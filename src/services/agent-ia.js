import { supabase } from '../lib/supabase.js';
import { OpenAI } from 'openai';
import { decrypt } from '../utils/crypto.js';
import Sentry from '../lib/sentry.js';
import crypto from 'crypto';
import { generateSystemTools, handleSystemToolCall } from './agent-ia-actions.js';

/**
 * @fileoverview Implementação do nó AgentIA para o flow-engine.
 * 
 * Este módulo implementa o processamento do nó do tipo 'agenteia', que é uma extensão do conceito
 * de nó 'openai', mas com uma abordagem mais consolidada.
 * 
 * Diferenças principais entre 'agenteia' e 'openai':
 * 
 * 1. No nó 'agenteia', todas as configurações (modelo, temperatura, ferramentas, destinations) 
 *    estão armazenadas no prompt, em vez de no próprio nó, o que resulta em uma interface mais limpa.
 * 
 * 2. O nó 'agenteia' apenas recebe o ID do prompt a ser utilizado e, opcionalmente, o nome da variável
 *    onde a resposta será armazenada.
 * 
 * 3. Processamento de ações das ferramentas com base no campo 'destinations' do prompt, que mapeia
 *    ferramentas para ações específicas com suporte a filtros condicionais.
 * 
 * Este design facilita a reutilização de prompts e configurações em diferentes fluxos,
 * além de simplificar a interface para o usuário.
 * 
 * AÇÕES SUPORTADAS:
 * 
 * 1. update_customer: Atualiza dados do cliente
 *    - Suporta atualização de nome e funil/estágio
 *    - Permite mapeamento dinâmico de variáveis para valores específicos
 * 
 * 2. update_chat: Atualiza dados do chat
 *    - Suporta atualização de status, título e equipe
 *    - Permite mapeamento dinâmico de variáveis para valores específicos
 * 
 * 3. start_flow: Inicia um novo fluxo automatizado
 *    - Permite iniciar um fluxo específico ou usar mapeamento dinâmico
 *    - Cria uma nova sessão para o fluxo selecionado
 * 
 * 4. check_schedule: Gerencia agendamentos
 *    - checkAvailability: Verifica disponibilidade de horários
 *    - createAppointment: Cria um novo agendamento
 *    - checkAppointment: Consulta agendamentos existentes
 *    - deleteAppointment: Cancela um agendamento existente
 * 
 * Todas as ações suportam filtros condicionais baseados nos argumentos da ferramenta,
 * permitindo execução seletiva com base nos valores fornecidos.
 */

/**
 * Processa um nó do tipo AgentIA
 * @param {Object} node - Nó a ser processado
 * @param {Object} session - Sessão atual
 * @param {Function} sendMessage - Função para enviar mensagens
 * @param {Function} updateSession - Função para atualizar a sessão
 * @returns {Object} - Sessão atualizada
 */
export const processAgentIA = async (node, session, sendMessage, updateSession) => {
  try {
    if (!node.data?.agenteia?.promptId) {
      return {
        success: false,
        instructions: "Please provide a valid prompt ID for the AgentIA node."
      };
    }

    // Buscar informações completas do prompt, incluindo configurações da integração
    const { data: prompt, error: promptError } = await supabase
      .from('prompts')
      .select('*')
      .eq('id', node.data.agenteia.promptId)
      .single();

    if (promptError) {
      console.error('[processAgentIA] Erro ao buscar prompt:', promptError);
      throw promptError;
    }
    if (!prompt) {
      console.error(`[processAgentIA] Prompt não encontrado com ID ${node.data.agenteia.promptId}`);
      return {
        success: false,
        instructions: `Please provide a valid prompt ID. The prompt with ID ${node.data.agenteia.promptId} was not found.`
      };
    }

    // Buscar a integração associada ao prompt
    const { data: integration, error: integrationError } = await supabase
      .from('integrations')
      .select('*')
      .eq('id', prompt.integration_id)
      .eq('type', 'openai')
      .eq('status', 'active')
      .single();

    if (integrationError) {
      console.error('[processAgentIA] Erro ao buscar integração:', integrationError);
      throw integrationError;
    }
    if (!integration) {
      console.error(`[processAgentIA] Integração não encontrada com ID ${prompt.integration_id}`);
      return {
        success: false,
        instructions: `Please check the integration configuration. The integration with ID ${prompt.integration_id} was not found or is not active.`
      };
    }

    // Descriptografar a chave da API OpenAI
    const decryptedApiKey = decrypt(integration.credentials.api_key);
    if (!decryptedApiKey) {
      console.error('[processAgentIA] Erro ao descriptografar chave da API OpenAI');
      return {
        success: false,
        instructions: "There was an error decrypting the OpenAI API key. Please check the integration configuration."
      };
    }

    // Inicializar o cliente OpenAI com a chave da API
    const openai = new OpenAI({
      apiKey: decryptedApiKey,
    });

    // Preparar mensagens do contexto
    const messages = await prepareContextMessages(prompt, session);

    // Determinar quais ferramentas do sistema utilizar com base nas actions configuradas no prompt
    let systemToolTypes = [];
    if (prompt.actions && Array.isArray(prompt.actions)) {
      systemToolTypes = prompt.actions
        .filter(action => action && action.type)
        .map(action => action.type);
      
      console.log(`[processAgentIA] Tipos de ferramentas do sistema detectadas:`, systemToolTypes);
    }

    // Gerar ferramentas do sistema
    let systemTools = [];
    if (systemToolTypes.length > 0) {
      // Buscar a organização da sessão
      const { data: chat } = await supabase
        .from('chats')
        .select('organization_id')
        .eq('id', session.chat_id)
        .single();
      
      if (chat && chat.organization_id) {
        systemTools = await generateSystemTools(chat.organization_id, prompt.actions);
        console.log(`[processAgentIA] Ferramentas do sistema geradas: ${systemTools.length}`);
      }
    }

    // Combinar ferramentas personalizadas e do sistema
    const customTools = prompt.tools || [];
    const combinedTools = [...customTools, ...systemTools];

    // Preparar ferramentas se existirem
    const tools = combinedTools.length > 0 ? prepareTools(combinedTools) : [];

    console.log(`[AgentIA] Iniciando chamada para modelo ${prompt.model} com temperatura ${prompt.temperature}`);
    console.log(`[AgentIA] Usando ${tools.length} ferramentas (${customTools.length} personalizadas, ${systemTools.length} do sistema)`);

    // console.log(`[AgentIA] Ferramentas do sistema: ${JSON.stringify(systemTools)}`);

    // Fazer chamada para o OpenAI
    const completion = await openai.chat.completions.create({
      model: prompt.model || 'gpt-4o',
      messages,
      temperature: prompt.temperature || 0.7,
      // max_tokens: prompt.max_tokens || 150,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? "auto" : undefined
    });
    

    // Processar resposta
    const choice = completion.choices[0];
    
    // Se houver chamadas de ferramentas
    if (choice.message.tool_calls) {
      console.log(`[processAgentIA] Ferramentas encontradas: ${choice.message.tool_calls.length}`);
      let toolResults = [];
      
      for (const toolCall of choice.message.tool_calls) {
        // Primeiro, tentar encontrar a ferramenta entre as ferramentas personalizadas
        let tool = customTools.find(t => t.name === toolCall.function.name);
        console.log(`[processAgentIA] Ferramenta personalizada encontrada: ${tool ? tool.name : 'Não encontrada'}`);
        
        // Se não encontrar nas ferramentas personalizadas, procurar nas ferramentas do sistema
        if (!tool) {
          tool = systemTools.find(t => t.name === toolCall.function.name);
          
          // Se encontrou em ferramentas do sistema, marcar para processamento especial
          if (tool) {
            console.log(`[processAgentIA] Ferramenta do sistema encontrada: ${tool.name}`);
          }
        }
        
        if (tool) {
          // Extrair argumentos da chamada
          const args = JSON.parse(toolCall.function.arguments);
          
          // Validar argumentos contra valores enum
          if (tool.parameters && tool.parameters.properties) {
            for (const [key, value] of Object.entries(args)) {
              const paramConfig = tool.parameters.properties[key];
              
              // Se o parâmetro tiver valores enum definidos, valida o valor recebido
              if (paramConfig && paramConfig.enum && Array.isArray(paramConfig.enum) && paramConfig.enum.length > 0) {
                console.log(`[validateEnum] Validando valor "${value}" para o parâmetro "${key}" da tool "${tool.name}" against enum values: ${paramConfig.enum.join(', ')}`);
                
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
          
          // Processar ações da ferramenta baseado no tipo de ferramenta
          let result = null;
          
          // Para ferramentas personalizadas, usar a configuração de destinations
          if (customTools.includes(tool) && prompt.destinations && prompt.destinations[tool.name]) {
            const actions = prompt.destinations[tool.name];
            result = await handleToolActions(actions, args, session, tool);
          } 
          // Para ferramentas do sistema, usar handlers específicos
          else if (systemTools.includes(tool)) {
            result = await handleSystemToolCall(
              tool, 
              args, 
              prompt.actions,
              session, 
              {
                processUpdateCustomerAction,
                processUpdateChatAction,
                processStartFlowAction
              }
            );
          }

          // Atualizar variáveis com os argumentos
          await updateSessionVariablesFromArgs(args, session, updateSession);
          
          // Store tool result for later contextualization
          if (result) {
            toolResults.push({
              tool: tool.name,
              tool_call_id: toolCall.id,
              result
            });
          }
        }
      }
      
      // If there are tool results, send them back to the model for contextualization
      if (toolResults.length > 0) {
        // Create a copy of the original messages
        const followUpMessages = [...messages];
        
        // Add the AI message that requested the tool use
        followUpMessages.push({
          role: 'assistant',
          content: null,
          tool_calls: choice.message.tool_calls
        });
        
        // Add tool results with improved format
        for (const toolResult of toolResults) {
          // For each individual tool result
          if (Array.isArray(toolResult.result)) {
            // If the result is an array of results (multiple actions)
            for (const actionResult of toolResult.result) {
              followUpMessages.push({
                role: 'tool',
                tool_call_id: toolResult.tool_call_id,
                name: toolResult.tool,
                content: JSON.stringify({
                  status: actionResult.status,
                  message: actionResult.message,
                  action_type: actionResult.action_type,
                  action_name: actionResult.action_name,
                  data: transformResultData(actionResult),
                  instructions: actionResult.instructions || null
                })
              });
            }
          } else {
            // If it's a single result
            followUpMessages.push({
              role: 'tool',
              tool_call_id: toolResult.tool_call_id,
              name: toolResult.tool,
              content: JSON.stringify(toolResult.result)
            });
          }
        }
        
        // Add specific instruction for contextualization
        followUpMessages.push({
          role: 'system',
          content: `Based on the tool results, generate a contextualized response for the user.
                   Continue the conversation in the same language you were already using with the customer.
                   Include relevant information from results such as:
                   - For scheduling: appointment dates, times, service names
                   - For customer updates: changed fields and new values
                   - For chat updates: status changes, title changes
                   - For flow initiation: flow name and session details
                   
                   If there are specific instructions in the results, include them in your response.
                   If there were errors, clearly explain what happened and suggest next steps.
                   Keep the tone professional but friendly, and be concise.`
        });
        
        // Send new request to the model to contextualize the results
        console.log(`[AgentIA] Sending tool results for contextualization`);
        const followUpCompletion = await openai.chat.completions.create({
          model: prompt.model || 'gpt-4o',
          messages: followUpMessages,
          temperature: prompt.temperature || 0.7,
          max_tokens: prompt.max_tokens || 150
        });
        
        // Obter a resposta contextualizada
        const contextualizedResponse = followUpCompletion.choices[0].message.content;

        
        // Se tiver especificado um nome de variável para salvar a resposta
        if (node.data.agenteia.variableName) {
          // Atualiza a sessão com a nova variável
          const variables = Array.isArray(session.variables) 
            ? [...session.variables] 
            : [];
          
          const variableIndex = variables.findIndex(v => v.name === node.data.agenteia.variableName);
          
          if (variableIndex >= 0) {
            variables[variableIndex] = {
              ...variables[variableIndex],
              value: contextualizedResponse
            };
          } else {
            variables.push({
              id: crypto.randomUUID(),
              name: node.data.agenteia.variableName,
              value: contextualizedResponse
            });
          }
          
          await updateSession(session.id, { variables });
          
          // Atualiza a sessão em memória também
          return {
            ...session,
            variables
          };
        }
        
        return session;
      }
      
      // Se não houver resultados a serem contextualizados, apenas retorna a sessão atualizada
      return session;
    }

    // Se for resposta textual
    const responseText = choice.message.content;
    
    // Se tiver especificado um nome de variável para salvar a resposta
    if (node.data.agenteia.variableName) {
      // Atualiza a sessão com a nova variável
      const variables = Array.isArray(session.variables) 
        ? [...session.variables] 
        : [];
      
      const variableIndex = variables.findIndex(v => v.name === node.data.agenteia.variableName);
      
      if (variableIndex >= 0) {
        variables[variableIndex] = {
          ...variables[variableIndex],
          value: responseText
        };
      } else {
        variables.push({
          id: crypto.randomUUID(),
          name: node.data.agenteia.variableName,
          value: responseText
        });
      }
      
      await updateSession(session.id, { variables });
      
      // Atualiza a sessão em memória também
      return {
        ...session,
        variables
      };
    }
    
    return session;
  } catch (error) {
    console.error('[AgentIA] Erro:', error);
    Sentry.captureException(error);
    throw error;
  }
};

/**
 * Prepara as mensagens do contexto para enviar ao modelo
 * @param {Object} prompt - Informações do prompt
 * @param {Object} session - Sessão atual
 * @returns {Array} - Array de mensagens para o contexto
 */
const prepareContextMessages = async (prompt, session) => {
  const messages = [];

  // Adicionar informações contextuais sobre data e cliente
  try {
    // Buscar informações do cliente
    const { data: customer } = await supabase
      .from('customers')
      .select('name')
      .eq('id', session.customer_id)
      .single();
    
    // Obter timezone da configuração do prompt ou usar padrão
    const timezone = prompt.config?.timezone || 'America/Sao_Paulo';
    
    // Obter data e hora formatadas
    const currentDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: timezone
    });
    
    const currentTime = new Date().toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit', 
      hour12: false,
      timeZone: timezone
    });
    
    // Obter o dia da semana
    const weekday = new Date().toLocaleDateString('pt-BR', {
      weekday: 'long',
      timeZone: timezone
    });
    
    // Obter informações do chat
    const { data: chat } = await supabase
      .from('chats')
      .select('title, channel_details')
      .eq('id', session.chat_id)
      .single();
    
    let contextInfo = `[SYSTEM CONTEXT INFO: Today is ${currentDate} (${weekday}), current time is ${currentTime} (${timezone} timezone).`;
    
    if (customer && customer.name) {
      contextInfo += `\nCustomer name: "${customer.name}" (automatically retrieved from our system)`;
    }
    
    if (chat) {
      if (chat.title) {
        contextInfo += `\nConversation title: "${chat.title}"`;
      }
      
      if (chat.channel_details && chat.channel_details.type) {
        contextInfo += `\nChannel type: ${chat.channel_details.type}`;
      }
    }

    // Verificar se o prompt tem mídia disponível
    if (prompt.media && Array.isArray(prompt.media) && prompt.media.length > 0) {
      contextInfo += `\n\nAVAILABLE MEDIA FILES: You have access to ${prompt.media.length} media files that you can share with the customer when they ask for them or when appropriate to enhance the conversation. When the customer requests any document, image, video, or other media, or when it would be helpful to share one of these files, provide the corresponding link.`;
      
      // Listar os arquivos de mídia disponíveis
      contextInfo += `\n\nMedia files:`;
      prompt.media.forEach((media, index) => {
        const fileType = media.type || 'document';
        contextInfo += `\n${index + 1}. ${fileType.toUpperCase()}: "${media.description || media.name || 'No description'}" - URL: ${media.url}`;
      });
      
      // Instruções adicionais
      contextInfo += `\n\nWhen sharing media files with the customer:
1. Select the most appropriate file based on the customer's request.
2. Share the complete URL as is.
3. Add a brief description of what the file contains.
4. Avoid modifying or shortening the URLs.`;
    }
    
    contextInfo += `\nPlease use this information appropriately in your responses without explicitly mentioning that it came from a system note, unless specifically asked about it.]`;
    
    // Adicionar prompt do sistema com informações do contexto
    if (prompt.content) {
      // Substituir variáveis no prompt
      const processedContent = replaceVariables(prompt.content, session.variables);
      messages.push({
        role: 'system',
        content: processedContent + '\n\n' + contextInfo
      });
    } else {
      // Se não houver prompt, apenas adicionar o contexto
      messages.push({
        role: 'system',
        content: contextInfo
      });
    }
  } catch (error) {
    console.error('[prepareContextMessages] Error adding context info:', error);
    Sentry.captureException(error);
    
    // Adicionar prompt do sistema sem informações contextuais
    if (prompt.content) {
      // Substituir variáveis no prompt
      const processedContent = replaceVariables(prompt.content, session.variables);
      messages.push({
        role: 'system',
        content: processedContent
      });
    }
  }

  // Buscar apenas mensagens do chat atual
  const { data: chatMessages } = await supabase
    .from('messages')
    .select('*')
    .eq('chat_id', session.chat_id)
    .in('sender_type', ['customer', 'agent'])
    .not('content', 'is', null)
    .neq('status', 'deleted')
    .order('created_at', { ascending: true });

  chatMessages?.forEach(msg => {
    // Adicionar timestamp da mensagem
    const messageDate = new Date(msg.created_at);
    
    // Obter timezone da configuração do prompt ou usar padrão
    const timezone = prompt.config?.timezone || 'America/Sao_Paulo';
    
    const formattedDate = messageDate.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long', 
      day: 'numeric',
      timeZone: timezone
    });
    
    const formattedTime = messageDate.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timezone
    });
    
    const timestampInfo = ``;
    // const timestampInfo = `[${formattedDate}, ${formattedTime}] `;
    
    messages.push({
      role: msg.sender_type === 'customer' ? 'user' : 'assistant',
      content: timestampInfo + msg.content
    });
  });

  return messages;
};

