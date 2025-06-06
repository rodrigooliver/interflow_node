import { supabase } from '../lib/supabase.js';
import Sentry from '../lib/sentry.js';
import { sendSystemMessage } from '../controllers/chat/message-handlers.js';

/**
 * Serviço unificado para envio de mensagens através de diferentes canais
 */

/**
 * Envia uma mensagem através do canal especificado
 */
export async function sendMessage({ customer, channelId, content, organizationId }) {
  try {
    const contacts = customer.contacts;
    
    // Buscar informações do canal
    const { data: channel, error: channelError } = await supabase
      .from('chat_channels')
      .select('*')
      .eq('id', channelId)
      .single();

    if (channelError) throw channelError;

    // Verificar se o canal está conectado
    if (!channel.is_connected) {
      throw new Error('Canal desconectado. Não é possível enviar mensagens.');
    }

    // Determinar o tipo de contato baseado no tipo do canal
    let contactType;
    switch (channel.type) {
      case 'whatsapp_official':
      case 'whatsapp_wapi':
      case 'whatsapp_zapi':
      case 'whatsapp_evo':
        contactType = 'whatsapp';
        break;
      case 'instagram':
        contactType = 'instagramId';
        break;
      case 'facebook':
        contactType = 'facebookId';
        break;
      case 'email':
        contactType = 'email';
        break;
      default:
        contactType = null;
    }

    // Buscar o contato apropriado
    let selectedContact = null;
    if (contactType && contacts && contacts.length > 0) {
      // Filtrar contatos por tipo
      const contactsByType = contacts.filter(contact => contact.type === contactType);
      
      if (contactsByType.length > 0) {
        // Se há múltiplos contatos do mesmo tipo, priorizar o primary
        const primaryContact = contactsByType.find(contact => contact.is_primary_for_type);
        selectedContact = primaryContact || contactsByType[0];
      }
    }

    // Formatar external_id baseado no tipo do canal
    let externalId = selectedContact?.value;
    if (selectedContact && contactType === 'whatsapp' && externalId) {
      externalId = formatWhatsAppNumber(externalId, channel.type);
    }

    // Buscar ou criar chat para este cliente e canal
    const chatId = await getOrCreateChat(customer, channel, organizationId, externalId);

    // Determinar o tipo de mensagem baseado no canal
    let messageType = 'text';
    if (channel.type === 'email') {
      messageType = 'email';
    }

    // Cadastrar a mensagem no banco de dados primeiro
    const messageId = await saveMessageToDatabase({
      chatId,
      organizationId,
      content,
      type: messageType,
      status: 'pending'
    });

    // Enviar mensagem usando sendSystemMessage
    const result = await sendSystemMessage(messageId);

    if (result.error) {
      throw new Error(result.error);
    }

    return {
      messageId,
      externalId: result.messageId,
      success: true
    };

  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);
    Sentry.captureException(error);
    throw error;
  }
}

/**
 * Busca ou cria um chat para o cliente e canal
 */
