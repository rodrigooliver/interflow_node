import { formatWhatsAppToMarkdown, formatMarkdownForWhatsApp } from '../../../utils/chat.js';
import Sentry from '../../../lib/sentry.js';
import { decrypt, encrypt } from '../../../utils/crypto.js';
import { supabase } from '../../../lib/supabase.js';
import { handleUpdateDeletedMessage } from '../../chat/message-handlers.js';
import { v4 as uuidv4 } from 'uuid';
import { registerUsageOrganizationByChannel } from '../../organizations/usage.js';

/**
 * Normaliza dados de mensagem do WAPI V2 para formato padrão
 * 
 * Esta função converte os dados brutos do webhook V2 do WAPI para um formato
 * padronizado que pode ser processado pelo sistema. Suporta a nova estrutura
 * de webhooks com chat, sender e msgContent.
 * 
 * @param {Object} webhookData - Dados brutos do webhook V2
 * @param {Object} channel - Dados do canal com credenciais (opcional para compatibilidade)
 * @returns {Object} - Mensagem normalizada
 */
export async function normalizeWapiMessageV2025_1(webhookData, channel = null) {
  // Determina o destinatário baseado em fromMe
  const recipient = webhookData.fromMe
    ? { id: webhookData.chat.id, profilePicture: webhookData.chat.profilePicture }
    : { id: webhookData.connectedPhone };

  // Determina a origem dos dados baseado em fromMe
  const externalData = webhookData.fromMe
    ? {
      externalId: webhookData.chat.id,
      externalName: webhookData.sender.pushName,
      externalProfilePicture: webhookData.sender.profilePicture
    }
    : {
      externalId: webhookData.sender.id,
      externalName: webhookData.sender.pushName,
      externalProfilePicture: webhookData.sender.profilePicture
    };

  // Verificar se é mensagem de resposta - estrutura pode ser diferente na V2
  let responseExternalId = null;

  // Função auxiliar para extrair contextInfo de diferentes tipos de mensagem
  const getContextInfo = (msgContent) => {
    // Verificar em diferentes localizações possíveis do contextInfo
    if (msgContent?.extendedTextMessage?.contextInfo) {
      return msgContent.extendedTextMessage.contextInfo;
    }
    if (msgContent?.conversation?.contextInfo) {
      return msgContent.conversation.contextInfo;
    }
    if (msgContent?.imageMessage?.contextInfo) {
      return msgContent.imageMessage.contextInfo;
    }
    if (msgContent?.videoMessage?.contextInfo) {
      return msgContent.videoMessage.contextInfo;
    }
    if (msgContent?.audioMessage?.contextInfo) {
      return msgContent.audioMessage.contextInfo;
    }
    if (msgContent?.documentMessage?.contextInfo) {
      return msgContent.documentMessage.contextInfo;
    }
    if (msgContent?.stickerMessage?.contextInfo) {
      return msgContent.stickerMessage.contextInfo;
    }
    // Localização antiga para compatibilidade
    if (msgContent?.contextInfo) {
      return msgContent.contextInfo;
    }
    return null;
  };

  const contextInfo = getContextInfo(webhookData.msgContent);
  if (contextInfo?.quotedMessage) {
    // O stanzaId é o ID da mensagem sendo respondida
    responseExternalId = contextInfo.stanzaId;
  }

  // Determinar o tipo de mensagem e conteúdo
  let messageType = 'text';
  let messageContent = '';
  let mediaBase64 = null;
  let mediaUrl = null;
  let mimeType = null;
  let fileName = null;

  // Processar conteúdo da mensagem baseado na estrutura V2
  if (webhookData.msgContent?.conversation) {
    messageType = 'text';
    messageContent = formatWhatsAppToMarkdown(webhookData.msgContent.conversation);
  } else if (webhookData.msgContent?.extendedTextMessage) {
    messageType = 'text';
    messageContent = formatWhatsAppToMarkdown(webhookData.msgContent.extendedTextMessage.text);
  } else if (webhookData.msgContent?.imageMessage) {
    messageType = 'image';
    messageContent = webhookData.msgContent.imageMessage.caption || '';
    mimeType = webhookData.msgContent.imageMessage.mimetype || 'image/jpeg';

    // Fazer download da mídia descriptografada se o canal estiver disponível
    if (channel && webhookData.msgContent.imageMessage.mediaKey && webhookData.msgContent.imageMessage.directPath) {
      mediaUrl = await downloadMediaFromWapi(channel, {
        mediaKey: webhookData.msgContent.imageMessage.mediaKey,
        directPath: webhookData.msgContent.imageMessage.directPath,
        type: 'image',
        mimetype: mimeType
      });
    }

    // Fallback para URL original se o download falhar
    if (!mediaUrl) {
      mediaUrl = webhookData.msgContent.imageMessage.url;
    }
  } else if (webhookData.msgContent?.videoMessage) {
    messageType = 'video';
    messageContent = webhookData.msgContent.videoMessage.caption || '';
    mimeType = webhookData.msgContent.videoMessage.mimetype || 'video/mp4';

    // Fazer download da mídia descriptografada se o canal estiver disponível
    if (channel && webhookData.msgContent.videoMessage.mediaKey && webhookData.msgContent.videoMessage.directPath) {
      mediaUrl = await downloadMediaFromWapi(channel, {
        mediaKey: webhookData.msgContent.videoMessage.mediaKey,
        directPath: webhookData.msgContent.videoMessage.directPath,
        type: 'video',
        mimetype: mimeType
      });
    }

    // Fallback para URL original se o download falhar
    if (!mediaUrl) {
      mediaUrl = webhookData.msgContent.videoMessage.url;
    }
  } else if (webhookData.msgContent?.audioMessage) {
    messageType = 'audio';
    messageContent = '';
    mimeType = webhookData.msgContent.audioMessage.mimetype || 'audio/ogg';

    // Fazer download da mídia descriptografada se o canal estiver disponível
    if (channel && webhookData.msgContent.audioMessage.mediaKey && webhookData.msgContent.audioMessage.directPath) {
      mediaUrl = await downloadMediaFromWapi(channel, {
        mediaKey: webhookData.msgContent.audioMessage.mediaKey,
        directPath: webhookData.msgContent.audioMessage.directPath,
        type: 'audio',
        mimetype: mimeType
      });
    }

    // Fallback para URL original se o download falhar
    if (!mediaUrl) {
      mediaUrl = webhookData.msgContent.audioMessage.url;
    }
  } else if (webhookData.msgContent?.documentMessage) {
    messageType = 'document';
    messageContent = webhookData.msgContent.documentMessage.caption || '';
    mimeType = webhookData.msgContent.documentMessage.mimetype || 'application/octet-stream';
    fileName = webhookData.msgContent.documentMessage.fileName;

    // Fazer download da mídia descriptografada se o canal estiver disponível
    if (channel && webhookData.msgContent.documentMessage.mediaKey && webhookData.msgContent.documentMessage.directPath) {
      mediaUrl = await downloadMediaFromWapi(channel, {
        mediaKey: webhookData.msgContent.documentMessage.mediaKey,
        directPath: webhookData.msgContent.documentMessage.directPath,
        type: 'document',
        mimetype: mimeType
      });
    }

    // Fallback para URL original se o download falhar
    if (!mediaUrl) {
      mediaUrl = webhookData.msgContent.documentMessage.url;
    }
  } else if (webhookData.msgContent?.stickerMessage) {
    messageType = 'sticker';
    messageContent = '';
    mimeType = webhookData.msgContent.stickerMessage.mimetype || 'image/webp';

    // Fazer download da mídia descriptografada se o canal estiver disponível
    if (channel && webhookData.msgContent.stickerMessage.mediaKey && webhookData.msgContent.stickerMessage.directPath) {
      mediaUrl = await downloadMediaFromWapi(channel, {
        mediaKey: webhookData.msgContent.stickerMessage.mediaKey,
        directPath: webhookData.msgContent.stickerMessage.directPath,
        type: 'image', // Stickers são tratados como imagem
        mimetype: mimeType
      });
    }

    // Fallback para URL original se o download falhar
    if (!mediaUrl) {
      mediaUrl = webhookData.msgContent.stickerMessage.url;
    }
  } else if (webhookData.msgContent?.listResponseMessage) {
    messageType = 'text';
    messageContent = webhookData.msgContent.listResponseMessage.title || '';
  } else if (webhookData.msgContent?.locationMessage) {
    messageType = 'location';
    messageContent = `📍 ${webhookData.msgContent.locationMessage.degreesLatitude}, ${webhookData.msgContent.locationMessage.degreesLongitude}`; //Salvar latitude e longitude
    
    // Extrair dados de localização
    const locationData = webhookData.msgContent.locationMessage;
    
    // Remover jpegThumbnail dos dados brutos para evitar duplicação
    const cleanedWebhookData = {
      ...webhookData,
      msgContent: {
        ...webhookData.msgContent,
        locationMessage: {
          ...locationData,
          jpegThumbnail: undefined // Remove para evitar duplicação
        }
      }
    };
    
    // Adicionar dados de localização diretamente nos campos da mensagem
    return {
      messageId: webhookData.messageId,
      timestamp: webhookData.moment,
      from: {
        id: webhookData.sender.id,
        name: webhookData.sender.pushName,
        profilePicture: webhookData.sender.profilePicture
      },
      to: recipient,
      ...externalData, // Adiciona os campos externos
      message: {
        type: messageType,
        content: messageContent,
        latitude: locationData.degreesLatitude,
        longitude: locationData.degreesLongitude,
        jpegThumbnail: locationData.jpegThumbnail || null,
        raw: cleanedWebhookData          // Dados brutos sem jpegThumbnail duplicado
      },
      isGroup: webhookData.isGroup,
      fromMe: webhookData.fromMe,
      responseExternalId: responseExternalId // Adiciona o ID da mensagem de referência quando for resposta
    };
  }

  return {
    messageId: webhookData.messageId,
    timestamp: webhookData.moment,
    from: {
      id: webhookData.sender.id,
      name: webhookData.sender.pushName,
      profilePicture: webhookData.sender.profilePicture
    },
    to: recipient,
    ...externalData, // Adiciona os campos externos
    message: {
      type: messageType,
      content: messageContent,
      mediaBase64: mediaBase64, // Campo padronizado para base64
      mediaUrl: mediaUrl,       // URL da mídia (pode ser criptografada)
      mimeType: mimeType,       // Tipo MIME da mídia
      fileName: fileName,       // Nome do arquivo (para documentos)
      raw: webhookData          // Dados brutos completos
    },
    isGroup: webhookData.isGroup,
    fromMe: webhookData.fromMe,
    responseExternalId: responseExternalId // Adiciona o ID da mensagem de referência quando for resposta
  };
}