/**
 * Prepara as ferramentas para enviar ao modelo
 * @param {Array} tools - Array de ferramentas
 * @returns {Array} - Array de ferramentas formatadas para o OpenAI
 */
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

/**
 * Updates session variables with tool arguments
 * @param {Object} args - Tool arguments
 * @param {Object} session - Current session
 * @param {Function} updateSession - Function to update the session
 */
const updateSessionVariablesFromArgs = async (args, session, updateSession) => {
  // Check if session.variables is an array or object and convert to array if needed
  let variables = [];
  
  if (Array.isArray(session.variables)) {
    variables = [...session.variables];
  } else if (session.variables && typeof session.variables === 'object') {
    // Convert from object to array
    variables = Object.entries(session.variables).map(([name, value]) => ({
      id: crypto.randomUUID(),
      name,
      value
    }));
  }
  
  // Update or add variables based on arguments
  for (const [key, value] of Object.entries(args)) {
    const variableIndex = variables.findIndex(v => v.name === key);
    
    if (variableIndex >= 0) {
      // Update existing variable
      variables[variableIndex] = {
        ...variables[variableIndex],
        value: value
      };
    } else {
      // Create new variable
      variables.push({
        id: crypto.randomUUID(),
        name: key,
        value: value
      });
    }
  }
  
  // Update session in database
  await updateSession(session.id, { variables });
};

/**
 * Processes actions configured for a tool based on provided arguments
 * @param {Array} actions - Actions configured for the tool
 * @param {Object} args - Tool arguments
 * @param {Object} session - Current session
 * @param {Object} tool - Tool configuration
 * @param {Function} sendMessage - Function to send messages
 * @returns {Array} - Results of actions for contextualization
 */
const handleToolActions = async (actions, args, session, tool, sendMessage) => {
  if (!actions || !Array.isArray(actions) || actions.length === 0) {
    return null;
  }

  console.log('[handleToolActions] Actions:', actions);
  console.log('[handleToolActions] Args:', args);

  const allResults = [];

  for (const action of actions) {
    // Verifica se há filtros e se todos os filtros são satisfeitos
    if (action.filters && Array.isArray(action.filters) && action.filters.length > 0) {
      const allFiltersPassed = action.filters.every(filter => {
        if (!filter.variable || !filter.operator) return true;
        
        const varName = filter.variable;
        const varValue = args[varName];
        const filterValue = filter.value;
        
        switch (filter.operator) {
          case 'equals':
            return varValue === filterValue;
          case 'not_equals':
            return varValue !== filterValue;
          case 'contains':
            return String(varValue).includes(String(filterValue));
          case 'not_contains':
            return !String(varValue).includes(String(filterValue));
          case 'starts_with':
            return String(varValue).startsWith(String(filterValue));
          case 'ends_with':
            return String(varValue).endsWith(String(filterValue));
          case 'greater_than':
            return Number(varValue) > Number(filterValue);
          case 'less_than':
            return Number(varValue) < Number(filterValue);
          case 'greater_than_or_equal':
            return Number(varValue) >= Number(filterValue);
          case 'less_than_or_equal':
            return Number(varValue) <= Number(filterValue);
          case 'exists':
            return varValue !== undefined && varValue !== null && varValue !== '';
          case 'not_exists':
            return varValue === undefined || varValue === null || varValue === '';
          default:
            return true;
        }
      });
      
      if (!allFiltersPassed) {
        console.log(`[handleToolActions] Filtros não satisfeitos para ação ${action.id}`);
        continue;
      }
    }
    
    // Processa a ação com base no tipo
    try {
      let result;
      switch (action.type) {
        case 'check_schedule':
          result = await processCheckScheduleAction(action, args, session);
          console.log('[handleToolActions] Result:', result);
          break;
        
        case 'update_customer':
          result = await processUpdateCustomerAction(action, args, session);
          break;
          
        case 'update_chat':
          result = await processUpdateChatAction(action, args, session);
          break;
          
        case 'start_flow':
          result = await processStartFlowAction(action, args, session);
          break;
          
        default:
          console.log(`[handleToolActions] Tipo de ação não suportado: ${action.type}`);
          continue;
      }
      
      // Adicionar informações sobre a ferramenta e a ação ao resultado
      if (result) {
        const resultWithContext = {
          ...result,
          action_type: action.type,
          action_name: action.name || action.type,
          tool_name: tool.name
        };
        
        allResults.push(resultWithContext);
        
        // Se a ação tem o sinalizador sendMessage ativado, enviar uma mensagem ao usuário
        // if (action.sendMessage && sendMessage && result.message) {
        //   if (result.status === "success") {
        //     await sendMessage(`✅ ${result.message}`);
        //   } else if (result.status === "error") {
        //     await sendMessage(`❌ ${result.message}`);
        //   } else if (result.status === "info") {
        //     await sendMessage(`ℹ️ ${result.message}`);
        //   }
        // }
      }
    } catch (error) {
      console.error(`[handleToolActions] Erro ao executar ação ${action.type}:`, error);
      Sentry.captureException(error);
      
      allResults.push({
        status: "error",
        message: `Error executing ${action.type}: ${error.message}`,
        error: error.message,
        action_type: action.type,
        action_name: action.name || action.type,
        tool_name: tool.name
      });
      
      // Enviar mensagem de erro se a ação tiver o sinalizador sendMessage ativado
      // if (action.sendMessage && sendMessage) {
      //   await sendMessage(`❌ Error executing action: ${error.message}`);
      // }
    }
  }
  
  // Para contextualização, é melhor retornar a lista completa de resultados
  return allResults;
};

/**
 * Converte um horário local para UTC
 * @param {string} date - Data no formato YYYY-MM-DD
 * @param {string} time - Hora local no formato HH:MM
 * @param {string} timezone - Timezone do cliente (ex: 'America/Sao_Paulo')
 * @returns {string} - Hora em UTC no formato HH:MM
 */
const convertLocalTimeToUTC = (date, time, timezone) => {
  try {
    if (!date || !time) return time;
    
    // Criar um objeto Date com a data e hora local
    const [hours, minutes] = time.split(':').map(Number);
    const localDate = new Date(`${date}T${time}:00`);
    
    // Ajustar para o timezone especificado
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    
    // Converter para string
    const parts = formatter.formatToParts(localDate);
    const formattedDate = {};
    
    parts.forEach(part => {
      if (part.type !== 'literal') {
        formattedDate[part.type] = part.value;
      }
    });
    
    // Criar um novo objeto Date com a data e hora ajustados ao timezone
    const dateInTimezone = new Date(
      `${formattedDate.year}-${formattedDate.month}-${formattedDate.day}T${formattedDate.hour}:${formattedDate.minute}:00`
    );
    
    // Obter a hora UTC
    const utcHours = dateInTimezone.getUTCHours().toString().padStart(2, '0');
    const utcMinutes = dateInTimezone.getUTCMinutes().toString().padStart(2, '0');
    
    return `${utcHours}:${utcMinutes}`;
  } catch (error) {
    console.error(`[convertLocalTimeToUTC] Error converting time: ${error.message}`);
    Sentry.captureException(error);
    throw error;
  }
};

