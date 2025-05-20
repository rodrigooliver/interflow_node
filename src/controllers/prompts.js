import { supabase } from '../lib/supabase.js';
import { decrypt } from '../utils/crypto.js';
import axios from 'axios';
import Sentry from '../lib/sentry.js';
import { v4 as uuidv4 } from 'uuid';
import { uploadFile, deleteFile } from '../utils/file-upload.js';
import { getActiveS3Integration } from '../lib/s3.js';

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

      // Se a última mensagem for do agente e a opção for 'generate',
      // adicionar uma mensagem de usuário solicitando resposta
      if (!messages.length || (messages.length > 0 && messages[messages.length - 1].role === 'assistant')) {
        messages.push({
          role: 'user',
          content: 'Please generate a response for the client based on this conversation.'
        });
      }
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
      systemPrompt = prompt.content;

      // Adicionar a mensagem do usuário com o texto a ser melhorado e incluir o basePrompt
      messages = [{ role: 'user', content: `${basePrompt}\n\n${text}` }];
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
      const apiRequestBody = {
        model,
        messages: improveOption === 'generate' ?
          [
            { role: 'system', content: systemPrompt },
            ...messages
          ] : [...messages],
        temperature,
        max_tokens: 2000
      };

      console.log('Fazendo requisição para OpenAI API:', JSON.stringify({
        url: 'https://api.openai.com/v1/chat/completions',
        model: apiRequestBody.model,
        temperature: apiRequestBody.temperature
      }));

      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        apiRequestBody,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      console.log('Resposta da OpenAI API:', JSON.stringify({
        status: response.status,
        usage: response.data.usage
      }));

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

export async function uploadImage(req, res) {
  try {
    const { organizationId, id: promptId } = req.params;
    const file = req.files?.file;
    const description = req.body?.description || '';

    if (!file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }

    if (!promptId) {
      return res.status(400).json({ error: 'ID do prompt não fornecido' });
    }

    // Validar tipo de arquivo
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/quicktime', 'video/x-msvideo',
      'audio/mpeg', 'audio/wav', 'audio/ogg',
      'application/pdf',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain'
    ];

    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({ error: 'Tipo de arquivo não suportado' });
    }

    // Validar tamanho do arquivo (10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB em bytes
    if (file.size > maxSize) {
      return res.status(400).json({ error: 'Arquivo muito grande. Tamanho máximo: 10MB' });
    }

     // Buscar o prompt atual
     const { data: prompt, error: promptError } = await supabase
     .from('prompts')
     .select('media')
     .eq('id', promptId)
     .eq('organization_id', organizationId)
     .single();

    if (promptError) {
      throw promptError;
    }

    if (!prompt) {
      return res.status(404).json({ error: 'Prompt não encontrado' });
    }

    // Determinar o tipo de mídia baseado no mimetype
    let mediaType;
    if (file.mimetype.startsWith('image/')) {
      mediaType = 'image';
    } else if (file.mimetype.startsWith('video/')) {
      mediaType = 'video';
    } else if (file.mimetype.startsWith('audio/')) {
      mediaType = 'audio';
    } else if (file.mimetype === 'application/pdf') {
      mediaType = 'pdf';
    } else {
      mediaType = 'document';
    }

    // Gerar nome único para o arquivo
    const fileExtension = file.name.split('.').pop();
    const uniqueFileName = `${uuidv4()}.${fileExtension}`;

    // Upload do arquivo usando a função uploadFile
    const uploadResult = await uploadFile({
      fileData: file.data,
      fileName: uniqueFileName,
      contentType: file.mimetype,
      fileSize: file.size,
      organizationId,
      customFolder: 'prompts',
      promptId: promptId
    });

    if (!uploadResult.success) {
      throw new Error(uploadResult.error || 'Erro ao fazer upload do arquivo');
    }

    // Preparar o novo item de mídia
    const newMediaItem = {
      id: uploadResult.fileId,
      url: uploadResult.fileUrl,
      name: file.name,
      type: mediaType,
      description: description
    };

    // Atualizar o array de mídia do prompt
    const updatedMedia = [...(prompt.media || []), newMediaItem];
    
    const { error: updateError } = await supabase
      .from('prompts')
      .update({ media: updatedMedia })
      .eq('id', promptId)
      .eq('organization_id', organizationId);

    if (updateError) {
      throw updateError;
    }

    return res.json({
      success: true,
      fileId: uploadResult.fileId,
      url: uploadResult.fileUrl,
      name: file.name,
      type: mediaType,
      description: description
    });
  } catch (error) {
    Sentry.captureException(error);
    return res.status(500).json({ error: 'Erro ao fazer upload de mídia' });
  }
}

