import { handleIncomingMessage, handleStatusUpdate } from '../chat/message-handlers.js';
import { validateChannel } from '../webhooks/utils.js';
import { encrypt, decrypt } from '../../utils/crypto.js';
import Sentry from '../../lib/sentry.js';
import { supabase } from '../../lib/supabase.js';
import axios from 'axios';
import {  formatMarkdownForWhatsApp, formatWhatsAppToMarkdown} from '../../utils/chat.js';
import { registerUsageOrganizationByCustomer } from '../organizations/usage.js';

async function getWhatsAppUserInfo(phoneNumber, accessToken) {
  try {
    // No WhatsApp, não temos uma API para buscar informações do usuário
    // Retornamos apenas o número formatado como identificação
    return {
      name: phoneNumber,
      phone_number: phoneNumber
    };
  } catch (error) {
    Sentry.captureException(error);
    console.error('Erro ao buscar informações do usuário WhatsApp:', error);
    return null;
  }
}

async function findOrCreateChat(channel, senderId, contactName) {
  try {
    // Buscar chat existente
    const { data: chats } = await supabase
      .from('chats')
      .select('*, customers(*)')
      .eq('channel_id', channel.id)
      .in('status', ['in_progress', 'pending', 'await_closing'])
      .eq('external_id', senderId)
      .order('created_at', { ascending: false })
      .limit(1);

    const existingChat = chats?.[0];

    if (existingChat) {
      // Atualizar última mensagem do cliente e nome se necessário
      const updates = {
        last_customer_message_at: new Date().toISOString()
      };

      await supabase
        .from('chats')
        .update(updates)
        .eq('id', existingChat.id);

      // Atualizar nome do cliente se recebemos um nome novo
      if (contactName && contactName !== existingChat.customers.name) {
        await supabase
          .from('customers')
          .update({ name: contactName })
          .eq('id', existingChat.customers.id);
      }

      return existingChat;
    }

    // Verificar se já existe um cliente com esse número de WhatsApp
    const { data: existingCustomer } = await supabase
      .from('customers')
      .select('*')
      .eq('organization_id', channel.organization_id)
      .eq('whatsapp', `+${senderId}`)
      .limit(1);

    let customerId;

    if (existingCustomer && existingCustomer.length > 0) {
      // Se o cliente já existe, usar o ID existente
      customerId = existingCustomer[0].id;
      
      // Atualizar o nome se necessário
      if (contactName && contactName !== existingCustomer[0].name) {
        await supabase
          .from('customers')
          .update({ name: contactName })
          .eq('id', customerId);
      }
    } else {
      // Criar novo customer se não existir
      const { data: newCustomer, error: customerError } = await supabase
        .from('customers')
        .insert({
          organization_id: channel.organization_id,
          name: contactName || senderId,
          whatsapp: `+${senderId}`
        })
        .select()
        .single();

      if (customerError) throw customerError;
      customerId = newCustomer.id;

      //Contabilizar usage de organization
      registerUsageOrganizationByCustomer(channel.organization_id);
    }

    // Criar novo chat
    let { data: chat, error: chatError } = await supabase
      .from('chats')
      .insert({
        organization_id: channel.organization_id,
        customer_id: customerId,
        channel_id: channel.id,
        external_id: senderId,
        status: 'pending',
        last_customer_message_at: new Date().toISOString()
      })
      .select('*, customers(*)')
      .single();

    if (chatError) throw chatError;

    chat.is_first_message = true;
    return chat;
  } catch (error) {
    Sentry.captureException(error);
    console.error('Erro ao criar/buscar chat:', error);
    throw error;
  }
}

/**
 * Registra eventos de status do WhatsApp para diagnóstico
 * 
 * @param {Object} channel - Canal de comunicação
 * @param {Object} statusUpdate - Dados do status recebido do webhook
 */
async function logWhatsAppStatusEvent(channel, statusUpdate) {
  try {
    // Registra o evento de status no banco de dados para diagnóstico
    await supabase
      .from('webhook_logs')
      .insert({
        organization_id: channel.organization_id,
        channel_id: channel.id,
        event_type: `whatsapp_status_${statusUpdate.status}`,
        payload: {
          status: statusUpdate.status,
          message_id: statusUpdate.id,
          recipient_id: statusUpdate.recipient_id,
          timestamp: statusUpdate.timestamp,
          conversation: statusUpdate.conversation,
          pricing: statusUpdate.pricing,
          errors: statusUpdate.errors
        },
        created_at: new Date().toISOString()
      });
  } catch (error) {
    Sentry.captureException(error);
    console.error('Erro ao registrar evento de status:', error);
    // Não falha o processamento principal se o log falhar
  }
}

/**
 * Extrai informações de um ID de mensagem do WhatsApp (wamid)
 * 
 * O formato wamid é algo como:
 * wamid.HBgMNTU5MjkxMjc2Njk2FQIAERgSODZGNDZFMDU5QjAyMTJDNzUzAA==
 * 
 * @param {string} wamid - ID da mensagem no formato WhatsApp
 * @returns {Object} Informações extraídas do wamid
 */
function parseWhatsAppMessageId(wamid) {
  try {
    // Verifica se é um wamid válido
    if (!wamid || !wamid.startsWith('wamid.')) {
      return { 
        original: wamid,
        isValid: false
      };
    }
    
    // Extrai a parte codificada em base64
    const base64Part = wamid.split('wamid.')[1];
    
    // Tenta decodificar para extrair mais informações
    // Nota: nem sempre é possível decodificar completamente
    let decodedInfo = {};
    try {
      const decoded = atob(base64Part);
      // Tenta extrair o número de telefone (nem sempre é possível)
      const phoneMatch = decoded.match(/(\d{10,15})/);
      if (phoneMatch) {
        decodedInfo.phoneNumber = phoneMatch[1];
      }
    } catch (e) {
      // Ignora erros de decodificação
    }
    
    return {
      original: wamid,
      isValid: true,
      base64Part,
      ...decodedInfo
    };
  } catch (error) {
    Sentry.captureException(error);
    console.error('Erro ao analisar wamid:', error);
    return { 
      original: wamid,
      isValid: false,
      error: error.message
    };
  }
}

/**
 * Normaliza dados de status do WhatsApp Official para formato padrão
 * 
 * @param {Object} statusUpdate - Dados de status do WhatsApp Official
 * @param {Object} additionalData - Dados adicionais como chat_id, etc.
 * @returns {Object} - Dados normalizados para handleStatusUpdate
 */
function normalizeWhatsAppOfficialStatusUpdate(statusUpdate, additionalData = {}) {
  // Mapear status específicos do WhatsApp Official para status padronizados
  const mapWhatsAppStatusToStandard = (whatsappStatus) => {
    const statusMap = {
      'sent': 'sent',
      'delivered': 'delivered', 
      'read': 'read',
      'failed': 'failed',
      'pending': 'pending'
    };
    return statusMap[whatsappStatus] || whatsappStatus || 'unknown';
  };

  return {
    messageId: statusUpdate.id || statusUpdate.messageId,
    status: mapWhatsAppStatusToStandard(statusUpdate.status),
    error: statusUpdate.errors?.[0]?.title || additionalData.error || null,
    timestamp: statusUpdate.timestamp ? statusUpdate.timestamp * 1000 : Date.now(),
    metadata: {
      original: statusUpdate,
      source: 'whatsapp_official',
      additionalData,
      recipient_id: statusUpdate.recipient_id,
      pricing: statusUpdate.pricing
    }
  };
}

/**
 * Processa eventos de status de mensagens do WhatsApp
 * 
 * @param {Object} channel - Canal de comunicação
 * @param {Object} statusUpdate - Dados do status recebido do webhook
 */
