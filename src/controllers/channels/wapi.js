import { handleIncomingMessage, handleStatusUpdate } from '../chat/message-handlers.js';
import { validateChannel } from '../webhooks/utils.js';
import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';
import { encrypt, decrypt } from '../../utils/crypto.js';
import { formatMarkdownForWhatsApp, formatWhatsAppToMarkdown } from '../../utils/chat.js';

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
  const webhookData = req.body;

  // console.log(webhookData)

  try {
    // Get channel details
    const channel = await validateChannel(channelId, 'whatsapp_wapi');
    
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    if(webhookData.isGroup) return res.json({ success: true });

    // Handle different webhook events
    switch (webhookData.event) {
      case 'messageReceived':
      case 'messageSent':
      case 'forwardedMessage':
      case 'repliedMessage':
        // console.log('messageReceived', webhookData);
        const normalizedMessage = normalizeWapiMessage(webhookData);
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
          // Função para tentar atualizar o status
          const updateMessageStatus = async (retryCount = 0) => {
            // Primeiro encontra a mensagem usando a chave estrangeira correta
            const { data: message, error: findError } = await supabase
              .from('messages')
              .select(`
                id,
                organization_id,
                chat_id,
                chat:chat_id (
                  channel_id
                )
              `)
              .eq('external_id', webhookData.messageId)
              .eq('chat.channel_id', channel.id)
              .single();

            if (findError) {
              // Se der erro e ainda não tentou 3 vezes, tenta novamente após 2 segundos
              if (retryCount < 3) {
                setTimeout(() => updateMessageStatus(retryCount + 1), 2000);
              }
              return;
            }

            if (message) {
              // Atualiza o status da mensagem encontrada
              const { error: updateError } = await supabase
                .from('messages')
                .update({ status: 'delivered' })
                .eq('id', message.id);

              if (updateError) {
                Sentry.captureException(updateError, {
                  extra: {
                    messageId: message.id,
                    context: 'updating_message_status'
                  }
                });
              }

              // console.log('chat', message.chat_id, message.organization_id);

              const { data: chat, error: updateChatError } = await supabase
                .from('chats')
                .update({
                  last_message_at: new Date().toISOString(),
                })
                .eq('id', message.chat_id)
              // console.log('data', chat);
              // console.log('updateChatError', updateChatError);
              if (updateChatError) {
                Sentry.captureException(updateChatError, {
                  extra: {
                    chatId: channel.id,
                    context: 'updating_chat_last_message_at'
                  }
                });
              }
            }
          };

          // Inicia a primeira tentativa após 2 segundos
          setTimeout(() => updateMessageStatus(), 2000);
        }
        break;
      case 'messageRead':
        if (webhookData.fromMe) {
          // Função para tentar atualizar o status
          const updateMessageStatus = async (retryCount = 0) => {
            // Primeiro encontra a mensagem usando a chave estrangeira correta
            const { data: message, error: findError } = await supabase
              .from('messages')
              .select(`
                id,
                organization_id,
                chat_id,
                chat:chat_id (
                  channel_id
                )
              `)
              .eq('external_id', webhookData.messageId)
              .eq('chat.channel_id', channel.id)
              .single();

            if (findError) {
              // Se der erro e ainda não tentou 3 vezes, tenta novamente após 2 segundos
              if (retryCount < 3) {
                setTimeout(() => updateMessageStatus(retryCount + 1), 2000);
              }
              return;
            }

            if (message) {
              // Atualiza o status da mensagem encontrada
              const { error: updateError } = await supabase
                .from('messages')
                .update({ status: 'read' })
                .eq('id', message.id);

              if (updateError) {
                Sentry.captureException(updateError, {
                  extra: {
                    messageId: message.id,
                    context: 'updating_message_status'
                  }
                });
              }

              // console.log('chat', message.chat_id, message.organization_id);

              const { data: chat, error: updateChatError } = await supabase
                .from('chats')
                .update({
                  last_message_at: new Date().toISOString(),
                })
                .eq('id', message.chat_id)
              // console.log('data', chat);
              // console.log('updateChatError', updateChatError);
              if (updateChatError) {
                Sentry.captureException(updateChatError, {
                  extra: {
                    chatId: channel.id,
                    context: 'updating_chat_last_message_at'
                  }
                });
              }
            }
          };

          // Inicia a primeira tentativa após 2 segundos
          setTimeout(() => updateMessageStatus(), 2000);
        }
        break;
      case 'editedMessage':
        if (webhookData.editedMessage && webhookData.editedMessage.referencedMessage) {
          console.log('Mensagem editada recebida:', webhookData);
          
          // Função para tentar atualizar a mensagem editada
          const updateEditedMessage = async (retryCount = 0) => {
            // Encontra a mensagem usando o external_id da mensagem referenciada
            const referencedMessageId = webhookData.editedMessage.referencedMessage.messageId;
            
            const { data: message, error: findError } = await supabase
              .from('messages')
              .select(`
                id,
                organization_id,
                chat_id,
                metadata,
                chat:chat_id (
                  channel_id
                )
              `)
              .eq('external_id', referencedMessageId)
              .eq('chat.channel_id', channel.id)
              .single();

            if (findError) {
              // Se der erro e ainda não tentou 3 vezes, tenta novamente após 2 segundos
              if (retryCount < 3) {
                setTimeout(() => updateEditedMessage(retryCount + 1), 2000);
              }
              return;
            }

            if (message) {
              // Formata o novo conteúdo para markdown se houver texto
              const newContent = webhookData.editedMessage.text 
                ? formatWhatsAppToMarkdown(webhookData.editedMessage.text)
                : (webhookData.editedMessage.caption || '');
              
              // Prepara os metadados atualizados
              const updatedMetadata = {
                ...(message.metadata || {}),
                edited: true,
                editedAt: new Date().toISOString(),
                previousContent: message.content
              };
              
              // Atualiza o conteúdo e os metadados da mensagem (sem alterar o status)
              const { error: updateError } = await supabase
                .from('messages')
                .update({ 
                  content: newContent,
                  metadata: updatedMetadata
                })
                .eq('id', message.id);

              if (updateError) {
                Sentry.captureException(updateError, {
                  extra: {
                    messageId: message.id,
                    context: 'updating_edited_message'
                  }
                });
              }

              // Atualiza também o timestamp do último contato no chat
              const { error: updateChatError } = await supabase
                .from('chats')
                .update({
                  last_message_at: new Date().toISOString(),
                })
                .eq('id', message.chat_id);
                
              if (updateChatError) {
                Sentry.captureException(updateChatError, {
                  extra: {
                    chatId: message.chat_id,
                    context: 'updating_chat_after_edited_message'
                  }
                });
              }
            }
          };

          // Inicia a tentativa de atualizar a mensagem editada
          updateEditedMessage();
        }
        break;
      case 'deletedMessage':
        console.log('Mensagem apagada recebida:', webhookData);
        
        // Função para tentar atualizar o status da mensagem apagada
        const updateDeletedMessage = async (retryCount = 0) => {
          // Verifica se existe ID da mensagem referenciada
          const messageId = webhookData.referencedMessage?.messageId || webhookData.messageId;
          
          if (!messageId) {
            console.error('ID da mensagem não encontrado para mensagem apagada');
            return;
          }
          
          // Encontra a mensagem pelo ID externo
          const { data: message, error: findError } = await supabase
            .from('messages')
            .select(`
              id,
              organization_id,
              chat_id,
              content,
              metadata,
              chat:chat_id (
                channel_id
              )
            `)
            .eq('external_id', messageId)
            .eq('chat.channel_id', channel.id)
            .single();

          if (findError) {
            // Se der erro e ainda não tentou 3 vezes, tenta novamente após 2 segundos
            if (retryCount < 3) {
              setTimeout(() => updateDeletedMessage(retryCount + 1), 2000);
            }
            return;
          }

          if (message) {
            // Prepara os metadados atualizados
            const updatedMetadata = {
              ...(message.metadata || {}),
              deleted: true,
              deletedAt: new Date().toISOString(),
              previousContent: message.content
            };
            
            // Atualiza o status e metadados da mensagem
            const { error: updateError } = await supabase
              .from('messages')
              .update({ 
                status: 'deleted',
                metadata: updatedMetadata
              })
              .eq('id', message.id);

            if (updateError) {
              Sentry.captureException(updateError, {
                extra: {
                  messageId: message.id,
                  context: 'updating_deleted_message_status'
                }
              });
            }

            // Atualiza o timestamp do último contato no chat
            const { error: updateChatError } = await supabase
              .from('chats')
              .update({
                last_message_at: new Date().toISOString(),
              })
              .eq('id', message.chat_id);
              
            if (updateChatError) {
              Sentry.captureException(updateChatError, {
                extra: {
                  chatId: message.chat_id,
                  context: 'updating_chat_after_deleted_message'
                }
              });
            }
          }
        };

        // Inicia a tentativa de atualizar o status da mensagem
        updateDeletedMessage();
        break;
      case 'status':
        await handleStatusUpdate(channel, webhookData);
        break;
      case 'qrCodeGenerated':
        await handleQrCodeGenerated(channel, webhookData);
        break;
      case 'connectedInstance':
        await handleConnectedInstance(channel, webhookData);
        break;
      case 'disconnectedInstance':
        // await handleDisconnectedInstance(channel, webhookData);
        break;
      case 'unreadMessageCount':
        // await handleUnreadMessageCount(channel, webhookData);
        break;
      case 'codeLimitReached':
        // Atualizar canal removendo o QR code quando limite for atingido
            // Descriptografar credenciais
        // channel.credentials = decryptCredentials(channel.credentials);
        const { error: updateError } = await supabase
          .from('chat_channels')
          .update({
            credentials: {
              ...channel.credentials,
              qrCode: null,
              qrExpiresAt: null
            },
            updated_at: new Date().toISOString()
          })
          .eq('id', channel.id);

        if (updateError) throw updateError;
        break;
        
      // Add more event handlers as needed
    }

    res.json({ success: true });
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId,
        webhookData
      }
    });
    console.error('Error handling webhook:', error);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Normaliza dados de mensagem do WAPI para formato padrão
 * 
 * Esta função converte os dados brutos do webhook do WAPI para um formato
 * padronizado que pode ser processado pelo sistema. Inclui suporte para
 * diferentes tipos de mídia (imagem, vídeo, áudio, documento, sticker)
 * e padroniza os dados base64 quando disponíveis.
 * 
 * @param {Object} webhookData - Dados brutos do webhook
 * @returns {Object} - Mensagem normalizada
 */
