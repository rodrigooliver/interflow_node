import { supabase } from '../lib/supabase.js';
import Sentry from '../lib/sentry.js';

/**
 * Cria um motor de fluxo para gerenciar conversas automatizadas
 * @param {Object} organization - Organização atual
 * @param {Object} channel - Canal de comunicação
 * @param {Object} customer - Cliente
 * @param {string} chatId - ID do chat
 */
export const createFlowEngine = (organization, channel, customer, chatId) => {
  /**
   * Processa cada mensagem recebida, gerenciando o fluxo ativo e o sistema de debounce
   * @param {Object} message - Mensagem a ser processada
   */
  const processMessage = async (message) => {
    try {
      let activeFlow = await getActiveFlow();

      if (!activeFlow) {
        const flow = await findMatchingFlow(message);
        if (flow) {
          activeFlow = await startFlow(flow);
        }
      }

      if (activeFlow) {
        // Verificar se está dentro do período de debounce
        const now = new Date();
        const debounceTime = activeFlow.flow?.debounce_time || 1000; // em milissegundos
        
        if (activeFlow.debounce_timestamp && 
            now.getTime() - new Date(activeFlow.debounce_timestamp).getTime() < debounceTime) {
          // Adicionar mensagem ao histórico temporário
          await updateMessageHistory(activeFlow.id, {
            content: message.content,
            type: message.type,
            timestamp: now
          });
          return; // Aguardar próxima mensagem
        }

        // Se chegou aqui, o período de debounce acabou
        // Processar todas as mensagens acumuladas
        const messages = activeFlow.message_history || [];
        messages.push({
          content: message.content,
          type: message.type,
          timestamp: now
        });

        // Atualizar timestamp do debounce
        await updateSession(activeFlow.id, {
          debounce_timestamp: now
        });

        // Processar mensagens acumuladas
        const combinedMessage = {
          content: messages.map(m => m.content).join('\n'),
          type: message.type,
          metadata: { ...message.metadata, original_messages: messages }
        };

        await continueFlow(activeFlow, combinedMessage);

        // Limpar histórico após processamento
        await clearMessageHistory(activeFlow.id);
      }
    } catch (error) {
      Sentry.captureException(error);
      throw error;
    }
  };

  /**
   * Busca um fluxo ativo para o cliente atual no chat específico
   * @returns {Object|null} Fluxo ativo ou null
   */
  const getActiveFlow = async () => {
    const { data, error } = await supabase
      .from('flow_sessions')
      .select(`
        *,
        flow:bot_id (
          id,
          nodes,
          edges,
          variables
        )
      `)
      .eq('customer_id', customer.id)
      .eq('chat_id', chatId)
      .eq('status', 'active')
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  };

  /**
   * Encontra um fluxo compatível com base na mensagem e organização
   * Verifica os triggers disponíveis para determinar qual fluxo deve ser iniciado
   * @param {Object} message - Mensagem recebida
   * @returns {Object|null} Fluxo compatível ou null
   */
  const findMatchingFlow = async (message) => {
    try {
      // Utiliza a função checkTriggers para encontrar um fluxo adequado
      const matchingFlow = await checkTriggers(organization, channel, customer);
      return matchingFlow;
    } catch (error) {
      Sentry.captureException(error);
      throw error;
    }
  };

  /**
   * Inicia um novo fluxo, começando pelo nó inicial
   * @param {Object} flow - Fluxo a ser iniciado
   */
  const startFlow = async (flow) => {
    // Encontrar o nó inicial (geralmente do tipo 'start')
    const startNode = flow.nodes.find(node => node.type === 'start');
    if (!startNode) throw new Error('Flow must have a start node');

    const { data: session, error } = await supabase
      .from('flow_sessions')
      .insert({
        bot_id: flow.id,
        chat_id: chatId,
        customer_id: customer.id,
        organization_id: organization.id,
        status: 'active',
        current_node_id: startNode.id,
        variables: {},
        message_history: []
      })
      .select()
      .single();

    if (error) throw error;
    return session;
  };

  /**
   * Continua a execução do fluxo, processando nós e avançando para o próximo
   * @param {Object} session - Sessão atual
   * @param {Object} message - Mensagem recebida
   */
  const continueFlow = async (session, message) => {
    try {
      const currentNode = session.flow.nodes.find(n => n.id === session.current_node_id);
      if (!currentNode) throw new Error('Current node not found');
      
      if (currentNode.type === 'input') {
        await processInputNode(session, currentNode, message);
      }

      let nextNode = await getNextNode(session.flow, currentNode, message);
      while (nextNode && nextNode.type !== 'input') {
        await executeNode(session, nextNode);
        nextNode = await getNextNode(session.flow, nextNode, message);
      }

      if (nextNode) {
        const timeout = nextNode.data?.inputConfig?.timeout || 5;
        await updateSession(session.id, {
          current_node_id: nextNode.id,
          input_type: nextNode.data?.inputType || 'text',
          timeout_at: new Date(Date.now() + timeout * 60 * 1000),
          last_interaction: new Date()
        });
        await executeNode(session, nextNode);
      } else {
        await updateSession(session.id, {
          status: 'inactive'
        });
      }
    } catch (error) {
      Sentry.captureException(error);
      throw error;
    }
  };

  /**
   * Executa um nó específico baseado em seu tipo (texto, input, condição, etc)
   * @param {Object} session - Sessão atual
   * @param {Object} node - Nó a ser executado
   */
  const executeNode = async (session, node) => {
    switch (node.type) {
      case 'text':
        await sendMessage(node.data.content);
        break;
        
      case 'input':
        await sendMessage(node.data.question || 'Por favor, responda:');
        break;
        
      case 'condition':
        // Implementar lógica de condição usando variáveis da sessão
        break;
        
      case 'delay':
        await processDelay(node.data.delaySeconds);
        break;
        
      case 'openai':
        await processOpenAI(node, session);
        break;
        
      case 'update_customer':
        await updateCustomer(node.data);
        break;
    }

    // Atualizar histórico de mensagens
    await updateMessageHistory(session.id, node);
  };

  /**
   * Processa nós de entrada, salvando respostas e variáveis
   * @param {Object} session - Sessão atual
   * @param {Object} node - Nó de input
   * @param {Object} message - Mensagem recebida
   */
  const processInputNode = async (session, node, message) => {
    const updates = {
      last_interaction: new Date()
    };

    if (node.data.inputType === 'options') {
      const validOption = node.data.options?.find(
        opt => opt.text.toLowerCase() === message.content.toLowerCase()
      );
      if (validOption) {
        updates.selected_option = validOption;
      }
    }

    if (node.data.variableName) {
      updates.variables = {
        ...session.variables,
        [node.data.variableName]: message.content
      };
    }

    await updateSession(session.id, updates);
  };

  /**
   * Determina qual é o próximo nó baseado nas conexões e condições
   * @param {Object} flow - Fluxo atual
   * @param {Object} currentNode - Nó atual
   * @param {Object} message - Mensagem recebida
   */
  const getNextNode = async (flow, currentNode, message) => {
    const edges = flow.edges.filter(edge => edge.source === currentNode.id);
    
    if (!edges.length) return null;

    // Se for nó de opções, encontrar a conexão correta
    if (currentNode.type === 'input' && currentNode.data.inputType === 'options') {
      const selectedEdge = edges.find(edge => 
        edge.sourceHandle === `option-${message.content.toLowerCase()}`
      );
      if (selectedEdge) {
        return flow.nodes.find(n => n.id === selectedEdge.target);
      }
      // Retornar nó de "no-match" se existir
      const noMatchEdge = edges.find(edge => edge.sourceHandle === 'no-match');
      if (noMatchEdge) {
        return flow.nodes.find(n => n.id === noMatchEdge.target);
      }
    }

    // Para outros tipos de nó, usar primeira conexão
    return flow.nodes.find(n => n.id === edges[0].target);
  };

  /**
   * Atualiza o estado da sessão do fluxo
   * @param {string} sessionId - ID da sessão
   * @param {Object} updates - Atualizações a serem aplicadas
   */
  const updateSession = async (sessionId, updates) => {
    const { error } = await supabase
      .from('flow_sessions')
      .update({
        ...updates,
        updated_at: new Date()
      })
      .eq('id', sessionId);

    if (error) throw error;
  };

  /**
   * Adiciona mensagens ao histórico da sessão
   * @param {string} sessionId - ID da sessão
   * @param {Object} message - Mensagem a ser adicionada
   */
  const updateMessageHistory = async (sessionId, message) => {
    const { data: session, error: fetchError } = await supabase
      .from('flow_sessions')
      .select('message_history')
      .eq('id', sessionId)
      .single();

    if (fetchError) throw fetchError;

    const { error: updateError } = await supabase
      .from('flow_sessions')
      .update({
        message_history: [...session.message_history, message]
      })
      .eq('id', sessionId);

    if (updateError) throw updateError;
  };

  /**
   * Limpa o histórico de mensagens da sessão
   * @param {string} sessionId - ID da sessão
   */
  const clearMessageHistory = async (sessionId) => {
    const { error } = await supabase
      .from('flow_sessions')
      .update({
        message_history: []
      })
      .eq('id', sessionId);

    if (error) throw error;
  };

  /**
   * Envia uma mensagem para o cliente
   * @param {string} content - Conteúdo da mensagem
   */
  const sendMessage = async (content) => {
    const { error } = await supabase
      .from('messages')
      .insert({
        chat_id: chatId,
        organization_id: organization.id,
        customer_id: customer.id,
        channel_id: channel.id,
        direction: 'outbound',
        content,
        type: 'text',
        status: 'pending'
      });

    if (error) throw error;
  };

  /**
   * Implementa delays entre mensagens
   * @param {number} seconds - Segundos de delay
   */
  const processDelay = async (seconds) => {
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  };

  /**
   * Integração com OpenAI (a ser implementado)
   */
  const processOpenAI = async (node, session) => {
    // Implementar integração com OpenAI
  };

  /**
   * Atualização de dados do cliente (a ser implementado)
   */
  const updateCustomer = async (data) => {
    // Implementar atualização do cliente
  };

  /**
   * Verifica se o horário atual está dentro dos slots de tempo configurados
   * @param {Object} timeConfig - Configuração de tempo com timezone e slots
   * @returns {boolean} - Verdadeiro se estiver dentro do horário permitido
   */
  const isWithinScheduleTime = (timeConfig) => {
    if (!timeConfig?.timeSlots?.length) return true;

    const now = new Date();
    // Converter para o timezone especificado
    const timeInZone = new Date(now.toLocaleString('en-US', { timeZone: timeConfig.timezone }));
    const currentDay = timeInZone.getDay();
    const currentTime = timeInZone.toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit' 
    });
    
    // Verificar todos os slots do dia atual
    const todaySlots = timeConfig.timeSlots.filter(slot => slot.day === currentDay);
    
    // Verificar se o horário atual está dentro de qualquer um dos slots do dia
    return todaySlots.some(slot => 
      currentTime >= slot.startTime && currentTime <= slot.endTime
    );
  };

  /**
   * Verifica todos os gatilhos disponíveis para uma organização
   * @param {Object} organization - Organização
   * @param {Object} channel - Canal
   * @param {Object} customer - Cliente
   */
  const checkTriggers = async (organization, channel, customer) => {
    const { data: flows } = await supabase
      .from('flow_triggers')
      .select(`
        id,
        type,
        is_active,
        conditions,
        flow:flows!inner(
          *
        )
      `)
      .eq('type', 'first_message')
      .eq('is_active', true)
      .eq('flows.organization_id', organization.id)
      .eq('flows.is_active', true)
      .eq('flows.is_published', true);

    for (const flow of flows) {
      // Encontrar a regra de canal
      const channelRule = flow.conditions.rules.find(rule => rule.type === 'channel');
      if (!channelRule) continue;

      // Verificar se o canal está na lista de canais permitidos
      const channelList = channelRule.params.channels || [];
      const isChannelAllowed = channelList.length === 0 || channelList.includes(channel.id);
      if (!isChannelAllowed) continue;

      // Encontrar e verificar regra de schedule, se existir
      const scheduleRule = flow.conditions.rules.find(rule => rule.type === 'schedule');
      if (scheduleRule) {
        const isWithinSchedule = isWithinScheduleTime(scheduleRule.params);
        if (!isWithinSchedule) continue;
      }

      // Verificar se é o primeiro contato
      const isFirstMessage = await checkFirstMessage(customer.id, channel.id);
      if (!isFirstMessage) continue;

      return flow.flow;
    }

    return null;
  };

  // Adicionar nova função auxiliar
  const checkFirstMessage = async (customerId, channelId) => {
    const { count } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', customerId)
      .eq('channel_id', channelId);

    return count === 0;
  };

  /**
   * Busca um chat ativo para um cliente em um canal específico
   * @param {string} channelId - ID do canal
   * @param {string} customerId - ID do cliente
   */
  const findActiveChat = async (channelId, customerId) => {
    const { data } = await supabase
      .from('chats')
      .select('*')
      .eq('channel_id', channelId)
      .eq('customer_id', customerId)
      .eq('status', 'in_progress')
      .single();
    
    return data;
  };

  return {
    processMessage,
    getActiveFlow,
    findMatchingFlow,
    startFlow,
    continueFlow,
    executeNode,
    processInputNode,
    getNextNode,
    updateSession,
    sendMessage,
    processDelay,
    processOpenAI,
    updateCustomer,
    checkTriggers,
    findActiveChat
  };
}; 