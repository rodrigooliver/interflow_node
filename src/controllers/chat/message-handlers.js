import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import FormData from 'form-data';
import Queue from 'queue';

import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';
import { createChat } from '../../services/chat.js';
import { createFlowEngine } from '../../services/flow-engine.js';
import { uploadFile, downloadFileFromUrl } from '../../utils/file-upload.js';
import { sendChatNotifications } from './notification-helpers.js';
import { decrypt } from '../../utils/crypto.js';

import { handleSenderMessageWApi, handleDeleteMessageWapiChannel, handleSenderUpdateMessageWapiChannel } from '../channels/wapi.js';
import { handleSenderMessageEmail } from '../../services/email.js';
import { handleSenderMessageInstagram, handleDeleteMessageInstagram } from '../channels/instagram.js';
import { handleSenderMessageOfficial } from '../channels/whatsapp-official.js';
import { formatWhatsAppToMarkdown } from '../../utils/chat.js';
// import { handleSenderMessageZApi } from '../../services/channels/z-api.js';
// import { handleSenderMessageEvolution } from '../../services/channels/evolution.js';
// import { handleSenderMessageFacebook } from '../../services/channels/facebook.js';


/**
 * Configurações e handlers para cada tipo de canal
 * 
 * Cada canal tem configurações específicas:
 * - identifier: coluna na tabela customers que armazena o ID do contato
 * - handler: função que processa o envio de mensagens
 * - formatMessage: função que formata o conteúdo da mensagem para o canal
 * 
 * Tipos de mensagens suportadas por canal:
 * - whatsapp_official: texto, imagem, vídeo, áudio, documento e templates
 * - whatsapp_wapi: texto, imagem, vídeo, áudio, documento
 * - instagram: texto, imagem, vídeo
 * - email: texto com formatação HTML, anexos
 */
const CHANNEL_CONFIG = {
  whatsapp_official: {
    identifier: 'whatsapp',
    handler: handleSenderMessageOfficial
  },
  whatsapp_wapi: {
    identifier: 'whatsapp',
    handler: handleSenderMessageWApi,
    deleteHandler: handleDeleteMessageWapiChannel,
    updateHandler: handleSenderUpdateMessageWapiChannel
  },
  whatsapp_zapi: {
    identifier: 'whatsapp',
    // handler: handleSenderMessageZApi
  },
  whatsapp_evo: {
    identifier: 'whatsapp',
    // handler: handleSenderMessageEvolution
  },
  instagram: {
    identifier: 'instagramId',
    handler: handleSenderMessageInstagram,
    // deleteHandler: handleDeleteMessageInstagram
  },
  facebook: {
    identifier: 'facebookId',
    // handler: handleSenderMessageFacebook
  },
  email: {
    identifier: 'email',
    handler: handleSenderMessageEmail
  }
};

/**
 * Normaliza o ID do contato e retorna possíveis variantes
 * @param {string} id - ID original do contato
 * @param {string} channelType - Tipo do canal
 * @returns {string[]} Array com ID normalizado e suas variantes
 */
const normalizeContactId = (id, channelType) => {
  if (!id) return [id];

  switch (channelType) {
    case 'whatsapp_official':
    case 'whatsapp_wapi':
    case 'whatsapp_zapi':
    case 'whatsapp_evo': {
      // Remove todos os caracteres não numéricos
      let numbers = id.replace(/\D/g, '');

      // Remove @s.whatsapp.net se existir (whatsapp_evo)
      numbers = numbers.split('@')[0];

      const variants = new Set(); // Usa Set para evitar duplicatas

      // Se começar com 55 e tiver 12 ou 13 dígitos, é um número brasileiro
      if (numbers.startsWith('55') && (numbers.length === 12 || numbers.length === 13)) {
        if (numbers.length === 13) { // tem 9
          // Versão sem 9
          const withoutNine = `${numbers.slice(0, 4)}${numbers.slice(5)}`;
          variants.add(`+${withoutNine}`);
          variants.add(withoutNine);
        } else if (numbers.length === 12) { // não tem 9
          // Versão com 9
          const withNine = `${numbers.slice(0, 4)}9${numbers.slice(4)}`;
          variants.add(`+${withNine}`);
          variants.add(withNine);
        }
      }

      // Adiciona versões com e sem + para qualquer número
      variants.add(`+${numbers}`);
      variants.add(numbers);

      return Array.from(variants);
    }

    case 'instagram':
    case 'facebook': {
      const normalized = id.toLowerCase();
      return [normalized];
    }

    case 'email': {
      const normalized = id.toLowerCase().trim();
      return [normalized];
    }

    default:
      return [id];
  }
};

/**
 * Processa mensagens recebidas em formato padronizado
 * 
 * Esta função lida com mensagens recebidas de diferentes canais de comunicação,
 * incluindo mensagens com anexos de mídia (imagens, vídeos, áudios, documentos).
 * 
 * Suporta recebimento de mídia via:
 * - URLs diretas
 * - Dados base64 (especialmente útil para webhooks do WAPI)
 * - Download via API do canal quando necessário
 * 
 * @param {Object} channel - Canal de comunicação
 * @param {Object} messageData - Dados normalizados da mensagem
 * @param {string} messageData.messageId - ID único da mensagem
 * @param {string} messageData.timestamp - Momento do envio
 * @param {string} messageData.externalId - ID do contato externo
 * @param {string} messageData.externalName - Nome do contato externo
 * @param {string} messageData.externalProfilePicture - URL da foto do contato externo
 * @param {Object} messageData.message - Dados da mensagem
 * @param {string} messageData.message.type - Tipo da mensagem (text, image, etc)
 * @param {string} messageData.message.content - Conteúdo da mensagem
 * @param {Object} messageData.message.raw - Dados brutos originais
 * @param {boolean} messageData.fromMe - Se foi uma mensagem enviada por mim
 * @param {boolean} messageData.attachments - Uma lista de arquivo com url e type, onde não cadastra no banco de daoos, somente aproveita a url
 */
