import { handleIncomingMessage, handleStatusUpdate } from '../webhooks/message-handlers.js';
import { validateChannel } from '../webhooks/utils.js';
import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';

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

    // Test connection by making a request to the WApi server
    const response = await fetch(`https://${apiHost}/instance/isInstanceOnline?connectionKey=${apiConnectionKey}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiToken}`
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

    // Update webhook configuration
    await updateWebhook(channel);

    // Make request to WApi server to generate QR code
    const response = await fetch(`https://${channel.credentials.apiHost}/instance/getQrcode?connectionKey=${channel.credentials.apiConnectionKey}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${channel.credentials.apiToken}`
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

    const webhookUrl = `${process.env.API_URL}/api/webhook/wapi/${channel.id}`;

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

    // Update channel with webhook URL
    const { error: updateError } = await supabase
      .from('chat_channels')
      .update({
        credentials: {
          ...channel.credentials,
          webhookUrl
        }
      })
      .eq('id', channel.id);

    if (updateError) throw updateError;

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

    // Fazer requisição para desconectar a instância na WApi
    const response = await fetch(`https://${channel.credentials.apiHost}/instance/logout?connectionKey=${channel.credentials.apiConnectionKey}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${channel.credentials.apiToken}`
      }
    });

    if (!response.ok) {
      throw new Error('Failed to disconnect WApi instance');
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(data.message || 'Failed to reset WApi instance');
    }

    // Atualizar status no banco de dados
    const { error: updateError } = await supabase
      .from('chat_channels')
      .update({
        is_connected: false,
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