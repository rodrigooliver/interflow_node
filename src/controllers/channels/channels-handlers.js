import Sentry from '../../lib/sentry.js';
import { supabase } from '../../lib/supabase.js';
import { deleteWapiChannel } from './wapi.js';
import { registerUsageOrganizationByChannel } from '../organizations/usage.js';

/* 
* Tipos de mensagens suportadas por canal:
* - whatsapp_official: texto, imagem, vídeo, áudio, documento e templates
* - whatsapp_wapi: texto, imagem, vídeo, áudio, documento
* - instagram: texto, imagem, vídeo
* - email: texto com formatação HTML, anexos
*/
const CHANNEL_CONFIG = {
  whatsapp_official: {
  },
  whatsapp_wapi: {
    deleteHandler: deleteWapiChannel
  },
  whatsapp_zapi: {
  },
  whatsapp_evo: {

  },
  instagram: {

  },
  facebook: {

  },
  email: {

  }
};


/**
 * Transfere todos os chats de um canal para outro
 * @param {*} req 
 * @param {*} res 
 * @returns 
 */
export async function transferChats(req, res) {
  const { channelId } = req.params;
  const { targetChannelId } = req.body;

  try {
    // Validar se os canais existem
    const { data: channels, error: channelsError } = await supabase
      .from('chat_channels')
      .select('*')
      .in('id', [channelId, targetChannelId]);

    if (channelsError) throw channelsError;
    if (!channels || channels.length !== 2) {
      return res.status(404).json({
        success: false,
        error: 'Um ou ambos os canais não foram encontrados'
      });
    }

    // Atualizar todos os chats do canal origem para o canal destino
    const { error: updateError } = await supabase
      .from('chats')
      .update({ channel_id: targetChannelId })
      .eq('channel_id', channelId);

    if (updateError) throw updateError;

    res.json({
      success: true,
      message: 'Chats transferidos com sucesso'
    });

  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId,
        targetChannelId
      }
    });
    console.error('Erro ao transferir chats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

/**
* Gera um QR code para o canal
* 
* @param {Object} channel - Canal de comunicação
* @param {Object} webhookData - Dados brutos do webhook WAPI
* @returns {Promise<boolean>} - True se o QR code foi gerado com sucesso
*/
export async function handleQrCodeGenerated(channel, qrCode) {
  try {
    // Validate webhook data
    if (!qrCode) {
      const error = new Error('Invalid QR code data');
      Sentry.captureException(error, {
        extra: {
          channelId: channel.id,
          qrCode
        }
      });
      throw error;
    }

    // Calcular timestamp de expiração (60 segundos a partir de agora)
    const qrExpiresAt = new Date(Date.now() + 60000).toISOString();

    // Update channel with new QR code and expiration
    const { error: updateError } = await supabase
      .from('chat_channels')
      .update({
        credentials: {
          ...channel.credentials,
          qrCode: qrCode,
          qrExpiresAt: qrExpiresAt
        },
        updated_at: new Date().toISOString()
      })
      .eq('id', channel.id);

    if (updateError) throw updateError;

    return true;
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id,
        qrCode
      }
    });
    console.error('Error handling QR code generation:', error);
    throw error;
  }
}

/**
 * Gerencia o limite de códigos atingido para o QR Code
 * @param {*} channel 
 * @returns 
 */
export async function handleQrCodeLimitReached(channel) {
  try {
    // Update channel with new QR code and expiration
    const { error: updateError } = await supabase
      .from('chat_channels')
      .update({
        credentials: {
          ...channel.credentials,
          qrCode: null,
          qrCodeBase64: null,
          qrExpiresAt: null
        },
        updated_at: new Date().toISOString()
      })
      .eq('id', channel.id);

    if (updateError) throw updateError;
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id
      }
    });
    console.error('Error handling code limit reached:', error);
    throw error;
  }
}

/**
* Gerencia a conexão de uma instância do WhatsApp
* 
* @param {Object} channel - Canal de comunicação
* @param {String} numberPhone - Número de telefone da instância conectada
* @returns {Promise<boolean>} - True se a conexão foi gerenciada com sucesso
*/
export async function handleConnectedInstance(channel, numberPhone = null) {
  try {
    // Update channel status in database
    const { error: updateError } = await supabase
      .from('chat_channels')
      .update({
        is_connected: true,
        is_tested: true,
        status: 'active',
        credentials: {
          ...channel.credentials,
          connectedPhone: numberPhone,
          numberPhone: numberPhone,
          qrCode: null, // Limpa o QR code após conexão
          qrCodeBase64: null,
          qrExpiresAt: null
        },
        updated_at: new Date().toISOString()
      })
      .eq('id', channel.id);

    if (updateError) throw updateError;

    return true;
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id,
        numberPhone
      }
    });
    console.error('Error handling connected instance:', error);
    throw error;
  }
}

/**
 * Gerencia a desconexão de uma instância do WhatsApp
 * 
 * @param {Object} channel - Canal de comunicação
 * @param {Object} webhookData - Dados brutos do webhook WAPI
 * @returns {Promise<boolean>} - True se a desconexão foi gerenciada com sucesso
 */
export async function handleDisconnectedInstance(channel) {
  try {
    // Update channel status in database to mark as disconnected
    const { error: updateError } = await supabase
      .from('chat_channels')
      .update({
        is_connected: false,
        is_tested: false,
        status: 'inactive',
        credentials: {
          ...channel.credentials,
          qrCode: null,
          qrCodeBase64: null,
          qrExpiresAt: null
        },
        updated_at: new Date().toISOString()
      })
      .eq('id', channel.id);

    if (updateError) throw updateError;

    return true;
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId: channel.id,
        webhookData
      }
    });
    console.error('Error handling disconnected instance:', error);
    throw error;
  }
}

/**
 * Deleta um canal
 * @param {*} req 
 * @param {*} res 
 * @returns 
 */
export async function deleteChannelRoute(req, res) {
  const { channelId, organizationId } = req.params;

  try {
    await deleteChannel(channelId, organizationId);

    res.json({
      success: true,
      message: 'Canal deletado com sucesso'
    });
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId
      }
    });
    // console.error('Error deleting channel:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * Deleta um canal
 * @param {*} channelId 
 * @param {*} organizationId 
 * @returns 
 */
export async function deleteChannel(channelId, organizationId) {
  try {
    if (!channelId || !organizationId) {
      throw new Error('ID do canal e ID da organização são obrigatórios');
    }

    //consultardados do canal
    const { data: channel, error: channelError } = await supabase
      .from('chat_channels')
      .select('*')
      .eq('id', channelId)
      .eq('organization_id', organizationId)
      .single();

    if (channelError) throw channelError;

    //Não excluir caso tenha um chat vinculado
    const { data: chats, error: chatsError } = await supabase
      .from('chats')
      .select('id')
      .eq('channel_id', channelId);
    if (chatsError) throw chatsError;
    if (chats.length > 0) {
      throw new Error('Não é possível excluir o canal, pois existem chats vinculados a ele');
    }

    //Verificar se tipo de canal tem handleDelete
    if (CHANNEL_CONFIG[channel.type] && CHANNEL_CONFIG[channel.type].deleteHandler) {
      await CHANNEL_CONFIG[channel.type].deleteHandler(channelId, organizationId);
    }

    const { error: deleteError } = await supabase
      .from('chat_channels')
      .delete()
      .eq('id', channelId);

    if (deleteError) throw deleteError;

    registerUsageOrganizationByChannel(organizationId);
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        channelId
      }
    });
    // console.error('Error deleting channel:', error);
    throw error;
  }
}