export async function handleIncomingMessage(channel, messageData) {
  const { organization } = channel;

  try {
    // Verifica se a mensagem já existe quando for messageSent
    if (messageData.event === 'messageSent' && messageData.fromMe) {
      const { data: existingMessage, error: findMessageError } = await supabase
        .from('messages')
        .select('*')
        .eq('external_id', messageData.messageId)
        .single();

      if (findMessageError && findMessageError.code !== 'PGRST116') throw findMessageError;

      if (existingMessage) {
        const { error: updateError } = await supabase
          .from('messages')
          .update({ status: 'sent' })
          .eq('id', existingMessage.id);

        if (updateError) throw updateError;
        return;
      }
    }
  } catch (error) {
    Sentry.captureException(error, {
      extra: { channel, messageData, context: 'handling_existing_message' }
    });
    throw error;
  }

  try {
    const channelConfig = CHANNEL_CONFIG[channel.type];
    if (!channelConfig) {
      throw new Error(`Unsupported channel type: ${channel.type}`);
    }

    let chat = messageData.chat;
    let customer = chat?.customers;
    let isFirstMessage = false;

    if (!chat) {
      const identifierColumn = channelConfig.identifier;

      let possibleIds = [];
      if (channel.type === 'whatsapp_wapi') {
        possibleIds = normalizeContactId(messageData.externalId, channel.type);
      } else {
        possibleIds = [messageData.externalId];
      }

      // console.log('possibleIds', possibleIds);

      const { data: chats, error } = await supabase
        .from('chats')
        .select('*, customers(*)')
        .eq('channel_id', channel.id)
        .in('status', ['in_progress', 'pending', 'await_closing'])
        .in('external_id', possibleIds)
        .order('last_message_at', { ascending: false })
        .limit(1);

      chat = chats?.[0] || null;

      if (chat) {
        customer = chat.customers;
        if (messageData.externalProfilePicture) {
          // Atualizar o profile_picture do chat
          const { error: updateError } = await supabase
            .from('chats')
            .update({ profile_picture: messageData.externalProfilePicture })
            .eq('id', chat.id);

          if (updateError) {
            Sentry.captureException(updateError, {
              extra: { channel, messageData, context: 'updating_chat_profile_picture' }
            });
          }

          //Atualizar o profile_picture do customer
          supabase
            .from('customers')
            .update({ profile_picture: messageData.externalProfilePicture })
            .eq('id', customer.id);
        }
      } else {
        isFirstMessage = true;

        // console.log('channel', channel);

        try {
          const possibleIds = normalizeContactId(messageData.externalId, channel.type);

          //Pesquisar se o customer existe com o id
          const { data: customerContact, error: customerContactError } = await supabase
            .from('customer_contacts')
            .select('*, customer:customers!customer_contacts_customer_id_fkey(*)')
            .eq('type', identifierColumn)
            .in('value', possibleIds)
            .eq('customer.organization_id', channel.organization.id)
            .not('customer', 'is', null)
            .order('created_at', { ascending: true })
            .limit(1);

          // console.log('customerContact', customerContact, channel.organization.id);

          if (customerContactError) throw customerContactError;

          if (customerContact.length > 0) {
            customer = customerContact[0].customer;
          } else {
            //Criar novo customer
            try {
              const customerData = {
                organization_id: organization.id,
                name: messageData.externalName || messageData.externalId,
                stage_id: channel.settings?.defaultStageId || null,
                ...(messageData.externalProfilePicture && { profile_picture: messageData.externalProfilePicture })
              };

              const { data: newCustomer, error: createError } = await supabase
                .from('customers')
                .insert(customerData)
                .select()
                .single();

              if (createError) throw createError;

              //Criar novo customer_contact
              const { error: insertError } = await supabase
                .from('customer_contacts')
                .insert({
                  customer_id: newCustomer.id,
                  type: identifierColumn,
                  value: possibleIds[0]
                });

              if (insertError) throw insertError;

              customer = newCustomer;
            } catch (error) {
              Sentry.captureException(error, {
                extra: { channel, messageData, context: 'creating_customer' }
              });
              throw error;
            }
          }
        } catch (error) {
          Sentry.captureException(error, {
            extra: { channel, messageData, context: 'finding_customer' }
          });
          throw error;
        }

        try {
          // Buscar o time padrão da organização
          const { data: defaultTeam } = await supabase
            .from('service_teams')
            .select('id')
            .eq('organization_id', organization.id)
            .eq('is_default', true)
            .single();

          chat = await createChat({
            organization_id: organization.id,
            customer_id: customer.id,
            channel_id: channel.id,
            external_id: messageData.externalId,
            status: 'pending',
            team_id: channel.settings?.defaultTeamId || defaultTeam?.id || null,
            ...(messageData.externalProfilePicture && { profile_picture: messageData.externalProfilePicture }),
          });

          if (!chat) throw new Error('Failed to create chat');
        } catch (error) {
          Sentry.captureException(error, {
            extra: { channel, messageData, context: 'creating_chat' }
          });
          throw error;
        }
      }
    } else {
      if (chat.is_first_message) {
        isFirstMessage = true;
      }
    }

    // Processar anexos se existirem
    let attachments = [];
    let fileRecords = [];

    if (messageData.attachments?.length > 0 ||
      messageData.message?.mediaUrl ||
      (messageData.message?.raw &&
        (messageData.message.raw.image ||
          messageData.message.raw.video ||
          messageData.message.raw.audio ||
          messageData.message.raw.document ||
          messageData.message.raw.sticker))) {

      try {
        // console.log('[MessageHandlers] Iniciando processamento de mídia:', {
        //   hasAttachments: messageData.attachments?.length > 0,
        //   hasMediaUrl: !!messageData.message?.mediaUrl,
        //   hasRawData: !!messageData.message?.raw,
        //   messageId: messageData.messageId
        // });

        const mediaResult = await processMessageMedia(messageData, organization.id, chat.id);

        // Remover todos os base64 dos metadados
        if (messageData.message.raw) {
          const metadataRaw = { ...messageData.message.raw };
          if (metadataRaw.audio) {
            delete metadataRaw.audio.audioBase64;
          }
          if (metadataRaw.image) {
            delete metadataRaw.image.imageBase64;
          }
          if (metadataRaw.video) {
            delete metadataRaw.video.videoBase64;
          }
          if (metadataRaw.document) {
            delete metadataRaw.document.documentBase64;
          }
          if (metadataRaw.sticker) {
            delete metadataRaw.sticker.stickerBase64;
          }
          messageData.message.raw = metadataRaw;
        }

        if (mediaResult && mediaResult.success) {
          if (mediaResult.attachment) {
            attachments = [mediaResult.attachment];

            // Se for um arquivo de áudio, tentar fazer a transcrição
            if (mediaResult.attachment.type.startsWith('audio') ||
              mediaResult.attachment.mime_type === 'audio/ogg; codecs=opus') {
              try {
                // Buscar integração OpenAI ativa
                const openaiIntegration = await getActiveOpenAIIntegration(organization.id);

                if (openaiIntegration) {
                  // Fazer a transcrição
                  const transcription = await transcribeAudio(
                    mediaResult.attachment.url,
                    openaiIntegration.api_key,
                    mediaResult.attachment.mime_type
                  );

                  // Adicionar a transcrição aos metadados e remover audioBase64
                  const metadataRaw = { ...messageData.message.raw };

                  // Atualizar o conteúdo da mensagem com a transcrição
                  messageData.message.content = transcription;
                  // messageData.message.type = 'text';

                  messageData.message.raw = {
                    ...metadataRaw,
                    transcription
                  };
                }
              } catch (transcriptionError) {
                Sentry.captureException(transcriptionError, {
                  extra: {
                    organizationId: organization.id,
                    audioType: mediaResult.attachment.type,
                    context: 'audio_transcription'
                  }
                });
                // Continuar mesmo se a transcrição falhar
              }
            }
          }
          if (mediaResult.fileRecord) {
            fileRecords = [mediaResult.fileRecord];
          }
        }
      } catch (error) {
        console.error('Erro ao processar mídia da mensagem:', error);
        Sentry.captureException(error, {
          extra: { channel, messageData, context: 'processing_message_media' }
        });
        // Continua o processamento mesmo se falhar o upload da mídia
      }
    }

    // Verificar se é uma resposta a outra mensagem
    let responseMessageId = null;
    if (messageData.responseExternalId) {
      try {
        // Buscar a mensagem original pelo external_id
        const { data: originalMessage, error: findError } = await supabase
          .from('messages')
          .select('id')
          .eq('external_id', messageData.responseExternalId)
          .eq('chat_id', chat.id)
          .single();

        if (!findError && originalMessage) {
          responseMessageId = originalMessage.id;
        }
      } catch (responseError) {
        Sentry.captureException(responseError, {
          extra: {
            chatId: chat.id,
            responseExternalId: messageData.responseExternalId,
            context: 'finding_original_message'
          }
        });
        // Continuar mesmo se não conseguir encontrar a mensagem original
      }
    }

    // Cadastra a mensagem recebida
    const { data: message, error: messageError } = await supabase
      .from('messages')
      .insert({
        chat_id: chat.id,
        organization_id: organization.id,
        content: messageData.message.content,
        type: messageData.message.type,
        sender_type: messageData.fromMe ? 'agent' : 'customer',
        status: messageData.fromMe ? 'sent' : 'received',
        external_id: messageData.messageId,
        ...(messageData.fromMe
          ? {}
          : { sender_customer_id: customer.id }
        ),
        ...(responseMessageId ? { response_message_id: responseMessageId } : {}),
        metadata: messageData.message.raw,
        attachments: attachments.length > 0 ? attachments : undefined
      })
      .select()
      .single();

    if (messageError) throw messageError;

    // //Atualizar o message_id em cada attachments
    // for (let i = 0; i < attachments.length; i++) {
    //   const { error: updateError } = await supabase
    //     .from('attachments')
    //     .update({ message_id: message.id })
    //     .eq('id', attachments[i].id);

    //   if (updateError) {
    //     Sentry.captureException(updateError, {
    //       extra: {
    //         messageId: message.id,
    //         attachmentId: attachments[i].id,
    //         context: 'updating_attachment_message_id'
    //       }
    //     });
    //     console.error('Erro ao atualizar message_id no attachment:', updateError);
    //   }
    // }

    // Registrar arquivos vinculados à mensagem
    if (fileRecords && fileRecords.length > 0) {
      // Definir se é um canal social
      const isSocialChannel = [
        'whatsapp_official',
        'whatsapp_wapi',
        'whatsapp_zapi',
        'whatsapp_evo',
        'instagram',
        'facebook'
      ].includes(channel.type);

      // Mapear arquivos para suas respectivas mensagens
      for (let i = 0; i < fileRecords.length; i++) {
        // Para canais sociais, cada arquivo tem sua própria mensagem
        if (isSocialChannel) {
          fileRecords[i].message_id = message.id;
        } else {
          // Para email, todos os arquivos pertencem à mesma mensagem
          fileRecords[i].message_id = message.id;
        }
      }

      // Filtrar registros duplicados baseado no id
      const uniqueFileRecords = fileRecords.filter((record, index, self) =>
        index === self.findIndex((r) => r.id === record.id)
      );

      console.log(`[Arquivos] Tentando inserir ${uniqueFileRecords.length} arquivos únicos`);

      if (uniqueFileRecords.length > 0 && !messageData.attachments?.length) {
        const { error: filesError } = await supabase
          .from('files')
          .upsert(uniqueFileRecords, {
            onConflict: 'id',
            ignoreDuplicates: true
          });

        if (filesError) {
          Sentry.captureException(filesError, {
            extra: {
              chatId: chat.id,
              organizationId: organization.id,
              fileRecords: uniqueFileRecords,
              context: 'inserting_files'
            }
          });
          console.error('Erro ao registrar arquivos:', filesError);
          // Não falhar a operação principal se o registro de arquivos falhar
        } else {
          console.log(`[Arquivos] ${uniqueFileRecords.length} arquivos registrados com sucesso`);
        }
      }
    }

    // Atualiza o last_message_id do chat
    const { error: updateError } = await supabase
      .from('chats')
      .update({
        last_message_id: message.id,
        last_message_at: message.created_at,
        unread_count: chat.unread_count ? parseInt(chat.unread_count) + 1 : 1
      })
      .eq('id', chat.id);

    if (updateError) throw updateError;

    // Buscar o chat atualizado com todas as informações necessárias
    const { data: updatedChat, error: chatError } = await supabase
      .from('chats')
      .select('*')
      .eq('id', chat.id)
      .single();

    if (chatError) {
      console.error('Erro ao buscar chat atualizado:', chatError);
    } else {
      // Enviar notificações push se for uma mensagem do cliente
      if (!messageData.fromMe) {
        sendChatNotifications(updatedChat || chat, customer, message);
      }
    }

    if (!messageData.fromMe) {
      const flowEngine = createFlowEngine(organization, channel, customer, chat.id, {
        // isFirstMessage: true,
        isFirstMessage,
        lastMessage: message
      });

      await flowEngine.processMessage({
        content: messageData.message.content,
        type: messageData.message.type,
        metadata: messageData.message.raw
      });
    }

  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channel,
        messageData
      }
    });
    throw error;
  }
}

/**
 * Processa mídia de mensagens recebidas
 * 
 * Esta função extrai, baixa e armazena arquivos de mídia recebidos em mensagens.
 * Suporta múltiplos métodos de obtenção da mídia, em ordem de prioridade:
 * 
 * 1. Dados base64 incluídos diretamente no webhook (mediaBase64)
 * 2. Download direto da URL fornecida (mediaUrl)
 * 3. Download via API do canal usando credenciais e messageId
 * 
 * Após obter o arquivo, faz upload para o armazenamento configurado (S3 ou Supabase)
 * e retorna os dados necessários para vincular o arquivo à mensagem.
 * 
 * @param {Object} messageData - Dados da mensagem
 * @param {string} organizationId - ID da organização
 * @returns {Promise<Object>} - Dados do arquivo processado (attachment e fileRecord)
 */