/**
 * Converte um horário UTC para local
 * @param {string} date - Data no formato YYYY-MM-DD
 * @param {string} utcTime - Hora UTC no formato HH:MM
 * @param {string} timezone - Timezone do cliente (ex: 'America/Sao_Paulo')
 * @returns {string} - Hora local no formato HH:MM
 */
const convertUTCToLocalTime = (date, utcTime, timezone) => {
  try {
    if (!date || !utcTime) return utcTime;
    
    // Criar um objeto Date com a data e hora UTC
    const [hours, minutes] = utcTime.split(':').map(Number);
    const utcDate = new Date(`${date}T${utcTime}:00Z`);
    
    // Formatar para o timezone especificado
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    
    // Obter a hora formatada
    const localTime = formatter.format(utcDate);
    return localTime;
  } catch (error) {
    console.error(`[convertUTCToLocalTime] Error converting time: ${error.message}`);
    Sentry.captureException(error);
    throw error;
  }
};

/**
 * Converte um horário no formato HH:MM para minutos desde meia-noite
 * @param {string} timeStr - Horário no formato HH:MM
 * @returns {number} - Minutos desde meia-noite
 */
const timeToMinutes = (timeStr) => {
  if (!timeStr) return 0;
  
  // Validar formato do horário (HH:MM ou HH:MM:SS)
  if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(timeStr)) {
    console.warn(`[timeToMinutes] Formato de horário inválido: ${timeStr}`);
    return 0;
  }
  
  // Dividir o horário em partes e converter para números
  const parts = timeStr.split(':').map(Number);
  
  // Validar valores
  if (parts[0] < 0 || parts[0] > 23 || parts[1] < 0 || parts[1] > 59) {
    console.warn(`[timeToMinutes] Valores de hora/minuto inválidos: ${timeStr}`);
    return 0;
  }
  
  // Se tiver segundos, validar também
  if (parts.length === 3 && (parts[2] < 0 || parts[2] > 59)) {
    console.warn(`[timeToMinutes] Valor de segundos inválido: ${timeStr}`);
    return 0;
  }
  
  // Converter para minutos (ignorando segundos se existirem)
  return parts[0] * 60 + parts[1];
};

/**
 * Converte minutos desde meia-noite para horário no formato HH:MM
 * @param {number} minutes - Minutos desde meia-noite
 * @returns {string} - Horário no formato HH:MM
 */
const minutesToTime = (minutes) => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
};

/**
 * Processa uma ação de verificação de agenda
 * @param {Object} action - Configuração da ação
 * @param {Object} args - Argumentos da ferramenta
 * @param {Object} session - Sessão atual
 * @returns {Object} - Resultado da operação
 */
const processCheckScheduleAction = async (action, args, session) => {
  try {
    const config = action.config || {};
    
    // Extrair os argumentos principais
    // Determinar a operação usando operationMapping ou diretamente
    let operation;
    if (config.operationMapping && config.operationMapping.variable && config.operationMapping.mapping) {
      const operationValue = args[config.operationMapping.variable];
      operation = config.operationMapping.mapping[operationValue] || operationValue;
      console.log(`[processCheckScheduleAction] Operação mapeada: ${operationValue} -> ${operation}`);
    } else if (config.operation) {
      operation = args[config.operation];
    } else {
      operation = args.operation;
    }
    
    // Obter os valores de data e hora das variáveis configuradas
    const dayValue = args[config.dayVariable || 'date'] || args.date; // Formato YYYY-MM-DD
    let timeValue = args[config.timeVariable || 'time'] || args.time; // Formato HH:MM
    
    // Obter ID do agendamento para cancelamento/consulta
    let appointmentId = args[config.appointmentIdVariable || 'appointment_id'] || args.id_consulta || args.appointment_id;

    // console.log('[processCheckScheduleAction] Appointment ID:', appointmentId);
    // console.log('[processCheckScheduleAction] Appointment format:', appointmentId.includes('-'), appointmentId.split('-').length);
    
    // Se o ID vier no formato YYYY-MM-DD-HH:II, precisamos buscar o ID real do agendamento
    if (appointmentId && appointmentId.includes('-') && appointmentId.split('-').length === 4) {
      const [year, month, day, time] = appointmentId.split('-');
      const date = `${year}-${month}-${day}`;
      
      // Buscar o agendamento pelo cliente, data e hora
      const { data: appointment } = await supabase
        .from('appointments')
        .select('id')
        .eq('customer_id', session.customer_id)
        .eq('date', date)
        .eq('start_time', time)
        .in('status', ['scheduled', 'confirmed'])
        .single();

      if (appointment) {
        appointmentId = appointment.id;
      } else {
        console.error(`[processCheckScheduleAction] Agendamento não encontrado para data ${date} e hora ${time}`);
        return {
          success: false,
          instructions: `Please inform the customer that no appointment was found for the specified date ${date} and time ${time}.`
        };
      }
    }
    
    // Obter ID do serviço usando mapeamento se disponível
    let serviceId;
    if (config.serviceMapping && config.serviceVariable) {
      const serviceValue = args[config.serviceVariable];
      serviceId = config.serviceMapping[serviceValue];
      console.log(`[processCheckScheduleAction] Serviço mapeado: ${serviceValue} -> ${serviceId}`);
    } else if (config.serviceId) {
      serviceId = config.serviceId;
    } else {
      serviceId = args.id_servico || args.service_id;
    }
    
    // Obter notas do agendamento
    const notes = config.notes ? replaceVariables(config.notes, args) : args.notes || args.observacoes;
    
    // Flag para atendimento por ordem de chegada
    const byArrivalTime = args.by_arrival_time || args.order_of_arrival;
    
    // Obter o timezone da configuração do prompt ou usar padrão
    const timezone = args.timezone || session.variables?.find(v => v.name === 'timezone')?.value || 'America/Sao_Paulo';
    
    if (!operation) {
      return {
        status: "error",
        message: "Operation parameter is required for schedule checking.",
        operation: null
      };
    }
    
    // Identificar o ID da agenda a ser usada
    const scheduleId = config.scheduleId;
    if (!scheduleId) {
      return {
        status: "error",
        message: "No schedule configured for this action.",
        operation
      };
    }
    
    console.log(`[processCheckScheduleAction] Operação: ${operation}, Data: ${dayValue}, Hora: ${timeValue}, Serviço: ${serviceId}, Agenda: ${scheduleId}`);
    
    // Buscar o nome do serviço e suas propriedades se especificado
    let serviceName = "Not specified";
    let isArrivalTimeService = false;
    let serviceCapacity = 1;
    
    if (serviceId) {
      const { data: service } = await supabase
        .from('schedule_services')
        .select('title, by_arrival_time, capacity')
        .eq('id', serviceId)
        .single();
        
      if (service) {
        serviceName = service.title;
        isArrivalTimeService = service.by_arrival_time || false;
        serviceCapacity = service.capacity || 1;
      }
    }
    
    // Para serviços com atendimento por ordem de chegada, formatar a resposta adequadamente
    const formatArrivalTimeMessage = (result) => {
      if (isArrivalTimeService || byArrivalTime) {
        if (result.success) {
          result.message = result.message.replace('at', 'between');
          
          if (result.time_slot && result.time_slot.includes('-')) {
            const [start, end] = result.time_slot.split('-');
            result.message += ` and ${end}`;
            result.data = {
              ...result.data,
              arrival_time_service: true,
              capacity: serviceCapacity,
              time_range: result.time_slot
            };
          }
        }
      }
      return result;
    };
    
    let operationResult;
    
    // Remover a conversão de horário uma vez que os dados estarão na timezone da agenda
    console.log(`[processCheckScheduleAction] Usando horário na timezone da agenda: ${timeValue}`);
    
    // Executar a operação apropriada
    switch (operation) {
      case 'checkAvailability':
        console.log('checkAvailability', scheduleId, dayValue, timeValue, serviceId);
        // Obter o timezone da agenda
        const { data: scheduleData } = await supabase
          .from('schedules')
          .select('timezone')
          .eq('id', scheduleId)
          .single();
        
        const scheduleTimezone = scheduleData?.timezone || timezone;
        console.log(`[processCheckScheduleAction] Usando timezone da agenda: ${scheduleTimezone}`);
        
        operationResult = await checkScheduleAvailability(scheduleId, dayValue, timeValue, serviceId, scheduleTimezone);
        operationResult = formatArrivalTimeMessage(operationResult);
        if (!operationResult.success) {
          return operationResult;
        }
        break;
        
      case 'createAppointment':
        console.log('createAppointment', dayValue, timeValue, serviceId);
        // || !timeValue 
        if (!dayValue || !serviceId) {
          const missingParams = [];
          if (!dayValue) missingParams.push('date');
          if (!serviceId) missingParams.push('serviceId');
          console.error(`[processCheckScheduleAction] Parâmetros obrigatórios não fornecidos: ${missingParams.join(', ')}`);
          return {
            success: false,
            instructions: `I need the following information to create your appointment: ${missingParams.join(', ')}. Please provide these details in your next message. For example, if you need to provide a date, use the format YYYY-MM-DD, and for time use HH:MM.`
          };
        }
        
        // Obter o timezone da agenda
        const { data: scheduleDataForCreate } = await supabase
          .from('schedules')
          .select('timezone')
          .eq('id', scheduleId)
          .single();
        
        const scheduleTimezoneForCreate = scheduleDataForCreate?.timezone || timezone;
        console.log(`[processCheckScheduleAction] Usando timezone da agenda para criação: ${scheduleTimezoneForCreate}`);
        
        // Se o cliente especificou que quer atendimento por ordem de chegada
        // e o serviço suporta isso, usamos modo por ordem de chegada
        const useArrivalTimeMode = (isArrivalTimeService || byArrivalTime);
        
        // Se o serviço não suporta ordem de chegada mas o cliente pediu, informar
        if (byArrivalTime && !isArrivalTimeService) {
          operationResult = {
            status: "error",
            message: "This service does not support arrival time scheduling. Please choose a specific time.",
            operation
          };
        } else {
          operationResult = await createAppointment(
            scheduleId, 
            session.customer_id, 
            dayValue, 
            timeValue, 
            serviceId, 
            notes,
            scheduleTimezoneForCreate,
            session
          );
          
          operationResult = formatArrivalTimeMessage(operationResult);
          
          // Adicionar instruções específicas para serviços por ordem de chegada
          if (operationResult.success) {
            if (useArrivalTimeMode) {
              operationResult.instructions = `Please arrive during the time range ${operationResult.time_slot}. There may be a wait depending on arrival order.`;
            } else {
              operationResult.instructions = "Please arrive 15 minutes before your appointment. Bring your documents and health insurance card, if applicable.";
            }
          } else {
            return operationResult;
          }
        }
        break;
        
      case 'checkAppointment':
        // Permitir consultar agendamentos mesmo sem ID ou data
        if (!appointmentId) {
          console.log(`[processCheckScheduleAction] Listando todos os agendamentos ativos do cliente`);
          operationResult = await checkAppointment(session.customer_id);
          if (!operationResult.success) {
            return operationResult;
          }
        } else {
          // Obter o timezone da agenda relacionada ao agendamento
          const { data: appointmentForCheck } = await supabase
            .from('appointments')
            .select('schedule_id')
            .eq('id', appointmentId)
            .single();
          
          if (appointmentForCheck) {
            const { data: scheduleForCheck } = await supabase
              .from('schedules')
              .select('timezone')
              .eq('id', appointmentForCheck.schedule_id)
              .single();
            
            const scheduleTimezoneForCheck = scheduleForCheck?.timezone || timezone;
            console.log(`[processCheckScheduleAction] Usando timezone da agenda para checagem: ${scheduleTimezoneForCheck}`);
            
            operationResult = await checkAppointment(session.customer_id, appointmentId);
            if (!operationResult.success) {
              return operationResult;
            }
          } else {
            operationResult = {
              status: "error",
              message: `Appointment not found with ID: ${appointmentId}`,
              operation
            };
          }
        }
        break;
        
      case 'deleteAppointment':
        // Permitir consultar agendamentos mesmo sem ID ou data
        if (!appointmentId && !dayValue) {
          console.error('[deleteAppointment] ID do agendamento ou data não fornecidos');
          return {
            success: false,
            instructions: "Please ask the customer to provide either an appointment ID or a date."
          };
        }
        // Se temos uma data, mas não temos ID, usar a data para cancelar todos os agendamentos do cliente neste dia
        else if (dayValue && !appointmentId) {
          console.log(`[processCheckScheduleAction] Cancelando agendamentos por data: ${dayValue}`);
          operationResult = await deleteAppointment(null, session.customer_id, dayValue);
          if (!operationResult.success) {
            return operationResult;
          }
        } 
        // Caso contrário, continuar com a lógica de cancelar por ID
        else {
          // Obter o timezone da agenda relacionada ao agendamento
          const { data: appointmentForDelete } = await supabase
            .from('appointments')
            .select('schedule_id')
            .eq('id', appointmentId)
            .single();
          
          if (appointmentForDelete) {
            const { data: scheduleForDelete } = await supabase
              .from('schedules')
              .select('timezone')
              .eq('id', appointmentForDelete.schedule_id)
              .single();
            
            const scheduleTimezoneForDelete = scheduleForDelete?.timezone || timezone;
            console.log(`[processCheckScheduleAction] Usando timezone da agenda para cancelamento: ${scheduleTimezoneForDelete}`);
            
            operationResult = await deleteAppointment(appointmentId, session.customer_id);
            if (!operationResult.success) {
              return operationResult;
            }
          } else {
            operationResult = {
              status: "error",
              message: `Agendamento não encontrado com ID: ${appointmentId}`,
              operation,
              instructions: `The appointment with ID ${appointmentId} was not found. Inform the customer that no appointment exists with this ID.`
            };
          }
        }
        break;
        
      default:
        console.error(`[processCheckScheduleAction] Operação não suportada: ${operation}`);
        return {
          success: false,
          instructions: `The operation "${operation}" is not supported. Please try a valid operation.`
        };
    }
    
    // Adicionar informações contextuais para melhorar o resultado
    const enrichedResult = {
      ...operationResult,
      status: operationResult.success ? "success" : "error",
      operation: operation,
      data: {
        ...operationResult,
        service_name: serviceName,
        appointment_date: dayValue,
        appointment_time: timeValue,
        timezone: timezone, // Usar o timezone padrão da sessão em todos os casos
        notes: notes,
        by_arrival_time: isArrivalTimeService || byArrivalTime,
        // Incluir informações específicas para cancelamento por data
        canceled_count: operationResult.canceled_count,
        canceled_appointments: operationResult.appointments
      }
    };
    
    if (operation === 'createAppointment' && operationResult.success) {
      // Adicionar instruções específicas já foram adicionadas acima
      enrichedResult.instructions = operationResult.instructions;
    }
    
    // Salvar resultado nas variáveis da sessão
    const variables = Array.isArray(session.variables) 
      ? [...session.variables] 
      : [];
    
    variables.push({
      id: crypto.randomUUID(),
      name: 'schedule_result',
      value: enrichedResult
    });
    
    // Retornar o resultado enriquecido para que possa ser processado pelo chamador
    return enrichedResult;
  } catch (error) {
    console.error('[processCheckScheduleAction] Error:', error);
    Sentry.captureException(error);
    throw error;
  }
};

