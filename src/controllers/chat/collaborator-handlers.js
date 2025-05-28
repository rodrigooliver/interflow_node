import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';
import { sendNotificationWithFilters } from './notification-helpers.js';
import dotenv from 'dotenv';

dotenv.config();

const FRONT_URL = process.env.FRONTEND_URL || 'https://app.interflow.ai';

export async function addCollaboratorRoute(req, res) {
  const { organizationId, chatId } = req.params;
  const { user_id } = req.body;
  const { language } = req;

  if (!user_id) {
    return res.status(400).json({ 
      error: req.t('chat.collaborator.errors.user_id_required'),
      language 
    });
  }

  try {
    // Verificar se o chat existe e pertence à organização
    const { data: chat, error: chatError } = await supabase
      .from('chats')
      .select('*, customer:customers(*)')
      .eq('id', chatId)
      .eq('organization_id', organizationId)
      .single();

    if (chatError) throw chatError;

    if (!chat) {
      return res.status(404).json({ 
        error: req.t('chat.collaborator.errors.chat_not_found'),
        language
      });
    }

    // Verificar se o usuário existe e pertence à organização
    // Buscar o organization_member pelo profile_id fornecido
    const { data: orgMember, error: orgMemberError } = await supabase
      .from('organization_members')
      .select('*, profile:profiles(*)')
      .eq('profile_id', user_id)
      .eq('organization_id', organizationId)
      .single();

    if (orgMemberError) throw orgMemberError;

    if (!orgMember) {
      return res.status(404).json({ 
        error: req.t('chat.collaborator.errors.user_not_found'),
        language
      });
    }

    // Verificar se o usuário já é colaborador
    const { data: existingCollaborator, error: checkError } = await supabase
      .from('chat_collaborators')
      .select('*')
      .eq('chat_id', chatId)
      .eq('user_id', user_id) // Usar diretamente o user_id fornecido
      .is('left_at', null)
      .single();

    if (checkError && checkError.code !== 'PGRST116') throw checkError;

    if (existingCollaborator) {
      return res.status(400).json({ 
        error: req.t('chat.collaborator.errors.already_collaborator'),
        language
      });
    }

    // Adicionar o colaborador
    const { data: newCollaborator, error: insertError } = await supabase
      .from('chat_collaborators')
      .insert({
        chat_id: chatId,
        user_id: user_id, // Usar diretamente o user_id fornecido
        organization_id: organizationId,
        joined_at: new Date().toISOString()
      })
      .select('*')
      .single();

    if (insertError) throw insertError;

    // Buscar os dados completos do colaborador adicionado
    const { data: collaboratorWithProfile, error: profileError } = await supabase
      .from('chat_collaborators')
      .select(`
        *,
        profile:profiles(*)
      `)
      .eq('id', newCollaborator.id)
      .single();

    if (profileError) throw profileError;

    // Inserir mensagem de sistema
    const { error: messageError } = await supabase
        .from('messages')
        .insert({
            chat_id: chatId,
            type: 'user_join',
            sender_type: 'system',
            sender_agent_id: user_id, // Usar diretamente o user_id fornecido
            organization_id: organizationId,
            created_at: new Date().toISOString()
        });

    if (messageError) throw messageError;

    // Enviar notificação para o novo colaborador
    try {
      await sendNotificationWithFilters(
        [user_id], // Usar diretamente o user_id fornecido
        {
          heading: req.t('chat.collaborator.notifications.added_title'),
          content: req.t('chat.collaborator.notifications.added_message', { 
            chatId: `#${chat.ticket_number}`,
            customerName: chat.customer?.name || 'Cliente'
          }),
          data: {
            url: `${FRONT_URL}/app/chats/${chat.id}`,
            chatId: chat.id,
            organizationId,
            type: 'chat_collaborator_added',
            language
          }
        }
      );
    } catch (notificationError) {
      console.error('Erro ao enviar notificação:', notificationError);
      // Não falha a operação se a notificação falhar
    }

    return res.json({
      success: true,
      message: req.t('chat.collaborator.success.added'),
      collaborator: collaboratorWithProfile,
      language
    });

  } catch (error) {
    console.error('Erro ao adicionar colaborador:', error);
    Sentry.captureException(error);
    return res.status(500).json({ 
      error: req.t('chat.collaborator.errors.add_error'),
      language
    });
  }
}

export async function removeCollaboratorRoute(req, res) {
  const { organizationId, chatId, collaboratorId } = req.params;
  const { language } = req;

  try {
    // Verificar se o colaborador existe
    const { data: collaborator, error: collaboratorError } = await supabase
      .from('chat_collaborators')
      .select(`
        *,
        profile:profiles(*)
      `)
      .eq('id', collaboratorId)
      .eq('chat_id', chatId)
      .eq('organization_id', organizationId)
      .is('left_at', null)
      .single();

    if (collaboratorError) throw collaboratorError;

    if (!collaborator) {
      return res.status(404).json({ 
        error: req.t('chat.collaborator.errors.collaborator_not_found'),
        language
      });
    }

    // Marcar como saído
    const { error: updateError } = await supabase
      .from('chat_collaborators')
      .update({
        left_at: new Date().toISOString()
      })
      .eq('id', collaboratorId);

    if (updateError) throw updateError;

    // Inserir mensagem de sistema
    const { error: messageError } = await supabase
    .from('messages')
    .insert({
      chat_id: chatId,
      type: 'user_left',
      sender_type: 'system',
      sender_agent_id: collaborator.user_id,
      organization_id: organizationId,
      created_at: new Date().toISOString()
    });

    if (messageError) throw messageError;

    return res.json({
      success: true,
      message: req.t('chat.collaborator.success.removed'),
      language
    });

  } catch (error) {
    console.error('Erro ao remover colaborador:', error);
    Sentry.captureException(error);
    return res.status(500).json({ 
      error: req.t('chat.collaborator.errors.remove_error'),
      language
    });
  }
}

export async function listCollaboratorsRoute(req, res) {
  const { organizationId, chatId } = req.params;
  const { language } = req;

  try {
    // Buscar colaboradores ativos
    const { data: collaborators, error: collaboratorsError } = await supabase
      .from('chat_collaborators')
      .select(`
        *,
        profile:profiles(*)
      `)
      .eq('chat_id', chatId)
      .eq('organization_id', organizationId)
      .is('left_at', null)
      .order('joined_at', { ascending: true });

    if (collaboratorsError) throw collaboratorsError;

    return res.json({
      success: true,
      collaborators: collaborators || [],
      language
    });

  } catch (error) {
    console.error('Erro ao listar colaboradores:', error);
    Sentry.captureException(error);
    return res.status(500).json({ 
      error: req.t('chat.collaborator.errors.list_error'),
      language
    });
  }
} 