async function processMessageMedia(messageData, organizationId, chatId) {
  try {
    // Extrair dados da mídia
    const raw = messageData.message?.raw || {};
    let mediaUrl = messageData.message?.mediaUrl;
    let mimeType = messageData.message?.mimeType;
    let fileName = messageData.message?.fileName;
    let caption = messageData.message?.content;
    let mediaBase64 = messageData.message?.mediaBase64;
    let mediaKey = null;
    let directPath = null;

    // Verificar se há anexos diretos
    if (messageData.attachments?.length > 0) {
      console.log('[MessageHandlers] Processando anexos diretos:', {
        attachments: messageData.attachments,
        messageId: messageData.messageId
      });

      const attachment = messageData.attachments[0];
      mediaUrl = attachment.url;
      mimeType = attachment.mime_type || 'image/jpeg';
      fileName = attachment.name;

      // Se for uma URL do Instagram, usar diretamente sem download/upload //  && mediaUrl.includes('instagram.com')
      if (mediaUrl) {
        console.log('[MessageHandlers] Processando URL do Instagram:', {
          mediaUrl,
          mimeType,
          messageId: messageData.messageId
        });

        const fileId = uuidv4();
        const extension = mimeType ? mimeType.split('/')[1] || '' : '';
        const generatedFileName = `${fileId}.${extension}`;

        const result = {
          success: true,
          url: mediaUrl,
          mimeType,
          fileName: generatedFileName,
          attachment: {
            url: mediaUrl,
            type: mimeType.startsWith('image/') ? 'image' :
              mimeType.startsWith('video/') ? 'video' :
                mimeType.startsWith('audio/') ? 'audio' : 'document',
            name: generatedFileName,
            mime_type: mimeType
          },
          fileRecord: {
            id: fileId,
            name: generatedFileName,
            url: mediaUrl,
            mime_type: mimeType,
            size: null, // Não temos o tamanho pois não baixamos o arquivo
            organization_id: organizationId
          }
        };

        console.log('[MessageHandlers] URL do Instagram processada:', {
          result,
          messageId: messageData.messageId
        });

        return result;
      }
    }

    // Extrair dados da mídia dos dados brutos se não fornecidos diretamente
    if (!mediaUrl && !mediaBase64) {
      if (raw.image) {
        mediaUrl = raw.image.url;
        mimeType = raw.image.mimetype || 'image/jpeg';
        caption = raw.image.caption || caption;
        mediaKey = raw.image.mediaKey;
        directPath = raw.image.directPath;
        mediaBase64 = raw.image.imageBase64;
      } else if (raw.video) {
        mediaUrl = raw.video.url;
        mimeType = raw.video.mimetype || 'video/mp4';
        caption = raw.video.caption || caption;
        mediaKey = raw.video.mediaKey;
        directPath = raw.video.directPath;
        mediaBase64 = raw.video.videoBase64;
      } else if (raw.audio) {
        mediaUrl = raw.audio.url;
        mimeType = raw.audio.mimetype || 'audio/mp3';
        caption = raw.audio.caption || caption;
        mediaKey = raw.audio.mediaKey;
        directPath = raw.audio.directPath;
        mediaBase64 = raw.audio.audioBase64;
      } else if (raw.document) {
        mediaUrl = raw.document.url;
        mimeType = raw.document.mimetype || 'application/pdf';
        caption = raw.document.caption || caption;
        fileName = raw.document.filename || fileName;
        mediaKey = raw.document.mediaKey;
        directPath = raw.document.directPath;
        mediaBase64 = raw.document.documentBase64;
      }
    }

    // Se for uma URL do Instagram, usar diretamente sem download/upload
    if (mediaUrl && mediaUrl.includes('instagram.com')) {
      console.log('[MessageHandlers] Processando URL do Instagram:', {
        mediaUrl,
        mimeType,
        messageId: messageData.messageId
      });

      const fileId = uuidv4();
      const extension = mimeType ? mimeType.split('/')[1] || '' : '';
      const generatedFileName = `${fileId}.${extension}`;

      const result = {
        success: true,
        url: mediaUrl,
        mimeType,
        fileName: generatedFileName,
        attachment: {
          url: mediaUrl,
          type: mimeType.startsWith('image/') ? 'image' :
            mimeType.startsWith('video/') ? 'video' :
              mimeType.startsWith('audio/') ? 'audio' : 'document',
          name: generatedFileName,
          mime_type: mimeType
        },
        fileRecord: {
          id: fileId,
          name: generatedFileName,
          url: mediaUrl,
          mime_type: mimeType,
          size: null, // Não temos o tamanho pois não baixamos o arquivo
          organization_id: organizationId
        }
      };

      console.log('[MessageHandlers] URL do Instagram processada:', {
        result,
        messageId: messageData.messageId
      });

      return result;
    }

    // Converter URL relativa para absoluta se necessário
    if (mediaUrl) {
      // console.log('[MessageHandlers] Processando URL de mídia:', {
      //   mediaUrl,
      //   mimeType,
      //   messageId: messageData.messageId
      // });

      // Verifica se a URL é absoluta (começa com http:// ou https://)
      if (!mediaUrl.startsWith('http://') && !mediaUrl.startsWith('https://')) {
        const apiUrl = process.env.API_URL || process.env.BACKEND_URL || 'http://localhost:3000';
        // Remover a barra final se a URL base terminar com barra
        const baseUrl = apiUrl.endsWith('/') ? apiUrl.slice(0, -1) : apiUrl;

        // Adicionar barra inicial se a URL não começar com barra
        const urlPath = mediaUrl.startsWith('/') ? mediaUrl : `/${mediaUrl}`;

        mediaUrl = `${baseUrl}${urlPath}`;
        console.log(`[MessageHandlers] URL convertida para absoluta: ${mediaUrl}`);
      }
    }

    // Tentar usar o base64 primeiro se disponível
    if (mediaBase64) {
      // console.log('[MessageHandlers] Processando mídia base64:', {
      //   mimeType,
      //   messageId: messageData.messageId
      // });

      try {
        // Usar a função uploadFile diretamente com os dados base64
        const uploadResult = await uploadFile({
          fileData: mediaBase64,
          fileName: fileName || `file-${Date.now()}.${mimeType.split('/')[1] || 'bin'}`,
          contentType: mimeType,
          organizationId,
          isBase64: true,
          customFolder: 'media',
          chatId: chatId
        });

        if (uploadResult.success) {
          // console.log('[MessageHandlers] Upload base64 realizado com sucesso:', {
          //   uploadResult,
          //   messageId: messageData.messageId
          // });

          return {
            success: true,
            url: uploadResult.fileUrl,
            mimeType,
            fileName: uploadResult.fileName,
            size: uploadResult.fileSize,
            attachment: uploadResult.attachment,
            fileRecord: uploadResult.fileRecord
          };
        } else {
          console.error('[MessageHandlers] Falha no upload base64:', {
            error: uploadResult.error,
            messageId: messageData.messageId
          });

          Sentry.captureMessage('Falha ao fazer upload do arquivo base64', {
            level: 'error',
            extra: {
              organizationId,
              fileName,
              mimeType,
              error: uploadResult.error,
              context: 'upload_base64_file'
            }
          });
          throw new Error(`Falha ao fazer upload do arquivo base64: ${uploadResult.error}`);
        }
      } catch (base64Error) {
        console.error('[MessageHandlers] Erro ao processar mídia base64:', {
          error: base64Error,
          messageId: messageData.messageId
        });

        Sentry.captureException(base64Error, {
          extra: {
            organizationId,
            fileName,
            mimeType,
            context: 'processing_base64_media'
          }
        });
        // Se falhar, tentaremos outros métodos
      }
    }

    // Se não temos buffer do base64, tentar baixar da URL
    if (mediaUrl) {
      try {
        console.log(`Tentando baixar mídia da URL: ${mediaUrl}`);

        // Usar a função downloadFileFromUrl para obter o buffer
        const fileBuffer = await downloadFileFromUrl(mediaUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        });

        // Usar a função uploadFile com o buffer obtido
        const uploadResult = await uploadFile({
          fileData: fileBuffer,
          fileName: fileName || `file-${Date.now()}.${mimeType.split('/')[1] || 'bin'}`,
          contentType: mimeType,
          fileSize: fileBuffer.length,
          organizationId,
          customFolder: 'media',
          chatId: chatId
        });

        if (uploadResult.success) {
          return {
            success: true,
            url: uploadResult.fileUrl,
            mimeType,
            fileName: uploadResult.fileName,
            size: uploadResult.fileSize,
            attachment: uploadResult.attachment,
            fileRecord: uploadResult.fileRecord
          };
        } else {
          Sentry.captureMessage('Falha ao fazer upload do arquivo baixado', {
            level: 'error',
            extra: {
              organizationId,
              fileName,
              mimeType,
              mediaUrl,
              error: uploadResult.error,
              context: 'upload_downloaded_file'
            }
          });
          throw new Error(`Falha ao fazer upload do arquivo baixado: ${uploadResult.error}`);
        }
      } catch (downloadError) {
        Sentry.captureException(downloadError, {
          extra: {
            organizationId,
            fileName,
            mimeType,
            mediaUrl,
            context: 'processing_downloaded_media'
          }
        });
        console.error('Erro ao baixar mídia diretamente:', downloadError);
        // Se falhar, tentaremos o próximo método
      }
    }

    // Se ainda não temos o buffer, tentar via API do canal
    if (messageData.channel) {
      try {
        // Buscar credenciais do canal
        const { data: channelData } = await supabase
          .from('chat_channels')
          .select('credentials, type')
          .eq('id', messageData.channel.id)
          .single();

        if (!channelData) {
          Sentry.captureMessage('Canal não encontrado', {
            level: 'error',
            extra: {
              channelId: messageData.channel.id,
              context: 'fetching_channel_credentials'
            }
          });
          throw new Error('Canal não encontrado');
        }

        // Implementar lógica específica para cada tipo de canal
        if (channelData.type === 'whatsapp' && mediaKey && directPath) {
          // Lógica específica para WhatsApp
          // ...
        }
      } catch (channelError) {
        Sentry.captureException(channelError, {
          extra: {
            channelId: messageData.channel.id,
            mediaKey,
            directPath,
            context: 'channel_api_media_download'
          }
        });
        console.error('Erro ao tentar baixar mídia via API do canal:', channelError);
      }
    }

    // Gerar nome de arquivo se não fornecido
    if (!fileName) {
      const fileId = uuidv4();
      const extension = mimeType ? mimeType.split('/')[1] || '' : '';
      fileName = `${fileId}.${extension}`;
    }

    // Se não conseguimos obter o buffer da mídia
    Sentry.captureMessage('Não foi possível obter o conteúdo da mídia', {
      level: 'warning',
      extra: {
        organizationId,
        fileName,
        mimeType,
        mediaUrl,
        context: 'media_processing_failed'
      }
    });
    console.warn('Não foi possível obter o conteúdo da mídia por nenhum método');
    return {
      success: false,
      error: 'Não foi possível obter o conteúdo da mídia por nenhum método',
      mimeType,
      fileName,
      attachment: null,
      fileRecord: null
    };
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        organizationId,
        messageData,
        context: 'process_message_media'
      }
    });
    console.error('Erro ao processar mídia:', error);
    return {
      success: false,
      error: error.message,
      attachment: null,
      fileRecord: null
    };
  }
}

