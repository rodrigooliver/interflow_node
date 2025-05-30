import { 
  handleIncomingMessage, 
  handleStatusUpdate, 
  handleUpdateEditedMessage, 
  handleUpdateDeletedMessage,
  handleUpdateMessageReaction
} from '../chat/message-handlers.js';
import { validateChannel } from '../webhooks/utils.js';
import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';
import { encrypt, decrypt } from '../../utils/crypto.js';
import { formatWhatsAppToMarkdown } from '../../utils/chat.js';
import { 
  handleQrCodeGenerated, 
  handleQrCodeLimitReached, 
  handleConnectedInstance, 
  handleDisconnectedInstance,
} from './channels-handlers.js';
import {
  normalizeWapiMessageV2024_1,
  normalizeWapiStatusUpdateV2024_1,
  handleSenderMessageWApiV2024_1,
  generateQrCodeV2024_1,
  handleDeleteMessageWapiChannelV2024_1,
  createInterflowChannelV2024_1,
  deleteInterflowChannelV2024_1,
  disconnectWapiInstanceV2024_1,
  restartWapiInstanceV2024_1
} from './wapi/wapi-handlers-v2024_1.js';
import { 
  normalizeWapiMessageV2025_1, 
  normalizeWapiStatusUpdateV2025_1, 
  handleSenderMessageWApiV2025_1, 
  handleSendUpdateMessageWapiChannelV2025_1,
  handleDeleteMessageWapiChannelV2025_1,
  generateQrCodeV2025_1,
  createInterflowChannelV2025_1,
  deleteInterflowChannelV2025_1,
  disconnectWapiInstanceV2025_1,
  restartWapiInstanceV2025_1
} from './wapi/wapi-handlers-v2025_1.js';



/**
 * Processa webhooks recebidos do WAPI
 * 
 * Esta função lida com diferentes tipos de eventos do WAPI, incluindo:
 * - Mensagens recebidas/enviadas (com suporte a texto e mídia)
 * - Atualizações de status de mensagens
 * - Eventos de conexão/desconexão
 * - Geração de QR code
 * 
 * Para mensagens com mídia, suporta recebimento via:
 * - URLs (que podem estar criptografadas)
 * - Dados base64 incluídos diretamente no webhook
 * 
 * @param {Object} req - Requisição Express
 * @param {Object} res - Resposta Express
 */