async function processWhatsAppStatus(channel, statusUpdate) {
  try {
    // Registra o evento para diagnóstico
    await logWhatsAppStatusEvent(channel, statusUpdate);
    
    // Analisa o ID da mensagem
    const messageIdInfo = parseWhatsAppMessageId(statusUpdate.id);
    
    // Busca o chat associado a este número de telefone
    const { data: chat } = await supabase
      .from('chats')
      .select('id')
      .eq('channel_id', channel.id)
      .eq('external_id', statusUpdate.recipient_id)
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (!chat || chat.length === 0) {
      console.warn(`Chat não encontrado para o número ${statusUpdate.recipient_id}`);
    }
    
    // Verifica se já processamos este status para esta mensagem
    const { data: existingLogs } = await supabase
      .from('webhook_logs')
      .select('payload')
      .eq('organization_id', channel.organization_id)
      .eq('channel_id', channel.id)
      .eq('event_type', `whatsapp_status_${statusUpdate.status}`)
      .eq('payload->message_id', statusUpdate.id)
      .order('created_at', { ascending: false })
      .limit(5);
    
    // Se já processamos este status recentemente, verifica se é um duplicado
    if (existingLogs && existingLogs.length > 1) {
      // Verifica se já processamos este status com o mesmo timestamp
      const isDuplicate = existingLogs.some(log => {
        const logTimestamp = log.payload?.timestamp;
        return logTimestamp && parseInt(logTimestamp) === parseInt(statusUpdate.timestamp);
      });
      
      if (isDuplicate) {
        return true; // Ignora duplicados silenciosamente
      }
    }
    
    // Atualiza o status da mensagem no sistema
    const normalizedStatusData = normalizeWhatsAppOfficialStatusUpdate(statusUpdate, {
      chat_id: chat?.[0]?.id,
      message_id_info: messageIdInfo,
      channel_id: channel.id,
      organization_id: channel.organization_id
    });
    
    await handleStatusUpdate(channel, normalizedStatusData);
    
    return true;
  } catch (error) {
    Sentry.captureException(error);
    console.error('Erro ao processar status WhatsApp:', error);
    return false;
  }
}

/**
 * Tenta baixar mídia com retry em caso de falha
 * 
 * @param {string} url - URL da mídia para download
 * @param {string} accessToken - Token de acesso para autenticação
 * @param {number} maxRetries - Número máximo de tentativas
 * @returns {Promise<ArrayBuffer>} - Buffer com os dados da mídia
 */
