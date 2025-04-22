/**
 * IMPORTANTE: Migration Guide para time_before
 * 
 * Estamos migrando o formato de armazenamento do tempo para usar minutos ao invés de string descritiva.
 * Passos para implementar a mudança:
 * 
 * 1. Adicionar a coluna time_before_minutes no banco de dados:
 *    ```sql
 *    -- Migration para adicionar coluna time_before_minutes
 *    ALTER TABLE schedule_notification_settings ADD COLUMN time_before_minutes INTEGER;
 *    
 *    -- Preencher a coluna para dados existentes
 *    UPDATE schedule_notification_settings
 *    SET time_before_minutes = CASE
 *        WHEN time_before LIKE '%minute%' THEN (regexp_replace(time_before, '[^0-9]', '', 'g'))::INTEGER
 *        WHEN time_before LIKE '%hour%' THEN (regexp_replace(time_before, '[^0-9]', '', 'g'))::INTEGER * 60
 *        WHEN time_before LIKE '%day%' THEN (regexp_replace(time_before, '[^0-9]', '', 'g'))::INTEGER * 24 * 60
 *        WHEN time_before LIKE '%week%' THEN (regexp_replace(time_before, '[^0-9]', '', 'g'))::INTEGER * 7 * 24 * 60
 *        ELSE 0
 *    END;
 *    
 *    -- Definir valor padrão e NOT NULL para novos registros
 *    ALTER TABLE schedule_notification_settings 
 *    ALTER COLUMN time_before_minutes SET NOT NULL,
 *    ALTER COLUMN time_before_minutes SET DEFAULT 0;
 *    
 *    -- Adicionar índice para facilitar buscas
 *    CREATE INDEX idx_schedule_notification_settings_time_before_minutes 
 *    ON schedule_notification_settings(time_before_minutes);
 *    ```
 * 
 * 2. Para retro-compatibilidade, mantemos o time_before como string e atualizamos
 *    automaticamente time_before_minutes nos controllers, usando as funções
 *    convertTimeToMinutes e convertMinutesToTimeString
 * 
 * 3. Configure um cron job para chamar processScheduledNotifications periodicamente.
 *    A função já está configurada em backend/src/cron/index.js para executar a cada 5 minutos.
 */

import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';

/**
 * Converte descrição de tempo (e.g., "2 days", "24 hours") em minutos totais
 * @param {string} timeStr - String no formato "X unidade" (e.g., "30 minutes", "1 day")
 * @returns {number} - Total de minutos
 */
function convertTimeToMinutes(timeStr) {
  const parts = timeStr.split(' ');
  const quantity = parseInt(parts[0], 10);
  const unit = parts[1];
  
  if (isNaN(quantity)) {
    const formatError = new Error(`Formato de tempo inválido: ${timeStr}`);
    Sentry.captureException(formatError);
    throw formatError;
  }
  
  switch (unit) {
    case 'minutes':
    case 'minute':
      return quantity;
    case 'hours':
    case 'hour':
      return quantity * 60;
    case 'days':
    case 'day':
      return quantity * 24 * 60;
    case 'weeks':
    case 'week':
      return quantity * 7 * 24 * 60;
    default:
      const unitError = new Error(`Unidade de tempo não reconhecida: ${unit}`);
      Sentry.captureException(unitError);
      throw unitError;
  }
}

/**
 * Converte minutos totais em descrição de tempo
 * @param {number} totalMinutes - Total de minutos
 * @returns {string} - String no formato "X unidade" (e.g., "30 minutes", "1 day")
 */
function convertMinutesToTimeString(totalMinutes) {
  if (totalMinutes % (7 * 24 * 60) === 0 && totalMinutes >= 7 * 24 * 60) {
    const weeks = totalMinutes / (7 * 24 * 60);
    return `${weeks} ${weeks === 1 ? 'week' : 'weeks'}`;
  } else if (totalMinutes % (24 * 60) === 0 && totalMinutes >= 24 * 60) {
    const days = totalMinutes / (24 * 60);
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  } else if (totalMinutes % 60 === 0 && totalMinutes >= 60) {
    const hours = totalMinutes / 60;
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  } else {
    return `${totalMinutes} ${totalMinutes === 1 ? 'minute' : 'minutes'}`;
  }
}

/**
 * Busca todos os templates de notificação de uma agenda
 */
export const getNotificationTemplates = async (req, res, next) => {
  try {
    const { schedule_id } = req.params;
    const { data, error } = await supabase
      .from('schedule_notification_templates')
      .select(`
        *,
        channel:channel_id (
          id,
          name,
          type
        ),
        settings:schedule_notification_settings (
          id,
          time_before,
          active
        )
      `)
      .eq('schedule_id', schedule_id);
      
    if (error) throw error;
    
    res.json({ data });
  } catch (error) {
    console.error('Erro ao buscar templates de notificação:', error);
    Sentry.captureException(error);
    next(error);
  }
};

