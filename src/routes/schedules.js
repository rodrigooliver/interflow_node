import express from 'express';
import { verifyAuth } from '../middleware/auth.js';
import notificationRoutes from './scheduleNotifications.js';

const router = express.Router({ mergeParams: true });

// Todas as rotas de prompts precisam de autenticação
router.use(verifyAuth);


// Rotas de notificações de agendamento
router.use('/notifications', notificationRoutes);

export default router; 