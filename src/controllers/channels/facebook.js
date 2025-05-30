import { handleIncomingMessage, handleStatusUpdate } from '../chat/message-handlers.js';
import { validateChannel } from '../webhooks/utils.js';
import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';

/**
 * Normaliza dados de status do Facebook para formato padrão
 * 
 * @param {Object} webhookData - Dados brutos do webhook Facebook
 * @returns {Object} - Dados normalizados para handleStatusUpdate
 */
function normalizeFacebookStatusUpdate(webhookData) {
  // Mapear status específicos do Facebook para status padronizados se necessário
  const mapFacebookStatusToStandard = (facebookStatus) => {
    const statusMap = {
      'sent': 'sent',
      'delivered': 'delivered', 
      'read': 'read',
      'failed': 'failed',
      'pending': 'pending',
      'error': 'failed'
    };
    return statusMap[facebookStatus] || facebookStatus || 'unknown';
  };

  return {
    messageId: webhookData.messageId || webhookData.id,
    status: mapFacebookStatusToStandard(webhookData.status),
    error: webhookData.error || webhookData.errorMessage || null,
    timestamp: webhookData.timestamp || webhookData.moment || Date.now(),
    metadata: {
      original: webhookData,
      source: 'facebook'
    }
  };
}

export async function handleFacebookWebhook(req, res) {
  const { channelId } = req.params;
  const webhookData = req.body;

  try {
    const channel = await validateChannel(channelId, 'facebook');

    if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
    }
  
    // Handle different webhook events
    switch (webhookData.event) {
      case 'message':
        await handleIncomingMessage(channel, {
          ...webhookData,
          from: webhookData.sender.id, // Facebook user ID
          senderName: webhookData.sender.name,
          text: webhookData.message.text,
          messageId: webhookData.message.mid,
          type: webhookData.message.type
        });
        break;
      case 'status':
        const normalizedStatusData = normalizeFacebookStatusUpdate(webhookData);
        await handleStatusUpdate(channel, normalizedStatusData);
        break;
      case 'delivery':
        // Handle message delivery confirmation
        await handleMessageDelivery(channel, webhookData);
        break;
      case 'read':
        // Handle message read confirmation
        await handleMessageRead(channel, webhookData);
        break;
      default:
        console.log('Unhandled Facebook webhook event:', webhookData.event);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error handling Facebook webhook:', error);
    Sentry.captureException(error, {
      extra: {
        channelId,
        webhookData
      }
    });
    res.status(500).json({ error: error.message });
  }
}

async function handleMessageDelivery(channel, webhookData) {
  try {
    // Update messages as delivered
    await supabase
      .from('messages')
      .update({ status: 'delivered' })
      .in('metadata->messageId', webhookData.delivery.mids);
  } catch (error) {
    console.error('Error handling message delivery:', error);
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id,
        webhookData
      }
    });
    throw error;
  }
}

async function handleMessageRead(channel, webhookData) {
  try {
    // Update messages as read
    await supabase
      .from('messages')
      .update({ status: 'read' })
      .eq('chat_id', webhookData.chat_id)
      .lt('created_at', webhookData.read.watermark);
  } catch (error) {
    console.error('Error handling message read:', error);
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id,
        webhookData
      }
    });
    throw error;
  }
}