import { getOpenAIIntegration } from '../integrations.js';
import { supabase } from '../../lib/supabase.js';
import { decrypt } from '../../utils/crypto.js';
import axios from 'axios';

/**
 * Gera conteúdo para uma tarefa com base no histórico de um chat
 * @param {string} chatId - ID do chat
 * @param {string} apiKey - Chave API da OpenAI
 * @param {string} language - Idioma preferido (pt/en)
 * @returns {Object} Objeto com título, descrição, data sugerida, prioridade e subtarefas
 */
async function generateTaskContent(chatId, apiKey, language = 'pt') {
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
    ? `Com base na conversa, crie:
    1. Um título conciso para uma tarefa (máximo 80 caracteres)
    2. Uma descrição detalhada que capture os pontos importantes
    3. Uma data de vencimento sugerida (no formato YYYY-MM-DD) com justificativa baseada no contexto
    4. Uma prioridade adequada (baixa, média ou alta) com justificativa
    5. Uma lista de 2 a 5 subtarefas importantes para resolver a questão

    Considere a data e hora atuais: ${currentDateInfo}

    Ao sugerir a data de vencimento:
    - Se a conversa tiver urgência explícita, sugira uma data próxima (hoje ou amanhã)
    - Se não houver urgência, sugira uma data útil considerando dias úteis (seg-sex)
    - Evite sugerir datas no passado ou em finais de semana
    - Se não houver contexto para determinar uma data, sugira um prazo razoável de 3-5 dias úteis

    Ao determinar a prioridade:
    - Alta: Problemas urgentes que afetam o cliente negativamente, solicitações de clientes VIP, questões críticas
    - Média: Questões importantes mas não urgentes, melhorias necessárias, dúvidas que precisam ser resolvidas
    - Baixa: Dúvidas simples já respondidas, sugestões futuras, melhorias cosméticas

    Responda no formato JSON:
    {
      "title": "Título da tarefa",
      "description": "Descrição detalhada com as informações relevantes",
      "due_date": "YYYY-MM-DD",
      "due_date_reason": "Justificativa para a data sugerida",
      "priority": "baixa|média|alta",
      "priority_reason": "Justificativa para a prioridade sugerida",
      "subtasks": ["Subtarefa 1", "Subtarefa 2", ...]
    }

    Mantenha o mesmo idioma usado na conversa.`
    : `Based on the conversation, create:
    1. A concise task title (max 80 characters)
    2. A detailed description capturing important points
    3. A suggested due date (in YYYY-MM-DD format) with justification based on context
    4. An appropriate priority (low, medium, or high) with justification
    5. A list of 2 to 5 important subtasks to resolve the issue

    Consider the current date and time: ${currentDateInfo}

    When suggesting the due date:
    - If the conversation has explicit urgency, suggest a close date (today or tomorrow)
    - If there is no urgency, suggest a useful date considering business days (Mon-Fri)
    - Avoid suggesting dates in the past or on weekends
    - If there is no context to determine a date, suggest a reasonable deadline of 3-5 business days

    When determining priority:
    - High: Urgent issues negatively affecting the customer, VIP client requests, critical matters
    - Medium: Important but non-urgent issues, necessary improvements, questions that need resolution
    - Low: Simple questions already answered, future suggestions, cosmetic improvements

    Respond in JSON format:
    {
      "title": "Task title",
      "description": "Detailed description with relevant information",
      "due_date": "YYYY-MM-DD",
      "due_date_reason": "Justification for suggested date",
      "priority": "low|medium|high",
      "priority_reason": "Justification for the suggested priority",
      "subtasks": ["Subtask 1", "Subtask 2", ...]
    }

    Keep the same language used in the conversation.`;

  // Chamar a API da OpenAI
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Informações do contexto: ${customerInfo}\nData atual: ${isoDateSaoPaulo}` },
        ...messages
      ],
      temperature: 0.7,
      max_tokens: 1000,
      response_format: { type: "json_object" }
    },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  try {
    // Parsear a resposta JSON
    const content = response.data.choices[0].message.content;
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

    // Buscar integração OpenAI ativa
    const openAIIntegration = await getOpenAIIntegration(organizationId);
    if (!openAIIntegration) {
      return res.status(400).json({
        success: false,
        error: 'Nenhuma integração OpenAI ativa encontrada'
      });
    }

    // Descriptografar a chave API
    let apiKey;
    try {
      apiKey = decrypt(openAIIntegration.credentials.api_key);
    } catch (error) {
      console.error('Erro ao descriptografar chave API:', error);
      return res.status(500).json({
        success: false,
        error: 'Erro ao processar credenciais da integração'
      });
    }

    // Gerar conteúdo da tarefa
    const taskContent = await generateTaskContent(chatId, apiKey, language);

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