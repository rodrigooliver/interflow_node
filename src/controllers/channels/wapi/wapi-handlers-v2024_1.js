import { formatWhatsAppToMarkdown } from '../../../utils/chat.js';
import Sentry from '../../../lib/sentry.js';
import { supabase } from '../../../lib/supabase.js';
import { decrypt, encrypt } from '../../../utils/crypto.js';
import { decryptCredentials } from '../wapi.js';
import { formatMarkdownForWhatsApp } from '../../../utils/chat.js';
import { registerUsageOrganizationByChannel } from '../../organizations/usage.js';

/**
 * Normaliza dados de mensagem do WAPI para formato padrão
 * 
 * Esta função converte os dados brutos do webhook do WAPI para um formato
 * padronizado que pode ser processado pelo sistema. Inclui suporte para
 * diferentes tipos de mídia (imagem, vídeo, áudio, documento, sticker)
 * e padroniza os dados base64 quando disponíveis.
 * 
 * @param {Object} webhookData - Dados brutos do webhook
 * @returns {Object} - Mensagem normalizada
 */
export function normalizeWapiMessageV2024_1(webhookData) {
  // Determina a origem dos dados baseado em fromMe
  const externalData = webhookData.fromMe
    ? {
      externalId: webhookData.recipient.id,
      externalName: webhookData.recipient.pushName,
      externalProfilePicture: webhookData.recipient.profilePicture
    }
    : {
      externalId: webhookData.sender.id,
      externalName: webhookData.sender.pushName,
      externalProfilePicture: webhookData.sender.profilePicture
    };

  // Verificar se é mensagem de resposta
  let responseExternalId = null;
  if (webhookData.referencedMessage && webhookData.referencedMessage.messageId) {
    responseExternalId = webhookData.referencedMessage.messageId;
  }

  // Determinar o tipo de mensagem
  let messageType = 'text';
  let messageContent = formatWhatsAppToMarkdown(webhookData.messageText?.text || '');
  let mediaBase64 = null;
  let mediaUrl = null;
  let mimeType = null;
  let fileName = null;

  // Processar diferentes tipos de mídia
  if (webhookData.image) {
    messageType = 'image';
    messageContent = webhookData.image.caption || '';
    mediaBase64 = webhookData.image.imageBase64;
    mediaUrl = webhookData.image.url;
    mimeType = webhookData.image.mimetype || 'image/jpeg';
  } else if (webhookData.video) {
    messageType = 'video';
    messageContent = webhookData.video.caption || '';
    mediaBase64 = webhookData.video.videoBase64;
    mediaUrl = webhookData.video.url;
    mimeType = webhookData.video.mimetype || 'video/mp4';
  } else if (webhookData.audio) {
    messageType = 'audio';
    messageContent = '';
    mediaBase64 = webhookData.audio.audioBase64;
    mediaUrl = webhookData.audio.url;
    mimeType = webhookData.audio.mimetype || 'audio/ogg';
  } else if (webhookData.document) {
    messageType = 'document';
    messageContent = webhookData.document.caption || '';
    mediaBase64 = webhookData.document.documentBase64;
    mediaUrl = webhookData.document.url;
    mimeType = webhookData.document.mimetype || 'application/octet-stream';
    fileName = webhookData.document.fileName;
  } else if (webhookData.sticker) {
    messageType = 'sticker';
    messageContent = '';
    mediaBase64 = webhookData.sticker.stickerBase64;
    mediaUrl = webhookData.sticker.url;
    mimeType = webhookData.sticker.mimetype || 'image/webp';
  } else if (webhookData.listResponseMessage) {
    messageType = 'text';
    // Prioriza o selectedRowId se existir, caso contrário usa o title
    // messageContent = webhookData.listResponseMessage.selectedRowId || webhookData.listResponseMessage.title || '';
    messageContent = webhookData.listResponseMessage.title || '';
  }

  return {
    messageId: webhookData.messageId,
    timestamp: webhookData.moment,
    from: {
      id: webhookData.sender.id,
      name: webhookData.sender.pushName,
      profilePicture: webhookData.sender.profilePicture
    },
    to: {
      id: webhookData.recipient.id,
      profilePicture: webhookData.recipient.profilePicture
    },
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
* Normaliza dados de status do WAPI para formato padrão
* 
* @param {Object} webhookData - Dados brutos do webhook WAPI
* @returns {Object} - Dados normalizados para handleStatusUpdate
*/
export function normalizeWapiStatusUpdateV2024_1(webhookData) {
  // Mapear status específicos do WAPI para status padronizados se necessário
  const mapWapiStatusToStandard = (wapiStatus) => {
    const statusMap = {
      'sent': 'sent',
      'delivered': 'delivered',
      'read': 'read',
      'failed': 'failed',
      'pending': 'pending',
      'error': 'failed'
    };
    return statusMap[wapiStatus] || wapiStatus || 'unknown';
  };

  return {
    messageId: webhookData.messageId || webhookData.id,
    status: mapWapiStatusToStandard(webhookData.status),
    error: webhookData.error || webhookData.errorMessage || null,
    timestamp: webhookData.timestamp || webhookData.moment || Date.now(),
    metadata: {
      original: webhookData,
      source: 'wapi'
    }
  };
}

/**
 * Função para enviar mensagem via WAPI v2024.1
 * @param {*} channel 
 * @param {*} messageData 
 * @returns 
 */
export async function handleSenderMessageWApiV2024_1(channel, messageData) {
  try {
    const credentials = channel.credentials;
    const apiHost = credentials.apiHost;
    const apiConnectionKey = credentials.apiConnectionKey ? decrypt(credentials.apiConnectionKey) : null;
    const apiToken = credentials.apiToken ? decrypt(credentials.apiToken) : null;
    messageData.content = formatMarkdownForWhatsApp(messageData.content);

    if (!apiHost || !apiConnectionKey || !apiToken) {
      const error = new Error('Credenciais incompletas ou inválidas');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          messageData
        }
      });
      throw error;
    }

    const baseUrl = `https://${apiHost}`;
    let response;
    let responseData;

    // console.log('WAPI - messageData', messageData);

    // Se tiver anexos, envia como mídia
    if (messageData.attachments && messageData.attachments.length > 0) {
      const attachment = messageData.attachments[0];
      // console.log('WAPI - attachment', attachment);

      let endpoint = '';
      let body = {};

      // Determina o endpoint e corpo da requisição com base no tipo de mídia
      if (attachment.type.startsWith('image/') || (attachment.mime_type && attachment.mime_type.startsWith('image/')) || attachment.type == 'image') {
        endpoint = '/message/send-image';
        body = {
          phoneNumber: messageData.to,
          image: attachment.url,
          caption: messageData.content || ''
        };
        // console.log('WAPI - attachment.url', attachment.url);
      } else if (attachment.type.startsWith('video/') || (attachment.mime_type && attachment.mime_type.startsWith('video/')) || attachment.type == 'video') {
        endpoint = '/message/send-video';
        body = {
          phoneNumber: messageData.to,
          video: attachment.url,
          caption: messageData.content || ''
        };
      } else if (attachment.type.startsWith('audio/') || (attachment.mime_type && attachment.mime_type.startsWith('audio/')) || attachment.type == 'audio') {
        endpoint = '/message/send-audio';
        body = {
          phoneNumber: messageData.to,
          audio: attachment.url
        };
      } else if (attachment.type === 'sticker' || attachment.mime_type === 'image/webp') {
        endpoint = '/message/send-sticker';
        body = {
          phoneNumber: messageData.to,
          sticker: attachment.url
        };
      } else {
        endpoint = '/message/send-document';

        // console.log('WAPI - attachment', attachment);

        let extension = attachment.extension || null;
        let url = attachment.url;
        let fileName = attachment.name || 'file';

        // Tentar extrair o nome do arquivo da URL se não encontrado
        if (!attachment.name && attachment.url) {
          try {
            // Tentar extrair de parâmetros da URL (ex: site.com?document.pdf)
            const urlObj = new URL(attachment.url);
            const pathSegments = urlObj.pathname.split('/');
            const queryParams = Object.keys(Object.fromEntries(urlObj.searchParams));

            // Verificar se algum segmento do caminho ou parâmetro da query parece ser um nome de arquivo
            const fileNamePattern = /\.[a-zA-Z0-9]{2,4}(?:$|\?|&)/;

            // Primeiro verificar o último segmento do caminho
            if (pathSegments.length > 0 && fileNamePattern.test(pathSegments[pathSegments.length - 1])) {
              fileName = pathSegments[pathSegments.length - 1];

              // Extrair a extensão do nome do arquivo obtido
              if (fileName.includes('.') && !extension) {
                extension = fileName.split('.').pop().toLowerCase();
              }
            }
            // Depois procurar nos parâmetros da query
            else if (queryParams.length > 0) {
              for (const param of queryParams) {
                if (fileNamePattern.test(param)) {
                  fileName = param;

                  // Extrair a extensão do nome do arquivo obtido
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
          // Adicionar extensão ao nome do arquivo
          if (extension) {
            fileName = `${fileName}.${extension}`;
          }
        }

        body = {
          phoneNumber: messageData.to,
          document: attachment.url,
          fileName: fileName,
          extension: extension,
          ...(messageData.responseMessageId ? {
            messageId: messageData.responseMessageId,
            message: {
              text: messageData.content
            }
          } : {})
        };
        // console.log('WAPI - body', body);
      }

      response = await fetch(`${baseUrl}${endpoint}?connectionKey=${apiConnectionKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiToken}`
        },
        body: JSON.stringify(body)
      });

    } else if (messageData.list) {
      // Enviar mensagem com listas
      response = await fetch(`${baseUrl}/message/send-option-list?connectionKey=${apiConnectionKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiToken}`
        },
        body: JSON.stringify({
          phoneNumber: messageData.to,
          delayMessage: 1000,
          title: messageData.list.title,
          description: messageData.list.description || '',
          buttonText: messageData.list.buttonText || 'Selecione uma opção',
          footerText: messageData.list.footerText || '',
          sections: messageData.list.sections.map(section => ({
            title: section.title,
            rows: section.rows.map(row => ({
              id: row.id,
              title: row.title,
              description: row.description
            }))
          }))
        })
      });
    } else if (messageData.content && messageData.content != '[object Object]') {
      const body = {
        phoneNumber: messageData.to,
        text: messageData.content,
        ...(messageData.responseMessageId ? {
          // messageId: messageData.responseMessageId,
          messageId: messageData.responseMessageId,
          message: {
            text: messageData.content
          }
        } : {})
      }
      // console.log('WAPI - body', body);
      response = await fetch(`${baseUrl}/message/send-text?connectionKey=${apiConnectionKey}`, {
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

        // Verifica se é erro de connectionKey inválida
        if (errorData.message === 'connectionKey inválida') {
          // Marca o canal como desconectado
          const { error: updateError } = await supabase
            .from('chat_channels')
            .update({
              is_connected: false,
              is_tested: false,
              status: 'inactive',
              credentials: {
                ...channel.credentials,
                connectedPhone: null,
                numberPhone: null,
                qrCode: null,
                qrCodeBase64: null,
                qrExpiresAt: null
              },
              updated_at: new Date().toISOString()
            })
            .eq('id', channel.id);

          if (updateError) {
            Sentry.captureException(updateError, {
              extra: {
                channelId: channel.id,
                context: 'updating_channel_status_after_invalid_key'
              }
            });
          }

          Sentry.captureMessage('Canal WAPI desconectado devido a connectionKey inválida', {
            level: 'warning',
            extra: {
              channelId: channel.id,
              errorData
            }
          });

          throw new Error('Canal desconectado: connectionKey inválida');
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
 * Ativa o webhook V3 para o canal
 * @param {*} channel 
 * @returns 
 */
export async function updateWebhookV2024_1(channel) {
  try {
    // console.log('channel.credentials', channel.credentials);
    if (!channel.credentials.apiHost) {
      throw new Error('Não existe host para ativar o webhook');
    }

    if (!channel.credentials.apiConnectionKey) {
      throw new Error('Não existe connectionKey para ativar o webhook');
    }

    if (!channel.credentials.apiToken) {
      throw new Error('Não existe token para ativar o webhook');
    }

    //Activate webhook v3
    const responseV3 = await fetch(`https://${channel.credentials.apiHost}/instance/updateWebhookV3?connectionKey=${channel.credentials.apiConnectionKey}&value=enable`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${channel.credentials.apiToken}`
      },
    });

    if (!responseV3.ok) {
      const errorData = await responseV3.json();
      const error = new Error(errorData.message || 'Failed to activate webhook V3');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          errorData
        }
      });
      throw error;
    }

    const dataV3 = await responseV3.json();

    // Check for error in response
    if (dataV3.error) {
      const error = new Error(dataV3.message || 'Failed to update webhook');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          dataV3
        }
      });
      throw error;
    }

    const webhookUrl = `${process.env.API_URL}/api/${channel.organization_id}/webhook/wapi/${channel.id}`;

    // Make request to WApi server to update webhook
    const response = await fetch(`https://${channel.credentials.apiHost}/webhook/editWebhook?connectionKey=${channel.credentials.apiConnectionKey}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${channel.credentials.apiToken}`
      },
      body: JSON.stringify({
        webhookUrl,
        events: {
          qrCodeGenerated: true,
          pairingCodeGenerated: true,
          codeLimitReached: true,
          connectedInstance: true,
          restoredInstance: true,
          disconnectedInstance: true,
          newChat: true,
          unreadMessageCount: false,
          numberMentioned: true,
          deletedMessage: true,
          messageDelivered: true,
          pinnedMessage: true,
          unpinnedMessage: true,
          reactedMessage: true,
          messageRead: true,
          messageReceived: true,
          messageSent: true,
          editedMessage: true,
          repliedMessage: true,
          forwardedMessage: true,
          pollCreated: true,
          updatedPoll: true,
          groupCreated: true,
          demotedMember: true,
          promotedMember: true,
          memberRemoved: true,
          updatedGroup: true,
          downloadMediaBase64: true
        }
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      const error = new Error(errorData.message || 'Failed to update webhook');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          errorData
        }
      });
      throw error;
    }

    const data = await response.json();

    // Check for error in response
    if (data.error) {
      const error = new Error(data.message || 'Failed to update webhook');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          data
        }
      });
      throw error;
    }

    return true;
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id
      }
    });
    console.error('Error updating webhook:', error);
    throw error;
  }
}

