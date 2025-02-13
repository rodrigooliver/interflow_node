import { handleIncomingMessage, handleStatusUpdate } from '../webhooks/message-handlers.js';
import { validateChannel } from '../webhooks/utils.js';

export async function handleWapiWebhook(req, res) {
  const { channelId } = req.params;
  const webhookData = req.body;

  try {
    // Get channel details
    const channel = await validateChannel(channelId, 'instagram');
    
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
    console.error('Error testing WApi connection:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}