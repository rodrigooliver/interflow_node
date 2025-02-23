import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';
import { createChat } from '../../services/chat.js';
import { findExistingChat } from './utils.js';
import { createFlowEngine } from '../../services/flow-engine.js';

import { handleSenderMessageWApi } from '../../controllers/channels/wapi.js';
// import { handleSenderMessageZApi } from '../../services/channels/z-api.js';
// import { handleSenderMessageEvolution } from '../../services/channels/evolution.js';
// import { handleSenderMessageOfficial } from '../../services/channels/official.js';
// import { handleSenderMessageInstagram } from '../../services/channels/instagram.js';
// import { handleSenderMessageFacebook } from '../../services/channels/facebook.js';
// import { handleSenderMessageEmail } from '../../services/channels/email.js';

/**
 * Configurações e handlers para cada tipo de canal
 */
const CHANNEL_CONFIG = {
  whatsapp_official: {
    identifier: 'whatsapp',
    // handler: handleSenderMessageOfficial
  },
  whatsapp_wapi: {
    identifier: 'whatsapp',
    handler: handleSenderMessageWApi
  },
  whatsapp_zapi: {
    identifier: 'whatsapp',
    // handler: handleSenderMessageZApi
  },
  whatsapp_evo: {
    identifier: 'whatsapp',
    // handler: handleSenderMessageEvolution
  },
  instagram: {
    identifier: 'instagram_id',
    // handler: handleSenderMessageInstagram
  },
  facebook: {
    identifier: 'facebook_id',
    // handler: handleSenderMessageFacebook
  },
  email: {
    identifier: 'email',
    // handler: handleSenderMessageEmail
  }
};

/**
 * Normaliza o ID do contato e retorna possíveis variantes
 * @param {string} id - ID original do contato
 * @param {string} channelType - Tipo do canal
 * @returns {string[]} Array com ID normalizado e suas variantes
 */
const normalizeContactId = (id, channelType) => {
  if (!id) return [id];

  switch (channelType) {
    case 'whatsapp_official':
    case 'whatsapp_wapi':
    case 'whatsapp_zapi':
    case 'whatsapp_evo': {
      // Remove todos os caracteres não numéricos
      let numbers = id.replace(/\D/g, '');
      
      // Remove @s.whatsapp.net se existir (whatsapp_evo)
      numbers = numbers.split('@')[0];
      
      const variants = new Set(); // Usa Set para evitar duplicatas
      
      // Se começar com 55 e tiver 12 ou 13 dígitos, é um número brasileiro
      if (numbers.startsWith('55') && (numbers.length === 12 || numbers.length === 13)) {
        if (numbers.length === 13) { // tem 9
          // Versão sem 9
          const withoutNine = `${numbers.slice(0, 4)}${numbers.slice(5)}`;
          variants.add(`+${withoutNine}`);
          variants.add(withoutNine);
        } else if (numbers.length === 12) { // não tem 9
          // Versão com 9
          const withNine = `${numbers.slice(0, 4)}9${numbers.slice(4)}`;
          variants.add(`+${withNine}`);
          variants.add(withNine);
        }
      }
      
      // Adiciona versões com e sem + para qualquer número
      variants.add(`+${numbers}`);
      variants.add(numbers);
      
      return Array.from(variants);
    }
    
    case 'instagram':
    case 'facebook': {
      const normalized = id.toLowerCase();
      return [normalized];
    }
    
    case 'email': {
      const normalized = id.toLowerCase().trim();
      return [normalized];
    }
    
    default:
      return [id];
  }
};

/**
 * Processa mensagens recebidas em formato padronizado
 * @param {Object} channel - Canal de comunicação
 * @param {Object} messageData - Dados normalizados da mensagem
 * @param {string} messageData.messageId - ID único da mensagem
 * @param {string} messageData.timestamp - Momento do envio
 * @param {string} messageData.externalId - ID do contato externo
 * @param {string} messageData.externalName - Nome do contato externo
 * @param {string} messageData.externalProfilePicture - URL da foto do contato externo
 * @param {Object} messageData.message - Dados da mensagem
 * @param {string} messageData.message.type - Tipo da mensagem (text, image, etc)
 * @param {string} messageData.message.content - Conteúdo da mensagem
 * @param {Object} messageData.message.raw - Dados brutos originais
 * @param {boolean} messageData.fromMe - Se foi uma mensagem enviada por mim
 */