/**
 * Verifica a disponibilidade de horários para agendamento
 * @param {string} scheduleId - ID da agenda
 * @param {string} date - Data para verificação (YYYY-MM-DD)
 * @param {string} time - Horário para verificação (HH:MM)
 * @param {string} serviceId - ID do serviço
 * @returns {Object} - Resultado da verificação
 */
const checkScheduleAvailability = async (scheduleId, date, time, serviceId, timezone = 'America/Sao_Paulo') => {
  try {
    // Verificar se a agenda existe
    const { data: schedule, error: scheduleError } = await supabase
      .from('schedules')
      .select('*, timezone')
      .eq('id', scheduleId)
      .single();
      
    if (scheduleError || !schedule) {
      if (scheduleError) {
        console.error(`[checkScheduleAvailability] Erro ao buscar agenda: ${scheduleError.message}`);
      } else {
        console.error(`[checkScheduleAvailability] Agenda não encontrada com ID ${scheduleId}`);
      }
      return {
        success: false,
        instructions: `Please check the schedule configuration. The schedule with ID ${scheduleId} was not found.`
      };
    }
    
    // Utilizar o timezone da agenda
    const scheduleTimezone = schedule.timezone || timezone;
    
    // Obter nome do serviço se especificado
    let serviceName = "Not specified";
    let serviceDuration = 30; // Duração padrão em minutos
    let serviceCapacity = 1; // Capacidade padrão do serviço
    let isByArrivalTime = false; // Por padrão não é por ordem de chegada
    
    if (serviceId) {
      const { data: service } = await supabase
        .from('schedule_services')
        .select('id, title, duration, capacity, by_arrival_time')
        .eq('id', serviceId)
        .single();
        
      if (service) {
        serviceName = service.title;
        serviceCapacity = service.capacity || 1;
        isByArrivalTime = service.by_arrival_time || false;
        
        // Converter duração do formato interval para minutos
        try {
          const durationParts = service.duration.toString().split(':');
          serviceDuration = parseInt(durationParts[0]) * 60 + parseInt(durationParts[1]);
        } catch (e) {
          console.warn(`Não foi possível converter duração do serviço: ${service.duration}`, e);
        }
      }
    }
    
    // Formatar a data para exibição
    const formattedDate = new Date(date).toLocaleDateString('pt-BR');


    console.log(`[checkScheduleAvailability] Formatted date: ${formattedDate}`);
    console.log(`[checkScheduleAvailability] Time: ${time}`);
    console.log(`[checkScheduleAvailability] Service ID: ${serviceId}`);
    console.log(`[checkScheduleAvailability] Service Name: ${serviceName}`);
    console.log(`[checkScheduleAvailability] Service Duration: ${serviceDuration}`);
    console.log(`[checkScheduleAvailability] Service Capacity: ${serviceCapacity}`);
    console.log(`[checkScheduleAvailability] Is By Arrival Time: ${isByArrivalTime}`);
    
    
    
    // Se não foi especificado um horário, vamos apenas verificar se o dia tem slots disponíveis
    if (!time) {
      // Verificar disponibilidade geral para a data
      const availableSlots = await getAvailableSlots(scheduleId, date, serviceId, serviceDuration, serviceCapacity, isByArrivalTime);
      
      return {
        success: true,
        available: availableSlots.length > 0,
        date: date,
        formatted_date: formattedDate,
        requested_time: null,
        service_id: serviceId,
        service_name: serviceName,
        by_arrival_time: isByArrivalTime,
        capacity: serviceCapacity,
        available_times: availableSlots,
        timezone: scheduleTimezone,
        message: availableSlots.length > 0
          ? `Slot available for scheduling on ${date} with ${availableSlots.length} available time slots`
          : `No availability for ${date}`
      };
    }
    
    // Se foi especificado um horário, verificar especificamente este horário
    const availableSlots = await getAvailableSlots(scheduleId, date, serviceId, serviceDuration, serviceCapacity, isByArrivalTime);

    console.log('[checkScheduleAvailability] Available slots:', availableSlots);
   
    // Verificar se o horário solicitado está disponível
    const isAvailable = availableSlots.some(slot => {
      if (isByArrivalTime) {
        // Para atendimento por ordem de chegada, verificar se o horário está dentro do intervalo
        const slotStart = timeToMinutes(slot);
        const slotEnd = timeToMinutes(slot) + serviceDuration;
        const requestedTime = timeToMinutes(time);
        return requestedTime >= slotStart && requestedTime <= slotEnd;
      } else {
        // Para agendamento normal, verificar se o horário exato está disponível
        return slot === time;
      }
    });
    
    console.log('[checkScheduleAvailability] Is Available:', isAvailable);
    
    return {
      success: true,
      available: isAvailable,
      date: date,
      formatted_date: formattedDate,
      requested_time: time,
      service_id: serviceId,
      service_name: serviceName,
      by_arrival_time: isByArrivalTime,
      capacity: serviceCapacity,
      available_times: availableSlots,
      timezone: scheduleTimezone,
      message: isAvailable 
        ? isByArrivalTime
          ? `Slot available for scheduling on ${date} between ${time} and ${minutesToTime(timeToMinutes(time) + serviceDuration)}`
          : `Slot available for scheduling on ${date} at ${time}`
        : `No availability for ${date} at ${time}`
    };
  } catch (error) {
    console.error('[checkScheduleAvailability] Error:', error);
    Sentry.captureException(error);
    throw error;
  }
};

/**
 * Função auxiliar para obter slots disponíveis para uma data específica
 * @param {string} scheduleId - ID da agenda
 * @param {string} date - Data para verificação (YYYY-MM-DD)
 * @param {string} serviceId - ID do serviço
 * @param {number} duration - Duração do serviço em minutos
 * @param {number} capacity - Capacidade do serviço
 * @param {boolean} isByArrivalTime - Se é por ordem de chegada
 * @returns {Array} - Lista de horários disponíveis no formato HH:MM
 */
