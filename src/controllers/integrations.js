import { supabase } from '../lib/supabase.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import axios from 'axios';

/**
 * Busca uma integração específica
 * GET /api/:organizationId/integrations/:integrationId
 */
export const getIntegration = async (req, res) => {
  try {
    const { organizationId, id } = req.params;

    // Buscar a integração no Supabase
    const { data, error } = await supabase
      .from('integrations')
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
        error: 'Integração não encontrada'
      });
    }

    // Preparar os dados para retornar ao frontend
    const responseData = {
      ...data,
      credentials: { ...data.credentials }
    };

    // Mascarar as credenciais sensíveis
    if (responseData.credentials) {
      if (responseData.type === 'openai' && responseData.credentials.api_key) {
        // Não retornar a chave real, apenas indicar que existe
        responseData.credentials.api_key = '••••••••••••••••••••••';
        responseData.credentials.has_key = true;
      } else if (responseData.type === 'aws_s3' && responseData.credentials.secret_access_key) {
        // Não retornar a chave secreta real, apenas indicar que existe
        responseData.credentials.secret_access_key = '••••••••••••••••••••••';
        responseData.credentials.has_key = true;
      }
    }

    return res.json({
      success: true,
      data: responseData
    });
  } catch (error) {
    console.error('Erro ao buscar integração:', error);
    return res.status(500).json({
      success: false,
      error: 'Erro ao buscar integração'
    });
  }
};

/**
 * Cria uma nova integração
 * POST /api/:organizationId/integrations
 */
export const createIntegration = async (req, res) => {
  try {
    const { organizationId } = req.params;
    const { title, type, credentials, status = 'active' } = req.body;

    // Validar campos obrigatórios
    if (!title || !type || !credentials) {
      return res.status(400).json({
        success: false,
        error: 'Campos obrigatórios não informados'
      });
    }

    // Criptografar as credenciais
    const encryptedCredentials = { ...credentials };
    
    if (type === 'openai' && credentials.api_key) {
      // Criptografar a chave API da OpenAI
      encryptedCredentials.api_key = encrypt(credentials.api_key);
    } else if (type === 'aws_s3' && credentials.secret_access_key) {
      // Criptografar a chave secreta do AWS S3
      encryptedCredentials.secret_access_key = encrypt(credentials.secret_access_key);
    }

    // Inserir a integração no Supabase
    const { data, error } = await supabase
      .from('integrations')
      .insert([{
        organization_id: organizationId,
        title,
        type,
        credentials: encryptedCredentials,
        status
      }])
      .select()
      .single();

    if (error) {
      throw error;
    }

    return res.status(201).json({
      success: true,
      id: data.id,
      message: 'Integração criada com sucesso'
    });
  } catch (error) {
    console.error('Erro ao criar integração:', error);
    return res.status(500).json({
      success: false,
      error: 'Erro ao criar integração'
    });
  }
};

/**
 * Atualiza uma integração existente
 * PUT /api/:organizationId/integrations/:id
 */
export const updateIntegration = async (req, res) => {
  try {
    const { organizationId, id } = req.params;
    const { title, credentials, status } = req.body;

    // Buscar a integração atual para verificar o tipo
    const { data: existingIntegration, error: fetchError } = await supabase
      .from('integrations')
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .single();

    if (fetchError) {
      throw fetchError;
    }

    if (!existingIntegration) {
      return res.status(404).json({
        success: false,
        error: 'Integração não encontrada'
      });
    }

    // Preparar os dados para atualização
    const updateData = {};
    
    if (title) {
      updateData.title = title;
    }
    
    if (status) {
      updateData.status = status;
    }
    
    if (credentials) {
      // Criptografar as credenciais
      const encryptedCredentials = { ...credentials };
      
      if (existingIntegration.type === 'openai' && credentials.api_key) {
        // Criptografar a chave API da OpenAI
        encryptedCredentials.api_key = encrypt(credentials.api_key);
      } else if (existingIntegration.type === 'aws_s3' && credentials.secret_access_key) {
        // Criptografar a chave secreta do AWS S3
        encryptedCredentials.secret_access_key = encrypt(credentials.secret_access_key);
      }
      
      updateData.credentials = encryptedCredentials;
    }
    
    updateData.updated_at = new Date().toISOString();

    // Atualizar a integração no Supabase
    const { error: updateError } = await supabase
      .from('integrations')
      .update(updateData)
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (updateError) {
      throw updateError;
    }

    return res.json({
      success: true,
      message: 'Integração atualizada com sucesso'
    });
  } catch (error) {
    console.error('Erro ao atualizar integração:', error);
    return res.status(500).json({
      success: false,
      error: 'Erro ao atualizar integração'
    });
  }
};

/**
 * Valida uma chave API da OpenAI
 * POST /api/:organizationId/integrations/openai/validate
 */
