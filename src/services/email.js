import { supabase } from '../lib/supabase.js';
import { createChat } from './chat.js';
import { connect } from 'imap-simple';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { ConnectionPool } from './connection-pool.js';
import { RateLimiter } from './rate-limiter.js';
import { createEmailTemplate } from './email-template.js';
import Sentry from '../lib/sentry.js';
import { handleIncomingMessage } from '../controllers/chat/message-handlers.js';

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
    Sentry.captureException(error, {
      tags: {
        type: 'email_connection_test',
        host: config.host
      }
    });
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
    this.reconnectingChannels = new Set(); // controle de canais em reconexão
  }

  async getConnection(channel) { 
    const host = channel.credentials.host;
    
    // Criar pool se não existir
    if (!this.connectionPools.has(host)) {
      this.connectionPools.set(host, new ConnectionPool({
        maxSize: MAX_CONNECTIONS_PER_HOST,
        create: async () => this.createConnection(channel),
        validate: (conn) => conn.isAlive(),
        destroy: async (conn) => {
          if (conn && conn.imap) {
            try {
              await conn.imap.end();
            } catch (err) {
              // console.error('Erro ao destruir conexão:', err);
            }
          }
        }
      }));
    }

    const pool = this.connectionPools.get(host);
    const connection = await pool.acquire();
    this.channelConnections.set(channel.id, connection);
    
    return connection;
  }

  async handleConnectionError(channel) {
    try {
      if (this.reconnectingChannels.has(channel.id)) {
        // console.log(`Canal ${channel.id} já está tentando reconectar`);
        return;
      }

      this.reconnectingChannels.add(channel.id);
      // console.log(`Iniciando reconexão para o canal ${channel.id}`);
      
      const maxRetries = 5;
      let retryCount = 0;
      let retryDelay = RECONNECT_INTERVAL;

      const retryConnection = async () => {
        try {
          if (retryCount >= maxRetries) {
            // console.error(`Máximo de tentativas atingido para o canal ${channel.id}`);
            await this.recordFailure(channel.credentials.host);
            this.reconnectingChannels.delete(channel.id); 
            return;
          }

          retryCount++;
          // console.log(`Tentativa ${retryCount} de reconexão para o canal ${channel.id}`);

          // Remover conexão antiga de forma segura
          const oldConnection = this.channelConnections.get(channel.id);
          if (oldConnection) {
            try {
              if (oldConnection.imap) {
                // Remover todos os listeners antes de fechar
                oldConnection.imap.removeAllListeners();
                await oldConnection.imap.end();
              }
            } catch (err) {
              console.warn('Erro ao fechar conexão antiga:', err);
              // Não propagar o erro, apenas registrar
            }
            this.channelConnections.delete(channel.id);
          }

          // Criar nova conexão com tratamento de erro melhorado
          try {
            const newConnection = await this.createConnection(channel);
            await newConnection.openBox('INBOX');
            await this.setupIdleListener(channel, newConnection);
            
            this.channelConnections.set(channel.id, newConnection);

            // console.log(`Reconectado com sucesso ao canal ${channel.id}`);
            this.failureCount.set(channel.credentials.host, 0);
            this.reconnectingChannels.delete(channel.id);
          } catch (connError) {
            // console.error(`Erro ao criar nova conexão para canal ${channel.id}:`, connError);
            
            if (retryCount < maxRetries) {
              retryDelay = Math.min(retryDelay * 2, 300000);
              setTimeout(retryConnection, retryDelay);
            } else {
              this.reconnectingChannels.delete(channel.id);
            }
          }
          
        } catch (err) {
          // console.error(`Erro na tentativa ${retryCount} de reconexão do canal ${channel.id}:`, err);
          
          if (retryCount < maxRetries) {
            retryDelay = Math.min(retryDelay * 2, 300000);
            setTimeout(retryConnection, retryDelay);
          } else {
            this.reconnectingChannels.delete(channel.id);
          }
        }
      };

      await retryConnection();
    } catch (error) {
      // console.error(`Erro crítico no handleConnectionError para canal ${channel.id}:`, error);
      // Garantir que o canal seja removido do conjunto de reconexão
      this.reconnectingChannels.delete(channel.id);
    }
  }

  async createConnection(channel) {
    const config = {
      imap: {
        user: channel.credentials.username,
        password: channel.credentials.password,
        host: channel.credentials.host,
        port: channel.credentials.port,
        tls: channel.credentials.secure,
        tlsOptions: { 
          rejectUnauthorized: false
        },
        debug: (info) => {
          if (
            info.includes('Error') || 
            info.includes('FATAL') ||
            info.includes('Connected') ||
            info.includes('Disconnected') ||
            info.includes('Connection error')
          ) {
            // console.log(`[IMAP Debug ${channel.id}]:`, info);
          }
        },
        authTimeout: 30000,
        socketTimeout: 60000,
        keepalive: true,
        keepaliveInterval: 60000,
        connTimeout: 30000
      }
    };

    // Aumentar o limite de listeners para o processo
    process.setMaxListeners(20);

    try {
      const connection = await connect(config);
      
      if (connection.imap._sock) {
        try {
          // Remover listeners existentes
          connection.imap._sock.removeAllListeners('error');
          connection.imap._sock.removeAllListeners('timeout');

          // Adicionar novo handler de erro
          connection.imap._sock.on('error', (err) => {
            // console.warn(`Socket error para canal ${channel.id}:`, err);
            if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
              try {
                connection.imap.end();
              } catch (endError) {
                // console.warn(`Erro ao finalizar conexão após erro ${channel.id}:`, endError);
              }
              setTimeout(() => {
                this.handleConnectionError(channel).catch(console.error);
              }, 1000);
            }
          });

          connection.imap._sock.on('timeout', () => {
            // console.warn(`Socket timeout para canal ${channel.id}`);
            try {
              connection.imap.end();
            } catch (endError) {
              // console.warn(`Erro ao finalizar conexão após timeout ${channel.id}:`, endError);
            }
            setTimeout(() => {
              this.handleConnectionError(channel).catch(console.error);
            }, 1000);
          });

          connection.imap._sock.setKeepAlive(true, 30000);
          connection.imap._sock.setTimeout(120000);
        } catch (sockErr) {
          Sentry.captureException(sockErr, {
            tags: {
              type: 'email_socket_error',
              channel_id: channel.id
            }
          });
          // console.warn(`Erro ao configurar socket para canal ${channel.id}:`, sockErr);
        }
      }

      // Modificar handler de erro do IMAP
      connection.imap.removeAllListeners('error');
      connection.imap.on('error', (err) => {
        console.error(`Erro IMAP para canal ${channel.id}:`, err);
        if (err.source === 'socket' || err.source === 'socket-timeout') {
          // Não propagar erros de socket
          return;
        }
        this.handleConnectionError(channel).catch(console.error);
      });

      // Prevenir que erros no socket causem crash na conexão
      if (connection.imap.connection) {
        connection.imap.connection.removeAllListeners('error');
        connection.imap.connection.on('error', (err) => {
          // console.warn(`Connection error para canal ${channel.id}:`, err);
          // Não propagar o erro
        });
      }

      let pingInterval;
      const startPing = () => {
        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(async () => {
          try {
            if (connection.imap.state === 'authenticated') {
              await connection.imap.status('INBOX', []);
            }
          } catch (err) {
            //  console.warn(`Erro no ping do canal ${channel.id}:`, err);
            clearInterval(pingInterval);
            this.handleConnectionError(channel).catch(console.error);
          }
        }, 270000);
      };

      startPing();

      connection.imap.once('end', () => {
        if (pingInterval) clearInterval(pingInterval);
      });

      return connection;
    } catch (error) {
      Sentry.captureException(error, {
        tags: {
          type: 'email_connection_error',
          channel_id: channel.id,
          host: channel.credentials.host
        }
      });
      await this.handleConnectionError(channel).catch(console.error);
      return null;
    }
  }

  async setupIdleListener(channel, connection) {
    try {
      const box = await connection.openBox('INBOX');
      
      await this.processNewEmails(channel, connection);
      
      connection.imap.on('mail', async () => {
        await this.processNewEmails(channel, connection);
      });

      connection.imap._sock.setKeepAlive(true);
      
    } catch (err) {
      Sentry.captureException(err, {
        tags: {
          type: 'email_idle_listener_error',
          channel_id: channel.id
        }
      });
      // console.error(`Erro ao configurar listener para canal ${channel.id}:`, err);
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
        return;
      }

      if (!(await this.rateLimiter.canMakeRequest(host))) {
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
          continue;
        }

        try {
          const fullEmailPart = msg.parts.find(p => p.which === '');
          if (!fullEmailPart?.body) {
            // console.error('Email sem corpo completo');
            continue;
          }

          const email = await simpleParser(fullEmailPart.body);

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
            // console.error('Email ainda sem remetente após todas as tentativas:', {
            //   emailContent: fullEmailPart.body.substring(0, 500),
            //   emailFrom: email.from
            // });
            continue;
          }

          await handleIncomingEmail(channel, email);
          
          this.messageCache.set(messageId, {
            timestamp: Date.now(),
            processed: true
          });
          
        } catch (err) {
          Sentry.captureException(err, {
            tags: {
              type: 'email_process_error',
              message_id: messageId,
              channel_id: channel.id
            }
          });
          // console.error(`Erro ao processar email ${messageId}:`, err);
          await this.recordFailure(host);
        }
      }

    } catch (error) {
      // console.error('Erro ao processar novos emails:', error);
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
        // console.error(`Erro ao inicializar canal ${channel.id}:`, err);
      }
    }
  } catch (error) {
    // console.error('Erro ao inicializar canais de email:', error);
  }
}

