import { handleIncomingMessage, handleStatusUpdate } from '../webhooks/message-handlers.js';
import { validateChannel } from '../webhooks/utils.js';

export async function handleInstagramWebhook(req, res) {
  const { channelId } = req.params;
  const webhookData = req.body;

  try {
    const channel = await validateChannel(channelId, 'instagram');
    
    if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
    }

    // Handle different webhook events
    switch (webhookData.event) {
      case 'message':
        await handleIncomingMessage(channel, {
          ...webhookData,
          from: webhookData.sender.id, // Instagram user ID
          senderName: webhookData.sender.username,
          text: webhookData.message.text,
          messageId: webhookData.message.id,
          type: webhookData.message.type
        });
        break;
      case 'status':
        await handleStatusUpdate(channel, webhookData);
        break;
      case 'seen':
        // Handle message seen event
        await handleMessageSeen(channel, webhookData);
        break;
      default:
        console.log('Unhandled Instagram webhook event:', webhookData.event);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error handling Instagram webhook:', error);
    res.status(500).json({ error: error.message });
  }
}

async function handleMessageSeen(channel, webhookData) {
  try {
    // Update messages as read
    await supabase
      .from('messages')
      .update({ status: 'read' })
      .eq('chat_id', webhookData.chat_id)
      .lt('created_at', webhookData.seen_at);
  } catch (error) {
    console.error('Error handling message seen:', error);
    throw error;
  }
}