export async function handleWapiWebhook(req, res) {
  const { channelId } = req.params;
  const { action } = req.query;
  const webhookData = req.body;


  // console.log(`webhookData`, webhookData);
  
  if (action && (action === 'onConnected' || action === 'onDisconnected' || action === 'onMessageDelivered' || action === 'onMessageReceived' || action === 'onPresence' || action === 'onStatus')) {
    //Nova versão do webhook
    try {
      // console.log(`webhookData ${action}`, webhookData);
      const channel = await validateChannel(channelId, 'whatsapp_wapi');

      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }

      switch (action) {
        case 'onConnected': // Ao conectar o whatsapp na instância
          if(webhookData.connected) {
            await handleConnectedInstance(channel, webhookData.connectedPhone);
          }
          break;
        case 'onDisconnected': //Ao desconectar da instância
          if(webhookData.disconnected && channel.is_connected) {
            await handleDisconnectedInstance(channel);
          }
          break;
        case 'onMessageDelivered': //Ao enviar uma mensagem
        case 'onMessageReceived': //Ao receber uma mensagem
          if (channel.status === 'inactive') {
            return res.status(404).json({ error: 'Channel not active' });
          }

          if (webhookData.isGroup) return res.json({ success: true });

          // Reação feita pelo cliente
          if (webhookData.msgContent && webhookData.msgContent.reactionMessage && webhookData.msgContent.reactionMessage.key && webhookData.msgContent.reactionMessage.text) {
            await handleUpdateMessageReaction(channel, webhookData.msgContent.reactionMessage.key.id, webhookData.msgContent.reactionMessage.text, webhookData.sender?.id, webhookData.sender?.pushName, webhookData.sender?.profilePicture);
            break;
          }

          //Edição feita pelo agente
          if (webhookData.msgContent && webhookData.msgContent.protocolMessage && webhookData.msgContent.protocolMessage?.type === 'MESSAGE_EDIT') {
            const originalMessageId = webhookData.msgContent.protocolMessage.key.id;
            let newContent = webhookData.msgContent.protocolMessage.editedMessage.conversation;
            newContent = formatWhatsAppToMarkdown(newContent);
            await handleUpdateEditedMessage(channel, originalMessageId, newContent);
            break;
          }

          //Edição feita pelo cliente
          if(webhookData.msgContent && webhookData.msgContent?.editedMessage) {
            const originalMessageId = webhookData.msgContent.editedMessage.message?.protocolMessage?.key?.id;
            let newContent = webhookData.msgContent.editedMessage.message?.protocolMessage?.editedMessage?.conversation;
            newContent = formatWhatsAppToMarkdown(newContent);
            await handleUpdateEditedMessage(channel, originalMessageId, newContent);
            break;
          }

          //Exclusão feita pelo cliente
          if(webhookData.msgContent && webhookData.msgContent.protocolMessage && webhookData.msgContent.protocolMessage?.type === 'REVOKE') {
            const originalMessageId = webhookData.msgContent.protocolMessage.key.id;
            await handleUpdateDeletedMessage(channel, originalMessageId);
            break;
          }

          //Normaliza as mensagens restantes
          const normalizedMessageV2 = await normalizeWapiMessageV2025_1(webhookData, channel);
          normalizedMessageV2.event = (action == 'onMessageDelivered') ? 'messageSent' : 'messageReceived';

          await handleIncomingMessage(channel, normalizedMessageV2);
          break;
        case 'onPresence': //Presença do chat
          break;
        case 'onStatus': //Receber status da mensagem
          const normalizedStatusData = normalizeWapiStatusUpdateV2025_1(webhookData);
          await handleStatusUpdate(channel, normalizedStatusData);
          break;

      }

      return res.json({ success: true });
    } catch (error) {
      Sentry.captureException(error, {
        extra: {
          channelId,
          webhookData,
          action
        }
      });
      console.error('Error handling webhook V2:', error);
      return res.status(500).json({ error: error.message });
    }
  } else if (!action) {
    //Versão antiga do webhook
    try {
      // Get channel details
      const channel = await validateChannel(channelId, 'whatsapp_wapi');

      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }
      if (webhookData.isGroup) return res.json({ success: true });

      // Handle different webhook events
      switch (webhookData.event) {
        case 'messageReceived':
        case 'messageSent':
        case 'forwardedMessage':
        case 'repliedMessage':
          if (channel.status === 'inactive') {
            return res.status(404).json({ error: 'Channel not active' });
          }

          // console.log('messageReceived', webhookData);
          const normalizedMessage = normalizeWapiMessageV2024_1(webhookData);
          normalizedMessage.event = webhookData.event;

          // Log para depuração quando for uma mensagem de resposta
          if (webhookData.event === 'repliedMessage') {
            console.log('Mensagem de resposta recebida:', {
              messageId: webhookData.messageId,
              referencedMessageId: webhookData.referencedMessage?.messageId
            });
          }

          await handleIncomingMessage(channel, normalizedMessage);
          break;
        case 'messageDelivered':
          if (webhookData.fromMe) {
            const normalizedStatusData = normalizeWapiStatusUpdateV2024_1({
              messageId: webhookData.messageId,
              status: 'delivered',
              moment: webhookData.moment || Date.now()
            });
            await handleStatusUpdate(channel, normalizedStatusData);
          }
          break;
        case 'messageRead':
          if (webhookData.fromMe) {
            const normalizedStatusData = normalizeWapiStatusUpdateV2024_1({
              messageId: webhookData.messageId,
              status: 'read',
              moment: webhookData.moment || Date.now()
            });
            await handleStatusUpdate(channel, normalizedStatusData);
          }
          break;
        case 'editedMessage':
          if (webhookData.editedMessage && webhookData.editedMessage.referencedMessage) {
            // Função para tentar atualizar a mensagem editada
            const originalMessageId = webhookData.editedMessage.referencedMessage.messageId;
            let newContent = webhookData.editedMessage.text || webhookData.editedMessage.caption || '';
            newContent = formatWhatsAppToMarkdown(newContent);
            await handleUpdateEditedMessage(channel, originalMessageId, newContent);
          }
          break;
        case 'deletedMessage':
          //Atualiza o status da mensagem para "deleted" quando recebido evento de mensagem apagada
          const messageId = webhookData.referencedMessage?.messageId || webhookData.messageId;
          await handleUpdateDeletedMessage(channel, messageId); //Atualiza o status da mensagem para "deleted" quando recebido evento de mensagem apagada
          break;
        case 'reactedMessage':
          if(webhookData.reactionMessage?.referencedMessage?.messageId && webhookData.reactionMessage?.reaction) {
            await handleUpdateMessageReaction(channel, webhookData.reactionMessage.referencedMessage.messageId, webhookData.reactionMessage.reaction, webhookData.sender?.id, webhookData.sender?.pushName, webhookData.sender?.profilePicture);
          }
          break;
        case 'qrCodeGenerated':
          await handleQrCodeGenerated(channel, webhookData.qrCode);
          break;
        case 'connectedInstance':
          if(webhookData.connected) {
            await handleConnectedInstance(channel, webhookData.connectedPhone);
          }
          break;
        case 'disconnectedInstance':
          await handleDisconnectedInstance(channel);
          break;
        case 'unreadMessageCount':
          // await handleUnreadMessageCount(channel, webhookData);
          break;
        case 'codeLimitReached':
          // Atualizar canal removendo o QR code quando limite for atingido
          await handleQrCodeLimitReached(channel);
          break;

        // Add more event handlers as needed
        case 'memberRemoved':
          //Membro removido de um grupo
          break;
        case 'groupCreated':
          //Grupo criado
          break;
        default:
          Sentry.captureMessage(`Evento WAPI não tratado: ${JSON.stringify(webhookData)}`, {
            level: 'warning',
            extra: {
              channelId: channel.id,
              webhookData
            }
          });
          break;
      }

      return res.json({ success: true });
    } catch (error) {
      Sentry.captureException(error, {
        extra: {
          channelId,
          webhookData
        }
      });
      console.error('Error handling webhook:', error);
      return res.status(500).json({ error: error.message });
    }
  }
}