/**
 * Atualiza o status de uma mensagem com base em dados normalizados
 * 
 * Esta função espera receber dados já normalizados pelos canais específicos.
 * Os dados devem estar no formato padrão com messageId, status, error, timestamp, etc.
 * 
 * Exemplo de normalização que cada canal deve fazer:
 * ```javascript
 * function normalizeChannelStatusUpdate(webhookData) {
 *   return {
 *     messageId: webhookData.messageId || webhookData.id,
 *     status: mapChannelStatusToStandard(webhookData.status),
 *     error: webhookData.error || webhookData.errorMessage || null,
 *     timestamp: webhookData.timestamp || webhookData.receivedAt || Date.now(),
 *     metadata: {
 *       original: webhookData,
 *       source: 'channel_name'
 *     }
 *   };
 * }
 * ```
 * 
 * @param {Object} channel - Canal de comunicação
 * @param {Object} normalizedData - Dados normalizados da atualização de status
 * @param {string} normalizedData.messageId - ID da mensagem a ser atualizada
 * @param {string} normalizedData.status - Novo status da mensagem
 * @param {string} [normalizedData.error] - Mensagem de erro, se houver
 * @param {number} [normalizedData.timestamp] - Timestamp da atualização de status
 * @param {Object} [normalizedData.metadata] - Metadados adicionais do canal
 */
export async function handleStatusUpdate(channel, normalizedData) {
  try {
    // Os dados já vêm normalizados pelos canais específicos
    const { messageId, status, error, timestamp, metadata } = normalizedData;

    // Função auxiliar para buscar a mensagem
    const findMessage = async () => {
      const { data: message, error: findMessageError } = await supabase
        .from('messages')
        .select(`
          *,
          chat:chats!messages_chat_id_fkey!inner(
            channel_id
          )
        `)
        .eq('external_id', messageId)
        .eq('chat.channel_id', channel.id)
        .not('status', 'eq', 'deleted')
        .maybeSingle();

      return { message, findMessageError };
    };

    // Primeira tentativa de buscar a mensagem
    let { message, findMessageError } = await findMessage();

    if (findMessageError) {
      console.log('findMessageError', findMessageError);
      Sentry.captureException(findMessageError, {
        extra: {
          messageId,
          channelId: channel.id,
          context: 'finding_message_by_external_id_and_channel'
        }
      });
      throw findMessageError;
    }

    // Se não encontrou a mensagem na primeira tentativa, aguardar 5 segundos e tentar novamente
    if (!message) {
      // console.log(`Mensagem ${messageId} não encontrada na primeira tentativa, aguardando 5 segundos para segunda tentativa...`);
      
      await new Promise(resolve => setTimeout(resolve, 5000)); // Aguarda 5 segundos
      
      // Segunda tentativa
      const secondAttempt = await findMessage();
      message = secondAttempt.message;
      findMessageError = secondAttempt.findMessageError;

      if (findMessageError) {
        console.log('findMessageError segunda tentativa', findMessageError);
        Sentry.captureException(findMessageError, {
          extra: {
            messageId,
            channelId: channel.id,
            context: 'finding_message_by_external_id_and_channel_second_attempt'
          }
        });
        throw findMessageError;
      }
    }

    if (message) {
      // Verifica se o novo status representa uma progressão válida
      const statusHierarchy = {
        'pending': 0,
        'retry': 1,
        'sent': 2,
        'delivered': 3,
        'read': 4,
        'failed': 5 // O status 'failed' é tratado como caso especial
      };

      const currentStatusLevel = statusHierarchy[message.status] || 0;
      const newStatusLevel = statusHierarchy[status] || 0;

      // Verifica se já temos um timestamp para o status atual nos metadados
      let currentStatusTimestamp = null;
      if (message.metadata?.status_timestamps) {
        const timestampStr = message.metadata.status_timestamps[message.status];
        if (timestampStr) {
          try {
            currentStatusTimestamp = new Date(timestampStr).getTime();
          } catch (e) {
            Sentry.captureException(e, {
              extra: {
                timestampStr,
                context: 'parsing_status_timestamp'
              }
            });
            console.warn(`Erro ao converter timestamp: ${timestampStr}`, e);
          }
        }
      }

      // Verifica se o novo evento é mais recente que o atual
      const newEventTimestamp = timestamp || Date.now();
      const isNewerEvent = !currentStatusTimestamp || newEventTimestamp >= currentStatusTimestamp;

      // Só atualiza o status se for uma progressão válida ou se for 'failed' ou se for um evento mais recente
      const shouldUpdateStatus =
        status === 'failed' || // Sempre atualiza para 'failed'
        (newStatusLevel > currentStatusLevel) || // Atualiza se for um status "superior"
        (newStatusLevel === currentStatusLevel && isNewerEvent); // Atualiza se for o mesmo status mas mais recente

      // Prepara os dados para atualização
      const updateData = {
        error_message: error
      };

      // Só inclui o status se for uma progressão válida
      if (shouldUpdateStatus) {
        updateData.status = status;
      }

      // Prepara os metadados atualizados
      const statusDate = timestamp ? new Date(timestamp).toISOString() : new Date().toISOString();

      // Inicializa ou atualiza os metadados
      const currentMetadata = message.metadata || {};
      const statusTimestamps = currentMetadata.status_timestamps || {};

      // Atualiza o timestamp do status atual
      if (shouldUpdateStatus || !statusTimestamps[status]) {
        statusTimestamps[status] = statusDate;
      }

      // Certifica-se de que status_updates seja um array
      const currentStatusUpdates = Array.isArray(currentMetadata.status_updates)
        ? currentMetadata.status_updates
        : [];

      // Adiciona a nova atualização de status com timestamp
      const newStatusUpdate = {
        status,
        timestamp,
        processed_at: new Date().toISOString(),
        ...metadata
      };

      // Atualiza os metadados
      updateData.metadata = {
        ...currentMetadata,
        status_timestamps: statusTimestamps,
        status_updates: [
          ...currentStatusUpdates,
          newStatusUpdate
        ]
      };

      // Verifica se há algo para atualizar
      if (Object.keys(updateData).length > 1 || shouldUpdateStatus) { // Sempre tem pelo menos error_message
        // Atualiza a mensagem no banco de dados
        const { error: updateError } = await supabase
          .from('messages')
          .update(updateData)
          .eq('id', message.id);

        if (updateError) {
          Sentry.captureException(updateError, {
            extra: {
              messageId: message.id,
              updateData,
              context: 'updating_message_status'
            }
          });
          console.error(`Erro ao atualizar status da mensagem: ${updateError.message}`);
        }

        const { error: updateChatError } = await supabase
          .from('chats')
          .update({
            last_customer_message_at: new Date().toISOString() //Atualiza a data da última mensagem do cliente
          })
          .eq('id', message.chat_id);

        if (updateChatError) {
          Sentry.captureException(updateChatError, {
            extra: {
              chatId: message.chat_id,
              context: 'updating_chat_last_message_at'
            }
          });
        }
      }
    } else {
      Sentry.captureMessage('Mensagem não encontrada para atualização de status após duas tentativas', {
        level: 'warning',
        extra: {
          messageId,
          channelId: channel.id,
          context: 'message_not_found_for_status_update_after_retry'
        }
      });
      console.log(`Mensagem não encontrada para o ID: ${messageId} no canal: ${channel.id} após duas tentativas`);
    }
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channel,
        normalizedData,
        context: 'handle_status_update'
      }
    });
    console.error(`Erro em handleStatusUpdate: ${error.message}`);
  }
}

/**
 * Verifica se o canal deve ser desconectado com base no histórico de falhas
 * 
 * Analisa as últimas mensagens enviadas pelo canal para determinar se há
 * um padrão de falhas que justifique a desconexão automática do canal.
 * 
 * @param {string} channelId - ID do canal a ser verificado
 * @returns {Promise<boolean>} - True se o canal deve ser desconectado
 */
async function shouldDisconnectChannel(channelId) {
  try {
    // Busca as últimas 8 mensagens enviadas neste canal usando JOIN
    const { data: recentMessages, error } = await supabase
      .from('messages')
      .select(`
        status, 
        error_message,
        chat:chats!messages_chat_id_fkey(channel_id)
      `)
      .eq('chat.channel_id', channelId)
      .eq('sender_type', 'agent')
      .eq('sent_from_system', true)
      .order('created_at', { ascending: false })
      .limit(8);

    if (error) {
      Sentry.captureException(error, {
        extra: {
          channelId,
          context: 'fetching_recent_messages'
        }
      });
      throw error;
    }

    // Se não houver mensagens suficientes para análise
    if (!recentMessages || recentMessages.length < 6) {
      Sentry.captureMessage('Mensagens insuficientes para análise de desconexão', {
        level: 'info',
        extra: {
          channelId,
          messageCount: recentMessages?.length || 0,
          context: 'insufficient_messages_for_analysis'
        }
      });
      return false;
    }

    // Conta quantas das últimas mensagens falharam
    const failedCount = recentMessages.filter(msg => msg.status === 'failed').length;

    // Se 6 ou mais das últimas 8 mensagens falharam, desconecta o canal
    const shouldDisconnect = failedCount >= 6;

    if (shouldDisconnect) {
      Sentry.captureMessage('Canal deve ser desconectado devido a falhas consecutivas', {
        level: 'warning',
        extra: {
          channelId,
          failedCount,
          totalMessages: recentMessages.length,
          context: 'channel_disconnect_recommended'
        }
      });
    }

    return shouldDisconnect;
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId,
        context: 'checking_channel_failures'
      }
    });
    console.error('Erro ao verificar histórico de falhas do canal:', error);
    return false; // Em caso de erro na verificação, não desconecta
  }
}