/**
 * Normaliza dados de status do WAPI V2025.1 para formato padrão
 * 
 * @param {Object} webhookData - Dados brutos do webhook WAPI V2025.1
 * @returns {Object} - Dados normalizados para handleStatusUpdate
 */
export function normalizeWapiStatusUpdateV2025_1(webhookData) {

  // Mapear status específicos do WAPI V2025.1 para status padronizados
  const mapWapiV2StatusToStandard = (wapiStatus) => {
    const statusMap = {
      'DELIVERY': 'delivered',
      'READ': 'read',
      'SENT': 'sent',
      'FAILED': 'failed',
      'PENDING': 'pending',
      'ERROR': 'failed'
    };
    return statusMap[wapiStatus] || wapiStatus?.toLowerCase() || 'unknown';
  };

  return {
    messageId: webhookData.messageId,
    status: mapWapiV2StatusToStandard(webhookData.status),
    error: webhookData.error || webhookData.errorMessage || null,
    timestamp: webhookData.moment || Date.now(),
    metadata: {
      original: webhookData,
      source: 'wapi_v2025.1',
      instanceId: webhookData.instanceId,
      connectedPhone: webhookData.connectedPhone,
      fromMe: webhookData.fromMe,
      isGroup: webhookData.isGroup
    }
  };
}

