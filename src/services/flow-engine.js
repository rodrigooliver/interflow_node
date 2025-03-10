import { supabase } from '../lib/supabase.js';
import Sentry from '../lib/sentry.js';
import { OpenAI } from 'openai';
import { createMessageToSend, sendSystemMessage } from '../controllers/chat/message-handlers.js';
import crypto from 'crypto';

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
        // Buscar novamente o fluxo ativo para obter o histórico de mensagens atualizado
        activeFlow = await getActiveFlow();

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
      // Garantir que flow.variables seja um array
      const defaultVariables = Array.isArray(flow.variables) 
        ? [...flow.variables] 
        : Object.entries(flow.variables || {}).map(([name, value]) => ({
            id: crypto.randomUUID(),
            name,
            value
          }));

      const { data: session, error } = await supabase
      .from('flow_sessions')
      .insert({
        bot_id: flow.id,
        chat_id: chatId,
        customer_id: customer.id,
        organization_id: organization.id,
        status: 'active',
        current_node_id: startNode.id,
        variables: defaultVariables,
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
      
      let updatedSession = { ...session };
      
      if (currentNode.type === 'input') {
        // Se o cliente respondeu a um nó de input, zeramos o timeout_at
        const initialUpdates = { timeout_at: null };
        await updateSession(session.id, initialUpdates);
        
        // Processa o nó de input e obtém a sessão atualizada com as novas variáveis
        updatedSession = await processInputNode(session, currentNode, message);
      }

      let nextNode = await getNextNode(updatedSession.flow, currentNode, message, updatedSession);

      while (nextNode && nextNode.type !== 'input') {
        // Executa o nó e obtém a sessão atualizada
        updatedSession = await executeNode(updatedSession, nextNode);
        nextNode = await getNextNode(updatedSession.flow, nextNode, message, updatedSession);
      }

      
      if (nextNode) {
        const timeout = nextNode.data?.inputConfig?.timeout || null;
        // Atualiza a sessão no banco de dados
        const sessionWithUpdatedNode = await updateSession(updatedSession.id, {
          current_node_id: nextNode.id,
          input_type: nextNode.data?.inputType || 'text',
          timeout_at: timeout ? new Date(Date.now() + timeout * 60 * 1000).toISOString() : null,
          last_interaction: new Date().toISOString()
        });
        
        // Usa a sessão atualizada para executar o próximo nó
        updatedSession = await executeNode(sessionWithUpdatedNode, nextNode);
      } else {
        // Finaliza o fluxo
        await updateSession(updatedSession.id, {
          status: 'inactive'
        });
      }
    } catch (error) {
      console.log('Error: ', error);
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
    let updatedSession = { ...session };
    
    switch (node.type) {
      case 'text':
        const processedText = replaceVariables(node.data.text, updatedSession.variables);
        
        // Verificar se a opção splitParagraphs está ativada
        if (node.data.splitParagraphs) {
          // Dividir o texto em parágrafos (separados por linhas em branco)
          const paragraphs = processedText
            .split('\n\n')
            .filter(paragraph => paragraph.trim().length > 0);
          
          // Enviar cada parágrafo como uma mensagem separada
          for (const paragraph of paragraphs) {
            await sendMessage(paragraph, null, updatedSession.id);
            
            // Adicionar um pequeno delay entre as mensagens para evitar throttling
            if (paragraphs.length > 1) {
              await processDelay(0.5); // 500ms de delay entre mensagens
            }
          }
        } else {
          // Comportamento padrão: enviar todo o texto como uma única mensagem
          await sendMessage(processedText, null, updatedSession.id);
        }
        break;

      case 'audio':
        // Processa a URL do áudio para substituir variáveis, se houver
        const processedAudioUrl = replaceVariables(node.data.mediaUrl, updatedSession.variables);
        await sendMessage(null, {attachments: [{url: processedAudioUrl, type: 'audio'}]}, updatedSession.id);
        break;

      case 'image':
        // Processa a URL da imagem para substituir variáveis, se houver
        const processedImageUrl = replaceVariables(node.data.mediaUrl, updatedSession.variables);
        await sendMessage(null, {attachments: [{url: processedImageUrl, type: 'image'}]}, updatedSession.id);
        break;

      case 'video':
        // Processa a URL do vídeo para substituir variáveis, se houver
        const processedVideoUrl = replaceVariables(node.data.mediaUrl, updatedSession.variables);
        await sendMessage(null, {attachments: [{url: processedVideoUrl, type: 'video'}]}, updatedSession.id);
        break;

      case 'document':
        // Processa a URL do documento para substituir variáveis, se houver
        const processedDocUrl = replaceVariables(node.data.mediaUrl, updatedSession.variables);
        await sendMessage(null, {attachments: [{url: processedDocUrl, type: 'document'}]}, updatedSession.id);
        break;

      case 'variable':
        // Processa a variável e retorna a sessão atualizada
        updatedSession = await processVariable(node.data, updatedSession);
        break;
        
      case 'delay':
        await processDelay(node.data.delaySeconds);
        break;
        
      case 'openai':
        updatedSession = await processOpenAI(node, updatedSession);
        break;
        
      case 'update_customer':
        updatedSession = await updateCustomer(node.data, updatedSession);
        break;
    }

    // Atualizar histórico de mensagens
    await updateMessageHistory(updatedSession.id, node);
    
    // Retorna a sessão potencialmente atualizada
    return updatedSession;
  };

  /**
   * Processa nós de entrada, salvando respostas e variáveis
   * @param {Object} session - Sessão atual
   * @param {Object} node - Nó de input
   * @param {Object} message - Mensagem recebida
   * @returns {Object} - Sessão atualizada com as novas variáveis
   */
  const processInputNode = async (session, node, message) => {
    const updates = {
      last_interaction: new Date().toISOString()
    };

    if (node.data.inputType === 'options') {
      const validOption = node.data.options?.find(
        opt => opt.text.toLowerCase() === message.content.toLowerCase()
      );
      if (validOption) {
        updates.selected_option = validOption;
      }
    }

    if (message && node.data.inputConfig && node.data.inputConfig.variableName) {
      // Verifica se session.variables é um array ou um objeto e converte para array se necessário
      let variables = [];
      
      if (Array.isArray(session.variables)) {
        variables = [...session.variables];
      } else if (session.variables && typeof session.variables === 'object') {
        // Converte de objeto para array
        variables = Object.entries(session.variables).map(([name, value]) => ({
          id: crypto.randomUUID(),
          name,
          value
        }));
      }
      
      const variableIndex = variables.findIndex(v => v.name === node.data.inputConfig.variableName);
      
      if (variableIndex >= 0) {
        // Atualiza a variável existente
        variables[variableIndex] = {
          ...variables[variableIndex],
          value: message.content
        };
      } else {
        // Cria uma nova variável
        variables.push({
          id: crypto.randomUUID(),
          name: node.data.inputConfig.variableName,
          value: message.content
        });
      }
      
      updates.variables = variables;
    }

    // Atualiza a sessão e retorna a sessão atualizada
    return await updateSession(session.id, updates);
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
      // Verifica se session.variables é um array ou um objeto
      if (Array.isArray(session.variables)) {
        // Encontra a variável no array
        const variable = session.variables.find(v => v.name === field);
        fieldValue = variable ? variable.value : undefined;
      } else if (session.variables && typeof session.variables === 'object') {
        // Acessa diretamente a propriedade do objeto
        fieldValue = session.variables[field];
      }
    } else if (type === 'clientData') {
      fieldValue = await getClientDataValue(field, session);
    }

    // Se o campo não existir, retornar false
    if (fieldValue === undefined) return false;

    // Processar variáveis no valor de comparação, se for string
    let compareValue = value;
    if (typeof value === 'string') {
      compareValue = replaceVariables(value, session.variables);
    }

    // Avaliar baseado no operador
    switch (operator) {
      case 'equalTo':
        return fieldValue === compareValue;
        
      case 'notEqual':
      case 'notEqualTo':
        return fieldValue !== compareValue;
        
      case 'contains':
        return String(fieldValue).toLowerCase().includes(String(compareValue).toLowerCase());
        
      case 'doesNotContain':
      case 'notContains':
        return !String(fieldValue).toLowerCase().includes(String(compareValue).toLowerCase());
        
      case 'greaterThan':
        return Number(fieldValue) > Number(compareValue);
        
      case 'lessThan':
        return Number(fieldValue) < Number(compareValue);
        
      case 'greaterThanOrEqual':
        return Number(fieldValue) >= Number(compareValue);
        
      case 'lessThanOrEqual':
        return Number(fieldValue) <= Number(compareValue);
        
      case 'isSet':
        return fieldValue !== null && fieldValue !== undefined && fieldValue !== '';
        
      case 'isEmpty':
        return fieldValue === null || fieldValue === undefined || fieldValue === '';
        
      case 'startsWith':
        return String(fieldValue).toLowerCase().startsWith(String(compareValue).toLowerCase());
        
      case 'endsWith':
        return String(fieldValue).toLowerCase().endsWith(String(compareValue).toLowerCase());
        
      case 'matchesRegex':
        try {
          const regex = new RegExp(compareValue);
          return regex.test(String(fieldValue));
        } catch {
          return false;
        }
        
      case 'doesNotMatchRegex':
        try {
          const regex = new RegExp(compareValue);
          return !regex.test(String(fieldValue));
        } catch {
          return false;
        }
        
      case 'inList':
        const valueList = String(compareValue).split(',').map(v => v.trim().toLowerCase());
        if (Array.isArray(fieldValue)) {
          return fieldValue.some(v => valueList.includes(String(v).toLowerCase()));
        }
        return valueList.includes(String(fieldValue).toLowerCase());
        
      case 'notInList':
        const excludeList = String(compareValue).split(',').map(v => v.trim().toLowerCase());
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
  const getNextNode = async (flow, currentNode, message, session) => {
    const edges = flow.edges.filter(edge => edge.source === currentNode.id);
    
    if (!edges.length) return null;

    // Se for nó de condição
    if (currentNode.type === 'condition') {

      for (const condition of currentNode.data.conditions || []) {
        const { logicOperator, subConditions } = condition;
        console.log('logicOperator', logicOperator);
        console.log('subConditions', subConditions);

        // Avaliar cada subcondição
        const results = await Promise.all(
          subConditions.map(sub => evaluateSubCondition(sub, session))
        );
          
        // Aplicar operador lógico aos resultados
        const isConditionMet = logicOperator === 'AND' 
          ? results.every(r => r)
          : results.some(r => r);
        
        // Encontrar a edge correspondente à condição
        const conditionIndex = currentNode.data.conditions.indexOf(condition);
        const edge = edges.find(e => e.source === currentNode.id && e.sourceHandle === `condition-${conditionIndex}`);
        
        if (isConditionMet && edge) {
          return flow.nodes.find(n => n.id === edge.target);
        }
      }
      
      // Se nenhuma condição for atendida, usar o else
      const elseEdge = edges.find(e => e.source === currentNode.id && e.sourceHandle === 'else');
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
          edge.source === currentNode.id && 
          edge.sourceHandle === `option${matchingOptionIndex}`
        );
        if (selectedEdge) {
          return flow.nodes.find(n => n.id === selectedEdge.target);
        }
      }

      // Se não encontrou correspondência exata, usar o handle 'no-match'
      const noMatchEdge = edges.find(edge => edge.source === currentNode.id && edge.sourceHandle === 'no-match');
      if (noMatchEdge) {
        return flow.nodes.find(n => n.id === noMatchEdge.target);
      }
    }

    // Para outros tipos de nó, usar primeira conexão
    return flow.nodes.find(n => n.id === edges[0].target);
  };

  /**
   * Atualiza uma sessão de fluxo
   * @param {string} sessionId - ID da sessão
   * @param {Object} updates - Atualizações a serem aplicadas
   */
  const updateSession = async (sessionId, updates) => {
    const { data, error } = await supabase
      .from('flow_sessions')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('id', sessionId)
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
    
    return data;
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
   * Envia uma mensagem para o chat
   * @param {string} content - Conteúdo da mensagem
   * @param {Object} files - Arquivos anexados
   * @param {string} sessionId - ID da sessão
   */
  const sendMessage = async (content, files, sessionId) => {
    try {
      if(content || files) {
        const result = await createMessageToSend(chatId, organization.id, content, null, files, null);
        if (result.status !== 201) throw new Error(result.error);
        
        // Aguardar que todas as mensagens sejam realmente enviadas para o canal
        if (result.messages && result.messages.length > 0) {
          // Criar uma cadeia de promises para enviar as mensagens em ordem
          let sendChain = Promise.resolve();
          
          for (const message of result.messages) {
            sendChain = sendChain.then(() => {
              return sendSystemMessage(message.id).catch(error => {
                console.error('Erro ao enviar mensagem para o canal:', error);
              });
            });
          }
          
          // Aguardar a conclusão da cadeia antes de retornar
          await sendChain;
        }
        
        return result;
      }
      return { status: 400, success: false, error: 'No content or files provided' };
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
   * Processa um nó do tipo OpenAI
   * @param {Object} node - Nó a ser processado
   * @param {Object} session - Sessão atual
   * @returns {Object} - Sessão atualizada
   */
  const processOpenAI = async (node, session) => {
    try {
      const { openai: openAIConfig } = node.data;

      const { data: integration, error: integrationError } = await supabase
        .from('integrations')
        .select('*')
        .eq('id', openAIConfig.integrationId)
        .eq('organization_id', organization.id)
        .eq('type', 'openai')
        .eq('status', 'active')
        .single();

      if (integrationError) throw integrationError;

      const openai = new OpenAI({
        apiKey: integration.credentials.api_key,
      });

      if (!openAIConfig) {
        throw new Error('Configuração do OpenAI não encontrada');
      }

      let updatedSession = { ...session };
      
      switch (openAIConfig.apiType) {
        case 'textGeneration':
          const textResult = await handleTextGeneration(openai, openAIConfig, updatedSession);
          if (openAIConfig.variableName) {
            // Atualiza a sessão com a nova variável
            const variables = Array.isArray(updatedSession.variables) 
              ? [...updatedSession.variables] 
              : [];
            
            const variableIndex = variables.findIndex(v => v.name === openAIConfig.variableName);
            
            if (variableIndex >= 0) {
              variables[variableIndex] = {
                ...variables[variableIndex],
                value: textResult
              };
            } else {
              variables.push({
                id: crypto.randomUUID(),
                name: openAIConfig.variableName,
                value: textResult
              });
            }
            
            await updateSession(updatedSession.id, { variables });
            updatedSession.variables = variables;
          }
          break;
          
        case 'audio':
          await handleAudioGeneration(openai, openAIConfig, updatedSession);
          break;
          
        case 'tts':
          await handleTextToSpeech(openai, openAIConfig, updatedSession);
          break;
          
        default:
          throw new Error(`Tipo de OpenAI não suportado: ${openAIConfig.apiType}`);
      }
      
      return updatedSession;
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
        if (tool) {
          // Extrair argumentos da chamada
          const args = JSON.parse(toolCall.function.arguments);
          
          // Validar argumentos contra valores enum
          if (tool.parameters && tool.parameters.properties) {
            for (const [key, value] of Object.entries(args)) {
              const paramConfig = tool.parameters.properties[key];
              
              // Se o parâmetro tiver valores enum definidos, valida o valor recebido
              if (paramConfig && paramConfig.enum && Array.isArray(paramConfig.enum) && paramConfig.enum.length > 0) {
                console.log(`[validateEnum] Validando valor "${value}" para o parâmetro "${key}" da ferramenta "${tool.name}" contra valores enum: ${paramConfig.enum.join(', ')}`);
                
                // Se o valor não estiver na lista de enum, usa o primeiro valor da lista
                if (!paramConfig.enum.includes(value)) {
                  console.warn(`[validateEnum] Valor "${value}" para o parâmetro "${key}" não está na lista de valores permitidos. Usando o primeiro valor da lista: "${paramConfig.enum[0]}"`);
                  args[key] = paramConfig.enum[0];
                } else {
                  console.log(`[validateEnum] Valor "${value}" para o parâmetro "${key}" é válido.`);
                }
              }
            }
          }
          
          // Atualizar variáveis com os argumentos
          for (const [key, value] of Object.entries(args)) {
            // Verifica se session.variables é um array ou um objeto e converte para array se necessário
            let variables = [];
            
            if (Array.isArray(session.variables)) {
              variables = [...session.variables];
            } else if (session.variables && typeof session.variables === 'object') {
              // Converte de objeto para array
              variables = Object.entries(session.variables).map(([name, value]) => ({
                id: crypto.randomUUID(),
                name,
                value
              }));
            }
            
            const variableIndex = variables.findIndex(v => v.name === key);
            
            if (variableIndex >= 0) {
              // Atualiza a variável existente
              variables[variableIndex] = {
                ...variables[variableIndex],
                value: value
              };
            } else {
              // Cria uma nova variável
              variables.push({
                id: crypto.randomUUID(),
                name: key,
                value: value
              });
            }
            
            await updateSession(session.id, { variables });
          }

          // Verificar condições para determinar o próximo nó
          let nextNodeId = null;
          
          // Se houver condições definidas, verifica cada uma delas
          if (tool.conditions && Array.isArray(tool.conditions) && tool.conditions.length > 0) {
            console.log(`[processConditions] Verificando ${tool.conditions.length} condições para a ferramenta "${tool.name}"`);
            
            // Verifica cada condição
            for (const condition of tool.conditions) {
              if (condition.paramName && condition.value && condition.targetNodeId) {
                const paramValue = args[condition.paramName];
                
                // Se o valor do parâmetro corresponder ao valor da condição, usa o nó de destino da condição
                if (paramValue === condition.value) {
                  console.log(`[processConditions] Condição satisfeita: ${condition.paramName} = ${condition.value}. Redirecionando para o nó ${condition.targetNodeId}`);
                  nextNodeId = condition.targetNodeId;
                  break; // Sai do loop após encontrar a primeira condição satisfeita
                }
              }
            }
          }
          
          // Se nenhuma condição for satisfeita, usa o nó de destino padrão
          if (!nextNodeId) {
            nextNodeId = tool.defaultTargetNodeId || tool.targetNodeId;
            console.log(`[processConditions] Nenhuma condição satisfeita. Usando nó de destino padrão: ${nextNodeId}`);
          }
          
          // Redirecionar para o nó alvo da ferramenta
          if (nextNodeId) {
            await updateSession(session.id, {
              current_node_id: nextNodeId
            });
          }
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
        // Substituir variáveis no prompt
        const processedContent = replaceVariables(prompt.content, session.variables);
        messages.push({
          role: 'system',
          content: processedContent
        });
      }
    } else if (config.promptType === 'custom' && config.customPrompt) {
      // Substituir variáveis no prompt personalizado
      const processedContent = replaceVariables(config.customPrompt, session.variables);
      messages.push({
        role: 'system',
        content: processedContent
      });
    }

    // Adicionar mensagens do contexto
    if (config.messageType === 'chatMessages') {
      // Buscar apenas mensagens do chat atual
      const { data: chatMessages } = await supabase
        .from('messages')
        .select('*')
        .eq('chat_id', session.chat_id)
        .not('content', 'is', null)
        .order('created_at', { ascending: true });

      chatMessages?.forEach(msg => {
        messages.push({
          role: msg.sender_type === 'customer' ? 'user' : 'assistant',
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
    return tools.map(tool => {
      // Cria uma cópia profunda dos parâmetros para evitar modificar o objeto original
      const parameters = tool.parameters ? JSON.parse(JSON.stringify(tool.parameters)) : { type: 'object', properties: {} };
      
      // Verifica se há propriedades com valores enum
      if (parameters.properties) {
        Object.keys(parameters.properties).forEach(propName => {
          const prop = parameters.properties[propName];
          
          // Se a propriedade tiver valores enum, garante que eles sejam incluídos corretamente
          if (prop.enum && Array.isArray(prop.enum)) {
            // Filtra valores vazios ou nulos
            const originalLength = prop.enum.length;
            prop.enum = prop.enum.filter(value => value !== null && value !== '');
            
            // Log para depuração
            if (originalLength !== prop.enum.length) {
              console.log(`[prepareTools] Filtrados ${originalLength - prop.enum.length} valores vazios do enum para o parâmetro "${propName}" da ferramenta "${tool.name}"`);
            }
            
            // Se não houver valores enum válidos após a filtragem, remove a propriedade enum
            if (prop.enum.length === 0) {
              delete prop.enum;
              console.log(`[prepareTools] Removida propriedade enum vazia para o parâmetro "${propName}" da ferramenta "${tool.name}"`);
            } else {
              console.log(`[prepareTools] Parâmetro "${propName}" da ferramenta "${tool.name}" tem ${prop.enum.length} valores enum: ${prop.enum.join(', ')}`);
            }
          }
        });
      }
      
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: parameters
        }
      };
    });
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
   * Processa um nó do tipo variável, atualizando o valor da variável na sessão
   * @param {Object} data - Dados do nó contendo a variável a ser atualizada
   * @param {Object} session - Sessão atual com as variáveis
   * @returns {Object} - Sessão atualizada com as novas variáveis
   */
  const processVariable = async (data, session) => {
    try {
      if (!data.variable || !data.variable.name) {
        throw new Error('Nome da variável não especificado');
      }

      // Processa o valor da variável, substituindo quaisquer variáveis existentes
      const processedValue = replaceVariables(data.variable.value, session.variables);

      // Verifica se session.variables é um array ou um objeto e converte para array se necessário
      let variables = [];
      
      if (Array.isArray(session.variables)) {
        variables = [...session.variables];
      } else if (session.variables && typeof session.variables === 'object') {
        // Converte de objeto para array
        variables = Object.entries(session.variables).map(([name, value]) => ({
          id: crypto.randomUUID(),
          name,
          value
        }));
      }
      
      const variableIndex = variables.findIndex(v => v.name === data.variable.name);
      
      if (variableIndex >= 0) {
        // Atualiza a variável existente
        variables[variableIndex] = {
          ...variables[variableIndex],
          value: processedValue
        };
      } else {
        // Cria uma nova variável
        variables.push({
          id: crypto.randomUUID(),
          name: data.variable.name,
          value: processedValue
        });
      }
      
      // Cria uma cópia atualizada da sessão com as novas variáveis
      const updatedSession = {
        ...session,
        variables
      };
      
      // Atualiza a sessão no banco de dados
      await updateSession(session.id, { variables }).catch(error => {
        Sentry.captureException(error);
        console.error('Erro ao atualizar variáveis na sessão:', error);
      });
      
      // Retorna a sessão atualizada imediatamente
      return updatedSession;
    } catch (error) {
      Sentry.captureException(error);
      throw error;
    }
  };

  /**
   * Atualização de dados do cliente
   * @param {Object} data - Dados a serem atualizados
   * @param {Object} session - Sessão atual
   * @returns {Object} - Sessão atualizada
   */
  const updateCustomer = async (data, session) => {
    try {
      const { fields } = data;
      if (!fields || !Array.isArray(fields) || fields.length === 0) {
        throw new Error('Campos para atualização não especificados');
      }

      const updates = {};
      
      // Processa cada campo, substituindo variáveis se necessário
      for (const field of fields) {
        if (field.name && field.value) {
          updates[field.name] = replaceVariables(field.value, session.variables);
        }
      }
      
      if (Object.keys(updates).length > 0) {
        await supabase
          .from('customers')
          .update(updates)
          .eq('id', session.customer);
      }
      
      return session;
    } catch (error) {
      Sentry.captureException(error);
      throw error;
    }
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

  /**
   * Substitui as variáveis no formato {{nome_variavel}} pelo valor correspondente
   * @param {string} text - Texto com possíveis variáveis para substituir
   * @param {Object|Array} variables - Variáveis disponíveis (pode ser um objeto ou um array)
   * @returns {string} - Texto com as variáveis substituídas
   */
  const replaceVariables = (text, variables) => {
    if (!text || !variables) return text;
    
    return text.replace(/\{\{([^}]+)\}\}/g, (match, variableName) => {
      const trimmedName = variableName.trim();
      let value;
      
      // Verifica se variables é um array ou um objeto
      if (Array.isArray(variables)) {
        // Procura a variável no array de variáveis
        const variable = variables.find(v => v.name === trimmedName);
        value = variable ? variable.value : undefined;
      } else if (typeof variables === 'object') {
        // Acessa diretamente a propriedade do objeto
        value = variables[trimmedName];
      }
      
      // Retorna o valor da variável ou mantém o placeholder se não encontrar
      return value !== undefined ? value : match;
    });
  };

  /**
   * Processa uma sessão específica que ultrapassou o tempo limite
   * @param {Object} session - Sessão que ultrapassou o timeout
   */
  const handleSessionTimeout = async (session) => {
    try {
      const currentNode = session.flow.nodes.find(n => n.id === session.current_node_id);
      if (!currentNode) {
        // Se não encontrar o nó atual, marca a sessão como inativa
        await updateSession(session.id, {
          status: 'inactive',
          timeout_at: null
        });
        return;
      }
      
      // Busca uma edge do tipo timeout que sai do nó atual
      const timeoutEdge = session.flow.edges.find(
        edge => edge.source === currentNode.id && edge.sourceHandle === 'timeout'
      );
      
      if (!timeoutEdge) {
        // Se não houver edge de timeout, apenas zera o timeout_at
        await updateSession(session.id, {
          timeout_at: null
        });
        return;
      }
      
      // Encontra o nó de destino do timeout
      const timeoutNode = session.flow.nodes.find(n => n.id === timeoutEdge.target);

      if (!timeoutNode) {
        // Se não encontrar o nó de timeout, apenas zera o timeout_at
        await updateSession(session.id, {
          timeout_at: null
        });
        return;
      }
      
      // Atualiza a sessão para o nó de timeout e zera o timeout_at
      const updatedSession = await updateSession(session.id, {
        current_node_id: timeoutNode.id,
        timeout_at: null,
        last_interaction: new Date().toISOString()
      });
      
      // Executa o nó de timeout
      await executeNode(updatedSession, timeoutNode);
      
      // Continua o fluxo a partir do nó de timeout
      let nextNode = await getNextNode(updatedSession.flow, timeoutNode, null, updatedSession);
      while (nextNode && nextNode.type !== 'input') {
        await executeNode(updatedSession, nextNode);
        nextNode = await getNextNode(updatedSession.flow, nextNode, null, updatedSession);
      }
      
      if (nextNode) {
        const timeout = nextNode.data?.inputConfig?.timeout || null;
        await updateSession(updatedSession.id, {
          current_node_id: nextNode.id,
          input_type: nextNode.data?.inputType || 'text',
          timeout_at: timeout ? new Date(Date.now() + timeout * 60 * 1000).toISOString() : null,
          last_interaction: new Date().toISOString()
        });
        await executeNode(updatedSession, nextNode);
      } else {
        await updateSession(updatedSession.id, {
          status: 'inactive'
        });
      }
    } catch (error) {
      Sentry.captureException(error);
      console.error(`Erro ao processar timeout da sessão ${session.id}:`, error);
    }
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
    findActiveChat,
    handleSessionTimeout
  };
}; 