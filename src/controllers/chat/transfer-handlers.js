import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';
import { sendToTeamMembers, sendNotificationWithFilters } from './notification-helpers.js';
import dotenv from 'dotenv';

dotenv.config();

const FRONT_URL = process.env.FRONTEND_URL || 'https://app.interflow.ai';

export async function transferAllChatsCustomerRoute(req, res) {
  const { oldCustomerId, newCustomerId } = req.body;
  const { organizationId } = req.params;
  const { language } = req;

  if (!oldCustomerId || !newCustomerId) {
    return res.status(400).json({ 
      error: req.t('chat.transfer.errors.required_fields'),
      language 
    });
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
      message: req.t('chat.transfer.success.chats_transferred'),
      transferredChats: chats.length,
      language
    });

  } catch (error) {
    console.error('Erro ao transferir chats:', error);
    Sentry.captureException(error);
    return res.status(500).json({ 
      error: req.t('chat.transfer.errors.transfer_error'),
      language
    });
  }
} 

export async function transferToTeamRoute(req, res) {
  const { organizationId, chatId } = req.params;
  const { oldTeamId, newTeamId, title } = req.body;
  const { profileId, language } = req;

  if (!chatId || !newTeamId) {
    return res.status(400).json({ 
      error: req.t('chat.transfer.errors.required_fields'),
      language
    });
  }

  if (oldTeamId === newTeamId) {
    return res.status(400).json({ 
      error: req.t('chat.transfer.errors.same_team'),
      language
    });
  }

  try {
    // Verificar se o chat existe e pertence à organização
    const { data: chat, error: chatError } = await supabase
      .from('chats')
      .select('*, customer:customers(name, id)')
      .eq('id', chatId)
      .eq('organization_id', organizationId)
      .single();

    if (chatError) throw chatError;
    if (!chat) {
      return res.status(404).json({ 
        error: req.t('chat.transfer.errors.chat_not_found'),
        language
      });
    }

    // Verificar se a equipe existe e pertence à organização
    const { data: team, error: teamError } = await supabase
      .from('service_teams')
      .select('*')
      .eq('id', newTeamId)
      .eq('organization_id', organizationId)
      .single();

    if (teamError) throw teamError;
    if (!team) {
      return res.status(404).json({ 
        error: req.t('chat.transfer.errors.team_not_found'),
        language
      });
    }

    // Atualizar o team_id do chat
    const { error: updateError } = await supabase
      .from('chats')
      .update({ 
        team_id: newTeamId, 
        ...(title ? {title: title} : {}),
        assigned_to: null,
        status: 'pending',
      })
      .eq('id', chatId)
      .eq('organization_id', organizationId);

    if (updateError) throw updateError;

    // Enviar mensagem para o novo time
    const { data: message, error: sendMessageError } = await supabase
      .from('messages')
      .insert({
        chat_id: chatId,
        sender_type: 'system',
        sender_agent_id: profileId ?? null,
        type: 'team_transferred',
        content: team.name,
        organization_id: organizationId,
        created_at: new Date().toISOString(),
        status: 'pending'
      }).select('*');

    if (sendMessageError) throw sendMessageError;

    sendToTeamMembers(chat, {
      heading: chat.customer?.name ?? req.t('chat.transfer.notifications.chat_available'),
      subtitle: `${req.t('chat.transfer.notifications.chat_awaiting_attendance')} ${team.name}`,
      content: title ?? `${req.t('chat.transfer.notifications.chat_awaiting_attendance')} ${team.name}`,
      data: {
        url: `${FRONT_URL}/app/chats/${chat.id}`,
        chat_id: chat.id,
        customer_id: chat.customer?.id,
        message_id: message.id,
        language
      }
    });

    // console.log(req.t('chat.transfer.success.team_transferred'));

    return res.json({ 
      success: true, 
      message: req.t('chat.transfer.success.team_transferred'),
      language
    });

  } catch (error) {
    console.error('Erro ao transferir chat para equipe:', error);
    Sentry.captureException(error);
    return res.status(500).json({ 
      error: req.t('chat.transfer.errors.team_transfer_error'),
      language
    });
  }
}

