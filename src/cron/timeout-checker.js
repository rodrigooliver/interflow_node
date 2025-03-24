import * as Sentry from '@sentry/node';
import { createFlowEngine } from '../services/flow-engine.js';
import { supabase } from '../lib/supabase.js';

/**
 * Função principal que verifica e processa sessões com timeout
 */
export const checkTimeouts = async () => {
  const transaction = Sentry.startTransaction({
    name: 'checkTimeouts',
  });

  try {
    const now = new Date();
    
    // Busca todas as sessões ativas com timeout_at no passado
    const { data: sessions, error } = await supabase
      .from('flow_sessions')
      .select(`
        *,
        flow:flows!flow_sessions_bot_id_fkey (
          id,
          nodes,
          edges,
          variables
        ),
        chat:chats!flow_sessions_chat_id_fkey (
          id,
          channel_id
        ),
        customer:customers!flow_sessions_customer_id_fkey (
          id
        ),
        organization:organizations!flow_sessions_organization_id_fkey (
          id,
          name
        )
      `)
      .eq('status', 'active')
      .lt('timeout_at', new Date().toISOString())
      .not('timeout_at', 'is', null);
    
    if (error) {
      Sentry.withScope((scope) => {
        scope.setExtra('error', error);
        scope.setTag('operation', 'fetch_sessions');
        Sentry.captureException(error);
      });
      throw error;
    }
    
    if (!sessions || sessions.length === 0) {
      return;
    }

    Sentry.setTag('sessions_count', sessions.length);
    
    // Processa cada sessão
    for (const session of sessions) {
      try {
        // Busca o canal
        const { data: channel, error: channelError } = await supabase
          .from('chat_channels')
          .select('*')
          .eq('id', session.chat.channel_id)
          .single();
        
        if (channelError) {
          Sentry.withScope((scope) => {
            scope.setExtra('session_id', session.id);
            scope.setExtra('channel_id', session.chat.channel_id);
            scope.setExtra('error', channelError);
            scope.setTag('operation', 'fetch_channel');
            Sentry.captureException(channelError);
          });
          throw channelError;
        }
        
        // Cria o flow engine para esta sessão específica
        const flowEngine = createFlowEngine(
          session.organization,
          channel,
          session.customer,
          session.chat_id
        );
        
        // Processa o timeout para esta sessão específica
        await flowEngine.handleSessionTimeout(session);
        
      } catch (sessionError) {
        Sentry.withScope((scope) => {
          scope.setExtra('session_id', session.id);
          scope.setExtra('organization_id', session.organization.id);
          scope.setExtra('chat_id', session.chat_id);
          scope.setTag('operation', 'process_session_timeout');
          Sentry.captureException(sessionError);
        });
        console.error(`Erro ao processar timeout para a sessão ${session.id}:`, sessionError);
      }
    }
    
  } catch (error) {
    Sentry.withScope((scope) => {
      scope.setTag('operation', 'check_timeouts');
      Sentry.captureException(error);
    });
    console.error('Erro ao verificar timeouts:', error);
  } finally {
    transaction.finish();
  }
};

// Executa a verificação de timeouts se o arquivo for executado diretamente
if (process.argv[1] === import.meta.url) {
  checkTimeouts()
    .then(() => process.exit(0))
    .catch((error) => {
      Sentry.withScope((scope) => {
        scope.setTag('operation', 'main_execution');
        Sentry.captureException(error);
      });
      console.error('Erro fatal ao verificar timeouts:', error);
      process.exit(1);
    });
} 