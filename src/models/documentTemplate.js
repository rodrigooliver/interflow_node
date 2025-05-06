import { supabase } from '../lib/supabase.js';

/**
 * Busca um template de documento pelo ID
 * @param {string} id - ID do template
 * @param {string} organizationId - ID da organização
 * @returns {Promise<Object|null>} Template encontrado ou null
 */
export const getTemplateById = async (id, organizationId) => {
  try {
    const { data, error } = await supabase
      .from('emr_document_templates')
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error fetching template:', error);
    throw error;
  }
};

/**
 * Lista templates de documentos com filtros
 * @param {Object} filters - Filtros para busca
 * @param {string} filters.organization_id - ID da organização (obrigatório)
 * @param {string} [filters.document_type] - Tipo do documento
 * @param {boolean} [filters.is_active] - Status de ativo
 * @param {string} [filters.search_term] - Termo para busca em nome e descrição
 * @returns {Promise<Array>} Lista de templates
 */
export const listTemplates = async (filters = {}) => {
  try {
    if (!filters.organization_id) {
      throw new Error('organization_id é obrigatório');
    }

    let query = supabase
      .from('emr_document_templates')
      .select('*')
      .eq('organization_id', filters.organization_id)
      .is('deleted_at', null);

    // Aplica filtros
    if (filters.document_type) {
      query = query.eq('document_type', filters.document_type);
    }

    if (filters.is_active !== undefined) {
      query = query.eq('is_active', filters.is_active);
    }

    if (filters.search_term) {
      query = query.or(`name.ilike.%${filters.search_term}%,description.ilike.%${filters.search_term}%`);
    }

    const { data, error } = await query;

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error listing templates:', error);
    throw error;
  }
};

/**
 * Cria um novo template de documento
 * @param {Object} template - Dados do template
 * @param {string} template.organization_id - ID da organização
 * @param {string} template.name - Nome do template
 * @param {string} template.description - Descrição do template
 * @param {string} template.document_type - Tipo do documento
 * @param {string} template.content - Conteúdo do template
 * @param {string} [template.format=html] - Formato do documento
 * @param {boolean} [template.is_default=false] - Se é o template padrão
 * @param {boolean} [template.is_active=true] - Se está ativo
 * @param {Object} [template.variables_schema] - Schema das variáveis
 * @param {Object} [template.metadata] - Metadados adicionais
 * @returns {Promise<Object>} Template criado
 */
export const createTemplate = async (template) => {
  try {
    const { data, error } = await supabase
      .from('emr_document_templates')
      .insert([{
        ...template,
        format: template.format || 'html',
        is_default: template.is_default || false,
        is_active: template.is_active !== undefined ? template.is_active : true
      }])
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error creating template:', error);
    throw error;
  }
};

/**
 * Atualiza um template de documento
 * @param {string} id - ID do template
 * @param {string} organizationId - ID da organização
 * @param {Object} updates - Dados para atualizar
 * @returns {Promise<Object>} Template atualizado
 */
export const updateTemplate = async (id, organizationId, updates) => {
  try {
    const { data, error } = await supabase
      .from('emr_document_templates')
      .update(updates)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error updating template:', error);
    throw error;
  }
};

/**
 * Remove um template de documento (soft delete)
 * @param {string} id - ID do template
 * @param {string} organizationId - ID da organização
 * @returns {Promise<void>}
 */
export const deleteTemplate = async (id, organizationId) => {
  try {
    const { error } = await supabase
      .from('emr_document_templates')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) throw error;
  } catch (error) {
    console.error('Error deleting template:', error);
    throw error;
  }
}; 