/**
 * Função para enviar mensagem via WAPI v2025.1
 * @param {*} channel 
 * @param {*} messageData 
 * @returns 
 */
export async function handleSenderMessageWApiV2025_1(channel, messageData) {
  try {
    const credentials = channel.credentials;
    const apiToken = credentials.apiToken ? decrypt(credentials.apiToken) : null;
    const instanceId = credentials.instanceId || null;
    messageData.content = formatMarkdownForWhatsApp(messageData.content);

    if (!apiToken || !instanceId) {
      const error = new Error('Credenciais incompletas ou inválidas');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          messageData
        }
      });
      throw error;
    }

    const baseUrl = 'https://api.w-api.app/v1';
    let response;
    let responseData;

    // Se tiver anexos, envia como mídia
    if (messageData.attachments && messageData.attachments.length > 0) {
      const attachment = messageData.attachments[0];

      let endpoint = '';
      let body = {};

      // Determina o endpoint e corpo da requisição com base no tipo de mídia
      if (attachment.type.startsWith('image/') || (attachment.mime_type && attachment.mime_type.startsWith('image/')) || attachment.type == 'image') {
        endpoint = '/message/send-image';
        body = {
          phone: messageData.to,
          image: attachment.url,
          ...(messageData.content ? { caption: messageData.content } : {}),
          delayMessage: 2,
          ...(messageData.responseMessageId ? {
            messageId: messageData.responseMessageId
          } : {})
        };
      } else if (attachment.type.startsWith('video/') || (attachment.mime_type && attachment.mime_type.startsWith('video/')) || attachment.type == 'video') {
        endpoint = '/message/send-video';
        body = {
          phone: messageData.to,
          video: attachment.url,
          ...(messageData.content ? { caption: messageData.content } : {}),
          delayMessage: 2,
          ...(messageData.responseMessageId ? {
            messageId: messageData.responseMessageId
          } : {})
        };
      } else if (attachment.type.startsWith('audio/') || (attachment.mime_type && attachment.mime_type.startsWith('audio/')) || attachment.type == 'audio') {
        endpoint = '/message/send-audio';
        body = {
          phone: messageData.to,
          audio: attachment.url,
          delayMessage: 2,
          ...(messageData.responseMessageId ? {
            messageId: messageData.responseMessageId
          } : {})
        };
      } else if (attachment.type === 'sticker' || attachment.mime_type === 'image/webp') {
        endpoint = '/message/send-sticker';
        body = {
          phone: messageData.to,
          sticker: attachment.url,
          delayMessage: 2,
          ...(messageData.responseMessageId ? {
            messageId: messageData.responseMessageId
          } : {})
        };
      } else {
        endpoint = '/message/send-document';

        let extension = attachment.extension || null;
        let url = attachment.url;
        let fileName = attachment.name || 'file';

        // Tentar extrair o nome do arquivo da URL se não encontrado
        if (!attachment.name && attachment.url) {
          try {
            const urlObj = new URL(attachment.url);
            const pathSegments = urlObj.pathname.split('/');
            const queryParams = Object.keys(Object.fromEntries(urlObj.searchParams));

            const fileNamePattern = /\.[a-zA-Z0-9]{2,4}(?:$|\?|&)/;

            if (pathSegments.length > 0 && fileNamePattern.test(pathSegments[pathSegments.length - 1])) {
              fileName = pathSegments[pathSegments.length - 1];
              if (fileName.includes('.') && !extension) {
                extension = fileName.split('.').pop().toLowerCase();
              }
            } else if (queryParams.length > 0) {
              for (const param of queryParams) {
                if (fileNamePattern.test(param)) {
                  fileName = param;
                  if (fileName.includes('.') && !extension) {
                    extension = fileName.split('.').pop().toLowerCase();
                  }
                  break;
                }
              }
            }
          } catch (error) {
            console.log('Erro ao extrair nome do arquivo da URL:', error);
          }
        }

        // Se ainda não tiver extensão, tentar extrair de outras fontes
        if (!extension) {
          if (fileName.includes('.')) {
            extension = fileName.split('.').pop().toLowerCase();
          } else if (url.includes('.')) {
            extension = url.split('.').pop().toLowerCase();
          } else if (attachment.mime_type) {
            const mimeExtension = attachment.mime_type.split('/')[1];
            if (mimeExtension) {
              extension = mimeExtension;
            } else {
              extension = 'txt';
            }
          } else {
            extension = 'txt';
          }
        }

        // Verificar se o nome do arquivo tem extensão
        if (!fileName.includes('.')) {
          if (extension) {
            fileName = `${fileName}.${extension}`;
          }
        }

        body = {
          phone: messageData.to,
          document: attachment.url,
          extension: extension, // Campo obrigatório na nova API
          ...(fileName ? { fileName: fileName } : {}),
          ...(messageData.content ? { caption: messageData.content } : {}),
          delayMessage: 2,
          ...(messageData.responseMessageId ? {
            messageId: messageData.responseMessageId
          } : {})
        };
      }

      response = await fetch(`${baseUrl}${endpoint}?instanceId=${instanceId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiToken}`
        },
        body: JSON.stringify(body)
      });

    } else if (messageData.list) {
      // Enviar mensagem com listas - adaptado para nova API
      const endpoint = '/message/send-list';
      const body = {
        phone: messageData.to,
        title: messageData.list.title,
        description: messageData.list.description || '',
        buttonText: messageData.list.buttonText || 'Selecione uma opção',
        footerText: messageData.list.footerText || '',
        sections: messageData.list.sections.map(section => ({
          title: section.title,
          rows: section.rows.map(row => ({
            title: row.title,
            description: row.description,
            rowId: row.id || row.rowId // Usando rowId conforme a nova API
          }))
        })),
        delayMessage: 2
      };

      response = await fetch(`${baseUrl}${endpoint}?instanceId=${instanceId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiToken}`
        },
        body: JSON.stringify(body)
      });
    } else if (messageData.content && messageData.content != '[object Object]') {
      const body = {
        phone: messageData.to,
        message: messageData.content,
        delayMessage: 2,
        ...(messageData.responseMessageId ? {
          messageId: messageData.responseMessageId
        } : {})
      };

      response = await fetch(`${baseUrl}/message/send-text?instanceId=${instanceId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiToken}`
        },
        body: JSON.stringify(body)
      });
    } else {
      const error = new Error('Nenhum conteúdo ou anexo fornecido para envio');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          messageData
        }
      });
      throw error;
    }

    if (!response.ok) {
      const errorText = await response.text();
      try {
        const errorData = JSON.parse(errorText);

        // Verifica se é erro de instanceId inválida ou outros erros da nova API
        if (errorData.message && errorData.message.includes('invalid') || errorData.error) {
          const error = new Error(errorData.message || errorData.error || 'Erro na API WAPI v2025.1');
          Sentry.captureException(error, {
            extra: {
              channelId: channel.id,
              messageData,
              errorData
            }
          });
          throw error;
        }

        const error = new Error(errorData.message || 'Erro ao enviar mensagem');
        Sentry.captureException(error, {
          extra: {
            channelId: channel.id,
            messageData,
            errorData
          }
        });
        throw error;
      } catch (parseError) {
        const error = new Error(`Erro ao enviar mensagem: ${errorText}`);
        Sentry.captureException(error, {
          extra: {
            channelId: channel.id,
            messageData,
            errorText
          }
        });
        throw error;
      }
    }

    const responseText = await response.text();

    try {
      responseData = JSON.parse(responseText);
    } catch (parseError) {
      const error = new Error(`Erro ao parsear resposta da API: ${responseText}`);
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          messageData,
          responseText
        }
      });
      throw error;
    }

    if (responseData.error) {
      const error = new Error(responseData.message || 'Erro retornado pela API');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          messageData,
          responseData
        }
      });
      throw error;
    }

    return {
      messageId: responseData.messageId
    };
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id,
        messageData
      }
    });
    throw error;
  }
}

