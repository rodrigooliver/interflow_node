import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { uploadToS3, getActiveS3Integration } from '../../lib/s3.js';
import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';
import { createChat } from '../../services/chat.js';
import { findExistingChat } from '../webhooks/utils.js';
import { createFlowEngine } from '../../services/flow-engine.js';

import { handleSenderMessageWApi } from '../channels/wapi.js';
import { handleSenderMessageEmail } from '../../services/email.js';
import { handleSenderMessageInstagram } from '../channels/instagram.js';
// import { handleSenderMessageZApi } from '../../services/channels/z-api.js';
// import { handleSenderMessageEvolution } from '../../services/channels/evolution.js';
// import { handleSenderMessageOfficial } from '../../services/channels/official.js';
// import { handleSenderMessageFacebook } from '../../services/channels/facebook.js';

/**
 * Configurações e handlers para cada tipo de canal
 */
const CHANNEL_CONFIG = {
  whatsapp_official: {
    identifier: 'whatsapp',
    // handler: handleSenderMessageOfficial
  },
  whatsapp_wapi: {
    identifier: 'whatsapp',
    handler: handleSenderMessageWApi
  },
  whatsapp_zapi: {
    identifier: 'whatsapp',
    // handler: handleSenderMessageZApi
  },
  whatsapp_evo: {
    identifier: 'whatsapp',
    // handler: handleSenderMessageEvolution
  },
  instagram: {
    identifier: 'instagram_id',
    handler: handleSenderMessageInstagram
  },
  facebook: {
    identifier: 'facebook_id',
    // handler: handleSenderMessageFacebook
  },
  email: {
    identifier: 'email',
    handler: handleSenderMessageEmail
  }
};

/**
 * Normaliza o ID do contato e retorna possíveis variantes
 * @param {string} id - ID original do contato
 * @param {string} channelType - Tipo do canal
 * @returns {string[]} Array com ID normalizado e suas variantes
 */
const normalizeContactId = (id, channelType) => {
  if (!id) return [id];

  switch (channelType) {
    case 'whatsapp_official':
    case 'whatsapp_wapi':
    case 'whatsapp_zapi':
    case 'whatsapp_evo': {
      // Remove todos os caracteres não numéricos
      let numbers = id.replace(/\D/g, '');
      
      // Remove @s.whatsapp.net se existir (whatsapp_evo)
      numbers = numbers.split('@')[0];
      
      const variants = new Set(); // Usa Set para evitar duplicatas
      
      // Se começar com 55 e tiver 12 ou 13 dígitos, é um número brasileiro
      if (numbers.startsWith('55') && (numbers.length === 12 || numbers.length === 13)) {
        if (numbers.length === 13) { // tem 9
          // Versão sem 9
          const withoutNine = `${numbers.slice(0, 4)}${numbers.slice(5)}`;
          variants.add(`+${withoutNine}`);
          variants.add(withoutNine);
        } else if (numbers.length === 12) { // não tem 9
          // Versão com 9
          const withNine = `${numbers.slice(0, 4)}9${numbers.slice(4)}`;
          variants.add(`+${withNine}`);
          variants.add(withNine);
        }
      }
      
      // Adiciona versões com e sem + para qualquer número
      variants.add(`+${numbers}`);
      variants.add(numbers);
      
      return Array.from(variants);
    }
    
    case 'instagram':
    case 'facebook': {
      const normalized = id.toLowerCase();
      return [normalized];
    }
    
    case 'email': {
      const normalized = id.toLowerCase().trim();
      return [normalized];
    }
    
    default:
      return [id];
  }
};

/**
 * Processa mensagens recebidas em formato padronizado
 * 
 * Esta função lida com mensagens recebidas de diferentes canais de comunicação,
 * incluindo mensagens com anexos de mídia (imagens, vídeos, áudios, documentos).
 * 
 * Suporta recebimento de mídia via:
 * - URLs diretas
 * - Dados base64 (especialmente útil para webhooks do WAPI)
 * - Download via API do canal quando necessário
 * 
 * @param {Object} channel - Canal de comunicação
 * @param {Object} messageData - Dados normalizados da mensagem
 * @param {string} messageData.messageId - ID único da mensagem
 * @param {string} messageData.timestamp - Momento do envio
 * @param {string} messageData.externalId - ID do contato externo
 * @param {string} messageData.externalName - Nome do contato externo
 * @param {string} messageData.externalProfilePicture - URL da foto do contato externo
 * @param {Object} messageData.message - Dados da mensagem
 * @param {string} messageData.message.type - Tipo da mensagem (text, image, etc)
 * @param {string} messageData.message.content - Conteúdo da mensagem
 * @param {Object} messageData.message.raw - Dados brutos originais
 * @param {boolean} messageData.fromMe - Se foi uma mensagem enviada por mim
 */