/**
 * Envia mensagem através do canal WApi
 * 
 * Suporta envio de diferentes tipos de mídia (imagem, vídeo, áudio, documento, sticker)
 * e mensagens de texto simples. Utiliza as APIs do WAPI para envio.
 * 
 * @param {Object} channel - Canal de comunicação
 * @param {Object} messageData - Dados da mensagem a ser enviada
 * @returns {Promise<{messageId: string}>} ID da mensagem enviada
 */
export async function handleSenderMessageWApi(channel, messageData) {
  try {
    const settings = channel.settings;
    if (settings.version && settings.version === '2025_1') {
      return handleSenderMessageWApiV2025_1(channel, messageData);
    } else {
      return handleSenderMessageWApiV2024_1(channel, messageData);
    }
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id,
        messageData,
        context: 'wapi_sender'
      }
    });
    throw error;
  }
}

/**
 * Envia atualização de mensagem através do canal WApi v2025.1
 * @param {*} channel 
 * @param {*} phoneNumber 
 * @param {*} messageId 
 * @param {*} content 
 * @returns 
 */
export async function handleSenderUpdateMessageWapiChannel(channel, phoneNumber, messageId, content) {
  try {
    const settings = channel.settings;
    if (settings.version && settings.version === '2025_1') {
      return handleSendUpdateMessageWapiChannelV2025_1(channel, phoneNumber, messageId, content);
    } else {
      throw new Error('Versão antiga do WAPI não suportada');
      // return handleUpdateMessageWapiChannelV2024_1(channel, phoneNumber, messageId, content);
    }
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id,
        messageId,
        content,
        context: 'wapi_update'
      }
    });
    throw error;
  }
}

/**
 * Deleta uma mensagem através do canal WApi
 * @param {*} channel 
 * @param {*} messageData 
 * @returns 
 */
export async function handleDeleteMessageWapiChannel(channel, messageData) {
  try {
    const settings = channel.settings;
    if (settings.version && settings.version === '2025_1') {
      return handleDeleteMessageWapiChannelV2025_1(channel, messageData);
    } else {
      return handleDeleteMessageWapiChannelV2024_1(channel, messageData);
    }

    
  } catch (error) {
    console.error('Erro ao deletar mensagem WAPI:', error);
    Sentry.captureException(error);
    throw error;
  }
}


