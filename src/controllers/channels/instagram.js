import { handleIncomingMessage, handleStatusUpdate } from '../chat/message-handlers.js';
import { validateChannel } from '../webhooks/utils.js';
import { encrypt, decrypt } from '../../utils/crypto.js';
import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';

async function getInstagramUserInfo(userId, accessToken) {
  try {
    const response = await fetch(
      `https://graph.instagram.com/v21.0/${userId}?fields=name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user&access_token=${accessToken}`
    );

    if (!response.ok) {
      const errorData = await response.json();

      // Tentar alternativa usando a API do Facebook com campos padrão do perfil público
      const fbResponse = await fetch(
        `https://graph.facebook.com/v22.0/${userId}?fields=id,first_name,last_name,middle_name,name,name_format,picture,short_name,email,gender,link,locale,timezone,updated_time,verified&access_token=${accessToken}`
      );

      if (!fbResponse.ok) {
        const fbErrorData = await fbResponse.json();
        throw new Error(`Facebook API error: ${fbResponse.status} - ${JSON.stringify(fbErrorData)}`);
      }

      const fbData = await fbResponse.json();
      
      // Adaptar os dados do Facebook para o formato esperado pelo Instagram
      return {
        id: fbData.id,
        name: fbData.name,
        username: fbData.short_name || fbData.name,
        profile_pic: fbData.picture?.data?.url,
        follower_count: null,
        is_user_follow_business: null,
        is_business_follow_user: null
      };
    }

    const data = await response.json();
    return data;
  } catch (error) {
    Sentry.captureException(error);
    return null;
  }
}

async function findOrCreateChat(channel, externalId, accessToken, isEcho = false) {
  try {
    // Buscar chat existente
    const { data: chats } = await supabase
      .from('chats')
      .select('*, customers(*)')
      .eq('channel_id', channel.id)
      .in('status', ['in_progress', 'pending'])
      .eq('external_id', externalId)
      .order('created_at', { ascending: false })
      .limit(1);

    const existingChat = chats?.[0];

    // Se for echo, apenas retorna o chat existente
    if (isEcho) {
      if (!existingChat) {
        console.log('Chat não encontrado para mensagem echo', channel.id, externalId);
        throw new Error('Chat não encontrado para mensagem echo');
      }
      return existingChat;
    }

    let userInfo = null;

    // Verificar se precisa buscar informações do usuário
    if (!existingChat || 
        !existingChat.profile_picture ||
        new Date(existingChat.profile_updated_at || 0) < new Date(Date.now() - 24 * 60 * 60 * 1000)) {
      userInfo = await getInstagramUserInfo(externalId, accessToken);
    }

    if (existingChat) {
      const customer = existingChat.customers;

      // Atualizar informações se tiver dados novos do usuário
      if (userInfo) {
        await Promise.all([
          supabase
            .from('chats')
            .update({
              profile_picture: userInfo.profile_pic || existingChat.profile_picture,
              profile_updated_at: new Date().toISOString(),
              last_customer_message_at: new Date().toISOString()
            })
            .eq('id', existingChat.id),
          
          supabase
            .from('customers')
            .update({
              name: userInfo.name || customer.name,
              profile_picture: userInfo.profile_pic || customer.profile_picture
            })
            .eq('id', customer.id)
        ]);
      } else {
        // Mesmo sem novas informações do usuário, atualizar a data da última mensagem
        await supabase
          .from('chats')
          .update({
            last_customer_message_at: new Date().toISOString()
          })
          .eq('id', existingChat.id);
      }

      return existingChat;
    }

    //Pesquisar se o customer existe com o instagramId
    const { data: instagramContact } = await supabase
      .from('customer_contacts')
      .select('*')
      .eq('type', 'instagramId')
      .eq('value', externalId)
      .eq('organization_id', channel.organization_id)
      .single();

    if (instagramContact) {
      // Buscar o time padrão da organização
      const { data: defaultTeam } = await supabase
        .from('service_teams')
        .select('id')
        .eq('organization_id', channel.organization_id)
        .eq('is_default', true)
        .single();

      //Cadastra chat com o customer existente
      let { data: newChat, error: newChatError } = await supabase
        .from('chats')
        .insert({
          organization_id: channel.organization_id,
          customer_id: instagramContact.customer_id,
          channel_id: channel.id,
          status: 'pending',
          team_id: defaultTeam?.id || null,
          profile_picture: userInfo?.profile_pic || null,
          profile_updated_at: new Date().toISOString(),
          last_customer_message_at: new Date().toISOString()
        })
        .select('*, customers(*)')
        .single();
      newChat.is_first_message = true;
      return newChat;
    }

    // Buscar o time padrão da organização
    const { data: defaultTeam } = await supabase
      .from('service_teams')
      .select('id')
      .eq('organization_id', channel.organization_id)
      .eq('is_default', true)
      .single();

    // Criar novo customer com foto de perfil
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .insert({
        organization_id: channel.organization_id,
        name: userInfo?.name || externalId,
        profile_picture: userInfo?.profile_pic || null
      })
      .select()
      .single();

    // Adicionar contato do Instagram para o novo cliente
    await supabase
      .from('customer_contacts')
      .insert({
        customer_id: customer.id,
        type: 'instagramId',
        value: externalId,
        created_at: new Date().toISOString()
      });

    // Criar novo chat com a mesma foto de perfil e data da última mensagem
    let { data: chat, error: chatError } = await supabase
      .from('chats')
      .insert({
        organization_id: channel.organization_id,
        customer_id: customer.id,
        channel_id: channel.id,
        external_id: externalId,
        status: 'pending',
        team_id: defaultTeam?.id || null,
        profile_picture: userInfo?.profile_pic || null,
        profile_updated_at: new Date().toISOString(),
        last_customer_message_at: new Date().toISOString()
      })
      .select('*, customers(*)')
      .single();

    if (chatError) throw chatError;

    chat.is_first_message = true;
    return chat;
  } catch (error) {
    console.error('Erro ao criar/buscar chat:', error);
    Sentry.captureException(error);
    throw error;
  }
}

