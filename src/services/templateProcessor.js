import Handlebars from 'handlebars';
import { getTemplateById } from '../models/documentTemplate.js';

/**
 * Processa um template HTML substituindo as variáveis usando Handlebars
 * @param {string} templateId - ID do template no banco de dados
 * @param {Object} variables - Objeto com as variáveis para substituição
 * @param {string} organizationId - ID da organização
 * @returns {Promise<string>} HTML processado
 */
export const processHtmlTemplate = async (templateId, variables, organizationId) => {
  try {
    // 1. Busca o template no banco de dados
    console.log('templateId', templateId);
    const template = await getTemplateById(templateId, organizationId);
    if (!template) {
      throw new Error('Template not found');
    }

    // 2. Compila o template usando Handlebars
    const compiledTemplate = Handlebars.compile(template.content);

    // 3. Registra helpers úteis
    Handlebars.registerHelper('formatDate', function(date) {
      if (!date) return '';
      return new Date(date).toLocaleDateString();
    });

    Handlebars.registerHelper('formatDateTime', function(date) {
      if (!date) return '';
      return new Date(date).toLocaleString();
    });

    Handlebars.registerHelper('formatCurrency', function(value) {
      if (!value) return '';
      return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL'
      }).format(value);
    });

    Handlebars.registerHelper('ifEquals', function(arg1, arg2, options) {
      return (arg1 == arg2) ? options.fn(this) : options.inverse(this);
    });

    Handlebars.registerHelper('ifNotEquals', function(arg1, arg2, options) {
      return (arg1 != arg2) ? options.fn(this) : options.inverse(this);
    });

    // 4. Processa o template com as variáveis
    const processedHtml = compiledTemplate(variables);

    return processedHtml;
  } catch (error) {
    console.error('Error processing template:', error);
    throw error;
  }
}; 