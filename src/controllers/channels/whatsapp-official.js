import { handleIncomingMessage, handleStatusUpdate } from '../webhooks/message-handlers.js';
import { validateChannel } from '../webhooks/utils.js';

export async function handleWhatsAppOfficialWebhook(req, res) {
  const { channelId } = req.params;
  const webhookData = req.body;

  try {
    const channel = await validateChannel(channelId, 'whatsapp_official');

    if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
    }

    // Handle different webhook events
    switch (webhookData.event) {
      case 'message':
        await handleIncomingMessage(channel, webhookData);
        break;
      case 'status':
        await handleStatusUpdate(channel, webhookData);
        break;
      // Add more event handlers as needed
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error handling webhook:', error);
    res.status(500).json({ error: error.message });
  }
}