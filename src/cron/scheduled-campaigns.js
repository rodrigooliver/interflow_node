import { supabase } from '../lib/supabase.js';
import Sentry from '../lib/sentry.js';

/**
 * Verifica campanhas agendadas que devem ser iniciadas
 */
export const processScheduledCampaigns = async () => {
  try {
    const now = new Date().toISOString();
    
    // Buscar campanhas agendadas cuja hora chegou
    const { data: scheduledCampaigns, error } = await supabase
      .from('bulk_message_campaigns')
      .select(`
        id,
        name,
        organization_id,
        created_by,
        scheduled_at
      `)
      .eq('status', 'scheduled')
      .lte('scheduled_at', now)
      .order('scheduled_at', { ascending: true });

    if (error) {
      console.error('Erro ao buscar campanhas agendadas:', error);
      throw error;
    }

    if (!scheduledCampaigns || scheduledCampaigns.length === 0) {
      return { processed: 0, errors: 0 };
    }

    // console.log(`[CRON] Encontradas ${scheduledCampaigns.length} campanhas agendadas para iniciar`);

    let processedCount = 0;
    let errorCount = 0;

    // Processar cada campanha
    for (const campaign of scheduledCampaigns) {
      try {
        // console.log(`[CRON] Iniciando campanha agendada: ${campaign.name} (ID: ${campaign.id})`);

        // Atualizar status para processing e definir started_at
        const { error: updateError } = await supabase
          .from('bulk_message_campaigns')
          .update({
            status: 'processing',
            started_at: new Date().toISOString()
          })
          .eq('id', campaign.id)
          .eq('status', 'scheduled'); // Verificação adicional para evitar concorrência

        if (updateError) {
          throw updateError;
        }

        // Criar fila de mensagens para a campanha
        const { data: queueResult, error: queueError } = await supabase
          .rpc('create_bulk_message_queue', {
            p_campaign_id: campaign.id
          });

        if (queueError) {
          // Se falhou ao criar fila, marcar campanha como failed
          await supabase
            .from('bulk_message_campaigns')
            .update({
              status: 'failed',
              completed_at: new Date().toISOString()
            })
            .eq('id', campaign.id);

          throw queueError;
        }

        // Log de sucesso
        await supabase
          .from('bulk_message_logs')
          .insert([{
            campaign_id: campaign.id,
            organization_id: campaign.organization_id,
            level: 'info',
            message: `Campanha agendada iniciada automaticamente. ${queueResult || 0} mensagens adicionadas à fila.`,
            details: {
              scheduled_at: campaign.scheduled_at,
              started_at: new Date().toISOString(),
              total_recipients: queueResult || 0
            }
          }]);

        processedCount++;
        // console.log(`[CRON] Campanha ${campaign.id} iniciada com sucesso - ${queueResult || 0} mensagens na fila`);

      } catch (campaignError) {
        errorCount++;
        // console.error(`[CRON] Erro ao processar campanha ${campaign.id}:`, campaignError);
        
        // Log de erro
        try {
          await supabase
            .from('bulk_message_logs')
            .insert([{
              campaign_id: campaign.id,
              organization_id: campaign.organization_id,
              level: 'error',
              message: `Falha ao iniciar campanha agendada: ${campaignError.message}`,
              details: {
                error: campaignError.message,
                scheduled_at: campaign.scheduled_at
              }
            }]);
        } catch (logError) {
          console.error('Erro ao registrar log:', logError);
        }

        Sentry.captureException(campaignError, {
          tags: {
            component: 'scheduled-campaigns',
            campaignId: campaign.id.toString()
          },
          extra: {
            campaignName: campaign.name,
            scheduledAt: campaign.scheduled_at
          }
        });
      }
    }

    // console.log(`[CRON] Processamento de campanhas agendadas concluído: ${processedCount} iniciadas, ${errorCount} falharam`);

    return {
      processed: processedCount,
      errors: errorCount,
      total: scheduledCampaigns.length
    };

  } catch (error) {
    console.error('Erro geral no processamento de campanhas agendadas:', error);
    Sentry.captureException(error, {
      tags: { component: 'scheduled-campaigns', method: 'processScheduledCampaigns' }
    });
    throw error;
  }
}; 