export async function handleIncomingMessage(channel, messageData) {
  const { organization } = channel;
  
  try {
    const transaction = Sentry.startTransaction({
      name: 'handle-incoming-message',
      op: 'message.incoming',
      data: {
        channelType: channel.type,
        organizationId: organization.id
      }
    });

    const channelConfig = CHANNEL_CONFIG[channel.type];
    if (!channelConfig) {
      throw new Error(`Unsupported channel type: ${channel.type}`);
    }

    // Usa o identifier do canal configurado
    const identifierColumn = channelConfig.identifier;

    // Normaliza o ID apenas para busca do customer
    const normalizedId = normalizeContactId(messageData.externalId, channel.type);

    // Procura o chat pelo external_id original
    let chat;
    try {
      const { data, error } = await supabase
        .from('chats')
        .select('*, customers(*)')
        .eq('channel_id', channel.id)
        .eq('external_id', messageData.externalId)
        .single();

      if (error && error.code !== 'PGRST116') throw error; // PGRST116 é erro de não encontrado
      chat = data;
    } catch (error) {
      Sentry.captureException(error, {
        extra: { channel, messageData, context: 'finding_chat' }
      });
      throw error;
    }

    let customer;
    let isFirstMessage = false;

    if (chat) {
      customer = chat.customers;
    } else {
      isFirstMessage = true;

      try {
        // Obtém todas as variantes possíveis do ID
        const possibleIds = normalizeContactId(messageData.externalId, channel.type);
        
        // Procura customer por qualquer uma das variantes
        const { data: existingCustomer, error: findError } = await supabase
          .from('customers')
          .select('*')
          .eq('organization_id', organization.id)
          .in(identifierColumn, possibleIds)
          .single();

        if (findError && findError.code !== 'PGRST116') throw findError;

        if (existingCustomer) {
          customer = existingCustomer;
        } else {
          // Tenta criar novo customer
          try {
            const customerData = {
              organization_id: organization.id,
              name: messageData.externalName || messageData.externalId,
              ...(messageData.externalProfilePicture && { profile_picture: messageData.externalProfilePicture }),
              [identifierColumn]: possibleIds[0]
            };

            const { data: newCustomer, error: createError } = await supabase
              .from('customers')
              .insert(customerData)
              .select()
              .single();

            if (createError) throw createError;
            customer = newCustomer;
          } catch (error) {
            Sentry.captureException(error, {
              extra: { channel, messageData, context: 'creating_customer' }
            });
            throw error;
          }
        }
      } catch (error) {
        Sentry.captureException(error, {
          extra: { channel, messageData, context: 'finding_customer' }
        });
        throw error;
      }

      // Tenta criar novo chat
      try {
        chat = await createChat({
          organization_id: organization.id,
          customer_id: customer.id,
          channel_id: channel.id,
          external_id: messageData.externalId,
          status: 'pending',
          ...(messageData.externalProfilePicture && { profile_picture: messageData.externalProfilePicture }),
        });

        if (!chat) throw new Error('Failed to create chat');
      } catch (error) {
        Sentry.captureException(error, {
          extra: { channel, messageData, context: 'creating_chat' }
        });
        throw error;
      }
    }

    // Verifica se a mensagem já existe quando for messageSent
    if (messageData.event === 'messageSent' && messageData.fromMe) {
      const { data: existingMessage, error: findMessageError } = await supabase
        .from('messages')
        .select('*')
        .eq('external_id', messageData.messageId)
        .single();

      if (findMessageError && findMessageError.code !== 'PGRST116') throw findMessageError;

      if (existingMessage) {
        // Atualiza apenas o status da mensagem existente
        const { error: updateError } = await supabase
          .from('messages')
          .update({ status: 'sent' })
          .eq('id', existingMessage.id);

        if (updateError) throw updateError;
        return; // Encerra a função pois não precisa criar nova mensagem
      }
    }

    // Cadastra a mensagem recebida (caso não exista)
    const { data: message, error: messageError } = await supabase
      .from('messages')
      .insert({
        chat_id: chat.id,
        organization_id: organization.id,
        content: messageData.message.content,
        type: messageData.message.type,
        sender_type: messageData.fromMe ? 'agent' : 'customer',
        status: messageData.fromMe ? 'sent' : 'delivered',
        external_id: messageData.messageId,
        ...(messageData.fromMe 
          ? {}
          : { sender_customer_id: customer.id }
        ),
        metadata: messageData.message.raw
      })
      .select()
      .single();

    if (messageError) throw messageError;

    // Atualiza o last_message_id do chat
    const { error: updateError } = await supabase
      .from('chats')
      .update({ last_message_id: message.id })
      .eq('id', chat.id);

    if (updateError) throw updateError;

    const flowEngine = createFlowEngine(organization, channel, customer, chat.id, {
      isFirstMessage,
      lastMessage: message
    });

    await flowEngine.processMessage({
      content: messageData.message.content,
      type: messageData.message.type,
      metadata: messageData.message.raw
    });

    transaction.finish();
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channel,
        messageData
      }
    });
    console.error('Error handling incoming message:', error);
    throw error;
  }
}

