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
    console.log(`[DocumentController] Iniciando processamento: template=${template_id}, format=${format}`);

    // 0. Busca o template para obter o nome
    const template = await getTemplateById(template_id, organizationId);
    if (!template) {
      console.error(`[DocumentController] Template não encontrado: ${template_id}`);
      return res.status(404).json({ error: 'Template not found' });
    }
    console.log(`[DocumentController] Template encontrado: ${template.name}`);

    // 1. Processa o template HTML com as variáveis
    console.log('[DocumentController] Processando template HTML...');
    const processedHtml = await processHtmlTemplate(template_id, variables, organizationId);
    console.log('[DocumentController] Template HTML processado com sucesso');
    console.log('[DocumentController] Tamanho do HTML processado:', processedHtml.length, 'caracteres');

    let fileBuffer;
    let contentType;
    let fileExtension;
    let fileName;

    // 2. Converte para o formato solicitado
    console.log(`[DocumentController] Iniciando conversão para ${format}...`);
    try {
      switch (format) {
        case 'docx':
          console.log('[DocumentController] Gerando DOCX...');
          fileBuffer = await generateDocx(processedHtml);
          contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          fileExtension = 'docx';
          console.log('[DocumentController] DOCX gerado. Tamanho do buffer:', fileBuffer?.length || 0, 'bytes');
          break;
        
        case 'html':
        case 'pdf': // Agora retornamos HTML também para PDF, já que será gerado no frontend
        default:
          console.log('[DocumentController] Retornando HTML...');
          fileBuffer = Buffer.from(processedHtml, 'utf-8');
          contentType = 'text/html';
          fileExtension = 'html';
          console.log('[DocumentController] Buffer HTML criado. Tamanho:', fileBuffer.length, 'bytes');
          break;
      }
      console.log(`[DocumentController] Conversão para ${format} concluída com sucesso`);
    } catch (conversionError) {
      console.error(`[DocumentController] Erro na conversão para ${format}:`, {
        error: conversionError,
        message: conversionError.message,
        stack: conversionError.stack
      });
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

    console.log(`[DocumentController] Enviando arquivo: ${fileName}`);
    console.log('[DocumentController] Content-Type:', contentType);
    console.log('[DocumentController] Tamanho do arquivo:', fileBuffer.length, 'bytes');

    // 4. Configura os headers para download
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', fileBuffer.length);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    // 5. Envia o arquivo
    console.log('[DocumentController] Enviando resposta...');
    return res.send(fileBuffer);

  } catch (error) {
    console.error('[DocumentController] Erro no processamento do documento:', {
      error,
      message: error.message,
      stack: error.stack
    });
    Sentry.captureException(error);
    return res.status(500).json({
      error: 'Error processing document',
      details: error.message
    });
  }
}; 