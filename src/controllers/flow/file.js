import { uploadFile, deleteFile } from '../../utils/file-upload.js';
import { supabase } from '../../lib/supabase.js';

export async function createFileRoute(req, res) {
  const { flowId, organizationId } = req.params;
  
  // Verificar se há um arquivo na requisição
  if (!req.files || !req.files.file) {
    return res.status(400).json({
      success: false,
      error: 'Nenhum arquivo enviado'
    });
  }
  
  const file = req.files.file;

  const { data: flowData, error: flowError } = await supabase
      .from('flows')
      .select(`
        id,
        organization_id
      `)
      .eq('id', flowId)
      .eq('organization_id', organizationId)
      .single();

  if (flowError || !flowData) {
    return res.status(404).json({
      success: false,
      error: 'Flow not found or permission denied'
    });
  }

  const uploadResult = await uploadFile({
    fileData: file.data,
    fileName: file.name,
    contentType: file.mimetype,
    fileSize: file.size,
    organizationId,
    customFolder: 'flow-files',
    flowId: flowId
  });

  if(uploadResult.success) {
    return res.status(200).json(uploadResult);
  }

  return res.status(500).json({
    success: false,
    error: uploadResult.error
  });
}

/**
 * Função para excluir um arquivo associado a um fluxo
 */
export async function deleteFileRoute(req, res) {
  const { flowId, organizationId } = req.params;
  const { fileId } = req.body;

  if (!fileId) {
    return res.status(400).json({
      success: false,
      error: 'É necessário fornecer o ID do arquivo para excluí-lo'
    });
  }

  // Verificar se o fluxo existe e pertence à organização
  const { data: flowData, error: flowError } = await supabase
    .from('flows')
    .select(`
      id,
      organization_id
    `)
    .eq('id', flowId)
    .eq('organization_id', organizationId)
    .single();

  if (flowError || !flowData) {
    return res.status(404).json({
      success: false,
      error: 'Fluxo não encontrado ou permissão negada'
    });
  }

  // Usar a função centralizada para excluir o arquivo
  const deleteResult = await deleteFile({
    fileId,
    organizationId,
    flowId
  });

  if (deleteResult.success) {
    return res.status(200).json(deleteResult);
  }

  return res.status(500).json({
    success: false,
    error: deleteResult.error
  });
}
