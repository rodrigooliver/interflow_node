import { supabase } from '../../lib/supabase.js';
import { createChat } from '../../services/chat.js';
import { findExistingChat } from './utils.js';

export async function handleIncomingMessage(channel, webhookData) {
  const { organization } = channel;
  
  try {
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

    // Create message
    await supabase
      .from('messages')
      .insert({
        chat_id: chat.id,
        organization_id: organization.id,
        content: webhookData.text || '',
        sender_type: 'customer',
        sender_id: customer.id,
        status: 'delivered',
        metadata: {
          messageId: webhookData.messageId,
          type: webhookData.type,
          // Add any other relevant metadata
        }
      });

  } catch (error) {
    console.error('Error handling incoming message:', error);
    throw error;
  }
}

export async function handleStatusUpdate(channel, webhookData) {
  try {
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
  } catch (error) {
    console.error('Error handling status update:', error);
    throw error;
  }
}