export async function handleIncomingMessage(channel, messageData) {
  const { organization } = channel;
  
  try {
    const transaction = Sentry.startTransaction({
      name: 'handle-incoming-message',
      op: 'message.incoming',
      data: {
        channelType: channel.type,
        organizationId: organization.id
      }
    });

    const channelConfig = CHANNEL_CONFIG[channel.type];
    if (!channelConfig) {
      throw new Error(`Unsupported channel type: ${channel.type}`);
    }

    let chat = messageData.chat;
    let customer = chat?.customers;
    let isFirstMessage = false;

    if (!chat) {
      const identifierColumn = channelConfig.identifier;
      const normalizedId = normalizeContactId(messageData.externalId, channel.type);

      const { data: chats, error } = await supabase
        .from('chats')
        .select('*, customers(*)')
        .eq('channel_id', channel.id)
        .in('status', ['in_progress', 'pending'])
        .eq('external_id', messageData.externalId)
        .order('created_at', { ascending: false })
        .limit(1);

      chat = chats?.[0] || null;

      if (chat) {
        customer = chat.customers;
      } else {
        isFirstMessage = true;

        try {
          const possibleIds = normalizeContactId(messageData.externalId, channel.type);
          
          const { data: existingCustomer, error: findError } = await supabase
            .from('customers')
            .select('*')
            .eq('organization_id', organization.id)
            .in(identifierColumn, possibleIds)
            .single();

          if (findError && findError.code !== 'PGRST116') throw findError;

          if (existingCustomer) {
            customer = existingCustomer;
          } else {
            try {
              const customerData = {
                organization_id: organization.id,
                name: messageData.externalName || messageData.externalId,
                ...(messageData.externalProfilePicture && { profile_picture: messageData.externalProfilePicture }),
                [identifierColumn]: possibleIds[0]
              };

              const { data: newCustomer, error: createError } = await supabase
                .from('customers')
                .insert(customerData)
                .select()
                .single();

              if (createError) throw createError;
              customer = newCustomer;
            } catch (error) {
              Sentry.captureException(error, {
                extra: { channel, messageData, context: 'creating_customer' }
              });
              throw error;
            }
          }
        } catch (error) {
          Sentry.captureException(error, {
            extra: { channel, messageData, context: 'finding_customer' }
          });
          throw error;
        }

        try {
          chat = await createChat({
            organization_id: organization.id,
            customer_id: customer.id,
            channel_id: channel.id,
            external_id: messageData.externalId,
            status: 'pending',
            ...(messageData.externalProfilePicture && { profile_picture: messageData.externalProfilePicture }),
          });

          if (!chat) throw new Error('Failed to create chat');
        } catch (error) {
          Sentry.captureException(error, {
            extra: { channel, messageData, context: 'creating_chat' }
          });
          throw error;
        }
      }
    }

    // Verifica se a mensagem já existe quando for messageSent
    if (messageData.event === 'messageSent' && messageData.fromMe) {
      const { data: existingMessage, error: findMessageError } = await supabase
        .from('messages')
        .select('*')
        .eq('external_id', messageData.messageId)
        .single();

      if (findMessageError && findMessageError.code !== 'PGRST116') throw findMessageError;

      if (existingMessage) {
        const { error: updateError } = await supabase
          .from('messages')
          .update({ status: 'sent' })
          .eq('id', existingMessage.id);

        if (updateError) throw updateError;
        return;
      }
    }

    // Processar anexos se existirem
    let attachments = [];
    let fileRecords = [];
    
    if (messageData.message.mediaUrl || 
        (messageData.message.raw && 
         (messageData.message.raw.image || 
          messageData.message.raw.video || 
          messageData.message.raw.audio || 
          messageData.message.raw.document || 
          messageData.message.raw.sticker))) {
      
      try {
        const mediaResult = await processMessageMedia(messageData, organization.id);
        if (mediaResult) {
          attachments = [mediaResult.attachment];
          fileRecords = [mediaResult.fileRecord];
        }
      } catch (error) {
        console.error('Erro ao processar mídia da mensagem:', error);
        Sentry.captureException(error, {
          extra: { channel, messageData, context: 'processing_message_media' }
        });
        // Continua o processamento mesmo se falhar o upload da mídia
      }
    }

    // Cadastra a mensagem recebida
    const { data: message, error: messageError } = await supabase
      .from('messages')
      .insert({
        chat_id: chat.id,
        organization_id: organization.id,
        content: messageData.message.content,
        type: messageData.message.type,
        sender_type: messageData.fromMe ? 'agent' : 'customer',
        status: messageData.fromMe ? 'sent' : 'delivered',
        external_id: messageData.messageId,
        ...(messageData.fromMe 
          ? {}
          : { sender_customer_id: customer.id }
        ),
        metadata: messageData.message.raw,
        attachments: attachments.length > 0 ? attachments : undefined
      })
      .select()
      .single();

    if (messageError) throw messageError;

    // Registrar arquivos vinculados à mensagem
    if (fileRecords.length > 0) {
      for (const fileRecord of fileRecords) {
        fileRecord.message_id = message.id;
      }
      
      const { error: filesError } = await supabase
        .from('files')
        .insert(fileRecords);

      if (filesError) {
        console.error('Erro ao registrar arquivos:', filesError);
        Sentry.captureException(filesError, {
          extra: { fileRecords, context: 'registering_message_files' }
        });
        // Não falhar a operação principal se o registro de arquivos falhar
      }
    }

    // Atualiza o last_message_id do chat
    const { error: updateError } = await supabase
      .from('chats')
      .update({ last_message_id: message.id })
      .eq('id', chat.id);

    if (updateError) throw updateError;

    const flowEngine = createFlowEngine(organization, channel, customer, chat.id, {
      isFirstMessage,
      lastMessage: message
    });

    await flowEngine.processMessage({
      content: messageData.message.content,
      type: messageData.message.type,
      metadata: messageData.message.raw
    });

    transaction.finish();
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channel,
        messageData
      }
    });
    throw error;
  }
}