async function downloadMediaWithRetry(url, accessToken, maxRetries = 3) {
  let lastError = null;
  
  console.warn(`Tentando baixar mídia da URL: ${url}`);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Usando axios em vez de fetch para melhor compatibilidade
      const response = await axios({
        method: 'GET',
        url: url,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'User-Agent': 'Interflow-WhatsApp-Media-Downloader/1.0'
        },
        responseType: 'arraybuffer',
        timeout: 30000
      });
      
      // Axios já lança erro para status não-2xx, então não precisamos verificar response.ok
      return response.data;
    } catch (error) {
      lastError = error;
      Sentry.captureException(error);
      
      // Extrair detalhes do erro para melhor diagnóstico
      let errorMessage = error.message;
      if (error.response) {
        // Resposta recebida com status de erro
        const statusText = error.response.statusText || '';
        const status = error.response.status || '';
        let responseData = '';
        
        try {
          // Tenta converter o buffer de resposta para texto para diagnóstico
          if (error.response.data) {
            responseData = Buffer.from(error.response.data).toString('utf8').substring(0, 500);
          }
        } catch (e) {
          responseData = '[Não foi possível ler o corpo da resposta]';
        }
        
        errorMessage = `Erro ${status} ${statusText}: ${responseData}`;
      } else if (error.request) {
        // Requisição feita mas sem resposta
        errorMessage = `Sem resposta do servidor: ${error.message}`;
      }
      
      console.warn(`Tentativa ${attempt}/${maxRetries} falhou: ${errorMessage}`);
      
      if (attempt < maxRetries) {
        // Espera um tempo antes de tentar novamente (backoff exponencial)
        const delayMs = 1000 * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  
  // Se chegou aqui, todas as tentativas falharam
  throw lastError;
}

/**
 * Baixa mídia do WhatsApp usando a API do Meta
 * 
 * @param {Object} channel - Canal de comunicação
 * @param {Object} mediaObject - Objeto de mídia do WhatsApp
 * @returns {Promise<Object>} - Informações da mídia baixada
 */
async function downloadWhatsAppMedia(channel, mediaObject) {
  try {
    if (!mediaObject || !mediaObject.id) {
      throw new Error('Objeto de mídia inválido');
    }
    
    // Verifica se temos credenciais válidas
    if (!channel.credentials || !channel.credentials.access_token) {
      throw new Error('Credenciais do canal não encontradas ou inválidas');
    }
    
    const accessToken = decrypt(channel.credentials.access_token);
    
    // Verifica se o token foi descriptografado corretamente
    if (!accessToken || accessToken.length < 10) {
      throw new Error('Token de acesso inválido ou corrompido');
    }
    
    // Passo 1: Obter informações da mídia (incluindo a URL)
    // Conforme documentação: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
    const phoneNumberId = channel.credentials.phone_number_id;
    const mediaInfoUrl = `https://graph.facebook.com/v21.0/${mediaObject.id}`;
    
    console.warn(`Obtendo informações da mídia: ${mediaInfoUrl}`);
    
    try {
      const mediaInfoResponse = await axios({
        method: 'GET',
        url: mediaInfoUrl,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'User-Agent': 'Interflow-WhatsApp-Media-Downloader/1.0'
        }
      });
      
      const mediaInfo = mediaInfoResponse.data;
      console.warn('Informações da mídia obtidas:', JSON.stringify({
        id: mediaObject.id,
        mime_type: mediaInfo.mime_type,
        sha256: mediaInfo.sha256,
        file_size: mediaInfo.file_size
      }));
      
      // Verifica se temos uma URL válida
      if (!mediaInfo.url) {
        console.warn('URL da mídia não encontrada na resposta da API, usando apenas metadados');
        return {
          id: mediaObject.id,
          mime_type: mediaInfo.mime_type,
          sha256: mediaInfo.sha256,
          file_size: mediaInfo.file_size,
          metadata_only: true,
          download_failed: true,
          error: 'URL da mídia não encontrada na resposta da API'
        };
      }
      
      try {
        // Passo 2: Baixar a mídia usando a URL obtida
        // Conforme documentação, a URL deve ser usada exatamente como retornada pela API
        console.warn(`URL da mídia obtida: ${mediaInfo.url.substring(0, 100)}...`);
        
        const arrayBuffer = await downloadMediaWithRetry(mediaInfo.url, accessToken);
        
        // Converte para base64 para facilitar o processamento
        const buffer = Buffer.from(arrayBuffer);
        const base64Data = buffer.toString('base64');
        
        return {
          url: mediaInfo.url,
          mime_type: mediaInfo.mime_type,
          sha256: mediaInfo.sha256,
          file_size: mediaInfo.file_size,
          id: mediaObject.id,
          base64: base64Data
        };
      } catch (downloadError) {
        console.error('Erro ao baixar mídia:', downloadError.message);
        
        // Cria uma URL de proxy para a mídia
        const proxyUrl = createMediaProxyUrl(mediaInfo, channel);
        
        // Se não conseguimos baixar a mídia, retornamos apenas os metadados
        return {
          url: mediaInfo.url,
          mime_type: mediaInfo.mime_type,
          sha256: mediaInfo.sha256,
          file_size: mediaInfo.file_size,
          id: mediaObject.id,
          metadata_only: true,
          download_failed: true,
          error: downloadError.message,
          proxy_url: proxyUrl
        };
      }
    } catch (error) {
      console.error('Erro ao obter informações da mídia:', error.message);
      throw new Error(`Erro ao obter informações da mídia: ${error.message}`);
    }
  } catch (error) {
    Sentry.captureException(error);
    console.error('Erro ao processar mídia do WhatsApp:', error);
    
    // Retorna o objeto original com informações sobre o erro
    return {
      ...mediaObject,
      error: error.message,
      download_failed: true,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Cria uma URL de proxy para mídia do WhatsApp
 * 
 * Esta função gera uma URL que pode ser usada para exibir a mídia
 * mesmo quando não conseguimos baixá-la diretamente.
 * 
 * @param {Object} mediaInfo - Informações da mídia
 * @param {Object} channel - Canal de comunicação
 * @returns {string} URL do proxy para a mídia
 */
function createMediaProxyUrl(mediaInfo, channel) {
  try {
    // Cria um objeto com as informações necessárias para o proxy
    const proxyData = {
      media_id: mediaInfo.id,
      mime_type: mediaInfo.mime_type,
      url: mediaInfo.url,
      channel_id: channel.id,
      timestamp: Date.now()
    };
    
    // Codifica os dados em base64 para usar na URL
    const encodedData = Buffer.from(JSON.stringify(proxyData)).toString('base64');
    
    // Obtém a URL base do backend a partir da variável de ambiente ou usa um valor padrão
    const backendUrl = process.env.API_URL || process.env.BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
    
    // Garantir que a URL base não termina com barra
    const baseUrl = backendUrl.endsWith('/') ? backendUrl.slice(0, -1) : backendUrl;
    
    // Registra a URL que está sendo gerada para diagnóstico
    console.log(`Gerando URL de proxy com base URL: ${baseUrl}`);
    
    // Retorna a URL absoluta do proxy usando a rota correta
  } catch (error) { 
    Sentry.captureException(error);
    console.error('Erro ao criar URL de proxy:', error);
    return null;
  }
}

export async function handleWhatsAppWebhook(req, res) {
  const webhookData = req.body;

  // console.log('Recebido webhook:', webhookData);

  try {
    // Validação específica para a estrutura do WhatsApp
    if (!webhookData?.object || !webhookData?.entry?.length) {
      return res.status(400).json({ error: 'Invalid webhook structure' });
    }

    // Verifica se é um webhook do WhatsApp Business
    if (webhookData.object !== 'whatsapp_business_account') {
      return res.status(400).json({ error: 'Unsupported webhook object type' });
    }

    // Processa cada entrada do webhook
    for (const entry of webhookData.entry) {
      for (const change of entry.changes) {
        const { value, field } = change;

        // Processa atualizações de status de templates
        if (field === 'message_template_status_update') {
          try {
            console.log('Recebido status de template:', JSON.stringify(value));
            
            // Busca o canal com base no ID da conta de negócios do WhatsApp
            const { data: channels } = await supabase
              .from('chat_channels')
              .select('*, organization:organizations(*)')
              .eq('type', 'whatsapp_official')
              .eq('status', 'active')
              .eq('external_id', entry.id)
              .limit(1);
            
            if (!channels || channels.length === 0) {
              console.log('Canal não encontrado para a conta de negócios:', entry.id);
              continue;
            }
            
            const channel = channels[0];
            
            // Registra o webhook completo para diagnóstico
            try {
              await supabase
                .from('webhook_logs')
                .insert({
                  organization_id: channel.organization_id,
                  channel_id: channel.id,
                  event_type: 'whatsapp_template_status_update',
                  payload: webhookData,
                  created_at: new Date().toISOString()
                });
            } catch (logError) {
              console.error('Erro ao registrar webhook de template:', logError);
            }
            
            // Atualiza o status do template no banco de dados
            const { data: template, error: templateError } = await supabase
              .from('whatsapp_templates')
              .select('*')
              .eq('channel_id', channel.id)
              .eq('template_id', value.message_template_id.toString())
              .single();
            
            if (templateError) {
              console.log('Template não encontrado:', value.message_template_id);
              
              // Tenta buscar pelo nome do template
              const { data: templateByName, error: nameError } = await supabase
                .from('whatsapp_templates')
                .select('*')
                .eq('channel_id', channel.id)
                .eq('name', value.message_template_name)
                .eq('language_code', value.message_template_language.replace('-', '_'))
                .single();
              
              if (nameError || !templateByName) {
                console.log('Template não encontrado pelo nome:', value.message_template_name);
                continue;
              }
              
              // Atualiza o template encontrado pelo nome
              const { error: updateError } = await supabase
                .from('whatsapp_templates')
                .update({
                  status: value.event,
                  template_id: value.message_template_id.toString(),
                  rejected_reason: value.reason,
                  last_sync_at: new Date().toISOString()
                })
                .eq('id', templateByName.id);
              
              if (updateError) {
                console.error('Erro ao atualizar status do template pelo nome:', updateError);
              } else {
                console.log('Status do template atualizado pelo nome:', value.message_template_name, value.event);
              }
            } else {
              // Atualiza o template encontrado pelo ID
              const { error: updateError } = await supabase
                .from('whatsapp_templates')
                .update({
                  status: value.event,
                  rejected_reason: value.reason,
                  last_sync_at: new Date().toISOString()
                })
                .eq('id', template.id);
              
              if (updateError) {
                console.error('Erro ao atualizar status do template:', updateError);
              } else {
                console.log('Status do template atualizado:', value.message_template_name, value.event);
              }
            }
          } catch (templateError) {
            Sentry.captureException(templateError);
            console.error('Erro ao processar atualização de status do template:', templateError);
          }
          continue;
        }

        // Verifica se temos os metadados necessários para mensagens
        if (!value?.metadata?.phone_number_id) {
          console.log('Webhook sem phone_number_id, ignorando:', value);
          continue;
        }

        // Busca o canal com base no phone_number_id
        const { data: channel, error: channelError } = await supabase
          .from('chat_channels')
          .select('*, organization:organizations(*)')
          .eq('type', 'whatsapp_official')
          .eq('status', 'active')
          .eq('external_id', value.metadata.phone_number_id)
          .single();

        // console.log('Canal encontrado:', channel);
        // console.log('Change:', change);
        if (channelError) {
          console.error('Erro ao buscar canal:', channelError);
        }

        if (!channel) {
          console.log('Canal não encontrado para:', value.metadata.phone_number_id);
          continue;
        }

        // Registra o webhook completo para diagnóstico
        try {
          await supabase
            .from('webhook_logs')
            .insert({
              organization_id: channel.organization_id,
              channel_id: channel.id,
              event_type: `whatsapp_webhook_${field}`,
              payload: webhookData,
              created_at: new Date().toISOString()
            });
        } catch (logError) {
          console.error('Erro ao registrar webhook:', logError);
        }

        // Processa atualizações de status de mensagens
        if (value.statuses && value.statuses.length > 0) {
          for (const statusUpdate of value.statuses) {
            await processWhatsAppStatus(channel, statusUpdate);
          }
        }

        // Processa mensagens recebidas
        if (value.messages && value.messages.length > 0) {
          for (const message of value.messages) {
            try {
              // Ignora mensagens do sistema ou notificações
              if (message.from === 'system' || message.type === 'notification') {
                console.log('Ignorando mensagem do sistema ou notificação:', message);
                continue;
              }

              // Encontra as informações do contato
              const contact = value.contacts?.find(c => c.wa_id === message.from);
              const contactName = contact?.profile?.name || message.from;

              const chat = await findOrCreateChat(channel, message.from, contactName);

              // Determina o tipo de mensagem e conteúdo
              let messageType = message.type;
              let messageContent = '';
              let mediaUrl = null;
              let mediaData = null;

              // Registra informações sobre a mensagem recebida para diagnóstico
              if (message.type !== 'text') {
                console.warn(`Mensagem ${message.type} recebida:`, JSON.stringify({
                  message_id: message.id,
                  from: message.from,
                  timestamp: message.timestamp,
                  type: message.type,
                  media_id: message[message.type]?.id,
                  mime_type: message[message.type]?.mime_type
                }));
              }

              // Extrai o conteúdo com base no tipo de mensagem
              switch (message.type) {
                case 'text':
                  messageContent = message.text?.body || '';
                  break;
                case 'image':
                  messageType = 'image';
                  messageContent = message.image?.caption || '';
                  // Tenta baixar a imagem se disponível
                  if (message.image) {
                    mediaData = await downloadWhatsAppMedia(channel, message.image);
                    // Verifica se o download falhou
                    if (mediaData.download_failed) {
                      console.warn(`Falha ao baixar imagem: ${mediaData.error}`);
                      // Se temos uma URL de proxy, podemos usá-la para exibir a imagem
                      if (mediaData.proxy_url) {
                        mediaUrl = mediaData.proxy_url;
                        messageContent = `${messageContent ? messageContent + '\n' : ''}[Imagem disponível via proxy]`;
                      } else {
                        messageContent = `${messageContent ? messageContent + '\n' : ''}[Imagem não disponível - ${mediaData.mime_type || 'image/jpeg'}${mediaData.file_size ? ` - ${Math.round(mediaData.file_size/1024)}KB` : ''}]`;
                      }
                    } else {
                      mediaUrl = mediaData.url;
                    }
                  }
                  break;
                case 'video':
                  messageType = 'video';
                  messageContent = message.video?.caption || '';
                  if (message.video) {
                    mediaData = await downloadWhatsAppMedia(channel, message.video);
                    // Verifica se o download falhou
                    if (mediaData.download_failed) {
                      console.warn(`Falha ao baixar vídeo: ${mediaData.error}`);
                      // Se temos uma URL de proxy, podemos usá-la para exibir o vídeo
                      if (mediaData.proxy_url) {
                        mediaUrl = mediaData.proxy_url;
                        messageContent = `${messageContent ? messageContent + '\n' : ''}[Vídeo disponível via proxy]`;
                      } else {
                        messageContent = `${messageContent ? messageContent + '\n' : ''}[Vídeo não disponível - ${mediaData.mime_type || 'video/mp4'}${mediaData.file_size ? ` - ${Math.round(mediaData.file_size/1024)}KB` : ''}]`;
                      }
                    } else {
                      mediaUrl = mediaData.url;
                    }
                  }
                  break;
                case 'audio':
                  messageType = 'audio';
                  messageContent = '';
                  if (message.audio) {
                    mediaData = await downloadWhatsAppMedia(channel, message.audio);
                    // Verifica se o download falhou
                    if (mediaData.download_failed) {
                      console.warn(`Falha ao baixar áudio: ${mediaData.error}`);
                      // Se temos uma URL de proxy, podemos usá-la para exibir o áudio
                      if (mediaData.proxy_url) {
                        mediaUrl = mediaData.proxy_url;
                        messageContent = `[Áudio disponível via proxy]`;
                      } else {
                        messageContent = `[Áudio não disponível - ${mediaData.mime_type || 'audio/mp3'}${mediaData.file_size ? ` - ${Math.round(mediaData.file_size/1024)}KB` : ''}]`;
                      }
                    } else {
                      mediaUrl = mediaData.url;
                    }
                  }
                  break;
                case 'document':
                  messageType = 'document';
                  messageContent = message.document?.caption || '';
                  if (message.document) {
                    mediaData = await downloadWhatsAppMedia(channel, message.document);
                    // Verifica se o download falhou
                    if (mediaData.download_failed) {
                      console.warn(`Falha ao baixar documento: ${mediaData.error}`);
                      // Se temos uma URL de proxy, podemos usá-la para exibir o documento
                      if (mediaData.proxy_url) {
                        mediaUrl = mediaData.proxy_url;
                        messageContent = `${messageContent ? messageContent + '\n' : ''}[Documento disponível via proxy]`;
                      } else {
                        messageContent = `${messageContent ? messageContent + '\n' : ''}[Documento não disponível - ${mediaData.mime_type || 'application/pdf'}${mediaData.file_size ? ` - ${Math.round(mediaData.file_size/1024)}KB` : ''}]`;
                      }
                    } else {
                      mediaUrl = mediaData.url;
                    }
                  }
                  break;
                case 'location':
                  messageType = 'location';
                  messageContent = `Localização: ${message.location?.latitude},${message.location?.longitude}`;
                  break;
                case 'button':
                  messageType = 'button';
                  messageContent = message.button?.text || '';
                  break;
                case 'interactive':
                  messageType = 'interactive';
                  // Extrai o texto do botão ou lista selecionada
                  if (message.interactive?.button_reply) {
                    messageContent = message.interactive.button_reply.title || '';
                  } else if (message.interactive?.list_reply) {
                    messageContent = message.interactive.list_reply.title || '';
                  }
                  break;
                default:
                  messageType = 'text';
                  messageContent = JSON.stringify(message);
              }

              // Processa a mensagem
              await handleIncomingMessage(channel, {
                chat,
                from: message.from,
                externalId: message.from,
                externalName: contactName,
                messageId: message.id,
                timestamp: parseInt(message.timestamp) * 1000, // Converte para milissegundos
                type: messageType,
                message: {
                  type: messageType,
                  content: formatWhatsAppToMarkdown(messageContent),
                  mediaUrl,
                  mediaBase64: mediaData?.base64,
                  mimeType: mediaData?.mime_type,
                  mediaMetadata: mediaData?.download_failed ? {
                    id: mediaData.id,
                    mime_type: mediaData.mime_type,
                    sha256: mediaData.sha256,
                    file_size: mediaData.file_size,
                    download_failed: true,
                    error: mediaData.error
                  } : undefined,
                  raw: {
                    ...message,
                    contact: contact, // Inclui informações do contato
                    mediaData // Inclui dados da mídia baixada
                  }
                },
                fromMe: false
              });
            } catch (error) {
              Sentry.captureException(error);
              console.error('Erro ao processar mensagem individual:', error);
              // Continua processando outras mensagens mesmo se uma falhar
            }
          }
        }
      }
    }

    // Responde com sucesso
    res.json({ success: true });
  } catch (error) {
    Sentry.captureException(error);
    console.error('Erro ao processar webhook:', error);
    res.status(500).json({ error: error.message });
  }
}

export async function handleWhatsAppConnect({ accessToken, channelId, organizationId, sessionInfo }) {
  if (!accessToken) {
    throw new Error('Access token is required');
  }

  try {
    // Verificar se o canal existe e está inativo
    const { data: channel, error: channelError } = await supabase
      .from('chat_channels')
      .select('*')
      .eq('id', channelId)
      .eq('organization_id', organizationId)
      .eq('type', 'whatsapp_official')
      .single();

    if (channelError || !channel) {
      throw new Error('Canal não encontrado ou inválido');
    }

    let phoneNumberId, businessAccountId, displayPhoneNumber;

    // Se temos informações da sessão do Cadastro Incorporado, usá-las
    if (sessionInfo && sessionInfo.phone_number_id && sessionInfo.waba_id) {
      phoneNumberId = sessionInfo.phone_number_id;
      businessAccountId = sessionInfo.waba_id;
      
      // Obter informações do número de telefone
      try {
        const phoneInfoResponse = await axios({
          method: 'GET',
          url: `https://graph.facebook.com/v22.0/${phoneNumberId}`,
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        });
        
        displayPhoneNumber = phoneInfoResponse.data.display_phone_number || 
                            phoneInfoResponse.data.verified_name || 
                            'WhatsApp Business';
      } catch (error) {
        console.error('Erro ao obter informações do número:', error);
        displayPhoneNumber = 'WhatsApp Business';
      }
    } else {
      // Fluxo tradicional: buscar informações da conta do WhatsApp Business
      const response = await axios({
        method: 'GET',
        url: 'https://graph.facebook.com/v18.0/me/accounts',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'User-Agent': 'Interflow-WhatsApp-Connect/1.0'
        }
      });

      const accountData = response.data;
      
      if (!accountData.data || accountData.data.length === 0) {
        throw new Error('Nenhuma conta do WhatsApp Business encontrada');
      }
      
      phoneNumberId = accountData.data[0]?.id;
      businessAccountId = accountData.data[0]?.id;
      displayPhoneNumber = accountData.data[0]?.name || 'WhatsApp Business';
    }

    // Atualizar o canal com as credenciais do WhatsApp
    const { error: updateError } = await supabase
      .from('chat_channels')
      .update({
        credentials: {
          access_token: encrypt(accessToken),
          phone_number_id: phoneNumberId,
          business_account_id: businessAccountId,
          display_phone_number: displayPhoneNumber
        },
        status: 'active',
        is_connected: true,
        is_tested: true,
        settings: {
          autoReply: true,
          notifyNewTickets: true
        },
        updated_at: new Date().toISOString()
      })
      .eq('id', channelId)
      .eq('organization_id', organizationId);

    if (updateError) {
      throw updateError;
    }

    // Configurar webhook para o número de telefone
    try {
      await axios({
        method: 'POST',
        url: `https://graph.facebook.com/v22.0/${phoneNumberId}/subscribed_apps`,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        data: {
          access_token: accessToken
        }
      });
    } catch (error) {
      console.error('Erro ao configurar webhook:', error);
      // Não falha o processo principal se a configuração do webhook falhar
    }

  } catch (error) {
    Sentry.captureException(error);
    console.error('Error handling WhatsApp connection:', error);
    throw error;
  }
}

export async function handleSenderMessageOfficial(channel, messageData) {
  try {
    const accessToken = decrypt(channel.credentials.access_token);
    const phoneNumberId = channel.credentials.phone_number_id;
    messageData.content = formatMarkdownForWhatsApp(messageData.content);

    let messageBody;

    // Verifica se é uma mensagem de template
    if (messageData.type === 'template') {
      messageBody = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: messageData.to,
        type: "template",
        template: {
          name: messageData.templateName,
          language: {
            code: messageData.languageCode || "pt_BR"
          }
        }
      };

      // Adiciona componentes se existirem
      if (messageData.components) {
        // Se components já é um array, usa diretamente
        if (Array.isArray(messageData.components)) {
          messageBody.template.components = messageData.components;
        } else {
          // Se não é um array, converte o objeto em array de componentes
          messageBody.template.components = [{
            type: "body",
            parameters: Object.entries(messageData.components).map(([_, value]) => {
              if (typeof value === 'object' && value.type) {
                return value;
              }
              return {
                type: "text",
                text: value.toString()
              };
            })
          }];
        }
      }
    }
    // Verifica se é uma mensagem interativa com botões
    else if (messageData.type === 'interactive' && messageData.buttons) {
      messageBody = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: messageData.to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: messageData.content || "Selecione uma opção:"
          },
          action: {
            buttons: messageData.buttons.map((button, index) => ({
              type: "reply",
              reply: {
                id: button.id || `button_${index}`,
                title: button.title
              }
            }))
          }
        }
      };
    }
    // Verifica se é uma mensagem interativa com lista
    else if (messageData.type === 'interactive' && messageData.list) {
      messageBody = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: messageData.to,
        type: "interactive",
        interactive: {
          type: "list",
          header: messageData.list.header ? {
            type: "text",
            text: messageData.list.header
          } : undefined,
          body: {
            text: messageData.content || "Selecione uma opção da lista:"
          },
          footer: messageData.list.footer ? {
            text: messageData.list.footer
          } : undefined,
          action: {
            button: messageData.list.button || "Ver opções",
            sections: messageData.list.sections || [{
              title: "Opções",
              rows: messageData.list.items.map((item, index) => ({
                id: item.id || `item_${index}`,
                title: item.title,
                description: item.description
              }))
            }]
          }
        }
      };
    }
    // Verifica se é uma mensagem com anexo
    else if (messageData.attachments?.length > 0) {
      const attachment = messageData.attachments[0];
      
      
  

      let attachmentType = attachment.type;
      if(!attachment.type) {
        const fileExtension = (attachment.name ? attachment.name.split('.').pop().toLowerCase() : null);
        // Validação de tipos de arquivo aceitos pelo WhatsApp
        const validTypes = {
          audio: ['mp3', 'ogg'],
          image: ['jpg', 'jpeg', 'png'],
          video: ['mp4'],
          document: ['pdf', 'doc', 'docx']
        };

        if (validTypes.image.includes(fileExtension)) {
          attachmentType = 'image';
        } else if (validTypes.video.includes(fileExtension)) {
          attachmentType = 'video';
        } else if (validTypes.audio.includes(fileExtension)) {
          attachmentType = 'audio';
        } else if (validTypes.document.includes(fileExtension)) {
          attachmentType = 'document';
        }
      }

      if (!attachmentType) {
        throw new Error(`Tipo de arquivo não suportado: ${fileExtension}`);
      }

      messageBody = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: messageData.to,
        type: attachmentType,
        [attachmentType]: {
          link: attachment.url
        }
      };
    } 
    // Mensagem de texto padrão
    else {
      messageBody = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: messageData.to,
        type: "text",
        text: {
          body: messageData.content
        }
      };
    }

    console.log('Enviando mensagem:', JSON.stringify(messageBody, null, 2));

    const response = await axios({
      method: 'POST',
      url: `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Interflow-WhatsApp-Sender/1.0'
      },
      data: messageBody
    });

    const result = response.data;

    return {
      messageId: result.messages[0].id
    };
  } catch (error) {
    Sentry.captureException(error);
    console.error('Erro ao enviar mensagem WhatsApp:', error.response?.data || error);
    throw error;
  }
}

/**
 * Envia uma mensagem de template do WhatsApp
 * 
 * @param {Object} channel - Canal de comunicação WhatsApp
 * @param {string} to - Número de telefone do destinatário
 * @param {string} templateName - Nome do template a ser enviado
 * @param {string} languageCode - Código do idioma (ex: pt_BR, en_US)
 * @param {Object} variables - Variáveis do template
 * @returns {Promise<Object>} - Resultado do envio com messageId
 */
export async function sendWhatsAppTemplate(channel, to, templateName, languageCode = 'pt_BR', variables = {}) {
  try {
    // Formata os componentes no formato esperado pela API do WhatsApp
    const components = [];
    
    if (Object.keys(variables).length > 0) {
      components.push({
        type: "body",
        parameters: Object.entries(variables).map(([_, value]) => {
          // Se o valor é um objeto com tipo específico (currency, date_time)
          if (typeof value === 'object' && value.type) {
            return value;
          }
          // Caso contrário, assume que é texto
          return {
            type: "text",
            text: value.toString()
          };
        })
      });
    }

    return await handleSenderMessageOfficial(channel, {
      type: 'template',
      to,
      templateName,
      languageCode,
      components: components.length > 0 ? components : undefined
    });
  } catch (error) {
    Sentry.captureException(error);
    console.error('Erro ao enviar template WhatsApp:', error);
    throw error;
  }
}

/**
 * Envia uma mensagem interativa com botões pelo WhatsApp
 * 
 * @param {Object} channel - Canal de comunicação WhatsApp
 * @param {string} to - Número de telefone do destinatário
 * @param {string} content - Texto principal da mensagem
 * @param {Array} buttons - Array de objetos com {id, title} para os botões
 * @returns {Promise<Object>} - Resultado do envio com messageId
 * 
 * @example
 * // Exemplo de envio de mensagem com botões
 * const result = await sendWhatsAppButtons(
 *   channel,
 *   "5511999999999",
 *   "Como posso ajudar você hoje?",
 *   [
 *     { id: "btn_support", title: "Suporte" },
 *     { id: "btn_sales", title: "Vendas" },
 *     { id: "btn_info", title: "Informações" }
 *   ]
 * );
 */
export async function sendWhatsAppButtons(channel, to, content, buttons) {
  try {
    return await handleSenderMessageOfficial(channel, {
      to,
      type: 'interactive',
      content,
      buttons
    });
  } catch (error) {
    Sentry.captureException(error);
    console.error('Erro ao enviar botões WhatsApp:', error);
    throw error;
  }
}

/**
 * Envia uma mensagem interativa com lista de opções pelo WhatsApp
 * 
 * @param {Object} channel - Canal de comunicação WhatsApp
 * @param {string} to - Número de telefone do destinatário
 * @param {string} content - Texto principal da mensagem
 * @param {Object} list - Configuração da lista (header, footer, button, items ou sections)
 * @returns {Promise<Object>} - Resultado do envio com messageId
 * 
 * @example
 * // Exemplo de envio de mensagem com lista simples
 * const result = await sendWhatsAppList(
 *   channel,
 *   "5511999999999",
 *   "Escolha um produto:",
 *   {
 *     header: "Catálogo de Produtos",
 *     footer: "Preços sujeitos a alteração",
 *     button: "Ver produtos",
 *     items: [
 *       { id: "prod_1", title: "Camiseta", description: "R$ 49,90" },
 *       { id: "prod_2", title: "Calça", description: "R$ 89,90" },
 *       { id: "prod_3", title: "Tênis", description: "R$ 199,90" }
 *     ]
 *   }
 * );
 * 
 * // Exemplo com seções múltiplas
 * const result = await sendWhatsAppList(
 *   channel,
 *   "5511999999999",
 *   "Escolha uma categoria:",
 *   {
 *     header: "Catálogo",
 *     sections: [
 *       {
 *         title: "Roupas",
 *         rows: [
 *           { id: "clothes_1", title: "Camisetas", description: "Vários modelos" },
 *           { id: "clothes_2", title: "Calças", description: "Jeans e sociais" }
 *         ]
 *       },
 *       {
 *         title: "Calçados",
 *         rows: [
 *           { id: "shoes_1", title: "Tênis", description: "Esportivos" },
 *           { id: "shoes_2", title: "Sapatos", description: "Sociais" }
 *         ]
 *       }
 *     ]
 *   }
 * );
 */
export async function sendWhatsAppList(channel, to, content, list) {
  try {
    return await handleSenderMessageOfficial(channel, {
      to,
      type: 'interactive',
      content,
      list
    });
  } catch (error) {
    Sentry.captureException(error);
    console.error('Erro ao enviar lista WhatsApp:', error);
    throw error;
  }
}

/**
 * Manipula requisições para o proxy de mídia do WhatsApp
 * 
 * Esta função atua como um proxy para mídia do WhatsApp,
 * tentando baixar a mídia usando as credenciais do canal.
 * 
 * @param {Object} req - Requisição HTTP
 * @param {Object} res - Resposta HTTP
 */
export async function handleWhatsAppMediaProxy(req, res) {
  try {
    const { data } = req.query;
    
    if (!data) {
      return res.status(400).json({ error: 'Dados do proxy não fornecidos' });
    }
    
    // Decodifica os dados do proxy
    const proxyData = JSON.parse(Buffer.from(data, 'base64').toString());
    
    // Verifica se os dados são válidos
    if (!proxyData.media_id || !proxyData.url || !proxyData.channel_id) {
      return res.status(400).json({ error: 'Dados do proxy inválidos' });
    }
    
    // Verifica se o timestamp não expirou (24 horas)
    const expirationTime = 24 * 60 * 60 * 1000; // 24 horas em milissegundos
    if (Date.now() - proxyData.timestamp > expirationTime) {
      return res.status(410).json({ error: 'Link de mídia expirado' });
    }
    
    // Busca o canal
    const { data: channel } = await supabase
      .from('chat_channels')
      .select('*')
      .eq('id', proxyData.channel_id)
      .eq('status', 'active')
      .single();
    
    if (!channel) {
      return res.status(404).json({ error: 'Canal não encontrado' });
    }
    
    // Obtém o token de acesso
    const accessToken = decrypt(channel.credentials.access_token);
    
    if (!accessToken) {
      return res.status(401).json({ error: 'Token de acesso inválido' });
    }
    
    // Tenta baixar a mídia seguindo exatamente a documentação da Meta
    try {
      console.warn(`Proxy tentando baixar mídia: ${proxyData.url.substring(0, 100)}...`);
      
      const response = await axios({
        method: 'GET',
        url: proxyData.url,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'User-Agent': 'Interflow-WhatsApp-Media-Downloader/1.0'
        },
        responseType: 'stream',
        timeout: 30000
      });
      
      // Define o tipo de conteúdo
      res.setHeader('Content-Type', proxyData.mime_type || 'application/octet-stream');
      
      // Envia a mídia como stream
      response.data.pipe(res);
    } catch (error) {
      Sentry.captureException(error);
      console.error('Erro no proxy de mídia:', error.message);
      
      // Extrair detalhes do erro para melhor diagnóstico
      let errorMessage = error.message;
      let statusCode = 500;
      
      if (error.response) {
        // Resposta recebida com status de erro
        statusCode = error.response.status || 500;
        const statusText = error.response.statusText || '';
        let responseData = '';
        
        try {
          // Tenta converter o buffer de resposta para texto para diagnóstico
          if (error.response.data) {
            responseData = error.response.data.toString().substring(0, 500);
          }
        } catch (e) {
          responseData = '[Não foi possível ler o corpo da resposta]';
        }
        
        errorMessage = `Erro ${statusCode} ${statusText}: ${responseData}`;
      } else if (error.request) {
        // Requisição feita mas sem resposta
        errorMessage = `Sem resposta do servidor: ${error.message}`;
      }
      
      return res.status(statusCode).json({ 
        error: 'Não foi possível baixar a mídia', 
        details: errorMessage
      });
    }
  } catch (error) {
    Sentry.captureException(error);
    console.error('Erro no proxy de mídia:', error);
    return res.status(500).json({ error: 'Erro interno do servidor', details: error.message });
  }
}

/**
 * Obtém os templates do WhatsApp para um canal específico
 */
export async function getWhatsAppTemplates(req, res) {
  const { channelId } = req.params;
  const { sync } = req.query; // Parâmetro opcional para sincronizar com a API
  
  try {
    // Verificar se o canal existe e é do tipo whatsapp_official
    const { data: channel, error: channelError } = await supabase
      .from('chat_channels')
      .select('*')
      .eq('id', channelId)
      .eq('type', 'whatsapp_official')
      .single();
    
    if (channelError || !channel) {
      return res.status(404).json({ error: 'Canal não encontrado ou não é do tipo WhatsApp Official' });
    }
    
    // Se solicitado, sincronizar templates com a API do WhatsApp
    if (sync === 'true') {
      try {
        // Obter o token de acesso do canal
        const accessToken = decrypt(channel.credentials.access_token);
        if (!accessToken) {
          return res.status(401).json({ error: 'Token de acesso não disponível' });
        }
        
        // Obter o WABA ID (WhatsApp Business Account ID) das credenciais do canal
        const wabaId = channel.credentials.business_account_id;
        if (!wabaId) {
          return res.status(400).json({ error: 'ID da conta de negócios do WhatsApp não encontrado' });
        }
        
        // Buscar templates da API do WhatsApp
        const messageTemplatesResponse = await axios({
          method: 'GET',
          url: `https://graph.facebook.com/v22.0/${wabaId}/message_templates`,
          params: {
            fields: 'language,name,rejected_reason,status,category,sub_category,last_updated_time,components,quality_score',
            limit: 50
          },
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        });

        console.log(messageTemplatesResponse.data);
        
        const apiTemplates = messageTemplatesResponse.data.data || [];
        
        // Para cada template da API, atualizar ou criar no banco de dados
        for (const apiTemplate of apiTemplates) {
          // Verificar se o template já existe no banco
          const { data: existingTemplate, error: existingError } = await supabase
            .from('whatsapp_templates')
            .select('*')
            .eq('channel_id', channelId)
            .eq('template_id', apiTemplate.id)
            .maybeSingle();

          
          
          const templateData = {
            channel_id: channelId,
            template_id: apiTemplate.id,
            name: apiTemplate.name,
            language_code: apiTemplate.language,
            category: apiTemplate.category,
            components: apiTemplate.components,
            status: apiTemplate.status,
            rejection_reason: apiTemplate.rejected_reason,
            last_sync_at: new Date().toISOString()
          };

         
          if (existingTemplate) {
            // Atualizar template existente
            await supabase
              .from('whatsapp_templates')
              .update(templateData)
              .eq('id', existingTemplate.id);
          } else {
            try {
              // Criar novo template
              const { data: newTemplate, error: newTemplateError } = await supabase
                .from('whatsapp_templates')
                .insert(templateData);
                console.log(newTemplate, newTemplateError);
          
            } catch (error) {
              console.log(error);
            }
          }
        }
      } catch (syncError) {
        Sentry.captureException(syncError);
        console.error('Erro ao sincronizar templates:', syncError.response?.data || syncError.message);
        // Continuar para retornar os templates do banco, mesmo se a sincronização falhar
      }
    }
    
    // Buscar templates do banco de dados
    const { data: templates, error: templatesError } = await supabase
      .from('whatsapp_templates')
      .select('*')
      .eq('channel_id', channelId)
      .order('created_at', { ascending: false });
    
    if (templatesError) {
      Sentry.captureException(templatesError);
      return res.status(500).json({ error: 'Erro ao buscar templates' });
    }
    
    return res.json({ templates });
  } catch (error) {
    Sentry.captureException(error);
    return res.status(500).json({ error: error.message });
  }
}

