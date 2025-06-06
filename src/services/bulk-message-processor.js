import { supabase } from '../lib/supabase.js';
import { sendMessage } from './message-sender.js';
import Sentry from '../lib/sentry.js';

/**
 * Serviço para processar a fila de mensagens em massa
 */
export class BulkMessageProcessor {
  constructor() {
    this.isProcessing = false;
    this.intervalId = null;
    this.batchTimeouts = new Map(); // Para controlar timeouts de batches
    this.pausedCampaigns = new Set(); // Controle global de campanhas pausadas
  }

  /**
   * Pausar uma campanha específica
   */
  pauseCampaign(campaignId) {
    // console.log(`Pausando campanha ${campaignId} no processador`);
    this.pausedCampaigns.add(campaignId.toString());
  }

  /**
   * Retomar uma campanha específica  
   */
  resumeCampaign(campaignId) {
    // console.log(`Retomando campanha ${campaignId} no processador`);
    this.pausedCampaigns.delete(campaignId.toString());
  }

  /**
   * Verificar se uma campanha está pausada
   */
  isCampaignPaused(campaignId) {
    return this.pausedCampaigns.has(campaignId.toString());
  }

  /**
   * Inicia o processamento da fila
   */
  async start() {
    if (this.isProcessing) {
    //   console.log('Bulk message processor já está em execução');
      return;
    }

    this.isProcessing = true;
    // console.log('Iniciando processamento da fila de mensagens em massa');

    // Recuperar estado após reinicialização
    await this.recoverFromRestart();

    // Processar a cada 5 segundos
    this.intervalId = setInterval(() => {
      this.processQueue().catch(error => {
        console.error('Erro no processamento da fila:', error);
        Sentry.captureException(error, {
          tags: { component: 'bulk-message-processor', method: 'processQueue' }
        });
      });
    }, 5000);
  }

  /**
   * Recupera o estado após reinicialização do servidor
   */
  async recoverFromRestart() {
    try {
    //   console.log('Iniciando recuperação de estado após reinicialização...');

      // 1. Recuperar campanhas pausadas do banco de dados
      await this.recoverPausedCampaigns();

      // 2. Resetar mensagens órfãs (que estavam 'processing' quando servidor foi reiniciado)
      await this.recoverOrphanedMessages();

    //   console.log('Recuperação de estado concluída com sucesso');

    } catch (error) {
      console.error('Erro na recuperação de estado:', error);
      Sentry.captureException(error, {
        tags: { component: 'bulk-message-processor', method: 'recoverFromRestart' }
      });
    }
  }

  /**
   * Recupera campanhas pausadas do banco de dados para memória
   */
  async recoverPausedCampaigns() {
    try {
      const { data: pausedCampaigns, error } = await supabase
        .from('bulk_message_campaigns')
        .select('id')
        .eq('status', 'paused');

      if (error) throw error;

      if (pausedCampaigns && pausedCampaigns.length > 0) {
        pausedCampaigns.forEach(campaign => {
          this.pausedCampaigns.add(campaign.id.toString());
        });
        console.log(`Recuperadas ${pausedCampaigns.length} campanhas pausadas para memória`);
      }

    } catch (error) {
      console.error('Erro ao recuperar campanhas pausadas:', error);
      throw error;
    }
  }

  /**
   * Recupera mensagens órfãs que estavam sendo processadas quando servidor foi reiniciado
   */
  async recoverOrphanedMessages() {
    try {
      // Buscar mensagens que ficaram com status 'processing' (órfãs)
      const { data: orphanedMessages, error: fetchError } = await supabase
        .from('bulk_message_queue')
        .select('id, campaign_id')
        .eq('status', 'processing');

      if (fetchError) throw fetchError;

      if (orphanedMessages && orphanedMessages.length > 0) {
        console.log(`Encontradas ${orphanedMessages.length} mensagens órfãs, resetando para 'pending'`);

        // Resetar para pending para que possam ser processadas novamente
        const { error: updateError } = await supabase
          .from('bulk_message_queue')
          .update({ status: 'pending' })
          .eq('status', 'processing');

        if (updateError) throw updateError;

        // Log de recuperação
        const campaignIds = [...new Set(orphanedMessages.map(m => m.campaign_id))];
        for (const campaignId of campaignIds) {
          const orphanedCount = orphanedMessages.filter(m => m.campaign_id === campaignId).length;
          await this.logCampaignEvent(campaignId, null, 'info', 
            `Recuperação: ${orphanedCount} mensagens órfãs resetadas após reinicialização do servidor`);
        }
      }

    } catch (error) {
      console.error('Erro ao recuperar mensagens órfãs:', error);
      throw error;
    }
  }

