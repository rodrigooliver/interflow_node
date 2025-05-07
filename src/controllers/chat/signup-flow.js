// Função para iniciar o fluxo de chat e mensagens do signup de forma assíncrona
import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';
import { validateWhatsAppNumber } from '../channels/wapi.js';
import { createFlowEngine } from '../../services/flow-engine.js';

/**
 * Inicia o fluxo de chat para um novo signup
 * Este processo é executado de forma assíncrona após o signup do usuário
 */
export async function startSignupChatFlow({
  organizationId,
  channelId,
  customerData,
  whatsappNumber,
  flowId,
  teamId
}) {
  try {
    if (!channelId || !whatsappNumber) {
      console.log('Canal ou número de WhatsApp não fornecidos para iniciar chat de signup');
      return;
    }

    // Buscar canal
    const { data: channelData, error: channelError } = await supabase
      .from('chat_channels')
      .select('*')
      .eq('id', channelId)
      .single();

    if (channelError) {
      Sentry.captureException(channelError);
      console.error('Erro ao buscar canal:', channelError);
      return;
    }

    // Buscar organização
    const { data: organizationData, error: organizationError } = await supabase
      .from('organizations')
      .select('*')
      .eq('id', organizationId)
      .single();

    if (organizationError) {
      Sentry.captureException(organizationError);
      console.error('Erro ao buscar organização:', organizationError);
      return;
    }

    // Checar se whatsappNumber é um número válido
    const { isValid, data } = await validateWhatsAppNumber(channelData, whatsappNumber);
    if (!isValid || !data.outputPhone) {
      Sentry.captureMessage('Número de WhatsApp inválido:', {
        extra: { whatsappNumber }
      });
      return;
    }

    // Consultar se existe chat ativo para o outputPhone
    let chatData = null;
    const { data: chatDataActive, error: chatErrorActive } = await supabase
      .from('chats')
      .select('*')
      .eq('external_id', data.outputPhone)
      .eq('organization_id', organizationId)
      .in('status', ['pending', 'in_progress', 'await_closing']);

    if (chatErrorActive) {
      Sentry.captureException(chatErrorActive);
      console.error('Erro ao buscar chat ativo:', chatErrorActive);
      return;
    }

    if (chatDataActive && chatDataActive.length > 0) {
      chatData = chatDataActive[0];
    } else {
      // Criar chat do whatsapp
      const { data: chatDataCreate, error: chatError } = await supabase
        .from('chats')
        .insert({
          organization_id: organizationId,
          channel_id: channelId,
          customer_id: customerData.id,
          status: 'pending',
          created_at: new Date().toISOString(),
          arrival_time: new Date().toISOString(),
          team_id: teamId,
          external_id: data.outputPhone
        })
        .select()
        .single();

      if (chatError) {
        Sentry.captureException(chatError);
        console.error('Erro ao criar chat:', chatError);
        return;
      }

      if (chatDataCreate) {
        chatData = chatDataCreate;
      }
    }

    if (chatData) {
      // Cadastrar mensagem do type system
      const { error: messageError } = await supabase
        .from('messages')
        .insert({
          chat_id: chatData.id,
          type: 'text',
          organization_id: organizationId,
          sender_type: 'system',
          status: 'sent',
          content: '### CLIENTE SE REGISTROU PARA TESTAR A DEMONSTRAÇÃO ###',
          created_at: new Date().toISOString(),
          sent_from_system: false
        });

      if (messageError) {
        Sentry.captureException(messageError);
        console.error('Erro ao cadastrar mensagem do tipo system:', messageError);
        return;
      }

      // Iniciar fluxo
      if (flowId) {
        // Buscar fluxo
        const { data: flow, error: flowError } = await supabase
          .from('flows')
          .select('*')
          .eq('id', flowId)
          .eq('organization_id', organizationId)
          .single();

        if (flowError) {
          Sentry.captureException(flowError);
          console.error('Erro ao buscar fluxo:', flowError);
          return;
        }

        if (flow) {
          //Pausar algum fluxo ativo
          const { error: pauseError } = await supabase
            .from('flow_sessions')
            .update({ status: 'inactive' })
            .eq('chat_id', chatData.id);
            
            
          // Criar engine de fluxo
          const flowEngine = createFlowEngine(
            organizationData, 
            channelData, 
            customerData, 
            chatData.id, 
            { isFirstMessage: false }
          );

          // Iniciar fluxo
          const session = await flowEngine.processMessage({ content: '', type: '' }, flow);
          if (session) {
            // Atualizar chat com o ID da sessão do fluxo
            const { error: updateError } = await supabase
              .from('chats')
              .update({ flow_session_id: session.id })
              .eq('id', chatData.id);

            if (updateError) {
              Sentry.captureException(updateError);
              console.error('Erro ao atualizar chat com o ID da sessão do fluxo:', updateError);
            }
          }
        }
      }
    }

    return true;
  } catch (error) {
    Sentry.captureException(error);
    console.error('Erro ao iniciar fluxo de chat do signup:', error);
    return false;
  }
} 