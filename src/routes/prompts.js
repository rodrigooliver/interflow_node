import express from 'express';
import { verifyAuth } from '../middleware/auth.js';
import { 
  getPrompts,
  getPrompt,
  createPrompt,
  updatePrompt,
  deletePrompt,
  improveTextWithOpenAI,
  uploadImage,
  deleteMedia,
  generatePromptWithOpenAI,
  generateResponseUnknownWithOpenAI
} from '../controllers/prompts.js';

const router = express.Router({ mergeParams: true });

// Todas as rotas de prompts precisam de autenticação
router.use(verifyAuth);

// Rotas de prompts
router.get('/', getPrompts);
router.get('/:id', getPrompt);
router.post('/', createPrompt);
router.put('/:id', updatePrompt);
router.delete('/:id', deletePrompt);
router.post('/:id/media', uploadImage);
router.delete('/:id/media/:mediaId', deleteMedia);

// Rota para melhorar texto com OpenAI usando um prompt específico
router.post('/:id/improve-text', improveTextWithOpenAI);
router.post('/:id/generate-response-unknown', generateResponseUnknownWithOpenAI);
router.post('/generate-prompt', generatePromptWithOpenAI);

export default router; 