function normalizeWapiMessage(webhookData) {
  // Determina a origem dos dados baseado em fromMe
  const externalData = webhookData.fromMe 
    ? {
        externalId: webhookData.recipient.id,
        externalName: webhookData.recipient.pushName,
        externalProfilePicture: webhookData.recipient.profilePicture
      }
    : {
        externalId: webhookData.sender.id,
        externalName: webhookData.sender.pushName,
        externalProfilePicture: webhookData.sender.profilePicture
      };

  // Verificar se é mensagem de resposta
  let responseExternalId = null;
  if (webhookData.referencedMessage && webhookData.referencedMessage.messageId) {
    responseExternalId = webhookData.referencedMessage.messageId;
  }

  // Determinar o tipo de mensagem
  let messageType = 'text';
  let messageContent = formatWhatsAppToMarkdown(webhookData.messageText?.text || '');
  let mediaBase64 = null;
  let mediaUrl = null;
  let mimeType = null;
  let fileName = null;
  
  // Processar diferentes tipos de mídia
  if (webhookData.image) {
    messageType = 'image';
    messageContent = webhookData.image.caption || '';
    mediaBase64 = webhookData.image.imageBase64;
    mediaUrl = webhookData.image.url;
    mimeType = webhookData.image.mimetype || 'image/jpeg';
  } else if (webhookData.video) {
    messageType = 'video';
    messageContent = webhookData.video.caption || '';
    mediaBase64 = webhookData.video.videoBase64;
    mediaUrl = webhookData.video.url;
    mimeType = webhookData.video.mimetype || 'video/mp4';
  } else if (webhookData.audio) {
    messageType = 'audio';
    messageContent = '';
    mediaBase64 = webhookData.audio.audioBase64;
    mediaUrl = webhookData.audio.url;
    mimeType = webhookData.audio.mimetype || 'audio/ogg';
  } else if (webhookData.document) {
    messageType = 'document';
    messageContent = webhookData.document.caption || '';
    mediaBase64 = webhookData.document.documentBase64;
    mediaUrl = webhookData.document.url;
    mimeType = webhookData.document.mimetype || 'application/octet-stream';
    fileName = webhookData.document.fileName;
  } else if (webhookData.sticker) {
    messageType = 'sticker';
    messageContent = '';
    mediaBase64 = webhookData.sticker.stickerBase64;
    mediaUrl = webhookData.sticker.url;
    mimeType = webhookData.sticker.mimetype || 'image/webp';
  } else if (webhookData.listResponseMessage) {
    messageType = 'text';
    // Prioriza o selectedRowId se existir, caso contrário usa o title
    // messageContent = webhookData.listResponseMessage.selectedRowId || webhookData.listResponseMessage.title || '';
    messageContent = webhookData.listResponseMessage.title || '';
  }

  return {
    messageId: webhookData.messageId,
    timestamp: webhookData.moment,
    from: {
      id: webhookData.sender.id,
      name: webhookData.sender.pushName,
      profilePicture: webhookData.sender.profilePicture
    },
    to: {
      id: webhookData.recipient.id,
      profilePicture: webhookData.recipient.profilePicture
    },
    ...externalData, // Adiciona os campos externos
    message: {
      type: messageType,
      content: messageContent,
      mediaBase64: mediaBase64, // Campo padronizado para base64
      mediaUrl: mediaUrl,       // URL da mídia (pode ser criptografada)
      mimeType: mimeType,       // Tipo MIME da mídia
      fileName: fileName,       // Nome do arquivo (para documentos)
      raw: webhookData          // Dados brutos completos
    },
    isGroup: webhookData.isGroup,
    fromMe: webhookData.fromMe,
    responseExternalId: responseExternalId // Adiciona o ID da mensagem de referência quando for resposta
  };
}