const getAvailableSlots = async (scheduleId, date, serviceId, duration, capacity = 1, isByArrivalTime = false) => {
  try {
    console.log('[getAvailableSlots] Schedule ID:', scheduleId);
    console.log('[getAvailableSlots] Date:', date);
    console.log('[getAvailableSlots] Service ID:', serviceId);
    console.log('[getAvailableSlots] Duration:', duration);
    console.log('[getAvailableSlots] Capacity:', capacity);
    console.log('[getAvailableSlots] Is By Arrival Time:', isByArrivalTime);
    
    
    // Obter a configuração de slot da agenda e o timezone
    const { data: scheduleConfig } = await supabase
      .from('schedules')
      .select('default_slot_duration, timezone')
      .eq('id', scheduleId)
      .single();
    
    // Duração padrão do slot (em minutos)
    const defaultSlotDuration = scheduleConfig?.default_slot_duration || 60; // 60 minutos por padrão
    // Timezone da agenda
    const scheduleTimezone = scheduleConfig?.timezone || 'America/Sao_Paulo';
    
    // Obter todos os providers ativos para esta agenda que atendem este serviço
    const { data: providers } = await supabase
      .from('schedule_providers')
      .select('id, profile_id, available_services')
      .eq('schedule_id', scheduleId)
      .eq('status', 'active');
    
    // Filtrar providers que oferecem o serviço solicitado
    let filteredProviders = providers;
    if (serviceId) {
      filteredProviders = providers.filter(provider => {
        // Se available_services estiver vazio, assume que o provider oferece todos os serviços
        if (!provider.available_services || !Array.isArray(provider.available_services) || provider.available_services.length === 0) {
          return true;
        }
        // Se não estiver vazio, verificar se o serviço está na lista
        return provider.available_services.includes(serviceId);
      });
    }
    
    // Se não temos providers disponíveis para este serviço, retornar lista vazia
    if (!filteredProviders.length) {
      return [];
    }
    
    // Converter a data para dia da semana (0-6, onde 0 é domingo)
    console.log(`[getAvailableSlots] Date: ${date}`);
    // Usar formato "YYYY-MM-DDT12:00:00Z" para garantir que o horário é 12:00 UTC, evitando problemas em qualquer fuso horário
    const dateObj = new Date(`${date}T12:00:00Z`);
    console.log(`[getAvailableSlots] Date object: ${dateObj}`);
    const dayOfWeek = dateObj.getDay();
    console.log(`[getAvailableSlots] Day of week: ${dayOfWeek}`);
    
    // Obter providerId de cada provider
    const providerIds = filteredProviders.map(p => p.id);
    
    // Buscar disponibilidade para o dia da semana e providers
    const { data: availabilities } = await supabase
      .from('schedule_availability')
      .select('provider_id, start_time, end_time')
      .in('provider_id', providerIds)
      .eq('day_of_week', dayOfWeek);

      console.log(`[getAvailableSlots] Available slots:`, availabilities);
    
    // Se não temos disponibilidade configurada para este dia da semana, retornar lista vazia
    if (!availabilities || !availabilities.length) {
      return [];
    }

    
    
    // Verificar feriados para a data específica
    const { data: holidays } = await supabase
      .from('schedule_holidays')
      .select('provider_id, start_time, end_time, all_day')
      .eq('schedule_id', scheduleId)
      .eq('date', date)
      .or(`provider_id.in.(${providerIds.join(',')}),provider_id.is.null`);
    
    // Mapear feriados por provider
    const holidaysByProvider = {};
    
    // Feriados gerais (sem provider específico afetam todos os providers)
    const generalHolidays = [];
    
    if (holidays && holidays.length > 0) {
      holidays.forEach(holiday => {
        if (!holiday.provider_id) {
          generalHolidays.push(holiday);
        } else {
          if (!holidaysByProvider[holiday.provider_id]) {
            holidaysByProvider[holiday.provider_id] = [];
          }
          holidaysByProvider[holiday.provider_id].push(holiday);
        }
      });
    }
    
    // Buscar agendamentos existentes para a data
    const { data: existingAppointments } = await supabase
      .from('appointments')
      .select('provider_id, start_time, end_time, time_slot, service_id')
      .eq('schedule_id', scheduleId)
      .eq('date', date)
      .not('status', 'in', '(canceled)');
      
    // Mapear agendamentos por provider
    const appointmentsByProvider = {};
    // Mapear contagem de agendamentos por time_slot
    const appointmentCountByTimeSlot = {};
    
    if (existingAppointments && existingAppointments.length > 0) {
      existingAppointments.forEach(apt => {
        // Manter o mapeamento por provider para verificação padrão
        if (!appointmentsByProvider[apt.provider_id]) {
          appointmentsByProvider[apt.provider_id] = [];
        }
        appointmentsByProvider[apt.provider_id].push(apt);
        
        // Para serviços por ordem de chegada, contar agendamentos por time_slot
        if (apt.service_id === serviceId && apt.time_slot) {
          if (!appointmentCountByTimeSlot[apt.time_slot]) {
            appointmentCountByTimeSlot[apt.time_slot] = 0;
          }
          appointmentCountByTimeSlot[apt.time_slot]++;
        }
      });
    }
  
    // Função auxiliar para converter minutos desde meia-noite para tempo no formato HH:MM
    const minutesToTime = (minutes) => {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
    };
    
    // Determinar slots disponíveis por provider
    let availableSlots = [];
    
    // Intervalo de slot (de quanto em quanto tempo oferecemos slots)
    const slotInterval = defaultSlotDuration; // Usar a configuração da agenda
    
    // Para atendimento por ordem de chegada, usamos faixas de horário maiores
    if (isByArrivalTime) {
      // Coletar faixas de horário para cada provider
      const timeRanges = [];
      
      availabilities.forEach(availability => {
        const providerId = availability.provider_id;
        
        // Verificar se o provider tem feriado de dia inteiro
        const hasFullDayHoliday = 
          generalHolidays.some(h => h.all_day) || 
          (holidaysByProvider[providerId] && holidaysByProvider[providerId].some(h => h.all_day));
        
        // Se o provider tem feriado de dia inteiro, pular
        if (hasFullDayHoliday) {
          return;
        }
        
        // Converter horários de início e fim para minutos
        const startMinutes = timeToMinutes(availability.start_time);
        const endMinutes = timeToMinutes(availability.end_time);
        
        // Para serviços por ordem de chegada, usamos intervalos baseados na configuração da agenda
        // Arredondar para o horário mais próximo baseado na configuração
        const roundToConfiguredSlot = (minutes) => {
          return Math.floor(minutes / defaultSlotDuration) * defaultSlotDuration;
        };
        
        // Criamos uma faixa de horário baseada na configuração da agenda
        for (let slotStart = roundToConfiguredSlot(startMinutes); slotStart < endMinutes - duration; slotStart += defaultSlotDuration) {
          const rangeStart = slotStart;
          const rangeEnd = Math.min(slotStart + defaultSlotDuration, endMinutes);
          
          if (rangeEnd - rangeStart >= duration) {
            const startTime = minutesToTime(rangeStart);
            const endTime = minutesToTime(rangeEnd);
            const timeSlot = `${startTime}-${endTime}`;
            
            // Verificar se esta faixa tem espaço disponível baseado na capacidade
            const currentCount = appointmentCountByTimeSlot[timeSlot] || 0;
            
            if (currentCount < capacity) {
              timeRanges.push(startTime);
            }
          }
        }
      });
      
      // Remover duplicatas e retornar
      return [...new Set(timeRanges)].sort();
    }
    
    // Para cada provider, calcular seus slots disponíveis (agendamento padrão)
    availabilities.forEach(availability => {
      const providerId = availability.provider_id;
      
      // Verificar se o provider tem feriado de dia inteiro
      const hasFullDayHoliday = 
        generalHolidays.some(h => h.all_day) || 
        (holidaysByProvider[providerId] && holidaysByProvider[providerId].some(h => h.all_day));
      
      // Se o provider tem feriado de dia inteiro, pular
      if (hasFullDayHoliday) {
        return;
      }
      
      // Converter horários de início e fim para minutos
      const startMinutes = timeToMinutes(availability.start_time);
      const endMinutes = timeToMinutes(availability.end_time);
      
      // Para cada slot possível no período disponível
      for (let slotStart = startMinutes; slotStart <= endMinutes - duration; slotStart += slotInterval) {
        const slotEnd = slotStart + duration;
        
        // Verificar se o slot está dentro de algum feriado parcial
        const conflictsWithHoliday = 
          generalHolidays.some(h => !h.all_day && 
            timeToMinutes(h.start_time) < slotEnd && 
            timeToMinutes(h.end_time) > slotStart) ||
          (holidaysByProvider[providerId] && holidaysByProvider[providerId].some(h => !h.all_day && 
            timeToMinutes(h.start_time) < slotEnd && 
            timeToMinutes(h.end_time) > slotStart));
        
        if (conflictsWithHoliday) {
          continue;
        }
        
        // Verificar se o slot conflita com algum agendamento existente
        const conflictsWithAppointment = 
          appointmentsByProvider[providerId] && appointmentsByProvider[providerId].some(apt => 
            timeToMinutes(apt.start_time) < slotEnd && 
            timeToMinutes(apt.end_time) > slotStart);
        
        if (conflictsWithAppointment) {
          continue;
        }
        
        // Se chegou aqui, o slot está disponível
        const slotTimeStr = minutesToTime(slotStart);
        if (!availableSlots.includes(slotTimeStr)) {
          availableSlots.push(slotTimeStr);
        }
      }
    });
    
    // Ordenar os slots disponíveis
    return availableSlots.sort();
  } catch (error) {
    console.error('[getAvailableSlots] Error:', error);
    Sentry.captureException(error);
    throw error;
  }
};

/**
 * Cria um novo agendamento
 * @param {string} scheduleId - ID da agenda
 * @param {string} customerId - ID do cliente
 * @param {string} date - Data (YYYY-MM-DD)
 * @param {string} time - Hora (HH:MM)
 * @param {string} serviceId - ID do serviço
 * @param {string} notes - Observações do agendamento
 * @returns {Object} - Resultado da criação
 */
const createAppointment = async (scheduleId, customerId, date, time, serviceId, notes, timezone = 'America/Sao_Paulo', session) => {
  try {
    // Verificar se os parâmetros obrigatórios foram fornecidos
    const requiredParams = {
      scheduleId: 'schedule ID',
      date: 'date (YYYY-MM-DD)',
      customerId: 'customer ID'
    };

    const missingParams = [];
    for (const [param, description] of Object.entries(requiredParams)) {
      if (!eval(param)) {
        missingParams.push(description);
      }
    }

    if (missingParams.length > 0) {
      console.error(`[createAppointment] Parâmetros obrigatórios não fornecidos: ${missingParams.join(', ')}`);
      return {
        success: false,
        instructions: `I need the following information to create your appointment: ${missingParams.join(', ')}. Please provide these details in your next message.`
      };
    }

    // Verificar se já existe um agendamento para este serviço no mesmo dia
    if (serviceId) {
      const { data: existingAppointments } = await supabase
        .from('appointments')
        .select('*')
        .eq('schedule_id', scheduleId)
        .eq('customer_id', customerId)
        .eq('service_id', serviceId)
        // .eq('date', date)
        .in('status', ['scheduled', 'confirmed']);

      console.log('[createAppointment] Existing Appointments:', existingAppointments);

      if (existingAppointments && existingAppointments.length > 0) {
        const appointment = existingAppointments[0];
        return {
          success: false,
          instructions: `You already have an appointment for this service on ${date} at ${appointment.start_time}. Would you like to cancel this existing appointment before creating a new one?`,
          existingAppointment: existingAppointments[0]
        };
      }
    }

    // Se o horário não foi informado, buscar horários disponíveis
    if (!time) {
      // Obter informações do serviço para determinar a duração
      const { data: serviceData } = await supabase
        .from('services')
        .select('duration, name')
        .eq('id', serviceId)
        .single();

      const serviceDuration = serviceData?.duration || 60;
      const serviceName = serviceData?.name || "Not specified";

      // Buscar horários disponíveis
      const availableSlots = await getAvailableSlots(scheduleId, date, serviceId, serviceDuration);
      console.log('[createAppointment] Available Slots:', availableSlots);

      if (availableSlots.length === 0) {
        return {
          success: false,
          instructions: `There are no available slots for ${serviceName} on ${date}. Please choose another date.`,
          availableSlots: []
        };
      }

      // Formatar os horários disponíveis para exibição
      const formattedSlots = availableSlots.join(', ');
      console.log('[createAppointment] Formatted Slots:', formattedSlots);
      
      return {
        success: false,
        instructions: `For ${serviceName} on ${date}, the available slots are: ${formattedSlots}. Please choose one of these slots for your appointment.`,
        availableSlots: availableSlots
      };
    }

    // Obter informações do serviço e da agenda para determinar duração, slots e capacidade
    let serviceEndTime = time;
    let serviceName = "Not specified";
    let isByArrivalTime = false;
    let serviceCapacity = 1;
    let slotDuration = 60; // Padrão de 60 minutos, será atualizado conforme configuração da agenda
    
    // Obter a configuração de slot da agenda
    const { data: scheduleConfig } = await supabase
      .from('schedules')
      .select('default_slot_duration, name, timezone')
      .eq('id', scheduleId)
      .single();
    
    if (scheduleConfig) {
      slotDuration = scheduleConfig.default_slot_duration || 60;
    }
    
    // Usar o timezone da agenda em vez do timezone padrão
    const scheduleTimezone = scheduleConfig?.timezone || timezone;
    
    if (serviceId) {
      const { data: service } = await supabase
        .from('schedule_services')
        .select('title, duration, capacity, by_arrival_time')
        .eq('id', serviceId)
        .single();
      
      if (service) {
        serviceName = service.title;
        serviceCapacity = service.capacity || 1;
        isByArrivalTime = service.by_arrival_time || false;
        
        // Calcular horário de término baseado na duração do serviço
        try {
          // Converter hora inicial para minutos desde meia-noite
          const [hours, minutes] = time.split(':').map(Number);
          const startMinutes = hours * 60 + minutes;
          
          // Obter duração em minutos
          let durationMinutes = 30; // Padrão de 30 minutos
          const durationParts = service.duration.toString().split(':');
          durationMinutes = (parseInt(durationParts[0]) * 60) + parseInt(durationParts[1]);
          
          // Calcular hora de término
          let endMinutes;
          
          if (isByArrivalTime) {
            // Se é por ordem de chegada, o término é baseado no tamanho do slot configurado
            // Calcular o próximo múltiplo da duração do slot a partir do início
            endMinutes = Math.ceil(startMinutes / slotDuration) * slotDuration;
            if (endMinutes - startMinutes < durationMinutes) {
              endMinutes += slotDuration; // Adicionar mais um slot se não couber no atual
            }
          } else {
            // Término baseado na duração do serviço
            endMinutes = startMinutes + durationMinutes;
          }
          
          const endHours = Math.floor(endMinutes / 60);
          const endMins = endMinutes % 60;
          
          serviceEndTime = `${endHours.toString().padStart(2, '0')}:${endMins.toString().padStart(2, '0')}`;
        } catch (e) {
          console.warn(`Erro ao calcular horário de término baseado na duração: ${service.duration}`, e);
          // Usar uma duração padrão de 30 minutos se não conseguir calcular
          const [hours, minutes] = time.split(':').map(Number);
          let endHours = hours;
          let endMinutes = minutes + 30;
          
          if (endMinutes >= 60) {
            endHours += 1;
            endMinutes -= 60;
          }
          
          serviceEndTime = `${endHours.toString().padStart(2, '0')}:${endMinutes.toString().padStart(2, '0')}`;
        }
      }
    }
    
    // Verificar se o horário está disponível
    const availabilityResult = await checkScheduleAvailability(scheduleId, date, time, serviceId, scheduleTimezone);

    console.log('[createAppointment] Availability Result:', availabilityResult);
    
    if (!availabilityResult.available) {
      console.error(`[createAppointment] Horário não disponível: ${date} ${time}`);
      return {
        success: false,
        instructions: `Please inform the customer that the requested time slot is not available. Available slots: ${availabilityResult.available_times}`
      };
    }
    
    // Para serviços por ordem de chegada, verificar se ainda há capacidade disponível
    if (isByArrivalTime) {
      const timeSlot = `${time}-${serviceEndTime}`;
      
      // Verificar quantos agendamentos já existem neste time_slot
      const { data: existingCount, error: countError } = await supabase
        .from('appointments')
        .select('id', { count: 'exact' })
        .eq('schedule_id', scheduleId)
        .eq('date', date)
        .eq('time_slot', timeSlot)
        .eq('service_id', serviceId)
        .not('status', 'in', '(canceled)');
      
      if (countError) {
        throw countError;
      }
      
      if (existingCount.length >= serviceCapacity) {
        console.error(`[createAppointment] Capacidade máxima atingida: ${serviceCapacity}`);
        return {
          success: false,
          instructions: `Please inform the customer that this time slot is already at maximum capacity (${serviceCapacity}).`
        };
      }
    }
    
    // Encontrar um provider disponível para este horário
    const availableProvider = await findAvailableProvider(scheduleId, date, time, serviceEndTime, serviceId);
    
    if (!availableProvider) {
      console.error(`[createAppointment] Nenhum provider disponível para ${date} ${time}`);
      return {
        success: false,
        instructions: `Please inform the customer that there are no available providers for this service at ${date} ${time}.`
      };
    }
    
    // Definir o time_slot baseado no tipo de serviço
    const timeSlot = isByArrivalTime 
      ? `${time}-${serviceEndTime}` 
      : time;
    
    // Criar o agendamento
    const { data: appointment, error: appointmentError } = await supabase
      .from('appointments')
      .insert({
        schedule_id: scheduleId,
        provider_id: availableProvider.profile_id, // Usar profile_id em vez de id
        service_id: serviceId,
        customer_id: customerId,
        status: 'scheduled',
        date: date,
        start_time: time,
        end_time: serviceEndTime,
        time_slot: timeSlot,
        notes: notes || '',
        chat_id: session.chat_id,
        metadata: {
          created_via: 'agent_ia',
          creation_date: new Date().toISOString(),
          by_arrival_time: isByArrivalTime
        }
      })
      .select()
      .single();
    
    if (appointmentError) {
      throw appointmentError;
    }

    // Buscar informações do cliente para a notificação
    const { data: customer } = await supabase
      .from('customers')
      .select('name, email, phone')
      .eq('id', customerId)
      .single();
    
    // Buscar todos os providers ativos desta agenda para enviar notificações
    const { data: providers } = await supabase
      .from('schedule_providers')
      .select('profile_id')
      .eq('schedule_id', scheduleId)
      .eq('status', 'active');
    
    // Se temos providers e o cliente, enviar notificações
    if (providers && providers.length > 0 && customer) {
      // Enviar notificação em segundo plano, sem aguardar
      (async () => {
        try {
          // Importar o módulo OneSignal
          const oneSignal = await import('../lib/oneSignal.js');
          
          // Extrair IDs dos profiles para notificação
          const profileIds = providers.map(provider => provider.profile_id);
          
          // Criar o conteúdo da notificação
          const notificationHeading = 'Novo agendamento';
          const notificationContent = `${customer.name} agendou ${serviceName} para ${date} às ${time}`;
          
          // Criar o objeto de dados da notificação com a URL para a página de agendamentos
          const frontendUrl = process.env.FRONTEND_URL || 'https://app.interflow.ai';
          const notificationData = {
            type: 'appointment',
            appointment_id: appointment.id,
            url: `${frontendUrl}/app/schedules/${scheduleId}`,
            schedule_id: scheduleId
          };
          
          // Enviar notificação para todos os providers
          await oneSignal.default.sendNotification({
            heading: notificationHeading,
            content: notificationContent,
            include_aliases: {
              external_id: profileIds
            },
            data: notificationData
          });
          
          console.log(`[createAppointment] Notificação enviada para ${profileIds.length} providers`);
        } catch (notificationError) {
          console.error('[createAppointment] Error sending notification:', notificationError);
          Sentry.captureException(notificationError, {
            tags: {
              type: 'notification_error',
              appointmentId: appointment.id
            }
          });
        }
      })();
    }
    
    // Formatar a data para exibição
    const formattedDate = new Date(date).toLocaleDateString('pt-BR');
    
    // Retornar informações do agendamento criado
    return {
      success: true,
      appointment_id: appointment.id,
      date: date,
      formatted_date: formattedDate,
      time: time,
      end_time: serviceEndTime,
      time_slot: timeSlot,
      by_arrival_time: isByArrivalTime,
      service_id: serviceId,
      service_name: serviceName,
      provider_id: availableProvider.profile_id,
      timezone: scheduleTimezone,
      notes: notes,
      message: isByArrivalTime
        ? `Appointment confirmed for ${date} between ${time} and ${serviceEndTime} (${scheduleTimezone} timezone)`
        : `Appointment confirmed for ${date} at ${time} (${scheduleTimezone} timezone)`
    };
  } catch (error) {
    console.error('[createAppointment] Error:', error);
    Sentry.captureException(error);
    throw error;
  }
};

