import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { supabase } from '../lib/supabase.js';
import { getActiveS3Integration } from '../lib/s3.js';

/**
 * Função unificada para upload de arquivos
 * 
 * Esta função gerencia o upload de arquivos para S3 (se integração estiver disponível)
 * ou para o storage do Supabase como fallback.
 * 
 * @param {Object} options - Opções de upload
 * @param {Buffer|ArrayBuffer|Blob} options.fileData - Dados do arquivo
 * @param {string} options.fileName - Nome original do arquivo
 * @param {string} options.contentType - Tipo MIME do arquivo
 * @param {number} options.fileSize - Tamanho do arquivo em bytes
 * @param {string} options.organizationId - ID da organização
 * @param {string} [options.messageId] - ID da mensagem associada (opcional)
 * @param {string} [options.customFolder] - Pasta personalizada para armazenamento
 * @param {boolean} [options.isBase64] - Se os dados do arquivo estão em formato base64
 * @returns {Promise<Object>} - Resultado do upload com informações do arquivo
 */
export async function uploadFile({
  fileData,
  fileName,
  contentType,
  fileSize,
  organizationId,
  messageId = null,
  flowId = null,
  customFolder = null,
  isBase64 = false
}) {
  try {
    // Gerar ID único para o arquivo
    const fileId = uuidv4();
    
    // Extrair extensão do arquivo
    const fileExtension = path.extname(fileName);
    const fileNameWithoutExt = path.basename(fileName, fileExtension);
    
    // Criar nome de arquivo seguro com ID único
    const safeFileName = `${fileId}${fileExtension}`;
    
    // Determinar o tipo de arquivo (image, video, audio, document)
    const fileType = contentType.split('/')[0]; // image, video, application, etc.
    
    // Processar dados do arquivo se estiver em base64
    let processedFileData = fileData;
    if (isBase64) {
      // Remover o prefixo data:image/jpeg;base64, se existir
      const base64Data = fileData.includes('base64,') 
        ? fileData.split('base64,')[1] 
        : fileData;
        
      processedFileData = Buffer.from(base64Data, 'base64');
    }
    
    // Verificar se existe integração ativa de S3
    const s3Integration = await getActiveS3Integration(organizationId);
    
    let fileUrl;
    let fileKey;
    let storageType;
    
    // Upload para S3 se integração estiver disponível
    if (s3Integration) {
      try {
        const s3Client = new S3Client({
          region: s3Integration.settings.region,
          credentials: {
            accessKeyId: s3Integration.settings.access_key,
            secretAccessKey: s3Integration.settings.secret_key
          }
        });
        
        const bucket = s3Integration.settings.bucket;
        
        // Determinar a pasta de destino
        const folder = customFolder || `organizations/${organizationId}/files`;
        const key = `${folder}/${safeFileName}`;
        
        const uploadParams = {
          Bucket: bucket,
          Key: key,
          Body: processedFileData,
          ContentType: contentType
        };
        
        await s3Client.send(new PutObjectCommand(uploadParams));
        
        // Construir URL do S3
        fileUrl = `https://${bucket}.s3.${s3Integration.settings.region}.amazonaws.com/${key}`;
        fileKey = key;
        storageType = 's3';
      } catch (s3Error) {
        console.error('Erro ao fazer upload para S3:', s3Error);
        // Se falhar o S3, tentamos salvar no Supabase como fallback
      }
    }
    
    // Se não temos S3 ou falhou, salvar no Supabase
    if (!fileUrl) {
      // Determinar a pasta de destino no Supabase
      const folder = customFolder || 'chat-attachments';
      const filePath = `${organizationId}/${folder}/${safeFileName}`;
      
      const { error: uploadError } = await supabase.storage
        .from('attachments')
        .upload(filePath, processedFileData, {
          contentType: contentType,
          cacheControl: '3600'
        });

      if (uploadError) {
        throw new Error(`Erro ao fazer upload para Supabase: ${uploadError.message}`);
      }

      // Obter URL pública
      const { data: urlData } = supabase.storage
        .from('attachments')
        .getPublicUrl(filePath);
        
      fileUrl = urlData.publicUrl;
      fileKey = filePath;
      storageType = 'supabase';
    }
    
    // Se não conseguimos fazer upload para nenhum serviço de armazenamento
    if (!fileUrl) {
      throw new Error('Não foi possível fazer upload do arquivo para nenhum serviço de armazenamento');
    }
    
    // Preparar objeto de anexo para mensagens
    const fileAttachment = {
      id: fileId,
      name: fileName,
      public_url: fileUrl,
      key: fileKey,
      type: fileType,
      mime_type: contentType,
      size: fileSize || (processedFileData ? processedFileData.length : 0),
      storage: storageType
    };
    
    // Preparar registro para a tabela files
    const fileRecord = {
      id: fileId,
      organization_id: organizationId,
      name: fileName,
      size: fileSize || (processedFileData ? processedFileData.length : 0),
      public_url: fileUrl,
      path: fileKey,
      integration_id: s3Integration ? s3Integration.id : null,
      mime_type: contentType,
      message_id: messageId,
      flow_id: flowId,
      created_at: new Date().toISOString()
    };
    
    // Inserir registro na tabela files se messageId for fornecido
    const { error: fileError } = await supabase
      .from('files')
      .insert(fileRecord);
    
    if (fileError) {
      console.error('Erro ao registrar arquivo no banco de dados:', fileError);
      // Não falhar a operação principal se o registro falhar
    }
    
    return {
      success: true,
      fileId,
      fileUrl,
      fileKey,
      fileName,
      contentType,
      fileSize: fileSize || (processedFileData ? processedFileData.length : 0),
      storageType,
      attachment: fileAttachment,
      fileRecord
    };
  } catch (error) {
    console.error('Erro no upload de arquivo:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Função unificada para exclusão de arquivos
 * 
 * Esta função gerencia a exclusão de arquivos do S3 ou do Supabase Storage,
 * bem como a remoção do registro correspondente na tabela files.
 * 
 * @param {Object} options - Opções de exclusão
 * @param {string} options.fileId - ID do arquivo a ser excluído
 * @param {string} options.organizationId - ID da organização
 * @param {string} [options.flowId] - ID do fluxo associado (opcional)
 * @param {string} [options.messageId] - ID da mensagem associada (opcional)
 * @returns {Promise<Object>} - Resultado da exclusão
 */
export async function deleteFile({
  fileId,
  organizationId,
  flowId = null,
  messageId = null
}) {
  try {
    if (!fileId) {
      throw new Error('É necessário fornecer o ID do arquivo para excluí-lo');
    }

    // Buscar o registro do arquivo no banco de dados
    let query = supabase
      .from('files')
      .select('*')
      .eq('id', fileId)
      .eq('organization_id', organizationId);
    
    // Adicionar filtros opcionais se fornecidos
    if (flowId) {
      query = query.eq('flow_id', flowId);
    }
    
    if (messageId) {
      query = query.eq('message_id', messageId);
    }
    
    const { data: fileData, error: fileError } = await query.single();

    if (fileError) {
      throw new Error(`Erro ao buscar arquivo: ${fileError.message}`);
    }

    if (!fileData) {
      return {
        success: false,
        error: `Arquivo com ID ${fileId} não encontrado`
      };
    }

    // Verificar se o arquivo está no S3 ou no Supabase Storage
    if (fileData.integration_id) {
      // Arquivo está no S3
      const s3Integration = await getActiveS3Integration(organizationId);
      
      if (!s3Integration) {
        throw new Error('Integração S3 não encontrada');
      }
      
      const s3Client = new S3Client({
        region: s3Integration.settings.region,
        credentials: {
          accessKeyId: s3Integration.settings.access_key,
          secretAccessKey: s3Integration.settings.secret_key
        }
      });
      
      // Excluir o arquivo do S3
      await s3Client.send(new DeleteObjectCommand({
        Bucket: s3Integration.settings.bucket,
        Key: fileData.path
      }));
    } else {
      // Arquivo está no Supabase Storage
      const { error: deleteError } = await supabase.storage
        .from('attachments')
        .remove([fileData.path]);
        
      if (deleteError) {
        throw new Error(`Erro ao excluir arquivo do storage: ${deleteError.message}`);
      }
    }
    
    // Excluir o registro do arquivo do banco de dados
    const { error: deleteRecordError } = await supabase
      .from('files')
      .delete()
      .eq('id', fileData.id);
      
    if (deleteRecordError) {
      throw new Error(`Erro ao excluir registro do arquivo: ${deleteRecordError.message}`);
    }
    
    return {
      success: true,
      message: 'Arquivo excluído com sucesso',
      fileId: fileData.id
    };
  } catch (error) {
    console.error('Erro ao excluir arquivo:', error);
    return {
      success: false,
      error: error.message || 'Erro ao excluir arquivo'
    };
  }
}

/**
 * Função para download de arquivo a partir de URL
 * 
 * @param {string} url - URL do arquivo para download
 * @param {Object} options - Opções adicionais
 * @param {Object} [options.headers] - Cabeçalhos HTTP para a requisição
 * @param {number} [options.timeout] - Timeout em milissegundos
 * @returns {Promise<Buffer>} - Buffer com os dados do arquivo
 */
export async function downloadFileFromUrl(url, options = {}) {
  try {
    const { headers = {}, timeout = 30000 } = options;
    
    // Adicionar User-Agent padrão se não fornecido
    const requestHeaders = {
      'User-Agent': 'Interflow-Media-Downloader/1.0',
      ...headers
    };
    
    const response = await fetch(url, {
      headers: requestHeaders,
      timeout
    });
    
    if (!response.ok) {
      throw new Error(`Falha ao baixar arquivo: ${response.status} ${response.statusText}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    console.error('Erro ao baixar arquivo:', error);
    throw error;
  }
} 