/**
 * Processa mídia de mensagens recebidas
 * 
 * Esta função extrai, baixa e armazena arquivos de mídia recebidos em mensagens.
 * Suporta múltiplos métodos de obtenção da mídia, em ordem de prioridade:
 * 
 * 1. Dados base64 incluídos diretamente no webhook (mediaBase64)
 * 2. Download direto da URL fornecida (mediaUrl)
 * 3. Download via API do canal usando credenciais e messageId
 * 
 * Após obter o arquivo, faz upload para o armazenamento configurado (S3 ou Supabase)
 * e retorna os dados necessários para vincular o arquivo à mensagem.
 * 
 * @param {Object} messageData - Dados da mensagem
 * @param {string} organizationId - ID da organização
 * @returns {Promise<Object>} - Dados do arquivo processado (attachment e fileRecord)
 */
async function processMessageMedia(messageData, organizationId) {
  try {
    // Extrair dados da mídia
    const raw = messageData.message.raw || {};
    let mediaUrl = messageData.message.mediaUrl;
    let mimeType = messageData.message.mimeType;
    let fileName = messageData.message.fileName;
    let caption = messageData.message.content;
    let mediaBase64 = messageData.message.mediaBase64;
    let mediaKey = null;
    let directPath = null;
    
    // Extrair dados da mídia dos dados brutos se não fornecidos diretamente
    if (!mediaUrl && !mediaBase64) {
      if (raw.image) {
        mediaUrl = raw.image.url;
        mimeType = raw.image.mimetype || 'image/jpeg';
        caption = raw.image.caption || caption;
        mediaKey = raw.image.mediaKey;
        directPath = raw.image.directPath;
        mediaBase64 = raw.image.imageBase64;
      } else if (raw.video) {
        mediaUrl = raw.video.url;
        mimeType = raw.video.mimetype || 'video/mp4';
        caption = raw.video.caption || caption;
        mediaKey = raw.video.mediaKey;
        directPath = raw.video.directPath;
        mediaBase64 = raw.video.videoBase64;
      } else if (raw.audio) {
        mediaUrl = raw.audio.url;
        mimeType = raw.audio.mimetype || 'audio/ogg';
        mediaKey = raw.audio.mediaKey;
        directPath = raw.audio.directPath;
        mediaBase64 = raw.audio.audioBase64;
      } else if (raw.document) {
        mediaUrl = raw.document.url;
        mimeType = raw.document.mimetype || 'application/octet-stream';
        fileName = raw.document.fileName || fileName;
        caption = raw.document.caption || caption;
        mediaKey = raw.document.mediaKey;
        directPath = raw.document.directPath;
        mediaBase64 = raw.document.documentBase64;
      } else if (raw.sticker) {
        mediaUrl = raw.sticker.url;
        mimeType = raw.sticker.mimetype || 'image/webp';
        mediaKey = raw.sticker.mediaKey;
        directPath = raw.sticker.directPath;
        mediaBase64 = raw.sticker.stickerBase64;
      }
    }
    
    // Gerar nome de arquivo se não fornecido
    if (!fileName) {
      const fileId = uuidv4();
      const extension = mimeType.split('/')[1] || '';
      fileName = `${fileId}.${extension}`;
    }
    
    // Verificar se existe integração ativa de S3
    const s3Integration = await getActiveS3Integration(organizationId);
    
    // Obter o buffer do arquivo
    let fileBuffer;
    
    // Verificar se temos base64 disponível (prioridade mais alta)
    if (mediaBase64) {
      try {
        // Remover prefixo "data:image/jpeg;base64," se existir
        const base64Data = mediaBase64.includes('base64,') 
          ? mediaBase64.split('base64,')[1] 
          : mediaBase64;
          
        fileBuffer = Buffer.from(base64Data, 'base64');
        console.log('Usando mídia base64 fornecida pelo webhook');
      } catch (base64Error) {
        console.error('Erro ao processar mídia base64:', base64Error);
        // Se falhar, tentaremos outros métodos
      }
    }
    
    // Se não temos buffer do base64, tentar baixar da URL
    if (!fileBuffer && mediaUrl) {
      try {
        // Tentar baixar diretamente da URL
        const response = await fetch(mediaUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        });
        
        if (!response.ok) {
          throw new Error(`Falha ao baixar mídia: ${response.statusText}`);
        }
        
        fileBuffer = Buffer.from(await response.arrayBuffer());
        console.log('Mídia baixada com sucesso da URL');
      } catch (downloadError) {
        console.error('Erro ao baixar mídia diretamente:', downloadError);
        // Se falhar, tentaremos o próximo método
      }
    }
    
    // Se ainda não temos o buffer, tentar via API do canal
    if (!fileBuffer && messageData.channel) {
      try {
        // Buscar credenciais do canal
        const { data: channelData } = await supabase
          .from('chat_channels')
          .select('credentials, type')
          .eq('id', messageData.channel.id)
          .single();
          
        if (channelData) {
          // Processar de acordo com o tipo de canal
          if (channelData.type === 'whatsapp_wapi') {
            const credentials = channelData.credentials || {};
            const apiHost = credentials.apiHost;
            const apiToken = credentials.apiToken ? decrypt(credentials.apiToken) : null;
            const apiConnectionKey = credentials.apiConnectionKey ? decrypt(credentials.apiConnectionKey) : null;
            
            if (apiHost && apiToken && apiConnectionKey && messageData.messageId) {
              // Construir URL para download via API do WAPI
              const downloadUrl = `https://${apiHost}/instance/downloadMedia?connectionKey=${apiConnectionKey}&messageId=${messageData.messageId}`;
              
              const apiResponse = await fetch(downloadUrl, {
                headers: {
                  'Authorization': `Bearer ${apiToken}`
                }
              });
              
              if (!apiResponse.ok) {
                throw new Error(`Falha ao baixar mídia via API: ${apiResponse.statusText}`);
              }
              
              fileBuffer = Buffer.from(await apiResponse.arrayBuffer());
              console.log('Mídia baixada com sucesso via API do WAPI');
            }
          }
          // Adicionar outros tipos de canal conforme necessário
        }
      } catch (apiError) {
        console.error('Erro ao baixar mídia via API do canal:', apiError);
        // Se falhar, não temos mais opções
      }
    }
    
    // Se não conseguimos obter o buffer por nenhum método, falhar
    if (!fileBuffer) {
      throw new Error('Não foi possível obter o conteúdo da mídia por nenhum método');
    }
    
    const fileId = uuidv4();
    let fileUrl;
    let fileKey;
    let storageType;
    
    if (s3Integration) {
      // Upload para S3 com integração personalizada
      const uploadResult = await uploadToS3({
        file: fileBuffer,
        fileName: fileName,
        contentType: mimeType,
        folder: `organizations/${organizationId}/chat-files`,
        organizationId
      });
      
      fileUrl = uploadResult.url;
      fileKey = uploadResult.key;
      storageType = 's3';
    } else {
      // Upload para o bucket padrão do Supabase
      const filePath = `${organizationId}/chat-attachments/${fileName}`;
      
      const { error: uploadError } = await supabase.storage
        .from('attachments')
        .upload(filePath, fileBuffer, {
          contentType: mimeType,
          cacheControl: '3600'
        });

      if (uploadError) {
        throw new Error(`Erro ao fazer upload do arquivo: ${uploadError.message}`);
      }

      // Obter URL pública
      const { data: urlData } = supabase.storage
        .from('attachments')
        .getPublicUrl(filePath);
        
      fileUrl = urlData.publicUrl;
      fileKey = filePath;
      storageType = 'supabase';
    }
    
    // Preparar registro para o banco de dados
    const fileRecord = {
      id: fileId,
      organization_id: organizationId,
      name: fileName,
      size: fileBuffer.byteLength,
      public_url: fileUrl,
      path: fileKey,
      integration_id: s3Integration ? s3Integration.id : null,
      mime_type: mimeType,
      created_at: new Date().toISOString()
    };
    
    // Preparar dados de anexo para a mensagem
    const attachment = {
      id: fileId,
      name: fileName,
      url: fileUrl,
      key: fileKey,
      type: mimeType.split('/')[0],
      mime_type: mimeType,
      size: fileBuffer.byteLength,
      storage: storageType
    };
    
    return {
      attachment,
      fileRecord
    };
  } catch (error) {
    console.error('Erro ao processar mídia:', error);
    throw error;
  }
}