/**
 * Busca um template de notificação específico
 */
export const getNotificationTemplate = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { language } = req;
    
    const { data, error } = await supabase
      .from('schedule_notification_templates')
      .select(`
        *,
        channel:channel_id (*)
      `)
      .eq('id', id)
      .single();
      
    if (error) throw error;
    
    if (!data) {
      const notFoundError = new Error('Template de notificação não encontrado');
      Sentry.captureException(notFoundError);
      return res.status(404).json({ 
        error: req.t('schedule.notifications.errors.template_not_found'),
        language 
      });
    }
    
    res.json({ data });
  } catch (error) {
    console.error('Erro ao buscar template específico:', error);
    Sentry.captureException(error);
    next(error);
  }
};

/**
 * Cria um novo template de notificação
 */
export const createNotificationTemplate = async (req, res, next) => {
  try {
    const { 
      schedule_id, 
      organization_id, 
      name, 
      channel_id, 
      trigger_type, 
      content, 
      subject, 
      active = true,
      time_settings = []         // Array de configurações de tempo
    } = req.body;
    const { language } = req;
    
    // Validar campos obrigatórios
    if (!schedule_id || !organization_id || !name || !trigger_type || !content) {
      const validationError = new Error('Campos obrigatórios não preenchidos');
      Sentry.captureException(validationError);
      return res.status(400).json({ 
        error: req.t('schedule.notifications.errors.required_fields'),
        language 
      });
    }

    // Verificar se há horários duplicados em time_settings
    if (trigger_type === 'before_appointment' && time_settings.length > 0) {
      const uniqueTimes = new Set(time_settings);
      if (uniqueTimes.size !== time_settings.length) {
        return res.status(400).json({ 
          error: req.t('schedule.notifications.errors.duplicate_times_not_allowed', 'Não é permitido configurar o mesmo horário mais de uma vez'),
          language 
        });
      }
    }

    const dataTemplate = {
        schedule_id,
        organization_id,
        name,
        trigger_type,
        content,
        subject,
        active
    }
    
    // Se o canal for de email, o assunto é obrigatório
    if (channel_id) {
      const { data: channel } = await supabase
        .from('chat_channels')
        .select('type')
        .eq('id', channel_id)
        .single();
        
      if (channel && channel.type === 'email' && !subject) {
        const subjectError = new Error('O assunto é obrigatório para canais de email');
        Sentry.captureException(subjectError);
        return res.status(400).json({ 
          error: req.t('schedule.notifications.errors.email_subject_required'),
          language 
        });
      }

      if(channel) {
        dataTemplate.channel_id = channel_id;
      }
    }

    // Validar configurações de tempo para trigger_type = before_appointment
    if (trigger_type === 'before_appointment' && time_settings.length === 0) {
      const timeError = new Error('O tempo antes do agendamento é obrigatório');
      Sentry.captureException(timeError);
      return res.status(400).json({ 
        error: req.t('schedule.notifications.errors.time_before_required'),
        language 
      });
    }

    // Criar o template
    const { data, error } = await supabase
      .from('schedule_notification_templates')
      .insert(dataTemplate)
      .select()
      .single();
      
    if (error) throw error;
    
    // Se o tipo de gatilho for before_appointment, criar todas as configurações de tempo de uma vez
    if (trigger_type === 'before_appointment' && time_settings.length > 0) {
      // Preparar um array com todas as configurações para inserção em lote
      const settingsToInsert = time_settings.map(timeSetting => ({
        schedule_id,
        organization_id,
        template_id: data.id,
        time_before: timeSetting,                        // Formato descritivo para compatibilidade
        time_before_minutes: convertTimeToMinutes(timeSetting), // Novo campo em minutos
        active: true
      }));
      
      // Inserir todas as configurações de uma vez
      const { error: settingsError } = await supabase
        .from('schedule_notification_settings')
        .insert(settingsToInsert);
        
      if (settingsError) throw settingsError;
    }
    
    // Buscar o template completo com suas configurações
    const { data: completeTemplate, error: fetchError } = await supabase
      .from('schedule_notification_templates')
      .select(`
        *,
        settings:schedule_notification_settings (
          id,
          time_before,
          time_before_minutes,
          active
        )
      `)
      .eq('id', data.id)
      .single();
    
    if (fetchError) throw fetchError;
    
    res.status(201).json({ data: completeTemplate });
  } catch (error) {
    console.error('Erro ao criar template de notificação:', error);
    Sentry.captureException(error);
    next(error);
  }
};

