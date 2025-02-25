import { supabase } from '../lib/supabase.js';
import { createChat } from './chat.js';
import { connect } from 'imap-simple';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { ConnectionPool } from './connection-pool.js';
import { RateLimiter } from './rate-limiter.js';
import { createEmailTemplate } from './email-template.js';

// Test email connection
export async function testEmailConnection(config) {
  let imapConnection;
  let smtpTransporter;

  try {
    // Test IMAP connection
    const imapConfig = {
      imap: {
        user: config.username,
        password: config.password,
        host: config.host,
        port: config.port,
        tls: config.secure,
        tlsOptions: { 
          rejectUnauthorized: false 
        },
        authTimeout: 30000, // 30 segundos
        socketTimeout: 60000 // 60 segundos
      }
    };

    imapConnection = await connect(imapConfig);
    await imapConnection.openBox('INBOX');

    // Test SMTP connection
    smtpTransporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: {
        user: config.smtpUsername,
        pass: config.smtpPassword
      },
      connectionTimeout: 60000, // 60 segundos
      greetingTimeout: 30000, // 30 segundos
      socketTimeout: 60000, // 60 segundos
      tlsOptions: {
        rejectUnauthorized: false
      }
    });

    await smtpTransporter.verify();

    return { success: true };
  } catch (error) {
    console.error('Error testing email connection:', error);
    return { 
      success: false, 
      error: error.message 
    };
  } finally {
    if (imapConnection) {
      imapConnection.end();
    }
    if (smtpTransporter) {
      smtpTransporter.close();
    }
  }
}

// Configuração do pool
const MAX_CONNECTIONS_PER_HOST = 10;
const RECONNECT_INTERVAL = 5000; // 5 segundos
const CONNECTION_TIMEOUT = 300000; // 5 minutos

class EmailConnectionManager {
  constructor() {
    this.connectionPools = new Map(); // host -> ConnectionPool
    this.channelConnections = new Map(); // channelId -> connection
    this.messageCache = new Map(); // messageId -> message
    this.rateLimiter = new RateLimiter(100, 60000); // 100 requisições por minuto
    this.failureCount = new Map(); // host -> count
    this.circuitBreakerTimeout = new Map(); // host -> timestamp
  }

  async getConnection(channel) {
    const host = channel.credentials.host;
    
    // Criar pool se não existir
    if (!this.connectionPools.has(host)) {
      this.connectionPools.set(host, new ConnectionPool({
        maxSize: MAX_CONNECTIONS_PER_HOST,
        create: async () => this.createConnection(channel),
        validate: (conn) => conn.isAlive(),
        destroy: async (conn) => conn.end()
      }));
    }

    const pool = this.connectionPools.get(host);
    const connection = await pool.acquire();
    this.channelConnections.set(channel.id, connection);
    
    return connection;
  }

  async createConnection(channel) {
    const config = {
      imap: {
        user: channel.credentials.username,
        password: channel.credentials.password,
        host: channel.credentials.host,
        port: channel.credentials.port,
        tls: channel.credentials.secure,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 30000,
        socketTimeout: 60000,
        keepalive: true,
        keepaliveInterval: 60000 // 1 minuto
      }
    };

    const connection = await connect(config);
    
    // Configurar reconexão automática
    connection.on('error', async (err) => {
      console.error(`Erro na conexão do canal ${channel.id}:`, err);
      await this.handleConnectionError(channel);
    });

    connection.on('end', async () => {
      await this.handleConnectionError(channel);
    });

    return connection;
  }

  async handleConnectionError(channel) {
    const retryConnection = async () => {
      try {
        const newConnection = await this.getConnection(channel);
        await this.setupIdleListener(channel, newConnection);
        // console.log(`Reconectado com sucesso ao canal ${channel.id}`);
      } catch (err) {
        // console.error(`Falha na reconexão do canal ${channel.id}:`, err);
        setTimeout(retryConnection, RECONNECT_INTERVAL);
      }
    };

    setTimeout(retryConnection, RECONNECT_INTERVAL);
  }

  async setupIdleListener(channel, connection) {
    try {
      const box = await connection.openBox('INBOX');
      
      // Verificar emails não lidos ao conectar/reconectar
      await this.processNewEmails(channel, connection);
      
      // Usar o evento 'mail' do objeto imap
      connection.imap.on('mail', async () => {
        // console.log(`Novo email recebido para canal ${channel.id}`);
        await this.processNewEmails(channel, connection);
      });

      // Manter a conexão viva
      connection.imap._sock.setKeepAlive(true);
      
      // console.log(`IMAP listener iniciado para o canal ${channel.id}`);

    } catch (err) {
      console.error(`Erro ao configurar listener para canal ${channel.id}:`, err);
      throw err;
    }
  }

