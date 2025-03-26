import { supabase } from '../lib/supabase.js';
import { decrypt } from '../utils/crypto.js';
import axios from 'axios';
import Sentry from '../lib/sentry.js';

/**
 * Busca todos os prompts de uma organização
 * GET /api/:organizationId/prompts
 */
export const getPrompts = async (req, res) => {
  try {
    const { organizationId } = req.params;

    // Buscar os prompts no Supabase
    const { data, error } = await supabase
      .from('prompts')
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (error) {
      throw error;
    }

    return res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('Erro ao buscar prompts:', error);
    Sentry.captureException(error);
    return res.status(500).json({
      success: false,
      error: 'Erro ao buscar prompts'
    });
  }
};

/**
 * Busca um prompt específico
 * GET /api/:organizationId/prompts/:id
 */
export const getPrompt = async (req, res) => {
  try {
    const { organizationId, id } = req.params;

    // Buscar o prompt no Supabase
    const { data, error } = await supabase
      .from('prompts')
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .single();

    if (error) {
      throw error;
    }

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Prompt não encontrado'
      });
    }

    return res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('Erro ao buscar prompt:', error);
    Sentry.captureException(error);
    return res.status(500).json({
      success: false,
      error: 'Erro ao buscar prompt'
    });
  }
};

/**
 * Cria um novo prompt
 * POST /api/:organizationId/prompts
 */
export const createPrompt = async (req, res) => {
  try {
    const { organizationId } = req.params;
    const { title, content, integration_id, model, temperature } = req.body;

    // Validar campos obrigatórios
    if (!title || !content || !integration_id) {
      return res.status(400).json({
        success: false,
        error: 'Campos obrigatórios não informados'
      });
    }

    // Inserir o prompt no Supabase
    const { data, error } = await supabase
      .from('prompts')
      .insert([{
        organization_id: organizationId,
        title,
        content,
        integration_id,
        model,
        temperature
      }])
      .select()
      .single();

    if (error) {
      throw error;
    }

    return res.status(201).json({
      success: true,
      id: data.id,
      message: 'Prompt criado com sucesso'
    });
  } catch (error) {
    console.error('Erro ao criar prompt:', error);
    Sentry.captureException(error);
    return res.status(500).json({
      success: false,
      error: 'Erro ao criar prompt'
    });
  }
};

/**
 * Atualiza um prompt existente
 * PUT /api/:organizationId/prompts/:id
 */
export const updatePrompt = async (req, res) => {
  try {
    const { organizationId, id } = req.params;
    const { title, content, integration_id, model, temperature } = req.body;

    // Buscar o prompt atual para verificar se existe
    const { data: existingPrompt, error: fetchError } = await supabase
      .from('prompts')
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .single();

    if (fetchError) {
      throw fetchError;
    }

    if (!existingPrompt) {
      return res.status(404).json({
        success: false,
        error: 'Prompt não encontrado'
      });
    }

    // Preparar os dados para atualização
    const updateData = {};
    
    if (title !== undefined) {
      updateData.title = title;
    }
    
    if (content !== undefined) {
      updateData.content = content;
    }
    
    if (integration_id !== undefined) {
      updateData.integration_id = integration_id;
    }
    
    if (model !== undefined) {
      updateData.model = model;
    }
    
    if (temperature !== undefined) {
      updateData.temperature = temperature;
    }
    
    updateData.updated_at = new Date().toISOString();

    // Atualizar o prompt no Supabase
    const { error: updateError } = await supabase
      .from('prompts')
      .update(updateData)
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (updateError) {
      throw updateError;
    }

    return res.json({
      success: true,
      message: 'Prompt atualizado com sucesso'
    });
  } catch (error) {
    console.error('Erro ao atualizar prompt:', error);
    Sentry.captureException(error);
    return res.status(500).json({
      success: false,
      error: 'Erro ao atualizar prompt'
    });
  }
};

/**
 * Exclui um prompt
 * DELETE /api/:organizationId/prompts/:id
 */
export const deletePrompt = async (req, res) => {
  try {
    const { organizationId, id } = req.params;

    // Excluir o prompt do Supabase
    const { error } = await supabase
      .from('prompts')
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) {
      throw error;
    }

    return res.json({
      success: true,
      message: 'Prompt excluído com sucesso'
    });
  } catch (error) {
    console.error('Erro ao excluir prompt:', error);
    Sentry.captureException(error);
    return res.status(500).json({
      success: false,
      error: 'Erro ao excluir prompt'
    });
  }
};

/**
 * Melhora um texto usando a API da OpenAI
 * POST /api/:organizationId/prompts/:id/improve-text
 */