/**
 * Faz download de mídia descriptografada da API WAPI V2025.1
 * 
 * @param {Object} channel - Dados do canal com credenciais
 * @param {Object} mediaData - Dados da mídia (mediaKey, directPath, type, mimetype)
 * @returns {Promise<string|null>} - URL da mídia descriptografada ou null em caso de erro
 */
export async function downloadMediaFromWapi(channel, mediaData) {
  try {
    const credentials = channel.credentials;
    const apiToken = credentials.apiToken ? decrypt(credentials.apiToken) : null;
    const instanceId = credentials.instanceId || null;

    if (!apiToken || !instanceId) {
      console.error('Credenciais incompletas para download de mídia');
      return null;
    }

    const baseUrl = 'https://api.w-api.app/v1';

    const body = {
      mediaKey: mediaData.mediaKey,
      directPath: mediaData.directPath,
      type: mediaData.type,
      mimetype: mediaData.mimetype
    };

    const response = await fetch(`${baseUrl}/message/download-media?instanceId=${instanceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Erro ao fazer download de mídia WAPI:', errorText);
      Sentry.captureException(new Error(`Erro ao fazer download de mídia: ${errorText}`), {
        extra: {
          channelId: channel.id,
          mediaData,
          status: response.status
        }
      });
      return null;
    }

    const responseData = await response.json();

    if (responseData.error) {
      console.error('Erro retornado pela API no download de mídia:', responseData);
      Sentry.captureException(new Error(responseData.message || 'Erro no download de mídia'), {
        extra: {
          channelId: channel.id,
          mediaData,
          responseData
        }
      });
      return null;
    }

    return responseData.fileLink;
  } catch (error) {
    console.error('Erro ao fazer download de mídia:', error);
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id,
        mediaData
      }
    });
    return null;
  }
}

/**
 * Envia uma mensagem de atualização de mensagem na versão V2025.1
 * @param {*} channel 
 * @param {*} phoneNumber 
 * @param {*} messageId 
 * @param {*} content 
 * @returns 
 */
export async function handleSendUpdateMessageWapiChannelV2025_1(channel, phoneNumber, messageId, content) {
  try {
    const credentials = channel.credentials;
    const apiToken = credentials.apiToken ? decrypt(credentials.apiToken) : null;
    const instanceId = credentials.instanceId || null;

    const baseUrl = 'https://api.w-api.app/v1';

    const body = {
      phone: phoneNumber,
      messageId: messageId,
      text: content
    }

    // console.log(body);

    const response = await fetch(`${baseUrl}/message/edit-message?instanceId=${instanceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Erro ao atualizar mensagem WAPI:', errorText);
      Sentry.captureException(new Error(`Erro ao atualizar mensagem: ${errorText}`), {
        extra: {
          channelId: channel.id,
          messageId,
          content,
          status: response.status
        }
      });
      throw new Error(`Erro ao atualizar mensagem: ${errorText}`);
    }

    const responseData = await response.json();

    // console.log('handleUpdateMessageWapiChannelV2025_1: responseData', responseData);

    return {
      messageId: responseData.messageId,
      insertedId: responseData.insertedId,
    };

  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id,
        messageId,
        content
      }
    });
    throw error;
  }
}