  /**
   * Para o processamento da fila
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // Limpar timeouts de batches
    for (const timeout of this.batchTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.batchTimeouts.clear();

    this.isProcessing = false;
    console.log('Processamento da fila de mensagens parado');
  }

  /**
   * Processa as mensagens pendentes na fila
   */
  async processQueue() {
    try {
      // Buscar mensagens que estão prontas para envio
      // Apenas de campanhas que estão em processamento
      const { data: pendingMessages, error } = await supabase
        .from('bulk_message_queue')
        .select(`
          *,
          campaign:bulk_message_campaigns(*),
          customer:customers(*, contacts:customer_contacts(*)),
          channel:chat_channels(*)
        `)
        .eq('status', 'pending')
        .eq('campaign.status', 'processing')
        .lte('scheduled_at', new Date().toISOString())
        .order('scheduled_at', { ascending: true })
        .limit(100); // Processar no máximo 100 por vez

      if (error) {
        console.error('Erro ao buscar mensagens pendentes:', error);
        Sentry.captureException(error, {
          tags: { component: 'bulk-message-processor', method: 'processQueue' }
        });
        return;
      }

      if (!pendingMessages || pendingMessages.length === 0) {
        return; // Nenhuma mensagem para processar
      }

    //   console.log(`Processando ${pendingMessages.length} mensagens`);

      // Agrupar por campanha para controle de batch
      const messagesByCampaign = this.groupMessagesByCampaign(pendingMessages);

      // Processar cada campanha
      for (const [campaignId, messages] of messagesByCampaign.entries()) {
        await this.processCampaignMessages(campaignId, messages);
      }

    } catch (error) {
      console.error('Erro geral no processamento da fila:', error);
      Sentry.captureException(error, {
        tags: { component: 'bulk-message-processor', method: 'processQueue' }
      });
    }
  }

  /**
   * Agrupa mensagens por campanha
   */
  groupMessagesByCampaign(messages) {
    const grouped = new Map();
    
    for (const message of messages) {
      const campaignId = message.campaign_id;
      if (!grouped.has(campaignId)) {
        grouped.set(campaignId, []);
      }
      grouped.get(campaignId).push(message);
    }

    return grouped;
  }

  /**
   * Processa mensagens de uma campanha específica
   */
  async processCampaignMessages(campaignId, messages) {
    try {
      // Verificar se a campanha está pausada em memória (muito mais rápido)
      if (this.isCampaignPaused(campaignId)) {
        // console.log(`Campanha ${campaignId} está pausada, ignorando mensagens`);
        return;
      }

      // Verificar se a campanha ainda está ativa
      const campaign = messages[0].campaign;
      if (!campaign || !['processing'].includes(campaign.status)) {
        // console.log(`Campanha ${campaignId} está com status '${campaign?.status}', ignorando mensagens`);
        return;
      }

      // Agrupar por batch para respeitar delays entre batches
      const messagesByBatch = this.groupMessagesByBatch(messages);

      // Processar cada batch com o delay apropriado
      for (const [batchNumber, batchMessages] of messagesByBatch.entries()) {
        await this.processBatch(campaignId, batchNumber, batchMessages, campaign);
      }

    } catch (error) {
      console.error(`Erro ao processar campanha ${campaignId}:`, error);
      Sentry.captureException(error, {
        tags: { 
          component: 'bulk-message-processor', 
          method: 'processCampaignMessages',
          campaignId: campaignId.toString()
        }
      });
      
      // Marcar campanha como failed
      await this.markCampaignAsFailed(campaignId, error.message);
    }
  }