/**
 * Atualiza um template de notificação
 */
export const updateNotificationTemplate = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { 
      name, 
      channel_id, 
      trigger_type, 
      content, 
      subject, 
      active,
      time_settings = [],
      existing_settings = []
    } = req.body;
    const { language } = req;
    
    // Verificar se o template existe
    const { data: existingTemplate, error: fetchError } = await supabase
      .from('schedule_notification_templates')
      .select(`
        *,
        settings:schedule_notification_settings (
          id,
          time_before,
          time_before_minutes,
          active
        )
      `)
      .eq('id', id)
      .single();
      
    if (fetchError || !existingTemplate) {
      const notFoundError = new Error(`Template de notificação não encontrado: ${id}`);
      Sentry.captureException(notFoundError);
      return res.status(404).json({ 
        error: req.t('schedule.notifications.errors.template_not_found'),
        language 
      });
    }

    // Verificar se há horários duplicados em time_settings
    if (trigger_type === 'before_appointment' && time_settings.length > 0) {
      const uniqueTimes = new Set(time_settings);
      if (uniqueTimes.size !== time_settings.length) {
        return res.status(400).json({ 
          error: req.t('schedule.notifications.errors.duplicate_times_not_allowed', 'Não é permitido configurar o mesmo horário mais de uma vez'),
          language 
        });
      }
    }

    let dataTemplate = {
        name,
        trigger_type,
        content,
        subject,
        active
    }
    
    // Se o canal for de email, o assunto é obrigatório
    if (channel_id) {
      const { data: channel } = await supabase
        .from('chat_channels')
        .select('type')
        .eq('id', channel_id)
        .single();
        
      if (channel && channel.type === 'email' && !subject) {
        const subjectError = new Error('O assunto é obrigatório para canais de email');
        Sentry.captureException(subjectError);
        return res.status(400).json({ 
          error: req.t('schedule.notifications.errors.email_subject_required'),
          language 
        });
      }

      if(channel) {
        dataTemplate.channel_id = channel_id;
      }
    }
    
    // Validar configurações de tempo para trigger_type = before_appointment
    if (trigger_type === 'before_appointment' && time_settings.length === 0) {
      const timeError = new Error('O tempo antes do agendamento é obrigatório');
      Sentry.captureException(timeError);
      return res.status(400).json({ 
        error: req.t('schedule.notifications.errors.time_before_required'),
        language 
      });
    }
    
    // Atualizar o template
    const { data, error } = await supabase
      .from('schedule_notification_templates')
      .update(dataTemplate)
      .eq('id', id)
      .select()
      .single();
      
    if (error) throw error;
    
    // Processar as configurações de tempo se for do tipo before_appointment
    if (trigger_type === 'before_appointment') {
      // Abordagem simplificada: excluir todas as configurações existentes primeiro
      console.log(`Excluindo todas as configurações existentes para o template ${id}`);
      const { error: deleteAllError } = await supabase
        .from('schedule_notification_settings')
        .delete()
        .eq('template_id', id);
        
      if (deleteAllError) throw deleteAllError;
      
      // Depois, inserir todas as novas configurações
      if (time_settings && time_settings.length > 0) {
        console.log(`Inserindo ${time_settings.length} novas configurações de tempo`);
        const settingsToInsert = time_settings.map(timeSetting => ({
          schedule_id: existingTemplate.schedule_id,
          organization_id: existingTemplate.organization_id,
          template_id: id,
          time_before: timeSetting,
          time_before_minutes: convertTimeToMinutes(timeSetting),
          active
        }));
        
        const { error: insertError } = await supabase
          .from('schedule_notification_settings')
          .insert(settingsToInsert);
          
        if (insertError) throw insertError;
      }
    } else {
      // Se o tipo de gatilho for alterado para outro que não before_appointment,
      // excluir todas as configurações de tempo
      const { error: deleteError } = await supabase
        .from('schedule_notification_settings')
        .delete()
        .eq('template_id', id);
        
      if (deleteError) throw deleteError;
    }
    
    // Buscar o template atualizado com suas configurações
    const { data: updatedTemplate, error: fetchUpdatedError } = await supabase
      .from('schedule_notification_templates')
      .select(`
        *,
        settings:schedule_notification_settings (
          id,
          time_before,
          time_before_minutes,
          active
        )
      `)
      .eq('id', id)
      .single();
    
    if (fetchUpdatedError) throw fetchUpdatedError;
    
    res.json({ data: updatedTemplate });
  } catch (error) {
    console.error('Erro ao atualizar template de notificação:', error);
    Sentry.captureException(error);
    next(error);
  }
};

