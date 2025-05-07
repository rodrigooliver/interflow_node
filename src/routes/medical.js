import express from 'express';
import Sentry from '../lib/sentry.js';
import { verifyAuth } from '../middleware/auth.js';
import { processDocument } from '../controllers/document.js';
import { handleAttachment, deleteAttachment } from '../controllers/medical/attachment.js';

const router = express.Router({ mergeParams: true });

// Todas as rotas médicas precisam de autenticação
router.use(verifyAuth);

// Rota para processar documentos
router.post('/documents/process', processDocument);

// Rotas para gerenciar anexos médicos
router.post('/attachment', handleAttachment);
router.delete('/attachment', deleteAttachment);

export default router;