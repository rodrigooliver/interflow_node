import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';
import { getBulkMessageProcessor } from '../../services/bulk-message-processor.js';
/**
 * Buscar todas as campanhas de mensagens em massa da organização
 */
export const getBulkMessageCampaignsRoute = async (req, res) => {
  try {
    const { organizationId } = req.params;

    const { data, error } = await supabase
      .from('bulk_message_campaigns')
      .select(`
        *,
        created_by_profile:profiles!bulk_message_campaigns_created_by_fkey(
          id, full_name, avatar_url
        )
      `)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('Erro ao buscar campanhas:', error);
    Sentry.captureException(error);
    res.status(500).json({ error: 'Erro ao buscar campanhas' });
  }
};

/**
 * Buscar uma campanha específica
 */
export const getBulkMessageCampaignRoute = async (req, res) => {
  try {
    const { id } = req.params;
    const { organizationId } = req.params;

    const { data, error } = await supabase
      .from('bulk_message_campaigns')
      .select(`
        *,
        created_by_profile:profiles!bulk_message_campaigns_created_by_fkey(
          id, full_name, avatar_url
        )
      `)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('Erro ao buscar campanha:', error);
    Sentry.captureException(error);
    res.status(500).json({ error: 'Erro ao buscar campanha' });
  }
};

/**
 * Criar nova campanha de mensagens em massa
 */
export const createBulkMessageCampaignRoute = async (req, res) => {
  try {
    const { organizationId } = req.params;
    const { profile_id } = req.user;
    const campaignData = {
      ...req.body,
      organization_id: organizationId,
      created_by: profile_id
    };

    // Validações básicas
    if (!campaignData.name || !campaignData.content || !campaignData.channel_ids?.length) {
      return res.status(400).json({
        error: 'Nome, conteúdo e pelo menos um canal são obrigatórios'
      });
    }

    const { data, error } = await supabase
      .from('bulk_message_campaigns')
      .insert([campaignData])
      .select()
      .single();

    if (error) throw error;

    // Log da criação
    await supabase
      .from('bulk_message_logs')
      .insert([{
        campaign_id: data.id,
        organization_id: organizationId,
        level: 'info',
        message: 'Campanha criada',
        details: { created_by: profile_id }
      }]);

    res.status(201).json(data);
  } catch (error) {
    console.error('Erro ao criar campanha:', error);
    Sentry.captureException(error);
    res.status(500).json({ error: 'Erro ao criar campanha' });
  }
};

/**
 * Atualizar campanha existente
 */
export const updateBulkMessageCampaignRoute = async (req, res) => {
  try {
    const { id } = req.params;
    const { organizationId } = req.params;

    // Verificar se a campanha pode ser editada
    const { data: existingCampaign, error: fetchError } = await supabase
      .from('bulk_message_campaigns')
      .select('status')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .single();

    if (fetchError) throw fetchError;

    if (existingCampaign.status === 'processing') {
      return res.status(400).json({
        error: 'Não é possível editar uma campanha em processamento'
      });
    }

    const { data, error } = await supabase
      .from('bulk_message_campaigns')
      .update(req.body)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('Erro ao atualizar campanha:', error);
    Sentry.captureException(error);
    res.status(500).json({ error: 'Erro ao atualizar campanha' });
  }
};

/**
 * Excluir campanha
 */
export const deleteBulkMessageCampaignRoute = async (req, res) => {
  try {
    const { id } = req.params;
    const { organizationId } = req.params;

    // Verificar se a campanha pode ser excluída
    const { data: existingCampaign, error: fetchError } = await supabase
      .from('bulk_message_campaigns')
      .select('status')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .single();

    if (fetchError) throw fetchError;

    if (existingCampaign.status === 'processing') {
      return res.status(400).json({
        error: 'Não é possível excluir uma campanha em processamento'
      });
    }

    //Deletar logs da campanha
    const { error: errorLogs } = await supabase
      .from('bulk_message_logs')
      .delete()
      .eq('campaign_id', id);

    if (errorLogs) throw errorLogs;

    // Deletar a fila de mensagens da campanha
    const { error: errorQueue } = await supabase
      .from('bulk_message_queue')
      .delete()
      .eq('campaign_id', id);

    if (errorQueue) throw errorQueue;

    const { error } = await supabase
      .from('bulk_message_campaigns')
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) throw error;

    res.json({ message: 'Campanha excluída com sucesso' });
  } catch (error) {
    console.error('Erro ao excluir campanha:', error);
    Sentry.captureException(error);
    res.status(500).json({ error: 'Erro ao excluir campanha' });
  }
};

