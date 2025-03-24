import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';

export async function transferChatRoute(req, res) {
  const { oldCustomerId, newCustomerId } = req.body;
  const { organizationId } = req.params;

  if (!oldCustomerId || !newCustomerId) {
    return res.status(400).json({ error: 'oldCustomerId e newCustomerId são obrigatórios' });
  }

  try {
    // Iniciar uma transação
    const { data: chats, error: chatsError } = await supabase
      .from('chats')
      .select('*')
      .eq('customer_id', oldCustomerId)
      .eq('organization_id', organizationId);

    if (chatsError) throw chatsError;

    // Atualizar todos os chats do cliente antigo para o novo cliente
    const { error: updateChatsError } = await supabase
      .from('chats')
      .update({ customer_id: newCustomerId })
      .eq('customer_id', oldCustomerId)
      .eq('organization_id', organizationId);

    if (updateChatsError) throw updateChatsError;

    // Atualizar o sender_customer_id das mensagens
    const { error: updateMessagesError } = await supabase
      .from('messages')
      .update({ sender_customer_id: newCustomerId })
      .eq('sender_customer_id', oldCustomerId)
      .eq('organization_id', organizationId);

    if (updateMessagesError) throw updateMessagesError;

    // Atualizar as sessões de fluxo
    const { error: updateSessionsError } = await supabase
      .from('flow_sessions')
      .update({ customer_id: newCustomerId })
      .eq('customer_id', oldCustomerId)
      .eq('organization_id', organizationId);

    if (updateSessionsError) throw updateSessionsError;

    // Buscar os contatos do cliente antigo
    const { data: oldCustomerContacts, error: contactsError } = await supabase
      .from('customer_contacts')
      .select('*')
      .eq('customer_id', oldCustomerId);

    if (contactsError) throw contactsError;

    // Verificar e adicionar os contatos ao novo cliente
    for (const contact of oldCustomerContacts) {
      const { data: existingContact, error: checkError } = await supabase
        .from('customer_contacts')
        .select('*')
        .eq('customer_id', newCustomerId)
        .eq('type', contact.type)
        .eq('value', contact.value)
        .single();

      if (checkError && checkError.code !== 'PGRST116') throw checkError;

      if (!existingContact) {
        const { error: insertError } = await supabase
          .from('customer_contacts')
          .insert({
            customer_id: newCustomerId,
            type: contact.type,
            value: contact.value,
            label: `Transferido do cliente ${oldCustomerId}`
          });

        if (insertError) throw insertError;
      }
    }

    return res.json({ 
      success: true, 
      message: 'Chats transferidos com sucesso',
      transferredChats: chats.length
    });

  } catch (error) {
    console.error('Erro ao transferir chats:', error);
    Sentry.captureException(error);
    return res.status(500).json({ error: 'Erro ao transferir chats' });
  }
} 