/**
 * Exclui um template de notificação
 */
export const deleteNotificationTemplate = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { language } = req;
    
    // Verificar se o template existe
    const { data: existingTemplate, error: fetchError } = await supabase
      .from('schedule_notification_templates')
      .select('id')
      .eq('id', id)
      .single();
      
    if (fetchError || !existingTemplate) {
      const notFoundError = new Error(`Template de notificação não encontrado: ${id}`);
      Sentry.captureException(notFoundError);
      return res.status(404).json({ 
        error: req.t('schedule.notifications.errors.template_not_found'),
        language 
      });
    }
    
    // Excluir configurações associadas primeiro (devido à restrição de chave estrangeira)
    await supabase
      .from('schedule_notification_settings')
      .delete()
      .eq('template_id', id);
    
    // Agora excluir o template
    const { error } = await supabase
      .from('schedule_notification_templates')
      .delete()
      .eq('id', id);
      
    if (error) throw error;
    
    res.status(204).send();
  } catch (error) {
    console.error('Erro ao excluir template de notificação:', error);
    Sentry.captureException(error);
    next(error);
  }
};

/**
 * Busca todas as configurações de notificação de um template
 */
export const getNotificationSettings = async (req, res, next) => {
  try {
    const { template_id } = req.params;
    
    const { data, error } = await supabase
      .from('schedule_notification_settings')
      .select('*')
      .eq('template_id', template_id);
      
    if (error) throw error;
    
    res.json({ data });
  } catch (error) {
    console.error('Erro ao buscar configurações de notificação:', error);
    Sentry.captureException(error);
    next(error);
  }
};

/**
 * Cria uma nova configuração de notificação
 */
export const createNotificationSetting = async (req, res, next) => {
  try {
    const { 
      schedule_id, 
      organization_id, 
      template_id, 
      time_before, 
      active = true 
    } = req.body;
    const { language } = req;
    
    // Validar campos obrigatórios
    if (!schedule_id || !organization_id || !template_id) {
      const validationError = new Error('Campos obrigatórios não preenchidos');
      Sentry.captureException(validationError);
      return res.status(400).json({ 
        error: req.t('schedule.notifications.errors.required_fields'),
        language 
      });
    }
    
    // Verificar se o template existe e tem trigger_type = before_appointment
    const { data: template, error: templateError } = await supabase
      .from('schedule_notification_templates')
      .select('trigger_type')
      .eq('id', template_id)
      .single();
      
    if (templateError || !template) {
      const notFoundError = new Error(`Template de notificação não encontrado: ${template_id}`);
      Sentry.captureException(notFoundError);
      return res.status(404).json({ 
        error: req.t('schedule.notifications.errors.template_not_found'),
        language 
      });
    }
    
    // Para before_appointment, precisamos do time_before
    if (template.trigger_type === 'before_appointment' && !time_before) {
      const timeError = new Error('O tempo antes do agendamento é obrigatório');
      Sentry.captureException(timeError);
      return res.status(400).json({ 
        error: req.t('schedule.notifications.errors.time_before_required'),
        language 
      });
    }
    
    // Calcular time_before_minutes para o formato descritivo time_before
    let time_before_minutes;
    if (time_before) {
      time_before_minutes = convertTimeToMinutes(time_before);
    }
    
    const { data, error } = await supabase
      .from('schedule_notification_settings')
      .insert({
        schedule_id,
        organization_id,
        template_id,
        time_before,
        time_before_minutes,
        active
      })
      .select()
      .single();
      
    if (error) throw error;
    
    res.status(201).json({ data });
  } catch (error) {
    console.error('Erro ao criar configuração de notificação:', error);
    Sentry.captureException(error);
    next(error);
  }
};

/**
 * Atualiza uma configuração de notificação
 */