/**
 * Função auxiliar para encontrar um provider disponível para o horário
 * @param {string} scheduleId - ID da agenda
 * @param {string} date - Data (YYYY-MM-DD)
 * @param {string} startTime - Hora de início (HH:MM)
 * @param {string} endTime - Hora de término (HH:MM)
 * @param {string} serviceId - ID do serviço
 * @returns {Object} - Provider disponível ou null
 */
const findAvailableProvider = async (scheduleId, date, startTime, endTime, serviceId) => {
  try {
    // Obter todos os providers ativos para esta agenda
    const { data: providers } = await supabase
      .from('schedule_providers')
      .select('id, profile_id, available_services')
      .eq('schedule_id', scheduleId)
      .eq('status', 'active');
    
    if (!providers || providers.length === 0) {
      return null;
    }
    
    // Filtrar providers que oferecem o serviço solicitado
    let eligibleProviders = providers;
    if (serviceId) {
      eligibleProviders = providers.filter(provider => {
        // Se available_services estiver vazio, assume que o provider oferece todos os serviços
        if (!provider.available_services || !Array.isArray(provider.available_services) || provider.available_services.length === 0) {
          return true;
        }
        // Se não estiver vazio, verificar se o serviço está na lista
        return provider.available_services.includes(serviceId);
      });
    }
    
    if (eligibleProviders.length === 0) {
      return null;
    }
    
    // Converter a data para dia da semana (0-6, onde 0 é domingo)
    const dateObj = new Date(`${date}T12:00:00Z`); // Usar formato UTC para evitar problemas em qualquer fuso horário
    const dayOfWeek = dateObj.getDay();
    
    // Obter providerId de cada provider
    const providerIds = eligibleProviders.map(p => p.id);
    
    // Buscar disponibilidade para o dia da semana e providers
    const { data: availabilities } = await supabase
      .from('schedule_availability')
      .select('provider_id, start_time, end_time')
      .in('provider_id', providerIds)
      .eq('day_of_week', dayOfWeek);
    
    if (!availabilities || availabilities.length === 0) {
      return null;
    }
    
    // Converter horários de início e fim do agendamento para minutos
    const appointmentStartMinutes = timeToMinutes(startTime);
    const appointmentEndMinutes = timeToMinutes(endTime);
    
    // Verificar feriados para a data específica
    const { data: holidays } = await supabase
      .from('schedule_holidays')
      .select('provider_id, start_time, end_time, all_day')
      .eq('schedule_id', scheduleId)
      .eq('date', date)
      .or(`provider_id.in.(${providerIds.join(',')}),provider_id.is.null`);
    
    // Mapear feriados por provider
    const holidaysByProvider = {};
    
    // Feriados gerais (sem provider específico afetam todos os providers)
    const generalHolidays = [];
    
    if (holidays && holidays.length > 0) {
      holidays.forEach(holiday => {
        if (!holiday.provider_id) {
          generalHolidays.push(holiday);
        } else {
          if (!holidaysByProvider[holiday.provider_id]) {
            holidaysByProvider[holiday.provider_id] = [];
          }
          holidaysByProvider[holiday.provider_id].push(holiday);
        }
      });
    }
    
    // Buscar agendamentos existentes para a data
    const { data: existingAppointments } = await supabase
      .from('appointments')
      .select('provider_id, start_time, end_time')
      .eq('schedule_id', scheduleId)
      .eq('date', date)
      .in('status', ['scheduled', 'confirmed']);
    
    // Mapear agendamentos por provider
    const appointmentsByProvider = {};
    if (existingAppointments && existingAppointments.length > 0) {
      existingAppointments.forEach(apt => {
        if (!appointmentsByProvider[apt.provider_id]) {
          appointmentsByProvider[apt.provider_id] = [];
        }
        appointmentsByProvider[apt.provider_id].push(apt);
      });
    }
    
    // Para cada provider, verificar se está disponível para o horário solicitado
    for (const provider of eligibleProviders) {
      const providerId = provider.id;
      
      // Verificar se o provider tem disponibilidade configurada para este dia da semana
      const providerAvailability = availabilities.find(a => a.provider_id === providerId);
      if (!providerAvailability) {
        continue;
      }
      
      // Verificar se o provider tem feriado de dia inteiro
      const hasFullDayHoliday = 
        generalHolidays.some(h => h.all_day) || 
        (holidaysByProvider[providerId] && holidaysByProvider[providerId].some(h => h.all_day));
      
      if (hasFullDayHoliday) {
        continue;
      }
      
      // Verificar se o horário solicitado está dentro do período de disponibilidade do provider
      const availabilityStartMinutes = timeToMinutes(providerAvailability.start_time);
      const availabilityEndMinutes = timeToMinutes(providerAvailability.end_time);
      
      if (appointmentStartMinutes < availabilityStartMinutes || appointmentEndMinutes > availabilityEndMinutes) {
        continue;
      }
      
      // Verificar se o horário solicitado não conflita com feriados parciais
      const conflictsWithHoliday = 
        generalHolidays.some(h => !h.all_day && 
          timeToMinutes(h.start_time) < appointmentEndMinutes && 
          timeToMinutes(h.end_time) > appointmentStartMinutes) ||
        (holidaysByProvider[providerId] && holidaysByProvider[providerId].some(h => !h.all_day && 
          timeToMinutes(h.start_time) < appointmentEndMinutes && 
          timeToMinutes(h.end_time) > appointmentStartMinutes));
      
      if (conflictsWithHoliday) {
        continue;
      }
      
      // Verificar se o horário solicitado não conflita com agendamentos existentes
      const conflictsWithAppointment = 
        appointmentsByProvider[providerId] && appointmentsByProvider[providerId].some(apt => 
          timeToMinutes(apt.start_time) < appointmentEndMinutes && 
          timeToMinutes(apt.end_time) > appointmentStartMinutes);
      
      if (conflictsWithAppointment) {
        continue;
      }
      
      // Se chegou aqui, o provider está disponível para o horário solicitado
      return provider;
    }
    
    // Se não encontrou nenhum provider disponível
    return null;
    
  } catch (error) {
    console.error('[findAvailableProvider] Error:', error);
    Sentry.captureException(error);
    throw error;
  }
};

/**
 * Verifica agendamentos de um cliente
 * @param {string} customerId - ID do cliente
 * @param {string} appointmentId - ID do agendamento específico (opcional)
 * @returns {Object} - Resultado da verificação
 */
const checkAppointment = async (customerId, appointmentId) => {
  try {
    if (!customerId) {
      console.error('[checkAppointment] ID do cliente não fornecido');
      return {
        success: false,
        instructions: "Please provide a valid customer ID to check appointments."
      };
    }
    
    // Construir a consulta base
    let query = supabase
      .from('appointments')
      .select(`
        id, 
        date, 
        start_time, 
        end_time, 
        status, 
        notes,
        provider_id,
        schedule_id,
        service_id,
        schedules(title),
        schedule_services(title, price, currency, duration),
        profiles(full_name)
      `)
      .eq('customer_id', customerId)
      .in('status', ['scheduled', 'confirmed']);
    
    // Se um ID específico foi fornecido, filtrar por ele
    if (appointmentId) {
      query = query.eq('id', appointmentId);
    } else {
      // Se não, ordenar por data e hora mais recentes
      query = query.order('date', { ascending: true })
              .order('start_time', { ascending: true });
    }
    
    // Executar a consulta
    const { data, error } = await query;
    
    if (error) {
      throw error;
    }
    
    // Se não encontrou nenhum agendamento
    const appointments = data || [];
    
    if (appointmentId && (!appointments || appointments.length === 0)) {
      console.error(`[checkAppointment] Agendamento não encontrado com ID ${appointmentId}`);
      return {
        success: false,
        instructions: `Please inform the customer that no appointment was found with ID ${appointmentId}.`
      };
    }
    
    // Formatar os resultados
    const formattedAppointments = appointments.map(apt => ({
      id: apt.id,
      date: apt.date,
      time: apt.start_time,
      end_time: apt.end_time,
      status: apt.status,
      schedule_name: apt.schedules?.name || 'Agenda não especificada',
      service_name: apt.schedule_services?.title || 'Serviço não especificado',
      provider_name: apt.profiles?.name || 'Profissional não especificado',
      service_duration: apt.schedule_services?.duration || '00:30:00',
      service_price: apt.schedule_services?.price || 0,
      service_currency: apt.schedule_services?.currency || 'BRL',
      notes: apt.notes
    }));
    
    return {
      success: true,
      appointments: formattedAppointments,
      count: appointments.length,
      message: appointmentId
        ? `Appointment found for ${formattedAppointments[0].date} at ${formattedAppointments[0].time}`
        : `Found ${appointments.length} appointment(s)`
    };
  } catch (error) {
    console.error('[checkAppointment] Error:', error);
    Sentry.captureException(error);
    throw error;
  }
};

