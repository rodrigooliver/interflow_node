import { supabase } from '../../lib/supabase.js';
import Sentry from '../../lib/sentry.js';
import { sendNotificationWithFilters } from '../chat/notification-helpers.js';
import dotenv from 'dotenv';

dotenv.config();

const FRONT_URL = process.env.FRONTEND_URL || 'https://app.interflow.ai';

// Iniciar tarefa (pending -> in_progress)
export const startTaskRoute = async (req, res) => {
  console.log('Iniciando tarefa');
  try {
    const { profileId } = req;
    const { language } = req;
    const { id: taskId, organizationId } = req.params;

    // Verificar se a tarefa existe e pertence à organização
    const { data: task, error: fetchError } = await supabase
      .from('tasks')
      .select(`
        *, 
        project:task_projects(members:task_project_members(id, user_id))
        `
      )
      .eq('id', taskId)
      .eq('organization_id', organizationId)
      .single();

    if (fetchError || !task) {
      return res.status(404).json({
        error: 'Tarefa não encontrada ou não pertence à organização'
      });
    }

    // Verificar se a tarefa pode ser iniciada
    if (task.status !== 'pending') {
      return res.status(400).json({
        error: 'A tarefa não pode ser iniciada. Status atual: ' + task.status
      });
    }

    // Atualizar status para in_progress
    const { data: updatedTask, error: updateError } = await supabase
      .from('tasks')
      .update({
        status: 'in_progress',
        updated_at: new Date().toISOString()
      })
      .eq('id', taskId)
      .select()
      .single();

    if (updateError) {
      console.error('Erro ao iniciar tarefa:', updateError);
      return res.status(500).json({ error: 'Erro interno do servidor' });
    }

    // TODO: Registrar histórico de alteração
    // Enviar notificação para usuários assignados
    let userIds = [];
    if (task.project.members) {
      task.project.members.forEach(member => {
        userIds.push(member.user_id);
      });
    }

    if (userIds.length > 0) {
      try {
        sendNotificationWithFilters(userIds, {
          heading: req.t('tasks.notifications.started_title') || 'Tarefa iniciada',
          content: task.title || 'Tarefa iniciada',
          data: {
            url: `${FRONT_URL}/app/tasks/${task.id}`,
            task_id: task.id,
            organizationId,
            type: 'task_started',
            language
          }
        });
      } catch (notificationError) {
        console.error('Erro ao enviar notificação:', notificationError);
        // Não falha a operação se a notificação falhar
      }
    }

    res.json({
      message: 'Tarefa iniciada com sucesso',
      task: updatedTask
    });

  } catch (error) {
    console.error('Erro ao iniciar tarefa:', error);
    Sentry.captureException(error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
};

// Concluir tarefa (in_progress -> completed)
export const completeTaskRoute = async (req, res) => {
  try {
    const { language } = req;
    const { id: taskId, organizationId } = req.params;

    // Verificar se a tarefa existe e pertence à organização
    const { data: task, error: fetchError } = await supabase
      .from('tasks')
      .select(`*, 
        project:task_projects(members:task_project_members(id, user_id))
        `
      )
      .eq('id', taskId)
      .eq('organization_id', organizationId)
      .single();

    if (fetchError || !task) {
      return res.status(404).json({
        error: 'Tarefa não encontrada ou não pertence à organização'
      });
    }

    // Verificar se a tarefa pode ser concluída
    if (task.status !== 'in_progress') {
      return res.status(400).json({
        error: 'A tarefa não pode ser concluída. Status atual: ' + task.status
      });
    }

    // Atualizar status para completed
    const { data: updatedTask, error: updateError } = await supabase
      .from('tasks')
      .update({
        status: 'completed',
        updated_at: new Date().toISOString()
      })
      .eq('id', taskId)
      .select()
      .single();

    if (updateError) {
      console.error('Erro ao concluir tarefa:', updateError);
      return res.status(500).json({ error: 'Erro interno do servidor' });
    }

    // TODO: Registrar histórico de alteração
    // Enviar notificação para usuários assignados e para user que cadastrou user_id
    let userIds = [];
    if (task.project.members) {
      task.project.members.forEach(member => {
        userIds.push(member.user_id);
      });
    }

    if (userIds.length > 0) {
      try {
        sendNotificationWithFilters(userIds, {
          heading: req.t('tasks.notifications.completed_title'),
          content: task.title || 'Tarefa concluída',
          data: {
            url: `${FRONT_URL}/app/tasks/${task.id}`,
            task_id: task.id,
            organizationId,
            type: 'task_completed',
            language
          }
        });
      } catch (notificationError) {
        console.error('Erro ao enviar notificação:', notificationError);
        // Não falha a operação se a notificação falhar
      }
    }

    res.json({
      message: 'Tarefa concluída com sucesso',
      task: updatedTask
    });

  } catch (error) {
    console.error('Erro ao concluir tarefa:', error);
    Sentry.captureException(error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
};

// Cancelar tarefa (qualquer status -> cancelled)
export const cancelTaskRoute = async (req, res) => {
  try {
    const { language } = req;
    const { id: taskId, organizationId } = req.params;

    // Verificar se a tarefa existe e pertence à organização
    const { data: task, error: fetchError } = await supabase
      .from('tasks')
      .select(`*, 
        project:task_projects(members:task_project_members(id, user_id))
        `
      )
      .eq('id', taskId)
      .eq('organization_id', organizationId)
      .single();

    if (fetchError || !task) {
      return res.status(404).json({
        error: 'Tarefa não encontrada ou não pertence à organização'
      });
    }

    // Verificar se a tarefa pode ser cancelada
    if (task.status === 'cancelled') {
      return res.status(400).json({
        error: 'A tarefa já está cancelada'
      });
    }

    // Atualizar status para cancelled
    const { data: updatedTask, error: updateError } = await supabase
      .from('tasks')
      .update({
        status: 'cancelled',
        updated_at: new Date().toISOString()
      })
      .eq('id', taskId)
      .select()
      .single();

    if (updateError) {
      console.error('Erro ao cancelar tarefa:', updateError);
      return res.status(500).json({ error: 'Erro interno do servidor' });
    }

    // TODO: Registrar histórico de alteração
    // Enviar notificação para usuários assignados
    let userIds = [];
    if (task.project.members) {
      task.project.members.forEach(member => {
        userIds.push(member.user_id);
      });
    }

    if (userIds.length > 0) {
      try {
        sendNotificationWithFilters(userIds, {
          heading: req.t('tasks.notifications.cancelled_title'),
          content: task.title || 'Tarefa cancelada',
          data: {
            url: `${FRONT_URL}/app/tasks/${task.id}`,
            task_id: task.id,
            organizationId,
            type: 'task_cancelled',
            language
          }
        });
      } catch (notificationError) {
        console.error('Erro ao enviar notificação:', notificationError);
        // Não falha a operação se a notificação falhar
      }
    }

    res.json({
      message: 'Tarefa cancelada com sucesso',
      task: updatedTask
    });

  } catch (error) {
    console.error('Erro ao cancelar tarefa:', error);
    Sentry.captureException(error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
};

// Criar tarefa
export const createTaskRoute = async (req, res) => {
  // TODO: Implementar criação de tarefas
  res.status(501).json({ error: 'Não implementado ainda' });
};

// Atualizar tarefa
export const updateTaskRoute = async (req, res) => {
  // TODO: Implementar atualização de tarefas
  res.status(501).json({ error: 'Não implementado ainda' });
};

// Excluir tarefa
export const deleteTaskRoute = async (req, res) => {
  // TODO: Implementar exclusão de tarefas
  res.status(501).json({ error: 'Não implementado ainda' });
};