import express from 'express';
import Sentry from '../lib/sentry.js';
import { verifyAuth } from '../middleware/auth.js';
import { processDocument } from '../controllers/document.js';

const router = express.Router({ mergeParams: true });

// Todas as rotas médicas precisam de autenticação
router.use(verifyAuth);

// Rota para processar documentos
router.post('/documents/process', processDocument);

export default router;