export async function testWapiConnection(req, res) {
  // Extrair dados do corpo da requisição
  const { apiHost, apiConnectionKey, apiToken } = req.body;

  // Validar parâmetros obrigatórios
  if (!apiHost || !apiConnectionKey || !apiToken) {
    return res.status(400).json({
      success: false,
      error: 'Missing required parameters'
    });
  }

  // Validar formato do host da API
  const hostRegex = /^[a-zA-Z0-9-]+\.[a-zA-Z0-9-]+\.[a-zA-Z]+$/;
  if (!hostRegex.test(apiHost)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid API host format'
    });
  }

  try {
    // Testar conexão com a API
    const response = await fetch(`https://${apiHost}/instance/isInstanceOnline?connectionKey=${apiConnectionKey}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiToken}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorData;

      try {
        errorData = JSON.parse(errorText);
      } catch (parseError) {
        errorData = { raw: errorText };
      }

      const errorMessage = errorData.message || 'Falha ao conectar ao servidor WAPI';

      const error = new Error(errorMessage);
      Sentry.captureException(error, {
        extra: {
          apiHost,
          channelId: req.params.channelId,
          errorData,
          status: response.status,
          statusText: response.statusText
        }
      });

      console.error('Erro detalhado da API WAPI (testConnection):', {
        status: response.status,
        statusText: response.statusText,
        data: errorData
      });

      return res.status(response.status).json({
        success: false,
        error: errorMessage,
        details: {
          status: response.status,
          data: errorData
        }
      });
    }

    const data = await response.json();

    if (data.error) {
      const errorMessage = data.message || 'Credenciais WAPI inválidas';

      const error = new Error(errorMessage);
      Sentry.captureException(error, {
        extra: {
          apiHost,
          channelId: req.params.channelId,
          data
        }
      });

      console.error('Erro retornado pela API WAPI:', data);

      return res.status(400).json({
        success: false,
        error: errorMessage,
        details: data
      });
    }

    // Se temos channelId nos parâmetros, atualizar o canal no banco
    if (req.params.channelId) {
      const { channelId } = req.params;

      // Buscar o canal para obter as credenciais atuais
      const { data: channel, error: queryError } = await supabase
        .from('chat_channels')
        .select('*')
        .eq('id', channelId)
        .eq('type', 'whatsapp_wapi')
        .single();

      if (queryError) throw queryError;
      if (!channel) {
        return res.status(404).json({
          success: false,
          error: 'Canal não encontrado'
        });
      }

      // Criptografar as novas credenciais
      const encryptedCredentials = {
        ...channel.credentials,
        apiHost: apiHost,
        apiToken: encrypt(apiToken),
        apiConnectionKey: encrypt(apiConnectionKey)
      };

      // Atualizar o canal com as novas credenciais e status
      const { error: updateError } = await supabase
        .from('chat_channels')
        .update({
          credentials: encryptedCredentials,
          is_connected: data.connected === true,
          is_tested: true,
          status: data.connected === true ? 'active' : channel.status
        })
        .eq('id', channelId);

      if (updateError) {
        console.error('Erro ao atualizar status do canal:', updateError);
        throw updateError;
      }
    }

    return res.json({
      success: true,
      data: {
        connected: data.connected,
        status: data.status
      }
    });

  } catch (error) {
    let errorMessage = error.message;

    // Verificar se o erro contém informações da API
    if (error.responseData && error.responseData.message) {
      errorMessage = error.responseData.message;
    }

    Sentry.captureException(error, {
      extra: {
        channelId: req.params.channelId,
        apiHost
      }
    });

    console.error('Erro ao testar conexão WAPI:', error);

    return res.status(500).json({
      success: false,
      error: errorMessage,
      details: {
        stack: error.stack
      }
    });
  }
}

/**
 * Rota para gerar um QR code para o canal WAPI
 * @param {*} req 
 * @param {*} res 
 */
export async function generateQrCodeRoute(req, res) {
  const { channelId } = req.params;
  try {
     // Get channel details with explicit error handling for no rows
     const { data: channels, error: queryError } = await supabase
     .from('chat_channels')
     .select(`
       id,
       name,
       type,
       status,
       credentials,
       settings,
       is_connected,
       is_tested,
       organization:organizations (
         id,
         name
       )
     `)
     .eq('id', channelId)
     .eq('type', 'whatsapp_wapi');

    if (queryError) throw queryError;

    // Handle case where no channel is found
    if (!channels || channels.length === 0) {
      throw new Error('Channel not found');
    }

    const channel = channels[0];

    if(channel.settings.version && channel.settings.version === '2025_1') {
      const qrCode = await generateQrCodeV2025_1(channel);
      return res.json({
        success: true,
        qrCode: qrCode
      });
    } else {
      await generateQrCodeV2024_1(channel);
      return res.json({
        success: true
      });
    }
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId
      }
    });
    console.error('Error generating QR code:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

export async function resetWapiConnection(req, res) {
  const { channelId } = req.params;

  try {
    // Get channel details
    const { data: channel, error: queryError } = await supabase
      .from('chat_channels')
      .select('*')
      .eq('id', channelId)
      .eq('type', 'whatsapp_wapi')
      .single();

    if (queryError) throw queryError;
    if (!channel) {
      return res.status(404).json({
        success: false,
        error: 'Channel not found'
      });
    }

    if(channel.is_connected) {
      if(channel.settings.version === '2025_1') {
        await restartWapiInstanceV2025_1(channel);
      } else {
        await restartWapiInstanceV2024_1(channel);
      }
    }

    // Atualizar status no banco de dados
    const { error: updateError } = await supabase
      .from('chat_channels')
      .update({
        updated_at: new Date().toISOString()
      })
      .eq('id', channelId);

    if (updateError) throw updateError;

    return res.json({ success: true });
  } catch (error) {
    let errorMessage = error.message;

    // Verificar se o erro contém informações da API
    if (error.responseData && error.responseData.message) {
      errorMessage = error.responseData.message;
    }

    Sentry.captureException(error, {
      extra: { channelId }
    });

    console.error('Erro ao resetar conexão WAPI:', error);

    return res.status(500).json({
      success: false,
      error: errorMessage,
      details: {
        stack: error.stack
      }
    });
  }
}

export async function disconnectWapiInstance(req, res) {
  const { channelId } = req.params;

  try {
    // Get channel details
    const { data: channel, error: queryError } = await supabase
      .from('chat_channels')
      .select('*')
      .eq('id', channelId)
      .eq('type', 'whatsapp_wapi')
      .single();

    if (queryError) throw queryError;
    if (!channel || channel.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Channel not found'
      });
    }

    if(channel.settings.version === '2025_1') {
      //CONEXÃO V2025_1
      await disconnectWapiInstanceV2025_1(channel);
    } else {
      //CONEXÃO V2024_1
      await disconnectWapiInstanceV2024_1(channel);
    }

    // Atualizar status no banco de dados independente do resultado da API
    const { error: updateError } = await supabase
      .from('chat_channels')
      .update({
        is_connected: false,
        status: 'inactive', // Desativa o canal
        credentials: {
          ...channel.credentials,
          connectedPhone: null,
          numberPhone: null,
          qrCode: null,
          qrExpiresAt: null
        },
        updated_at: new Date().toISOString()
      })
      .eq('id', channelId);

    if (updateError) throw updateError;

    return res.json({ success: true });
  } catch (error) {
    Sentry.captureException(error, {
      extra: { channelId }
    });
    console.error('Error disconnecting WApi instance:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

function encryptCredentials(credentials) {
  return {
    ...credentials,
    apiToken: encrypt(credentials.apiToken),
    apiConnectionKey: encrypt(credentials.apiConnectionKey)
  };
}

export function decryptCredentials(credentials) {
  if (!credentials) return null;

  return {
    ...credentials,
    apiToken: credentials.apiToken ? decrypt(credentials.apiToken) : null,
    apiConnectionKey: credentials.apiConnectionKey ? decrypt(credentials.apiConnectionKey) : null
  };
}

export async function createWapiChannel(req, res) {
  const { organizationId } = req.params;
  const channelData = req.body;

  try {
    // Validar dados necessários
    if (!channelData.name || !channelData.credentials) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Criptografar credenciais
    const encryptedCreds = encryptCredentials(
      channelData.credentials
    );

    // Criar canal no banco de dados
    const { data: channel, error } = await supabase
      .from('chat_channels')
      .insert({
        organization_id: organizationId,
        name: channelData.name,
        type: 'whatsapp_wapi',
        credentials: encryptedCreds,
        settings: channelData.settings || {},
        status: channelData.status || 'inactive',
        is_connected: false,
        is_tested: channelData.is_tested || false
      })
      .select()
      .single();

    if (error) throw error;

    return res.json({
      success: true,
      id: channel.id
    });

  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        organizationId,
        channelData
      }
    });
    console.error('Error creating WApi channel:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

export async function updateWapiChannel(req, res) {
  const { organizationId, channelId } = req.params;
  const channelData = req.body;

  try {
    // Verificar se o canal existe e pertence à organização
    const { data: existingChannel, error: queryError } = await supabase
      .from('chat_channels')
      .select('*')
      .eq('id', channelId)
      .eq('organization_id', organizationId)
      .single();

    if (queryError || !existingChannel) {
      return res.status(404).json({
        success: false,
        error: 'Channel not found'
      });
    }

    // Preparar dados para atualização
    const updateData = {
      name: channelData.name,
      updated_at: new Date().toISOString()
    };

    // Se houver novas credenciais, criptografá-las
    if (channelData.credentials) {
      const encryptedCreds = encryptCredentials(
        channelData.credentials
      );

      updateData.credentials = encryptedCreds;
    }

    // Atualizar outros campos se fornecidos
    if (channelData.settings) updateData.settings = channelData.settings;
    if (channelData.status) updateData.status = channelData.status;
    if (typeof channelData.is_connected !== 'undefined') updateData.is_connected = channelData.is_connected;
    if (typeof channelData.is_tested !== 'undefined') updateData.is_tested = channelData.is_tested;

    // Atualizar canal no banco de dados
    const { error: updateError } = await supabase
      .from('chat_channels')
      .update(updateData)
      .eq('id', channelId);

    if (updateError) throw updateError;

    return res.json({
      success: true,
      channelId
    });

  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        organizationId,
        channelId: channelId,
        channelData
      }
    });
    console.error('Error updating WApi channel:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * Cria uma nova conexão na W-API da interflow
 * @param {*} req 
 * @param {*} res 
 * @returns 
 */
export async function createInterflowChannel(req, res) {
  const { organizationId } = req.params;
  const { organization } = req;
  const { name } = req.body;

  try {
    // Validar dados necessários
    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Nome é obrigatório'
      });
    }

    // Verificar se WAPI_TOKEN_V2025_1 está definido
    if(process.env.WAPI_TOKEN_V2025_1) {
    // if(1 == 2) {
      //CONEXÃO V2025_1
      const response = await createInterflowChannelV2025_1(organizationId, name, organization.name);
      return res.json({
        success: response.success,
        error: response.error,
        id: response.id || null,
        wapiData: response.wapiData || null,
        details: response.details || null
      });
    } else if (process.env.WAPI_ACCOUNT_ID) {
      //CONEXÃO V2024_1
      const response = await createInterflowChannelV2024_1(organizationId, name, organization.name);
      return res.json({
        success: response.success,
        error: response.error,
        id: response.id || null,
        wapiData: response.wapiData || null,
        details: response.details || null
      });

    } else {
      return res.status(500).json({
        success: false,
        error: 'Dados de conexão não encontrados'
      });
    }

  } catch (error) {
    // Verificar se o erro tem uma mensagem específica da API
    let errorMessage = error.message;

    // Tentar extrair mensagem de erro específica
    if (error.responseData && error.responseData.message) {
      errorMessage = error.responseData.message;
    }

    Sentry.captureException(error, {
      extra: {
        organizationId,
        name
      }
    });

    return res.status(500).json({
      success: false,
      error: errorMessage,
      details: {
        stack: error.stack
      }
    });
  }
}

export async function deleteWapiChannel(req, res) {
  const { organizationId, channelId } = req.params;

  try {
    // Buscar o canal
    const { data: channel, error: fetchError } = await supabase
      .from('chat_channels')
      .select('*')
      .eq('id', channelId)
      .eq('organization_id', organizationId)
      .single();

    if (fetchError || !channel) {
      return res.status(404).json({
        success: false,
        error: 'Canal não encontrado'
      });
    }
    //Não excluir caso tenha um chat vinculado
    const { data: chats, error: chatsError } = await supabase
      .from('chats')
      .select('id')
      .eq('channel_id', channelId);
    if (chatsError) throw chatsError;
    if (chats.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Não é possível excluir o canal, pois existem chats vinculados a ele'
      });
    }

    // Se o canal foi testado, precisamos excluir na API
    if (channel.is_tested) {

      if(channel.settings.version === '2025_1') {
        //CONEXÃO V2025_1
        const response = await deleteInterflowChannelV2025_1(channel);
      } else {
        //CONEXÃO V2024_1
        const response = await deleteInterflowChannelV2024_1(channel);
      }
    }
    //Atualizar lastMessageId in chats to null
    // const { error: updateLastMessageIdError } = await supabase
    //   .from('chats')
    //   .update({
    //     last_message_id: null
    //   })
    //   .eq('channel_id', channelId);
    //   if (updateLastMessageIdError) throw updateLastMessageIdError;

    //   //Excluir mensagens do chat
    // const { error: deleteMessagesError } = await supabase
    //   .from('messages')
    //   .select('id, chat_id, chats!messages_chat_id_fkey!inner(id)')
    //   .delete()
    //   .eq('chat_id', channelId);

    //   if (deleteMessagesError) throw deleteMessagesError;


    // // Excluir os chats associados ao canal
    // const { error: deleteChatsError } = await supabase
    //   .from('chats')
    //   .delete()
    //   .eq('channel_id', channelId);

    // if (deleteChatsError) throw deleteChatsError;

    // Excluir o canal do banco de dados
    const { error: deleteError } = await supabase
      .from('chat_channels')
      .delete()
      .eq('id', channelId);

    if (deleteError) throw deleteError;

    return res.json({
      success: true
    });

  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        organizationId,
        channelId
      }
    });
    console.error('Error deleting WApi channel:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

export async function validateWapiNumberRoute(req, res) {
  try {
    const { number, channelId } = req.body;
    const { organizationId } = req.params;

    if (!number) {
      return res.status(400).json({ error: 'Número de telefone é obrigatório' });
    }

    if (!organizationId) {
      return res.status(400).json({ error: 'ID da organização é obrigatório' });
    }

    const result = await validateWapiNumber(number, organizationId);

    if (result.error) {
      return res.status(400).json(result);
    }

    return res.status(200).json(result);
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        context: 'validate_whatsapp_number_route'
      }
    });
    return res.status(500).json({
      error: 'Erro ao validar número de WhatsApp',
      isValid: false
    });
  }
}

/**
 * Valida se um número de telefone é um WhatsApp válido usando um canal da organização
 * @param {string} number - Número a ser validado
 * @param {string} organizationId - ID da organização para buscar canais
 * @param {string} [channelId] - ID do canal específico para usar (opcional)
 * @returns {Promise<Object>} - Resultado da validação {isValid, error?, data?}
 */
export async function validateWapiNumber(number, organizationId, channelId = null) {
  try {
    if (!number) {
      return {
        error: 'Número de telefone é obrigatório',
        isValid: false
      };
    }

    if (!organizationId && !channelId) {
      return {
        error: 'ID da organização ou ID do canal é obrigatório',
        isValid: false
      };
    }

    // Normalizar o número (remover caracteres não numéricos)
    const cleanNumber = number.replace(/\D/g, '');

    let selectedChannel = null;

    // Se foi fornecido um ID de canal específico, busca diretamente pelo ID
    if (channelId) {
      const { data: channel, error: channelError } = await supabase
        .from('chat_channels')
        .select('*')
        .eq('id', channelId)
        .eq('type', 'whatsapp_wapi')
        .single();

      if (channelError) {
        return {
          error: 'Canal não encontrado',
          isValid: false
        };
      }

      if (!channel || !channel.is_connected || channel.status !== 'active') {
        return {
          error: 'Canal inativo ou desconectado',
          isValid: false
        };
      }

      selectedChannel = channel;
    } else {
      // Buscar um canal WhatsApp ativo e conectado na organização
      const { data: channels, error: channelsError } = await supabase
        .from('chat_channels')
        .select('*')
        .eq('organization_id', organizationId)
        .eq('type', 'whatsapp_wapi')
        .eq('status', 'active')
        .eq('is_connected', true);

      if (channelsError) {
        throw channelsError;
      }

      if (!channels || channels.length === 0) {
        return {
          error: 'Nenhum canal WhatsApp ativo e conectado encontrado',
          isValid: false
        };
      }

      // Priorizar canais do tipo whatsapp_wapi
      const wapiChannel = channels.find(channel => channel.type === 'whatsapp_wapi');

      // Se não houver canais wapi, usar o primeiro canal disponível
      selectedChannel = wapiChannel || channels[0];
    }

    // Verificar o número usando o canal selecionado
    return await validateWhatsAppNumber(selectedChannel, cleanNumber);
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        number,
        organizationId,
        channelId,
        context: 'validate_wapi_number'
      }
    });

    return {
      error: 'Erro ao validar número de WhatsApp',
      isValid: false
    };
  }
}

/**
 * Valida se um número de telefone é um WhatsApp válido
 * @param {Object} channel - Canal WhatsApp para usar na validação
 * @param {string} phoneNumber - Número a ser validado
 * @returns {Promise<Object>} - Resultado da validação {isValid, error?}
 */
export async function validateWhatsAppNumber(channel, phoneNumber) {
  try {
    // Verificar se o canal é válido
    if (!channel || !channel.id) {
      return {
        isValid: false,
        error: 'Canal inválido'
      };
    }

    // Buscar credenciais do canal
    const { data: channelData, error: channelError } = await supabase
      .from('chat_channels')
      .select('credentials, type')
      .eq('id', channel.id)
      .single();

    if (channelError) {
      console.error('Erro ao buscar canal:', channelError);
      return {
        isValid: false,
        error: 'Erro ao buscar credenciais do canal'
      };
    }

    // Verificar tipo de canal
    if (channel.type !== 'whatsapp_wapi') {
      // Para outros canais que não são wapi, retornar válido por padrão
      // Em uma implementação completa, cada tipo de canal teria sua própria validação
      return { isValid: true };
    }

    // Descriptografar credenciais
    const credentials = decryptCredentials(channelData.credentials);
    const baseUrl = `https://${credentials.apiHost}`;

    // Verificar número na API W-API usando o endpoint correto
    // GET https://HOST/contacts/onwhatsapp?connectionKey=CONNECTIONKEY&phoneNumber=5599992249708
    const response = await fetch(`${baseUrl}/contacts/onwhatsapp?connectionKey=${credentials.apiConnectionKey}&phoneNumber=${phoneNumber}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${credentials.apiToken}`
      }
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Erro na resposta da W-API:', errorData);
      return {
        isValid: false,
        error: 'Erro ao verificar número na API'
      };
    }

    const data = await response.json();

    // A resposta da API contém um campo 'exists' que indica se o número é um WhatsApp válido
    return {
      isValid: data.exists === true,
      data: {
        exists: data.exists,
        inputPhone: data.inputPhone,
        outputPhone: data.outputPhone,
        profilePictureUrl: data.profilePictureUrl
      }
    };
  } catch (error) {
    console.error('Erro ao validar número WhatsApp:', error);
    Sentry.captureException(error, {
      extra: {
        phoneNumber,
        channelId: channel?.id,
        context: 'validate_whatsapp_number'
      }
    });

    return {
      isValid: false,
      error: 'Erro ao validar número de WhatsApp'
    };
  }
}

