import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';

export async function findExistingChat(channelId, customerId) {
  try {
    // Use select() without single() to handle no rows case
    const { data: chats, error } = await supabase
      .from('chats')
      .select('*')
      .eq('channel_id', channelId)
      .eq('customer_id', customerId)
      .in('status', ['in_progress', 'pending', 'await_closing'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) {
      if (error.code === 'PGRST116') {
        return null; // No rows found
      }
      
      Sentry.captureException(error, {
        extra: { channelId, customerId }
      });
      console.error('Error finding existing chat:', error);
      throw error;
    }

    // Return first chat or null
    return chats && chats.length > 0 ? chats[0] : null;
  } catch (error) {
    Sentry.captureException(error, {
      extra: { channelId, customerId }
    });
    console.error('Error in findExistingChat:', error);
    throw error;
  }
}

export async function validateChannel(channelId, type) {
  try {
    // Use select() without single() to handle no rows case
    const { data: channels, error } = await supabase
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
        organization:organizations!inner (
          id,
          name,
          settings
        )
      `)
      .eq('id', channelId)
      .eq('type', type);

    if (error) {
      if (error.code === 'PGRST116') {
        return null; // No rows found
      }

      Sentry.captureException(error, {
        extra: { channelId, type }
      });
      console.error('Error validating channel:', error);
      throw error;
    }

    // Handle case where no channel is found
    if (!channels || channels.length === 0) {
      return null;
    }

    return channels[0];
  } catch (error) {
    Sentry.captureException(error, {
      extra: { channelId, type }
    });
    console.error('Error in validateChannel:', error);
    throw error;
  }
}

export async function findOrCreateCustomer(organization, contactInfo) {
  try {
    // Check if customer exists
    const { data: customers, error: findError } = await supabase
      .from('customers')
      .select('*')
      .eq('organization_id', organization.id)
      .eq('whatsapp', contactInfo.whatsapp);

    if (findError) {
      if (findError.code === 'PGRST116') {
        // No customer found, create new one
        const { data: newCustomers, error: createError } = await supabase
          .from('customers')
          .insert({
            organization_id: organization.id,
            name: contactInfo.name || contactInfo.whatsapp,
            whatsapp: contactInfo.whatsapp
          })
          .select();

        if (createError) {
          Sentry.captureException(createError, {
            extra: { organization, contactInfo }
          });
          throw createError;
        }

        return newCustomers[0];
      }
      throw findError;
    }

    // Return existing customer if found
    if (customers && customers.length > 0) {
      return customers[0];
    }

    // Create new customer if not exists
    const { data: newCustomers, error: createError } = await supabase
      .from('customers')
      .insert({
        organization_id: organization.id,
        name: contactInfo.name || contactInfo.whatsapp,
        whatsapp: contactInfo.whatsapp
      })
      .select();

    if (createError) {
      Sentry.captureException(createError, {
        extra: { organization, contactInfo }
      });
      throw createError;
    }

    return newCustomers[0];
  } catch (error) {
    Sentry.captureException(error, {
      extra: { organization, contactInfo }
    });
    console.error('Error in findOrCreateCustomer:', error);
    throw error;
  }
}