export async function handleInstagramWebhook(req, res) {
  const webhookData = req.body;

  console.log('🔍 Webhook recebido:', webhookData);

  try {
    if (!webhookData?.entry?.length || !webhookData.entry[0]?.messaging?.length) {
      console.log('❌ Estrutura do webhook inválida');
      return res.status(400).json({ error: 'Invalid webhook structure' });
    }

    for (const entry of webhookData.entry) {
      for (const messagingData of entry.messaging) {
        console.log('🔍 Dados da mensagem:', messagingData);
        if (!messagingData?.recipient?.id || !messagingData?.sender?.id) {
          console.log('⚠️ Dados de mensagem incompletos:', messagingData);
          continue;
        }

        // console.log('Dados da mensagem:', messagingData);

        try {
          // Verificar se é uma mensagem echo (enviada pelo sistema)
          const isEcho = messagingData.message?.is_echo === true;
          const isRead = messagingData.read !== undefined;
          const channelId = isEcho ? messagingData.sender.id : messagingData.recipient.id;
          const chatExternalId = isEcho ? messagingData.recipient.id : messagingData.sender.id;

          // console.log('🔍 Buscando canal para channel_id:', channelId);
          const { data: dataChannel, error: errorChannel } = await supabase
            .from('chat_channels')
            .select('*, organization:organizations(*)')
            .eq('type', 'instagram')
            .eq('status', 'active')
            .eq('external_id', channelId)
            .order('created_at', { ascending: false })
            .limit(1);

          if (errorChannel) {
            console.error('❌ Erro ao buscar canal:', errorChannel);
            Sentry.captureException(errorChannel);
            continue;
          }

          if (!dataChannel.length) {
            console.log('❌ Canal não encontrado para channel_id:', channelId);
            continue;
          }
          const channel = dataChannel[0];
          // console.log('✅ Canal encontrado:', channel.id);

          // Se for uma atualização de status de leitura
          if (isRead) {
            // console.log('👀 Processando atualização de status de leitura:', messagingData.read);
            await handleStatusUpdate(channel, {
              messageId: messagingData.read.mid,
              status: 'read',
              timestamp: messagingData.timestamp || Date.now(),
              fromMe: true
            });
            continue;
          }

          if (messagingData.message) {
            // console.log('📝 Processando mensagem:', {
            //   sender_id: messagingData.sender.id,
            //   message_id: messagingData.message.mid,
            //   text: messagingData.message.text,
            //   is_echo: isEcho
            // });

            // Verificar se a mensagem foi deletada
            if (messagingData.message?.is_deleted) {
              console.log('🗑️ Mensagem deletada, atualizando status:', messagingData.message.mid);
              
              // Buscar o chat associado à mensagem
              const { data: messageData } = await supabase
                .from('messages')
                .select('chat_id')
                .eq('external_id', messagingData.message.mid)
                .single();

              if (messageData) {
                // Buscar a última mensagem antes da deletada
                const { data: lastMessage } = await supabase
                  .from('messages')
                  .select('*')
                  .eq('chat_id', messageData.chat_id)
                  .neq('external_id', messagingData.message.mid)
                  .order('created_at', { ascending: false })
                  .limit(1)
                  .single();

                if (lastMessage) {
                  // Atualizar o chat com a última mensagem
                  await supabase
                    .from('chats')
                    .update({
                      last_message_at: lastMessage.created_at,
                      last_message_id: lastMessage.id
                    })
                    .eq('id', messageData.chat_id);
                }
              }

              // Atualizar o status da mensagem para deleted
              const { error: updateError } = await supabase
                .from('messages')
                .update({ status: 'deleted' })
                .eq('external_id', messagingData.message.mid);

              if (updateError) {
                console.error('❌ Erro ao atualizar status da mensagem:', updateError);
                Sentry.captureException(updateError);
              } else {
                console.log('✅ Status da mensagem atualizado para deleted');
              }
              
              continue;
            }

            const accessToken = decrypt(channel.credentials.access_token);
            const chat = await findOrCreateChat(channel, chatExternalId, accessToken, isEcho);
            
            // console.log('💬 Chat processado:', {
            //   chat_id: chat.id,
            //   is_first_message: chat.is_first_message
            // });

            // Atualizar a data da última mensagem do cliente
            await supabase
              .from('chats')
              .update({
                last_customer_message_at: new Date(messagingData.timestamp || Date.now()).toISOString()
              })
              .eq('id', chat.id);

            // Processar anexos se houver
            let attachments = [];
            if (messagingData.message.attachments) {
              attachments = messagingData.message.attachments.map(attachment => {
                if (attachment.type === 'share') {
                  return {
                    url: attachment.payload.url,
                    type: 'image',
                    name: 'Imagem compartilhada'
                  };
                }
                return null;
              }).filter(Boolean);
            }

            await handleIncomingMessage(channel, {
              chat,
              from: messagingData.sender.id,
              externalId: messagingData.sender.id,
              externalName: chat.customers.name || messagingData.sender.id,
              messageId: messagingData.message.mid,
              timestamp: messagingData.timestamp || Date.now(),
              type: attachments.length > 0 ? 'image' : 'text',
              message: {
                type: attachments.length > 0 ? 'image' : 'text',
                content: messagingData.message.text || '',
                raw: messagingData
              },
              attachments,
              event: isEcho ? 'messageSent' : 'messageReceived',
              fromMe: isEcho
            });

            // console.log('✅ Mensagem processada com sucesso');
          }
        } catch (error) {
          console.error('❌ Erro ao processar mensagem:', error);
          Sentry.captureException(error);
          continue;
        }
      }
    }

    // console.log('✅ Webhook processado com sucesso');
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erro ao processar webhook:', error);
    Sentry.captureException(error);
    res.status(500).json({ error: error.message });
  }
}