export const validateOpenAIKey = async (req, res) => {
  try {
    const { api_key } = req.body;

    if (!api_key) {
      return res.status(400).json({
        success: false,
        error: 'Chave API não informada'
      });
    }

    // Validar a chave API da OpenAI
    try {
      const response = await axios.get('https://api.openai.com/v1/models', {
        headers: {
          'Authorization': `Bearer ${api_key}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.status === 200) {
        return res.json({
          success: true,
          message: 'Chave API válida'
        });
      } else {
        return res.status(400).json({
          success: false,
          error: 'Chave API inválida'
        });
      }
    } catch (error) {
      console.error('Erro ao validar chave OpenAI:', error);
      return res.status(400).json({
        success: false,
        error: 'Chave API inválida ou erro na validação'
      });
    }
  } catch (error) {
    console.error('Erro ao processar validação de chave OpenAI:', error);
    return res.status(500).json({
      success: false,
      error: 'Erro ao validar chave API'
    });
  }
};

/**
 * Testa um prompt usando a API da OpenAI
 * POST /api/:organizationId/integrations/:id/test-prompt
 */
export const testOpenAIPrompt = async (req, res) => {
  try {
    const { organizationId, id } = req.params;
    const { systemPrompt, messages, model = 'gpt-3.5-turbo', temperature = 0.7 } = req.body;

    // Validar campos obrigatórios
    if (!systemPrompt || !messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Prompt do sistema e histórico de mensagens são obrigatórios'
      });
    }

    // Validar temperatura
    const parsedTemperature = parseFloat(temperature);
    if (isNaN(parsedTemperature) || parsedTemperature < 0 || parsedTemperature > 2) {
      return res.status(400).json({
        success: false,
        error: 'Temperatura deve ser um número entre 0 e 2'
      });
    }

    // Buscar a integração no Supabase
    const { data: integration, error: fetchError } = await supabase
      .from('integrations')
      .select('*')
      .eq('id', id)
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
        error: 'Integração OpenAI não encontrada ou inativa'
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
        error: 'Erro ao processar credenciais da integração'
      });
    }

    // Preparar as mensagens para a API da OpenAI
    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages
    ];

    // Chamar a API da OpenAI
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model,
          messages: apiMessages,
          temperature: parsedTemperature,
          max_tokens: 1000
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      // Registrar o uso da API (opcional)
      // Aqui você pode adicionar código para registrar o uso da API, 
      // como contagem de tokens, custo, etc.

      return res.json({
        success: true,
        data: {
          message: response.data.choices[0].message,
          usage: response.data.usage
        }
      });
    } catch (error) {
      console.error('Erro ao chamar API da OpenAI:', error.response?.data || error);
      
      return res.status(error.response?.status || 500).json({
        success: false,
        error: error.response?.data?.error?.message || 'Erro ao processar o prompt com a API da OpenAI'
      });
    }
  } catch (error) {
    console.error('Erro ao testar prompt:', error);
    return res.status(500).json({
      success: false,
      error: 'Erro ao testar prompt'
    });
  }
};

/**
 * Busca os modelos disponíveis da OpenAI
 * GET /api/:organizationId/integrations/:id/openai-models
 */
export const getOpenAIModels = async (req, res) => {
  try {
    const { organizationId, id } = req.params;

    // Buscar a integração no Supabase
    const { data: integration, error: fetchError } = await supabase
      .from('integrations')
      .select('*')
      .eq('id', id)
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
        error: 'Integração OpenAI não encontrada ou inativa'
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
        error: 'Erro ao processar credenciais da integração'
      });
    }

    // Chamar a API da OpenAI para obter os modelos
    try {
      const response = await axios.get(
        'https://api.openai.com/v1/models',
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      // Filtrar apenas os modelos GPT
      const gptModels = response.data.data
        .filter(model => 
          model.id.includes('gpt-') && 
          !model.id.includes('instruct') && 
          !model.id.includes('vision')
        )
        .map(model => ({
          id: model.id,
          name: model.id
            .replace('gpt-3.5-turbo', 'GPT-3.5 Turbo')
            .replace('gpt-4', 'GPT-4')
            .replace('gpt-4-turbo', 'GPT-4 Turbo')
            .replace(/-\d{4}/, '')
        }))
        .sort((a, b) => {
          // Ordenar por versão (4 antes de 3.5)
          if (a.id.includes('gpt-4') && b.id.includes('gpt-3.5')) return -1;
          if (a.id.includes('gpt-3.5') && b.id.includes('gpt-4')) return 1;
          
          // Ordenar por turbo (turbo antes de não-turbo)
          if (a.id.includes('turbo') && !b.id.includes('turbo')) return -1;
          if (!a.id.includes('turbo') && b.id.includes('turbo')) return 1;
          
          return a.id.localeCompare(b.id);
        });

      return res.json({
        success: true,
        data: gptModels
      });
    } catch (error) {
      console.error('Erro ao buscar modelos da OpenAI:', error.response?.data || error);
      
      return res.status(error.response?.status || 500).json({
        success: false,
        error: error.response?.data?.error?.message || 'Erro ao buscar modelos da OpenAI'
      });
    }
  } catch (error) {
    console.error('Erro ao buscar modelos:', error);
    return res.status(500).json({
      success: false,
      error: 'Erro ao buscar modelos'
    });
  }
};
