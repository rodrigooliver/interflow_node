import Sentry from '../lib/sentry.js';
import { processHtmlTemplate } from '../services/templateProcessor.js';
import { generateDocx } from '../services/docxGenerator.js';
import { getTemplateById } from '../models/documentTemplate.js';

/**
 * Processa um template de documento e retorna o arquivo para download
 */
export const processDocument = async (req, res) => {
  const { organizationId } = req.params;
  const { template_id, variables, format = 'html' } = req.body;

  try {
    // 0. Busca o template para obter o nome
    const template = await getTemplateById(template_id, organizationId);
    if (!template) {
      console.error(`[DocumentController] Template não encontrado: ${template_id}`);
      return res.status(404).json({ error: 'Template not found' });
    }

    // 1. Processa o template HTML com as variáveis
    const processedHtml = await processHtmlTemplate(template_id, variables, organizationId);

    let fileBuffer;
    let contentType;
    let fileExtension;
    let fileName;

    // 2. Converte para o formato solicitado
    try {
      switch (format) {
        case 'docx':
          fileBuffer = await generateDocx(processedHtml);
          contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          fileExtension = 'docx';
          break;
        
        case 'html':
        case 'pdf': // Agora retornamos HTML também para PDF, já que será gerado no frontend
        default:
          fileBuffer = Buffer.from(processedHtml, 'utf-8');
          contentType = 'text/html';
          fileExtension = 'html';
          break;
      }
    } catch (conversionError) {
      Sentry.captureException(conversionError);
      return res.status(500).json({
        error: `Error converting document to ${format}`,
        details: conversionError.message
      });
    }

    // Verifica se o buffer foi gerado corretamente
    if (!fileBuffer || fileBuffer.length === 0) {
      console.error('[DocumentController] Buffer gerado está vazio');
      return res.status(500).json({
        error: 'Generated file is empty',
        details: 'The file conversion process did not produce any content'
      });
    }

    // 3. Define o nome do arquivo usando o nome do template
    const sanitizedTemplateName = template.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    fileName = `${sanitizedTemplateName}_${Date.now()}.${fileExtension}`;

    // 4. Configura os headers para download
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', fileBuffer.length);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    // 5. Envia o arquivo
    return res.send(fileBuffer);

  } catch (error) {
    Sentry.captureException(error);
    return res.status(500).json({
      error: 'Error processing document',
      details: error.message
    });
  }
}; 