/**
 * Cria um novo template do WhatsApp
 */
export async function createWhatsAppTemplate(req, res) {
  const { channelId } = req.params;
  const { name, language_code = 'pt_BR', category, components } = req.body;
  
  if (!name || !category || !components) {
    return res.status(400).json({ error: 'Nome, categoria e componentes são obrigatórios' });
  }
  
  try {
    // Verificar se o canal existe e é do tipo whatsapp_official
    const { data: channel, error: channelError } = await supabase
      .from('chat_channels')
      .select('*')
      .eq('id', channelId)
      .eq('type', 'whatsapp_official')
      .single();
    
    if (channelError || !channel) {
      return res.status(404).json({ error: 'Canal não encontrado ou não é do tipo WhatsApp Official' });
    }
    
    // Verificar se já existe um template com o mesmo nome e idioma
    const { data: existingTemplate, error: existingError } = await supabase
      .from('whatsapp_templates')
      .select('id')
      .eq('channel_id', channelId)
      .eq('name', name)
      .eq('language_code', language_code)
      .maybeSingle();
    
    if (existingTemplate) {
      return res.status(409).json({ error: 'Já existe um template com este nome e idioma' });
    }
    
    // Obter o token de acesso do canal
    const accessToken = decrypt(channel.credentials.access_token);

    if (!accessToken) {
      return res.status(401).json({ error: 'Token de acesso não disponível' });
    }
    
    // Obter o WABA ID (WhatsApp Business Account ID) das credenciais do canal
    const wabaId = channel.credentials.business_account_id;
    if (!wabaId) {
      return res.status(400).json({ error: 'ID da conta de negócios do WhatsApp não encontrado' });
    }
    
    // Criar template na API do WhatsApp
    try {
      // Preparar o payload para a API do WhatsApp
      const payload = {
        name,
        language: language_code,
        category,
        components
      };
      
      // Fazer a chamada à API do WhatsApp para criar o template
      const whatsappResponse = await axios({
        method: 'POST',
        url: `https://graph.facebook.com/v22.0/${wabaId}/message_templates`,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        data: payload
      });
      
      const templateId = whatsappResponse.data.id;
      
      // Salvar o template no banco de dados
      const { data: template, error: templateError } = await supabase
        .from('whatsapp_templates')
        .insert({
          channel_id: channelId,
          name,
          language_code,
          category,
          components,
          status: 'PENDING', // Status inicial
          template_id: templateId, // ID retornado pela API do WhatsApp
          last_sync_at: new Date().toISOString()
        })
        .select()
        .single();
      
      if (templateError) {
        Sentry.captureException(templateError);
        return res.status(500).json({ error: 'Erro ao salvar template' });
      }
      
      return res.status(201).json({ template });
    } catch (apiError) {
      Sentry.captureException(apiError);
      console.error('Erro na API do WhatsApp:', apiError.response?.data || apiError.message);
      return res.status(500).json({ 
        error: `${apiError.response?.data?.error?.message || apiError.message}: ${apiError.response?.data?.error?.error_user_title} - ${apiError.response?.data?.error?.error_user_msg}` 
      });
    }
  } catch (error) {
    Sentry.captureException(error);
    return res.status(500).json({ error: error.message });
  }
}

