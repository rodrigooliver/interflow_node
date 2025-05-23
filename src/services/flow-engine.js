import { supabase } from '../lib/supabase.js';
import Sentry from '../lib/sentry.js';
import { OpenAI } from 'openai';
import { createMessageToSend, sendSystemMessage } from '../controllers/chat/message-handlers.js';
import crypto from 'crypto';
import { decrypt } from '../utils/crypto.js';
import { processAgentIA } from './agent-ia.js';
import axios from 'axios';

// Objeto global para armazenar os timeouts ativos por sessão
const sessionTimeouts = {};

/**
 * Cria um motor de fluxo para gerenciar conversas automatizadas
 * @param {Object} organization - Organização atual
 * @param {Object} channel - Canal de comunicação
 * @param {Object} customer - Cliente
 * @param {string} chatId - ID do chat
 * @param {Object} options - Opções adicionais
 */
export const createFlowEngine = (organization, channel, customer, chatId, options = {}) => {
  const { isFirstMessage } = options;
  
  /**
   * Processa cada mensagem recebida, gerenciando o fluxo ativo e o sistema de debounce
   * @param {Object} message - Mensagem a ser processada
   * @param {Object} flow - Somente caso seja um fluxo específico a ser processado / Não necessário informar para iniciar um novo fluxo
   */
  const processMessage = async (message, flow = null) => {
    try {
      let activeFlow;
      if(flow) {
        // Se for um fluxo específico, inicia o fluxo
        activeFlow = await startFlow(flow);
      } else {
        // Verifica se já existe um fluxo ativo
        activeFlow = await getActiveFlow();
        if (!activeFlow) {
          // Se não existir, encontra um fluxo adequado
          flow = await findMatchingFlow(message);
          if (flow) {
            // Se encontrar, inicia o fluxo
            activeFlow = await startFlow(flow);
          }
        }
      }

      if (activeFlow) {
        // Criar uma chave única para o timeout usando chatId e sessionId
        const timeoutKey = `${chatId}_${activeFlow.id}`;
      
        // Cancelar qualquer timeout pendente para esta sessão
        if (sessionTimeouts[timeoutKey]) {
          clearTimeout(sessionTimeouts[timeoutKey]);
        }

        // Verificar se está dentro do período de debounce
        const debounceTime = activeFlow.flow?.debounce_time || 20000; // em milissegundos

        // Definimos um timeout para processar a mensagem após o período de debounce
        sessionTimeouts[timeoutKey] = setTimeout(async () => {
          try {
            // Limpa a referência ao timeout concluído
            delete sessionTimeouts[timeoutKey];

            // Executar o fluxo caso não tenha sido cancelado por outra mensagem nova
            await continueFlow(activeFlow, message);
          } catch (error) {
            Sentry.captureException(error);
            console.error('Erro durante o processamento do timeout de debounce:', error);
          }
        }, debounceTime);
        
        return activeFlow; // Não prossegue para continueFlow imediatamente
      }
      return null;
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
          variables,
          debounce_time
        ),
        customer:customers!flow_sessions_customer_id_fkey (
          *,
          contacts:customer_contacts(*),
          field_values:customer_field_values(
            id,
            field_definition_id,
            value,
            updated_at,
            field_definition:custom_fields_definition(*)
          ),
          tags:customer_tags(
            tag_id,
            tags:tags(*)
          )
        ),
        chat:chats!flow_sessions_chat_id_fkey (*)
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
    const startNode = flow.nodes.find(node => node.id === 'start-node' || node.id === 'start');
    // console.log('startNode', startNode);
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
          variables,
          debounce_time
        ),
        customer:customers!flow_sessions_customer_id_fkey (
          *,
          contacts:customer_contacts(*),
          field_values:customer_field_values(
            id,
            field_definition_id,
            value,
            updated_at,
            field_definition:custom_fields_definition(*)
          ),
          tags:customer_tags(
            tag_id,
            tags:tags(*)
          )
        ),
        chat:chats!flow_sessions_chat_id_fkey (*)
      `)
      .single();
        
      if (error) throw error;

      // Atualiza o chat com o ID da sessão do fluxo
      const { data: chatsUpdate, error: chatsUpdateError } = await supabase
      .from('chats')
      .update({
        flow_session_id: session.id
      })
      .eq('id', chatId);

      if (chatsUpdateError) throw chatsUpdateError;

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
      if (!currentNode) {
        const error = new Error('Current node not found');
        Sentry.captureException(error);
        throw error;
      }
      
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
        // console.log(`[continueFlow] Proximo nó a ser executado antes de executar o nó:`, nextNode);
        updatedSession = await executeNode(updatedSession, nextNode);
        if (updatedSession && updatedSession.go_to_node && updatedSession.target_node) {
          nextNode = updatedSession.target_node;
          delete updatedSession.go_to_node;
          delete updatedSession.target_node;
        } else {
          nextNode = await getNextNode(updatedSession.flow, nextNode, message, updatedSession);
        }
        
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
        await pauseFlow(session);
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
        const processedText = replaceVariables(node.data.text, updatedSession);
        // console.log('processedText', processedText);
        
        // Função para identificar o tipo de mídia baseado na URL
        const identifyMediaType = (url) => {
          const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'];
          const audioExtensions = ['.mp3', '.wav', '.ogg', '.m4a', '.aac'];
          const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
          const documentExtensions = ['.pdf', '.doc', '.docx', '.txt', '.rtf', '.xls', '.xlsx', '.ppt', '.pptx'];
          
          // Remove parâmetros da URL (tudo após ?)
          const urlWithoutParams = url.split('?')[0];
          
          // Procura por extensões no meio da URL
          const extensionMatch = urlWithoutParams.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp|mp3|wav|ogg|m4a|aac|mp4|webm|mov|avi|mkv|pdf|doc|docx|txt|rtf|xls|xlsx|ppt|pptx)/i);
          
          if (extensionMatch) {
            const extension = '.' + extensionMatch[1].toLowerCase();
            
            if (imageExtensions.includes(extension)) return 'image';
            if (audioExtensions.includes(extension)) return 'audio';
            if (videoExtensions.includes(extension)) return 'video';
            if (documentExtensions.includes(extension)) return 'document';
          }
          
          return null;
        };

        // Função para extrair links do texto
        const extractLinks = (text) => {
          // Regex para identificar tanto links normais quanto imagens
          const linkRegex = /!?\[([^\]]+)\]\(([^)]+)\)/g;
          const parts = [];
          let lastIndex = 0;
          let match;

          while ((match = linkRegex.exec(text)) !== null) {
            // Adiciona o texto antes do link
            if (match.index > lastIndex) {
              parts.push({
                type: 'text',
                content: text.slice(lastIndex, match.index)
              });
            }
            
            // Adiciona o link
            parts.push({
              type: 'link',
              content: match[1], // texto do link
              url: match[2],     // URL do link
              mediaType: identifyMediaType(match[2])
            });
            
            // Atualiza o lastIndex considerando qualquer pontuação após o link
            const afterLink = text.slice(match.index + match[0].length);
            const punctuationMatch = afterLink.match(/^[.,!?;:]/);
            if (punctuationMatch) {
              lastIndex = match.index + match[0].length + punctuationMatch[0].length;
            } else {
              lastIndex = match.index + match[0].length;
            }
          }
          
          // Adiciona o texto restante após o último link
          if (lastIndex < text.length) {
            parts.push({
              type: 'text',
              content: text.slice(lastIndex)
            });
          }
          
          return parts;
        };

        // Função para processar e enviar as partes do texto
        const processAndSendParts = async (parts, metadata) => {
          // Função auxiliar para enviar uma mensagem e aguardar antes de prosseguir
          const sendWithDelay = async (content, files, sessionId, meta, delaySeconds) => {
            // Envia a mensagem e espera a conclusão completa
            const result = await sendMessage(content, files, sessionId, meta);
            
            // Aguarda tempo adicional após o envio para garantir que a mensagem seja processada
            await processDelay(delaySeconds || 3);
            
            return result;
          };
          
          // Processa as partes sequencialmente
          for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLastPart = i === parts.length - 1;
            
            if (part.type === 'text') {
              if (node.data.splitParagraphs) {
                // Se for texto com parágrafos, segue com o comportamento normal de splitParagraphs
                const paragraphs = part.content
                  .split('\n\n')
                  .filter(paragraph => paragraph.trim().length > 0);
                
                for (let j = 0; j < paragraphs.length; j++) {
                  const paragraph = paragraphs[j];
                  const isLastParagraph = j === paragraphs.length - 1;
                  
                  const currentMetadata = isLastParagraph && isLastPart ? metadata : null;
                  await sendWithDelay(paragraph, null, updatedSession.id, currentMetadata, 3);
                }
              } else {
                // Comportamento padrão para texto
                const currentMetadata = isLastPart ? metadata : null;
                await sendWithDelay(part.content, null, updatedSession.id, currentMetadata, 2);
              }
            } else if (part.type === 'list') {
              // Envia a lista com delay maior
              // `${part.content ?? 'Lista'} \n\n ${part.metadata?.description ?? ''}`,
              await sendWithDelay(
                `${part.content ?? 'Lista'} \n\n ${part.metadata?.description ?? ''}`,
                null, 
                updatedSession.id, 
                { list: part.content },
                4
              );
            } else if (part.type === 'link' && part.mediaType) {
              // Se for um link de mídia, envia como anexo
              await sendWithDelay(
                null, 
                {
                  attachments: [{
                    url: part.url,
                    type: part.mediaType,
                    content: part.content
                  }]
                }, 
                updatedSession.id,
                null,
                5
              );
            } else if (part.type === 'link') {
              await sendWithDelay(
                `${part.url}`, 
                null, 
                updatedSession.id,
                null,
                5
              );
            }
            
            // Sempre espera um tempo entre diferentes partes para garantir a ordem
            if (!isLastPart) {
              await processDelay(1);
            }
          }
        };

        // Processa o texto com prioridade: extractJsonList -> extractLinks -> splitParagraphs
        
        // 1. Primeiro verifica se o texto contém blocos de código JSON
        const jsonParts = extractJsonList(processedText);
        
        if (jsonParts.length > 1 || (jsonParts.length === 1 && jsonParts[0].type === 'list')) {
          // Se encontrou blocos JSON, processa cada parte
          // console.log('Processando texto com blocos JSON');
          
          // Processa os links dentro de partes de texto antes de enviar
          if (node.data.extractLinks) {
            const processedParts = jsonParts.map(part => {
              if (part.type === 'text') {
                // Extrai links apenas de partes do tipo texto
                const linkParts = extractLinks(part.content);
                return linkParts;
              }
              return [part];
            }).flat();
            
            await processAndSendParts(processedParts, null);
          } else {
            await processAndSendParts(jsonParts, null);
          }
        } 
        // 2. Se não tem JSON, verifica se deve extrair links
        else if (node.data.extractLinks) {
          // console.log('Processando texto com extração de links');
          const parts = extractLinks(processedText);
          const metadata = node.data.listOptions ? { list: node.data.listOptions } : null;
          await processAndSendParts(parts, metadata);
        } 
        // 3. Se não tem JSON nem links, verifica se deve separar por parágrafos
        else if (node.data.splitParagraphs) {
          // Comportamento existente para splitParagraphs
          // console.log('Processando parágrafos separados');
          const paragraphs = processedText
            .split('\n\n')
            .filter(paragraph => paragraph.trim().length > 0);
          
          for (let i = 0; i < paragraphs.length; i++) {
            const paragraph = paragraphs[i];
            const isLastParagraph = i === paragraphs.length - 1;
            
            const metadata = isLastParagraph && node.data.listOptions ? { list: node.data.listOptions } : null;
            await sendMessage(paragraph, null, updatedSession.id, metadata);
            
            if (paragraphs.length > 1 && !isLastParagraph) {
              await processDelay(2);
            }
          }
        } 
        // 4. Caso contrário, envia o texto completo sem processamento
        else {
          // Comportamento padrão
          // console.log('Enviando texto completo sem processamento');
          const metadata = node.data.listOptions ? { list: node.data.listOptions } : null;
          await sendMessage(processedText, null, updatedSession.id, metadata);
        }
        break;

      case 'audio':
        // Processa a URL do áudio para substituir variáveis, se houver
        const processedAudioUrl = replaceVariables(node.data.mediaUrl, updatedSession);
        await sendMessage(null, {attachments: [{url: processedAudioUrl, type: 'audio'}]}, updatedSession.id);
        break;

      case 'image':
        // Processa a URL da imagem para substituir variáveis, se houver
        const processedImageUrl = replaceVariables(node.data.mediaUrl, updatedSession);
        await sendMessage(null, {attachments: [{url: processedImageUrl, type: 'image'}]}, updatedSession.id);
        break;

      case 'video':
        // Processa a URL do vídeo para substituir variáveis, se houver
        const processedVideoUrl = replaceVariables(node.data.mediaUrl, updatedSession);
        await sendMessage(null, {attachments: [{url: processedVideoUrl, type: 'video'}]}, updatedSession.id);
        break;

      case 'document':
        // Processa a URL do documento para substituir variáveis, se houver
        const processedDocUrl = replaceVariables(node.data.mediaUrl, updatedSession);
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

      case 'agenteia':
        const updatedSession = await processAgentIA(node, updatedSession, sendMessage, updateSession);
        
        // Verificar se há atualizações de variáveis para aplicar
        if (updatedSession.variables_update && Object.keys(updatedSession.variables_update).length > 0) {
          console.log(`[executeNode] Aplicando ${Object.keys(updatedSession.variables_update).length} atualizações de variáveis do agent-ia`);
          
          // Garantir que as variáveis existam como array
          let variables = Array.isArray(updatedSession.variables) 
            ? [...updatedSession.variables] 
            : [];
          
          // Aplicar cada atualização de variável
          for (const [varName, varValue] of Object.entries(updatedSession.variables_update)) {
            const variableIndex = variables.findIndex(v => v.name === varName);
            
            if (variableIndex >= 0) {
              // Atualizar variável existente
              variables[variableIndex] = {
                ...variables[variableIndex],
                value: varValue
              };
              console.log(`[executeNode] Variável '${varName}' atualizada para: ${varValue}`);
            } else {
              // Criar nova variável
              variables.push({
                id: crypto.randomUUID(),
                name: varName,
                value: varValue
              });
              console.log(`[executeNode] Nova variável '${varName}' criada com valor: ${varValue}`);
            }
          }
          
          // Atualizar a sessão com as novas variáveis
          await updateSession(updatedSession.id, { variables });
          updatedSession = { ...updatedSession, variables };
        }
        
        break;
        
      case 'update_customer':
        updatedSession = await updateCustomer(node.data, updatedSession);
        break;

      case 'request':
        updatedSession = await processRequestNode(node.data, updatedSession);
        break;

      case 'jump_to':
        updatedSession = await processJumpToNode(node.data, updatedSession);  
        break;
    }

    // Atualizar histórico de mensagens
    // await updateMessageHistory(updatedSession.id, node);
    
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
    const { type, field, operator, value, stageId } = subCondition;
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
      compareValue = replaceVariables(value, session);
    }

    // Avaliar baseado no operador
    switch (operator) {
      case 'equalTo':
        return fieldValue === compareValue;
        
      case 'notEqual':
      case 'notEqualTo':
        return fieldValue !== compareValue;
        
      case 'contains':
        const containsResult = String(fieldValue).toLowerCase().includes(String(compareValue).toLowerCase());
        return containsResult;
        
      case 'doesNotContain':
      case 'notContains':
        const notContainsResult = !String(fieldValue).toLowerCase().includes(String(compareValue).toLowerCase());
        return notContainsResult;
        
      case 'greaterThan':
        return Number(fieldValue) > Number(compareValue);
        
      case 'lessThan':
        return Number(fieldValue) < Number(compareValue);
        
      case 'greaterThanOrEqual':
        return Number(fieldValue) >= Number(compareValue);
        
      case 'lessThanOrEqual':
        return Number(fieldValue) <= Number(compareValue);
        
      case 'isSet':
        const isSetResult = fieldValue !== null && fieldValue !== undefined && fieldValue !== '';
        return isSetResult;
        
      case 'isEmpty':
        const isEmptyResult = fieldValue === null || fieldValue === undefined || fieldValue === '';
        return isEmptyResult;
        
      case 'startsWith':
        const startsWithResult = String(fieldValue).toLowerCase().startsWith(String(compareValue).toLowerCase());
        return startsWithResult;
        
      case 'endsWith':
        const endsWithResult = String(fieldValue).toLowerCase().endsWith(String(compareValue).toLowerCase());
        return endsWithResult;
        
      case 'matchesRegex':
        try {
          const regex = new RegExp(compareValue);
          const matchesResult = regex.test(String(fieldValue));
          return matchesResult;
        } catch (error) {
          return false;
        }
        
      case 'doesNotMatchRegex':
        try {
          const regex = new RegExp(compareValue);
          const notMatchesResult = !regex.test(String(fieldValue));
          return notMatchesResult;
        } catch (error) {
          return false;
        }
        
      case 'inList':
        const valueList = String(compareValue).split(',').map(v => v.trim().toLowerCase());
        
        // Caso especial para chat_funil
        if (field === 'chat_funil') {
          // Não precisamos buscar novamente o estágio, pois o fieldValue já é o stage_id
          if (!fieldValue) {
            return false;
          }
          
          // Verificar se o estágio do cliente está na lista de estágios permitidos
          const stageIdList = String(stageId).split(',').map(id => id.trim());
          const stageInListResult = stageIdList.includes(fieldValue);
          return stageInListResult;
        }
        
        // Comportamento padrão para outros campos
        if (Array.isArray(fieldValue)) {
          const arrayInListResult = fieldValue.some(v => valueList.includes(String(v).toLowerCase()));
          return arrayInListResult;
        }
        
        const inListResult = valueList.includes(String(fieldValue).toLowerCase());
        return inListResult;
        
      case 'notInList':
        const excludeList = String(compareValue).split(',').map(v => v.trim().toLowerCase());
        
        // Caso especial para chat_funil
        if (field === 'chat_funil') {
          // Não precisamos buscar novamente o estágio, pois o fieldValue já é o stage_id
          if (!fieldValue) {
            return true; // Se não tem estágio, não está na lista
          }
          
          // Verificar se o estágio do cliente NÃO está na lista de estágios
          const stageIdList = String(stageId).split(',').map(id => id.trim());
          const stageNotInListResult = !stageIdList.includes(fieldValue);
          return stageNotInListResult;
        }
        
        // Comportamento padrão para outros campos
        if (Array.isArray(fieldValue)) {
          const arrayNotInListResult = !fieldValue.some(v => excludeList.includes(String(v).toLowerCase()));
          return arrayNotInListResult;
        }
        
        const notInListResult = !excludeList.includes(String(fieldValue).toLowerCase());
        return notInListResult;
        
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
        // Usar dados do cliente já carregados na sessão, se disponíveis
        if (session.customer) {
          const customerField = field.replace('custumer_', '');
          return session.customer[customerField];
        }
        
        // Fallback para busca no banco se não tiver os dados na sessão
        const { data: customerData } = await supabase
          .from('customers')
          .select('*')
          .eq('id', session.customer_id)
          .single();
          
        const customerField = field.replace('custumer_', '');
        return customerData?.[customerField];
      }
      
      // Caso especial para chat_funil - retornar stage_id do cliente diretamente
      if (field === 'chat_funil') {
        // Usar dados do cliente já carregados na sessão, se disponíveis
        if (session.customer) {
          return session.customer.stage_id;
        }
        
        // Fallback para busca no banco se não tiver os dados na sessão
        const { data: customerData } = await supabase
          .from('customers')
          .select('stage_id')
          .eq('id', session.customer_id)
          .single();
          
        return customerData?.stage_id;
      }
      
      // Caso especial para chat_price - retornar sale_price do cliente diretamente
      if (field === 'chat_price') {
        // Usar dados do cliente já carregados na sessão, se disponíveis
        if (session.customer) {
          return session.customer.sale_price;
        }
        
        // Fallback para busca no banco se não tiver os dados na sessão
        const { data: customerData } = await supabase
          .from('customers')
          .select('sale_price')
          .eq('id', session.customer_id)
          .single();
          
        return customerData?.sale_price;
      }
      
      // Caso especial para chat_tag - retornar as tags do cliente da tabela customer_tags
      if (field === 'chat_tag') {
        // Buscar as tags do cliente da tabela de junção
        const { data: customerTags, error } = await supabase
          .from('customer_tags')
          .select(`
            tag_id,
            tag:tags(*)
          `)
          .eq('customer_id', session.customer_id);
          
        if (error) {
          Sentry.captureException(error);
          return null;
        }
        
        // Extrair os IDs das tags
        const tagIds = customerTags?.map(ct => ct.tag_id) || [];
        return tagIds;
      }
      
      // Buscar dados do chat
      if (field.startsWith('chat_')) {
        // Usar dados do chat já carregados na sessão, se disponíveis
        if (session.chat) {
          const chat = session.chat;
          
          let result;
          switch (field) {
            case 'chat_team':
              result = chat.team_id;
              break;
              
            case 'chat_attendant':
              result = chat.assigned_to;
              break;
              
            default:
              result = null;
          }
          
          return result;
        }
        
        // Fallback para busca no banco se não tiver os dados na sessão
        const { data: chat } = await supabase
          .from('chats')
          .select(`
            *,
            team:team_id(*),
            assigned_agent:assigned_to(*)
          `)
          .eq('id', session.chat_id)
          .single();
          
        let result;
        switch (field) {
          case 'chat_team':
            result = chat?.team?.id;
            break;
            
          case 'chat_attendant':
            result = chat?.assigned_agent?.id;
            break;
            
          default:
            result = null;
        }
        
        return result;
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

        // Avaliar cada subcondição
        const results = await Promise.all(
          subConditions.map(async (sub) => {
            const result = await evaluateSubCondition(sub, session);
            return result;
          })
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
        ),
        customer:customers!flow_sessions_customer_id_fkey (
          *,
          contacts:customer_contacts(*),
          field_values:customer_field_values(
            id,
            field_definition_id,
            value,
            updated_at,
            field_definition:custom_fields_definition(*)
          ),
          tags:customer_tags(
            tag_id,
            tags:tags(*)
          )
        ),
        chat:chats!flow_sessions_chat_id_fkey (*)
      `)
      .single();

    if (error) throw error;

    if(updates.status && updates.status === 'inactive') {
      //Pesquisar se chat está status await_closing e marcar como closed
      const { data: chat, error: chatError } = await supabase
        .from('chats')
        .select('*')
        .eq('id', data.chat_id)
        .eq('status', 'await_closing')
        .single();

      if(chat) {
        await supabase
          .from('chats')
          .update({ status: 'closed' })
          .eq('id', data.chat_id);
      }
    }

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
  const sendMessage = async (content, files, sessionId, metadata) => {
    try {
      // console.log('sendMessage', content, files, sessionId, metadata);
      if(content || files || metadata) {
        const result = await createMessageToSend(chatId, organization.id, content, null, files, null, metadata);
        if (result.status !== 201) {
          const error = new Error(result.error);
          Sentry.captureException(error);
          throw error;
        }
        
        // // Aguardar que todas as mensagens sejam realmente enviadas para o canal
        // if (result.messages && result.messages.length > 0) {
        //   // Criar uma cadeia de promises para enviar as mensagens em ordem
        //   let sendChain = Promise.resolve();
          
        //   for (const message of result.messages) {
        //     sendChain = sendChain.then(() => {
        //       return sendSystemMessage(message.id).catch(error => {
        //         console.error('Erro ao enviar mensagem para o canal:', error);
        //       });
        //     });
        //   }
          
        //   // Aguardar a conclusão da cadeia antes de retornar
        //   await sendChain;
        // }
        
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

      // Descriptografar a chave da API OpenAI antes de usar
      const decryptedApiKey = decrypt(integration.credentials.api_key);
      
      if (!decryptedApiKey) {
        const error = new Error('Erro ao descriptografar a chave da API OpenAI');
        Sentry.captureException(error);
        throw error;
      }

      const openai = new OpenAI({
        apiKey: decryptedApiKey,
      });

      if (!openAIConfig) {
        const error = new Error('Configuração do OpenAI não encontrada');
        Sentry.captureException(error);
        throw error;
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
          const error = new Error(`Tipo de OpenAI não suportado: ${openAIConfig.apiType}`);
          Sentry.captureException(error);
          throw error;
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
        const processedContent = replaceVariables(prompt.content, session);
        messages.push({
          role: 'system',
          content: processedContent
        });
      }
    } else if (config.promptType === 'custom' && config.customPrompt) {
      // Substituir variáveis no prompt personalizado
      const processedContent = replaceVariables(config.customPrompt, session);
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
    const error = new Error('Audio generation not implemented yet');
    Sentry.captureException(error);
    throw error;
  };

  const handleTextToSpeech = async (openai, config, session) => {
    // Implementar lógica para text-to-speech
    const error = new Error('Text to speech not implemented yet');
    Sentry.captureException(error);
    throw error;
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
        const error = new Error('Nome da variável não especificado');
        Sentry.captureException(error);
        throw error;
      }

      // Processa o valor da variável, substituindo quaisquer variáveis existentes
      const processedValue = replaceVariables(data.variable.value, session);

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
      const {updateCustomer: updateCustomerData} = data;
      if(!updateCustomerData) {
        const error = new Error('Dados para atualização do cliente não especificados');
        Sentry.captureException(error);
        throw error;
      }
      const { field, value, teamId, userId, funnelId, stageId } = updateCustomerData;
      console.log(`[updateCustomer] Atualizando cliente com dados:`, updateCustomerData);
      if (!field) {
        const error = new Error('Campo para atualização não especificado');
        Sentry.captureException(error);
        throw error;
      }

      let updateChat = {};
      let updateCustomer = {};

      if(field === 'rating') { // Atualiza a avaliação do chat
        const rating = Number(replaceVariables(value, session)); // Substitui variáveis no valor
        if (!rating) {
          const error = new Error('Avaliação não especificada');
          Sentry.captureException(error);
          throw error;
        }
        if(rating < 0 || rating > 5) {
          const error = new Error('Avaliação inválida');
          Sentry.captureException(error);
          throw error;
        }
        updateChat = {
          rating: rating
        };
      } else if(field === 'feedback') { // Atualiza o feedback do chat
        const feedback = replaceVariables(value, session);
        if(!feedback) {
          const error = new Error('Feedback não especificado');
          Sentry.captureException(error);
          throw error;
        }
        updateChat = {
          feedback: feedback
        };
      } else if(field === 'funnel') { // Atualiza o funil do chat
        const funnel = replaceVariables(value, session);
        if(!funnel) {
          const error = new Error('Funnel não especificado');
          Sentry.captureException(error);
          throw error;
        }
        updateCustomer = {
          stage_id: stageId,
        };
      } else if(field === 'team') { // Atualiza o time do chat
        const team = replaceVariables(value, session);
        if(!team) {
          const error = new Error('Time não especificado');
          Sentry.captureException(error);
          throw error;
        }
        updateChat = {
          team_id: teamId
        };
      } else if(field === 'user') { // Atualiza o usuário do chat
        const user = replaceVariables(value, session);
        if(!user) {
          const error = new Error('Usuário não especificado');
          Sentry.captureException(error);
          throw error;
        }
        updateChat = {
          assigned_to: userId
        };
      }

      // console.log(`[updateCustomer] Atualizando chat com dados:`, updateChat);
      // console.log(`[updateCustomer] Atualizando cliente com dados:`, updateCustomer);

      if(Object.keys(updateChat).length > 0) {
        await supabase  
          .from('chats')
          .update(updateChat)
          .eq('id', session.chat_id);
      }

      if(Object.keys(updateCustomer).length > 0) {
        await supabase
          .from('customers')
          .update(updateCustomer)
          .eq('id', session.customer_id);
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
      // .eq('flows.is_active', true)
      .eq('flows.is_published', true)
      .not('flow', 'is', null);

      
      if(flowsError) throw flowsError;
      if(flows.length === 0) return null;
      
      for (const flow of flows) {
        // Encontrar a regra de canal (opcional)
        const channelRule = flow.conditions.rules.find(rule => rule.type === 'channel');
        
        // Se existir regra de canal, verificar se o canal está na lista de canais permitidos
        if (channelRule) {
          const channelList = channelRule.params.channels || [];
          const isChannelAllowed = channelList.length === 0 || channelList.includes(channel.id);
          if (!isChannelAllowed) continue;
        }
        
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
   * Também permite acessar propriedades de customer e chat como {{customer.name}} ou {{chat.title}}
   * @param {string} text - Texto com possíveis variáveis para substituir
   * @param {Object} session - Sessão contendo as variáveis e objetos customer e chat
   * @returns {string} - Texto com as variáveis substituídas
   */
  const replaceVariables = (text, session) => {
    if (!text || !session) return text;
    
    const variables = session.variables;
    
    if (!variables && !session.customer && !session.chat) return text;
    
    // Verificar se há variáveis URL-encoded no texto (%7B%7B...%7D%7D)
    if (text.includes('%7B%7B')) {
      text = text.replace(/%7B%7B([^}]+)%7D%7D/g, (match, varName) => {
        return `{{${varName}}}`;
      });
    }
    
    // Pré-processamento do customer para facilitar acesso a contacts e custom fields
    let processedCustomer = null;
    if (session.customer) {
      processedCustomer = { ...session.customer };
      delete processedCustomer.contacts;
      delete processedCustomer.field_values;
      // delete processedCustomer.email;
      // delete processedCustomer.whatsapp;
      // delete processedCustomer.instagram_id;
      
      // Reorganizar contacts para acesso por tipo
      if (Array.isArray(session.customer.contacts)) {
        session.customer.contacts.forEach(contact => {
          if (contact.type && contact.value) {
            // Adiciona o contato diretamente como propriedade do customer
            // Por exemplo, customer.email, customer.whatsapp, etc.
            processedCustomer[contact.type] = contact.value;
            
            // Se o contato tiver um label, cria também uma propriedade baseada no label
            if (contact.label) {
              const labelKey = contact.label
                .toLowerCase()
                .replace(/\s+/g, '_')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, ''); // Remover acentos
              
              // processedCustomer[`contact_${labelKey}`] = contact.value;
            }
          }
        });
      }
      
      // Reorganizar field_values para acesso por slug
      if (Array.isArray(session.customer.field_values)) {
        session.customer.field_values.forEach(fieldValue => {
          if (fieldValue.field_definition && fieldValue.field_definition.slug) {
            // Adiciona o valor do campo diretamente como propriedade do customer
            // Por exemplo, customer.origem, customer.cargo, etc.
            processedCustomer[fieldValue.field_definition.slug] = fieldValue.value;
            
            // Adiciona também com prefixo field_ para evitar conflitos
            // processedCustomer[`field_${fieldValue.field_definition.slug}`] = fieldValue.value;
          }
        });
      }
    }
    // console.log('processedCustomer', processedCustomer);
    
    return text.replace(/\{\{([^}]+)\}\}/g, (match, variableName) => {
      const trimmedName = variableName.trim();
      let value;
      
      // Verifica primeiro na lista de variáveis (como antes)
      if (variables) {
        if (Array.isArray(variables)) {
          // Procura a variável no array de variáveis
          const variable = variables.find(v => v.name === trimmedName);
          if (variable) {
            return variable.value !== undefined ? variable.value : match;
          }
        } else if (typeof variables === 'object') {
          // Acessa diretamente a propriedade do objeto
          value = variables[trimmedName];
          if (value !== undefined) {
            return value;
          }
        }
      }
      
      // Se não encontrou na lista de variáveis, verifica se é acesso a propriedades de customer ou chat
      if (trimmedName.includes('.')) {
        const parts = trimmedName.split('.');
        const objectType = parts[0]; // 'customer' ou 'chat'
        
        // Remove o tipo de objeto do array de partes
        parts.shift();
        
        if (objectType === 'customer' && processedCustomer) {
          // Tenta acessar a propriedade do customer pré-processado
          try {
            let currentObj = processedCustomer;
            for (const part of parts) {
              currentObj = currentObj[part];
              if (currentObj === undefined) break;
            }
            value = currentObj;
          } catch (error) {
            console.error(`Erro ao acessar propriedade ${parts.join('.')} de customer:`, error);
          }
        } else if (objectType === 'chat' && session.chat) {
          // Tenta acessar a propriedade do chat
          try {
            let currentObj = session.chat;
            for (const part of parts) {
              currentObj = currentObj[part];
              if (currentObj === undefined) break;
            }
            value = currentObj;
          } catch (error) {
            console.error(`Erro ao acessar propriedade ${parts.join('.')} de chat:`, error);
          }
        }
      }
      
      // Retorna o valor encontrado ou mantém o placeholder se não encontrar
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
        await pauseFlow(session);
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
        await pauseFlow(session);
      }
    } catch (error) {
      Sentry.captureException(error);
      console.error(`Erro ao processar timeout da sessão ${session.id}:`, error);
    }
  };

  // Função para extrair listas de blocos de código JSON no texto
  const extractJsonList = (text) => {
    // console.log('Verificando blocos JSON no texto');
    // Regex para encontrar blocos de código JSON
    const jsonBlockRegex = /```(?:json)?\s*\n([\s\S]+?)\n```/g;
    
    const parts = [];
    let lastIndex = 0;
    let match;
    
    while ((match = jsonBlockRegex.exec(text)) !== null) {
      // console.log('Encontrou bloco JSON em:', match.index);
      // Adiciona o texto antes do bloco JSON
      if (match.index > lastIndex) {
        parts.push({
          type: 'text',
          content: text.slice(lastIndex, match.index).trim()
        });
      }
      
      // Tenta analisar o JSON
      try {
        const jsonContent = match[1].trim();
        // console.log('Conteúdo JSON:', jsonContent.substring(0, 100) + '...');
        const listData = JSON.parse(jsonContent);
        
        parts.push({
          type: 'list',
          content: listData
        });
      } catch (e) {
        console.log('Erro ao analisar JSON:', e);
        // Se falhar, adiciona como texto normal
        parts.push({
          type: 'text',
          content: match[0]
        });
      }
      
      lastIndex = match.index + match[0].length;
    }
    
    // Adiciona o texto restante após o último bloco JSON
    if (lastIndex < text.length) {
      parts.push({
        type: 'text',
        content: text.slice(lastIndex).trim()
      });
    }
    
    // console.log('Partes extraídas:', parts.length, 'Tipos:', parts.map(p => p.type).join(', '));
    return parts;
    // return parts.filter(part => part.content && part.content.length > 0);
  };

  /**
   * Processa um nó do tipo requisição HTTP
   * @param {Object} data - Dados do nó de requisição HTTP
   * @param {Object} session - Sessão atual
   * @returns {Object} - Sessão atualizada com as variáveis da resposta
   */
  const processRequestNode = async (data, session) => {
    try {
      if (!data.request) {
        const error = new Error('Configuração da requisição HTTP não encontrada');
        Sentry.captureException(error);
        throw error;
      }

      const requestConfig = data.request;
      
      // Substituir variáveis em todos os campos da requisição
      // Primeiro decodificar URL-encoded variáveis (%7B%7B...%7D%7D para {{...}})
      let url = requestConfig.url;
      // Verificar se a URL contém variáveis URL-encoded
      if (url && url.includes('%7B%7B')) {
        // Substituir variáveis codificadas antes da substituição normal
        url = url.replace(/%7B%7B([^}]+)%7D%7D/g, (match, varName) => {
          return `{{${varName}}}`;
        });
      }
      // Agora substituir as variáveis normais
      url = replaceVariables(url, session);
      
      // Não vamos mais separar a URL dos parâmetros, usaremos a URL completa
      // incluindo os parâmetros de query que já estiverem presentes
      
      // Processar headers
      const headers = {};
      for (const header of requestConfig.headers || []) {
        if (header.key && header.value) {
          headers[header.key] = replaceVariables(header.value, session);
        }
      }
      
      // Configurar a requisição para o axios
      const axiosConfig = {
        method: requestConfig.method || 'GET',
        url: url, // Usar a URL completa
        headers: headers,
        timeout: 15000 // 15 segundos por padrão
      };
      
      // Adicionar parâmetros de query adicionais se fornecidos
      // Estes serão mesclados com quaisquer parâmetros já presentes na URL
      if (requestConfig.params && Array.isArray(requestConfig.params) && requestConfig.params.length > 0) {
        axiosConfig.params = {};
        for (const param of requestConfig.params) {
          if (param.key && param.value) {
            // axiosConfig.params[param.key] = replaceVariables(param.value, session);
          }
        }
      }
      
      // Processar corpo da requisição, se houver
      if (requestConfig.method !== 'GET' && requestConfig.bodyType !== 'none' && requestConfig.body) {
        const processedBody = replaceVariables(requestConfig.body, session);
        
        if (requestConfig.bodyType === 'json') {
          try {
            // Verificar se é um JSON válido
            axiosConfig.data = JSON.parse(processedBody);
          } catch (jsonError) {
            const error = new Error(`JSON inválido no corpo da requisição: ${jsonError.message}`);
            Sentry.captureException(error);
            throw error;
          }
        } else {
          // Para outros tipos de body (form, text, etc.)
          axiosConfig.data = processedBody;
        }

        // Configurar content-type baseado no bodyType
        if (requestConfig.bodyType === 'json') {
          axiosConfig.headers['Content-Type'] = 'application/json';
        } else if (requestConfig.bodyType === 'form') {
          axiosConfig.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
      }
      
      // Executar a requisição HTTP usando axios
      let response;
      try {
        // Fazer a requisição usando axios
        response = await axios(axiosConfig);
        
        // Parsear a resposta como JSON
        const responseData = response.data;
        // console.log(`[processRequestNode] Resposta recebida:`, responseData);
        
        // Processar mapeamentos de variáveis, se houver
        if (requestConfig.variableMappings && requestConfig.variableMappings.length > 0) {
          // console.log(`[processRequestNode] Processando ${requestConfig.variableMappings.length} mapeamentos de variáveis`);
          
          // Verificar se session.variables é um array ou um objeto e converte para array se necessário
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
          
          // Processar cada mapeamento de variável
          for (const mapping of requestConfig.variableMappings) {
            if (mapping.variable && mapping.jsonPath) {
              // Extrair o valor do jsonPath da resposta
              const value = extractValueFromPath(responseData, mapping.jsonPath);
              
              if (value !== undefined) {
                // console.log(`[processRequestNode] Valor extraído para ${mapping.variable}:`, value);
                
                // Verificar se a variável já existe
                const variableIndex = variables.findIndex(v => v.name === mapping.variable);
                
                if (variableIndex >= 0) {
                  // Atualizar a variável existente
                  variables[variableIndex] = {
                    ...variables[variableIndex],
                    value: value
                  };
                } else {
                  // Criar uma nova variável
                  variables.push({
                    id: crypto.randomUUID(),
                    name: mapping.variable,
                    value: value
                  });
                }
              } else {
                // console.log(`[processRequestNode] Caminho ${mapping.jsonPath} não encontrado na resposta`);
              }
            }
          }
          
          // Atualizar as variáveis na sessão
          await updateSession(session.id, { variables });
          
          // Criar uma cópia atualizada da sessão com as novas variáveis
          const updatedSession = {
            ...session,
            variables
          };
          
          return updatedSession;
        }
        
        return session;
      } catch (error) {
        console.error(`[processRequestNode] Erro ao executar requisição:`, error);
        
        // Tratamento detalhado de erro
        if (axios.isAxiosError(error)) {
          if (error.response) {
            // Servidor respondeu com status de erro
            throw new Error(`Erro ${error.response.status}: ${error.response.statusText || 'Erro desconhecido'}`);
          } else if (error.request) {
            // Requisição foi feita mas não houve resposta
            throw new Error('Não foi recebida resposta do servidor remoto');
          } else {
            // Erro na configuração da requisição
            throw new Error(`Erro na configuração da requisição: ${error.message}`);
          }
        }
        
        Sentry.captureException(error);
        throw error;
      }
    } catch (error) {
      console.error(`[processRequestNode] Erro:`, error);
      Sentry.captureException(error);
      throw error;
    }
  };

  /**
   * Extrai um valor de um objeto usando um caminho tipo JSONPath
   * @param {Object} obj - Objeto de onde extrair o valor
   * @param {string} path - Caminho para o valor (ex: "data[0].customer")
   * @returns {any} - Valor extraído ou undefined se não encontrado
   */
  const extractValueFromPath = (obj, path) => {
    if (!obj || !path) return undefined;
    
    // Dividir o caminho por pontos, mas preservar notação de array
    const segments = [];
    let currentSegment = '';
    let inBrackets = false;
    
    for (let i = 0; i < path.length; i++) {
      const char = path[i];
      
      if (char === '.' && !inBrackets) {
        if (currentSegment) {
          segments.push(currentSegment);
          currentSegment = '';
        }
      } else if (char === '[') {
        if (currentSegment) {
          segments.push(currentSegment);
          currentSegment = '';
        }
        inBrackets = true;
        currentSegment += char;
      } else if (char === ']') {
        currentSegment += char;
        inBrackets = false;
      } else {
        currentSegment += char;
      }
    }
    
    if (currentSegment) {
      segments.push(currentSegment);
    }
    
    // Navegar pelo objeto usando os segmentos do caminho
    let current = obj;
    
    for (let segment of segments) {
      // Verificar se o segmento é um índice de array
      if (segment.match(/\[\d+\]$/)) {
        // Extrair o nome da propriedade e o índice
        const match = segment.match(/^([^\[]+)\[(\d+)\]$/);
        if (match) {
          const propName = match[1];
          const index = parseInt(match[2], 10);
          
          // Obter a propriedade do objeto atual
          current = current[propName];
          
          // Verificar se é um array válido
          if (!Array.isArray(current) || current.length <= index) {
            return undefined;
          }
          
          // Obter o elemento do array pelo índice
          current = current[index];
        } else {
          // Formato diferente, apenas para índice direto [0]
          const indexMatch = segment.match(/\[(\d+)\]/);
          if (indexMatch) {
            const index = parseInt(indexMatch[1], 10);
            
            // Verificar se é um array válido
            if (!Array.isArray(current) || current.length <= index) {
              return undefined;
            }
            
            // Obter o elemento do array pelo índice
            current = current[index];
          }
        }
      } else {
        // Propriedade normal do objeto
        if (current === undefined || current === null || typeof current !== 'object') {
          return undefined;
        }
        
        current = current[segment];
      }
      
      // Se current for undefined ou null, não podemos continuar
      if (current === undefined || current === null) {
        return undefined;
      }
    }
    
    return current;
  };

  /**
   * Processa um nó do tipo jump_to, encontrando o nó alvo pelo ID
   * @param {Object} data - Dados do nó jump_to
   * @param {Object} session - Sessão atual
   * @returns {Object} - Sessão atualizada com as flags de redirecionamento
   */
  const processJumpToNode = async (data, session) => {
    try {
      if (!data.targetNodeId) {
        const error = new Error('ID do nó alvo não especificado para o nó jump_to');
        Sentry.captureException(error);
        throw error;
      }

      // Buscar o nó alvo na lista de nós do fluxo
      const targetNode = session.flow.nodes.find(node => node.id === data.targetNodeId);
      
      if (!targetNode) {
        const error = new Error(`Nó alvo com ID ${data.targetNodeId} não encontrado no fluxo`);
        Sentry.captureException(error);
        throw error;
      }
      
      // Configurar as flags de redirecionamento
      return {
        ...session,
        go_to_node: true,
        target_node: targetNode
      };
    } catch (error) {
      Sentry.captureException(error);
      throw error;
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
    processRequestNode,
    extractValueFromPath,
    updateCustomer,
    checkTriggers,
    findActiveChat,
    handleSessionTimeout
  };
}; 


export const pauseFlow = async (session) => {
  // Atualiza a sessão no banco de dados
  if(session.id) {
    const { data, error } = await supabase
    .from('flow_sessions')
    .update({
      status: 'inactive',
      updated_at: new Date().toISOString()
    })
    .eq('id', session.id);
    if(error) {
      console.error('[pauseFlow] Erro ao atualizar sessão:', error);
      throw error;
    }
  }
  //Atualiza o chat com o status de inativação
  if(session.chat_id) {
    const { data, error } = await supabase
    .from('chats')
    .update({ flow_session_id: null })
    .eq('id', session.chat_id);
    if(error) {
      console.error('[pauseFlow] Erro ao atualizar chat:', error);
      throw error;
    }
  }
  return session;
}