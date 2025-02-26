import express from 'express';
import Sentry from '../lib/sentry.js';
import { verifyAuth } from '../middleware/auth.js';
import { createMessageRoute } from '../controllers/chat/message-handlers.js';

const router = express.Router({ mergeParams: true });

// Todas as rotas de canal precisam de autenticação
router.use(verifyAuth);

router.post('/:chatId/message', createMessageRoute);


export default router;