/**
 * Atualiza um template do WhatsApp existente
 */
export async function updateWhatsAppTemplate(req, res) {
  const { channelId, templateId } = req.params;
  const { name, language_code, category, components, status } = req.body;
  
  try {
    // Verificar se o canal existe e é do tipo whatsapp_official
    const { data: channel, error: channelError } = await supabase
      .from('chat_channels')
      .select('*')
      .eq('id', channelId)
      .eq('type', 'whatsapp_official')
      .single();
    
    if (channelError || !channel) {
      return res.status(404).json({ error: 'Canal não encontrado ou não é do tipo WhatsApp Official' });
    }
    
    // Verificar se o template existe
    const { data: existingTemplate, error: existingError } = await supabase
      .from('whatsapp_templates')
      .select('*')
      .eq('id', templateId)
      .eq('channel_id', channelId)
      .single();
    
    if (existingError || !existingTemplate) {
      return res.status(404).json({ error: 'Template não encontrado' });
    }
    
    // Obter o token de acesso do canal
    const accessToken = decrypt(channel.credentials.access_token);
    if (!accessToken) {
      return res.status(401).json({ error: 'Token de acesso não disponível' });
    }
    
    // Verificar se o template tem um ID válido na API do WhatsApp
    if (!existingTemplate.template_id) {
      return res.status(400).json({ error: 'Template não possui um ID válido na API do WhatsApp' });
    }
    
    // Atualizar template no WhatsApp API
    try {
      // Preparar o payload para a API do WhatsApp
      // Nota: Só podemos atualizar category ou components, não ambos ao mesmo tempo
      const payload = {};
      
      // Verificar o que está sendo atualizado
      if (category && components) {
        return res.status(400).json({ 
          error: 'Não é possível atualizar categoria e componentes ao mesmo tempo. Escolha apenas um.' 
        });
      }
      
      if (category) {
        payload.category = category;
      }
      
      if (components) {
        payload.components = components;
      }
      
      if (Object.keys(payload).length === 0) {
        return res.status(400).json({ error: 'Nenhum campo válido para atualização foi fornecido' });
      }
      
      // Fazer a chamada à API do WhatsApp para atualizar o template
      const whatsappResponse = await axios({
        method: 'POST',
        url: `https://graph.facebook.com/v22.0/${existingTemplate.template_id}`,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        data: payload
      });
      
      // Atualizar o template no banco de dados
      const updateData = {};
      if (name) updateData.name = name;
      if (language_code) updateData.language_code = language_code;
      if (category) updateData.category = category;
      if (components) updateData.components = components;
      if (status) updateData.status = status;
      
      updateData.last_sync_at = new Date().toISOString();
      
      const { data: updatedTemplate, error: updateError } = await supabase
        .from('whatsapp_templates')
        .update(updateData)
        .eq('id', templateId)
        .select()
        .single();
      
      if (updateError) {
        Sentry.captureException(updateError);
        return res.status(500).json({ error: 'Erro ao atualizar template' });
      }
      
      return res.json({ template: updatedTemplate });
    } catch (apiError) {
      Sentry.captureException(apiError);
      console.error('Erro na API do WhatsApp:', apiError.response?.data || apiError.message);
      return res.status(500).json({ 
        error: `Erro na API do WhatsApp: ${apiError.response?.data?.error?.message || apiError.message}` 
      });
    }
  } catch (error) {
    Sentry.captureException(error);
    return res.status(500).json({ error: error.message });
  }
}

