import cron from 'node-cron';
import * as Sentry from '@sentry/node';
import { checkTimeouts } from './timeout-checker.js';
import { refreshInstagramTokens } from './instagram-token-refresh.js';
import { 
  processOverdueTransactions, 
  generateRecurringTransactions,
  processDailyFinancialJobs 
} from './financial-jobs.js';
import { processScheduledNotifications } from '../controllers/schedules/scheduleNotifications.js';
import { processScheduledMessages } from '../controllers/chat/message-handlers.js';
import { startBulkMessageProcessor, stopBulkMessageProcessor } from '../services/bulk-message-processor.js';
import { processScheduledCampaigns } from './scheduled-campaigns.js';

/**
 * Configura todos os cron jobs da aplicação
 */
export const setupCronJobs = async () => {
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

    // Job para processar transações vencidas (executa diariamente às 00:30)
    const overdueTransactionsCron = cron.schedule('30 0 * * *', async () => {
      try {
        await processOverdueTransactions();
      } catch (error) {
        console.error('Erro ao processar transações vencidas:', error);
        Sentry.captureException(error);
      }
    });

    // Job para gerar transações recorrentes (executa diariamente às 01:00)
    const recurringTransactionsCron = cron.schedule('0 1 * * *', async () => {
      try {
        await generateRecurringTransactions();
      } catch (error) {
        console.error('Erro ao gerar transações recorrentes:', error);
        Sentry.captureException(error);
      }
    });

    // Job para processar todas as tarefas financeiras diárias (executa às 02:00)
    const dailyFinancialJobsCron = cron.schedule('0 2 * * *', async () => {
      try {
        await processDailyFinancialJobs();
      } catch (error) {
        console.error('Erro ao processar jobs financeiros diários:', error);
        Sentry.captureException(error);
      }
    });
    
    // Job para verificar e enviar notificações programadas (executa a cada 5 minutos)
    const notificationsCron = cron.schedule('*/5 * * * *', async () => {
      try {
        // console.log('[CRON] Iniciando verificação de notificações programadas...');
        const result = await processScheduledNotifications();
        // console.log(`[CRON] Processamento de notificações concluído: ${result.appointments_processed} agendamentos processados, ${result.reminders_created} lembretes criados`);
      } catch (error) {
        console.error('Erro ao verificar notificações programadas:', error);
        Sentry.captureException(error);
      }
    });

    // Job para processar mensagens agendadas (executa a cada minuto)
    const scheduledMessagesCron = cron.schedule('* * * * *', async () => {
      try {
        const result = await processScheduledMessages();
        if (result.processed > 0) {
          // console.log(`[CRON] Mensagens agendadas processadas: ${result.processed} enviadas, ${result.errors || 0} falharam`);
        }
      } catch (error) {
        console.error('Erro ao processar mensagens agendadas:', error);
        Sentry.captureException(error);
      }
    });

    // Job para processar campanhas agendadas (executa a cada minuto)
    const scheduledCampaignsCron = cron.schedule('* * * * *', async () => {
      try {
        const result = await processScheduledCampaigns();
        if (result.processed > 0) {
          // console.log(`[CRON] Campanhas agendadas processadas: ${result.processed} iniciadas, ${result.errors || 0} falharam`);
        }
      } catch (error) {
        console.error('Erro ao processar campanhas agendadas:', error);
        Sentry.captureException(error);
      }
    });

    // Iniciar o processador de mensagens em massa
    const bulkMessageProcessor = await startBulkMessageProcessor();
    
    // Retorna os cron jobs para que possam ser parados se necessário
    return {
      timeoutCron,
      instagramTokenCron,
      overdueTransactionsCron,
      recurringTransactionsCron,
      dailyFinancialJobsCron,
      notificationsCron,
      scheduledMessagesCron,
      scheduledCampaignsCron,
      bulkMessageProcessor
    };
  } catch (error) {
    Sentry.captureException(error);
    console.error('Erro ao configurar cron jobs:', error);
    return {};
  }
}; 