/**
 * Atualiza o status de uma mensagem com base em dados de webhook
 * 
 * Esta função é chamada quando um webhook de atualização de status é recebido,
 * permitindo rastrear o progresso da entrega de mensagens (enviada, entregue, lida, falha).
 * 
 * @param {Object} channel - Canal de comunicação
 * @param {Object} messageData - Dados da atualização de status
 * @param {string} messageData.messageId - ID da mensagem a ser atualizada
 * @param {string} messageData.status - Novo status da mensagem
 * @param {string} [messageData.error] - Mensagem de erro, se houver
 */
export async function handleStatusUpdate(channel, messageData) {
  try {
    // Start a new transaction for error tracking
    const transaction = Sentry.startTransaction({
      name: 'handle-status-update',
      op: 'message.status',
      data: {
        channelType: channel.type,
        status: messageData.status
      }
    });

    // Update message status based on webhook data
    const { data: message } = await supabase
      .from('messages')
      .select('*')
      .eq('metadata->messageId', messageData.messageId)
      .single();

    if (message) {
      await supabase
        .from('messages')
        .update({
          status: messageData.status,
          error_message: messageData.error
        })
        .eq('id', message.id);
    }

    // Finish the transaction
    transaction.finish();
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channel,
        messageData
      }
    });
    console.error('Error handling status update:', error);
    throw error;
  }
}

