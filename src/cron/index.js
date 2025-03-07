import cron from 'node-cron';
import * as Sentry from '@sentry/node';
import { checkTimeouts } from './timeout-checker.js';
import { refreshInstagramTokens } from './instagram-token-refresh.js';

/**
 * Configura todos os cron jobs da aplicação
 */
export const setupCronJobs = () => {
  try {
    // Verifica timeouts a cada minuto
    const timeoutCron = cron.schedule('* * * * *', async () => {
      try {
        await checkTimeouts();
      } catch (error) {
        Sentry.captureException(error);
      }
    });
    
    // Atualiza tokens do Instagram todos os dias à meia-noite
    const instagramTokenCron = cron.schedule('0 0 * * *', async () => {
      try {
        await refreshInstagramTokens();
      } catch (error) {
        console.error('Error refreshing Instagram tokens:', error);
        Sentry.captureException(error);
      }
    });

    
    // Retorna os cron jobs para que possam ser parados se necessário
    return {
      timeoutCron,
      instagramTokenCron
    };
  } catch (error) {
    Sentry.captureException(error);
    console.error('Erro ao configurar cron jobs:', error);
    return {};
  }
}; 