import express from 'express';
import { verifyAuth } from '../middleware/auth.js';
import {
  getNotificationTemplates,
  getNotificationTemplate,
  createNotificationTemplate,
  updateNotificationTemplate,
  deleteNotificationTemplate,
  getNotificationSettings,
  createNotificationSetting,
  updateNotificationSetting,
  deleteNotificationSetting,
  processNotificationContent,
  generateAppointmentReminders
} from '../controllers/schedules/scheduleNotifications.js';

const router = express.Router({ mergeParams: true });

// Todas as rotas de notificações precisam de autenticação
router.use(verifyAuth);

// Rotas para templates de notificação
router.get('/templates/schedule/:schedule_id', getNotificationTemplates);
router.get('/templates/:id', getNotificationTemplate);
router.post('/templates', createNotificationTemplate);
router.put('/templates/:id', updateNotificationTemplate);
router.delete('/templates/:id', deleteNotificationTemplate);

// Rotas para configurações de notificação
router.get('/settings/template/:template_id', getNotificationSettings);
// Rota para obter configurações pelo ID do template (caminho mais amigável)
router.get('/templates/:template_id/settings', getNotificationSettings);
router.post('/settings', createNotificationSetting);
router.put('/settings/:id', updateNotificationSetting);
router.delete('/settings/:id', deleteNotificationSetting);

// Rotas para processamento e geração de notificações
router.get('/process/:appointment_id/:template_id', processNotificationContent);
router.post('/generate/:appointment_id', generateAppointmentReminders);

export default router; 