/**
 * Deleta uma mensagem através do canal WApi v2025.1
 * @param {*} channel 
 * @param {*} messageData 
 * @returns 
 */
export async function handleDeleteMessageWapiChannelV2025_1(channel, messageData) {
  try {
    const credentials = channel.credentials;
    const apiToken = credentials.apiToken ? decrypt(credentials.apiToken) : null;
    const instanceId = credentials.instanceId || null;

    if (!apiToken || !instanceId) {
      const error = new Error('Credenciais incompletas ou inválidas');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          messageData
        }
      });
      throw error;
    }

    const baseUrl = 'https://api.w-api.app/v1';

    // Construir URL com query parameters
    const url = new URL(`${baseUrl}/message/delete-message`);
    url.searchParams.append('phone', messageData.to);
    url.searchParams.append('messageId', messageData.externalId);
    url.searchParams.append('instanceId', instanceId);

    const response = await fetch(url.toString(), {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      try {
        const errorData = JSON.parse(errorText);
        const error = new Error(errorData.message || errorData.error || 'Erro ao deletar mensagem');
        Sentry.captureException(error, {
          extra: {
            channelId: channel.id,
            messageData,
            errorData,
            status: response.status
          }
        });
        throw error;
      } catch (parseError) {
        const error = new Error(`Erro ao deletar mensagem: ${errorText}`);
        Sentry.captureException(error, {
          extra: {
            channelId: channel.id,
            messageData,
            errorText,
            status: response.status
          }
        });
        throw error;
      }
    }

    const responseText = await response.text();
    let responseData;

    try {
      responseData = JSON.parse(responseText);
    } catch (parseError) {
      // Se não conseguir parsear, assumir que foi sucesso se status foi OK
      return true;
    }

    if (responseData.error) {
      const error = new Error(responseData.message || 'Erro retornado pela API');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          messageData,
          responseData
        }
      });
      throw error;
    }


    if (responseData.insertedId) {
      // await handleUpdateDeletedMessage(channel, messageData.externalId);
    } else {
      return false;
    }

    return true;

  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id,
        messageData
      }
    });
    throw error;
  }
}

/**
 * Gera um QR code para o canal
 * @param {*} channel 
 * @returns 
 */