export const updateNotificationSetting = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { time_before, active } = req.body;
    const { language } = req;
    
    // Verificar se a configuração existe
    const { data: existingSetting, error: fetchError } = await supabase
      .from('schedule_notification_settings')
      .select('template_id')
      .eq('id', id)
      .single();
      
    if (fetchError || !existingSetting) {
      const notFoundError = new Error(`Configuração de notificação não encontrada: ${id}`);
      Sentry.captureException(notFoundError);
      return res.status(404).json({ 
        error: req.t('schedule.notifications.errors.setting_not_found'),
        language 
      });
    }
    
    // Verificar o tipo de gatilho do template associado
    const { data: template, error: templateError } = await supabase
      .from('schedule_notification_templates')
      .select('trigger_type')
      .eq('id', existingSetting.template_id)
      .single();
      
    if (templateError || !template) {
      const notFoundError = new Error(`Template de notificação não encontrado: ${existingSetting.template_id}`);
      Sentry.captureException(notFoundError);
      return res.status(404).json({ 
        error: req.t('schedule.notifications.errors.template_not_found'),
        language 
      });
    }
    
    // Para before_appointment, precisamos do time_before
    if (template.trigger_type === 'before_appointment' && !time_before) {
      const timeError = new Error('O tempo antes do agendamento é obrigatório');
      Sentry.captureException(timeError);
      return res.status(400).json({ 
        error: req.t('schedule.notifications.errors.time_before_required'),
        language 
      });
    }
    
    // Calcular time_before_minutes para o formato descritivo time_before
    let updateData = { active };
    
    if (time_before) {
      updateData.time_before = time_before;
      updateData.time_before_minutes = convertTimeToMinutes(time_before);
    }
    
    // Atualizar a configuração
    const { data, error } = await supabase
      .from('schedule_notification_settings')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();
      
    if (error) throw error;
    
    res.json({ data });
  } catch (error) {
    console.error('Erro ao atualizar configuração de notificação:', error);
    Sentry.captureException(error);
    next(error);
  }
};

/**
 * Exclui uma configuração de notificação
 */
export const deleteNotificationSetting = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { language } = req;
    
    // Verificar se a configuração existe
    const { data: existingSetting, error: fetchError } = await supabase
      .from('schedule_notification_settings')
      .select('id')
      .eq('id', id)
      .single();
      
    if (fetchError || !existingSetting) {
      const notFoundError = new Error(`Configuração de notificação não encontrada: ${id}`);
      Sentry.captureException(notFoundError);
      return res.status(404).json({ 
        error: req.t('schedule.notifications.errors.setting_not_found'),
        language 
      });
    }
    
    // Excluir a configuração
    const { error } = await supabase
      .from('schedule_notification_settings')
      .delete()
      .eq('id', id);
      
    if (error) throw error;
    
    res.status(204).send();
  } catch (error) {
    console.error('Erro ao excluir configuração de notificação:', error);
    Sentry.captureException(error);
    next(error);
  }
};

/**
 * Processa uma notificação para um agendamento
 * Substitui as variáveis do template com os dados do agendamento
 */
export const processNotificationContent = async (req, res, next) => {
  try {
    const { appointment_id, template_id } = req.params;
    const { language } = req;
    
    // Validar campos obrigatórios
    if (!appointment_id || !template_id) {
      const validationError = new Error('IDs do agendamento e do template são obrigatórios');
      Sentry.captureException(validationError);
      return res.status(400).json({ 
        error: req.t('schedule.notifications.errors.appointment_template_required'),
        language 
      });
    }
    
    // Buscar o template de notificação
    const { data: template, error: templateError } = await supabase
      .from('schedule_notification_templates')
      .select('content, subject')
      .eq('id', template_id)
      .single();
      
    if (templateError || !template) {
      const notFoundError = new Error(`Template de notificação não encontrado: ${template_id}`);
      Sentry.captureException(notFoundError);
      return res.status(404).json({ 
        error: req.t('schedule.notifications.errors.template_not_found'),
        language 
      });
    }
    
    // Buscar dados do agendamento e informações relacionadas
    const { data: appointment, error: appointmentError } = await supabase
      .from('appointments')
      .select(`
        *,
        schedule:schedule_id (
          title,
          organization:organization_id (name)
        ),
        service:service_id (title),
        provider:provider_id (full_name),
        customer:customer_id (name)
      `)
      .eq('id', appointment_id)
      .single();
      
    if (appointmentError || !appointment) {
      const notFoundError = new Error(`Agendamento não encontrado: ${appointment_id}`);
      Sentry.captureException(notFoundError);
      return res.status(404).json({ 
        error: req.t('schedule.notifications.errors.appointment_not_found'),
        language 
      });
    }
    
    // Formatar datas
    const date = new Date(appointment.date);
    const formattedDate = `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getFullYear()}`;
    
    // Start time e end time já estão como strings HH:MM:SS
    const startTime = appointment.start_time.slice(0, 5); // HH:MM
    const endTime = appointment.end_time.slice(0, 5); // HH:MM
    
    // Valores para substituir nas variáveis
    const replacementValues = {
      '{{name}}': appointment.customer?.name || 'Cliente',
      '{{provider}}': appointment.provider?.full_name || 'Profissional',
      '{{service}}': appointment.service?.title || 'Serviço',
      '{{schedule}}': appointment.schedule?.title || 'Agenda',
      '{{date}}': formattedDate,
      '{{hour}}': startTime,
      '{{start_time}}': startTime,
      '{{end_time}}': endTime,
      '{{organization}}': appointment.schedule?.organization?.name || 'Empresa'
    };
    
    // Substituir as variáveis no conteúdo
    let processedContent = template.content;
    for (const [variable, value] of Object.entries(replacementValues)) {
      processedContent = processedContent.replace(new RegExp(variable, 'g'), value);
    }
    
    // Substituir as variáveis no assunto (se existir)
    let processedSubject = null;
    if (template.subject) {
      processedSubject = template.subject;
      for (const [variable, value] of Object.entries(replacementValues)) {
        processedSubject = processedSubject.replace(new RegExp(variable, 'g'), value);
      }
    }
    
    res.json({
      data: {
        content: processedContent,
        subject: processedSubject
      }
    });
  } catch (error) {
    console.error('Erro ao processar conteúdo da notificação:', error);
    Sentry.captureException(error);
    next(error);
  }
};