/**
 * Cancela um agendamento
 * @param {string} appointmentId - ID do agendamento (opcional se date for fornecido)
 * @param {string} customerId - ID do cliente
 * @param {string} date - Data do agendamento (formato YYYY-MM-DD, opcional se appointmentId for fornecido)
 * @returns {Object} - Resultado do cancelamento
 */
const deleteAppointment = async (appointmentId, customerId, date) => {
  try {
    if (!customerId) {
      console.error('[deleteAppointment] ID do cliente não fornecido');
      return {
        success: false,
        instructions: "Please provide a valid customer ID to delete appointments."
      };
    }
    
    // Se tivermos um ID específico, tentar cancelar por ID
    if (appointmentId) {
      // Verificar se o agendamento existe e pertence ao cliente
      const { data: appointment, error: fetchError } = await supabase
        .from('appointments')
        .select('*')
        .eq('id', appointmentId)
        .eq('customer_id', customerId)
        .in('status', ['scheduled', 'confirmed'])
        .single();

      if (fetchError) {
        if (fetchError.code === 'PGRST116') {
          console.error('[deleteAppointment] Agendamento não encontrado ou não pertence ao cliente');
          return {
            success: false,
            instructions: "Please inform the customer that the appointment was not found or doesn't belong to them."
          };
        }
        throw fetchError;
      }

      // Atualizar o status do agendamento
      const { error: updateError } = await supabase
        .from('appointments')
        .update({ 
          status: 'canceled',
          metadata: {
            canceled_at: new Date().toISOString(),
            canceled_via: 'agent_ia'
          }
         })
        .eq('id', appointmentId);

      if (updateError) throw updateError;

      return {
        success: true,
        message: `Agendamento para ${appointment.date} às ${appointment.start_time} cancelado com sucesso.`,
        instructions: `The appointment for ${appointment.date} at ${appointment.start_time} has been successfully canceled. Confirm to the customer that the cancellation was processed.`,
        data: {
          appointmentId,
          date: appointment.date,
          time: appointment.start_time,
          status: 'cancelled'
        }
      };
    }
    
    // Se não foi fornecido um ID de agendamento, mas foi fornecida uma data
    if (!appointmentId && date) {
      // Buscar todos os agendamentos do cliente para a data especificada
      const { data: appointments, error: searchError } = await supabase
        .from('appointments')
        .select(`
          id, 
          date, 
          start_time, 
          end_time,
          schedule_id,
          service_id,
          provider_id,
          schedule_services(title),
          metadata
        `)
        .eq('customer_id', customerId)
        .eq('date', date)
        .in('status', ['scheduled', 'confirmed']);
      
      if (searchError) {
        throw searchError;
      }
      
      if (!appointments || appointments.length === 0) {
        console.error(`[deleteAppointment] Nenhum agendamento encontrado para a data ${date}`);
        return {
          success: false,
          instructions: `Please inform the customer that no appointments were found for the specified date ${date}.`
        };
      }
      
      // Cancelar todos os agendamentos encontrados
      let canceledCount = 0;
      const canceledAppointments = [];
      
      for (const appointment of appointments) {
        const { error: updateError } = await supabase
          .from('appointments')
          .update({
            status: 'canceled',
            metadata: {
              ...appointment.metadata,
              canceled_at: new Date().toISOString(),
              canceled_via: 'agent_ia'
            }
          })
          .eq('id', appointment.id);
        
        if (!updateError) {
          canceledCount++;
          canceledAppointments.push({
            id: appointment.id,
            date: appointment.date,
            time: appointment.start_time,
            service: appointment.schedule_services?.title || 'Serviço não especificado'
          });
        }
      }
      
      // Buscar informações do cliente para a notificação
      const { data: customer } = await supabase
        .from('customers')
        .select('name, email, phone')
        .eq('id', customerId)
        .single();
      
      // Se cancelamos algum agendamento, enviar notificações para os providers
      if (canceledCount > 0 && customer) {
        // Enviar notificação em segundo plano, sem aguardar
        (async () => {
          try {
            // Importar o módulo OneSignal
            const oneSignal = await import('../lib/oneSignal.js');
            
            // Para cada agendamento cancelado, notificar os providers
            for (const canceledAppointment of canceledAppointments) {
              // Buscar providers desta agenda
              const { data: providers } = await supabase
                .from('schedule_providers')
                .select('profile_id')
                .eq('schedule_id', canceledAppointment.schedule_id)
                .eq('status', 'active');
              
              if (providers && providers.length > 0) {
                // Extrair IDs dos profiles para notificação
                const profileIds = providers.map(provider => provider.profile_id);
                
                // Criar o conteúdo da notificação
                const notificationHeading = 'Agendamento cancelado';
                const notificationContent = `${customer.name} cancelou o agendamento para ${canceledAppointment.date} às ${canceledAppointment.time}`;
                
                // Criar o objeto de dados da notificação com a URL para a página de agendamentos
                const frontendUrl = process.env.FRONTEND_URL || 'https://app.interflow.ai';
                const notificationData = {
                  type: 'appointment_canceled',
                  appointment_id: canceledAppointment.id,
                  url: `${frontendUrl}/app/schedules/${canceledAppointment.schedule_id}`,
                  schedule_id: canceledAppointment.schedule_id
                };
                
                // Enviar notificação para todos os providers
                await oneSignal.default.sendNotification({
                  heading: notificationHeading,
                  content: notificationContent,
                  include_aliases: {
                    external_id: profileIds
                  },
                  data: notificationData
                });
              }
            }
            
            console.log(`[deleteAppointment] Notificações de cancelamento enviadas para ${canceledCount} agendamentos`);
          } catch (notificationError) {
            console.error('[deleteAppointment] Error sending notification:', notificationError);
            Sentry.captureException(notificationError, {
              tags: {
                type: 'notification_error',
                appointmentId: appointment.id
              }
            });
          }
        })();
      }
      
      // Retornar informações dos agendamentos cancelados
      return {
        success: true,
        canceled_count: canceledCount,
        appointments: canceledAppointments,
        message: `Cancelado(s) ${canceledCount} agendamento(s) para ${date}`,
        instructions: `Successfully canceled ${canceledCount} appointment(s) for ${date}. Inform the customer that their appointments have been canceled.`
      };
    }
    // Caso contrário, exigir um ID de agendamento específico
    else if (!appointmentId) {
      console.error('[deleteAppointment] ID do agendamento ou data não fornecidos');
      return {
        success: false,
        instructions: "Please ask the customer to provide either an appointment ID or a date."
      };
    }
    
    // Verificar se o agendamento específico existe e pertence ao cliente
    const { data: appointment, error: checkError } = await supabase
      .from('appointments')
      .select(`
        id, 
        date, 
        start_time, 
        end_time,
        schedule_id,
        service_id,
        provider_id,
        schedule_services(title),
        metadata
      `)
      .eq('id', appointmentId)
      .eq('customer_id', customerId)
      .in('status', ['scheduled', 'confirmed'])
      .single();
    
    if (checkError || !appointment) {
      if (checkError) {
        console.error(`[deleteAppointment] Erro ao verificar agendamento: ${checkError.message}`);
      } else {
        console.error(`[deleteAppointment] Agendamento não encontrado com ID ${appointmentId}`);
      }
      return {
        success: false,
        instructions: "Please inform the customer that the appointment was not found or doesn't belong to them."
      };
    }
    
    // Atualizar status para cancelado
    const { error: updateError } = await supabase
      .from('appointments')
      .update({
        status: 'canceled',
        metadata: {
          ...appointment.metadata,
          canceled_at: new Date().toISOString(),
          canceled_via: 'agent_ia'
        }
      })
      .eq('id', appointmentId);
    
    if (updateError) {
      throw updateError;
    }
    
    // Buscar informações do cliente para a notificação
    const { data: customer } = await supabase
      .from('customers')
      .select('name, email, phone')
      .eq('id', customerId)
      .single();
    
    // Buscar todos os providers ativos desta agenda para enviar notificações
    const { data: providers } = await supabase
      .from('schedule_providers')
      .select('profile_id')
      .eq('schedule_id', appointment.schedule_id)
      .eq('status', 'active');
    
    // Se temos providers e o cliente, enviar notificações
    if (providers && providers.length > 0 && customer) {
      // Enviar notificação em segundo plano, sem aguardar
      (async () => {
        try {
          // Importar o módulo OneSignal
          const oneSignal = await import('../lib/oneSignal.js');
          
          // Extrair IDs dos profiles para notificação
          const profileIds = providers.map(provider => provider.profile_id);
          
          // Criar o conteúdo da notificação
          const notificationHeading = 'Agendamento cancelado';
          const notificationContent = `${customer.name} cancelou o agendamento para ${appointment.date} às ${appointment.start_time}`;
          
          // Criar o objeto de dados da notificação com a URL para a página de agendamentos
          const frontendUrl = process.env.FRONTEND_URL || 'https://app.interflow.ai';
          const notificationData = {
            type: 'appointment_canceled',
            appointment_id: appointmentId,
            url: `${frontendUrl}/app/schedules/${appointment.schedule_id}`,
            schedule_id: appointment.schedule_id
          };
          
          // Enviar notificação para todos os providers
          await oneSignal.default.sendNotification({
            heading: notificationHeading,
            content: notificationContent,
            include_aliases: {
              external_id: profileIds
            },
            data: notificationData
          });
          
          console.log(`[deleteAppointment] Notificação de cancelamento enviada para ${profileIds.length} providers`);
        } catch (notificationError) {
          console.error('[deleteAppointment] Error sending notification:', notificationError);
          Sentry.captureException(notificationError, {
            tags: {
              type: 'notification_error',
              appointmentId: appointment.id
            }
          });
        }
      })();
    }
    
    return {
      success: true,
      appointment_id: appointmentId,
      date: appointment.date,
      time: appointment.start_time,
      service_name: appointment.schedule_services?.title || 'Serviço não especificado',
      message: `Agendamento de ${appointment.date} às ${appointment.start_time} cancelado com sucesso`,
      instructions: `The appointment for ${appointment.date} at ${appointment.start_time} has been successfully canceled. Confirm to the customer that the cancellation was processed.`
    };
  } catch (error) {
    console.error('[deleteAppointment] Error:', error);
    Sentry.captureException(error);
    throw error;
  }
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
      value = variable ? variable.value : '';
    } else if (typeof variables === 'object') {
      // Acessa diretamente a propriedade do objeto
      value = variables[trimmedName] || '';
    }
    
    // Se o valor for undefined ou null, retorna string vazia
    return value || '';
  }).replace(/\s+/g, ' ').trim(); // Remove espaços extras e espaços no início/fim
};

/**
 * Transforms the result data into a format more suitable for contextualization
 * @param {Object} result - Operation result
 * @returns {Object} - Transformed data for contextualization
 */