export async function handleStatusUpdate(channel, messageData) {
  try {
    // Start a new transaction for error tracking
    const transaction = Sentry.startTransaction({
      name: 'handle-status-update',
      op: 'message.status',
      data: {
        channelType: channel.type,
        status: messageData.status
      }
    });

    // Update message status based on webhook data
    const { data: message } = await supabase
      .from('messages')
      .select('*')
      .eq('metadata->messageId', messageData.messageId)
      .single();

    if (message) {
      await supabase
        .from('messages')
        .update({
          status: messageData.status,
          error_message: messageData.error
        })
        .eq('id', message.id);
    }

    // Finish the transaction
    transaction.finish();
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channel,
        messageData
      }
    });
    console.error('Error handling status update:', error);
    throw error;
  }
}

/**
 * Inicia subscription para processar mensagens do sistema
 */
export async function initSystemMessageSubscription() {
  try {
    const subscription = supabase
      .channel('system-messages')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: 'sent_from_system=eq.true'
        },
        async (payload) => {
          const message = payload.new;
          
          try {
            // Busca dados do chat e do canal
            const { data: chat, error: chatError } = await supabase
              .from('chats')
              .select(`
                external_id,
                channel:chat_channels!chats_channel_id_fkey (
                  *,
                  organization:organizations(*)
                )
              `)
              .eq('id', message.chat_id)
              .single();

            if (chatError) throw chatError;
            
            const channelConfig = CHANNEL_CONFIG[chat.channel.type];
            if (!channelConfig) {
              throw new Error(`Handler não encontrado para o canal tipo: ${chat.channel.type}`);
            }

            const transaction = Sentry.startTransaction({
              name: 'process-system-message',
              op: 'message.system',
              data: {
                channelType: chat.channel.type,
                organizationId: chat.channel.organization_id
              }
            });

            // Usa o handler específico do canal
            const result = await channelConfig.handler(chat.channel, {
              messageId: message.id,
              content: message.content,
              type: message.type,
              attachments: message.attachments,
              to: chat.external_id
            });

            // Atualiza status da mensagem e external_id
            const { error: updateError } = await supabase
              .from('messages')
              .update({ 
                status: 'sent',
                external_id: result.messageId
              })
              .eq('id', message.id);

            if (updateError) throw updateError;

            transaction.finish();
          } catch (error) {
            console.log(error);
            // Atualiza status da mensagem para erro
            await supabase
              .from('messages')
              .update({ 
                status: 'failed',
                error_message: error.message
              })
              .eq('id', message.id);

            Sentry.captureException(error, {
              extra: { 
                message,
                context: 'processing_system_message'
              }
            });
          }
        }
      )
      .subscribe();

    return subscription;
  } catch (error) {
    Sentry.captureException(error, {
      extra: { 
        context: 'system_message_subscription'
      }
    });
    throw error;
  }
}