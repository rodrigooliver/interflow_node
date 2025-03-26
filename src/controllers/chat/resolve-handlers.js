import { getOpenAIIntegration } from '../integrations.js';
import { supabase } from '../../lib/supabase.js';
import { decrypt } from '../../utils/crypto.js';
import axios from 'axios';

async function generateChatSummary(chatId, apiKey) {
  // Buscar mensagens do chat
  const { data: chatMessages, error: chatError } = await supabase
    .from('messages')
    .select('*')
    .eq('chat_id', chatId)
    .in('sender_type', ['agent', 'customer'])
    .order('created_at', { ascending: true });

  if (chatError) {
    throw chatError;
  }

  // Converter mensagens do chat para o formato esperado pela API da OpenAI
  const messages = chatMessages.map(msg => ({
    role: msg.sender_type === 'agent' ? 'assistant' : 'user',
    content: msg.content || ''
  }));

  // Chamar a API da OpenAI
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [
        ...messages,
        { 
            role: 'system', 
            content: 'Create a single-sentence summary of the conversation. Keep the same language used in the chat and focus on the key resolution.' 
        },
      ],
      temperature: 0.7,
      max_tokens: 500
    },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return response.data.choices[0].message.content;
}

export const resolveChatRoute = async (req, res) => {
  try {
    const { organizationId, chatId } = req.params;

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

    // Gerar resumo do chat
    const chatSummary = await generateChatSummary(chatId, apiKey);

    // TODO: Salvar o resumo e atualizar o status do chat no banco de dados

    return res.json({
      success: true,
      data: {
        summary: chatSummary
      }
    });

  } catch (error) {
    console.error('Erro ao resolver chat:', error);
    return res.status(500).json({
      success: false,
      error: 'Erro ao resolver chat'
    });
  }
}; 