/**
 * Marca um canal como desconectado após falhas consecutivas
 * 
 * Atualiza o status do canal para desconectado e registra informações sobre o erro
 * que causou a desconexão nas configurações do canal.
 * 
 * @param {string} channelId - ID do canal a ser desconectado
 * @param {string} errorMessage - Mensagem de erro que causou a desconexão
 */
async function disconnectChannel(channelId, errorMessage) {
  try {
    // Primeiro, busca o canal para obter as configurações atuais
    const { data: channelData, error: fetchError } = await supabase
      .from('chat_channels')
      .select('settings')
      .eq('id', channelId)
      .single();

    if (fetchError) {
      Sentry.captureException(fetchError, {
        extra: {
          channelId,
          context: 'fetching_channel_data'
        }
      });
      throw fetchError;
    }

    // Atualiza as configurações com as informações de erro
    const updatedSettings = {
      ...(channelData?.settings || {}),
      last_error: errorMessage,
      last_error_at: new Date().toISOString()
    };

    // Marca o canal como desconectado
    const { error: channelUpdateError } = await supabase
      .from('chat_channels')
      .update({
        is_connected: false,
        is_tested: false,
        settings: updatedSettings,
        updated_at: new Date().toISOString()
      })
      .eq('id', channelId);

    if (channelUpdateError) {
      Sentry.captureException(channelUpdateError, {
        extra: {
          channelId,
          errorMessage,
          context: 'updating_channel_status'
        }
      });
      console.error('Erro ao marcar canal como desconectado:', channelUpdateError);
    } else {
      Sentry.captureMessage('Canal marcado como desconectado', {
        level: 'warning',
        extra: {
          channelId,
          errorMessage,
          context: 'channel_disconnected'
        }
      });
      console.log(`Canal ${channelId} marcado como desconectado após falhas consecutivas.`);
    }
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId,
        errorMessage,
        context: 'disconnecting_channel'
      }
    });
    console.error('Erro ao desconectar canal:', error);
  }
}

/**
 * Envia uma mensagem do sistema através do canal apropriado
 * 
 * Processa o envio de mensagens geradas pelo sistema, incluindo tentativas
 * de reenvio em caso de falha. Suporta diferentes tipos de mensagens e anexos.
 * 
 * @param {string} messageId - ID da mensagem a ser enviada
 * @param {number} attempt - Número da tentativa atual (para retry)
 * @returns {Promise<Object>} - Resultado do envio com messageId externo
 */
export async function sendSystemMessage(messageId, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY = 4000; // 2 segundos entre tentativas

  try {
    // Busca a mensagem com dados do chat e do canal
    const { data: message, error: messageError } = await supabase
      .from('messages')
      .select(`
        *,
        chat:chats!messages_chat_id_fkey (
          external_id,
          channel:chat_channels!chats_channel_id_fkey (
            *,
            organization:organizations(*)
          )
        ),
        response_to:response_message_id(
          id,
          external_id
        )
      `)
      .eq('id', messageId)
      .single();

    if (messageError) {
      Sentry.captureException(messageError, {
        extra: {
          messageId,
          attempt,
          context: 'fetching_message_data'
        }
      });
      throw messageError;
    }

    const chat = message.chat;
    const channel = chat.channel;

    // Verifica se o canal está desconectado
    if (!channel.is_connected) {
      const errorMessage = 'Canal desconectado. Não é possível enviar mensagens.';

      // Atualiza status da mensagem para erro
      const { error: updateError } = await supabase
        .from('messages')
        .update({
          status: 'failed',
          error_message: errorMessage
        })
        .eq('id', messageId);

      if (updateError) {
        Sentry.captureException(updateError, {
          extra: {
            messageId,
            context: 'updating_message_status_disconnected_channel'
          }
        });
      }

      Sentry.captureMessage('Tentativa de envio em canal desconectado', {
        level: 'warning',
        extra: {
          messageId,
          channelId: channel.id,
          channelType: channel.type
        }
      });

      return {
        error: errorMessage,
        status: 'failed',
        messageId
      };
    }

    const channelConfig = CHANNEL_CONFIG[channel.type];
    if (!channelConfig) {
      Sentry.captureMessage('Handler não encontrado para tipo de canal', {
        level: 'error',
        extra: {
          messageId,
          channelType: channel.type,
          context: 'channel_handler_not_found'
        }
      });
      throw new Error(`Handler not found for channel type: ${channel.type}`);
    }

    if (!channelConfig.handler) {
      Sentry.captureMessage('Handler não implementado para tipo de canal', {
        level: 'error',
        extra: {
          messageId,
          channelType: channel.type,
          context: 'channel_handler_not_implemented'
        }
      });
      throw new Error(`Handler not implemented for channel type: ${channel.type}`);
    }

    // Usa o handler específico do canal
    const result = await channelConfig.handler(channel, {
      messageId: message.id,
      content: channelConfig.formatMessage ? channelConfig.formatMessage(message.content) : message.content,
      responseMessageId: message.response_to?.external_id ?? null,
      type: message.type,
      attachments: message.attachments,
      to: chat.external_id,
      chat_id: message.chat_id,
      sender_customer_id: message.sender_customer_id,
      sender_agent_id: message.sender_agent_id,
      list: message.metadata?.list ?? null
    });

    // Atualiza status da mensagem e external_id
    const { error: updateError } = await supabase
      .from('messages')
      .update({
        status: 'sent',
        external_id: result.messageId,
        error_message: null // Limpa mensagem de erro anterior se existir
      })
      .eq('id', message.id);

    if (updateError) {
      Sentry.captureException(updateError, {
        extra: {
          messageId: message.id,
          result,
          context: 'updating_message_status'
        }
      });
      throw updateError;
    }

    return result;

  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        messageId,
        attempt,
        context: 'sending_system_message'
      }
    });
    console.log(`Erro ao enviar mensagem (tentativa ${attempt}/${MAX_ATTEMPTS}):`, error);

    // Verifica se deve tentar novamente
    if (attempt < MAX_ATTEMPTS) {
      console.log(`Tentando novamente em ${RETRY_DELAY / 1000} segundos...`);

      // Atualiza status da mensagem para retry
      const { error: retryUpdateError } = await supabase
        .from('messages')
        .update({
          status: 'failed',
          error_message: `Tentativa ${attempt}/${MAX_ATTEMPTS} falhou: ${error.message}`
        })
        .eq('id', messageId);

      if (retryUpdateError) {
        Sentry.captureException(retryUpdateError, {
          extra: {
            messageId,
            attempt,
            context: 'updating_message_retry_status'
          }
        });
      }

      // Espera antes de tentar novamente
      return new Promise((resolve) => {
        setTimeout(() => {
          sendSystemMessage(messageId, attempt + 1)
            .then(resolve)
            .catch((retryError) => {
              // Em caso de erro na retry, resolve com o erro ao invés de rejeitar
              resolve({ error: retryError });
            });
        }, RETRY_DELAY);
      });
    }

    // Se chegou aqui, todas as tentativas falharam
    // Busca novamente a mensagem para obter o ID do canal
    const { data: failedMessage, error: fetchError } = await supabase
      .from('messages')
      .select(`
        chat:chats!messages_chat_id_fkey (
          channel_id
        )
      `)
      .eq('id', messageId)
      .single();

    if (fetchError) {
      Sentry.captureException(fetchError, {
        extra: {
          messageId,
          context: 'fetching_failed_message'
        }
      });
    }

    // Atualiza status da mensagem para erro
    const { error: finalUpdateError } = await supabase
      .from('messages')
      .update({
        status: 'failed',
        error_message: `Failed after ${MAX_ATTEMPTS} attempts. Last error: ${error.message}`
      })
      .eq('id', messageId);

    if (finalUpdateError) {
      Sentry.captureException(finalUpdateError, {
        extra: {
          messageId,
          context: 'updating_message_final_status'
        }
      });
    }

    // Verifica se deve desconectar o canal com base no histórico de falhas
    if (failedMessage && failedMessage.chat) {
      const channelId = failedMessage.chat.channel_id;
      const shouldDisconnect = await shouldDisconnectChannel(channelId);

      if (shouldDisconnect) {
        await disconnectChannel(channelId, error.message);
      }
    }

    // Retorna objeto com erro ao invés de lançar exceção
    return {
      error: error.message,
      status: 'failed',
      messageId
    };
  }
}