export async function generateQrCodeV2025_1(channel) {
  try {
    const credentials = channel.credentials;
    const apiToken = credentials.apiToken ? decrypt(credentials.apiToken) : null;
    const instanceId = credentials.instanceId || null;

    if (!apiToken || !instanceId) {
      const error = new Error('Credenciais incompletas ou inválidas');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id
        }
      });
      throw error;
    }

    const baseUrl = 'https://api.w-api.app/v1';

    // Primeiro, tentamos obter o QR code como JSON (sem image=enable)
    const response = await fetch(`${baseUrl}/instance/qr-code?instanceId=${instanceId}&syncContacts=disable`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`
      }
    });

    if (!response.ok) {
      let errorData;
      try {
        errorData = await response.json();
      } catch (e) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
      const error = new Error(errorData.message || 'Failed to generate QR code');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          errorData
        }
      });
      throw error;
    }

    // Verificar o Content-Type da resposta
    const contentType = response.headers.get('content-type');

    let responseData;

    if (contentType && contentType.includes('application/json')) {
      // Se for JSON, parsear normalmente
      responseData = await response.json();

      if (responseData.error) {
        const error = new Error(responseData.message || 'Failed to generate QR code');
        Sentry.captureException(error, {
          extra: {
            channelId: channel.id,
            responseData
          }
        });
        throw error;
      }
    } else if (contentType && contentType.includes('image/')) {
      // Se for uma imagem, converter para base64
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const dataUri = `data:${contentType};base64,${base64}`;
      responseData = { qrcode: dataUri };
    } else {
      // Tentar como texto primeiro, depois como JSON
      const responseText = await response.text();
      try {
        responseData = JSON.parse(responseText);
        if (responseData.error) {
          const error = new Error(responseData.message || 'Failed to generate QR code');
          Sentry.captureException(error, {
            extra: {
              channelId: channel.id,
              responseData
            }
          });
          throw error;
        }
      } catch (parseError) {
        console.error('Erro ao parsear resposta:', parseError);
        console.log('Resposta recebida:', responseText.substring(0, 100) + '...');
        throw new Error('Resposta da API não é um JSON válido nem uma imagem');
      }
    }

    //Atualizar qrcode no banco de dados
    const { data: updatedChannel, error: updateError } = await supabase
      .from('chat_channels')
      .update({
        credentials: {
          ...channel.credentials,
          qrCodeBase64: responseData.qrcode,
          qrExpiresAt: new Date(Date.now() + 40 * 1000).toISOString() //60 segundos
        }
      })
      .eq('id', channel.id);

    if (updateError) {
      const error = new Error(updateError.message || 'Failed to update channel');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id
        }
      });
      throw error;
    }

    return responseData.qrcode;

  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id
      }
    });
    console.error('Error generating QR code:', error);
    throw error;
  }
}

/**
 * Cria um novo canal de interconexão na W-API
 * @param {*} organizationId 
 * @param {*} name 
 * @returns 
 */
export async function createInterflowChannelV2025_1(organizationId, name, organizationName, channelIdUpdate = null, rejectCalls = false, rejectCallsMessage = '') {
  try {
    if (!process.env.WAPI_TOKEN_V2025_1) {
      return {
        success: false,
        error: 'WAPI_TOKEN_V2025_1 não definido'
      };
    }

    let channelId;
    // Gerar ID único para o canal
    if (channelIdUpdate) {
      channelId = channelIdUpdate;
    } else {
      channelId = uuidv4();
    }

    const baseUrl = 'https://api.w-api.app/v1';

    // Primeiro, criar a instância na API da WAPI
    const response = await fetch(`${baseUrl}/integrator/create-instance`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.WAPI_TOKEN_V2025_1}`
      },
      body: JSON.stringify({
        instanceName: `${organizationName}: ${name}`,
        rejectCalls: rejectCalls,
        callMessage: rejectCallsMessage || 'Não atendemos ligações. Por favor, envie uma mensagem de texto.',
        webhookConnectedUrl: `${process.env.API_URL}/api/${organizationId}/webhook/wapi/${channelId}?action=onConnected`,
        webhookDeliveryUrl: `${process.env.API_URL}/api/${organizationId}/webhook/wapi/${channelId}?action=onMessageDelivered`,
        webhookDisconnectedUrl: `${process.env.API_URL}/api/${organizationId}/webhook/wapi/${channelId}?action=onDisconnected`,
        webhookStatusUrl: `${process.env.API_URL}/api/${organizationId}/webhook/wapi/${channelId}?action=onStatus`,
        webhookPresenceUrl: '',
        webhookReceivedUrl: `${process.env.API_URL}/api/${organizationId}/webhook/wapi/${channelId}?action=onMessageReceived`
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.log('errorData', errorData);
      const error = new Error(errorData.message || 'Failed to create instance');
      Sentry.captureException(error, {
        extra: {
          organizationId,
          name,
          errorData
        }
      });
      throw error;
    }

    const responseData = await response.json();

    if (responseData.error) {
      const error = new Error(responseData.message || 'Failed to create instance');
      Sentry.captureException(error, {
        extra: {
          organizationId,
          name,
          responseData
        }
      });
      throw error;
    }

    let channel;

    if (channelIdUpdate) {
      //Ler dados do canal
      const { data: channelData, error: channelError } = await supabase
        .from('chat_channels')
        .select('*')
        .eq('id', channelIdUpdate)
        .single();

      if (channelError) {
        const dbError = new Error(channelError.message || 'Failed to read channel');
        Sentry.captureException(dbError, {
          extra: {
            organizationId,
            name,
            channelId,
            responseData
          }
        });
        throw dbError;
      }
      

      //Atualizar canal no banco de dados com ID pré-definido
      const { data: channelUpdated, error } = await supabase
        .from('chat_channels')
        .update({
          settings: {
            ...channelData.settings,
            version: '2025_1',
            interflowData: {
              ...channelData.settings.interflowData,
              createdAt: new Date().toISOString(),
              accountToken: encrypt(process.env.WAPI_TOKEN_V2025_1)
            }
          },
          status: 'inactive',
          is_connected: false,
          is_tested: true,
          credentials: {
            apiToken: encrypt(responseData.token),
            instanceId: responseData.instanceId
          }
        })
        .eq('id', channelIdUpdate)
        .select()
        .single();

      if (error) {
        const dbError = new Error(error.message || 'Failed to update channel');
        Sentry.captureException(dbError, {
          extra: {
            organizationId,
            name,
            channelId,
            responseData
          }
        });
        throw dbError;
      }

      channel = channelUpdated;
    } else {
      // Somente após sucesso na API, criar canal no banco de dados com ID pré-definido
      const { data: channelCreated, error } = await supabase
        .from('chat_channels')
        .insert({
          id: channelId,
          organization_id: organizationId,
          name: name,
          type: 'whatsapp_wapi',
          settings: {
            version: '2025_1',
            autoReply: true,
            notifyNewTickets: true,
            isInterflow: true,
            interflowData: {
              createdAt: new Date().toISOString(),
              isInterflowConnection: true,
              accountToken: encrypt(process.env.WAPI_TOKEN_V2025_1)
            }
          },
          status: 'inactive',
          is_connected: false,
          is_tested: true,
          credentials: {
            apiToken: encrypt(responseData.token),
            instanceId: responseData.instanceId
          }
        })
        .select()
        .single();

      if (error) {
        const dbError = new Error(error.message || 'Failed to create channel');
        Sentry.captureException(dbError, {
          extra: {
            organizationId,
            name,
            channelId,
            responseData
          }
        });
        throw dbError;
      }

      channel = channelCreated;

      registerUsageOrganizationByChannel(organizationId);
        
    }

    if (channel) {
      // Gerar QR code de forma assíncrona após 5 segundos, sem bloquear o retorno
      setTimeout(async () => {
        try {
          await generateQrCodeV2025_1(channel);
        } catch (error) {
          console.error('Erro ao gerar QR code de forma assíncrona:', error);
          Sentry.captureException(error, {
            extra: {
              organizationId,
              name,
              channelId: channel.id
            }
          });
        }
      }, 5000);
    }


    // Retornar imediatamente sem esperar o QR code
    return {
      success: true,
      id: channel.id
    };

  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        organizationId,
        name
      }
    });
    throw error;
  }
}