  async isCircuitBreakerOpen(host) {
    const failures = this.failureCount.get(host) || 0;
    const timeout = this.circuitBreakerTimeout.get(host);
    
    if (failures >= 5) { // Após 5 falhas
      if (timeout && Date.now() < timeout) {
        return true; // Circuito aberto
      }
      // Reset após timeout
      this.failureCount.set(host, 0);
      this.circuitBreakerTimeout.delete(host);
    }
    return false;
  }

  async recordFailure(host) {
    const failures = (this.failureCount.get(host) || 0) + 1;
    this.failureCount.set(host, failures);
    
    if (failures >= 5) {
      // Abrir circuito por 5 minutos
      this.circuitBreakerTimeout.set(host, Date.now() + 5 * 60 * 1000);
    }
  }

  async processNewEmails(channel, connection) {
    try {
      const host = channel.credentials.host;
      
      if (await this.isCircuitBreakerOpen(host)) {
        // console.log(`Circuit breaker aberto para ${host}`);
        return;
      }

      if (!(await this.rateLimiter.canMakeRequest(host))) {
        // console.log(`Rate limit atingido para ${host}`);
        return;
      }

      const searchCriteria = ['UNSEEN'];
      const fetchOptions = {
        bodies: ['HEADER', 'TEXT', ''],
        markSeen: true,
        struct: true
      };

      const messages = await connection.search(searchCriteria, fetchOptions);
      
      for (const msg of messages) {
        const messageId = msg.attributes.uid;
        
        if (this.messageCache.has(messageId)) {
          // console.log(`Mensagem ${messageId} encontrada no cache`);
          continue;
        }

        try {
          // Debug seguro da mensagem
          // console.log('Mensagem raw:', {
          //   attributes: msg.attributes,
          //   parts: msg.parts.map(p => ({
          //     which: p.which,
          //     size: p.size,
          //     bodyPreview: typeof p.body === 'string' ? 
          //       p.body.substring(0, 100) + '...' : 
          //       'Body não é string'
          //   }))
          // });

          // Usar a parte completa do email (which: '')
          const fullEmailPart = msg.parts.find(p => p.which === '');
          if (!fullEmailPart?.body) {
            console.error('Email sem corpo completo');
            continue;
          }

          const email = await simpleParser(fullEmailPart.body);

          // console.log('Email parseado:', {
          //   from: email.from,
          //   subject: email.subject,
          //   hasText: !!email.text,
          //   hasHtml: !!email.html
          // });

          // Extrair endereço do Return-Path se o from estiver undefined
          if (!email.from?.value?.[0]?.address) {
            const returnPathMatch = fullEmailPart.body.match(/Return-Path:\s*<([^>]+)>/i);
            if (returnPathMatch) {
              email.from = {
                value: [{
                  address: returnPathMatch[1],
                  name: returnPathMatch[1].split('@')[0]
                }]
              };
            }
          }

          if (!email.from?.value?.[0]?.address) {
            console.error('Email ainda sem remetente após todas as tentativas:', {
              emailContent: fullEmailPart.body.substring(0, 500),
              emailFrom: email.from
            });
            continue;
          }

          await handleIncomingEmail(channel, email);
          
          this.messageCache.set(messageId, {
            timestamp: Date.now(),
            processed: true
          });
          
        } catch (err) {
          console.error(`Erro ao processar email ${messageId}:`, err);
          await this.recordFailure(host);
        }
      }

    } catch (error) {
      console.error('Erro ao processar novos emails:', error);
      await this.recordFailure(channel.credentials.host);
    }
  }

  cleanupCache() {
    const now = Date.now();
    for (const [messageId, data] of this.messageCache.entries()) {
      if (now - data.timestamp > 24 * 60 * 60 * 1000) { // 24 horas
        this.messageCache.delete(messageId);
      }
    }
  }

  // Adicionar métricas básicas
  getMetrics() {
    return {
      activeConnections: this.channelConnections.size,
      poolsSize: this.connectionPools.size,
      cacheSize: this.messageCache.size,
      circuitBreakers: Array.from(this.circuitBreakerTimeout.entries()).map(([host, timeout]) => ({
        host,
        status: Date.now() < timeout ? 'open' : 'closed'
      })),
      rateLimits: Array.from(this.rateLimiter.requests.entries()).map(([host, requests]) => ({
        host,
        requestCount: requests.length
      }))
    };
  }