/**
 * Iniciar campanha de mensagens em massa
 */
export const startBulkMessageCampaignRoute = async (req, res) => {
  try {
    const { id, organizationId } = req.params;

    // Verificar se a campanha existe e pode ser iniciada
    const { data: campaign, error: fetchError } = await supabase
      .from('bulk_message_campaigns')
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .single();

    if (fetchError) throw fetchError;

    // console.log(campaign);

    if (!['draft', 'scheduled'].includes(campaign.status)) {
      return res.status(400).json({
        error: 'Campanha não pode ser iniciada no status atual'
      });
    }

    // Atualizar status para 'processing'
    const { error: updateError } = await supabase
      .from('bulk_message_campaigns')
      .update({
        status: 'processing',
        started_at: new Date().toISOString()
      })
      .eq('id', id);

    if (updateError) throw updateError;

    // Criar a fila de mensagens usando a função SQL
    const { data: queueResult, error: queueError } = await supabase
      .rpc('create_bulk_message_queue', { p_campaign_id: id });

    if (queueError) throw queueError;

    // Log do início
    await supabase
      .from('bulk_message_logs')
      .insert([{
        campaign_id: id,
        organization_id: organizationId,
        level: 'info',
        message: 'Campanha iniciada',
        details: { recipients_queued: queueResult }
      }]);

    res.json({
      success: true,
      message: 'Campanha iniciada com sucesso',
      recipients_queued: queueResult
    });
  } catch (error) {
    console.error('Erro ao iniciar campanha:', error);
    Sentry.captureException(error);

    // Reverter status em caso de erro
    await supabase
      .from('bulk_message_campaigns')
      .update({ status: 'failed' })
      .eq('id', req.params.id);

    res.status(500).json({ error: 'Erro ao iniciar campanha' });
  }
};

/**
 * Cancelar campanha em processamento
 */