/**
 * Exclui um template do WhatsApp
 */
export async function deleteWhatsAppTemplate(req, res) {
  const { channelId, templateId } = req.params;
  
  try {
    // Verificar se o canal existe e é do tipo whatsapp_official
    const { data: channel, error: channelError } = await supabase
      .from('chat_channels')
      .select('*')
      .eq('id', channelId)
      .eq('type', 'whatsapp_official')
      .single();
    
    if (channelError || !channel) {
      return res.status(404).json({ error: 'Canal não encontrado ou não é do tipo WhatsApp Official' });
    }
    
    // Verificar se o template existe
    const { data: existingTemplate, error: existingError } = await supabase
      .from('whatsapp_templates')
      .select('*')
      .eq('id', templateId)
      .eq('channel_id', channelId)
      .single();
    
    if (existingError || !existingTemplate) {
      return res.status(404).json({ error: 'Template não encontrado' });
    }
    
    // Obter o token de acesso do canal
    const accessToken = decrypt(channel.credentials.access_token);
    if (!accessToken && existingTemplate.template_id) {
      return res.status(401).json({ error: 'Token de acesso não disponível' });
    }
    
    // Obter o WABA ID (WhatsApp Business Account ID) das credenciais do canal
    const wabaId = channel.credentials.business_account_id;
    if (!wabaId && existingTemplate.template_id) {
      return res.status(400).json({ error: 'ID da conta de negócios do WhatsApp não encontrado' });
    }
    
    // Excluir template na API do WhatsApp, se tiver um template_id
    if (existingTemplate.template_id) {
      try {
        // Existem duas formas de excluir um template:
        // 1. Por nome (exclui todos os templates com o mesmo nome em diferentes idiomas)
        // 2. Por ID (exclui apenas o template específico)
        
        // Vamos usar a exclusão por ID, que é mais específica
        await axios({
          method: 'DELETE',
          url: `https://graph.facebook.com/v22.0/${wabaId}/message_templates`,
          params: {
            hsm_id: existingTemplate.template_id,
            name: existingTemplate.name
          },
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        });
      } catch (apiError) {
        // Apenas logar o erro, mas continuar com a exclusão no banco
        Sentry.captureException(apiError);
        console.error('Erro ao excluir template na API do WhatsApp:', apiError.response?.data || apiError.message);
      }
    }
    
    // Excluir o template do banco de dados
    const { error: deleteError } = await supabase
      .from('whatsapp_templates')
      .delete()
      .eq('id', templateId);
    
    if (deleteError) {
      Sentry.captureException(deleteError);
      return res.status(500).json({ error: 'Erro ao excluir template' });
    }
    
    return res.json({ success: true });
  } catch (error) {
    Sentry.captureException(error);
    return res.status(500).json({ error: error.message });
  }
}