export async function cleanupEmailConnections() {
  await emailManager.cleanup();
}

// Handle incoming email
async function handleIncomingEmail(channel, email) {
  const { organization } = channel;
  
  try {
    const chatId = email.headers?.get('x-chat-id') || 
                  email.references?.find(ref => ref.includes('chat-'))?.split('chat-')[1]?.split('@')[0];

    const fromEmail = email.from?.value?.[0]?.address || 
                     email.from?.text || 
                     email.headers?.get('from');

    if (!fromEmail) {
      // console.error('Email sem remetente válido:', email);
      return;
    }

    const fromName = email.from?.value?.[0]?.name || 
                    fromEmail.split('@')[0] || 
                    'Unknown';

    // Preparar dados para handleIncomingMessage
    const messageData = {
      messageId: email.messageId || `email-${Date.now()}`,
      timestamp: email.date?.getTime() || Date.now(),
      externalId: fromEmail,
      externalName: fromName,
      externalProfilePicture: null, // Email não tem foto de perfil
      message: {
        type: 'text',
        content: cleanEmailContent(email.text || email.html || email.textAsHtml || 'Empty email content'),
        raw: email
      },
      fromMe: false,
      event: 'messageReceived'
    };

    // Se encontrou um chatId, incluir o chat
    if (chatId) {
      const { data: existingChat } = await supabase
        .from('chats')
        .select('*, customers(*)')
        .eq('id', chatId)
        .single();

      if (existingChat) {
        messageData.chat = existingChat;
      }
    }

    // Chamar handleIncomingMessage
    await handleIncomingMessage(channel, messageData);

  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        type: 'email_handle_incoming_error',
        channel_id: channel.id,
        organization_id: organization.id
      }
    });
    // console.error('Error handling incoming email:', error);
    throw error;
  }
}

