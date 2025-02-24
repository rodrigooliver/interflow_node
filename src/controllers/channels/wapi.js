import { handleIncomingMessage, handleStatusUpdate } from '../webhooks/message-handlers.js';
import { validateChannel } from '../webhooks/utils.js';
import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';
import { encrypt, decrypt } from '../../utils/crypto.js';

export async function handleWapiWebhook(req, res) {
  const { channelId } = req.params;
  const webhookData = req.body;

  console.log(webhookData)

  try {
    // Get channel details
    const channel = await validateChannel(channelId, 'whatsapp_wapi');
    
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    if(webhookData.isGroup) return;

    // Handle different webhook events
    switch (webhookData.event) {
      case 'messageReceived':
      case 'messageSent':
        const normalizedMessage = normalizeWapiMessage(webhookData);
        normalizedMessage.event = webhookData.event;
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

              if (updateError) throw updateError;
            }
          };

          // Inicia a primeira tentativa após 2 segundos
          setTimeout(() => updateMessageStatus(), 2000);
        }
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

async function handleQrCodeGenerated(channel, webhookData) {
  try {
    // Validate webhook data
    if (!webhookData.qrCode || !webhookData.connectionKey) {
      throw new Error('Invalid QR code data');
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
      throw new Error('Invalid connection data');
    }

    // Update channel status in database
    const { error: updateError } = await supabase
      .from('chat_channels')
      .update({
        is_connected: true,
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
  const { apiHost, apiConnectionKey, apiToken } = req.body;

  try {
    // Validate required parameters
    if (!apiHost || !apiConnectionKey || !apiToken) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters'
      });
    }

    // Validate API host format
    const hostRegex = /^[a-zA-Z0-9-]+\.[a-zA-Z0-9-]+\.[a-zA-Z]+$/;
    if (!hostRegex.test(apiHost)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid API host format'
      });
    }

    // Usar credenciais descriptografadas na requisição
    const decryptedApiToken = apiToken;
    const decryptedConnectionKey = apiConnectionKey;

    // Test connection by making a request to the WApi server
    const response = await fetch(`https://${apiHost}/instance/isInstanceOnline?connectionKey=${decryptedConnectionKey}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${decryptedApiToken}`
      }
    });

    if (!response.ok) {
      throw new Error('Failed to connect to WApi server');
    }

    const data = await response.json();

    // Check if the response indicates a valid connection
    if (data.error) {
      throw new Error(data.error || 'Invalid WApi credentials');
    }

    res.json({
      success: true,
      data: {
        connected: true,
        status: data.status
      }
    });
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        apiHost
      }
    });
    console.error('Error testing WApi connection:', error);
    res.status(500).json({
      success: false,
      error: error.message
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
      throw new Error('Failed to activate webhook V3');
    }

    const dataV3 = await responseV3.json();

    // Check for error in response
    if (dataV3.error) {
      throw new Error(dataV3.message || 'Failed to update webhook');
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
      throw new Error('Failed to update webhook');
    }

    const data = await response.json();

    // Check for error in response
    if (data.error) {
      throw new Error(data.message || 'Failed to update webhook');
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

    // Fazer requisição para resetar a instância na WApi
    const response = await fetch(`https://${channel.credentials.apiHost}/instance/restart?connectionKey=${channel.credentials.apiConnectionKey}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${channel.credentials.apiToken}`
      }
    });

    if (!response.ok) {
      throw new Error('Failed to reset WApi instance');
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(data.message || 'Failed to reset WApi instance');
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
    Sentry.captureException(error, {
      extra: { channelId }
    });
    console.error('Error resetting WApi connection:', error);
    res.status(500).json({
      success: false,
      error: error.message
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

    try {
      // Fazer requisição para desconectar a instância na WApi
      const response = await fetch(`https://${channel.credentials.apiHost}/instance/logout?connectionKey=${channel.credentials.apiConnectionKey}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${channel.credentials.apiToken}`
        }
      });

      if (!response.ok) {
        console.error('Failed to disconnect WApi instance, marking as disconnected anyway');
      } else {
        const data = await response.json();
        if (data.error) {
          console.error('WApi error:', data.message);
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
      type: 'text',
      content: webhookData.messageText?.text || '',
      raw: webhookData
    },
    isGroup: webhookData.isGroup,
    fromMe: webhookData.fromMe
  };
}

/**
 * Envia mensagem através do canal WApi
 * @returns {Promise<{messageId: string}>} ID da mensagem enviada
 */
export async function handleSenderMessageWApi(channel, messageData) {
  try {
    const { apiHost, apiConnectionKey, apiToken } = channel.credentials;
    const baseUrl = `https://${apiHost}`;
    let response;
    let responseData;

    // Se tiver anexos, envia como mídia
    if (messageData.attachments && messageData.attachments.length > 0) {
      const attachment = messageData.attachments[0];
      
      let endpoint = '';
      let body = {};

      if (attachment.type.startsWith('image/')) {
        endpoint = '/message/sendImage';
        body = {
          phoneNumber: messageData.to,
          caption: messageData.content,
          image: attachment.url
        };
      } else if (attachment.type.startsWith('video/')) {
        endpoint = '/message/sendVideo';
        body = {
          phoneNumber: messageData.to,
          caption: messageData.content,
          video: attachment.url
        };
      } else if (attachment.type.startsWith('audio/')) {
        endpoint = '/message/sendAudio';
        body = {
          phoneNumber: messageData.to,
          audio: attachment.url
        };
      } else {
        endpoint = '/message/sendDocument';
        body = {
          phoneNumber: messageData.to,
          document: attachment.url,
          fileName: attachment.name
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

    } else if (messageData.content) {
      response = await fetch(`${baseUrl}/message/send-text?connectionKey=${apiConnectionKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiToken}`
        },
        body: JSON.stringify({
          phoneNumber: messageData.to,
          text: messageData.content
        })
      });
    }

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Erro ao enviar mensagem');
    }

    responseData = await response.json();

    if (responseData.error) {
      throw new Error(responseData.message || 'Erro retornado pela API');
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
      const wapiResponse = await fetch(`https://api-painel.w-api.app/createNewConnection?id=${process.env.WAPI_ACCOUNT_ID}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!wapiResponse.ok) {
        throw new Error('Falha ao criar conexão na W-API');
      }

      const wapiData = await wapiResponse.json();

      if (wapiData.error) {
        throw new Error(wapiData.message || 'Erro retornado pela W-API');
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
      throw new Error(`Erro ao criar conexão W-API: ${wapiError.message}`);
    }

  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        organizationId,
        name
      }
    });
    console.error('Error creating Interflow channel:', error);
    res.status(500).json({
      success: false,
      error: error.message
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
            throw new Error('Falha ao excluir conexão na W-API');
          }

          const wapiData = await wapiResponse.json();
          if (wapiData.error) {
            throw new Error(wapiData.message || 'Erro retornado pela W-API');
          }
        } catch (wapiError) {
          console.error('Erro ao excluir conexão W-API:', wapiError);
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
      .in('id', [channelId, targetChannelId])
      .eq('type', 'whatsapp_wapi');

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