export const improveTextWithOpenAI = async (req, res) => {
  try {
    const { organizationId, id } = req.params;
    const { text, improveOption, chatId, language = 'pt', customInstructions } = req.body;

    // Validar campos obrigatórios
    if (!improveOption) {
      return res.status(400).json({
        success: false,
        error: language === 'en' ? 'Improvement option is required' : 
               language === 'es' ? 'La opción de mejora es obligatoria' : 
               'Opção de melhoria é obrigatória'
      });
    }

    // Para a opção 'generate', precisamos do chatId
    if (improveOption === 'generate') {
      if (!chatId) {
        return res.status(400).json({
          success: false,
          error: language === 'en' ? 'Chat ID is required to generate a response' : 
                 language === 'es' ? 'El ID del chat es obligatorio para generar una respuesta' : 
                 'ID do chat é obrigatório para gerar resposta'
        });
      }
    } else if (improveOption === 'custom') {
      // Para a opção 'custom', precisamos de instruções customizadas e texto
      if (!customInstructions) {
        return res.status(400).json({
          success: false,
          error: language === 'en' ? 'Custom instructions are required' : 
                 language === 'es' ? 'Las instrucciones personalizadas son obligatorias' : 
                 'Instruções personalizadas são obrigatórias'
        });
      }
      if (!text) {
        return res.status(400).json({
          success: false,
          error: language === 'en' ? 'Text to improve is required' : 
                 language === 'es' ? 'El texto a mejorar es obligatorio' : 
                 'Texto a ser melhorado é obrigatório'
        });
      }
    } else {
      // Para outras opções, precisamos de texto
      if (!text) {
        return res.status(400).json({
          success: false,
          error: language === 'en' ? 'Text to improve is required' : 
                 language === 'es' ? 'El texto a mejorar es obligatorio' : 
                 'Texto a ser melhorado é obrigatório'
        });
      }
    }

    // Buscar o prompt
    const { data: prompt, error: promptError } = await supabase
      .from('prompts')
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .single();

    if (promptError) {
      throw promptError;
    }

    if (!prompt) {
      return res.status(404).json({
        success: false,
        error: language === 'en' ? 'AI Agent not found' : 
               language === 'es' ? 'Agente IA no encontrado' : 
               'Agente IA não encontrado'
      });
    }

    if (!prompt.integration_id) {
      return res.status(400).json({
        success: false,
        error: language === 'en' ? 'The selected AI Agent does not have a configured integration' : 
               language === 'es' ? 'El Agente IA seleccionado no tiene una integración configurada' : 
               'O Agente IA selecionado não possui uma integração configurada'
      });
    }

    // Buscar a integração no Supabase
    const { data: integration, error: fetchError } = await supabase
      .from('integrations')
      .select('*')
      .eq('id', prompt.integration_id)
      .eq('organization_id', organizationId)
      .eq('type', 'openai')
      .eq('status', 'active')
      .single();

    if (fetchError) {
      throw fetchError;
    }

    if (!integration) {
      return res.status(404).json({
        success: false,
        error: language === 'en' ? 'OpenAI integration not found or inactive' : 
               language === 'es' ? 'Integración de OpenAI no encontrada o inactiva' : 
               'Integração OpenAI não encontrada ou inativa'
      });
    }

    // Descriptografar a chave API
    let apiKey;
    try {
      apiKey = decrypt(integration.credentials.api_key);
    } catch (error) {
      console.error('Erro ao descriptografar chave API:', error);
      return res.status(500).json({
        success: false,
        error: language === 'en' ? 'Error processing integration credentials' : 
               language === 'es' ? 'Error al procesar las credenciales de integración' : 
               'Erro ao processar credenciais da integração'
      });
    }

    // Definir modelo padrão e temperatura
    let model = 'gpt-4o';
    let temperature = 0.7;

    // Usar modelo e temperatura do prompt, se disponíveis
    if (prompt.model) {
      model = prompt.model;
    }
    
    if (prompt.temperature !== undefined && prompt.temperature !== null) {
      temperature = prompt.temperature;
    }

    // Preparar o prompt do sistema e as mensagens com base na opção de melhoria
    let systemPrompt = '';
    let messages = [];

    if (improveOption === 'generate') {
      systemPrompt = prompt.content;

      // Se houver instruções customizadas, incluí-las no prompt do sistema
      if (customInstructions) {
        systemPrompt += `\n\n${customInstructions}`;
      }

      // Buscar mensagens do chat para contextualização
      const { data: chatMessages, error: chatError } = await supabase
        .from('messages')
        .select('*')
        .eq('chat_id', chatId)
        .in('sender_type', ['agent', 'user'])
        .order('created_at', { ascending: true });

      if (chatError) {
        throw chatError;
      }

      // Converter mensagens do chat para o formato esperado pela API da OpenAI
      messages = chatMessages.map(msg => ({
        role: msg.sender_type === 'agent' ? 'assistant' : 'user',
        content: msg.content || ''
      }));
    } else {
      // Configurar prompts específicos para cada tipo de melhoria com base no idioma
      let basePrompt = '';
      
      switch (improveOption) {
        case 'improve':
          if (language === 'en') {
            basePrompt = 'Improve the provided text while maintaining the original meaning, but making it clearer, more concise, and more professional.';
          } else if (language === 'es') {
            basePrompt = 'Mejora el texto proporcionado manteniendo el significado original, pero haciéndolo más claro, conciso y profesional.';
          } else {
            basePrompt = 'Melhore o texto fornecido mantendo o significado original, mas tornando-o mais claro, conciso e profissional.';
          }
          break;
        case 'expand':
          if (language === 'en') {
            basePrompt = 'Expand the provided text by adding more details, examples, and explanations, while maintaining the original tone and style.';
          } else if (language === 'es') {
            basePrompt = 'Expande el texto proporcionado añadiendo más detalles, ejemplos y explicaciones, manteniendo el tono y estilo originales.';
          } else {
            basePrompt = 'Expanda o texto fornecido adicionando mais detalhes, exemplos e explicações, mantendo o tom e o estilo originais.';
          }
          break;
        case 'shorten':
          if (language === 'en') {
            basePrompt = 'Summarize the provided text while maintaining the main points and essential meaning, but significantly reducing the length.';
          } else if (language === 'es') {
            basePrompt = 'Resume el texto proporcionado manteniendo los puntos principales y el significado esencial, pero reduciendo significativamente la longitud.';
          } else {
            basePrompt = 'Resuma o texto fornecido mantendo os pontos principais e o significado essencial, mas reduzindo significativamente o comprimento.';
          }
          break;
        case 'formal':
          if (language === 'en') {
            basePrompt = 'Rewrite the provided text in a more formal and professional tone, while maintaining the original meaning.';
          } else if (language === 'es') {
            basePrompt = 'Reescribe el texto proporcionado en un tono más formal y profesional, manteniendo el significado original.';
          } else {
            basePrompt = 'Reescreva o texto fornecido em um tom mais formal e profissional, mantendo o significado original.';
          }
          break;
        case 'casual':
          if (language === 'en') {
            basePrompt = 'Rewrite the provided text in a more casual and conversational tone, while maintaining the original meaning.';
          } else if (language === 'es') {
            basePrompt = 'Reescribe el texto proporcionado en un tono más casual y conversacional, manteniendo el significado original.';
          } else {
            basePrompt = 'Reescreva o texto fornecido em um tom mais casual e conversacional, mantendo o significado original.';
          }
          break;
        case 'custom':
          // Usar as instruções customizadas fornecidas pelo usuário
          basePrompt = customInstructions;
          break;
        default:
          if (language === 'en') {
            basePrompt = 'Improve the provided text while maintaining the original meaning.';
          } else if (language === 'es') {
            basePrompt = 'Mejora el texto proporcionado manteniendo el significado original.';
          } else {
            basePrompt = 'Melhore o texto fornecido mantendo o significado original.';
          }
      }
      
      // Combinar o prompt base com o conteúdo do prompt personalizado
      systemPrompt = `${prompt.content}\n\n${basePrompt}`;

      // Adicionar a mensagem do usuário com o texto a ser melhorado
      messages = [{ role: 'user', content: text }];
    }

    // Adicionar instrução para responder no idioma selecionado
    if (language === 'en') {
      systemPrompt += ' Respond in English.';
    } else if (language === 'es') {
      systemPrompt += ' Responde en español.';
    } else {
      systemPrompt += ' Responda em português.';
    }

    // Chamar a API da OpenAI
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages
          ],
          temperature,
          max_tokens: 2000
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      // Extrair o texto da resposta
      const improvedText = response.data.choices[0].message.content;

      return res.json({
        success: true,
        data: {
          text: improvedText,
          usage: response.data.usage
        }
      });
    } catch (error) {
      console.error('Erro ao chamar API da OpenAI:', error.response?.data || error);
      
      const errorMessage = language === 'en' ? 'Error processing text with OpenAI API' : 
                           language === 'es' ? 'Error al procesar el texto con la API de OpenAI' : 
                           'Erro ao processar o texto com a API da OpenAI';
      
      return res.status(error.response?.status || 500).json({
        success: false,
        error: error.response?.data?.error?.message || errorMessage
      });
    }
  } catch (error) {
    console.error('Erro ao processar melhoria de texto:', error);
    Sentry.captureException(error);
    
    const errorMessage = req.body.language === 'en' ? 'Error processing text improvement' : 
                         req.body.language === 'es' ? 'Error al procesar la mejora del texto' : 
                         'Erro ao processar melhoria de texto';
    
    return res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
}; 