export const cancelBulkMessageCampaignRoute = async (req, res) => {
  try {
    const { id } = req.params;
    const { organizationId } = req.params;

    // Atualizar status da campanha
    const { error: campaignError } = await supabase
      .from('bulk_message_campaigns')
      .update({
        status: 'cancelled',
        completed_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (campaignError) throw campaignError;

    // Cancelar mensagens pendentes na fila
    const { error: queueError } = await supabase
      .from('bulk_message_queue')
      .update({ status: 'cancelled' })
      .eq('campaign_id', id)
      .eq('status', 'pending');

    if (queueError) throw queueError;

    // Log do cancelamento
    await supabase
      .from('bulk_message_logs')
      .insert([{
        campaign_id: id,
        organization_id: organizationId,
        level: 'info',
        message: 'Campanha cancelada pelo usuário'
      }]);

    res.json({ message: 'Campanha cancelada com sucesso' });
  } catch (error) {
    console.error('Erro ao cancelar campanha:', error);
    Sentry.captureException(error);
    res.status(500).json({ error: 'Erro ao cancelar campanha' });
  }
};

/**
 * Pausar campanha em processamento
 */
export const pauseBulkMessageCampaignRoute = async (req, res) => {
  try {
    const { id, organizationId } = req.params;

    // Verificar se a campanha pode ser pausada
    const { data: campaign, error: fetchError } = await supabase
      .from('bulk_message_campaigns')
      .select('status')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .single();

    if (fetchError) throw fetchError;

    if (campaign.status !== 'processing') {
      return res.status(400).json({ error: 'Apenas campanhas em processamento podem ser pausadas' });
    }

    // Atualizar status da campanha
    const { error: campaignError } = await supabase
      .from('bulk_message_campaigns')
      .update({
        status: 'paused'
      })
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (campaignError) throw campaignError;

    // Pausar mensagens pendentes na fila
    const { error: queueError } = await supabase
      .from('bulk_message_queue')
      .update({ status: 'paused' })
      .eq('campaign_id', id)
      .eq('status', 'pending');

    if (queueError) throw queueError;

    // Notificar o processador para pausar em memória
    const processor = getBulkMessageProcessor();
    if (processor) {
      processor.pauseCampaign(id);
    }

    // Log da pausa
    await supabase
      .from('bulk_message_logs')
      .insert([{
        campaign_id: id,
        organization_id: organizationId,
        level: 'info',
        message: 'Campanha pausada pelo usuário'
      }]);

    res.json({ message: 'Campanha pausada com sucesso' });
  } catch (error) {
    console.error('Erro ao pausar campanha:', error);
    Sentry.captureException(error);
    res.status(500).json({ error: 'Erro ao pausar campanha' });
  }
};

/**
 * Despausar/retomar campanha pausada
 */
export const resumeBulkMessageCampaignRoute = async (req, res) => {
  try {
    const { id, organizationId } = req.params;

    // Verificar se a campanha pode ser retomada
    const { data: campaign, error: fetchError } = await supabase
      .from('bulk_message_campaigns')
      .select('status')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .single();

    if (fetchError) throw fetchError;

    if (campaign.status !== 'paused') {
      return res.status(400).json({ error: 'Apenas campanhas pausadas podem ser retomadas' });
    }

    // Atualizar status da campanha para processing
    const { error: campaignError } = await supabase
      .from('bulk_message_campaigns')
      .update({
        status: 'processing'
      })
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (campaignError) throw campaignError;

    // Retomar mensagens pausadas na fila
    const { error: queueError } = await supabase
      .from('bulk_message_queue')
      .update({ status: 'pending' })
      .eq('campaign_id', id)
      .eq('status', 'paused');

    if (queueError) throw queueError;

    // Notificar o processador para retomar em memória
    const processor = getBulkMessageProcessor();
    if (processor) {
      processor.resumeCampaign(id);
    }

    // Log da retomada
    await supabase
      .from('bulk_message_logs')
      .insert([{
        campaign_id: id,
        organization_id: organizationId,
        level: 'info',
        message: 'Campanha retomada pelo usuário'
      }]);

    res.json({ message: 'Campanha retomada com sucesso' });
  } catch (error) {
    console.error('Erro ao retomar campanha:', error);
    Sentry.captureException(error);
    res.status(500).json({ error: 'Erro ao retomar campanha' });
  }
};

/**
 * Buscar fila de mensagens de uma campanha
 */
export const getBulkMessageQueueRoute = async (req, res) => {
  try {
    const { id } = req.params;
    const { organizationId } = req.params;
    const { page = 1, limit = 50, status } = req.query;

    let query = supabase
      .from('bulk_message_queue')
      .select(`
        *,
        customer:customers(id, name),
        channel:chat_channels(id, name, type)
      `)
      .eq('campaign_id', id)
      .eq('organization_id', organizationId);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error, count } = await query
      .order('scheduled_at', { ascending: true })
      .range((page - 1) * limit, page * limit - 1);

    if (error) throw error;

    res.json({
      data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count
      }
    });
  } catch (error) {
    console.error('Erro ao buscar fila:', error);
    Sentry.captureException(error);
    res.status(500).json({ error: 'Erro ao buscar fila' });
  }
};

/**
 * Buscar logs de uma campanha
 */
export const getBulkMessageLogsRoute = async (req, res) => {
  try {
    const { id } = req.params;
    const { organizationId } = req.params;
    const { page = 1, limit = 50, level } = req.query;

    let query = supabase
      .from('bulk_message_logs')
      .select('*')
      .eq('campaign_id', id)
      .eq('organization_id', organizationId);

    if (level) {
      query = query.eq('level', level);
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (error) throw error;

    res.json({
      data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count
      }
    });
  } catch (error) {
    console.error('Erro ao buscar logs:', error);
    Sentry.captureException(error);
    res.status(500).json({ error: 'Erro ao buscar logs' });
  }
};

/**
 * Estimar número de destinatários baseado nos filtros
 */
export const estimateRecipientsRoute = async (req, res) => {
  try {
    const { organizationId } = req.params;
    const { channel_id, stage_ids, tag_ids, custom_field_filters } = req.body;

    if (!channel_id) {
      return res.json({ estimate: 0 });
    }

    // Usar a função SQL para calcular a estimativa
    const { data, error } = await supabase.rpc('estimate_bulk_message_recipients', {
      p_organization_id: organizationId,
      p_channel_id: channel_id,
      p_stage_ids: stage_ids && stage_ids.length > 0 ? stage_ids : null,
      p_tag_ids: tag_ids && tag_ids.length > 0 ? tag_ids : null
    });

    if (error) {
      console.error('Erro na função de estimativa:', error);
      throw error;
    }

    res.json({ estimate: data || 0 });
  } catch (error) {
    console.error('Erro ao estimar destinatários:', error);
    Sentry.captureException(error);
    res.status(500).json({ error: 'Erro ao estimar destinatários' });
  }
}; 