function cleanEmailContent(content) {
  if (!content) return '';

  let cleanContent = content;

  // Primeiro, limpar todos os padrões HTML
  const htmlPatterns = [
    /<blockquote[^>]*>[\s\S]*?<\/blockquote>/gi,
    /<div class="gmail_quote"[\s\S]*?<\/div>/gi,
    /<div class="gmail_extra"[\s\S]*?<\/div>/gi,
    /<div class="yahoo_quoted"[\s\S]*?<\/div>/gi,
    /<div class="(ms-outlook|outlook)"[\s\S]*?<\/div>/gi,
    /<div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"[\s\S]*?<\/div>/gi,
    /<div class="gmail_signature"[\s\S]*?<\/div>/gi,
    /<div data-smartmail="gmail_signature"[\s\S]*?<\/div>/gi,
    /<div class="gmail_signature" data-smartmail="gmail_signature"[\s\S]*?<\/div>/gi
  ];

  htmlPatterns.forEach(pattern => {
    cleanContent = cleanContent.replace(pattern, '');
  });

  // Remover todas as tags HTML restantes
  cleanContent = cleanContent.replace(/<[^>]+>/g, '');

  // Depois, aplicar os outros padrões de limpeza
  const markers = [
    'Em .*?(?:às|at) .*?, .*? escreveu:',
    'Em .*?, .*? escreveu:',
    'On .*? at .*?, .*? wrote:',
    'On .*?, .*? wrote:',
    '_{10,}',
    '-{10,}',
    'From: .*?@',
    'De: .*?@',
    'Enviado: .*?\n',
    'Sent: .*?\n',
    '--- Original Message ---',
    '--- Mensagem original ---',
    'Forwarded message',
    'Mensagem encaminhada',
    'Begin forwarded message:',
    'Início da mensagem encaminhada:',
    'Email interflow.*?escreveu:',
    '.*?@.*?escreveu:'
  ];

  const regex = new RegExp(`(${markers.join('|')})`, 'ims');
  const parts = cleanContent.split(regex);
  cleanContent = parts[0];

  // Limpeza final
  cleanContent = cleanContent
    .split('\n')
    .filter(line => !line.trim().startsWith('>'))
    .join('\n')
    .replace(/\s*\n\s*\n\s*\n+/g, '\n\n')
    .replace(/^\s+|\s+$/g, '')
    .replace(/\[cid:.*?\]/g, '')
    .replace(/\[image:.*?\]/g, '')
    .trim();

  if (!cleanContent.trim()) {
    cleanContent = 'Mensagem vazia';
  }

  return cleanContent;
}

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

    const transporter = nodemailer.createTransport({
      host: credentials.smtpHost,
      port: credentials.smtpPort,
      secure: credentials.smtpSecure,
      auth: {
        user: credentials.smtpUsername,
        pass: credentials.smtpPassword
      },
      connectionTimeout: 60000,
      greetingTimeout: 30000,
      socketTimeout: 60000
    });

    await transporter.sendMail({
      from: `"${credentials.fromName}" <${credentials.smtpUsername}>`,
      to: chat.email,
      subject: `Re: ${chat.subject || 'Your message'}`,
      text: message.content
    });

    await supabase
      .from('messages')
      .update({ status: 'sent' })
      .eq('id', message.id);

  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        type: 'email_send_reply_error',
        chat_id: chat.id,
        message_id: message.id
      }
    });
    // console.error('Error sending email reply:', error);
    
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
    const { data: chat, error: chatError } = await supabase
      .from('chats')
      .select('title')
      .eq('id', messageData.chat_id)
      .single();

    if (chatError) throw chatError;

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

    const { data: senderData, error: senderError } = await supabase
      .from(messageData.sender_type === 'customer' ? 'customers' : 'profiles')
      .select(messageData.sender_type === 'customer' ? 'name' : 'full_name')
      .eq('id', messageData.sender_type === 'customer' ? messageData.sender_customer_id : messageData.sender_agent_id)
      .single();

    if (senderError) throw senderError;

    const enrichedMessageData = {
      ...messageData,
      sender_customer: messageData.sender_type === 'customer' ? { name: senderData.name } : null,
      sender_user: messageData.sender_type === 'customer' ? null : { full_name: senderData.full_name },
      created_at: new Date().toISOString()
    };

    const htmlContent = createEmailTemplate(messageData.chat_id, messages, enrichedMessageData);

    const transporter = nodemailer.createTransport({
      host: channel.credentials.smtpHost,
      port: channel.credentials.smtpPort,
      secure: channel.credentials.smtpSecure,
      auth: {
        user: channel.credentials.smtpUsername,
        pass: channel.credentials.smtpPassword
      },
      connectionTimeout: 60000,
      greetingTimeout: 30000,
      socketTimeout: 60000,
      tls: {
        rejectUnauthorized: false
      }
    });

    await transporter.verify();

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

    const info = await transporter.sendMail(emailConfig);

    return {
      messageId: info.messageId,
      status: 'sent'
    };
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        type: 'email_sender_message_error',
        chat_id: messageData.chat_id,
        channel_id: channel.id
      }
    });
    // console.error('Erro ao enviar email:', error);
    throw error;
  }
}