async function handleQrCodeGenerated(channel, webhookData) {
  try {
    // Validate webhook data
    if (!webhookData.qrCode || !webhookData.connectionKey) {
      const error = new Error('Invalid QR code data');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          webhookData
        }
      });
      throw error;
    }

    // Calcular timestamp de expiração (60 segundos a partir de agora)
    const qrExpiresAt = new Date(Date.now() + 60000).toISOString();

    // Update channel with new QR code and expiration
    const { error: updateError } = await supabase
      .from('chat_channels')
      .update({
        credentials: {
          ...channel.credentials,
          qrCode: webhookData.qrCode,
          qrExpiresAt: qrExpiresAt
        },
        updated_at: new Date().toISOString()
      })
      .eq('id', channel.id);

    if (updateError) throw updateError;

    return true;
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id,
        webhookData
      }
    });
    console.error('Error handling QR code generation:', error);
    throw error;
  }
}

async function handleConnectedInstance(channel, webhookData) {
  try {
    // Validate webhook data
    if (!webhookData.connectedPhone || !webhookData.connected) {
      const error = new Error('Invalid connection data');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          webhookData
        }
      });
      throw error;
    }

    // Update channel status in database
    const { error: updateError } = await supabase
      .from('chat_channels')
      .update({
        is_connected: true,
        is_tested: true,
        status: 'active',
        credentials: {
          ...channel.credentials,
          connectedPhone: webhookData.connectedPhone,
          numberPhone: webhookData.connectedPhone,
          qrCode: null, // Limpa o QR code após conexão
          qrExpiresAt: null
        },
        updated_at: new Date().toISOString()
      })
      .eq('id', channel.id);

    if (updateError) throw updateError;

    return true;
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id,
        webhookData
      }
    });
    console.error('Error handling connected instance:', error);
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
    
    res.json({
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
    
    res.status(500).json({
      success: false,
      error: errorMessage,
      details: {
        stack: error.stack
      }
    });
  }
}

