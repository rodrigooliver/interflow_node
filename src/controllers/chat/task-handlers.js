import { getOpenAIIntegration } from '../integrations.js';
import { supabase } from '../../lib/supabase.js';
import { decrypt } from '../../utils/crypto.js';
import OpenAI from 'openai';
import { registerTokenUsage } from '../organizations/usage.js';

/**
 * Gera conteúdo para uma tarefa com base no histórico de um chat
 * @param {string} chatId - ID do chat
 * @param {string} apiKey - Chave API da OpenAI
 * @param {boolean} keyDefault - Se a chave é a default do Interflow
 * @param {string} language - Idioma preferido (pt/en)
 * @param {string} organizationId - ID da organização
 * @param {string} integrationId - ID da integração
 * @returns {Object} Objeto com título, descrição, data sugerida, prioridade e subtarefas
 */
async function generateTaskContent(chatId, apiKey, keyDefault = false, language = 'pt', organizationId, integrationId) {
  // Buscar informações do chat, incluindo o cliente
  const { data: chatData, error: chatError } = await supabase
    .from('chats')
    .select(`
      *,
      customers(id, name)
    `)
    .eq('id', chatId)
    .single();

  if (chatError) {
    throw chatError;
  }

  // Buscar mensagens do chat
  const { data: chatMessages, error: messagesError } = await supabase
    .from('messages')
    .select('*')
    .eq('chat_id', chatId)
    .in('sender_type', ['agent', 'customer'])
    .order('created_at', { ascending: true });

  if (messagesError) {
    throw messagesError;
  }

  // Obter a data atual no fuso horário de São Paulo
  const now = new Date();
  // Configurar para o fuso horário de São Paulo (GMT-3)
  const saoPauloOptions = { timeZone: 'America/Sao_Paulo' };
  const currentDateSaoPaulo = now.toLocaleDateString('pt-BR', saoPauloOptions);
  const currentTimeSaoPaulo = now.toLocaleTimeString('pt-BR', saoPauloOptions);
  const weekdaySaoPaulo = now.toLocaleDateString('pt-BR', { ...saoPauloOptions, weekday: 'long' });
  
  // Formato ISO para cálculos mais precisos
  const isoDateSaoPaulo = now.toLocaleString('sv', saoPauloOptions).replace(' ', 'T');

  // Informações do cliente para fornecer contexo
  const customerInfo = chatData.customers 
    ? `Cliente: ${chatData.customers.name} (ID: ${chatData.customers.id})`
    : 'Cliente não identificado';

  // Converter mensagens do chat para o formato esperado pela API da OpenAI
  const messages = chatMessages.map(msg => ({
    role: msg.sender_type === 'agent' ? 'assistant' : 'user',
    content: msg.content || ''
  }));

  // Sistema de prompt adequado para a geração de conteúdo de tarefas
  const currentDateInfo = language === 'pt'
    ? `Data atual: ${currentDateSaoPaulo} (${weekdaySaoPaulo}), hora atual: ${currentTimeSaoPaulo}, fuso horário: São Paulo (GMT-3)`
    : `Current date: ${currentDateSaoPaulo} (${weekdaySaoPaulo}), current time: ${currentTimeSaoPaulo}, timezone: São Paulo (GMT-3)`;

  const systemPrompt = language === 'pt' 
    ? `Crie uma tarefa baseada na conversa:

    Data/hora atual: ${currentDateInfo}

    Gere JSON com:
    - title: título conciso (máx 80 chars)
    - description: resumo dos pontos principais
    - due_date: YYYY-MM-DD (urgente=hoje/amanhã, normal=3-5 dias úteis, evite fins de semana)
    - due_date_reason: justificativa breve
    - time: horário sugerido HH:MM (baseado no contexto ou horário comercial padrão)
    - priority: baixa/média/alta (alta=urgente/crítico, média=importante, baixa=simples)
    - priority_reason: justificativa breve
    - subtasks: 2-5 itens principais

    JSON:
    {
      "title": "",
      "description": "",
      "due_date": "",
      "due_date_reason": "",
      "time": "",
      "priority": "",
      "priority_reason": "",
      "subtasks": []
    }`
    : `Create task from conversation:

    Current date/time: ${currentDateInfo}

    Generate JSON with:
    - title: concise title (max 80 chars)
    - description: main points summary
    - due_date: YYYY-MM-DD (urgent=today/tomorrow, normal=3-5 business days, avoid weekends)
    - due_date_reason: brief justification
    - time: suggested time HH:MM (based on context or standard business hours)
    - priority: low/medium/high (high=urgent/critical, medium=important, low=simple)
    - priority_reason: brief justification
    - subtasks: 2-5 main items

    JSON:
    {
      "title": "",
      "description": "",
      "due_date": "",
      "due_date_reason": "",
      "time": "",
      "priority": "",
      "priority_reason": "",
      "subtasks": []
    }`;

  // Chamar a API da OpenAI
  const openai = new OpenAI({
    apiKey: apiKey,
  });

  const response = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Informações do contexto: ${customerInfo}\nData atual: ${isoDateSaoPaulo}` },
      ...messages
    ],
    text: {
      format: {
        type: "json_object"
      }
    },
    reasoning: {},
    tools: [],
    temperature: 0.7,
    max_output_tokens: 2048,
    top_p: 1,
    store: false
  });
  // Calcular custo baseado nos preços da OpenAI:
  // Input: $0.40 / 1M tokens = $0.0000004 por token
  // Output: $1.60 / 1M tokens = $0.0000016 por token
  const inputCost = response.usage.input_tokens * 0.0000004;
  const outputCost = response.usage.output_tokens * 0.0000016;
  const totalCost = inputCost + outputCost;

  //Atualizar o usage
  registerTokenUsage({
    organizationId: organizationId,
    chatId: chatId,
    integrationId: integrationId,
    tokenSource: (keyDefault ? 'system' : 'client'),
    modelName: response.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    costUsd: totalCost,
  });

  try {
    // Parsear a resposta JSON
    const content = response.output_text;
    const result = JSON.parse(content);
    
    // Normalizar a prioridade para garantir compatibilidade
    if (result.priority) {
      // Converter para minúsculas e remover acentos
      const normalizedPriority = result.priority.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      
      // Mapear para os valores aceitos pelo sistema
      if (normalizedPriority.includes('alt') || normalizedPriority.includes('high')) {
        result.priority = 'high';
      } else if (normalizedPriority.includes('med') || normalizedPriority.includes('medi')) {
        result.priority = 'medium';
      } else {
        result.priority = 'low';
      }
    } else {
      // Valor padrão
      result.priority = 'medium';
    }
    
    return result;
  } catch (error) {
    console.error("Erro ao processar resposta da IA:", error);
    // Retornar um objeto com valores padrão em caso de erro
    return {
      title: "Tarefa baseada em chat",
      description: "Não foi possível gerar uma descrição automática.",
      due_date: "",
      due_date_reason: "",
      time: "09:00",
      priority: "medium",
      priority_reason: "",
      subtasks: []
    };
  }
}

export const generateTaskContentRoute = async (req, res) => {
  try {
    const { organizationId, chatId } = req.params;
    const { language = 'pt' } = req.body;
    const { usage } = req;

    // console.log('usage', usage);

    // Buscar integração OpenAI ativa
    let keyDefault = false;
    let apiKey;
    const openAIIntegration = await getOpenAIIntegration(organizationId);
    if (openAIIntegration) {
      // Descriptografar a chave API
      apiKey = decrypt(openAIIntegration.credentials.api_key);
    } else {
      if(usage.tokens.used < usage.tokens.limit) {
        //Utilizar chave default interflow
        apiKey = process.env.OPENAI_API_KEY;
        keyDefault = true;
      } else {
        return res.status(400).json({
          success: false,
          error: 'Nenhuma integração OpenAI ativa encontrada'
        });
      }
    }

    if(!apiKey) {
      return res.status(400).json({
        success: false,
        error: 'Nenhuma chave API encontrada'
      });
    }

    // Gerar conteúdo da tarefa
    const taskContent = await generateTaskContent(chatId, apiKey, keyDefault, language, organizationId, openAIIntegration.id);

    return res.json({
      success: true,
      data: taskContent
    });

  } catch (error) {
    console.error('Erro ao gerar conteúdo da tarefa:', error);
    return res.status(500).json({
      success: false,
      error: 'Erro ao gerar conteúdo da tarefa'
    });
  }
}; 