async function handleMessageSeen(channel, webhookData) {
  try {
    // Update messages as read
    await supabase
      .from('messages')
      .update({ status: 'read' })
      .eq('chat_id', webhookData.chat_id)
      .lt('created_at', webhookData.seen_at);
  } catch (error) {
    console.error('Error handling message seen:', error);
    Sentry.captureException(error);
    throw error;
  }
}

export async function handleInstagramConnect({ code, channelId, organizationId }) {
  if (!code) {
    throw new Error('Authorization code is required');
  }

  try {
    // Verificar se o canal existe e está inativo
    const { data: channel, error: channelError } = await supabase
      .from('chat_channels')
      .select('*')
      .eq('id', channelId)
      .eq('organization_id', organizationId)
      .eq('type', 'instagram')
      // .eq('status', 'inactive')
      .eq('is_connected', false)
      .single();

    if (channelError || !channel) {
      throw new Error('Canal não encontrado ou inválido');
    }

    // Fazer a troca do código de autorização pelo access token
    const tokenResponse = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: process.env.INSTAGRAM_CLIENT_ID,
        client_secret: process.env.INSTAGRAM_CLIENT_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: `${process.env.API_URL}/api/webhook/instagram/oauth`,
        code: code
      })
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      throw new Error(`Instagram OAuth error: ${JSON.stringify(tokenData)}`);
    }

    // Obter token de longa duração (60 dias)
    const longLivedTokenResponse = await fetch(
      `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${process.env.INSTAGRAM_CLIENT_SECRET}&access_token=${tokenData.access_token}`
    );

    const longLivedTokenData = await longLivedTokenResponse.json();

    if (!longLivedTokenResponse.ok || !longLivedTokenData.access_token) {
      throw new Error(`Error getting long-lived token: ${JSON.stringify(longLivedTokenData)}`);
    }

    // Buscar informações adicionais do usuário
    const userInfoResponse = await fetch(
      `https://graph.instagram.com/v21.0/me?fields=user_id,username,profile_picture_url&access_token=${longLivedTokenData.access_token}`
    );

    const userInfo = await userInfoResponse.json();

    if (!userInfoResponse.ok) {
      throw new Error(`Error getting user info: ${JSON.stringify(userInfo)}`);
    }

    // Atualizar o canal com as credenciais do Instagram
    const { error: updateError } = await supabase
      .from('chat_channels')
      .update({
        credentials: {
          access_token: encrypt(longLivedTokenData.access_token),
          token_type: longLivedTokenData.token_type,
          user_id: parseInt(userInfo.user_id, 10),
          instagram_id: parseInt(userInfo.id, 10),
          username: userInfo.username,
          profile_picture_url: userInfo.profile_picture_url,
          token_expires_at: new Date(Date.now() + (longLivedTokenData.expires_in * 1000)).toISOString()
        },
        external_id: userInfo.user_id,
        status: 'active',
        is_connected: true,
        is_tested: true,
        settings: {},
        updated_at: new Date().toISOString()
      })
      .eq('id', channelId)
      .eq('organization_id', organizationId);

    if (updateError) {
      throw updateError;
    }

  } catch (error) {
    console.error('Error handling Instagram connection:', error);
    Sentry.captureException(error);
    throw error;
  }
}