/**
 * Verifica se o canal deve ser desconectado com base no histórico de falhas
 * 
 * Analisa as últimas mensagens enviadas pelo canal para determinar se há
 * um padrão de falhas que justifique a desconexão automática do canal.
 * 
 * @param {string} channelId - ID do canal a ser verificado
 * @returns {Promise<boolean>} - True se o canal deve ser desconectado
 */
async function shouldDisconnectChannel(channelId) {
  try {
    // Busca as últimas 5 mensagens enviadas neste canal usando JOIN
    const { data: recentMessages, error } = await supabase
      .from('messages')
      .select('messages.status, messages.error_message')
      .join('chats', 'messages.chat_id = chats.id')
      .eq('chats.channel_id', channelId)
      .eq('messages.sender_type', 'agent')
      .eq('messages.sent_from_system', true)
      .order('messages.created_at', { ascending: false })
      .limit(5);
    
    if (error) throw error;
    
    // Se não houver mensagens suficientes para análise
    if (!recentMessages || recentMessages.length < 3) return false;
    
    // Conta quantas das últimas mensagens falharam
    const failedCount = recentMessages.filter(msg => msg.status === 'failed').length;
    
    // Se 3 ou mais das últimas 5 mensagens falharam, desconecta o canal
    return failedCount >= 3;
  } catch (error) {
    console.error('Erro ao verificar histórico de falhas do canal:', error);
    Sentry.captureException(error, {
      extra: { channelId, context: 'checking_channel_failures' }
    });
    return false; // Em caso de erro na verificação, não desconecta
  }
}

/**
 * Marca um canal como desconectado após falhas consecutivas
 * 
 * Atualiza o status do canal para desconectado e registra informações sobre o erro
 * que causou a desconexão nas configurações do canal.
 * 
 * @param {string} channelId - ID do canal a ser desconectado
 * @param {string} errorMessage - Mensagem de erro que causou a desconexão
 */