export async function clearExpiredQrCode(req, res) {
  const { channelId } = req.params;

  try {
    console.log(`Limpando QR code expirado para o canal: ${channelId}`);

    // Verificar se o canal existe
    const { data: channel, error: queryError } = await supabase
      .from('chat_channels')
      .select('*')
      .eq('id', channelId)
      .eq('type', 'whatsapp_wapi')
      .single();

    if (queryError || !channel) {
      return res.status(404).json({
        success: false,
        error: 'Canal não encontrado'
      });
    }

    // Atualizar o canal removendo os dados do QR code
    const { error: updateError } = await supabase
      .from('chat_channels')
      .update({
        credentials: {
          ...channel.credentials,
          qrCode: null,
          qrCodeBase64: null,
          qrExpiresAt: null
        },
        updated_at: new Date().toISOString()
      })
      .eq('id', channelId);

    if (updateError) {
      console.error('Erro ao atualizar canal:', updateError);
      throw updateError;
    }

    console.log(`QR code limpo com sucesso para o canal: ${channelId}`);

    return res.json({ 
      success: true,
      message: 'QR code expirado limpo com sucesso'
    });

  } catch (error) {
    Sentry.captureException(error, {
      extra: { channelId }
    });
    console.error('Erro ao limpar QR code expirado:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Erro interno do servidor'
    });
  }
}