export async function deleteInstagramChannel(req, res) {
  const { channelId, organizationId } = req.params;

  try {
    // Primeiro buscar o canal
    const { data: channel, error: channelError } = await supabase
      .from('chat_channels')
      .select('*')
      .eq('id', channelId)
      .eq('organization_id', organizationId)
      .eq('type', 'instagram')
      .single();

    if (channelError || !channel) {
      return res.status(404).json({
        success: false,
        error: 'Canal não encontrado'
      });
    }

    // Se estiver conectado, tenta revogar o token
    if (channel.is_connected && channel.credentials?.access_token) {
      try {
        const decryptedToken = decrypt(channel.credentials.access_token);
        const response = await fetch(
          `https://graph.facebook.com/${channel.credentials.user_id}/permissions?access_token=${decryptedToken}`,
          {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${decryptedToken}`
            }
          }
        );

        const result = await response.json();
        console.log('Resposta da revogação:', result);

        if (!response.ok || result !== true) {
          throw new Error('Falha ao revogar permissões do Instagram');
        }
      } catch (error) {
        console.error('Erro detalhado:', error);
        return res.status(500).json({
          success: false,
          error: 'Não foi possível revogar o acesso ao Instagram. Por favor, revogue o acesso manualmente nas configurações do Instagram.'
        });
      }
    }

    // Deletar o canal
    const { error: deleteError } = await supabase
      .from('chat_channels')
      .delete()
      .eq('id', channelId)
      .eq('organization_id', organizationId);

    if (deleteError) {
      throw deleteError;
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting Instagram channel:', error);
    Sentry.captureException(error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

export async function handleSenderMessageInstagram(channel, messageData) {
  try {
    const accessToken = decrypt(channel.credentials.access_token);
    const instagramUserId = channel.credentials.instagram_id;

    // Verificar se o cliente enviou mensagem nas últimas 24 horas
    const { data: chatData, error: chatError } = await supabase
      .from('chats')
      .select('last_customer_message_at')
      .eq('id', messageData.chat_id)
      .single();

    if (chatError) throw chatError;

    const lastCustomerMessageAt = chatData?.last_customer_message_at;
    
    // Verificar se last_customer_message_at está vazio
    if (!lastCustomerMessageAt) {
      throw new Error('Não é possível enviar mensagem para este cliente pois ele ainda não enviou nenhuma mensagem');
    }
    
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    if (new Date(lastCustomerMessageAt) < twentyFourHoursAgo) {
      throw new Error('Não é possível enviar mensagem para este cliente pois já se passaram mais de 24 horas desde a última interação dele');
    }

    let messageBody;

    // console.log(messageData)
    
    if (messageData.attachments?.length > 0) {
      const attachment = messageData.attachments[0];
      const fileExtension = attachment.name.split('.').pop().toLowerCase();
      
      // Validação de tipos de arquivo aceitos
      const validTypes = {
        audio: ['aac', 'm4a', 'wav', 'mp4'],
        image: ['png', 'jpeg', 'jpg', 'gif'],
        video: ['ogg', 'avi', 'mov', 'webm']
      };

      let attachmentType = null;
      
      if (validTypes.image.includes(fileExtension)) {
        attachmentType = 'image';
      } else if (validTypes.video.includes(fileExtension)) {
        attachmentType = 'video';
      } else if (validTypes.audio.includes(fileExtension)) {
        attachmentType = 'audio';
      }

      if (!attachmentType) {
        throw new Error(`Tipo de arquivo não suportado: ${fileExtension}`);
      }

      messageBody = {
        recipient: {
          id: messageData.to
        },
        message: {
          attachment: {
            type: attachmentType,
            payload: {
              url: attachment.url
            }
          }
        }
      };
      console.log(messageBody)
    } else {
      messageBody = {
        recipient: {
          id: messageData.to
        },
        message: {
          text: messageData.content
        }
      };
    }

    const response = await fetch(
      `https://graph.instagram.com/v21.0/${instagramUserId}/messages?access_token=${accessToken}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(messageBody)
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Instagram API error: ${JSON.stringify(error)}`);
    }

    const result = await response.json();

    return {
      messageId: result.message_id
    };
  } catch (error) {
    console.error('Erro ao enviar mensagem Instagram:', error);
    Sentry.captureException(error);
    throw error;
  }
}
