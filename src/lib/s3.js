import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { supabase } from './supabase.js';
import { decrypt } from '../utils/crypto.js';
import Sentry from './sentry.js';

export async function getActiveS3Integration(organizationId) {
  try {
    // Buscar integração ativa de AWS S3 para a organização
    const { data, error } = await supabase
      .from('integrations')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('type', 'aws_s3')
      .eq('status', 'active')
      .single();

    if (error) {
      Sentry.captureException(error, {
        tags: {
          organizationId,
          type: 's3_integration_fetch'
        }
      });
      return null;
    }

    if (!data) {
      Sentry.captureMessage('Nenhuma integração S3 ativa encontrada', {
        level: 'warning',
        tags: {
          organizationId,
          type: 's3_integration_not_found'
        }
      });
      return null;
    }

    return data;
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        organizationId,
        type: 's3_integration_error'
      }
    });
    return null;
  }
}

export async function uploadToS3({ 
  file, 
  fileName, 
  contentType, 
  folder,
  organizationId
}) {
  // Obter integração (assumindo que já foi verificada no controller)
  const s3Integration = await getActiveS3Integration(organizationId);
  
  if (!s3Integration) {
    const error = new Error('Integração S3 não encontrada');
    Sentry.captureException(error, {
      tags: {
        organizationId,
        type: 's3_upload_no_integration'
      }
    });
    throw error;
  }

  // Configurar cliente S3 com credenciais da integração
  const { access_key_id, secret_access_key, region, bucket } = s3Integration.credentials;
  
  // Descriptografar a chave secreta antes de usar
  const decryptedSecretKey = decrypt(secret_access_key);
  
  if (!decryptedSecretKey) {
    const error = new Error('Erro ao descriptografar a chave secreta do S3');
    Sentry.captureException(error, {
      tags: {
        organizationId,
        type: 's3_decrypt_error'
      }
    });
    throw error;
  }
  
  const s3Client = new S3Client({
    region: region || 'us-east-1',
    credentials: {
      accessKeyId: access_key_id,
      secretAccessKey: decryptedSecretKey
    }
  });

  const key = `${folder}/${fileName}`;
  const params = {
    Bucket: bucket,
    Key: key,
    Body: file,
    ContentType: contentType,
    ACL: 'public-read'
  };

  try {
    const command = new PutObjectCommand(params);
    await s3Client.send(command);
    
    // Construir URL manualmente já que o SDK v3 não retorna a URL diretamente
    const url = `https://${bucket}.s3.${region || 'us-east-1'}.amazonaws.com/${key}`;
    
    return {
      url,
      key
    };
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        organizationId,
        type: 's3_upload_error',
        bucket,
        key
      },
      extra: {
        fileName,
        contentType,
        folder
      }
    });
    throw error;
  }
}

export async function deleteFromS3(key, organizationId) {
  const s3Integration = await getActiveS3Integration(organizationId);
  
  if (!s3Integration) {
    const error = new Error('Integração S3 não encontrada');
    Sentry.captureException(error, {
      tags: {
        organizationId,
        type: 's3_delete_no_integration'
      }
    });
    throw error;
  }

  const { access_key_id, secret_access_key, region, bucket } = s3Integration.credentials;
  
  // Descriptografar a chave secreta antes de usar
  const decryptedSecretKey = decrypt(secret_access_key);
  
  if (!decryptedSecretKey) {
    const error = new Error('Erro ao descriptografar a chave secreta do S3');
    Sentry.captureException(error, {
      tags: {
        organizationId,
        type: 's3_decrypt_error'
      }
    });
    throw error;
  }
  
  const s3Client = new S3Client({
    region: region || 'us-east-1',
    credentials: {
      accessKeyId: access_key_id,
      secretAccessKey: decryptedSecretKey
    }
  });

  const params = {
    Bucket: bucket,
    Key: key
  };

  try {
    const command = new DeleteObjectCommand(params);
    await s3Client.send(command);
    return true;
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        organizationId,
        type: 's3_delete_error',
        bucket,
        key
      }
    });
    throw error;
  }
} 