import { supabase } from '../lib/supabase.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import Sentry from '../lib/sentry.js';

export async function refreshInstagramTokens() {
  const thirtyDaysFromNow = new Date();
  thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

  // Buscar canais com tokens que expiram nos próximos 30 dias
  const { data: channels, error } = await supabase
    .from('chat_channels')
    .select('*')
    .eq('type', 'instagram')
    .eq('status', 'active')
    .eq('is_connected', true)
    .lt('credentials.token_expires_at', thirtyDaysFromNow.toISOString());

  if (error) {
    console.error('Erro ao buscar canais para atualização de token:', error);
    Sentry.captureException(error, {
      tags: {
        operation: 'fetch_channels_for_token_refresh'
      }
    });
    return;
  }

  for (const channel of channels) {
    try {
      const currentToken = decrypt(channel.credentials.access_token);
      
      // Renovar o token de longa duração
      const response = await fetch(
        `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${currentToken}`
      );

      const data = await response.json();

      if (!response.ok) {
        const error = new Error(`Erro ao renovar token: ${JSON.stringify(data)}`);
        Sentry.captureException(error, {
          tags: {
            operation: 'refresh_instagram_token',
            channel_id: channel.id
          },
          extra: {
            response_data: data
          }
        });
        throw error;
      }

      // Atualizar o token no banco de dados
      const { error: updateError } = await supabase
        .from('chat_channels')
        .update({
          credentials: {
            ...channel.credentials,
            access_token: encrypt(data.access_token),
            token_expires_at: new Date(Date.now() + (data.expires_in * 1000)).toISOString()
          },
          updated_at: new Date().toISOString()
        })
        .eq('id', channel.id);

      if (updateError) {
        throw updateError;
      }

      console.log(`Token renovado com sucesso para o canal ${channel.id}`);
    } catch (error) {
      console.error(`Erro ao renovar token para o canal ${channel.id}:`, error);
      Sentry.captureException(error, {
        tags: {
          operation: 'process_channel_token_refresh',
          channel_id: channel.id
        }
      });
    }
  }
} 