/**
 * Rota para enviar templates do WhatsApp
 * 
 * @param {Object} req - Requisição HTTP
 * @param {Object} res - Resposta HTTP
 */
export async function sendWhatsAppTemplateRoute(req, res) {
  const { chatId } = req.params;
  const { templateId, variables } = req.body;

  try {
    // Buscar informações do chat
    const { data: chat, error: chatError } = await supabase
      .from('chats')
      .select(`
        *,
        channel:channel_id(*)
      `)
      .eq('id', chatId)
      .single();

    if (chatError || !chat) {
      return res.status(404).json({ error: 'Chat não encontrado' });
    }

    // Verificar se o canal é do tipo WhatsApp
    if (chat.channel.type !== 'whatsapp_official') {
      return res.status(400).json({ error: 'Este chat não é do tipo WhatsApp' });
    }

    // Buscar o template
    const { data: template, error: templateError } = await supabase
      .from('whatsapp_templates')
      .select('*')
      .eq('id', templateId)
      .single();

    if (templateError || !template) {
      return res.status(404).json({ error: 'Template não encontrado' });
    }

    // Gerar preview do template substituindo as variáveis
    let templatePreview = '';
    if (template.components) {
      template.components.forEach(component => {
        if (component.type === 'body' && component.text) {
          let text = component.text;
          // Substitui as variáveis {{1}}, {{2}}, etc pelos valores
          Object.entries(variables || {}).forEach(([key, value]) => {
            const varValue = typeof value === 'object' ? 
              (value.currency ? 
                `${value.currency.code} ${value.currency.fallback_value}` : 
                value.date_time ? 
                  value.date_time.fallback_value :
                  value.text || JSON.stringify(value)
              ) : value;
            text = text.replace(new RegExp(`{{${key}}}`, 'g'), varValue);
          });
          templatePreview += text;
        }
      });
    }

    // Se não conseguiu gerar o preview, usa o nome do template
    if (!templatePreview) {
      templatePreview = `Template: ${template.name}`;
    }

    // Enviar o template
    const result = await sendWhatsAppTemplate(
      chat.channel,
      chat.external_id,
      template.name,
      template.language_code,
      variables || {} // Garante que variables seja um objeto
    );

    const { error: messageError } = await supabase
      .from('messages')
      .insert({
        chat_id: chatId,
        content: templatePreview,
        type: 'template',
        sender_type: 'agent',
        sender_agent_id: req.profileId,
        organization_id: chat.organization_id,
        external_id: result.messageId,
        metadata: {
          template_id: template.id,
          template_name: template.name,
          preview: templatePreview,
          variables
        }
      });

    if (messageError) {
      throw messageError;
    }

    return res.json({ success: true, messageId: result.messageId });
  } catch (error) {
    Sentry.captureException(error);
    console.error('Erro ao enviar template:', error);
    return res.status(500).json({ error: error.message });
  }
}