/**
 * Deleta uma conexão Interflow na W-API
 * @param {*} channel 
 * @returns 
 */
export async function deleteInterflowChannelV2025_1(channel) {
  try {
    const credentials = channel.credentials;
    const instanceId = credentials.instanceId || null;
    const accountToken = channel.settings?.interflowData?.accountToken ? decrypt(channel.settings?.interflowData?.accountToken) : process.env.WAPI_TOKEN_V2025_1;

    if (!instanceId) {
      console.warn('Instance ID não encontrado para o canal:', channel.id);
      return;
    }

    if (!accountToken) {
      const error = new Error('WAPI_TOKEN_V2025_1 não definido');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id
        }
      });
      throw error;
    }

    const baseUrl = 'https://api.w-api.app/v1';

    try {
      if (channel.is_connected) {
        await disconnectWapiInstanceV2025_1(channel);
      }

      // Deletar a instância usando a nova API v2025.1
      const response = await fetch(`${baseUrl}/integrator/delete-instance?instanceId=${instanceId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accountToken}`
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        try {
          const errorData = JSON.parse(errorText);
          const error = new Error(errorData.message || errorData.error || 'Falha ao deletar instância na W-API');
          Sentry.captureException(error, {
            extra: {
              channelId: channel.id,
              instanceId,
              errorData,
              status: response.status
            }
          });
          console.error('Falha ao deletar instância na W-API:', error);
        } catch (parseError) {
          const error = new Error(`Erro ao deletar instância: ${errorText}`);
          Sentry.captureException(error, {
            extra: {
              channelId: channel.id,
              instanceId,
              errorText,
              status: response.status
            }
          });
          console.error('Falha ao deletar instância na W-API:', error);
        }
      } else {
        const responseText = await response.text();
        let responseData;

        try {
          responseData = JSON.parse(responseText);

          if (responseData.error) {
            const error = new Error(responseData.message || 'Erro retornado pela W-API');
            Sentry.captureException(error, {
              extra: {
                channelId: channel.id,
                instanceId,
                responseData
              }
            });
            console.error('Erro retornado pela W-API:', error);
          } else {
            console.log('Instância deletada com sucesso na W-API');
          }
        } catch (parseError) {
          // Se não conseguir parsear, assumir que foi sucesso se status foi OK
          console.log('Instância deletada com sucesso na W-API');
        }
      }
    } catch (wapiError) {
      console.error('Erro ao deletar instância W-API:', wapiError);
      Sentry.captureException(wapiError, {
        extra: {
          channelId: channel.id,
          instanceId
        }
      });
      // Continua com a execução mesmo se falhar na API
    }

  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id
      }
    });
    throw error;
  }
}

