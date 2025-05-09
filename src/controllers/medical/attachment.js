import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';
import { uploadFile as uploadFileUtil, deleteFile as deleteFileUtil } from '../../utils/file-upload.js';

/**
 * Controlador para criar ou atualizar anexos médicos com upload de arquivo
 * Esta função permite gerenciar anexos e seus arquivos em uma única operação
 */
export async function handleAttachment(req, res) {
  const { organizationId } = req.params;
  
  try {
    // Extrair dados do formulário
    const { 
      title, 
      attachment_type, 
      description, 
      is_highlighted,
      customer_id,
      medical_record_id,
      appointment_id,
      attachment_id,
      file_id
    } = req.body;
    
    // Verificar dados obrigatórios
    if (!title || !attachment_type || !customer_id) {
      return res.status(400).json({
        success: false,
        error: 'Dados obrigatórios não fornecidos: título, tipo de anexo e ID do paciente são necessários'
      });
    }
    
    // Variáveis para armazenar dados do arquivo
    let fileData = null;
    let newFileId = file_id;
    
    // 1. Se temos um novo arquivo no upload, vamos processá-lo primeiro
    if (req.files && req.files.file) {
      const file = req.files.file;
      
      // Fazer upload do arquivo
      const uploadResult = await uploadFileUtil({
        fileData: file.data,
        fileName: file.name,
        contentType: file.mimetype,
        fileSize: file.size,
        organizationId,
        customFolder: 'medical-files'
      });
      
      if (!uploadResult.success) {
        return res.status(500).json({
          success: false,
          error: uploadResult.error || 'Erro ao fazer upload do arquivo'
        });
      }
      
      // Usar os dados do arquivo já registrado pelo uploadFileUtil
      fileData = uploadResult.fileRecord;
      newFileId = uploadResult.fileId;
    }
    
    // 2. Se estamos substituindo um arquivo existente (temos novo arquivo e ID de arquivo antigo)
    if (newFileId !== file_id && file_id) {
      // Excluir o arquivo antigo
      try {
        await deleteFileUtil({
          fileId: file_id,
          organizationId
        });
        
        // A exclusão do registro na tabela files já é feita pelo deleteFileUtil
      } catch (error) {
        console.error('Erro ao excluir arquivo antigo:', error);
        // Continuamos o processo mesmo se a exclusão falhar
      }
    }
    
    // 3. Agora processamos o anexo (criar ou atualizar)
    if (attachment_id) {
      // Atualizar anexo existente
      const { data, error } = await supabase
        .from('emr_attachments')
        .update({
          title,
          attachment_type,
          description,
          is_highlighted: is_highlighted === 'true',
          file_id: newFileId,
          file_url: fileData?.public_url,
          file_name: fileData?.name || req.body.file_name,
          file_type: fileData?.mime_type || req.body.file_type,
          file_size: fileData?.size || req.body.file_size,
          updated_at: new Date().toISOString()
        })
        .eq('id', attachment_id)
        .eq('organization_id', organizationId)
        .select()
        .single();
      
      if (error) {
        Sentry.captureException(error);
        return res.status(500).json({
          success: false,
          error: 'Erro ao atualizar anexo médico'
        });
      }

      if(newFileId) {
        //Atualizar files com emr_attachment_id
        await supabase
          .from('files')
          .update({ emr_attachment_id: attachment_id })
          .eq('id', newFileId)
          .eq('organization_id', organizationId);
      }
      
      return res.status(200).json({
        success: true,
        data,
        message: 'Anexo atualizado com sucesso'
      });
    } else {
      // Criar novo anexo
      const { data, error } = await supabase
        .from('emr_attachments')
        .insert({
          title,
          attachment_type,
          description,
          is_highlighted: is_highlighted === 'true',
          customer_id,
          medical_record_id: medical_record_id || null,
          appointment_id: appointment_id || null,
          file_id: newFileId,
          file_url: fileData?.public_url,
          file_name: fileData?.name,
          file_type: fileData?.mime_type,
          file_size: fileData?.size,
          organization_id: organizationId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select()
        .single();
      
      if (error) {
        Sentry.captureException(error);
        return res.status(500).json({
          success: false,
          error: 'Erro ao criar anexo médico'
        });
      }
      
      return res.status(201).json({
        success: true,
        data,
        message: 'Anexo criado com sucesso'
      });
    }
  } catch (error) {
    Sentry.captureException(error);
    return res.status(500).json({
      success: false,
      error: 'Erro interno ao processar o anexo'
    });
  }
}

/**
 * Controlador para excluir anexos médicos
 * Esta função exclui o anexo e também o arquivo associado, se existir
 */
export async function deleteAttachment(req, res) {
  const { organizationId } = req.params;
  const { attachmentId } = req.body;
  
  if (!attachmentId) {
    return res.status(400).json({
      success: false,
      error: 'ID do anexo não fornecido'
    });
  }
  
  try {
    // 1. Primeiro, obtemos os dados do anexo para saber se há arquivo associado
    const { data: attachment, error: fetchError } = await supabase
      .from('emr_attachments')
      .select('file_id, file_url')
      .eq('id', attachmentId)
      .eq('organization_id', organizationId)
      .single();
    
    if (fetchError) {
      Sentry.captureException(fetchError);
      return res.status(404).json({
        success: false,
        error: 'Anexo não encontrado ou você não tem permissão para excluí-lo'
      });
    }
    
    // 2. Se houver um arquivo associado, excluímos ele primeiro
    if (attachment.file_id) {
      try {
        // deleteFileUtil já exclui o arquivo físico e o registro na tabela files
        await deleteFileUtil({
          fileId: attachment.file_id,
          organizationId
        });
      } catch (fileError) {
        // Registro do erro, mas continuamos com a exclusão do anexo
        console.error('Erro ao excluir o arquivo associado:', fileError);
        Sentry.captureException(fileError);
      }
    }
    
    // 3. Finalmente, excluímos o anexo
    // Opção 1: Exclusão definitiva
    const { error: deleteError } = await supabase
      .from('emr_attachments')
      .delete()
      .eq('id', attachmentId)
      .eq('organization_id', organizationId);
    
    // Opção 2: Soft delete (alternativa)
    // const { error: deleteError } = await supabase
    //   .from('emr_attachments')
    //   .update({ deleted_at: new Date().toISOString() })
    //   .eq('id', attachmentId)
    //   .eq('organization_id', organizationId);
    
    if (deleteError) {
      Sentry.captureException(deleteError);
      return res.status(500).json({
        success: false,
        error: 'Erro ao excluir o anexo'
      });
    }
    
    return res.status(200).json({
      success: true,
      message: 'Anexo excluído com sucesso'
    });
  } catch (error) {
    Sentry.captureException(error);
    return res.status(500).json({
      success: false,
      error: 'Erro interno ao processar a exclusão do anexo'
    });
  }
} 