export async function leaveAttendanceRoute(req, res) {
  const { organizationId, chatId } = req.params;
  const { title } = req.body;
  const { profileId, language } = req;


  try {
    // Verificar se o chat existe e pertence à organização
    const { data: chat, error: chatError } = await supabase
      .from('chats')
      .select('*, customer:customers(name, id), team:service_teams(name, id)')
      .eq('id', chatId)
      .eq('organization_id', organizationId)
      .single();

    if (chatError) throw chatError;

    if (!chat) {
      return res.status(404).json({ 
        error: req.t('chat.transfer.errors.chat_not_found'),
        language
      });
    }

    // Verificar se o chat está em andamento
    if (chat.status !== 'in_progress') {
      return res.status(400).json({ 
        error: req.t('chat.transfer.errors.chat_not_active'),
        language
      });
    }

    // Atualizar o status do chat para 'pending'
    const { error: updateError } = await supabase
      .from('chats')
      .update({ 
        status: 'pending', 
        ...(title ? {title: title} : {}),
        assigned_to: null 
      })
      .eq('id', chatId)
      .eq('organization_id', organizationId);

    if (updateError) throw updateError;

     // Enviar mensagem para o novo time
     const { data: message, error: sendMessageError } = await supabase
     .from('messages')
     .insert({
       chat_id: chatId,
       sender_type: 'system',
       sender_agent_id: profileId ?? null,
       type: 'user_left',
       content: null,
       organization_id: organizationId,
       created_at: new Date().toISOString(),
       status: 'pending'
     }).select('*');

   if (sendMessageError) throw sendMessageError;

    sendToTeamMembers(chat, {
      heading: chat.customer?.name ?? req.t('chat.transfer.notifications.chat_available'),
      subtitle: `${req.t('chat.transfer.notifications.chat_awaiting_attendance')} ${chat.team?.name}`,
      content: title ?? `${req.t('chat.transfer.notifications.chat_awaiting_attendance')} ${chat.team?.name}`,
      data: {
        url: `${FRONT_URL}/app/chats/${chat.id}`,
        chat_id: chat.id,
        customer_id: chat.customer?.id,
        language
      }
    });

    return res.json({
      success: true,
      message: req.t('chat.transfer.success.leave_attendance'),
      language
    });
  } catch (error) {
    console.error('Erro ao sair do atendimento:', error);
    Sentry.captureException(error);
    return res.status(500).json({ 
      error: req.t('chat.transfer.errors.leave_attendance_error'),
      language
    });
  }
}

export async function transferToAgentRoute(req, res) {
  const { organizationId, chatId } = req.params;
  const { oldTeamId, newTeamId, title, agentId } = req.body;
  const { profileId, language } = req;

  if (!chatId || !agentId) {
    return res.status(400).json({ 
      error: req.t('chat.transfer.errors.required_fields'),
      language
    });
  }

  try {
    // Verificar se o chat existe e pertence à organização
    const { data: chat, error: chatError } = await supabase
      .from('chats')
      .select('*, customer:customers(name, id), team:service_teams(name, id)')
      .eq('id', chatId)
      .eq('organization_id', organizationId)
      .single();

    if (chatError) throw chatError;
    if (!chat) {
      return res.status(404).json({ 
        error: req.t('chat.transfer.errors.chat_not_found'),
        language
      });
    }

    // Verificar se o agente pertence à equipe
    const { data: teamMember, error: teamMemberError } = await supabase
      .from('service_team_members')
      .select('*')
      .eq('team_id', newTeamId)
      .eq('user_id', agentId)
      .maybeSingle();

    // console.log(teamMember);

    if (teamMemberError) throw teamMemberError;
    if (!teamMember) {
      return res.status(403).json({ 
        error: req.t('chat.transfer.errors.agent_not_in_team'),
        language
      });
    }

    // Atualizar o chat com o novo agente
    const { error: updateError } = await supabase
      .from('chats')
      .update({ 
        assigned_to: agentId,
        team_id: newTeamId,
        ...(title ? {title: title} : {}),
        status: 'in_progress'
      })
      .eq('id', chatId)
      .eq('organization_id', organizationId);

    if (updateError) throw updateError;

    // Enviar mensagem de transferência
    const { data: message, error: sendMessageError } = await supabase
      .from('messages')
      .insert({
        chat_id: chatId,
        sender_type: 'system',
        sender_agent_id: agentId,
        type: 'user_transferred',
        content: null,
        organization_id: organizationId,
        created_at: new Date().toISOString(),
        status: 'pending'
      }).select('*');

    if (sendMessageError) throw sendMessageError;

    sendNotificationWithFilters([agentId], {
      heading: chat.customer?.name ?? req.t('chat.transfer.notifications.chat_available'),
      subtitle: `${req.t('chat.transfer.notifications.chat_assigned_to')}`,
      content: title ?? `${req.t('chat.transfer.notifications.chat_assigned_to')}`,
      data: {
        url: `${FRONT_URL}/app/chats/${chat.id}`,
      }
    });

    return res.json({ 
      success: true, 
      message: req.t('chat.transfer.success.agent_transferred'),
      language
    });

  } catch (error) {
    console.error('Erro ao transferir chat para agente:', error);
    Sentry.captureException(error);
    return res.status(500).json({ 
      error: req.t('chat.transfer.errors.agent_transfer_error'),
      language
    });
  }
}