  async cleanup() {
    for (const pool of this.connectionPools.values()) {
      await pool.drain();
      await pool.clear();
    }
    this.connectionPools.clear();
    this.channelConnections.clear();
  }
}

// Singleton instance
const emailManager = new EmailConnectionManager();

// Exportar o emailManager
export { emailManager };

export async function initializeEmailChannels() {
  try {
    const { data: channels, error } = await supabase
      .from('chat_channels')
      .select('*, organization:organizations(id, name)')
      .eq('type', 'email')
      .eq('status', 'active');

    if (error) throw error;

    for (const channel of channels) {
      try {
        const connection = await emailManager.getConnection(channel);
        await emailManager.setupIdleListener(channel, connection);
      } catch (err) {
        console.error(`Erro ao inicializar canal ${channel.id}:`, err);
      }
    }
  } catch (error) {
    console.error('Erro ao inicializar canais de email:', error);
  }
}

export async function cleanupEmailConnections() {
  await emailManager.cleanup();
}

// Handle incoming email
async function handleIncomingEmail(channel, email) {
  const { organization } = channel;
  
  try {
    // Tentar extrair ID do chat dos cabeçalhos
    const chatId = email.headers?.get('x-chat-id') || 
                  email.references?.find(ref => ref.includes('chat-'))?.split('chat-')[1]?.split('@')[0];

    let chat;
    if (chatId) {
      // Buscar chat existente
      const { data: existingChat } = await supabase
        .from('chats')
        .select('*, customers(*)')
        .eq('id', chatId)
        .single();

      if (existingChat) {
        chat = existingChat;
      }
    }

    // Se não encontrou chat, processa normalmente
    if (!chat) {
      // Extrair email do remetente
      const fromEmail = email.from?.value?.[0]?.address || 
                       email.from?.text || 
                       email.headers?.get('from');

      if (!fromEmail) {
        console.error('Email sem remetente válido:', email);
        return;
      }

      // Extrair nome do remetente de forma segura
      const fromName = email.from?.value?.[0]?.name || 
                      fromEmail.split('@')[0] || 
                      'Unknown';

      // Check if customer exists
      let { data: customer } = await supabase
        .from('customers')
        .select('*')
        .eq('organization_id', organization.id)
        .eq('email', fromEmail)
        .single();

      // Create customer if not exists
      if (!customer) {
        const { data: newCustomer, error: customerError } = await supabase
          .from('customers')
          .insert({
            organization_id: organization.id,
            name: fromName,
            email: fromEmail
          })
          .select()
          .single();

        if (customerError) throw customerError;
        customer = newCustomer;
      }

      // Find existing chat or create new one
      chat = await findExistingChat(channel.id, customer.id);
      
      if (!chat) {
        // Extrair e limpar o título do email
        const emailSubject = email.subject?.trim() || 'Sem assunto';
        
        const { data: newChat, error: chatError } = await supabase
          .from('chats')
          .insert({
            organization_id: organization.id,
            customer_id: customer.id,
            channel_id: channel.id,
            external_id: customer.email,
            status: 'pending',
            title: emailSubject
          })
          .select('*, customers(*)')
          .single();

        if (chatError) throw chatError;
        chat = newChat;
      }
    }

    if (!chat || !chat.id) {
      throw new Error('Failed to create or retrieve chat');
    }

    // Limpar o conteúdo do email antes de criar a mensagem
    const cleanedContent = cleanEmailContent(email.text || email.html || email.textAsHtml || 'Empty email content');

    // Criar mensagem com o conteúdo limpo
    const { data: message, error: messageError } = await supabase
      .from('messages')
      .insert({
        chat_id: chat.id,
        organization_id: organization.id,
        content: cleanedContent,
        sender_type: 'customer',
        sender_customer_id: chat.customer_id, // Alterado para usar customer_id do chat
        status: 'delivered'
      })
      .select()
      .single();

    if (messageError) throw messageError;

    // Atualizar last_message_id do chat
    const { error: updateError } = await supabase
      .from('chats')
      .update({ 
        last_message_id: message.id
      })
      .eq('id', chat.id);

    if (updateError) throw updateError;

  } catch (error) {
    console.error('Error handling incoming email:', error);
    throw error;
  }
}

