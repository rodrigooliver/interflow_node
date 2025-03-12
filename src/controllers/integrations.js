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