/**
 * Gera um QR code para o canal
 * @param {*} channel 
 * @returns 
 */
export async function generateQrCodeV2024_1(channel) {
  try {
    // Descriptografar credenciais antes of use
    const decryptedCredentials = decryptCredentials(channel.credentials);

    if (!decryptedCredentials.apiHost || !decryptedCredentials.apiConnectionKey || !decryptedCredentials.apiToken) {
      throw new Error('Credenciais inválidas');
    }

    // Update webhook configuration
    await updateWebhookV2024_1({
      ...channel,
      credentials: decryptedCredentials
    });

    // Make request to WApi server to generate QR code
    const response = await fetch(`https://${decryptedCredentials.apiHost}/instance/getQrcode?connectionKey=${decryptedCredentials.apiConnectionKey}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${decryptedCredentials.apiToken}`
      }
    });

    if (!response.ok) {
      const errorData = await response.json();
      const error = new Error(errorData.message || 'Failed to generate QR code');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          errorData
        }
      });
      throw error;
    }

    return true;
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
 * Deleta uma mensagem através do canal WApi v2024.1
 * @param {*} channel 
 * @param {*} messageData 
 * @returns 
 */
export async function handleDeleteMessageWapiChannelV2024_1(channel, messageData) {
  try {
    const credentials = decryptCredentials(channel.credentials);

    if (!credentials.apiHost || !credentials.apiConnectionKey || !credentials.apiToken) {
      throw new Error('Credenciais inválidas');
    }

    const baseUrl = `https://${credentials.apiHost}`;

    const response = await fetch(`${baseUrl}/message/delete?connectionKey=${credentials.apiConnectionKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${credentials.apiToken}`
      },
      body: JSON.stringify({
        phoneNumber: messageData.to,
        messageKey: {
          remoteJid: `${messageData.to}@s.whatsapp.net`,
          fromMe: true,
          id: messageData.externalId
        }
      })
    });

    if (!response.ok) {
      console.log('Erro ao deletar mensagem WAPI:', response);
      const errorData = await response.json();
      throw new Error(`WAPI error: ${JSON.stringify(errorData)}`);
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
 * Cria um novo canal de interconexão na W-API
 * @param {*} organizationId 
 * @param {*} name 
 * @returns 
 */
export async function createInterflowChannelV2024_1(organizationId, name, organizationName) {
  try {

    if (!process.env.WAPI_ACCOUNT_ID) {
      return {
        success: false,
        error: 'WAPI_ACCOUNT_ID não definido'
      };
    }

    const wapiResponse = await fetch(`https://api-painel.w-api.app/createNewConnection?id=${process.env.WAPI_ACCOUNT_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!wapiResponse.ok) {
      // Capturar detalhes completos da resposta de erro
      const errorText = await wapiResponse.text();
      let errorData;

      try {
        errorData = JSON.parse(errorText);
      } catch (parseError) {
        errorData = { raw: errorText };
      }

      const errorMessage = errorData.message || `Status ${wapiResponse.status} - ${wapiResponse.statusText}`;
      const error = new Error(`Falha ao criar conexão na W-API: ${errorMessage}`);

      Sentry.captureException(error, {
        extra: {
          organizationId,
          name,
          status: wapiResponse.status,
          statusText: wapiResponse.statusText,
          responseData: errorData
        }
      });

      console.error('Erro detalhado da API WAPI:', {
        status: wapiResponse.status,
        statusText: wapiResponse.statusText,
        data: errorData
      });

      return {
        success: false,
        error: errorMessage
      };
    }

    const wapiData = await wapiResponse.json();

    if (wapiData.error) {
      const errorMessage = wapiData.message || 'Erro retornado pela W-API';
      const error = new Error(errorMessage);

      Sentry.captureException(error, {
        extra: {
          organizationId,
          name,
          wapiData
        }
      });

      return {
        success: false,
        error: errorMessage
      };
    }

    // Criar credenciais com os dados retornados
    const credentials = {
      apiHost: wapiData.host,
      apiToken: encrypt(wapiData.token),
      apiConnectionKey: encrypt(wapiData.connectionKey)
    };

    // Criar canal no banco de dados
    const { data: channel, error } = await supabase
      .from('chat_channels')
      .insert({
        organization_id: organizationId,
        name: name,
        type: 'whatsapp_wapi',
        credentials: credentials,
        settings: {
          autoReply: true,
          notifyNewTickets: true,
          isInterflow: true,
          interflowData: {
            createdAt: new Date().toISOString(),
            accountId: encrypt(process.env.WAPI_ACCOUNT_ID),
            isInterflowConnection: true
          }
        },
        status: 'inactive',
        is_connected: false,
        is_tested: true
      })
      .select()
      .single();

    if (error) throw error;

    //Contabilizar usage
    registerUsageOrganizationByChannel(organizationId);

    // Configurar webhook após criar o canal
    // await updateWebhookV2024_1({
    //   id: channel.id,
    //   organization: { id: organizationId },
    //   credentials: {
    //     apiHost: wapiData.host,
    //     apiToken: wapiData.token,
    //     apiConnectionKey: wapiData.connectionKey
    //   }
    // });

    // Gerar QR Code
    await generateQrCodeV2024_1(channel);

    return {
      success: true,
      id: channel.id
    };

  } catch (wapiError) {
    // Verificar se o erro tem uma propriedade de resposta da API
    let errorMessage = wapiError.message;

    // Tentar extrair mensagem de erro específica da API
    if (wapiError.responseData && wapiError.responseData.message) {
      errorMessage = wapiError.responseData.message;
    }

    const error = new Error(`Erro ao criar conexão W-API: ${errorMessage}`);

    Sentry.captureException(error, {
      extra: {
        organizationId,
        name,
        wapiError: {
          message: wapiError.message,
          stack: wapiError.stack
        }
      }
    });

    console.error('Erro completo ao criar conexão W-API:', wapiError);

    return {
      success: false,
      error: errorMessage,
      details: {
        stack: wapiError.stack
      }
    };
  }
}

/**
 * Deleta uma conexão Interflow na W-API
 * @param {*} channel 
 * @returns 
 */
export async function deleteInterflowChannelV2024_1(channel) {
  try {
    const credentials = decryptCredentials(channel.credentials);

    if (!credentials.apiHost || !credentials.apiConnectionKey || !credentials.apiToken) {
      throw new Error('Credenciais inválidas');
    }

    // Se for uma conexão Interflow
    if (channel.settings.isInterflow && channel.settings?.interflowData?.accountId) {
      const accountId = decrypt(channel.settings.interflowData.accountId);

      try {
        if (channel.is_connected) {
          // Primeiro desconecta a instância
          const disconnectResponse = await fetch(`https://${channel.credentials.apiHost}/instance/logout?connectionKey=${credentials.apiConnectionKey}`, {
            method: 'DELETE',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${credentials.apiToken}`
            }
          });

          if (!disconnectResponse.ok) {
            const disconnectData = await disconnectResponse.json();
            const error = new Error(disconnectData.message || 'Falha ao desconectar instância na W-API');
            Sentry.captureException(error, {
              extra: {
                channelId: channel.id,
                disconnectData
              }
            });
            console.error('Falha ao desconectar instância na W-API:', error);
          }
          console.log('Instância antiga desconectada com sucesso');
        }

        // Depois exclui a conexão
        const wapiResponse = await fetch(
          `https://api-painel.w-api.app/deleteConnection?connectionKey=${credentials.apiConnectionKey}&id=${accountId}`,
          {
            method: 'DELETE',
            headers: {
              'Content-Type': 'application/json'
            }
          }
        );

        if (!wapiResponse.ok) {
          const wapiData = await wapiResponse.json();
          const error = new Error(wapiData.message || 'Falha ao excluir conexão na W-API');
          Sentry.captureException(error, {
            extra: {
              channelId: channel.id,
              wapiData
            }
          });
          console.error('Falha ao excluir conexão na W-API:', error);
        } else {
          const wapiData = await wapiResponse.json();
          if (wapiData.error) {
            const error = new Error(wapiData.message || 'Erro retornado pela W-API');
            Sentry.captureException(error, {
              extra: {
                channelId: channel.id,
                wapiData
              }
            });
            console.error('Erro retornado pela W-API:', error);
          }
          console.log('Conexão antiga excluída com sucesso');
        }
      } catch (wapiError) {
        console.error('Erro ao excluir conexão W-API:', wapiError);
        Sentry.captureException(wapiError, {
          extra: {
            channelId: channel.id,
          }
        });
        // Continua com a exclusão local mesmo se falhar na API
      }
    } else if (channel.is_connected) {
      // Para conexões não-Interflow, desconectar antes de excluir
      try {
        disconnectWapiInstanceV2024_1(channel);
      } catch (disconnectError) {
        console.error('Erro ao desconectar instância:', disconnectError);
        // Continua com a exclusão mesmo se falhar a desconexão
      }
    }
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id
      }
    });
  }
}