export async function createMessageRoute(req, res) {
  try {
    // Obter chatId e organizationId dos parâmetros da rota
    const { chatId, organizationId } = req.params;

    // Em requisições multipart/form-data, os campos de texto estão em req.body
    const content = req.body.content || null;
    const replyToMessageId = req.body.replyToMessageId || null;

    // Extrair o campo metadata se existir
    let metadata = null;
    if (req.body.metadata) {
      try {
        metadata = JSON.parse(req.body.metadata);
      } catch (e) {
        console.error('Erro ao fazer parse do metadata:', e);
      }
    }

    // Processar anexos de URL se existirem
    let urlAttachments = [];
    if (req.body.url_attachments) {
      // Pode haver múltiplos anexos URL
      const urlAttachmentsData = Array.isArray(req.body.url_attachments)
        ? req.body.url_attachments
        : [req.body.url_attachments];

      // Processar cada JSON de anexo URL
      for (const urlAttachmentJson of urlAttachmentsData) {
        try {
          const urlAttachment = JSON.parse(urlAttachmentJson);
          if (urlAttachment && urlAttachment.url) {
            urlAttachments.push({
              url: urlAttachment.url,
              type: urlAttachment.type || 'document',
              name: urlAttachment.name || 'attachment',
              mimetype: urlAttachment.type || null,
              size: null
            });
          }
        } catch (e) {
          console.error('Erro ao fazer parse de um url_attachment:', e);
        }
      }
    }

    const files = req.files || {};

    // Se houver anexos URL, adicioná-los como "arquivos"
    if (urlAttachments.length > 0) {
      if (!files.attachments) {
        files.attachments = [];
      } else if (!Array.isArray(files.attachments)) {
        files.attachments = [files.attachments];
      }

      // Adicionar cada anexo URL à lista de arquivos
      for (const urlAttachment of urlAttachments) {
        files.attachments.push(urlAttachment);
      }
    }

    const userId = req.profileId;
    const result = await createMessageToSend(chatId, organizationId, content, replyToMessageId, files, userId, metadata);
    return res.status(result.status).json(result);
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        chatId: req.params.chatId,
        organizationId: req.params.organizationId,
        context: 'create_message_route'
      }
    });
    console.error('Error creating message:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

export async function createMessageToSend(chatId, organizationId, content, replyToMessageId, files, userId, metadata) {
  try {
    // Validar se o chat pertence à organização e obter informações do canal
    const { data: chatData, error: chatError } = await supabase
      .from('chats')
      .select(`
        id, 
        organization_id,
        channel_id,
        channel_details:channel_id (
          id,
          type,
          settings
        )
      `)
      .eq('id', chatId)
      .eq('organization_id', organizationId)
      .single();

    if (chatError) {
      Sentry.captureException(chatError, {
        extra: {
          chatId,
          organizationId,
          context: 'fetching_chat_data'
        }
      });
      return {
        status: 404,
        success: false,
        error: 'Chat not found or permission denied'
      };
    }

    if (!chatData) {
      Sentry.captureMessage('Chat not found', {
        level: 'warning',
        extra: {
          chatId,
          organizationId,
          context: 'chat_not_found'
        }
      });
      return {
        status: 404,
        success: false,
        error: 'Chat not found or permission denied'
      };
    }

    // Verificar o tipo de canal
    const channelType = chatData.channel_details?.type || 'email';
    const channelConfig = CHANNEL_CONFIG[channelType] || {};
    const isSocialChannel = [
      'whatsapp_official',
      'whatsapp_wapi',
      'whatsapp_zapi',
      'whatsapp_evo',
      'instagram',
      'facebook'
    ].includes(channelType);


    // Se houver userId e uma assinatura de mensagem configurada no canal, processar a assinatura
    let processedContent = content;
    if (userId && chatData.channel_details?.settings?.messageSignature && content) {
      try {
        // Buscar os dados do perfil do usuário
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('nickname')
          .eq('id', userId)
          .single();

        if (!profileError && profile && profile.nickname) {
          const signature = chatData.channel_details.settings.messageSignature;

          // Substituir {{nickname}} pelo nickname do agente
          let formattedSignature = signature.replace(/{{nickname}}/g, profile.nickname);

          // Verificar se a assinatura contém {{contentMessage}}
          if (formattedSignature.includes('{{contentMessage}}')) {
            // Substituir {{contentMessage}} pelo conteúdo original
            processedContent = formattedSignature.replace(/{{contentMessage}}/g, content);
          } else {
            // Adicionar a assinatura após o conteúdo
            processedContent = content + '\n\n' + formattedSignature;
          }
        }
      } catch (signatureError) {
        Sentry.captureException(signatureError, {
          extra: {
            userId,
            channelId: chatData.channel_id,
            context: 'processing_message_signature'
          }
        });
        console.error('Erro ao processar assinatura da mensagem:', signatureError);
        // Em caso de erro, usa o conteúdo original
      }
    }

    // Preparar anexos
    const attachments = [];
    const fileRecords = [];
    const messages = [];

    // Verificar se há arquivos para processar
    const hasFiles = files && files.attachments;

    // Processar uploads de arquivos
    // console.log('hasFiles', hasFiles);
    if (hasFiles) {
      const uploadPromises = Array.isArray(files.attachments)
        ? files.attachments
        : [files.attachments];
      // console.log('uploadPromises', uploadPromises);

      for (const file of uploadPromises) {
        let uploadResult;
        // Usar a função uploadFile para processar o arquivo
        if (file.url) {
          // console.log('file', file);
          uploadResult = {
            attachment: {
              url: file.url,
              type: file.type ?? file.mimetype ?? 'document',
              file_name: file.name ?? file.filename ?? 'attachment',
              mime_type: file.mimetype ?? null,
              file_size: file.size ?? null
            }
          }
        } else {
          uploadResult = await uploadFile({
            fileData: file.data,
            fileName: file.name,
            contentType: file.mimetype,
            fileSize: file.size,
            organizationId,
            customFolder: 'chat-attachments',
            chatId: chatId
          });

          if (!uploadResult.success) {
            throw new Error(`Error uploading file: ${uploadResult.error}`);
          }
        }

        // Para canais sociais, cada arquivo é uma mensagem separada
        if (isSocialChannel) {
          // Determinar o tipo de mensagem com base no tipo de arquivo
          let messageType = 'document';
          if (uploadResult.attachment.type === 'image') messageType = 'image';
          if (uploadResult.attachment.type === 'video') messageType = 'video';
          if (uploadResult.attachment.type === 'audio') messageType = 'audio';

          messages.push({
            chat_id: chatId,
            organization_id: organizationId,
            sender_agent_id: userId ?? null,
            sender_type: 'agent',
            content: null, // Sem conteúdo de texto
            type: messageType,
            response_message_id: replyToMessageId ?? null,
            attachments: [uploadResult.attachment],
            status: 'pending',
            created_at: new Date().toISOString(),
            metadata: metadata ?? null
          });
        } else {
          // Para email, adicionar à lista de anexos
          attachments.push(uploadResult.attachment);
        }
        if (!file.url) {
          // Adicionar o registro do arquivo para inserção posterior
          fileRecords.push(uploadResult.fileRecord);
        }
      }
    }

    // Adicionar mensagem de texto
    if (processedContent) {
      // Aplicar formatação específica do canal se disponível
      // const formattedContent = channelConfig.formatMessage ? channelConfig.formatMessage(content) : content;
      const formattedContent = processedContent;

      if (isSocialChannel && hasFiles) {
        // Para canais sociais com arquivos, adicionar mensagem de texto separada
        messages.push({
          chat_id: chatId,
          organization_id: organizationId,
          sender_agent_id: userId,
          sender_type: 'agent',
          content: formattedContent,
          type: 'text',
          response_message_id: replyToMessageId ?? null,
          attachments: [],
          status: 'pending',
          created_at: new Date().toISOString(),
          metadata: metadata ?? null
        });
      } else if (!isSocialChannel && hasFiles) {
        // Para email com arquivos, uma única mensagem com todos os anexos
        messages.push({
          chat_id: chatId,
          organization_id: organizationId,
          sender_agent_id: userId,
          sender_type: 'agent',
          content: formattedContent,
          type: 'email',
          response_message_id: replyToMessageId ?? null,
          attachments: attachments,
          status: 'pending',
          created_at: new Date().toISOString(),
          metadata: metadata ?? null
        });
      } else {
        // Apenas texto para qualquer tipo de canal
        messages.push({
          chat_id: chatId,
          organization_id: organizationId,
          sender_agent_id: userId,
          sender_type: 'agent',
          content: formattedContent,
          type: isSocialChannel ? 'text' : 'email',
          response_message_id: replyToMessageId ?? null,
          attachments: [],
          status: 'pending',
          created_at: new Date().toISOString(),
          metadata: metadata ?? null
        });
      }
    } else if (!hasFiles) {
      // Se não há conteúdo nem arquivos
      return {
        status: 400,
        success: false,
        error: 'No content or attachments provided'
      }

    } else if (!isSocialChannel && !processedContent && hasFiles) {
      // Para email sem texto, mas com anexos
      messages.push({
        chat_id: chatId,
        organization_id: organizationId,
        sender_agent_id: userId,
        sender_type: 'agent',
        content: null,
        type: 'email',
        response_message_id: replyToMessageId ?? null,
        attachments: attachments,
        status: 'pending',
        created_at: new Date().toISOString(),
        metadata: metadata ?? null
      });
    }

    // Se não houver mensagens para inserir (caso raro)
    if (messages.length === 0) {
      return {
        status: 400,
        success: false,
        error: 'No content or attachments provided'
      }
    }

    // Inserir mensagens no banco
    const messagesData = [];

    // Cadastrar e enviar mensagens uma por uma
    for (const message of messages) {
      try {
        const { data: messageData, error: messageError } = await supabase
          .from('messages')
          .insert(message)
          .select('*')
          .single();

        if (messageError) {
          Sentry.captureException(messageError, {
            extra: {
              chatId,
              organizationId,
              message,
              context: 'inserting_single_message'
            }
          });
          console.error('Erro ao criar mensagem:', messageError);
          continue;
        }

        messagesData.push(messageData);

        // Se a mensagem tem anexos, registrar os arquivos
        if (message.attachments && message.attachments.length > 0 && fileRecords.length > 0) {
          // Encontrar os fileRecords correspondentes a esta mensagem
          const messageFileRecords = fileRecords.filter(record => {
            const attachment = message.attachments.find(att => att.name === record.name);
            return attachment !== undefined;
          });

          if (messageFileRecords.length > 0) {
            // Atualizar o message_id dos arquivos
            const updatedFileRecords = messageFileRecords.map(record => ({
              ...record,
              message_id: messageData.id
            }));

            // Inserir os registros de arquivo
            const { error: filesError } = await supabase
              .from('files')
              .upsert(updatedFileRecords, {
                onConflict: 'id',
                ignoreDuplicates: true
              });

            if (filesError) {
              Sentry.captureException(filesError, {
                extra: {
                  messageId: messageData.id,
                  fileRecords: updatedFileRecords,
                  context: 'inserting_message_files'
                }
              });
              console.error('Erro ao registrar arquivos da mensagem:', filesError);
            } else {
              // console.log(`[Arquivos] ${updatedFileRecords.length} arquivos registrados para a mensagem ${messageData.id}`);
            }
          }
        }

        // Atualiza o last_message_id do chat
        await supabase
          .from('chats')
          .update({
            last_message_id: messageData.id,
            last_message_at: new Date().toISOString()
          })
          .eq('id', chatId);

        // Envia a mensagem imediatamente após cadastro, não espera o resultado
        await sendSystemMessage(messageData.id);
      } catch (error) {
        Sentry.captureException(error, {
          extra: {
            chatId,
            organizationId,
            message,
            context: 'processing_single_message'
          }
        });
        console.error('Erro ao processar mensagem:', error);
      }
    }

    if (messagesData.length === 0) {
      return {
        status: 500,
        success: false,
        error: 'Error creating messages'
      };
    }

    // Atualiza o last_message_id do chat apos os envios
    const lastMessage = messagesData[messagesData.length - 1];

    if (lastMessage) {
      await supabase
        .from('chats')
        .update({
          unread_count: 0,
          last_message_id: lastMessage.id,
          last_message_at: new Date().toISOString()
        })
        .eq('id', chatId);
    }

    return {
      status: 201,
      success: true,
      messages: messagesData
    };
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        chatId,
        organizationId,
        content,
        replyToMessageId,
        userId,
        context: 'create_message_to_send'
      }
    });
    console.error('Erro no createMessageRoute:', error);
    return {
      status: 500,
      success: false,
      error: 'Internal server error'
    }
  }
}