export async function generateQrCode(req, res) {
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
      return res.status(404).json({ 
        success: false,
        error: 'Channel not found' 
      });
    }

    const channel = channels[0];
    
    // Descriptografar credenciais antes de usar
    const decryptedCredentials = decryptCredentials(channel.credentials);

    // Update webhook configuration
    await updateWebhook({
      ...channel,
      credentials: decryptedCredentials
    });

    // Make request to WApi server to generate QR code
    const response = await fetch(`https://${decryptedCredentials.apiHost}/instance/getQrcode?connectionKey=${decryptedCredentials.apiConnectionKey}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${decryptedCredentials.apiToken}`
      }
    });

    if (!response.ok) {
      const errorData = await response.json();
      const error = new Error(errorData.message || 'Failed to generate QR code');
      Sentry.captureException(error, {
        extra: {
          channelId,
          errorData
        }
      });
      throw error;
    }

    res.json({
      success: true
    });
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId
      }
    });
    console.error('Error generating QR code:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

export async function updateWebhook(channel) {
  try {
    //Activate webhook v3
    const responseV3 = await fetch(`https://${channel.credentials.apiHost}/instance/updateWebhookV3?connectionKey=${channel.credentials.apiConnectionKey}&value=enable`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${channel.credentials.apiToken}`
      },
    });

    if (!responseV3.ok) {
      const errorData = await responseV3.json();
      const error = new Error(errorData.message || 'Failed to activate webhook V3');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          errorData
        }
      });
      throw error;
    }

    const dataV3 = await responseV3.json();

    // Check for error in response
    if (dataV3.error) {
      const error = new Error(dataV3.message || 'Failed to update webhook');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          dataV3
        }
      });
      throw error;
    }

    const webhookUrl = `${process.env.API_URL}/api/${channel.organization?.id}/webhook/wapi/${channel.id}`;

    // Make request to WApi server to update webhook
    const response = await fetch(`https://${channel.credentials.apiHost}/webhook/editWebhook?connectionKey=${channel.credentials.apiConnectionKey}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${channel.credentials.apiToken}`
      },
      body: JSON.stringify({
        webhookUrl,
        events: {
          qrCodeGenerated: true,
          pairingCodeGenerated: true,
          codeLimitReached: true,
          connectedInstance: true,
          restoredInstance: true,
          disconnectedInstance: true,
          newChat: true,
          unreadMessageCount: false,
          numberMentioned: true,
          deletedMessage: true,
          messageDelivered: true,
          pinnedMessage: true,
          unpinnedMessage: true,
          reactedMessage: true,
          messageRead: true,
          messageReceived: true,
          messageSent: true,
          editedMessage: true,
          repliedMessage: true,
          forwardedMessage: true,
          pollCreated: true,
          updatedPoll: true,
          groupCreated: true,
          demotedMember: true,
          promotedMember: true,
          memberRemoved: true,
          updatedGroup: true,
          downloadMediaBase64: true
        }
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      const error = new Error(errorData.message || 'Failed to update webhook');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          errorData
        }
      });
      throw error;
    }

    const data = await response.json();

    // Check for error in response
    if (data.error) {
      const error = new Error(data.message || 'Failed to update webhook');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          data
        }
      });
      throw error;
    }

    return true;
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id
      }
    });
    console.error('Error updating webhook:', error);
    throw error;
  }
}

