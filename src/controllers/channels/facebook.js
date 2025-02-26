import { handleIncomingMessage, handleStatusUpdate } from '../chat/message-handlers.js';
import { validateChannel } from '../webhooks/utils.js';

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
        await handleStatusUpdate(channel, webhookData);
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
    throw error;
  }
}