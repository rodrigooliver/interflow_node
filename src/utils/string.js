/**
 * Gera um slug a partir de uma string
 * @param {string} text Texto para gerar o slug
 * @returns {string} Slug gerado
 */
export function generateSlug(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
} 