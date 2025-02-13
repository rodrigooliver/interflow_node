import { handleIncomingMessage, handleStatusUpdate } from '../webhooks/message-handlers.js';
import { validateChannel } from '../webhooks/utils.js';
import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';

export async function handleWapiWebhook(req, res) {
  const { channelId } = req.params;
  const webhookData = req.body;

  try {
    // Get channel details
    const channel = await validateChannel(channelId, 'whatsapp_wapi');
    
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

    // Make request to WApi server to generate QR code
    const response = await fetch(`https://${channel.credentials.apiHost}/instance/qrcode?connectionKey=${channel.credentials.apiConnectionKey}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${channel.credentials.apiToken}`
      }
    });

    if (!response.ok) {
      throw new Error('Failed to generate QR code');
    }

    const data = await response.json();

    // Check for error in response
    if (data.error) {
      throw new Error(data.message || 'Failed to generate QR code');
    }

    // Update channel with QR code from base64 response
    const { error: updateError } = await supabase
      .from('chat_channels')
      .update({
        credentials: {
          ...channel.credentials,
          qrCode: `${data.qrcode}` // Add data URL prefix for base64 image
        }
      })
      .eq('id', channelId);

    if (updateError) throw updateError;

    res.json({
      success: true,
      data: {
        qrCode: data.qrcode // Return with data URL prefix
      }
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