/**
 * Busca uma integração OpenAI ativa para a organização
 * @param {string} organizationId - ID da organização
 * @returns {Promise<{api_key: string} | null>} - Credenciais da integração ou null
 */
async function getActiveOpenAIIntegration(organizationId) {
  try {
    const { data: integration, error } = await supabase
      .from('integrations')
      .select('credentials')
      .eq('organization_id', organizationId)
      .eq('type', 'openai')
      .eq('status', 'active')
      .maybeSingle();

    if (error) throw error;
    if (!integration) return null;

    // Descriptografar a chave API
    const apiKey = decrypt(integration.credentials.api_key);
    return { api_key: apiKey };
  } catch (error) {
    console.error('Erro ao buscar integração OpenAI:', error);
    Sentry.captureException(error, {
      extra: {
        organizationId,
        context: 'get_openai_integration'
      }
    });
    return null;
  }
}

/**
 * Faz a transcrição de um arquivo de áudio usando a API da OpenAI
 * @param {string} audioUrl - URL do arquivo de áudio
 * @param {string} apiKey - Chave API da OpenAI
 * @param {string} mimeType - Tipo MIME do arquivo de áudio
 * @returns {Promise<string>} - Texto transcrito
 */
async function transcribeAudio(audioUrl, apiKey, mimeType = 'audio/ogg; codecs=opus') {
  try {
    // Baixar o arquivo de áudio
    const audioBuffer = await downloadFileFromUrl(audioUrl);

    // Criar um FormData para enviar o arquivo
    const formData = new FormData();

    // Determinar a extensão do arquivo baseado no mime_type
    let fileExtension = 'ogg';
    if (mimeType.includes('mp3')) {
      fileExtension = 'mp3';
    } else if (mimeType.includes('wav')) {
      fileExtension = 'wav';
    } else if (mimeType.includes('m4a')) {
      fileExtension = 'm4a';
    }

    // Adicionar o arquivo e os parâmetros conforme a documentação da OpenAI
    formData.append('file', audioBuffer, {
      filename: `audio.${fileExtension}`,
      contentType: mimeType
    });
    formData.append('model', 'whisper-1');
    // formData.append('language', 'pt');
    formData.append('response_format', 'json');
    formData.append('temperature', 0);

    // Fazer a requisição para a API da OpenAI
    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          ...formData.getHeaders()
        }
      }
    );

    return response.data.text;
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        audioUrl,
        mimeType,
        error: error.response?.data || error.message,
        context: 'transcribe_audio'
      }
    });
    console.error('Erro ao transcrever áudio:', error.message);
    return null; // Retorna null em caso de erro para não travar o código
  }
}

export async function deleteMessageRoute(req, res) {
  try {
    const { chatId, messageId } = req.params;
    const { user } = req;

    if (!messageId) {
      return res.status(400).json({ error: 'messageId é obrigatório' });
    }

    const { data: message, error: messageError } = await supabase
      .from('messages')
      .select(`
        *,
        chat:chats!messages_chat_id_fkey (
          external_id,
          metadata,
          last_message_id,
          channel:chat_channels!chats_channel_id_fkey (*)
        )
      `)
      .eq('id', messageId)
      .eq('chat_id', chatId)
      .single();

    if (messageError) {
      throw messageError;
    }

    if (!message) {
      return res.status(404).json({ error: 'Mensagem não encontrada' });
    }

    // Marca a mensagem como deletada
    const { error: updateError } = await supabase
      .from('messages')
      .update({ status: 'deleted' })
      .eq('id', messageId);

    if (updateError) {
      throw updateError;
    }

    
    // Se a mensagem deletada for a última mensagem do chat
    if (message.chat.last_message_id === messageId) {
      // Busca a mensagem anterior não deletada

       // Prepara metadata do chat com a última reação
       const updatedChatMetadata = {
        ...(message.chat.metadata || {}),
        last_message: {
          type: 'deleted',
          timestamp: new Date().toISOString(),
          message_id: message.id
        }
      };

      // Atualiza o last_message_id do chat
      const { error: chatUpdateError } = await supabase
        .from('chats')
        .update({ 
          last_message_id: null,
          last_message_at: new Date().toISOString(),
          metadata: updatedChatMetadata
        })
        .eq('id', chatId);

      if (chatUpdateError) {
        console.error('Erro ao atualizar o chat:', chatUpdateError);
        throw chatUpdateError;
      }
    }

    // Se a mensagem tiver um external_id e o canal suportar deleção de mensagens
    if (message.external_id && message.chat?.channel) {
      try {
        await handleChannelDeletion(message.chat.channel, {
          id: message.id,
          externalId: message.external_id,
          to: message.chat.external_id
        });
      } catch (deleteError) {
        console.error('Erro ao deletar mensagem no canal:', deleteError);
        // Não falha a operação se a deleção no canal falhar
        // Apenas registra o erro no Sentry
        Sentry.captureException(deleteError, {
          extra: {
            messageId: message.id,
            externalId: message.external_id,
            channelId: message.chat.channel.id,
            context: 'deleting_message_in_channel'
          }
        });
      }
    } else {
      //Deletar a mensagem, pois está apenas no nosso banco de dados
      const { error: deleteError } = await supabase
        .from('messages')
        .delete()
        .eq('id', messageId);

      if (deleteError) {
        throw deleteError;
      }
    }

    return res.status(200).json({ message: 'Mensagem deletada com sucesso' });
  } catch (error) {
    Sentry.captureException(error);
    return res.status(500).json({ error: 'Erro ao deletar mensagem' });
  }
}

/**
 * Verifica e executa o handler de exclusão do canal se existir
 * @param {Object} channel - Canal a ser excluído
 * @param {Object} messageData - Dados da mensagem (id, externalId, to)
 * @returns {Promise<boolean>} - True se o handler foi executado, false caso contrário
 */
export async function handleChannelDeletion(channel, messageData) {
  const channelConfig = CHANNEL_CONFIG[channel.type];
  // console.log(channelConfig?.deleteHandler)

  if (!channelConfig?.deleteHandler) {
    return true;
  }

  try {
    await channelConfig.deleteHandler(channel, messageData);
    return true;
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id,
        channelType: channel.type
      }
    });
    throw error;
  }
}

export async function updateMessageRoute(req, res) {
  try {
    const { chatId, messageId, organizationId } = req.params;
    const { content } = req.body;

    // Validação básica
    if (!content || !content.trim()) {
      return res.status(400).json({
        error: 'Content is required',
        message: 'O conteúdo da mensagem é obrigatório'
      });
    }

    // Verificar se a mensagem existe e pertence à organização
    const { data: existingMessage, error: findError } = await supabase
      .from('messages')
      .select(`
        *,
        chat:chats!messages_chat_id_fkey!inner(
          organization_id,
          id,
          external_id,
          channel:chat_channels!chats_channel_id_fkey (
            *
          )
        )
      `)
      .eq('id', messageId)
      .eq('chats.id', chatId)
      .eq('chats.organization_id', organizationId)
      .single();

    if (findError || !existingMessage) {
      return res.status(404).json({
        error: 'Message not found',
        message: findError || 'Mensagem não encontrada'
      });
    }

    // Verificar se a mensagem pode ser editada (apenas mensagens de texto enviadas pelos usuários)
    if (existingMessage.type !== 'text' || existingMessage.sender_type !== 'agent') {
      return res.status(400).json({
        error: 'Message cannot be edited',
        message: 'Esta mensagem não pode ser editada'
      });
    }

    if(!existingMessage.chat.channel){
      return res.status(400).json({
        error: 'Channel not found',
        message: 'Canal não encontrado'
      });
    }

    // Verificar limite de tempo para edição (15 minutos)
    const messageTime = new Date(existingMessage.created_at);
    const currentTime = new Date();
    const timeDifference = currentTime - messageTime;
    const fifteenMinutes = 15 * 60 * 1000; // 15 minutos em milissegundos

    if (timeDifference > fifteenMinutes) {
      return res.status(400).json({
        error: 'Edit time expired',
        message: 'O tempo limite para editar esta mensagem expirou'
      });
    }

    //Verificar se o canal suporta edição de mensagens
    const channelConfig = CHANNEL_CONFIG[existingMessage.chat.channel.type];
    if (!channelConfig?.updateHandler) {
      return res.status(400).json({
        error: 'Channel does not support message editing',
        message: 'Este canal não suporta edição de mensagens'
      });
    }

    if(!existingMessage.chat.external_id) {
      return res.status(400).json({
        error: 'Channel does not support message editing',
        message: 'Este canal não suporta edição de mensagens'
      });
    }

    try {
        //Atualizar a mensagem no canal
      const response = await channelConfig.updateHandler(existingMessage.chat.channel, existingMessage.chat.external_id, existingMessage.external_id, content.trim());
      res.json({
        success: true,
        message: 'Mensagem atualizada com sucesso'
      });
    } catch (error) {
      Sentry.captureException(error, {
        extra: {
          organizationId: req.user?.organizationId,
          chatId: req.params?.chatId,
          messageId: req.params?.messageId
        }
      });
      return res.status(500).json({
        error: 'Failed to update message',
        message: `${JSON.stringify(error)}`
      });
    }

    // // Atualizar a mensagem
    // const { data: updatedMessage, error: updateError } = await supabase
    //   .from('messages')
    //   .update({
    //     content: content.trim(),
    //     edited_at: new Date().toISOString(),
    //     updated_at: new Date().toISOString()
    //   })
    //   .eq('id', messageId)
    //   .select('*')
    //   .single();

    // if (updateError) {
    //   console.error('Erro ao atualizar mensagem:', updateError);
    //   return res.status(500).json({
    //     error: 'Failed to update message',
    //     message: 'Erro interno do servidor ao atualizar mensagem'
    //   });
    // }

    

  } catch (error) {
    console.error('Erro na função updateMessageRoute:', error);
    Sentry.captureException(error, {
      extra: { 
        organizationId: req.user?.organizationId,
        chatId: req.params?.chatId,
        messageId: req.params?.messageId
      }
    });

    res.status(500).json({
      error: 'Internal server error',
      message: 'Erro interno do servidor'
    });
  }
}


