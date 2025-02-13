import { supabase } from '../../lib/supabase.js';

export async function findExistingChat(channelId, customerId) {
  const { data: chat } = await supabase
    .from('chats')
    .select('*')
    .eq('channel_id', channelId)
    .eq('customer_id', customerId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  return chat;
}

export async function validateChannel(channelId, type) {
  const { data: channel, error } = await supabase
    .from('chat_channels')
    .select('*, organization:organizations(*)')
    .eq('id', channelId)
    .eq('type', type)
    .single();

  if (error) throw error;
  if (!channel) throw new Error('Channel not found');

  return channel;
}

export async function findOrCreateCustomer(organization, contactInfo) {
  // Check if customer exists
  let { data: customer } = await supabase
    .from('customers')
    .select('*')
    .eq('organization_id', organization.id)
    .eq('whatsapp', contactInfo.whatsapp)
    .single();

  // Create customer if not exists
  if (!customer) {
    const { data: newCustomer, error: customerError } = await supabase
      .from('customers')
      .insert({
        organization_id: organization.id,
        name: contactInfo.name || contactInfo.whatsapp,
        whatsapp: contactInfo.whatsapp
      })
      .select()
      .single();

    if (customerError) throw customerError;
    customer = newCustomer;
  }

  return customer;
}