  /**
   * Agrupa mensagens por batch
   */
  groupMessagesByBatch(messages) {
    const grouped = new Map();
    
    for (const message of messages) {
      const batchNumber = message.batch_number;
      if (!grouped.has(batchNumber)) {
        grouped.set(batchNumber, []);
      }
      grouped.get(batchNumber).push(message);
    }

    return grouped;
  }

  /**
   * Processa um batch de mensagens
   */
  async processBatch(campaignId, batchNumber, messages, campaign) {
    // console.log(`Processando batch ${batchNumber} da campanha ${campaignId} com ${messages.length} mensagens`);

    // Verificar se a campanha está pausada antes de iniciar o batch
    if (this.isCampaignPaused(campaignId)) {
    //   console.log(`Campanha ${campaignId} está pausada, parando batch ${batchNumber}`);
      return;
    }

    // Ordenar mensagens por position_in_batch
    messages.sort((a, b) => a.position_in_batch - b.position_in_batch);

    let successCount = 0;
    let failureCount = 0;

    // Processar cada mensagem do batch com delay
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      
      // Verificar se a campanha foi pausada durante o processamento (verificação rápida em memória)
      if (this.isCampaignPaused(campaignId)) {
        // console.log(`Campanha ${campaignId} foi pausada durante processamento, parando batch ${batchNumber}`);
        break; // Parar o processamento deste batch
      }
      
      try {

        // Marcar como processando
        await this.updateMessageStatus(message.id, 'processing');

        // Enviar mensagem
        const result = await sendMessage({
          customer: message.customer,
          channelId: message.channel.id,
          content: message.content,
          organizationId: campaign.organization_id,
        });

        // Marcar como enviada
        await this.updateMessageStatus(message.id, 'sent', {
          sent_at: new Date().toISOString(),
          message_id: result.messageId
        });

        successCount++;

        // Log de sucesso
        await this.logCampaignEvent(campaignId, campaign.organization_id, 'info', 
          `Mensagem enviada com sucesso para ${message.customer.name}`);

      } catch (error) {
        console.error(`Erro ao enviar mensagem ${message.id}:`, error);
        Sentry.captureException(error, {
          tags: { 
            component: 'bulk-message-processor', 
            method: 'processBatch',
            campaignId: campaignId.toString(),
            messageId: message.id.toString()
          }
        });

        // Marcar como failed
        await this.updateMessageStatus(message.id, 'failed', {
          error_message: error.message
        });

        failureCount++;

        // Log de erro
        await this.logCampaignEvent(campaignId, campaign.organization_id, 'error', 
          `Falha ao enviar mensagem para ${message.customer.name}: ${error.message}`);
      }

      // Aplicar delay entre mensagens (exceto na última)
      if (i < messages.length - 1) {
        await this.delay(campaign.delay_between_messages);
      }
    }

    // Atualizar estatísticas da campanha
    await this.updateCampaignStats(campaignId, successCount, failureCount);

    // Verificar se a campanha foi concluída
    await this.checkCampaignCompletion(campaignId);

