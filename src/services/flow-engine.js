import { supabase } from '../lib/supabase.js';
import Sentry from '../lib/sentry.js';
import { OpenAI } from 'openai';
import { createMessageToSend, sendSystemMessage } from '../controllers/chat/message-handlers.js';
import crypto from 'crypto';
import { decrypt } from '../utils/crypto.js';
import { processAgentIA } from './agent-ia.js';

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

      // console.log('Active Flow:', activeFlow);

      if (activeFlow) {
        // Verificar se está dentro do período de debounce
        const now = new Date();
        const debounceTime = activeFlow.flow?.debounce_time || 10000; // em milissegundos
        
        // console.log('debounceTime', debounceTime);
        // console.log('activeFlow.debounce_timestamp', activeFlow.debounce_timestamp);
        // console.log('now.getTime()', now.getTime());
        // console.log('new Date(activeFlow.debounce_timestamp).getTime()', new Date(activeFlow.debounce_timestamp).getTime());
        // console.log('now.getTime() - new Date(activeFlow.debounce_timestamp).getTime()', now.getTime() - new Date(activeFlow.debounce_timestamp).getTime());
        
        if (activeFlow.debounce_timestamp && 
            now.getTime() - new Date(activeFlow.debounce_timestamp).getTime() < debounceTime) {
              // Adicionar mensagem ao histórico temporário
              if(message.content) {
                await updateMessageHistory(activeFlow.id, {
                  content: message.content,
                  type: message.type,
                  timestamp: now
                });
              }
              
              return; // Aguardar próxima mensagem
            }

        // Se chegou aqui, o período de debounce acabou ou é a primeira mensagem
        // Buscar novamente o fluxo ativo para obter o histórico de mensagens atualizado
        activeFlow = await getActiveFlow();

        // Atualizar timestamp do debounce para a mensagem atual
        // Isso é crucial para iniciar o período de debounce
        await updateSession(activeFlow.id, {
          debounce_timestamp: now
        });

        // Processar todas as mensagens acumuladas
        const messages = activeFlow.message_history || [];
        messages.push({
          content: message.content,
          type: message.type,
          timestamp: now
        });

        // Processar mensagens acumuladas
        const combinedMessage = {
          content: messages.map(m => m.content).join('\n'),
          type: message.type,
          metadata: { ...message.metadata, original_messages: messages }
        };

        // Definimos um timeout para processar a mensagem após o período de debounce
        setTimeout(async () => {
          try {
            // Buscar a sessão mais recente para verificar se ainda é a mesma mensagem de debounce
            const currentSession = await getActiveFlow();
            
            // Verificar se o timestamp do debounce ainda é o mesmo
            // Se for diferente, significa que uma nova mensagem chegou e alterou o timestamp
            if (currentSession && 
                currentSession.debounce_timestamp && 
                new Date(currentSession.debounce_timestamp).getTime() === now.getTime()) {
                
              // Executar o fluxo apenas se o timestamp não tiver sido atualizado por uma nova mensagem
              // console.log('Executando fluxo após o período de debounce  ------------------ ');
              await continueFlow(currentSession, combinedMessage);
              
              // Limpar histórico após processamento
              await clearMessageHistory(currentSession.id);
              
              // Limpar o timestamp de debounce
              await updateSession(currentSession.id, {
                debounce_timestamp: null
              });
            }
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
        )
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

        // Função para extrair listas formatadas do texto
        const extractFormattedList = (text) => {
          // Verifica se o texto contém marcadores de lista
          if (!text.includes('**') && !text.includes('-') && !text.match(/\d+\.\s*\*\*/)) {
            return null;
          }

          // Tenta extrair seções e itens
          const sections = [];
          let currentSection = null;
          let title = "";
          let description = "";
          
          // Extrai o título e descrição (primeiras linhas antes das seções)
          const lines = text.split('\n');
          let i = 0;
          
          // Pula linhas vazias iniciais
          while (i < lines.length && lines[i].trim() === '') i++;
          
          // Título pode ser a primeira linha não vazia
          if (i < lines.length) {
            // Verificamos se a primeira linha não é já um item de lista
            if (!lines[i].match(/^(\d+\.\s*\*\*|\-\s*\*\*|\*\*)/)) {
              title = lines[i].replace(/[*#]/g, '').trim();
              i++;
            }
          }
          
          // Descrição pode ser as próximas linhas até encontrar uma seção ou item numerado
          let descLines = [];
          while (i < lines.length && 
                !lines[i].match(/^\*\*[^*]+\*\*:?$/) && 
                !lines[i].startsWith('**') && 
                !lines[i].match(/^\d+\.\s*\*\*/)) {
            if (lines[i].trim() !== '') {
              descLines.push(lines[i].trim());
            }
            i++;
          }
          description = descLines.join(' ').trim();
          
          // Se não encontramos título ou seções explícitas,
          // vamos criar uma seção única para os itens numerados
          let hasNumberedItems = false;
          currentSection = {
            title: "Serviços",
            rows: []
          };
          sections.push(currentSection);
          
          // Processa o resto do texto para encontrar seções e itens
          for (; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Ignora linhas vazias
            if (line === '') continue;
            
            // Verifica se é um título de seção
            const sectionMatch = line.match(/^\*\*([^*]+)\*\*:?$/); // Ex: **Doces:**
            if (sectionMatch || (line.startsWith('**') && line.endsWith('**:')) ||
                line.endsWith('**')) {
              let sectionTitle = line.replace(/^\*\*|\*\*:?$/g, '').trim();
              
              // Cria nova seção
              currentSection = {
                title: sectionTitle,
                rows: []
              };
              sections.push(currentSection);
              continue;
            }
            
            // Verifica se é um item de lista com marcador (-)
            const bulletItemMatch = line.match(/^-\s*\*\*([^*]+)\*\*:?(.*)$/); // Ex: - **Bombom de Morango:** R$ 12,00
            if (bulletItemMatch && currentSection) {
              let itemTitle = bulletItemMatch[1].trim();
              let itemDescription = bulletItemMatch[2].trim();
              
              currentSection.rows.push({
                title: itemTitle,
                description: itemDescription,
                rowId: ""
              });
              continue;
            }
            
            // Verifica se é um item de lista numerada
            const numberedItemMatch = line.match(/^\d+\.\s*\*\*([^*]+)\*\*:?(.*)$/); // Ex: 1. **Urgências**: Atendidas...
            if (numberedItemMatch) {
              hasNumberedItems = true;
              let itemTitle = numberedItemMatch[1].trim();
              let itemDescription = numberedItemMatch[2].trim();
              
              // Se a descrição continua nas próximas linhas (sem ser item ou seção)
              let j = i + 1;
              while (j < lines.length && 
                     lines[j].trim() !== '' && 
                     !lines[j].match(/^\d+\.\s*\*\*/) && 
                     !lines[j].match(/^-\s*\*\*/) &&
                     !lines[j].match(/^\*\*[^*]+\*\*:?$/)) {
                itemDescription += " " + lines[j].trim();
                j++;
              }
              
              // Avançamos o índice se processamos linhas adicionais
              if (j > i + 1) {
                i = j - 1;
              }
              
              currentSection.rows.push({
                title: itemTitle,
                description: itemDescription,
                rowId: ""
              });
              continue;
            }
          }
          
          // Se encontrou seções ou itens numerados, retorna objeto formatado
          if (sections.length > 1 || (sections.length === 1 && currentSection.rows.length > 0)) {
            // Remover a primeira seção genérica se não tiver itens
            if (sections.length > 1 && sections[0].rows.length === 0) {
              sections.shift();
            }
            
            // Detecta o idioma pelo conteúdo para determinar o texto do botão
            let buttonText = "📋";
            if (title.toLowerCase().includes("cardápio") || 
                title.toLowerCase().includes("menu") || 
                description.toLowerCase().includes("cardápio")) {
              buttonText = "Ver cardápio 📋";
            } else if (title.toLowerCase().includes("serviço") || 
                description.toLowerCase().includes("serviço") ||
                title.toLowerCase().includes("atendimento")) {
              buttonText = "Ver serviços 📋";
            } else if (title.toLowerCase().includes("lista") || 
                description.toLowerCase().includes("lista")) {
              buttonText = "Ver lista 📋";
            }
            
            return {
              title: title || "",
              description: description || "👇", 
              buttonText: buttonText,
              footerText: "",
              sections: sections
            };
          }
          
          return null;
        };

        // Função para processar e enviar as partes do texto
        const processAndSendParts = async (parts, metadata) => {
          for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLastPart = i === parts.length - 1;
            
            if (part.type === 'text') {
              // Verifica se o texto contém uma lista formatada e se a opção está ativada
              const formattedList = node.data.extractList ? extractFormattedList(part.content) : null;
              
              if (formattedList) {
                // Se encontrou uma lista formatada, envia com o metadata de lista
                await sendMessage(part.content, null, updatedSession.id, { list: formattedList });
              } else if (node.data.splitParagraphs) {
                // Se não encontrou lista, segue com o comportamento normal de splitParagraphs
                const paragraphs = part.content
                  .split('\n\n')
                  .filter(paragraph => paragraph.trim().length > 0);
                
                for (let j = 0; j < paragraphs.length; j++) {
                  const paragraph = paragraphs[j];
                  const isLastParagraph = j === paragraphs.length - 1;
                  
                  const currentMetadata = isLastParagraph && isLastPart ? metadata : null;
                  await sendMessage(paragraph, null, updatedSession.id, currentMetadata);
                  
                  if (paragraphs.length > 1 && !isLastParagraph) {
                    await processDelay(2);
                  }
                }
              } else {
                // Comportamento padrão para texto
                const currentMetadata = isLastPart ? metadata : null;
                await sendMessage(part.content, null, updatedSession.id, currentMetadata);
              }
            } else if (part.type === 'link' && part.mediaType) {
              // Se for um link de mídia, envia como anexo
              await sendMessage(null, {
                attachments: [{
                  url: part.url,
                  type: part.mediaType,
                  content: part.content
                }]
              }, updatedSession.id);
              
              // Adiciona um delay maior após enviar arquivos de mídia
              // para garantir que o arquivo seja enviado completamente
              await processDelay(5);
            } else if (part.type === 'link') {
              await sendMessage(`${part.url}`, null, updatedSession.id);
              
              // Adiciona um delay maior para links também
              await processDelay(3);
            }
            
            // Adiciona delay entre partes se não for a última
            if (!isLastPart) {
              await processDelay(2);
            }
          }
        };

        // Processa o texto com ou sem extração de links
        if (node.data.extractLinks) {
          const parts = extractLinks(processedText);
          const metadata = node.data.listOptions ? { list: node.data.listOptions } : null;
          await processAndSendParts(parts, metadata);
        } else {
          // Verifica se o texto contém uma lista formatada e se a opção está ativada
          const formattedList = node.data.extractList ? extractFormattedList(processedText) : null;
          
          if (formattedList) {
            // Se encontrou uma lista formatada, envia com o metadata de lista
            await sendMessage(processedText, null, updatedSession.id, { list: formattedList });
          } else if (node.data.splitParagraphs) {
            // Comportamento existente para splitParagraphs
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
        } else {
            // Comportamento padrão
          const metadata = node.data.listOptions ? { list: node.data.listOptions } : null;
          await sendMessage(processedText, null, updatedSession.id, metadata);
          }
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

      case 'agenteia':
        updatedSession = await processAgentIA(node, updatedSession, sendMessage, updateSession);
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
        // console.log('logicOperator', logicOperator);
        // console.log('subConditions', subConditions);

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
  const sendMessage = async (content, files, sessionId, metadata) => {
    try {
      // console.log('sendMessage', content, files, sessionId, metadata);
      if(content || files) {
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
        const error = new Error('Campos para atualização não especificados');
        Sentry.captureException(error);
        throw error;
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