/**
 * Migra um canal para a nova versão (2025_1)
 * @param {string} channelId - ID do canal a ser migrado
 * @param {string} organizationId - ID da organização
 * @returns {Promise<Object>} - Resultado da migração
 */
export async function migrateChannelToNewVersion(channelId, organizationId) {
  try {
    console.log(`Iniciando migração do canal ${channelId} para nova versão`);

    // Verificar se o canal existe e pertence à organização
    const { data: channel, error: queryError } = await supabase
      .from('chat_channels')
      .select('*, organization:organizations(*)')
      .eq('id', channelId)
      .eq('organization_id', organizationId)
      .eq('type', 'whatsapp_wapi')
      .single();

    if (queryError || !channel) {
      throw new Error(queryError.message || 'Canal não encontrado ou não pertence a esta organização');
    }

    // Verificar se o canal já está na versão mais recente
    if (channel.settings?.version === '2025_1') {
      return {
        success: true,
        message: 'Canal já está na versão mais recente',
        alreadyMigrated: true
      };
    }

    if(channel.is_tested || channel.is_connected) {
      //Desconectar da versão antiga
      await deleteInterflowChannelV2024_1(channel);
    }

    //Conectar na nova versão
    await createInterflowChannelV2025_1(organizationId, channel.name, channel.organization.name, channelId);

    console.log(`Canal ${channelId} migrado com sucesso para versão 2025_1`);

    return {
      success: true,
      message: 'Migração iniciada com sucesso',
      version: '2025_1',
      migratedAt: new Date().toISOString()
    };

  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId,
        organizationId,
        context: 'migrate_channel'
      }
    });
    
    console.error('Erro ao migrar canal:', error);
    throw error;
  }
}