/**
 * Desconecta uma instância da W-API
 * @param {*} channel 
 * @returns 
 */
export async function disconnectWapiInstanceV2024_1(channel) {
  try {
    const decryptedCredentials = decryptCredentials(channel.credentials);

    try {
      // Fazer requisição para desconectar a instância na WApi
      const response = await fetch(`https://${channel.credentials.apiHost}/instance/logout?connectionKey=${decryptedCredentials.apiConnectionKey}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${decryptedCredentials.apiToken}`
        }
      });

      if (!response.ok) {
        const errorData = await response.json();
        const error = new Error(errorData.message || 'Failed to disconnect WApi instance');
        Sentry.captureException(error, {
          extra: {
            channelId: channel.id,
            errorData
          }
        });
        console.error('Falha ao desconectar instância na W-API:', error);
      } else {
        const data = await response.json();
        if (data.error) {
          const error = new Error(data.message || 'Erro retornado pela W-API');
          Sentry.captureException(error, {
            extra: {
              channelId: channel.id,
              data
            }
          });
          console.error('WApi error:', error);
        }
      }
    } catch (apiError) {
      console.error('Error calling WApi:', apiError);
      // Continua a execução para atualizar o status local
    }
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id
      }
    });
  }
}

/**
 * Reinicia uma instância da W-API
 * @param {*} channel 
 * @returns 
 */