    // console.log(`Batch ${batchNumber} concluído: ${successCount} sucessos, ${failureCount} falhas`);
  }

  /**
   * Atualiza o status de uma mensagem na fila
   */
  async updateMessageStatus(messageId, status, additionalData = {}) {
    const updateData = {
      status,
      ...additionalData
    };

    const { error } = await supabase
      .from('bulk_message_queue')
      .update(updateData)
      .eq('id', messageId);

    if (error) {
      console.error(`Erro ao atualizar status da mensagem ${messageId}:`, error);
      Sentry.captureException(error, {
        tags: { 
          component: 'bulk-message-processor', 
          method: 'updateMessageStatus',
          messageId: messageId.toString()
        }
      });
      throw error;
    }
  }

  /**
   * Atualiza estatísticas da campanha
   */
  async updateCampaignStats(campaignId, successCount, failureCount) {
    const { error } = await supabase
      .rpc('increment_campaign_stats', {
        p_campaign_id: campaignId,
        p_messages_sent: successCount,
        p_messages_failed: failureCount
      });

    if (error) {
      console.error(`Erro ao atualizar estatísticas da campanha ${campaignId}:`, error);
      Sentry.captureException(error, {
        tags: { 
          component: 'bulk-message-processor', 
          method: 'updateCampaignStats',
          campaignId: campaignId.toString()
        }
      });
    }
  }

  /**
   * Verifica se a campanha foi concluída
   */
  async checkCampaignCompletion(campaignId) {
    try {
      // Buscar estatísticas da campanha
      const { data: campaign, error } = await supabase
        .from('bulk_message_campaigns')
        .select('total_recipients, messages_sent, messages_failed, status')
        .eq('id', campaignId)
        .single();

      if (error) throw error;

      // Verificar se todas as mensagens foram processadas
      const totalProcessed = campaign.messages_sent + campaign.messages_failed;
      
      if (totalProcessed >= campaign.total_recipients && (campaign.status === 'processing' || campaign.status === 'paused')) {
        // Marcar campanha como concluída
        await supabase
          .from('bulk_message_campaigns')
          .update({ 
            status: 'completed',
            completed_at: new Date().toISOString()
          })
          .eq('id', campaignId);

        await this.logCampaignEvent(campaignId, campaign.organization_id, 'info', 
          `Campanha concluída: ${campaign.messages_sent} enviadas, ${campaign.messages_failed} falharam`);

        // console.log(`Campanha ${campaignId} concluída`);
      }

    } catch (error) {
      console.error(`Erro ao verificar conclusão da campanha ${campaignId}:`, error);
      Sentry.captureException(error, {
        tags: { 
          component: 'bulk-message-processor', 
          method: 'checkCampaignCompletion',
          campaignId: campaignId.toString()
        }
      });
    }
  }

  /**
   * Marca uma campanha como failed
   */
  async markCampaignAsFailed(campaignId, errorMessage) {
    try {
      await supabase
        .from('bulk_message_campaigns')
        .update({ 
          status: 'failed',
          completed_at: new Date().toISOString()
        })
        .eq('id', campaignId);

      await this.logCampaignEvent(campaignId, null, 'error', 
        `Campanha falhou: ${errorMessage}`);

    } catch (error) {
      console.error(`Erro ao marcar campanha ${campaignId} como failed:`, error);
      Sentry.captureException(error, {
        tags: { 
          component: 'bulk-message-processor', 
          method: 'markCampaignAsFailed',
          campaignId: campaignId.toString()
        }
      });
    }
  }

  /**
   * Registra um evento de log da campanha
   */
  async logCampaignEvent(campaignId, organizationId, level, message, details = {}) {
    try {
      await supabase
        .from('bulk_message_logs')
        .insert([{
          campaign_id: campaignId,
          organization_id: organizationId,
          level,
          message,
          details
        }]);
    } catch (error) {
      console.error('Erro ao registrar log da campanha:', error);
      Sentry.captureException(error, {
        tags: { 
          component: 'bulk-message-processor', 
          method: 'logCampaignEvent',
          campaignId: campaignId?.toString() || 'unknown'
        }
      });
    }
  }

  /**
   * Utilitário para criar delay
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Instância singleton
let processor = null;

/**
 * Inicia o processador de mensagens em massa
 */
export async function startBulkMessageProcessor() {
  if (!processor) {
    processor = new BulkMessageProcessor();
  }
  await processor.start();
  return processor;
}

/**
 * Para o processador de mensagens em massa
 */
export function stopBulkMessageProcessor() {
  if (processor) {
    processor.stop();
  }
}

/**
 * Obtém a instância do processador
 */
export function getBulkMessageProcessor() {
  return processor;
} 