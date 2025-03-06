import { supabase } from '../lib/supabase.js';
import Sentry from '../lib/sentry.js';
import { OpenAI } from 'openai';
import { createMessageToSend } from '../controllers/chat/message-handlers.js';

/**
 * Cria um motor de fluxo para gerenciar conversas automatizadas
 * @param {Object} organization - Organização atual
 * @param {Object} channel - Canal de comunicação
 * @param {Object} customer - Cliente
 * @param {string} chatId - ID do chat
 * @param {Object} options - Opções adicionais
 */
export const createFlowEngine = (organization, channel, customer, chatId, options = {}) => {
  const { isFirstMessage, lastMessage } = options;

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

      // console.log('Active Flow:', activeFlow);

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
        flow:flows!flow_sessions_bot_id_fkey (
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
    const startNode = flow.nodes.find(node => node.id === 'start-node');
    if (!startNode) return null;

    try {
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
      .select(`
        *,
        flow:flows!flow_sessions_bot_id_fkey (
          id,
          nodes,
          edges,
          variables
        )
      `)
      .single();

      if (error) throw error;
      return session;
    } catch (error) {
      Sentry.captureException(error);
      throw error;
    }
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
        await sendMessage(node.data.text);
        break;
        
      case 'input':
        await sendMessage(node.data.question || 'Por favor, responda:');
        break;
        
      case 'condition':
        await processCondition(node.data, session);
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
   * Processa condições, avaliando-as e atualizando o fluxo
   * @param {Object} condition - Condição a ser processada
   * @param {Object} session - Sessão atual
   */
  const processCondition = async (condition, session) => {
    try {
      const { logicOperator, subConditions } = condition;
      
      // Avaliar cada subcondição
      const results = await Promise.all(
        subConditions.map(sub => evaluateSubCondition(sub, session))
      );
      
      // Aplicar operador lógico aos resultados
      const isConditionMet = logicOperator === 'AND' 
        ? results.every(r => r)
        : results.some(r => r);

      if (isConditionMet) {
        // Encontrar a edge correspondente à condição
        const conditionIndex = condition.conditions.indexOf(condition);
        const edge = session.flow.edges.find(e => e.sourceHandle === `condition-${conditionIndex}`);
        
        if (edge) {
          await updateSession(session.id, {
            current_node_id: edge.target
          });
        }
      } else {
        // Se nenhuma condição for atendida, usar o else
        const elseEdge = session.flow.edges.find(e => e.sourceHandle === 'else');
        if (elseEdge) {
          await updateSession(session.id, {
            current_node_id: elseEdge.target
          });
        }
      }
    } catch (error) {
      Sentry.captureException(error);
      throw error;
    }
  };

  /**
   * Avalia uma subcondição baseada nos critérios fornecidos
   * @param {Object} subCondition - Subcondição a ser avaliada
   * @param {Object} session - Sessão atual
   * @returns {boolean} - Verdadeiro se a subcondição for atendida
   */
  const evaluateSubCondition = async (subCondition, session) => {
    const { type, field, operator, value } = subCondition;
    let fieldValue;

    // Buscar valor do campo apropriado
    if (type === 'variable') {
      fieldValue = session.variables[field];
    } else if (type === 'clientData') {
      fieldValue = await getClientDataValue(field, session);
    }

    // Se o campo não existir, retornar false
    if (fieldValue === undefined) return false;

    // Avaliar baseado no operador
    switch (operator) {
      case 'equalTo':
        return fieldValue === value;
        
      case 'notEqual':
        return fieldValue !== value;
        
      case 'contains':
        return String(fieldValue).toLowerCase().includes(String(value).toLowerCase());
        
      case 'doesNotContain':
        return !String(fieldValue).toLowerCase().includes(String(value).toLowerCase());
        
      case 'greaterThan':
        return Number(fieldValue) > Number(value);
        
      case 'lessThan':
        return Number(fieldValue) < Number(value);
        
      case 'isSet':
        return fieldValue !== null && fieldValue !== undefined && fieldValue !== '';
        
      case 'isEmpty':
        return fieldValue === null || fieldValue === undefined || fieldValue === '';
        
      case 'startsWith':
        return String(fieldValue).toLowerCase().startsWith(String(value).toLowerCase());
        
      case 'endsWith':
        return String(fieldValue).toLowerCase().endsWith(String(value).toLowerCase());
        
      case 'matchesRegex':
        try {
          const regex = new RegExp(value);
          return regex.test(String(fieldValue));
        } catch {
          return false;
        }
        
      case 'doesNotMatchRegex':
        try {
          const regex = new RegExp(value);
          return !regex.test(String(fieldValue));
        } catch {
          return false;
        }
        
      case 'inList':
        const valueList = String(value).split(',').map(v => v.trim().toLowerCase());
        if (Array.isArray(fieldValue)) {
          return fieldValue.some(v => valueList.includes(String(v).toLowerCase()));
        }
        return valueList.includes(String(fieldValue).toLowerCase());
        
      case 'notInList':
        const excludeList = String(value).split(',').map(v => v.trim().toLowerCase());
        if (Array.isArray(fieldValue)) {
          return !fieldValue.some(v => excludeList.includes(String(v).toLowerCase()));
        }
        return !excludeList.includes(String(fieldValue).toLowerCase());
        
      default:
        return false;
    }
  };

  /**
   * Busca um valor de dados do cliente ou do chat
   * @param {string} field - Campo a ser buscado
   * @param {Object} session - Sessão atual
   * @returns {any} - Valor do campo buscado
   */
  const getClientDataValue = async (field, session) => {
    try {
      // Buscar dados do cliente
      if (field.startsWith('custumer_')) {
        const { data: customer } = await supabase
          .from('customers')
          .select('*')
          .eq('id', session.customer_id)
          .single();
          
        const customerField = field.replace('custumer_', '');
        return customer?.[customerField];
      }
      
      // Buscar dados do chat
      if (field.startsWith('chat_')) {
        const { data: chat } = await supabase
          .from('chats')
          .select(`
            *,
            team:team_id(*),
            assigned_agent:assigned_to(*)
          `)
          .eq('id', session.chat_id)
          .single();
          
        switch (field) {
          case 'chat_funil':
            return chat?.funnel_id;
            
          case 'chat_price':
            return chat?.sale_value;
            
          case 'chat_team':
            return chat?.team?.id;
            
          case 'chat_attendant':
            return chat?.assigned_agent?.id;
            
          case 'chat_tag':
            return chat?.tags;
            
          default:
            return null;
        }
      }
      
      return null;
    } catch (error) {
      Sentry.captureException(error);
      return null;
    }
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

    // Se for nó de condição
    if (currentNode.type === 'condition') {
      for (const condition of currentNode.data.conditions || []) {
        const isConditionMet = await evaluateCondition(condition, session);
        
        // Encontrar a edge correspondente à condição
        const conditionIndex = currentNode.data.conditions.indexOf(condition);
        const edge = edges.find(e => e.sourceHandle === `condition-${conditionIndex}`);
        
        if (isConditionMet && edge) {
          return flow.nodes.find(n => n.id === edge.target);
        }
      }
      
      // Se nenhuma condição for atendida, usar o else
      const elseEdge = edges.find(e => e.sourceHandle === 'else');
      if (elseEdge) {
        return flow.nodes.find(n => n.id === elseEdge.target);
      }
    }

    // Se for nó de opções, encontrar a conexão correta
    if (currentNode.type === 'input' && currentNode.data.inputType === 'options') {
      // Procurar uma opção que corresponda exatamente ao texto da mensagem
      const matchingOptionIndex = currentNode.data.options.findIndex(option => 
        option.text.toLowerCase().trim() === message.content.toLowerCase().trim()
      );

      if (matchingOptionIndex !== -1) {
        // Procurar edge correspondente à opção encontrada
        const selectedEdge = edges.find(edge => 
          edge.sourceHandle === `option${matchingOptionIndex}`
        );
        if (selectedEdge) {
          return flow.nodes.find(n => n.id === selectedEdge.target);
        }
      }

      // Se não encontrou correspondência exata, usar o handle 'no-match'
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
  const sendMessage = async (content, sessionId) => {
    try {
      if(content) {
        const result = await createMessageToSend(chatId, organization.id, content, null, null, null);
          if (result.status !== 201) throw new Error(result.error);
      } else {
        console.log('Não há conteúdo para enviar');
      }

    } catch (error) {
      Sentry.captureException(error);
      throw error;
    }
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
    try {
      const config = node.data.openai;
      if (!config) throw new Error('OpenAI configuration not found');

      // Buscar integração do OpenAI
      const { data: integration } = await supabase
        .from('integrations')
        .select('*')
        .eq('id', config.integrationId)
        .single();

      if (!integration) throw new Error('OpenAI integration not found');

      // Configurar cliente OpenAI
      const openai = new OpenAI({
        apiKey: integration.credentials.apiKey
      });

      let response;
      switch (config.apiType) {
        case 'textGeneration':
          response = await handleTextGeneration(openai, config, session);
          break;
        case 'audioGeneration':
          response = await handleAudioGeneration(openai, config, session);
          break;
        case 'textToSpeech':
          response = await handleTextToSpeech(openai, config, session);
          break;
        default:
          throw new Error(`Unsupported API type: ${config.apiType}`);
      }

      // Salvar resposta na variável especificada
      if (config.variableName) {
        await updateSession(session.id, {
          variables: {
            ...session.variables,
            [config.variableName]: response
          }
        });
      }

      // Se houver uma resposta de texto, enviar como mensagem
      if (typeof response === 'string') {
        await sendMessage(response, session.id);
      }

      return response;
    } catch (error) {
      Sentry.captureException(error);
      throw error;
    }
  };

  const handleTextGeneration = async (openai, config, session) => {
    // Preparar mensagens do contexto
    const messages = await prepareContextMessages(config, session);

    // Preparar ferramentas se existirem
    const tools = prepareTools(config.tools);

    // Fazer chamada para o OpenAI
    const completion = await openai.chat.completions.create({
      model: config.model,
      messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? "auto" : undefined
    });

    // Processar resposta
    const choice = completion.choices[0];
    
    // Se houver chamadas de ferramentas
    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        const tool = config.tools.find(t => t.name === toolCall.function.name);
        if (tool && tool.targetNodeId) {
          // Extrair argumentos da chamada
          const args = JSON.parse(toolCall.function.arguments);
          
          // Atualizar variáveis com os argumentos
          for (const [key, value] of Object.entries(args)) {
            await updateSession(session.id, {
              variables: {
                ...session.variables,
                [key]: value
              }
            });
          }

          // Redirecionar para o nó alvo da ferramenta
          await updateSession(session.id, {
            current_node_id: tool.targetNodeId
          });
        }
      }
      return null; // Retorna null pois o fluxo será redirecionado
    }

    return choice.message.content;
  };

  const prepareContextMessages = async (config, session) => {
    const messages = [];

    // Adicionar prompt do sistema
    if (config.promptType === 'select' && config.promptId) {
      const { data: prompt } = await supabase
        .from('prompts')
        .select('content')
        .eq('id', config.promptId)
        .single();
      
      if (prompt) {
        messages.push({
          role: 'system',
          content: prompt.content
        });
      }
    } else if (config.promptType === 'custom' && config.customPrompt) {
      messages.push({
        role: 'system',
        content: config.customPrompt
      });
    }

    // Adicionar mensagens do contexto
    if (config.messageType === 'chatMessages') {
      // Buscar apenas mensagens do chat atual
      const { data: chatMessages } = await supabase
        .from('messages')
        .select('*')
        .eq('chat_id', session.chat_id)
        .order('created_at', { ascending: true });

      chatMessages?.forEach(msg => {
        messages.push({
          role: msg.direction === 'inbound' ? 'user' : 'assistant',
          content: msg.content
        });
      });
    } else if (config.messageType === 'allClientMessages') {
      // Buscar todas as mensagens do cliente neste canal
      const { data: allMessages } = await supabase
        .from('messages')
        .select('*')
        .eq('customer_id', session.customer_id)
        .eq('channel_id', session.channel_id)
        .order('created_at', { ascending: true });

      allMessages?.forEach(msg => {
        messages.push({
          role: msg.direction === 'inbound' ? 'user' : 'assistant',
          content: msg.content
        });
      });
    }

    return messages;
  };

  const prepareTools = (tools = []) => {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
  };

  const handleAudioGeneration = async (openai, config, session) => {
    // Implementar lógica para geração de áudio
    throw new Error('Audio generation not implemented yet');
  };

  const handleTextToSpeech = async (openai, config, session) => {
    // Implementar lógica para text-to-speech
    throw new Error('Text to speech not implemented yet');
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
    try {
      const { data: flows, error: flowsError } = await supabase
      .from('flow_triggers')
      .select(`
        id,
        type,
        is_active,
        conditions,
        flow:flows!flow_triggers_flow_id_fkey(
          *
        )
      `)
      .eq('type', 'first_contact')
      .eq('is_active', true)
      .eq('flows.organization_id', organization.id)
      .eq('flows.is_active', true)
      .eq('flows.is_published', true);

      if(flowsError) throw flowsError;
      if(flows.length === 0) return null;

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

        // Usar a informação de primeira mensagem que veio como propriedade
        if (!isFirstMessage) continue;

        return flow.flow;
      }

      return null;
    } catch (error) {
      console.log('Error:', error);
      Sentry.captureException(error);
      throw error;
    }
    
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