export async function disconnectWapiInstanceV2025_1(channel) {
  try {
    const credentials = channel.credentials;
    const instanceId = credentials.instanceId || null;
    const apiToken = decrypt(credentials.apiToken) || null;

    if (!instanceId) {
      console.warn('Instance ID não encontrado para o canal:', channel.id);
      throw new Error('Instance ID não encontrado para o canal');
    }

    if (!apiToken) {
      console.warn('API Token não encontrado para o canal:', channel.id);
      throw new Error('API Token não encontrado para o canal');
    }

    const baseUrl = 'https://api.w-api.app/v1';

    const response = await fetch(`${baseUrl}/instance/disconnect?instanceId=${instanceId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`
      }
    });

    if (!response.ok) {
      const errorData = await response.json();
      
      // Verificar se o erro é sobre instância já desconectada
      if (errorData.message && errorData.message.includes('Instância não está online para realizar logout')) {
        console.log('Instância já estava desconectada, considerando como sucesso');
        return true;
      }
      
      const error = new Error(errorData.message || 'Failed to disconnect WApi instance');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          instanceId
        }
      });
      throw error;
    }

    const responseData = await response.json();

    if (responseData.error) {
      // Verificar se o erro é sobre instância já desconectada
      if (responseData.message && responseData.message.includes('Instância não está online para realizar logout')) {
        console.log('Instância já estava desconectada, considerando como sucesso');
        return true;
      }
      
      const error = new Error(responseData.message || 'Failed to disconnect WApi instance');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          instanceId
        }
      });
      throw error;
    }

    return true;

  } catch (error) {
    // Verificar se o erro é sobre instância já desconectada
    if (error.message && error.message.includes('Instância não está online para realizar logout')) {
      console.log('Instância já estava desconectada, considerando como sucesso');
      return true;
    }
    
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id
      }
    });
    throw error;
  }
}

export async function restartWapiInstanceV2025_1(channel) {
  try {
    const credentials = channel.credentials;
    const instanceId = credentials.instanceId || null;
    const apiToken = credentials.apiToken ? decrypt(credentials.apiToken) : null;

    if (!instanceId) {
      console.warn('Instance ID não encontrado para o canal:', channel.id);
      throw new Error('Instance ID não encontrado para o canal');
    }

    if (!apiToken) {
      console.warn('API Token não encontrado para o canal:', channel.id);
      throw new Error('API Token não encontrado para o canal');
    }

    const baseUrl = 'https://api.w-api.app/v1';

    const response = await fetch(`${baseUrl}/instance/restart?instanceId=${instanceId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      try {
        const errorData = JSON.parse(errorText);
        const error = new Error(errorData.message || errorData.error || 'Falha ao reiniciar instância na W-API');
        Sentry.captureException(error, {
          extra: {
            channelId: channel.id,
            instanceId,
            errorData,
            status: response.status
          }
        });
        throw error;
      } catch (parseError) {
        const error = new Error(`Erro ao reiniciar instância: ${errorText}`);
        Sentry.captureException(error, {
          extra: {
            channelId: channel.id,
            instanceId,
            errorText,
            status: response.status
          }
        });
        throw error;
      }
    }

    const responseText = await response.text();
    let responseData;

    try {
      responseData = JSON.parse(responseText);

      if (responseData.error) {
        const error = new Error(responseData.message || 'Erro retornado pela W-API');
        Sentry.captureException(error, {
          extra: {
            channelId: channel.id,
            instanceId,
            responseData
          }
        });
        throw error;
      }
    } catch (parseError) {
      // Se não conseguir parsear, assumir que foi sucesso se status foi OK
      console.log('Instância reiniciada com sucesso na W-API');
    }

    return true;

  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id
      }
    });
    throw error;
  }
}

export async function validateWhatsAppNumberV2025_1(channel, phoneNumber) {
  try {
    const credentials = channel.credentials;
    const instanceId = credentials.instanceId || null;
    const apiToken = credentials.apiToken ? decrypt(credentials.apiToken) : null;

    const baseUrl = 'https://api.w-api.app/v1';

    const body = {
      phones: [phoneNumber]
    };

    const response = await fetch(`${baseUrl}/contacts/phone-exists-batch?instanceId=${instanceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorData = await response.json();
      const error = new Error(errorData.message || 'Failed to validate WhatsApp number');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          instanceId,
          phoneNumber,
          errorData
        }
      });
      throw error;
    }

    const responseData = await response.json();

    return {
      isValid: responseData.results[0].exists || false,
      data: {
        outputPhone: responseData.results[0].outputPhone ?? null
      }
    };
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id
      }
    });
    throw error;
  }
}