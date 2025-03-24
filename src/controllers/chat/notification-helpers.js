import { supabase } from '../../lib/supabase.js';
import { sendNotification } from '../../lib/oneSignal.js';
import Sentry from '../../lib/sentry.js';
import dotenv from 'dotenv';

dotenv.config();

const FRONT_URL = process.env.FRONTEND_URL || 'https://app.interflow.ai';

/**
 * Envia notificações push para os usuários relevantes
 * @param {Object} chat - Objeto do chat
 * @param {Object} customer - Objeto do cliente
 * @param {Object} message - Objeto da mensagem
 * @returns {Promise<void>}
 */
export async function sendChatNotifications(chat, customer, message) {
  try {
    if (!chat || !customer || !message) {
      console.warn('Parâmetros insuficientes para enviar notificações');
      return;
    }

    if (message.sender_type !== 'customer') {
      // Só enviamos notificações para mensagens de clientes
      return;
    }

    // Determinar o conteúdo da notificação
    let messageContent = message.content || '';
    
    // Se a mensagem for um arquivo, ajustar o conteúdo
    if (message.type !== 'text' && message.attachments?.length > 0) {
      const fileType = message.type.charAt(0).toUpperCase() + message.type.slice(1);
      messageContent = `[${fileType}]`;
    }

    // Buscar informações do canal
    let channelName = 'Chat';
    let channelEmoji = '💬'; // Emoji padrão para chat

    if (chat.channel_id) {
      const { data: channel, error: channelError } = await supabase
        .from('chat_channels')
        .select('name, type')
        .eq('id', chat.channel_id)
        .single();

      if (!channelError && channel) {
        // Definir emoji baseado no tipo do canal
        if (channel.type) {
          switch (true) {
            case channel.type.startsWith('whatsapp_'):
              channelName = 'WhatsApp';
              channelEmoji = '💬';
              break;
            case channel.type === 'instagram':
              channelName = 'INSTAGRAM';
              channelEmoji = '💬';
              break;
            case channel.type === 'facebook':
              channelName = 'FACEBOOK';
              channelEmoji = '💬';
              break;
            case channel.type === 'email':
              channelName = 'EMAIL';
              channelEmoji = '✉️';
              break;
            case channel.type === 'telegram':
              channelName = 'TELEGRAM';
              channelEmoji = '💬';
              break;
            default:
              channelName = channel.type.toUpperCase();
          }
        }
        
        // Se tiver um nome personalizado, sobrescrever apenas o nome
        if (channel.name) {
          channelName = channel.name;
        }
      }
    }

    // Preparar dados da notificação com o nome do canal como subtítulo
    const notificationData = {
      heading: `${channelEmoji} ${channelName}`,
      subtitle: customer.name || 'Nova mensagem',
      content: messageContent,
      data: {
        url: `${FRONT_URL}/app/chats/${chat.id}`,
        chat_id: chat.id,
        customer_id: customer.id,
        message_id: message.id
      }
    };

    // Determinar para quem enviar com base no status do chat
    if (chat.status === 'pending') {
      await sendToTeamMembers(chat, notificationData);
    } else if (chat.status === 'in_progress') {
      await sendToAssignedAndCollaborators(chat, notificationData);
    }
  } catch (error) {
    console.error('Erro ao enviar notificações push:', error);
    Sentry.captureException(error, {
      extra: { 
        context: 'sending_push_notifications', 
        chat_id: chat?.id,
        customer_id: customer?.id,
        message_id: message?.id
      }
    });
  }
}

/**
 * Envia notificações para os membros da equipe de um chat pendente
 * @param {Object} chat - Objeto do chat
 * @param {Object} notificationData - Dados da notificação
 * @returns {Promise<void>}
 */
async function sendToTeamMembers(chat, notificationData) {
  try {
    if (!chat.team_id) {
      console.log('Chat pendente sem equipe atribuída, nenhuma notificação enviada');
      return;
    }

    // Buscar os membros da equipe na tabela service_team_members
    const { data: teamMembers, error: teamError } = await supabase
      .from('service_team_members')
      .select('user_id')
      .eq('team_id', chat.team_id);

    if (teamError) {
      throw new Error(`Erro ao buscar membros da equipe: ${teamError.message}`);
    }

    if (!teamMembers || teamMembers.length === 0) {
      console.log(`Equipe ${chat.team_id} não tem membros, nenhuma notificação enviada`);
      return;
    }

    // Extrair os IDs dos usuários
    const userIds = teamMembers.map(member => member.user_id);
    
    // Enviar notificação usando include_aliases com external_id
    await sendNotificationWithFilters(userIds, notificationData);
  } catch (error) {
    console.error('Erro ao enviar notificações para membros da equipe:', error);
    Sentry.captureException(error, {
      extra: { 
        context: 'sending_team_notifications',
        chat_id: chat?.id,
        team_id: chat?.team_id
      }
    });
    throw error;
  }
}

/**
 * Envia notificações para o atendente atribuído e colaboradores de um chat em andamento
 * @param {Object} chat - Objeto do chat
 * @param {Object} notificationData - Dados da notificação
 * @returns {Promise<void>}
 */
async function sendToAssignedAndCollaborators(chat, notificationData) {
  try {
    // Lista para armazenar todos os IDs de usuário únicos
    const userIds = new Set();

    // Adicionar o usuário atribuído ao chat, se houver
    if (chat.assigned_to) {
      userIds.add(chat.assigned_to);
    }

    // Buscar os colaboradores do chat
    if (chat.id) {
      const { data: collaborators, error: collabError } = await supabase
        .from('chat_collaborators')
        .select('user_id')
        .eq('chat_id', chat.id);

      if (collabError) {
        throw new Error(`Erro ao buscar colaboradores: ${collabError.message}`);
      }

      // Adicionar os IDs dos colaboradores ao conjunto
      if (collaborators && collaborators.length > 0) {
        collaborators.forEach(collab => userIds.add(collab.user_id));
      }
    }

    // Se não há usuários para notificar, sair
    if (userIds.size === 0) {
      console.log('Nenhum usuário para notificar');
      return;
    }

    // Converter o Set para um array e enviar as notificações
    await sendNotificationWithFilters(Array.from(userIds), notificationData);
  } catch (error) {
    console.error('Erro ao enviar notificações para atendente e colaboradores:', error);
    Sentry.captureException(error, {
      extra: { 
        context: 'sending_assigned_notifications',
        chat_id: chat?.id,
        assigned_to: chat?.assigned_to
      }
    });
    throw error;
  }
}

/**
 * Envia notificações usando external_id através do OneSignal
 * @param {string[]} profileIds - Array de IDs de perfis
 * @param {Object} notificationData - Dados da notificação
 * @returns {Promise<void>}
 */
async function sendNotificationWithFilters(profileIds, notificationData) {
  try {
    if (!profileIds || profileIds.length === 0) {
      return;
    }

    // Usar include_aliases com external_id conforme documentação do OneSignal
    await sendNotification({
      ...notificationData,
      include_aliases: {
        external_id: profileIds
      },
      target_channel: "push"
    });

    console.log(`Notificação enviada para ${profileIds.length} usuários com external_id`);
  } catch (error) {
    console.error('Erro ao enviar notificações com external_id:', error);
    Sentry.captureException(error, {
      extra: { 
        context: 'sending_notification_with_filters',
        profile_ids_count: profileIds?.length
      }
    });
    throw error;
  }
} 