/**
 * Gera lembretes para um agendamento com base nas configurações de notificação
 */
export const generateAppointmentReminders = async (req, res, next) => {
  try {
    const { appointment_id } = req.params;
    const { language } = req;
    
    // Buscar o agendamento
    const { data: appointment, error: appointmentError } = await supabase
      .from('appointments')
      .select('id, schedule_id, date, start_time, status')
      .eq('id', appointment_id)
      .single();
      
    if (appointmentError || !appointment) {
      const notFoundError = new Error(`Agendamento não encontrado: ${appointment_id}`);
      Sentry.captureException(notFoundError);
      return res.status(404).json({ 
        error: req.t('schedule.notifications.errors.appointment_not_found'),
        language 
      });
    }
    
    // Buscar a agenda para obter o timezone
    const { data: schedule, error: scheduleError } = await supabase
      .from('schedules')
      .select('timezone')
      .eq('id', appointment.schedule_id)
      .single();
      
    if (scheduleError || !schedule) {
      const notFoundError = new Error(`Agenda não encontrada: ${appointment.schedule_id}`);
      Sentry.captureException(notFoundError);
      return res.status(404).json({ 
        error: req.t('schedule.notifications.errors.schedule_not_found'),
        language 
      });
    }
    
    // Buscar templates e configurações de notificação ativos para a agenda
    const { data: notificationSettings, error: settingsError } = await supabase
      .from('schedule_notification_settings')
      .select(`
        *,
        template:template_id (
          id,
          trigger_type,
          channel_id
        )
      `)
      .eq('schedule_id', appointment.schedule_id)
      .eq('active', true)
      .filter('template.active', 'eq', true);
      
    if (settingsError) throw settingsError;
    
    // Preparar a data e hora do agendamento
    const appointmentDateTime = new Date(`${appointment.date}T${appointment.start_time}`);
    
    // Lembretes criados
    const createdReminders = [];
    
    // Para cada configuração de notificação
    for (const setting of notificationSettings) {
      // Pular se o template não estiver disponível
      if (!setting.template) continue;
      
      // Tratar diferentes tipos de gatilho
      if (setting.template.trigger_type === 'before_appointment' && setting.time_before) {
        // Calcular o horário para enviar a notificação
        const scheduledTime = new Date(appointmentDateTime.getTime() - parseTimeInterval(setting.time_before));
        
        // Só programar se o horário for no futuro
        if (scheduledTime > new Date()) {
          const { data: reminder, error: reminderError } = await supabase
            .from('appointment_reminders')
            .insert({
              appointment_id,
              channel_id: setting.template.channel_id,
              status: 'pending',
              scheduled_for: scheduledTime.toISOString(),
              template_id: setting.template.id,
              setting_id: setting.id
            })
            .select()
            .single();
            
          if (reminderError) throw reminderError;
          
          createdReminders.push(reminder);
        }
      } else if (setting.template.trigger_type === 'on_confirmation' && appointment.status === 'confirmed') {
        // Enviar imediatamente quando confirmado
        const { data: reminder, error: reminderError } = await supabase
          .from('appointment_reminders')
          .insert({
            appointment_id,
            channel_id: setting.template.channel_id,
            status: 'pending',
            scheduled_for: new Date().toISOString(),
            template_id: setting.template.id,
            setting_id: setting.id
          })
          .select()
          .single();
          
        if (reminderError) throw reminderError;
        
        createdReminders.push(reminder);
      } else if (setting.template.trigger_type === 'on_cancellation' && appointment.status === 'canceled') {
        // Enviar imediatamente quando cancelado
        const { data: reminder, error: reminderError } = await supabase
          .from('appointment_reminders')
          .insert({
            appointment_id,
            channel_id: setting.template.channel_id,
            status: 'pending',
            scheduled_for: new Date().toISOString(),
            template_id: setting.template.id,
            setting_id: setting.id
          })
          .select()
          .single();
          
        if (reminderError) throw reminderError;
        
        createdReminders.push(reminder);
      }
      // Outros tipos de gatilho podem ser implementados aqui
    }
    
    res.json({
      data: {
        reminders_created: createdReminders.length,
        reminders: createdReminders
      }
    });
  } catch (error) {
    console.error('Erro ao gerar lembretes para agendamento:', error);
    Sentry.captureException(error);
    next(error);
  }
};