// Função auxiliar para limpar o conteúdo do email
function cleanEmailContent(content) {
  if (!content) return '';

  // Lista de marcadores comuns que indicam início do histórico
  const markers = [
    'Em .*?(?:às|at) .*?, .*? escreveu:',  // Formato Gmail PT
    'Em .*?, .*? escreveu:',               // Formato Gmail PT simplificado
    'On .*? at .*?, .*? wrote:',           // Formato Gmail EN
    'On .*?, .*? wrote:',                  // Formato Gmail EN simplificado
    '_{10,}',                              // 10 ou mais underscores
    '-{10,}',                              // 10 ou mais hífens
    'From: .*?@',                          // Cabeçalho From
    'De: .*?@',                            // Cabeçalho De
    'Enviado: .*?\n',                      // Cabeçalho Enviado
    'Sent: .*?\n',                         // Cabeçalho Sent
    '--- Original Message ---',            // Mensagem original EN
    '--- Mensagem original ---',           // Mensagem original PT
    'Forwarded message',                   // Encaminhamento EN
    'Mensagem encaminhada',                // Encaminhamento PT
    'Begin forwarded message:',            // Início encaminhamento EN
    'Início da mensagem encaminhada:',     // Início encaminhamento PT
    'Email interflow.*?escreveu:',         // Específico para o sistema
    '.*?@.*?escreveu:'                     // Qualquer email seguido de "escreveu:"
  ];

  // Criar regex com todos os marcadores
  const regex = new RegExp(`(${markers.join('|')})`, 'ims'); // 'ims' para multiline, case insensitive e dotall

  // Dividir o conteúdo na primeira ocorrência de qualquer marcador
  let cleanContent = content;

  // Remover blocos HTML de citação
  const htmlPatterns = [
    /<blockquote[^>]*>[\s\S]*?<\/blockquote>/gi,
    /<div class="gmail_quote"[\s\S]*?<\/div>/gi,
    /<div class="gmail_extra"[\s\S]*?<\/div>/gi,
    /<div class="yahoo_quoted"[\s\S]*?<\/div>/gi,
    /<div class="(ms-outlook|outlook)"[\s\S]*?<\/div>/gi
  ];

  // Remover cada padrão HTML
  htmlPatterns.forEach(pattern => {
    cleanContent = cleanContent.replace(pattern, '');
  });

  // Dividir no primeiro marcador encontrado
  const parts = cleanContent.split(regex);
  cleanContent = parts[0];

  // Remover linhas que são citações
  cleanContent = cleanContent
    .split('\n')
    .filter(line => !line.trim().startsWith('>'))
    .join('\n');

  // Limpeza final
  cleanContent = cleanContent
    .replace(/\s*\n\s*\n\s*\n+/g, '\n\n') // Substituir 3+ quebras de linha por 2
    .replace(/^\s+|\s+$/g, '')            // Remover espaços no início e fim
    .replace(/\[cid:.*?\]/g, '')          // Remover referências a CID
    .replace(/\[image:.*?\]/g, '')         // Remover referências a imagens
    .trim();

  // Se o conteúdo estiver vazio após a limpeza, tentar uma limpeza mais simples
  if (!cleanContent.trim()) {
    cleanContent = content
      .replace(/<[^>]+>/g, '')            // Remover todas as tags HTML
      .replace(/\s*\n\s*\n\s*\n+/g, '\n\n')
      .split(regex)[0]                     // Ainda tentar cortar no marcador
      .trim();
  }

  // Se ainda estiver vazio, usar o conteúdo original limpo
  if (!cleanContent.trim()) {
    cleanContent = content
      .replace(/<[^>]+>/g, '')
      .trim();
  }

  return cleanContent || 'Mensagem vazia';
}

