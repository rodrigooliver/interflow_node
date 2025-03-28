import OneSignal from 'onesignal-node';
import dotenv from 'dotenv';
import Sentry from './sentry.js';

dotenv.config();

// OneSignal App ID e REST API Key
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;

// Limite máximo de caracteres compatível com iOS e Android
const MAX_MESSAGE_LENGTH = 150;

/**
 * Trunca o conteúdo da mensagem para respeitar o limite máximo
 * @param {string} content - Conteúdo original da mensagem
 * @returns {string} - Conteúdo truncado se necessário
 */
const truncateContent = (content) => {
  if (!content) return '';
  return content.length > MAX_MESSAGE_LENGTH 
    ? content.substring(0, MAX_MESSAGE_LENGTH - 3) + '...' 
    : content;
};

// Adicionar logs para debug
console.log('OneSignal Config:', {
  appId: ONESIGNAL_APP_ID ? 'Configurado' : 'Não configurado',
  restApiKey: ONESIGNAL_REST_API_KEY ? 'Configurado' : 'Não configurado'
});

// Criar cliente OneSignal
const client = new OneSignal.Client(ONESIGNAL_APP_ID, ONESIGNAL_REST_API_KEY);

/**
 * Envia uma notificação push através do OneSignal
 * @param {Object} options - Opções da notificação
 * @param {string} options.heading - Título da notificação
 * @param {string} options.subtitle - Subtítulo da notificação
 * @param {string} options.content - Conteúdo da notificação
 * @param {string[]} [options.segments] - Segmentos para enviar a notificação (default: ['Subscribed Users'])
 * @param {Array} [options.filters] - Filtros para enviar a notificação para usuários específicos
 * @param {Object} [options.include_aliases] - Objeto com chave external_id contendo array de IDs para enviar notificações
 * @param {string} [options.target_channel] - Canal alvo (push, email, sms)
 * @param {Object} [options.data] - Dados adicionais para enviar com a notificação
 * @returns {Promise<Object>} - Objeto com o ID da notificação criada
 */
export const sendNotification = async ({ 
  heading, 
  subtitle,
  content, 
  segments, 
  filters, 
  include_aliases, 
  target_channel, 
  data = {} 
}) => {
  try {
    if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) {
      throw new Error('OneSignal credentials are not configured');
    }

    if (!content) {
      return;
    }

    // Truncar o conteúdo para respeitar o limite máximo
    const truncatedContent = truncateContent(content);

    const notification = {
      contents: {
        en: truncatedContent,
        pt: truncatedContent
      }
    };

    // Adicionar headings se fornecidos
    if (heading) {
      notification.headings = {
        en: truncateContent(heading),
        pt: truncateContent(heading)
      };
    }

    // Adicionar subtitle se fornecido
    if (subtitle) {
      notification.subtitle = {
        en: truncateContent(subtitle),
        pt: truncateContent(subtitle)
      };
    }

    // Prioridade para include_aliases (para notificações direcionadas com external_id)
    if (include_aliases && Object.keys(include_aliases).length > 0) {
      notification.include_aliases = include_aliases;
      
      // Definir canal alvo se fornecido
      if (target_channel) {
        notification.target_channel = target_channel;
      }
    }
    // Se não tiver include_aliases, usar filtros ou segmentos
    else if (filters && filters.length > 0) {
      notification.filters = filters;
    } else if (segments && segments.length > 0) {
      notification.included_segments = segments;
    } else {
      notification.included_segments = ['Subscribed Users'];
    }
    
    // Adicionar dados extras se fornecidos
    if (Object.keys(data).length > 0) {
      notification.data = data;
    }

    const response = await client.createNotification(notification);
    return { id: response.body.id };
  } catch (error) {
    console.error('Error sending OneSignal notification:', {
      message: error.message,
      code: error.code,
      status: error.status,
      details: error.body,
      headers: error.headers
    });
    
    Sentry.captureException(error, {
      tags: {
        service: 'oneSignal',
        operation: 'sendNotification'
      },
      extra: {
        notification: {
          heading,
          subtitle,
          content,
          segments,
          filters,
          include_aliases,
          target_channel,
          data
        }
      }
    });
    
    throw error;
  }
};

/**
 * Busca informações sobre uma notificação específica
 * @param {string} notificationId - ID da notificação
 * @returns {Promise<Object>} - Dados da notificação
 */
export const getNotification = async (notificationId) => {
  try {
    if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) {
      throw new Error('OneSignal credentials are not configured');
    }

    const response = await client.viewNotification(notificationId);
    return response.body;
  } catch (error) {
    console.error('Error getting OneSignal notification:', error);
    
    Sentry.captureException(error, {
      tags: {
        service: 'oneSignal',
        operation: 'getNotification'
      },
      extra: {
        notificationId
      }
    });
    
    throw error;
  }
};

export default {
  sendNotification,
  getNotification
}; 