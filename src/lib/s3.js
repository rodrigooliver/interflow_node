import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { supabase } from './supabase.js';

export async function getActiveS3Integration(organizationId) {
  // Buscar integração ativa de AWS S3 para a organização
  const { data, error } = await supabase
    .from('integrations')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('type', 'aws_s3')
    .eq('status', 'active')
    .single();

  if (error || !data) {
    return null;
  }

  return data;
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
    throw new Error('Integração S3 não encontrada');
  }

  // Configurar cliente S3 com credenciais da integração
  const { accessKeyId, secretAccessKey, region, bucket } = s3Integration.credentials;
  
  const s3Client = new S3Client({
    region: region || 'us-east-1',
    credentials: {
      accessKeyId,
      secretAccessKey
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
    console.error('Erro no upload para S3:', error);
    throw error;
  }
}

export async function deleteFromS3(key, organizationId) {
  const s3Integration = await getActiveS3Integration(organizationId);
  
  if (!s3Integration) {
    throw new Error('Integração S3 não encontrada');
  }

  const { accessKeyId, secretAccessKey, region, bucket } = s3Integration.credentials;
  
  const s3Client = new S3Client({
    region: region || 'us-east-1',
    credentials: {
      accessKeyId,
      secretAccessKey
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
    console.error('Erro ao deletar arquivo do S3:', error);
    throw error;
  }
} 