async function getOrCreateChat(customer, channel, organizationId, externalId) {
  const customerId = customer.id;
  const channelId = channel.id;
  try {
    // Preparar lista de external_ids para buscar (incluindo versão alternativa para WhatsApp)
    let externalIdsToSearch = [externalId];
    
    // Se for WhatsApp, criar versão alternativa do número
    if (channel.type?.startsWith('whatsapp') && externalId) {
      const alternativeId = createAlternativeWhatsAppNumber(externalId, channel.type);
      if (alternativeId && alternativeId !== externalId) {
        externalIdsToSearch.push(alternativeId);
      }
    }

    // Tentar encontrar chat existente com qualquer uma das versões do external_id
    const { data: existingChat, error: searchError } = await supabase
      .from('chats')
      .select('id')
      .eq('customer_id', customerId)
      .eq('channel_id', channelId)
      .eq('organization_id', organizationId)
      .in('external_id', externalIdsToSearch)
      .in('status', ['pending', 'in_progress'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (searchError) throw searchError;

    // Se encontrou chat existente, usar ele
    if (existingChat && existingChat.length > 0) {
      return existingChat[0].id;
    }

    //Se não tiver team_default no channel, buscar team_default no organization
    let teamDefaultId = channel.settings.defaultTeamId || null;
    if(!teamDefaultId) {
      const { data: teamDefault, error: teamDefaultError } = await supabase
        .from('service_teams')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('is_default', true)
        .single();
      teamDefaultId = teamDefault.id;
    }

    // Criar novo chat
    const { data: newChat, error: createError } = await supabase
      .from('chats')
      .insert([{
        customer_id: customerId,
        channel_id: channelId,
        organization_id: organizationId,
        status: 'pending',
        arrival_time: new Date().toISOString(),
        external_id: externalId,
        team_id: teamDefaultId || null,
        created_at: new Date().toISOString()
      }])
      .select('id')
      .single();

    if (createError) throw createError;

    return newChat.id;

  } catch (error) {
    console.error('Erro ao buscar/criar chat:', error);
    Sentry.captureException(error);
    throw error;
  }
}

/**
 * Salva a mensagem no banco de dados
 */
async function saveMessageToDatabase({ chatId, organizationId, content, type = 'text', status = 'pending' }) {
  try {
    const { data: message, error } = await supabase
      .from('messages')
      .insert([{
        chat_id: chatId,
        organization_id: organizationId,
        content,
        type,
        sent_from_system: true,
        sender_type: 'agent',
        status,
        created_at: new Date().toISOString()
      }])
      .select('id')
      .single();

    if (error) throw error;

    // Atualizar última mensagem do chat
    await supabase
      .from('chats')
      .update({
        last_message_at: new Date().toISOString(),
        last_message_id: message.id
      })
      .eq('id', chatId);

    return message.id;

  } catch (error) {
    console.error('Erro ao salvar mensagem no banco:', error);
    Sentry.captureException(error);
    throw error;
  }
}

/**
 * Formata número de WhatsApp baseado no tipo do canal
 */
function formatWhatsAppNumber(contactValue, channelType) {
  if (!contactValue) return contactValue;

  // Remover caracteres não numéricos
  const cleanNumber = contactValue.replace(/\D/g, '');
  
  let formattedValue = cleanNumber;
  
  // Formatar para o canal específico
  if (channelType === 'whatsapp_evo') {
    formattedValue = `${cleanNumber}@s.whatsapp.net`;
  } else if (channelType === 'whatsapp_official' || channelType === 'whatsapp_wapi' || channelType === 'whatsapp_zapi') {
    formattedValue = cleanNumber;
  }
  
  return formattedValue;
}

/**
 * Cria versão alternativa do número WhatsApp (com/sem 9 adicional)
 */
function createAlternativeWhatsAppNumber(externalId, channelType) {
  if (!externalId) return null;

  // Extrair número limpo (sem @s.whatsapp.net se houver)
  let cleanNumber = externalId.replace('@s.whatsapp.net', '').replace(/\D/g, '');
  
  // Para números brasileiros, criar versão alternativa com/sem 9 adicional
  if (cleanNumber.startsWith('55') && cleanNumber.length >= 12) {
    const ddd = cleanNumber.substring(2, 4);
    const rest = cleanNumber.substring(4);
    
    let alternativeNumber;
    // Se o número tem 9 na frente (após DDD)
    if (rest.startsWith('9') && rest.length > 8) {
      // Alternativa sem o 9
      alternativeNumber = `55${ddd}${rest.substring(1)}`;
    } else if (rest.length === 8) {
      // Alternativa com o 9 adicionado
      alternativeNumber = `55${ddd}9${rest}`;
    }
    
    if (alternativeNumber) {
      // Formatar para o canal específico
      if (channelType === 'whatsapp_evo') {
        return `${alternativeNumber}@s.whatsapp.net`;
      } else {
        return alternativeNumber;
      }
    }
  }
  
  return null;
}

 