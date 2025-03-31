import express from 'express';
import Sentry from '../lib/sentry.js';
import { verifyAuth } from '../middleware/auth.js';
import { createMessageRoute, deleteMessageRoute } from '../controllers/chat/message-handlers.js';
import { sendWhatsAppTemplateRoute } from '../controllers/channels/whatsapp-official.js';
import { transferChatRoute } from '../controllers/chat/transfer-handlers.js';
import { resolveChatRoute } from '../controllers/chat/resolve-handlers.js';
import { startFlowRoute } from '../controllers/chat/flow-handlers.js';

const router = express.Router({ mergeParams: true });

// Todas as rotas de canal precisam de autenticação
router.use(verifyAuth);

router.post('/transfer', transferChatRoute);
router.post('/:chatId/message', createMessageRoute);
router.delete('/:chatId/message/:messageId', deleteMessageRoute);
router.post('/:chatId/send-template', sendWhatsAppTemplateRoute);
router.post('/:chatId/generate-summary', resolveChatRoute);
router.post('/:chatId/start-flow', startFlowRoute);

export default router;