export const deleteMedia = async (req, res) => {
  try {
    const { organizationId, id: promptId, mediaId } = req.params;

    // Busca o prompt para verificar se existe e pertence à organização
    const { data: prompt, error: promptError } = await supabase
      .from('prompts')
      .select('*')
      .eq('id', promptId)
      .eq('organization_id', organizationId)
      .single();

    if (promptError || !prompt) {
      return res.status(404).json({ success: false, error: 'Prompt não encontrado' });
    }

    // Busca a mídia para verificar se existe e pertence ao prompt
    const mediaItem = prompt.media.find(item => item.id === mediaId);
    if (!mediaItem) {
      return res.status(404).json({ success: false, error: 'Mídia não encontrada' });
    }

    // Exclui o arquivo usando a função deleteFile
    const deleteResult = await deleteFile({
      fileId: mediaId,
      organizationId
    });

    if (!deleteResult.success) {
      console.error('Erro ao excluir arquivo:', deleteResult.error);
      return res.status(500).json({ success: false, error: deleteResult.error || 'Erro ao excluir arquivo' });
    }

    // Remove a mídia do array
    const updatedMedia = prompt.media.filter(item => item.id !== mediaId);

    // Atualiza o prompt com o novo array de mídia
    const { error: updateError } = await supabase
      .from('prompts')
      .update({ media: updatedMedia })
      .eq('id', promptId)
      .eq('organization_id', organizationId);

    if (updateError) {
      console.error('Erro ao atualizar prompt:', updateError);
      return res.status(500).json({ success: false, error: 'Erro ao excluir mídia' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao excluir mídia:', error);
    Sentry.captureException(error);
    res.status(500).json({ success: false, error: 'Erro ao excluir mídia' });
  }
};

/**
 * Gera um prompt com base nas informações do negócio usando OpenAI
 * POST /api/:organizationId/prompts/generate-prompt
 */
export const generatePromptWithOpenAI = async (req, res) => {
  try {
    const { organizationId } = req.params;
    const { 
      attendantName,
      businessName, 
      businessDescription, 
      industry, 
      targetAudience, 
      tone,
      language = 'pt',
      specificNeeds
    } = req.body;

    // Validar campos obrigatórios
    if (!businessDescription) {
      return res.status(400).json({
        success: false,
        error: language === 'en' ? 'Business description is required' :
               language === 'es' ? 'La descripción del negocio es obligatoria' :
               'Descrição do negócio é obrigatória'
      });
    }

    // Usar a chave API diretamente do ambiente
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        error: language === 'en' ? 'OpenAI API key not configured' :
               language === 'es' ? 'Clave de API de OpenAI no configurada' :
               'Chave de API da OpenAI não configurada'
      });
    }

    // Definir tom padrão se não for fornecido
    const selectedTone = tone || 'professional';
    
    // Criar o sistema de prompt para o GPT-4o
    let systemPrompt = '';
    
    if (language === 'en') {
      systemPrompt = `You are an expert AI consultant specializing in creating natural, human-like customer service system prompts. Your task is to create a detailed system prompt that will guide an AI to act as a virtual customer service representative${attendantName ? ` named ${attendantName}` : ''} for ${businessName || 'a company'}, simulating human-like interactions and responses.`;
    } else if (language === 'es') {
      systemPrompt = `Eres un consultor experto en IA especializado en crear prompts de sistema de atención al cliente naturales y humanos. Tu tarea es crear un prompt de sistema detallado que guiará a una IA para actuar como un representante virtual de atención al cliente${attendantName ? ` llamado ${attendantName}` : ''} para ${businessName || 'una empresa'}, simulando interacciones y respuestas humanas.`;
    } else {
      systemPrompt = `Você é um consultor especialista em IA, especializado em criar prompts de sistema para atendimento ao cliente que pareçam naturais e humanizados. Sua tarefa é criar um prompt de sistema detalhado que guiará uma IA para atuar como um atendente virtual${attendantName ? ` chamado ${attendantName}` : ''} para ${businessName || 'uma empresa'}, simulando interações e respostas humanas.`;
    }

    // Construir a mensagem do usuário com detalhes do negócio
    let userPrompt = '';
    
    if (language === 'en') {
      userPrompt = `Create a comprehensive system prompt for an AI that will function as a virtual customer service representative${attendantName ? ` named ${attendantName}` : ''} for ${businessName || 'our company'}.
      
Business Details:
- Description: ${businessDescription}
- Service Area: ${industry || 'General services'}
- Customer Profile: ${targetAudience || 'General customers'}
- Preferred tone: ${selectedTone}
${specificNeeds ? `- Additional Information: ${specificNeeds}` : ''}

The prompt should include:
1. A clear introduction of who the virtual attendant is (${attendantName ? `using the name ${attendantName}` : 'including a fictional name'} and personality traits)
2. Detailed knowledge about products/services with natural language explanations
3. Guidelines for handling common customer scenarios:
   - Greeting customers in a friendly, human-like manner
   - Answering product/service questions
   - Handling complaints and difficult customers
   - Providing support for common issues
   - Transferring to human agents when necessary
4. Conversation flow instructions that mimic human conversation patterns:
   - Using small talk appropriately
   - Asking clarifying questions
   - Using empathetic responses
   - Including appropriate pauses in responses
5. Tone and personality guidance matching the company brand (${selectedTone})
6. Limitations and boundaries (what the virtual attendant should not do)
7. Strategy for handling unexpected or out-of-scope questions
8. IMPORTANT: Instructions to always respond with short paragraphs (2-3 sentences maximum per paragraph), as each paragraph will be sent as a separate message to the customer

Make the prompt read as instructions for a human customer service representative rather than an AI. The resulting virtual attendant should feel like a real person handling customer inquiries rather than an obvious AI system.

Create a complete system prompt that can be directly used with an AI model. Do not include placeholders or sections to be filled in later. Provide a fully usable system prompt.`;
    } else if (language === 'es') {
      userPrompt = `Crea un prompt de sistema completo para una IA que funcionará como un representante virtual de atención al cliente${attendantName ? ` llamado ${attendantName}` : ''} para ${businessName || 'nuestra empresa'}.
      
Detalles del Negocio:
- Descripción: ${businessDescription}
- Área de Servicio: ${industry || 'Servicios en general'}
- Perfil de Clientes: ${targetAudience || 'Clientes en general'}
- Tono preferido: ${selectedTone}
${specificNeeds ? `- Información adicional: ${specificNeeds}` : ''}

El prompt debe incluir:
1. Una clara introducción de quién es el asistente virtual (${attendantName ? `usando el nombre ${attendantName}` : 'incluyendo un nombre ficticio'} y rasgos de personalidad)
2. Conocimiento detallado sobre productos/servicios con explicaciones en lenguaje natural
3. Directrices para manejar escenarios comunes de clientes:
   - Saludar a los clientes de manera amistosa y humana
   - Responder preguntas sobre productos/servicios
   - Manejar quejas y clientes difíciles
   - Proporcionar soporte para problemas comunes
   - Transferir a agentes humanos cuando sea necesario
4. Instrucciones de flujo de conversación que imiten patrones de conversación humana:
   - Usar charla informal apropiadamente
   - Hacer preguntas aclaratorias
   - Usar respuestas empáticas
   - Incluir pausas apropiadas en las respuestas
5. Guía de tono y personalidad que coincida con la marca de la empresa (${selectedTone})
6. Limitaciones y fronteras (lo que el asistente virtual no debe hacer)
7. Estrategia para manejar preguntas inesperadas o fuera de alcance
8. IMPORTANTE: Instrucciones para responder siempre con párrafos cortos (máximo 2-3 frases por párrafo), ya que cada párrafo se enviará como un mensaje separado al cliente

Haz que el prompt se lea como instrucciones para un representante humano de atención al cliente en lugar de una IA. El asistente virtual resultante debe sentirse como una persona real manejando consultas de clientes en lugar de un sistema de IA obvio.

Crea un prompt de sistema completo que pueda usarse directamente con un modelo de IA. Não inclua espaços reservados ou seções a serem preenchidas posteriormente. Forneça um prompt de sistema totalmente utilizável.`;
    } else {
      userPrompt = `Crie um prompt de sistema completo para uma IA que funcionará como um atendente virtual${attendantName ? ` chamado ${attendantName}` : ''} para ${businessName || 'nossa empresa'}.
      
Detalhes do Negócio:
- Descrição: ${businessDescription}
- Área de Atendimento: ${industry || 'Serviços em geral'}
- Perfil dos Clientes: ${targetAudience || 'Clientes em geral'}
- Tom preferido: ${selectedTone}
${specificNeeds ? `- Informações Adicionais: ${specificNeeds}` : ''}

O prompt deve incluir:
1. Uma clara introdução de quem é o atendente virtual (${attendantName ? `usando o nome ${attendantName}` : 'incluindo um nome fictício'} e traços de personalidade)
2. Conhecimento detalhado sobre produtos/serviços com explicações em linguagem natural
3. Diretrizes para lidar com cenários comuns de atendimento:
   - Saudação aos clientes de maneira amigável e humana
   - Responder perguntas sobre produtos/serviços
   - Lidar com reclamações e clientes difíceis
   - Fornecer suporte para problemas comuns
   - Transferir para atendentes humanos quando necessário
4. Instruções de fluxo de conversa que imitam padrões de conversação humana:
   - Usar conversa casual apropriadamente
   - Fazer perguntas esclarecedoras
   - Usar respostas empáticas
   - Incluir pausas apropriadas nas respostas
5. Orientação de tom e personalidade compatível com a marca da empresa (${selectedTone})
6. Limitações e fronteiras (o que o atendente virtual não deve fazer)
7. Estratégia para lidar com perguntas inesperadas ou fora do escopo
8. IMPORTANTE: Instruções para sempre responder com parágrafos curtos (máximo de 2-3 frases por parágrafo), pois cada parágrafo será enviado como uma mensagem separada para o cliente

Faça com que o prompt pareça instruções para um atendente humano em vez de uma IA. O atendente virtual resultante deve se sentir como uma pessoa real lidando com consultas de clientes em vez de um sistema de IA óbvio.

Crie um prompt de sistema completo que possa ser usado diretamente com um modelo de IA. Não inclua espaços reservados ou seções a serem preenchidas posteriormente. Forneça um prompt de sistema totalmente utilizável.`;
    }

    // Preparar requisição para a API da OpenAI
    try {
      const apiRequestBody = {
        model: "gpt-4.1",
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7
      };

      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        apiRequestBody,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      // Extrair o texto da resposta
      const generatedPrompt = response.data.choices[0].message.content;

      return res.json({
        success: true,
        data: {
          text: generatedPrompt,
          usage: response.data.usage
        }
      });
    } catch (error) {
      console.error('Erro ao chamar API da OpenAI:', error.response?.data || error);
      
      const errorMessage = language === 'en' ? 'Error generating prompt with OpenAI API' :
                           language === 'es' ? 'Error al generar el prompt con la API de OpenAI' :
                           'Erro ao gerar o prompt com a API da OpenAI';
      
      return res.status(error.response?.status || 500).json({
        success: false,
        error: error.response?.data?.error?.message || errorMessage
      });
    }
  } catch (error) {
    console.error('Erro ao gerar prompt:', error);
    Sentry.captureException(error);
    
    const errorMessage = req.body.language === 'en' ? 'Error generating prompt' :
                         req.body.language === 'es' ? 'Error al generar el prompt' :
                         'Erro ao gerar prompt';
    
    return res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
};

/**
 * Gera sugestão de resposta para uma pergunta sem contexto usando OpenAI
 * POST /api/:organizationId/prompts/:id/generate-response-unknown
 */
export const generateResponseUnknownWithOpenAI = async (req, res) => {
  try {
    const { organizationId, id: promptId } = req.params;
    const {
      question, 
      content, 
      notes,
      promptContext,
      language = 'pt'
    } = req.body;

    // Validar campos obrigatórios
    if (!question) {
      return res.status(400).json({
        success: false,
        error: language === 'en' ? 'Question is required' :
               language === 'es' ? 'La pregunta es obligatoria' :
               'A pergunta é obrigatória'
      });
    }

    // Usar a chave API diretamente do ambiente
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        error: language === 'en' ? 'OpenAI API key not configured' :
               language === 'es' ? 'Clave de API de OpenAI no configurada' :
               'Chave de API da OpenAI não configurada'
      });
    }
    
    // Buscar o contexto do prompt se não foi fornecido
    let contextText = promptContext;
    
    if (!contextText) {
      const { data: promptData, error: promptError } = await supabase
        .from('prompts')
        .select('content')
        .eq('id', promptId)
        .single();

      if (promptError) {
        throw promptError;
      }
      
      if (!promptData) {
        return res.status(404).json({
          success: false,
          error: language === 'en' ? 'AI Agent not found' :
                 language === 'es' ? 'Agente IA no encontrado' :
                 'Agente IA não encontrado'
        });
      }
      
      contextText = promptData.content;
    }
    
    // Definir instruções com base no idioma
    let instructions = '';
    
    if (language === 'en') {
      instructions = `
You are an expert AI consultant specialized in creating responses for virtual assistants.
A question was asked that doesn't have an answer in the current virtual assistant's context.
Your task is to suggest an excellent response to this question that can be added to the assistant's context.

The current virtual assistant context is:
---
${contextText}
---

The question without an answer in the context is: "${question}"
${content ? `\nThe current (incomplete or inadequate) response is: "${content}"` : ''}
${notes ? `\nNotes about the question: "${notes}"` : ''}

Create a clear, concise and useful response that:
1. Directly answers the question
2. Is consistent with the tone and style of the existing context
3. Can be added to the virtual assistant's context
4. Addresses different variations or perspectives of the question
5. Is well-formatted and structured

IMPORTANT: Format your response with a bold question title followed by the answer.
For example: "**What are your business hours?** Our operating hours are Monday to Friday from 9 AM to 6 PM."

Make it clear that this is an instruction for the prompt, not a direct response to a user. Format the response
so it can be easily added to the context document.

Do not include explanations about your reasoning process - just provide the actual response that should be added to the
virtual assistant's context.`;
    } else if (language === 'es') {
      instructions = `
Eres un consultor experto en IA especializado en crear respuestas para asistentes virtuales.
Se hizo una pregunta que no tiene respuesta en el contexto actual del asistente virtual.
Tu tarea es sugerir una excelente respuesta a esta pregunta que pueda agregarse al contexto del asistente.

El contexto actual del asistente virtual es:
---
${contextText}
---

La pregunta sin respuesta en el contexto es: "${question}"
${content ? `\nLa respuesta actual (incompleta o inadecuada) es: "${content}"` : ''}
${notes ? `\nNotas sobre la pregunta: "${notes}"` : ''}

Crea una respuesta clara, concisa y útil que:
1. Responda directamente a la pregunta
2. Sea consistente con el tono y estilo del contexto existente
3. Pueda agregarse al contexto del asistente virtual
4. Aborde diferentes variaciones o perspectivas de la pregunta
5. Esté bien formateada y estructurada

IMPORTANTE: Formatea tu respuesta con un título en negrita de la pregunta seguido de la respuesta.
Por ejemplo: "**¿Cuál es su horario comercial?** Nuestro horario de atención es de lunes a viernes de 9 AM a 6 PM."

Deja claro que esto es una instrucción para el prompt, no una respuesta directa a un usuario. Formatea la respuesta
para que pueda agregarse fácilmente al documento de contexto.

No incluyas explicaciones sobre tu proceso de razonamiento - solo proporciona la respuesta real que debería agregarse al
contexto del asistente virtual.`;
    } else {
      instructions = `
Você é um consultor especialista em IA especializado em criar respostas para assistentes virtuais.
Uma pergunta foi feita que não tem resposta no contexto atual do assistente virtual.
Sua tarefa é sugerir uma excelente resposta para esta pergunta, que possa ser adicionada ao contexto do assistente.

O contexto atual do assistente virtual é:
---
${contextText}
---

A pergunta sem resposta no contexto é: "${question}"
${content ? `\nA resposta atual (incompleta ou inadequada) é: "${content}"` : ''}
${notes ? `\nNotas sobre a pergunta: "${notes}"` : ''}

Crie uma resposta clara, concisa e útil que:
1. Responda diretamente à pergunta
2. Seja consistente com o tom e estilo do contexto existente
3. Possa ser adicionada ao contexto do assistente virtual
4. Contemple diferentes variações ou perspectivas da pergunta
5. Seja bem formatada e estruturada

IMPORTANTE: Formate sua resposta com um título em negrito da pergunta seguido pela resposta.
Por exemplo: "**Qual é o horário de funcionamento?** Nosso horário de atendimento é de segunda a sexta, das 9h às 18h."

Deixe claro que isso é uma instrução para o prompt, não uma resposta direta a um usuário. Formate a resposta
de modo que possa ser facilmente adicionada ao documento de contexto.

Não inclua explicações sobre seu processo de raciocínio - apenas forneça a resposta real que deve ser adicionada ao
contexto do assistente virtual.`;
    }

    // Preparar requisição para a API da OpenAI
    try {
      const apiRequestBody = {
        model: "gpt-4o",
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: language === 'en' ? 
            `Please generate an optimal response for the question: "${question}" that can be added to the virtual assistant's context.` :
            language === 'es' ? 
            `Por favor, genera una respuesta óptima para la pregunta: "${question}" que pueda agregarse al contexto del asistente virtual.` :
            `Por favor, gere uma resposta ideal para a pergunta: "${question}" que possa ser adicionada ao contexto do assistente virtual.`
          }
        ],
        temperature: 0.7
      };

      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        apiRequestBody,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      // Extrair o texto da resposta
      const suggestedResponse = response.data.choices[0].message.content;

      return res.json({
        success: true,
        data: {
          suggestedResponse,
          usage: response.data.usage
        }
      });
    } catch (error) {
      console.error('Erro ao chamar API da OpenAI:', error.response?.data || error);
      
      const errorMessage = language === 'en' ? 'Error generating response suggestion with OpenAI API' :
                          language === 'es' ? 'Error al generar sugerencia de respuesta con la API de OpenAI' :
                          'Erro ao gerar sugestão de resposta com a API da OpenAI';
      
      return res.status(error.response?.status || 500).json({
        success: false,
        error: error.response?.data?.error?.message || errorMessage
      });
    }
  } catch (error) {
    console.error('Erro ao gerar sugestão de resposta:', error);
    Sentry.captureException(error);
    
    const errorMessage = req.body.language === 'en' ? 'Error generating response suggestion' :
                         req.body.language === 'es' ? 'Error al generar sugerencia de respuesta' :
                         'Erro ao gerar sugestão de resposta';
    
    return res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
}; 