async function disconnectChannel(channelId, errorMessage) {
  try {
    // Primeiro, busca o canal para obter as configurações atuais
    const { data: channelData } = await supabase
      .from('chat_channels')
      .select('settings')
      .eq('id', channelId)
      .single();
    
    // Atualiza as configurações com as informações de erro
    const updatedSettings = {
      ...(channelData?.settings || {}),
      last_error: errorMessage,
      last_error_at: new Date().toISOString()
    };
    
    // Marca o canal como desconectado
    const { error: channelUpdateError } = await supabase
      .from('chat_channels')
      .update({ 
        is_connected: false,
        is_tested: false,
        settings: updatedSettings,
        updated_at: new Date().toISOString()
      })
      .eq('id', channelId);
    
    if (channelUpdateError) {
      console.error('Erro ao marcar canal como desconectado:', channelUpdateError);
    } else {
      console.log(`Canal ${channelId} marcado como desconectado após falhas consecutivas.`);
    }
  } catch (error) {
    console.error('Erro ao desconectar canal:', error);
    Sentry.captureException(error, {
      extra: { channelId, errorMessage, context: 'disconnecting_channel' }
    });
  }
}

/**
 * Envia uma mensagem do sistema através do canal apropriado
 * 
 * Processa o envio de mensagens geradas pelo sistema, incluindo tentativas
 * de reenvio em caso de falha. Suporta diferentes tipos de mensagens e anexos.
 * 
 * @param {string} messageId - ID da mensagem a ser enviada
 * @param {number} attempt - Número da tentativa atual (para retry)
 * @returns {Promise<Object>} - Resultado do envio com messageId externo
 */
export async function sendSystemMessage(messageId, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY = 2000; // 2 segundos entre tentativas
  
  try {
    // Busca a mensagem com dados do chat e do canal
    const { data: message, error: messageError } = await supabase
      .from('messages')
      .select(`
        *,
        chat:chats!messages_chat_id_fkey (
          external_id,
          channel:chat_channels!chats_channel_id_fkey (
            *,
            organization:organizations(*)
          )
        )
      `)
      .eq('id', messageId)
      .single();

    if (messageError) throw messageError;
    
    const chat = message.chat;
    const channel = chat.channel;
    
    const channelConfig = CHANNEL_CONFIG[channel.type];
    if (!channelConfig) {
      throw new Error(`Handler não encontrado para o canal tipo: ${channel.type}`);
    }
    
    if (!channelConfig.handler) {
      throw new Error(`Handler não implementado para o canal tipo: ${channel.type}`);
    }

    const transaction = Sentry.startTransaction({
      name: 'send-system-message',
      op: 'message.system.send',
      data: {
        channelType: channel.type,
        organizationId: channel.organization_id,
        attempt: attempt
      }
    });

    // Usa o handler específico do canal
    const result = await channelConfig.handler(channel, {
      messageId: message.id,
      content: message.content,
      type: message.type,
      attachments: message.attachments,
      to: chat.external_id,
      chat_id: message.chat_id,
      sender_customer_id: message.sender_customer_id,
      sender_agent_id: message.sender_agent_id
    });

    // Atualiza status da mensagem e external_id
    const { error: updateError } = await supabase
      .from('messages')
      .update({ 
        status: 'sent',
        external_id: result.messageId,
        error_message: null // Limpa mensagem de erro anterior se existir
      })
      .eq('id', message.id);

    if (updateError) throw updateError;

    transaction.finish();
    return result;
    
  } catch (error) {
    console.log(`Erro ao enviar mensagem (tentativa ${attempt}/${MAX_ATTEMPTS}):`, error);
    
    // Verifica se deve tentar novamente
    if (attempt < MAX_ATTEMPTS) {
      console.log(`Tentando novamente em ${RETRY_DELAY/1000} segundos...`);
      
      // Atualiza status da mensagem para retry
      await supabase
        .from('messages')
        .update({ 
          status: 'retry',
          error_message: `Tentativa ${attempt}/${MAX_ATTEMPTS} falhou: ${error.message}`
        })
        .eq('id', messageId);
      
      // Espera antes de tentar novamente
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          sendSystemMessage(messageId, attempt + 1)
            .then(resolve)
            .catch(reject);
        }, RETRY_DELAY);
      });
    }
    
    // Se chegou aqui, todas as tentativas falharam
    // Busca novamente a mensagem para obter o ID do canal
    const { data: failedMessage } = await supabase
      .from('messages')
      .select(`
        chat:chats!messages_chat_id_fkey (
          channel_id
        )
      `)
      .eq('id', messageId)
      .single();
    
    // Atualiza status da mensagem para erro
    await supabase
      .from('messages')
      .update({ 
        status: 'failed',
        error_message: `Falha após ${MAX_ATTEMPTS} tentativas. Último erro: ${error.message}`
      })
      .eq('id', messageId);
    
    // Verifica se deve desconectar o canal com base no histórico de falhas
    if (failedMessage && failedMessage.chat) {
      const channelId = failedMessage.chat.channel_id;
      const shouldDisconnect = await shouldDisconnectChannel(channelId);
      
      if (shouldDisconnect) {
        await disconnectChannel(channelId, error.message);
      }
    }

    Sentry.captureException(error, {
      extra: { 
        messageId,
        context: 'sending_system_message',
        attempts: attempt
      }
    });
    
    throw error;
  }
}