export async function resetWapiConnection(req, res) {
  const { channelId } = req.params;

  try {
    // Get channel details
    const { data: channels, error: queryError } = await supabase
      .from('chat_channels')
      .select('*')
      .eq('id', channelId)
      .eq('type', 'whatsapp_wapi');

    if (queryError) throw queryError;
    if (!channels || channels.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Channel not found' 
      });
    }

    const channel = channels[0];

    const decryptedCredentials = decryptCredentials(channel.credentials);

    // Fazer requisição para resetar a instância na WApi
    const response = await fetch(`https://${channel.credentials.apiHost}/instance/restart?connectionKey=${decryptedCredentials.apiConnectionKey}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${decryptedCredentials.apiToken}`
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
      
      const errorMessage = errorData.message || `Falha ao reiniciar instância WAPI: ${response.statusText}`;
      
      const error = new Error(errorMessage);
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          errorData,
          status: response.status,
          statusText: response.statusText
        }
      });
      
      console.error('Erro detalhado da API WAPI (resetConnection):', {
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
      const errorMessage = data.message || 'Falha ao reiniciar instância WAPI';
      
      const error = new Error(errorMessage);
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          data
        }
      });
      
      console.error('Erro retornado pela API WAPI (reset):', data);
      
      return res.status(400).json({
        success: false,
        error: errorMessage,
        details: data
      });
    }

    // Atualizar status no banco de dados
    const { error: updateError } = await supabase
      .from('chat_channels')
      .update({
        updated_at: new Date().toISOString()
      })
      .eq('id', channelId);

    if (updateError) throw updateError;

    res.json({ success: true });
  } catch (error) {
    let errorMessage = error.message;
    
    // Verificar se o erro contém informações da API
    if (error.responseData && error.responseData.message) {
      errorMessage = error.responseData.message;
    }
    
    Sentry.captureException(error, {
      extra: { channelId }
    });
    
    console.error('Erro ao reiniciar conexão WAPI:', error);
    
    res.status(500).json({
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
    const { data: channels, error: queryError } = await supabase
      .from('chat_channels')
      .select('*')
      .eq('id', channelId)
      .eq('type', 'whatsapp_wapi');

    if (queryError) throw queryError;
    if (!channels || channels.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Channel not found' 
      });
    }

    const channel = channels[0];
  
    const decryptedCredentials = decryptCredentials(channel.credentials); 

    try {
      // Fazer requisição para desconectar a instância na WApi
      const response = await fetch(`https://${channel.credentials.apiHost}/instance/logout?connectionKey=${decryptedCredentials.apiConnectionKey}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${decryptedCredentials.apiToken}`
        }
      });

      if (!response.ok) {
        const errorData = await response.json();
        const error = new Error(errorData.message || 'Failed to disconnect WApi instance');
        Sentry.captureException(error, {
          extra: {
            channelId,
            errorData
          }
        });
        console.error('Falha ao desconectar instância na W-API:', error);
      } else {
        const data = await response.json();
        if (data.error) {
          const error = new Error(data.message || 'Erro retornado pela W-API');
          Sentry.captureException(error, {
            extra: {
              channelId,
              data
            }
          });
          console.error('WApi error:', error);
        }
      }
    } catch (apiError) {
      console.error('Error calling WApi:', apiError);
      // Continua a execução para atualizar o status local
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

    res.json({ success: true });
  } catch (error) {
    Sentry.captureException(error, {
      extra: { channelId }
    });
    console.error('Error disconnecting WApi instance:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
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
    // Descriptografar credenciais antes de usar
    const credentials = channel.credentials;
    const apiHost = credentials.apiHost;
    const apiConnectionKey = credentials.apiConnectionKey ? decrypt(credentials.apiConnectionKey) : null;
    const apiToken = credentials.apiToken ? decrypt(credentials.apiToken) : null;
    messageData.content = formatMarkdownForWhatsApp(messageData.content);
    
    if (!apiHost || !apiConnectionKey || !apiToken) {
      const error = new Error('Credenciais incompletas ou inválidas');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          messageData
        }
      });
      throw error;
    }
    
    const baseUrl = `https://${apiHost}`;
    let response;
    let responseData;

    // console.log('WAPI - messageData', messageData);

    // Se tiver anexos, envia como mídia
    if (messageData.attachments && messageData.attachments.length > 0) {
      const attachment = messageData.attachments[0];
      // console.log('WAPI - attachment', attachment);
      
      let endpoint = '';
      let body = {};

      // Determina o endpoint e corpo da requisição com base no tipo de mídia
      if (attachment.type.startsWith('image/') || (attachment.mime_type && attachment.mime_type.startsWith('image/')) || attachment.type == 'image') {
        endpoint = '/message/send-image';
        body = {
          phoneNumber: messageData.to,
          image: attachment.url,
          caption: messageData.content || ''
        };
        // console.log('WAPI - attachment.url', attachment.url);
      } else if (attachment.type.startsWith('video/') || (attachment.mime_type && attachment.mime_type.startsWith('video/')) || attachment.type == 'video') {
        endpoint = '/message/send-video';
        body = {
          phoneNumber: messageData.to,
          video: attachment.url,
          caption: messageData.content || ''
        };
      } else if (attachment.type.startsWith('audio/') || (attachment.mime_type && attachment.mime_type.startsWith('audio/')) || attachment.type == 'audio') {
        endpoint = '/message/send-audio';
        body = {
          phoneNumber: messageData.to,
          audio: attachment.url
        };
      } else if (attachment.type === 'sticker' || attachment.mime_type === 'image/webp') {
        endpoint = '/message/send-sticker';
        body = {
          phoneNumber: messageData.to,
          sticker: attachment.url
        };
      } else {
        endpoint = '/message/send-document';
        
        // Verificar se o nome do arquivo tem extensão
        let fileName = attachment.name || 'documento';
        if (!fileName.includes('.')) {
          // Tentar extrair extensão do MIME type
          if (attachment.mime_type) {
            const mimeExtension = attachment.mime_type.split('/')[1];
            if (mimeExtension) {
              fileName = `${fileName}.${mimeExtension}`;
            } else {
              // Fallback para extensão genérica
              fileName = `${fileName}.txt`;
            }
          } else {
            // Fallback para extensão genérica
            fileName = `${fileName}.txt`;
          }
        }
        
        body = {
          phoneNumber: messageData.to,
          document: attachment.url,
          fileName: fileName,
          ...(messageData.responseMessageId ? {
            messageId: messageData.responseMessageId,
            message: {
              text: messageData.content
            }
          } : {})
        };
      }
      
      response = await fetch(`${baseUrl}${endpoint}?connectionKey=${apiConnectionKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiToken}`
        },
        body: JSON.stringify(body)
      });

    } else if (messageData.list) {
      // Enviar mensagem com listas
      response = await fetch(`${baseUrl}/message/send-option-list?connectionKey=${apiConnectionKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiToken}`
        },
        body: JSON.stringify({
          phoneNumber: messageData.to,
          delayMessage: 1000,
          title: messageData.list.title,
          description: messageData.list.description || '',
          buttonText: messageData.list.buttonText || 'Selecione uma opção',
          footerText: messageData.list.footerText || '',
          sections: messageData.list.sections.map(section => ({
            title: section.title,
            rows: section.rows.map(row => ({
              id: row.id,
              title: row.title,
              description: row.description
            }))
          }))
        })
      });
    } else if (messageData.content) {
      const body = {
        phoneNumber: messageData.to,
        text: messageData.content,
        ...(messageData.responseMessageId ? {
          messageId: messageData.responseMessageId,
          message: {
            text: messageData.content
          }
        } : {})
      }
      // console.log('WAPI - body', body);
      response = await fetch(`${baseUrl}/message/send-text?connectionKey=${apiConnectionKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiToken}`
        },
        body: JSON.stringify(body)
      });
    } else {
      const error = new Error('Nenhum conteúdo ou anexo fornecido para envio');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          messageData
        }
      });
      throw error;
    }

    if (!response.ok) {
      const errorText = await response.text();
      try {
        const errorData = JSON.parse(errorText);
        
        // Verifica se é erro de connectionKey inválida
        if (errorData.message === 'connectionKey inválida') {
          // Marca o canal como desconectado
          const { error: updateError } = await supabase
            .from('chat_channels')
            .update({
              is_connected: false,
              is_tested: false,
              status: 'inactive',
              credentials: {
                ...channel.credentials,
                connectedPhone: null,
                numberPhone: null,
                qrCode: null,
                qrExpiresAt: null
              },
              updated_at: new Date().toISOString()
            })
            .eq('id', channel.id);

          if (updateError) {
            Sentry.captureException(updateError, {
              extra: {
                channelId: channel.id,
                context: 'updating_channel_status_after_invalid_key'
              }
            });
          }

          Sentry.captureMessage('Canal WAPI desconectado devido a connectionKey inválida', {
            level: 'warning',
            extra: {
              channelId: channel.id,
              errorData
            }
          });

          throw new Error('Canal desconectado: connectionKey inválida');
        }

        const error = new Error(errorData.message || 'Erro ao enviar mensagem');
        Sentry.captureException(error, {
          extra: {
            channelId: channel.id,
            messageData,
            errorData
          }
        });
        throw error;
      } catch (parseError) {
        const error = new Error(`Erro ao enviar mensagem: ${errorText}`);
        Sentry.captureException(error, {
          extra: {
            channelId: channel.id,
            messageData,
            errorText
          }
        });
        throw error;
      }
    }

    const responseText = await response.text();
    
    try {
      responseData = JSON.parse(responseText);
    } catch (parseError) {
      const error = new Error(`Erro ao parsear resposta da API: ${responseText}`);
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          messageData,
          responseText
        }
      });
      throw error;
    }

    if (responseData.error) {
      const error = new Error(responseData.message || 'Erro retornado pela API');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          messageData,
          responseData
        }
      });
      throw error;
    }

    return {
      messageId: responseData.messageId
    };

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