/**
 * Função auxiliar para converter strings de intervalo de tempo em milissegundos
 * @deprecated Use convertTimeToMinutes com multiplicador de milissegundos se necessário
 */
function parseTimeInterval(timeStr) {
  const minutes = convertTimeToMinutes(timeStr);
  return minutes * 60 * 1000; // Converter minutos para milissegundos
}

/**
 * Função de processamento de notificações - versão independente para uso em cron jobs
 * Esta função contém a lógica principal e pode ser chamada diretamente pelo cron
 * 
 * Utiliza o sistema de sincronização para processar apenas agendamentos que:
 * 1. Ainda não tiveram seus lembretes criados (needs_reminders_sync = true)
 * 2. Estão dentro da janela de tempo relevante
 */
export const processScheduledNotifications = async () => {
  try {
    // console.log('Iniciando processamento de notificações programadas');
    
    // Obter hora atual
    const currentTime = new Date();
    
    // Definir janela de tempo para verificação (próximas 48 horas)
    // Isso limita a busca apenas aos agendamentos que podem precisar de notificações em breve
    const endTimeWindow = new Date(currentTime);
    endTimeWindow.setHours(currentTime.getHours() + 48);
    
    // Formato das datas para o banco: YYYY-MM-DD
    const todayFormatted = currentTime.toISOString().split('T')[0];
    const endDateFormatted = endTimeWindow.toISOString().split('T')[0];
    
    console.log(`Janela de tempo: ${todayFormatted} até ${endDateFormatted}`);
    
    // 1. Buscar templates ativos para notificações do tipo before_appointment
    const { data: templates, error: templatesError } = await supabase
      .from('schedule_notification_templates')
      .select(`
        id, 
        schedule_id,
        channel_id,
        trigger_type, 
        settings:schedule_notification_settings(
          id, 
          time_before_minutes,
          active
        )
      `)
      .eq('active', true)
      .eq('trigger_type', 'before_appointment');
      
    if (templatesError) throw templatesError;
    
    if (!templates || templates.length === 0) {
      // console.log('Nenhum template ativo encontrado, finalizando processamento');
      return {
        appointments_processed: 0,
        reminders_created: 0,
        reminders: []
      };
    }
    
    // Extrair todos os tempos antes para calcular o período máximo
    const allTimeBeforeMinutes = templates
      .flatMap(t => t.settings?.map(s => s.time_before_minutes) || [])
      .filter(Boolean);
    
    if (allTimeBeforeMinutes.length === 0) {
      // console.log('Nenhuma configuração de tempo encontrada, finalizando processamento');
      return {
        appointments_processed: 0,
        reminders_created: 0,
        reminders: []
      };
    }
    
    // Obter o tempo máximo em minutos para todas as configurações
    const maxTimeBeforeMinutes = Math.max(...allTimeBeforeMinutes);
    console.log(`Tempo máximo de antecedência: ${maxTimeBeforeMinutes} minutos (${Math.round(maxTimeBeforeMinutes/60)} horas)`);
    
    // 2. Buscar apenas agendamentos que necessitam sincronização dentro da janela de tempo relevante
    const { data: appointments, error: appointmentsError } = await supabase
      .from('appointments')
      .select(`
        id, 
        schedule_id, 
        date, 
        start_time,
        status
      `)
      .eq('needs_reminders_sync', true) // Apenas agendamentos não sincronizados
      .gte('date', todayFormatted)
      .lte('date', endDateFormatted)
      .in('status', ['scheduled', 'confirmed']) 
      .order('date', { ascending: true })
      .order('start_time', { ascending: true });
      
    if (appointmentsError) throw appointmentsError;
    
    console.log(`Encontrados ${appointments?.length || 0} agendamentos não sincronizados na janela de tempo`);
    
    if (!appointments || appointments.length === 0) {
      return {
        appointments_processed: 0,
        reminders_created: 0,
        reminders: []
      };
    }
    
    // Agrupar os IDs de agendamentos por agenda para otimizar o processamento
    const appointmentsBySchedule = {};
    appointments.forEach(appointment => {
      if (!appointmentsBySchedule[appointment.schedule_id]) {
        appointmentsBySchedule[appointment.schedule_id] = [];
      }
      appointmentsBySchedule[appointment.schedule_id].push(appointment);
    });
    
    // 3. Processar cada agendamento e gerar lembretes necessários
    const createdReminders = [];
    const processedAppointmentIds = [];
    
    for (const scheduleId in appointmentsBySchedule) {
      // Filtrar templates relevantes para esta agenda
      const scheduleTemplates = templates.filter(t => t.schedule_id === scheduleId);
      
      if (scheduleTemplates.length === 0) {
        console.log(`Nenhum template ativo para a agenda ${scheduleId}, marcando agendamentos como sincronizados`);
        // Mesmo sem templates, marcar como sincronizados para evitar verificações repetidas
        const appointmentIds = appointmentsBySchedule[scheduleId].map(a => a.id);
        await markAppointmentsAsSynced(appointmentIds);
        processedAppointmentIds.push(...appointmentIds);
        continue;
      }
      
      // Processar cada agendamento desta agenda
      for (const appointment of appointmentsBySchedule[scheduleId]) {
        const appointmentDateTime = new Date(`${appointment.date}T${appointment.start_time}`);
        let appointmentProcessed = false;
        
        // Para cada template relevante
        for (const template of scheduleTemplates) {
          // Pular templates sem configurações de tempo
          if (!template.settings || template.settings.length === 0) continue;
          
          // Para cada configuração de tempo
          for (const setting of template.settings) {
            // Pular configurações inativas
            if (!setting.active) continue;
            
            // Calcular quando a notificação deve ser enviada
            const minutesBeforeAppointment = setting.time_before_minutes;
            const notificationTime = new Date(appointmentDateTime.getTime() - (minutesBeforeAppointment * 60 * 1000));
            
            // Verificar se o lembrete já existe para este agendamento e configuração
            const { data: existingReminders, error: remindersError } = await supabase
              .from('appointment_reminders')
              .select('id')
              .eq('appointment_id', appointment.id)
              .eq('template_id', template.id)
              .eq('setting_id', setting.id);
              
            if (remindersError) throw remindersError;
            
            // Se não existe, criar o lembrete
            if (!existingReminders || existingReminders.length === 0) {
              console.log(`Criando lembrete para agendamento ${appointment.id}, template ${template.id}, ${minutesBeforeAppointment} minutos antes`);
              
              const { data: reminder, error: reminderError } = await supabase
                .from('appointment_reminders')
                .insert({
                  appointment_id: appointment.id,
                  channel_id: template.channel_id,
                  status: 'pending',
                  scheduled_for: notificationTime.toISOString(),
                  template_id: template.id,
                  setting_id: setting.id
                })
                .select()
                .single();
                
              if (reminderError) throw reminderError;
              
              createdReminders.push(reminder);
              appointmentProcessed = true;
            }
          }
        }
        
        // Marcar este agendamento como processado para atualização posterior
        processedAppointmentIds.push(appointment.id);
      }
    }
    
    // 4. Atualizar o status de sincronização dos agendamentos processados
    if (processedAppointmentIds.length > 0) {
      await markAppointmentsAsSynced(processedAppointmentIds);
      console.log(`Marcados ${processedAppointmentIds.length} agendamentos como sincronizados`);
    }
    
    console.log(`Processamento concluído. ${createdReminders.length} lembretes criados.`);
    
    return {
      appointments_processed: processedAppointmentIds.length,
      reminders_created: createdReminders.length,
      reminders: createdReminders
    };
  } catch (error) {
    console.error('Erro ao processar notificações programadas:', error);
    Sentry.captureException(error);
    throw error;
  }
};

/**
 * Marca um conjunto de agendamentos como sincronizados
 * @param {string[]} appointmentIds - Array de IDs de agendamentos
 */
async function markAppointmentsAsSynced(appointmentIds) {
  if (!appointmentIds || appointmentIds.length === 0) return;
  
  const { error } = await supabase
    .from('appointments')
    .update({
      needs_reminders_sync: false,
      reminders_synced_at: new Date().toISOString()
    })
    .in('id', appointmentIds);
    
  if (error) {
    console.error('Erro ao marcar agendamentos como sincronizados:', error);
    Sentry.captureException(error);
    throw error;
  }
}

/**
 * Função para verificar e gerar notificações programadas (para uso com cron)
 * Este endpoint deve ser chamado periodicamente para verificar notificações a serem enviadas
 */
export const checkAndSendScheduledNotifications = async (req, res, next) => {
  try {
    const result = await processScheduledNotifications();
    res.json({ data: result });
  } catch (error) {
    console.error('Erro ao verificar notificações programadas:', error);
    Sentry.captureException(error);
    next(error);
  }
}; 