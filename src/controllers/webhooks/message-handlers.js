import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';
import { createChat } from '../../services/chat.js';
import { findExistingChat } from './utils.js';
import { createFlowEngine } from '../../services/flow-engine.js';

export async function handleIncomingMessage(channel, webhookData) {
  const { organization } = channel;
  
  try {
    // Start a new transaction for error tracking
    const transaction = Sentry.startTransaction({
      name: 'handle-incoming-message',
      op: 'message.incoming',
      data: {
        channelType: channel.type,
        organizationId: organization.id
      }
    });

    // Check if customer exists
    let { data: customer } = await supabase
      .from('customers')
      .select('*')
      .eq('organization_id', organization.id)
      .eq('whatsapp', webhookData.from)
      .single();

    // Create customer if not exists
    if (!customer) {
      const { data: newCustomer, error: customerError } = await supabase
        .from('customers')
        .insert({
          organization_id: organization.id,
          name: webhookData.senderName || webhookData.from,
          whatsapp: webhookData.from
        })
        .select()
        .single();

      if (customerError) throw customerError;
      customer = newCustomer;
    }

    // Find existing chat or create new one
    let chat = await findExistingChat(channel.id, customer.id);
    
    if (!chat) {
      chat = await createChat({
        organization_id: organization.id,
        customer_id: customer.id,
        channel_id: channel.id,
        channel: 'whatsapp',
        whatsapp: customer.whatsapp,
        status: 'open'
      });
    }

    // Iniciar processamento do fluxo
    const flowEngine = createFlowEngine(organization, channel, customer, chat.id);
    await flowEngine.processMessage({
      content: webhookData.text,
      type: webhookData.type,
      metadata: webhookData
    });

    // Finish the transaction
    transaction.finish();
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channel,
        webhookData
      }
    });
    console.error('Error handling incoming message:', error);
    throw error;
  }
}

export async function handleStatusUpdate(channel, webhookData) {
  try {
    // Start a new transaction for error tracking
    const transaction = Sentry.startTransaction({
      name: 'handle-status-update',
      op: 'message.status',
      data: {
        channelType: channel.type,
        status: webhookData.status
      }
    });

    // Update message status based on webhook data
    const { data: message } = await supabase
      .from('messages')
      .select('*')
      .eq('metadata->messageId', webhookData.messageId)
      .single();

    if (message) {
      await supabase
        .from('messages')
        .update({
          status: webhookData.status,
          error_message: webhookData.error
        })
        .eq('id', message.id);
    }

    // Finish the transaction
    transaction.finish();
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channel,
        webhookData
      }
    });
    console.error('Error handling status update:', error);
    throw error;
  }
}