function encryptCredentials(credentials) {
  return {
    ...credentials,
    apiToken: encrypt(credentials.apiToken),
    apiConnectionKey: encrypt(credentials.apiConnectionKey)
  };
}

function decryptCredentials(credentials) {
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

    res.json({
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
    res.status(500).json({
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

    res.json({
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
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

export async function createInterflowChannel(req, res) {
  const { organizationId } = req.params;
  const { name } = req.body;

  try {
    // Verificar se WAPI_ACCOUNT_ID está definido
    if (!process.env.WAPI_ACCOUNT_ID) {
      return res.status(500).json({
        success: false,
        error: 'Configuração WAPI_ACCOUNT_ID não encontrada'
      });
    }

    // Validar dados necessários
    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Nome é obrigatório'
      });
    }

    // Criar nova conexão na W-API
    try {
      console.log('Criando nova conexão na W-API', process.env.WAPI_ACCOUNT_ID);
      const wapiResponse = await fetch(`https://api-painel.w-api.app/createNewConnection?id=${process.env.WAPI_ACCOUNT_ID}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!wapiResponse.ok) {
        // Capturar detalhes completos da resposta de erro
        const errorText = await wapiResponse.text();
        let errorData;
        
        try {
          errorData = JSON.parse(errorText);
        } catch (parseError) {
          errorData = { raw: errorText };
        }
        
        const errorMessage = errorData.message || `Status ${wapiResponse.status} - ${wapiResponse.statusText}`;
        const error = new Error(`Falha ao criar conexão na W-API: ${errorMessage}`);
        
        Sentry.captureException(error, {
          extra: {
            organizationId,
            name,
            status: wapiResponse.status,
            statusText: wapiResponse.statusText,
            responseData: errorData
          }
        });
        
        console.error('Erro detalhado da API WAPI:', {
          status: wapiResponse.status,
          statusText: wapiResponse.statusText,
          data: errorData
        });
        
        return res.status(500).json({
          success: false,
          error: errorMessage,
          details: {
            status: wapiResponse.status,
            data: errorData
          }
        });
      }

      const wapiData = await wapiResponse.json();

      if (wapiData.error) {
        const errorMessage = wapiData.message || 'Erro retornado pela W-API';
        const error = new Error(errorMessage);
        
        Sentry.captureException(error, {
          extra: {
            organizationId,
            name,
            wapiData
          }
        });
        
        console.error('Erro retornado pela W-API:', wapiData);
        
        return res.status(500).json({
          success: false,
          error: errorMessage,
          details: wapiData
        });
      }

      // Criar credenciais com os dados retornados
      const credentials = {
        apiHost: wapiData.host,
        apiToken: encrypt(wapiData.token),
        apiConnectionKey: encrypt(wapiData.connectionKey)
      };

      // Criar canal no banco de dados
      const { data: channel, error } = await supabase
        .from('chat_channels')
        .insert({
          organization_id: organizationId,
          name: name,
          type: 'whatsapp_wapi',
          credentials: credentials,
          settings: {
            autoReply: true,
            notifyNewTickets: true,
            isInterflow: true,
            interflowData: {
              createdAt: new Date().toISOString(),
              accountId: encrypt(process.env.WAPI_ACCOUNT_ID),
              isInterflowConnection: true
            }
          },
          status: 'inactive',
          is_connected: false,
          is_tested: true
        })
        .select()
        .single();

      if (error) throw error;

      // Configurar webhook após criar o canal
      await updateWebhook({
        id: channel.id,
        organization: { id: organizationId },
        credentials: {
          apiHost: wapiData.host,
          apiToken: wapiData.token,
          apiConnectionKey: wapiData.connectionKey
        }
      });

      // Gerar QR Code
      await generateQrCode(
        { params: { channelId: channel.id } },
        { status: () => ({ json: () => {} }), json: () => {} }
      );

      res.json({
        success: true,
        id: channel.id
      });

    } catch (wapiError) {
      // Verificar se o erro tem uma propriedade de resposta da API
      let errorMessage = wapiError.message;
      
      // Tentar extrair mensagem de erro específica da API
      if (wapiError.responseData && wapiError.responseData.message) {
        errorMessage = wapiError.responseData.message;
      }
      
      const error = new Error(`Erro ao criar conexão W-API: ${errorMessage}`);
      
      Sentry.captureException(error, {
        extra: {
          organizationId,
          name,
          wapiError: {
            message: wapiError.message,
            stack: wapiError.stack
          }
        }
      });
      
      console.error('Erro completo ao criar conexão W-API:', wapiError);
      
      return res.status(500).json({
        success: false,
        error: errorMessage,
        details: {
          stack: wapiError.stack
        }
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
    
    console.error('Error creating Interflow channel:', error);
    
    res.status(500).json({
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

    // Se o canal foi testado, precisamos excluir na API
    if (channel.is_tested) {
      const credentials = decryptCredentials(channel.credentials);

      // Se for uma conexão Interflow
      if (channel.settings.isInterflow && channel.settings?.interflowData?.accountId) {
        const accountId = decrypt(channel.settings.interflowData.accountId);
        
        try {
          // Primeiro desconecta a instância
          const disconnectResponse = await fetch(
            `https://api-painel.w-api.app/instance/disconnect?connectionKey=${credentials.apiConnectionKey}`,
            {
              method: 'DELETE',
              headers: {
                'Content-Type': 'application/json'
              }
            }
          );

          if (!disconnectResponse.ok) {
            const disconnectData = await disconnectResponse.json();
            const error = new Error(disconnectData.message || 'Falha ao desconectar instância na W-API');
            Sentry.captureException(error, {
              extra: {
                channelId,
                organizationId,
                disconnectData
              }
            });
            console.error('Falha ao desconectar instância na W-API:', error);
          }

          // Depois exclui a conexão
          const wapiResponse = await fetch(
            `https://api-painel.w-api.app/deleteConnection?connectionKey=${credentials.apiConnectionKey}&id=${accountId}`,
            {
              method: 'DELETE',
              headers: {
                'Content-Type': 'application/json'
              }
            }
          );

          if (!wapiResponse.ok) {
            const wapiData = await wapiResponse.json();
            const error = new Error(wapiData.message || 'Falha ao excluir conexão na W-API');
            Sentry.captureException(error, {
              extra: {
                channelId,
                organizationId,
                wapiData
              }
            });
            console.error('Falha ao excluir conexão na W-API:', error);
          } else {
            const wapiData = await wapiResponse.json();
            if (wapiData.error) {
              const error = new Error(wapiData.message || 'Erro retornado pela W-API');
              Sentry.captureException(error, {
                extra: {
                  channelId,
                  organizationId,
                  wapiData
                }
              });
              console.error('Erro retornado pela W-API:', error);
            }
          }
        } catch (wapiError) {
          console.error('Erro ao excluir conexão W-API:', wapiError);
          Sentry.captureException(wapiError, {
            extra: {
              channelId,
              organizationId
            }
          });
          // Continua com a exclusão local mesmo se falhar na API
        }
      } else if (channel.is_connected) {
        // Para conexões não-Interflow, desconectar antes de excluir
        try {
          await disconnectWapiInstance({ 
            params: { channelId },
            body: {}
          }, {
            json: () => {},
            status: () => ({ json: () => {} })
          });
        } catch (disconnectError) {
          console.error('Erro ao desconectar instância:', disconnectError);
          // Continua com a exclusão mesmo se falhar a desconexão
        }
      }
    }

    // Excluir os chats associados ao canal
    const { error: deleteChatsError } = await supabase
      .from('chats')
      .delete()
      .eq('channel_id', channelId);

    if (deleteChatsError) throw deleteChatsError;

    // Excluir o canal do banco de dados
    const { error: deleteError } = await supabase
      .from('chat_channels')
      .delete()
      .eq('id', channelId);

    if (deleteError) throw deleteError;

    res.json({
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
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

export async function transferChats(req, res) {
  const { channelId } = req.params;
  const { targetChannelId } = req.body;

  try {
    // Validar se os canais existem
    const { data: channels, error: channelsError } = await supabase
      .from('chat_channels')
      .select('*')
      .in('id', [channelId, targetChannelId]);

    if (channelsError) throw channelsError;
    if (!channels || channels.length !== 2) {
      return res.status(404).json({
        success: false,
        error: 'Um ou ambos os canais não foram encontrados'
      });
    }

    // Atualizar todos os chats do canal origem para o canal destino
    const { error: updateError } = await supabase
      .from('chats')
      .update({ channel_id: targetChannelId })
      .eq('channel_id', channelId);

    if (updateError) throw updateError;

    res.json({
      success: true,
      message: 'Chats transferidos com sucesso'
    });

  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId,
        targetChannelId
      }
    });
    console.error('Erro ao transferir chats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

export async function handleDeleteMessageWapiChannel(channel, messageData) {
  try {
    const { data: channelData, error: channelError } = await supabase
      .from('chat_channels')
      .select('credentials')
      .eq('id', channel.id)
      .single();

    if (channelError) throw channelError;

    const credentials = channelData.credentials;
    const apiUrl = credentials.api_url;
    const apiKey = decrypt(credentials.api_key);

    const response = await fetch(`${apiUrl}/message/delete?connectionKey=${credentials.apiConnectionKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': apiKey
      },
      body: JSON.stringify({
        phoneNumber: messageData.to,
        messageKey: {
          remoteJid: `${messageData.to}@s.whatsapp.net`,
          fromMe: true,
          id: messageData.externalId
        }
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`WAPI error: ${JSON.stringify(errorData)}`);
    }

    return true;
  } catch (error) {
    console.error('Erro ao deletar mensagem WAPI:', error);
    Sentry.captureException(error);
    throw error;
  }
}