// Find existing open chat
async function findExistingChat(channelId, customerId) {
  const { data: chat } = await supabase
    .from('chats')
    .select('*')
    .eq('channel_id', channelId)
    .eq('customer_id', customerId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  return chat;
}

// Send email reply
export async function sendEmailReply(chat, message) {
  try {
    const { data: channel } = await supabase
      .from('chat_channels')
      .select('*')
      .eq('id', chat.channel_id)
      .single();

    if (!channel || channel.type !== 'email') {
      throw new Error('Invalid channel');
    }

    const { credentials } = channel;
    if (!credentials?.smtpHost || !credentials?.smtpUsername || !credentials?.smtpPassword) {
      throw new Error('Invalid SMTP credentials');
    }

    // Send email using nodemailer
    const transporter = nodemailer.createTransport({
      host: credentials.smtpHost,
      port: credentials.smtpPort,
      secure: credentials.smtpSecure,
      auth: {
        user: credentials.smtpUsername,
        pass: credentials.smtpPassword
      },
      connectionTimeout: 60000, // 60 segundos
      greetingTimeout: 30000, // 30 segundos
      socketTimeout: 60000 // 60 segundos
    });

    await transporter.sendMail({
      from: `"${credentials.fromName}" <${credentials.smtpUsername}>`,
      to: chat.email,
      subject: `Re: ${chat.subject || 'Your message'}`,
      text: message.content
    });

    // Update message status
    await supabase
      .from('messages')
      .update({ status: 'sent' })
      .eq('id', message.id);

  } catch (error) {
    console.error('Error sending email reply:', error);
    
    // Update message status to failed
    await supabase
      .from('messages')
      .update({ 
        status: 'failed',
        error_message: error.message
      })
      .eq('id', message.id);

    throw error;
  }
}

export async function handleSenderMessageEmail(channel, messageData) {
  try {
    // Buscar dados do chat, incluindo o título
    const { data: chat, error: chatError } = await supabase
      .from('chats')
      .select('title')
      .eq('id', messageData.chat_id)
      .single();

    if (chatError) throw chatError;

    // Buscar mensagens anteriores com join em profiles e customers
    const { data: messages, error: messagesError } = await supabase
      .from('messages')
      .select(`
        *,
        sender_user:profiles(full_name),
        sender_customer:customers(name)
      `)
      .eq('chat_id', messageData.chat_id)
      .or('content.neq.null,attachments.neq.[]')
      .order('created_at', { ascending: true });

    if (messagesError) throw messagesError;

    // Buscar dados do remetente da nova mensagem
    const { data: senderData, error: senderError } = await supabase
      .from(messageData.sender_type === 'customer' ? 'customers' : 'profiles')
      .select(messageData.sender_type === 'customer' ? 'name' : 'full_name')
      .eq('id', messageData.sender_type === 'customer' ? messageData.sender_customer_id : messageData.sender_agent_id)
      .single();

    if (senderError) throw senderError;

    // Preparar nova mensagem com dados do remetente
    const enrichedMessageData = {
      ...messageData,
      sender_customer: messageData.sender_type === 'customer' ? { name: senderData.name } : null,
      sender_user: messageData.sender_type === 'customer' ? null : { full_name: senderData.full_name },
      created_at: new Date().toISOString()
    };

    const htmlContent = createEmailTemplate(messageData.chat_id, messages, enrichedMessageData);

    // Configurar transporte de email com configurações mais robustas
    const transporter = nodemailer.createTransport({
      host: channel.credentials.smtpHost, // Mudado de host para smtpHost
      port: channel.credentials.smtpPort, // Mudado de port para smtpPort
      secure: channel.credentials.smtpSecure, // Mudado de secure para smtpSecure
      auth: {
        user: channel.credentials.smtpUsername, // Mudado de username para smtpUsername
        pass: channel.credentials.smtpPassword // Mudado de password para smtpPassword
      },
      connectionTimeout: 60000, // 60 segundos
      greetingTimeout: 30000, // 30 segundos
      socketTimeout: 60000, // 60 segundos
      tls: {
        rejectUnauthorized: false
      }
    });

    // Verificar a conexão antes de enviar
    await transporter.verify();

    // Configurar cabeçalhos especiais para threading
    const emailConfig = {
      from: `"${channel.name || 'Atendimento'}" <${channel.credentials.username}>`,
      to: messageData.to,
      subject: `Re: ${chat.title || 'Support'}`,
      html: htmlContent,
      headers: {
        'X-Chat-ID': messageData.chat_id,
        'References': `<chat-${messageData.chat_id}@${channel.credentials.host}>`,
        'In-Reply-To': `<chat-${messageData.chat_id}@${channel.credentials.host}>`
      }
    };

    // console.log('Configuração do email:', { 
    //   to: emailConfig.to,
    //   from: emailConfig.from,
    //   subject: emailConfig.subject
    // }); // Debug

    // Enviar email
    const info = await transporter.sendMail(emailConfig);

    return {
      messageId: info.messageId,
      status: 'sent'
    };
  } catch (error) {
    console.error('Erro ao enviar email:', error);
    throw error;
  }
}