/**
 * Função para atualizar uma mensagem editada pela api do canal
 * @param {*} channel 
 * @param {*} originalMessageId 
 * @param {*} newContent 
 * @returns 
 */
export async function handleUpdateEditedMessage(channel, originalMessageId, newContent) {
  try {
    // Verifica se existe a estrutura de protocolo de mensagem editada
    if (!originalMessageId || !newContent) {
      console.error('Dados insuficientes para processar mensagem editada V2025.1:', {
        originalMessageId,
        newContent
      });
      return;
    }

    // Busca a mensagem usando uma query mais robusta
    const { data: message, error: findError } = await supabase
      .from('messages')
      .select(`
        id,
        external_id,
        content,
        chat_id,
        organization_id,
        metadata,
        chat:chats!messages_chat_id_fkey!inner (
          channel_id
        )
      `)
      .eq('external_id', originalMessageId)
      .eq('chat.channel_id', channel.id)
      .single();

    if (findError) {
      console.error('Mensagem não encontrada para edição:', originalMessageId, findError);
      Sentry.captureException(findError, {
        extra: {
          channelId: channel.id,
          originalMessageId,
          context: 'find_message_for_edit_v2025_1'
        }
      });
      return;
    }

    if (message) {
      // Formata o conteúdo usando o mesmo formatador das mensagens recebidas
      const formattedContent = formatWhatsAppToMarkdown(newContent);

      // Prepara os metadados atualizados com informações da edição
      const updatedMetadata = {
        ...(message.metadata || {}),
        edited: true,
        editedAt: new Date().toISOString(),
        previousContent: message.content
      };

      // Atualiza a mensagem com o novo conteúdo e metadados
      const { error: updateError } = await supabase
        .from('messages')
        .update({
          content: formattedContent,
          metadata: updatedMetadata
        })
        .eq('id', message.id);

      if (updateError) {
        console.error('Erro ao atualizar mensagem editada:', updateError);
        Sentry.captureException(updateError, {
          extra: {
            messageId: message.id,
            originalMessageId,
            newContent: formattedContent,
            context: 'updating_message_edited_v2025_1'
          }
        });
      } else {
        // Atualiza o timestamp da última atividade no chat
        const { error: updateChatError } = await supabase
          .from('chats')
          .update({
            last_message_at: new Date().toISOString()
          })
          .eq('id', message.chat_id);

        if (updateChatError) {
          console.error('Erro ao atualizar timestamp do chat:', updateChatError);
          Sentry.captureException(updateChatError, {
            extra: {
              chatId: message.chat_id,
              context: 'updating_chat_timestamp_after_edit_v2025_1'
            }
          });
        }
      }
    } else {
      console.warn(`Mensagem ${originalMessageId} não encontrada no banco de dados para ser editada`);
    }
  } catch (error) {
    console.error('Erro ao processar mensagem editada V2025.1:', error);
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id,
        context: 'handle_update_edited_message_v2025_1'
      }
    });
  }
}

/**
 * Atualiza o status de uma mensagem para "deleted" quando recebido evento de mensagem apagada de uma api do canal
 * @param {*} channel - Canal de comunicação
 * @param {*} messageId - ID da mensagem apagada
 * @returns 
 */
export async function handleUpdateDeletedMessage(channel, messageId) {

  if(!channel) {
    console.error('Canal não encontrado para mensagem apagada');
    return;
  }

  if (!messageId) {
    console.error('ID da mensagem não encontrado para mensagem apagada');
    return;
  }

  // Encontra a mensagem pelo ID externo
  const { data: message, error: findError } = await supabase
    .from('messages')
    .select(`
        id,
        organization_id,
        chat_id,
        content,
        metadata,
        chat:chat_id (
          channel_id,
          metadata,
          unread_count
        )
      `)
    .eq('external_id', messageId)
    .eq('chat.channel_id', channel.id)
    .single();

  if (findError) {
    console.error('Erro ao buscar mensagem para atualizar status de apagada:', findError);
    return;
  }

  if (message) {
    // Prepara os metadados atualizados
    const updatedMetadata = {
      ...(message.metadata || {}),
      deleted: true,
      deletedAt: new Date().toISOString(),
      previousContent: message.content
    };

    // Atualiza o status e metadados da mensagem
    const { error: updateError } = await supabase
      .from('messages')
      .update({
        status: 'deleted',
        metadata: updatedMetadata
      })
      .eq('id', message.id);

    if (updateError) {
      Sentry.captureException(updateError, {
        extra: {
          messageId: message.id,
          context: 'updating_deleted_message_status'
        }
      });
    }

    // Prepara metadata do chat com a última reação
    const updatedChatMetadata = {
      ...(message.chat.metadata || {}),
      last_message: {
        type: 'deleted',
        timestamp: new Date().toISOString(),
        message_id: message.id
      }
    };

    // Atualiza o timestamp do último contato no chat
    const { error: updateChatError } = await supabase
      .from('chats')
      .update({
        last_message_id: null,
        last_message_at: new Date().toISOString(),
        metadata: updatedChatMetadata,
        unread_count: (message.chat.unread_count ? message.chat.unread_count - 1 : 0)
      })
      .eq('id', message.chat_id);

    if (updateChatError) {
      Sentry.captureException(updateChatError, {
        extra: {
          chatId: message.chat_id,
          context: 'updating_chat_after_deleted_message'
        }
      });
    }
  }
}


/**
 * Atualiza uma mensagem com uma reação
 * @param {Object} channel - Canal de comunicação
 * @param {String} messageExternalId - ID da mensagem referenciada
 * @param {String} reaction - Reação
 * @param {String} senderId - ID do remetente
 * @param {String} senderName - Nome do remetente
 * @param {String} senderProfilePicture - URL da imagem do perfil do remetente
 */
export async function handleUpdateMessageReaction(channel, messageExternalId, reaction, senderId, senderName, senderProfilePicture) {
  try {
    // Verifica se existe a estrutura de reação e ID da mensagem referenciada
    if (!messageExternalId) {
      console.error('ID da mensagem referenciada não encontrado para reação V2025.1');
      return;
    }

    if(!reaction) {
      console.error('Reação não encontrada para atualização');
      return;
    }

    if(!senderId) {
      senderId = 'unknown_sender';
    }

    const { data: message, error: findError } = await supabase
      .from('messages')
      .select(`
          id,
          organization_id,
          chat_id,
          metadata,
          content,
          type,
          chat:chat_id (
            channel_id
          )
        `)
      .eq('external_id', messageExternalId)
      .eq('chat.channel_id', channel.id)
      .single();

    if (findError) {
      console.error('Erro ao buscar mensagem para reação V2025.1:', findError);
      Sentry.captureException(findError, {
        extra: {
          messageExternalId,
          channelId: channel.id,
          messageExternalId,
          context: 'find_message_for_reaction_v2025_1'
        }
      });
      return;
    }

    if (message) {
      // Prepara os metadados atualizados com a reação
      const updatedMetadata = {
        ...(message.metadata || {}),
        reactions: {
          ...(message.metadata?.reactions || {}),
          [senderId]: {
            reaction: reaction,
            timestamp: new Date().toISOString(),
            senderName: senderName || null,
            senderProfilePicture: senderProfilePicture || null
          }
        }
      };

      // Atualiza os metadados da mensagem
      const { error: updateError } = await supabase
        .from('messages')
        .update({
          metadata: updatedMetadata
        })
        .eq('id', message.id);

      if (updateError) {
        Sentry.captureException(updateError, {
          extra: {
            messageId: message.id,
            context: 'updating_message_reaction_v2025_1'
          }
        });
      }

      // Atualiza o timestamp do último contato no chat
      const { data: chatData, error: getChatError } = await supabase
        .from('chats')
        .select('metadata')
        .eq('id', message.chat_id)
        .single();

      if (!getChatError && chatData) {
        // Prepara metadata do chat com a última reação
        const updatedChatMetadata = {
          ...(chatData.metadata || {}),
          last_message: {
            type: 'reaction',
            reaction: reaction,
            timestamp: new Date().toISOString(),
            senderName: senderName,
            senderProfilePicture: senderProfilePicture,
            message_id: message.id,
            message_content: message.content,
            message_type: message.type
          }
        };

        const { error: updateChatError } = await supabase
          .from('chats')
          .update({
            last_message_at: new Date().toISOString(),
            last_message_id: null,
            metadata: updatedChatMetadata
          })
          .eq('id', message.chat_id);

        if (updateChatError) {
          Sentry.captureException(updateChatError, {
            extra: {
              chatId: message.chat_id,
              context: 'updating_chat_reaction_v2025_1'
            }
          });
        }
      }
    }
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id,
        context: 'handle_update_message_reaction_v2025_1'
      }
    });
    console.error('Erro ao processar reação V2025.1:', error);
  }
}