const transformResultData = (result) => {
  if (!result.data) return {};
  
  const { action_type } = result;
  
  // Format data based on specific action type
  switch (action_type) {
    case 'update_customer':
      return {
        customer_id: result.data.id,
        customer_name: result.data.nome,
        customer_email: result.data.email,
        customer_phone: result.data.telefone,
        funnel_name: result.data.funil,
        stage_name: result.data.estagio,
        funnel_id: result.data.funil_id,
        stage_id: result.data.estagio_id,
        updates: result.updates
      };
      
    case 'update_chat':
      return {
        chat_id: result.data.id,
        chat_title: result.data.titulo,
        chat_status: result.data.status,
        team_name: result.data.equipe,
        updated_at: result.data.data_atualizacao,
        updates: result.updates
      };
      
    case 'start_flow':
      return {
        flow_name: result.data.fluxo,
        flow_id: result.data.fluxo_id,
        session_id: result.data.sessao_id,
        customer_name: result.data.cliente,
        started_at: result.data.data_inicio
      };
      
    case 'check_schedule':
      // For scheduling operations
      const baseData = {
        service_name: result.data.service_name,
        operation: result.operation
      };
      
      // Add specific data based on operation type
      if (result.operation === 'checkAvailability') {
        return {
          ...baseData,
          date: result.data.appointment_date,
          time: result.data.appointment_time,
          available: result.data.available,
          available_times: result.data.available_times
        };
      } else if (result.operation === 'createAppointment') {
        return {
          ...baseData,
          appointment_id: result.data.appointment_id,
          date: result.data.appointment_date,
          time: result.data.appointment_time,
          notes: result.data.notes
        };
      } else if (result.operation === 'checkAppointment') {
        return {
          ...baseData,
          appointments: result.data.appointments,
          count: result.data.count
        };
      } else if (result.operation === 'deleteAppointment') {
        // Para listagem de agendamentos (sem cancelamento)
        if (result.data.list_only) {
          // Se é um único agendamento
          if (result.data.single_appointment) {
            return {
              ...baseData,
              list_only: true,
              single_appointment: true,
              appointment: result.data.appointment,
              instructions: result.data.instructions || 'Ask the customer if they want to cancel this appointment.'
            };
          }
          // Se são múltiplos agendamentos
          return {
            ...baseData,
            list_only: true,
            appointments: result.data.appointments,
            count: result.data.count,
            instructions: result.data.instructions || 'Ask the customer to choose which appointment they want to cancel by specifying a date or ID.'
          };
        }
        // Para exclusão por ID específico
        else if (result.data.appointment_id) {
          return {
            ...baseData,
            appointment_id: result.data.appointment_id,
            date: result.data.appointment_date,
            time: result.data.appointment_time,
            instructions: result.data.instructions || 'Inform the customer that their appointment has been successfully canceled.'
          };
        } 
        // Para exclusão por data (múltiplos agendamentos)
        else if (result.data.canceled_count) {
          return {
            ...baseData,
            canceled_count: result.data.canceled_count,
            canceled_appointments: result.data.canceled_appointments,
            date: result.data.appointment_date,
            instructions: result.data.instructions || 'Inform the customer that their appointments have been successfully canceled.'
          };
        }
        // Caso padrão
        return baseData;
      }
      
      return baseData;
      
    default:
      // For other action types, return data as is
      return result.data;
  }
}; 

/**
 * Processa uma ação de atualização de cliente
 * @param {Object} action - Configuração da ação
 * @param {Object} args - Argumentos da ferramenta
 * @param {Object} session - Sessão atual
 * @returns {Object} - Resultado da atualização
 */
const processUpdateCustomerAction = async (action, args, session) => {
  try {
    const config = action.config || {};
    const updates = {};
    
    // Processar o nome do cliente (direto ou via mapeamento)
    if (config.name) {
      updates.name = config.name;
    } else if (config.nameMapping && config.nameMapping.variable && config.nameMapping.mapping) {
      const variableValue = args[config.nameMapping.variable];
      if (variableValue && config.nameMapping.mapping[variableValue]) {
        updates.name = config.nameMapping.mapping[variableValue];
      }
    }
    
    // Processar o funil/estágio do cliente (direto ou via mapeamento)
    if (config.funnelId) {
      updates.funnel_id = config.funnelId;
      
      if (config.stageId) {
        updates.stage_id = config.stageId;
      }
    } else if (config.funnelMapping && config.funnelMapping.variable && config.funnelMapping.mapping) {
      const variableValue = args[config.funnelMapping.variable];
      if (variableValue && config.funnelMapping.mapping[variableValue]) {
        updates.funnel_id = config.funnelMapping.mapping[variableValue];
      }
    }
    
    // Atualizar cliente no banco de dados se houver atualizações
    if (Object.keys(updates).length > 0) {
      console.log(`[processUpdateCustomerAction] Atualizando cliente ${session.customer_id} com:`, updates);
      
      const { error } = await supabase
        .from('customers')
        .update(updates)
        .eq('id', session.customer_id);
      
      if (error) {
        throw error;
      }
      
      // Buscar o cliente atualizado
      const { data: customer } = await supabase
        .from('customers')
        .select('*')
        .eq('id', session.customer_id)
        .single();
      
      // Buscar informações adicionais sobre funil e estágio se tiverem sido atualizados
      let funnelInfo = null;
      let stageInfo = null;
      
      if (updates.funnel_id) {
        try {
          const { data: funnel } = await supabase
            .from('funnels')
            .select('id, name')
            .eq('id', customer.funnel_id)
            .single();
            
          if (funnel) {
            funnelInfo = funnel;
          }
        } catch (error) {
          console.warn(`[processUpdateCustomerAction] Erro ao buscar informações do funil:`, error);
        }
      }
      
      if (updates.stage_id) {
        try {
          const { data: stage } = await supabase
            .from('funnel_stages')
            .select('id, name')
            .eq('id', customer.stage_id)
            .single();
            
          if (stage) {
            stageInfo = stage;
          }
        } catch (error) {
          console.warn(`[processUpdateCustomerAction] Erro ao buscar informações do estágio:`, error);
        }
      }
      
      return {
        status: "success",
        message: `Customer data successfully updated.`,
        data: {
          id: customer.id,
          nome: customer.name,
          email: customer.email,
          telefone: customer.phone,
          funil: funnelInfo ? funnelInfo.name : null,
          estagio: stageInfo ? stageInfo.name : null,
          funil_id: customer.funnel_id,
          estagio_id: customer.stage_id
        },
        updates: Object.keys(updates).map(field => {
          const fieldName = field === 'name' ? 'Nome' : 
                          field === 'funnel_id' ? 'Funil' : 
                          field === 'stage_id' ? 'Estágio' : field;
          return `${fieldName}: ${updates[field]}`;
        }).join(', ')
      };
    }
    
    return {
      status: "info",
      message: "No updates needed for customer."
    };
  } catch (error) {
    console.error('[processUpdateCustomerAction] Erro:', error);
    Sentry.captureException(error);
    throw error;
  }
};

/**
 * Processa uma ação de atualização de chat
 * @param {Object} action - Configuração da ação
 * @param {Object} args - Argumentos da ferramenta
 * @param {Object} session - Sessão atual
 * @returns {Object} - Resultado da atualização
 */
const processUpdateChatAction = async (action, args, session) => {
  try {
    const config = action.config || {};
    const updates = {};
    
    // Processar status do chat (direto ou via mapeamento)
    if (config.status) {
      updates.status = config.status;
    } else if (config.statusMapping && config.statusMapping.variable && config.statusMapping.mapping) {
      const variableValue = args[config.statusMapping.variable];
      if (variableValue && config.statusMapping.mapping[variableValue]) {
        updates.status = config.statusMapping.mapping[variableValue];
      }
    }
    
    // Processar título do chat (direto ou via mapeamento)
    if (config.title) {
      updates.title = config.title;
    } else if (config.titleMapping && config.titleMapping.variable && config.titleMapping.mapping) {
      const variableValue = args[config.titleMapping.variable];
      if (variableValue && config.titleMapping.mapping[variableValue]) {
        updates.title = config.titleMapping.mapping[variableValue];
      }
    }
    
    // Processar equipe do chat (direto ou via mapeamento)
    if (config.teamId) {
      updates.team_id = config.teamId;
    } else if (config.teamMapping && config.teamMapping.variable && config.teamMapping.mapping) {
      const variableValue = args[config.teamMapping.variable];
      if (variableValue && config.teamMapping.mapping[variableValue]) {
        updates.team_id = config.teamMapping.mapping[variableValue];
      }
    }
    
    // Atualizar chat no banco de dados se houver atualizações
    if (Object.keys(updates).length > 0) {
      console.log(`[processUpdateChatAction] Atualizando chat ${session.chat_id} com:`, updates);
      
      const { error } = await supabase
        .from('chats')
        .update(updates)
        .eq('id', session.chat_id);
      
      if (error) {
        throw error;
      }
      
      // Buscar o chat atualizado
      const { data: chat } = await supabase
        .from('chats')
        .select('*')
        .eq('id', session.chat_id)
        .single();
      
      // Buscar nome da equipe se tiver sido atualizada
      let teamName = null;
      if (updates.team_id) {
        try {
          const { data: team } = await supabase
            .from('teams')
            .select('name')
            .eq('id', chat.team_id)
            .single();
            
          if (team) {
            teamName = team.name;
          }
        } catch (error) {
          console.warn(`[processUpdateChatAction] Erro ao buscar nome da equipe:`, error);
        }
      }
      
      // Traduzir status para formato mais amigável
      const statusLabel = {
        'in_progress': 'Em andamento',
        'waiting': 'Aguardando',
        'closed': 'Encerrado',
        'transferred': 'Transferido'
      }[chat.status] || chat.status;
      
      return {
        status: "success",
        message: `Chat data successfully updated.`,
        data: {
          id: chat.id,
          titulo: chat.title,
          status: statusLabel,
          equipe: teamName,
          data_atualizacao: new Date().toLocaleString('pt-BR')
        },
        updates: Object.keys(updates).map(field => {
          const fieldName = field === 'title' ? 'Título' : 
                           field === 'status' ? 'Status' : 
                           field === 'team_id' ? 'Equipe' : field;
          const fieldValue = field === 'status' ? statusLabel : 
                            field === 'team_id' ? teamName : 
                            updates[field];
          return `${fieldName}: ${fieldValue}`;
        }).join(', ')
      };
    }
    
    return {
      status: "info",
      message: "No updates needed for chat."
    };
  } catch (error) {
    console.error('[processUpdateChatAction] Erro:', error);
    Sentry.captureException(error);
    throw error;
  }
};

/**
 * Processa uma ação para iniciar um novo fluxo
 * @param {Object} action - Configuração da ação
 * @param {Object} args - Argumentos da ferramenta
 * @param {Object} session - Sessão atual
 * @returns {Object} - Resultado da criação do fluxo
 */
const processStartFlowAction = async (action, args, session) => {
  try {
    const config = action.config || {};
    let flowId = null;
    
    // Determinar o ID do fluxo a ser iniciado (direto ou via mapeamento)
    if (config.flowId) {
      flowId = config.flowId;
    } else if (config.flowMapping && config.flowMapping.variable && config.flowMapping.mapping) {
      const variableValue = args[config.flowMapping.variable];
      if (variableValue && config.flowMapping.mapping[variableValue]) {
        flowId = config.flowMapping.mapping[variableValue];
      }
    }
    
    if (!flowId) {
      return {
        status: "error",
        message: "No flow specified to start."
      };
    }
    
    // Verificar se o fluxo existe e está ativo
    const { data: flow, error: flowError } = await supabase
      .from('flows')
      .select('*')
      .eq('id', flowId)
      .eq('is_active', true)
      .single();
    
    if (flowError || !flow) {
      if (flowError) {
        console.error(`[processStartFlowAction] Erro ao buscar fluxo: ${flowError.message}`);
      } else {
        console.error(`[processStartFlowAction] Fluxo não encontrado com ID ${flowId}`);
      }
      return {
        success: false,
        instructions: `Please check the flow configuration. The flow with ID ${flowId} was not found or is not active.`
      };
    }
    
    // Iniciar um novo fluxo
    console.log(`[processStartFlowAction] Iniciando fluxo ${flowId} para o cliente ${session.customer_id} no chat ${session.chat_id}`);
    
    // Encontrar o nó inicial (geralmente do tipo 'start')
    const startNode = flow.nodes.find(node => node.id === 'start-node');
    if (!startNode) {
      console.error(`[processStartFlowAction] Fluxo ${flowId} não tem nó inicial válido`);
      return {
        success: false,
        instructions: `Please check the flow configuration. The flow ${flowId} does not have a valid start node.`
      };
    }
    
    // Garantir que flow.variables seja um array
    const defaultVariables = Array.isArray(flow.variables) 
      ? [...flow.variables] 
      : Object.entries(flow.variables || {}).map(([name, value]) => ({
          id: crypto.randomUUID(),
          name,
          value
        }));
    
    // Criar uma nova sessão de fluxo
    const { data: newSession, error } = await supabase
      .from('flow_sessions')
      .insert({
        bot_id: flow.id,
        chat_id: session.chat_id,
        customer_id: session.customer_id,
        organization_id: flow.organization_id,
        status: 'active',
        current_node_id: startNode.id,
        variables: defaultVariables,
        message_history: []
      })
      .select()
      .single();
    
    if (error) {
      throw error;
    }
    
    console.log(`[processStartFlowAction] Fluxo ${flowId} iniciado com sucesso, sessão ID: ${newSession.id}`);
    
    // Buscar informações do cliente
    const { data: customer } = await supabase
      .from('customers')
      .select('name, email, phone')
      .eq('id', session.customer_id)
      .single();
    
    return {
      status: "success",
      message: `New automated flow started: ${flow.name || 'Automated Flow'}.`,
      data: {
        fluxo: flow.name || 'Fluxo automático',
        fluxo_id: flow.id,
        sessao_id: newSession.id,
        cliente: customer?.name || 'Cliente',
        data_inicio: new Date().toLocaleString('pt-BR')
      },
      instructions: `The automated flow has been started. This process will be conducted by the system and you will receive messages and information requests automatically.`
    };
    
  } catch (error) {
    console.error('[processStartFlowAction] Erro:', error);
    Sentry.captureException(error);
    throw error;
  }
};