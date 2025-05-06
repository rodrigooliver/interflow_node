import htmlDocx from 'html-docx-js';

/**
 * Gera um arquivo DOCX a partir de um HTML
 * @param {string} html - Conteúdo HTML para converter em DOCX
 * @returns {Promise<Buffer>} Buffer do arquivo DOCX
 */
export const generateDocx = async (html) => {
  try {
    // Converte HTML para DOCX
    const docxBuffer = htmlDocx.asBlob(html);
    return Buffer.from(await docxBuffer.arrayBuffer());
  } catch (error) {
    console.error('Error generating DOCX:', error);
    throw error;
  }
}; 