export async function restartWapiInstanceV2024_1(channel) {
  try {
    const decryptedCredentials = decryptCredentials(channel.credentials);

    // Fazer requisição para resetar a instância na WApi
    const response = await fetch(`https://${channel.credentials.apiHost}/instance/restart?connectionKey=${decryptedCredentials.apiConnectionKey}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${decryptedCredentials.apiToken}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorData;

      try {
        errorData = JSON.parse(errorText);
      } catch (parseError) {
        errorData = { raw: errorText };
      }

      const errorMessage = errorData.message || `Falha ao reiniciar instância WAPI: ${response.statusText}`;

      const error = new Error(errorMessage);
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          errorData,
          status: response.status,
          statusText: response.statusText
        }
      });

      console.error('Erro detalhado da API WAPI (resetConnection):', {
        status: response.status,
        statusText: response.statusText,
        data: errorData
      });

      return res.status(response.status).json({
        success: false,
        error: errorMessage,
        details: {
          status: response.status,
          data: errorData
        }
      });
    }

    const data = await response.json();

    if (data.error) {
      const errorMessage = data.message || 'Falha ao reiniciar instância WAPI';

      const error = new Error(errorMessage);
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          data
        }
      });

      console.error('Erro retornado pela API WAPI (reset):', data);

      return res.status(400).json({
        success: false,
        error: errorMessage,
        details: data
      });
    }
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id
      }
    });
  }
}

/**
 * Valida um número de WhatsApp na W-API v2024.1
 * @param {*} channelData 
 * @param {*} phoneNumber 
 * @returns 
 */
export async function validateWhatsAppNumberV2024_1(channelData, phoneNumber) {
  try {
    const credentials = decryptCredentials(channelData.credentials);

    if (!credentials.apiHost || !credentials.apiConnectionKey || !credentials.apiToken) {
      throw new Error('Credenciais inválidas');
    }

    const baseUrl = `https://${credentials.apiHost}`;

    // Verificar número na API W-API usando o endpoint correto
    // GET https://HOST/contacts/onwhatsapp?connectionKey=CONNECTIONKEY&phoneNumber=5599992249708
    const response = await fetch(`${baseUrl}/contacts/onwhatsapp?connectionKey=${credentials.apiConnectionKey}&phoneNumber=${phoneNumber}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${credentials.apiToken}`
      }
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Erro na resposta da W-API:', errorData);
      return {
        isValid: false,
        error: 'Erro ao verificar número na API'
      };
    }

    const data = await response.json();
    const isValid = data.exists === true;

    return {
      isValid: isValid,
      data: {
        outputPhone: data.inputPhone
      }
    };
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channelData.id
      }
    });
  }
}