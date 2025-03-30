import { supabase } from '../../lib/supabase.js';
import { createFlowEngine } from '../../services/flow-engine.js';
import Sentry from '../../lib/sentry.js';

export const startFlowRoute = async (req, res) => {
  try {
    const { chatId, organizationId } = req.params;
    const { flowId } = req.body;

    // Buscar informações do chat
    const { data: chat, error: chatError } = await supabase
      .from('chats')
      .select(`
        *,
        customer:customers(*),
        channel:chat_channels(*),
        organization:organizations(*)
      `)
      .eq('organization_id', organizationId)
      .eq('id', chatId)
      .single();

    if (chatError) throw chatError;
    if (!chat) {
      return res.status(404).json({ error: 'Chat não encontrado' });
    }

    // Verificar se existe um fluxo ativo e encerrá-lo
    const { error: endSessionError } = await supabase
        .from('flow_sessions')
        .update({ status: 'inactive' })
        .eq('status', 'active')
        .eq('chat_id', chatId);

    if (endSessionError) throw endSessionError;

    // Buscar informações do fluxo
    const { data: flow, error: flowError } = await supabase
      .from('flows')
      .select('*')
      .eq('id', flowId)
      .eq('organization_id', organizationId)
      .single();

    if (flowError) throw flowError;
    if (!flow) {
      return res.status(404).json({ error: 'Fluxo não encontrado' });
    }

    // Criar o motor de fluxo
    const flowEngine = createFlowEngine(
      chat.organization,
      chat.channel,
      chat.customer,
      chatId,
      { isFirstMessage: false }
    );

    // Iniciar o fluxo
    const session = await flowEngine.processMessage({ content: '', type: '' }, flow);

    if (!session) {
      return res.status(400).json({ error: 'Não foi possível iniciar o fluxo' });
    }

    // Atualizar o chat com a referência da sessão do fluxo
    const { error: updateError } = await supabase
      .from('chats')
      .update({
        flow_session_id: session.id
      })
      .eq('id', chatId);

    if (updateError) throw updateError;

    return res.status(200).json({
      success: true,
      session
    });

  } catch (error) {
    console.error('Erro ao iniciar fluxo:', error);
    Sentry.captureException(error);
    return res.status(500).json({ error: 'Erro ao iniciar fluxo' });
  }
}; 