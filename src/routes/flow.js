import express from 'express';
import Sentry from '../lib/sentry.js';
import { verifyAuth } from '../middleware/auth.js';
import { createFileRoute, deleteFileRoute } from '../controllers/flow/file.js';
const router = express.Router({ mergeParams: true });

// Todas as rotas de canal precisam de autenticação
router.use(verifyAuth);

router.post('/:flowId/file', createFileRoute);
router.delete('/:flowId/file', deleteFileRoute);

export default router;