export async function createMessageRoute(req, res) {
  // Obter chatId e organizationId dos parâmetros da rota
  const { chatId, organizationId } = req.params;
  
  // Em requisições multipart/form-data, os campos de texto estão em req.body
  const content = req.body.content || null;
  const replyToMessageId = req.body.replyToMessageId || null;

  const files = req.files;
  const userId = req.profileId;

  try {
    // Validar se o chat pertence à organização e obter informações do canal
    const { data: chatData, error: chatError } = await supabase
      .from('chats')
      .select(`
        id, 
        organization_id,
        channel_id,
        channel_details:channel_id (
          id,
          type
        )
      `)
      .eq('id', chatId)
      .eq('organization_id', organizationId)
      .single();

    if (chatError || !chatData) {
      return res.status(404).json({ 
        success: false, 
        error: 'Chat não encontrado ou sem permissão' 
      });
    }

    // Verificar o tipo de canal
    const channelType = chatData.channel_details?.type || 'email';
    const isSocialChannel = [
      'whatsapp_official', 
      'whatsapp_wapi', 
      'whatsapp_zapi', 
      'whatsapp_evo', 
      'instagram', 
      'facebook'
    ].includes(channelType);

    // Verificar se existe integração ativa de S3
    const s3Integration = await getActiveS3Integration(organizationId);
    
    // Preparar anexos
    const attachments = [];
    const fileRecords = [];
    const messages = [];

    // Verificar se há arquivos para processar
    const hasFiles = files && files.attachments;

    // Processar uploads de arquivos
    if (hasFiles) {
      const uploadPromises = Array.isArray(files.attachments) 
        ? files.attachments 
        : [files.attachments]; 

      for (const file of uploadPromises) {
        const fileId = uuidv4();
        const fileExtension = path.extname(file.name);
        const fileName = `${fileId}${fileExtension}`;
        const fileType = file.mimetype.split('/')[0]; // image, video, application, etc.

        let fileUrl;
        let fileKey;
        let storageType;

        if (s3Integration) {
          // Upload para S3 com integração personalizada
          const uploadResult = await uploadToS3({
            file: file.data,
            fileName: fileName,
            contentType: file.mimetype,
            folder: `organizations/${organizationId}/chat-files`,
            organizationId
          });
          
          fileUrl = uploadResult.url;
          fileKey = uploadResult.key;
          storageType = 's3';
        } else {
          // Upload para o bucket padrão do Supabase
          const filePath = `${organizationId}/chat-attachments/${fileName}`;
          
          const { error: uploadError, data: uploadData } = await supabase.storage
            .from('attachments')
            .upload(filePath, file.data, {
              contentType: file.mimetype,
              cacheControl: '3600'
            });

          if (uploadError) {
            throw new Error(`Erro ao fazer upload do arquivo: ${uploadError.message}`);
          }

          // Obter URL pública
          const { data: urlData } = supabase.storage
            .from('attachments')
            .getPublicUrl(filePath);
            
          fileUrl = urlData.publicUrl;
          fileKey = filePath;
          storageType = 'supabase';
        }

        const fileAttachment = {
          id: fileId,
          name: file.name,
          url: fileUrl,
          key: fileKey,
          type: fileType,
          mime_type: file.mimetype,
          size: file.size,
          storage: storageType
        };

        // Preparar registro para a tabela files
        fileRecords.push({
          id: fileId,
          organization_id: organizationId,
          name: file.name,
          size: file.size,
          public_url: fileUrl,
          path: fileKey,
          integration_id: s3Integration ? s3Integration.id : null,
          mime_type: file.mimetype,
          created_at: new Date().toISOString()
        });

        // Para canais sociais, cada arquivo é uma mensagem separada
        if (isSocialChannel) {
          // Determinar o tipo de mensagem com base no tipo de arquivo
          let messageType = 'document';
          if (fileType === 'image') messageType = 'image';
          if (fileType === 'video') messageType = 'video';
          if (fileType === 'audio') messageType = 'audio';

          messages.push({
            chat_id: chatId,
            organization_id: organizationId,
            sender_agent_id: userId,
            sender_type: 'agent',
            content: null, // Sem conteúdo de texto
            type: messageType,
            response_message_id: replyToMessageId,
            attachments: [fileAttachment],
            status: 'pending',
            created_at: new Date().toISOString()
          });
        } else {
          // Para email, adicionar à lista de anexos
          attachments.push(fileAttachment);
        }
      }
    }

    // Adicionar mensagem de texto
    if (content) {
      if (isSocialChannel && hasFiles) {
        // Para canais sociais com arquivos, adicionar mensagem de texto separada
        messages.push({
          chat_id: chatId,
          organization_id: organizationId,
          sender_agent_id: userId,
          sender_type: 'agent',
          content: content,
          type: 'text',
          response_message_id: replyToMessageId,
          attachments: [],
          status: 'pending',
          created_at: new Date().toISOString()
        });
      } else if (!isSocialChannel && hasFiles) {
        // Para email com arquivos, uma única mensagem com todos os anexos
        messages.push({
          chat_id: chatId,
          organization_id: organizationId,
          sender_agent_id: userId,
          sender_type: 'agent',
          content: content,
          type: 'email',
          response_message_id: replyToMessageId,
          attachments: attachments,
          status: 'pending',
          created_at: new Date().toISOString()
        });
      } else {
        // Apenas texto para qualquer tipo de canal
        messages.push({
          chat_id: chatId,
          organization_id: organizationId,
          sender_agent_id: userId,
          sender_type: 'agent',
          content: content,
          type: isSocialChannel ? 'text' : 'email',
          response_message_id: replyToMessageId,
          attachments: [],
          status: 'pending',
          created_at: new Date().toISOString()
        });
      }
    } else if (!hasFiles) {
      // Se não há conteúdo nem arquivos
      return res.status(400).json({
        success: false,
        error: 'Nenhum conteúdo ou anexo fornecido'
      });
    } else if (!isSocialChannel && !content && hasFiles) {
      // Para email sem texto, mas com anexos
      messages.push({
        chat_id: chatId,
        organization_id: organizationId,
        sender_agent_id: userId,
        sender_type: 'agent',
        content: null,
        type: 'email',
        response_message_id: replyToMessageId,
        attachments: attachments,
        status: 'pending',
        created_at: new Date().toISOString()
      });
    }

    // Se não houver mensagens para inserir (caso raro)
    if (messages.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Nenhum conteúdo ou anexo fornecido'
      });
    }

    // Inserir mensagens no banco
    const { data: messagesData, error: messagesError } = await supabase
      .from('messages')
      .insert(messages)
      .select('*');

    if (messagesError) {
      console.error('Erro ao criar mensagens:', messagesError);
      return res.status(500).json({ 
        success: false, 
        error: 'Erro ao criar mensagens' 
      });
    }

    // Atualizar a referência da última mensagem
    // Garantir que pegamos a última mensagem mesmo quando há apenas uma
    const lastMessage = messagesData.length > 0 ? messagesData[messagesData.length - 1] : null;
    
    if (lastMessage) {
      await supabase
        .from('chats')
        .update({ 
          last_message_id: lastMessage.id
        })
        .eq('id', chatId);
    }

    // Inserir registros de arquivos na tabela files
    if (fileRecords.length > 0) {
      // Mapear arquivos para suas respectivas mensagens
      for (let i = 0; i < fileRecords.length; i++) {
        // Para canais sociais, cada arquivo tem sua própria mensagem
        if (isSocialChannel) {
          fileRecords[i].message_id = messagesData[i].id;
        } else {
          // Para email, todos os arquivos pertencem à mesma mensagem
          fileRecords[i].message_id = messagesData[0].id;
        }
      }

      const { error: filesError } = await supabase
        .from('files')
        .insert(fileRecords);

      if (filesError) {
        console.error('Erro ao registrar arquivos:', filesError);
        // Não falhar a operação principal se o registro de arquivos falhar
      }
    }

    // Enviar mensagens para o canal sem aguardar a resposta
    // Mas garantindo que sejam enviadas em ordem
    if (messagesData.length > 0) {
      // Criar uma cadeia de promises para enviar as mensagens em ordem
      let sendChain = Promise.resolve();
      
      for (const message of messagesData) {
        sendChain = sendChain.then(() => {
          return sendSystemMessage(message.id).catch(error => {
            console.error('Erro ao enviar mensagem para o canal:', error);
          });
        });
      }
      
      // Iniciar a cadeia sem bloquear a resposta
      sendChain.catch(error => {
        console.error('Erro na cadeia de envio de mensagens:', error);
      });
    }

    return res.status(201).json({
      success: true,
      messages: messagesData
    });

  } catch (error) {
    console.error('Erro no createMessageRoute:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Erro interno do servidor' 
    });
  }
}