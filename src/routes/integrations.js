import express from 'express';
import { verifyAuth } from '../middleware/auth.js';
import { 
  createIntegration, 
  updateIntegration, 
  getIntegration,
  validateOpenAIKey,
  testOpenAIPrompt,
  getOpenAIModels
} from '../controllers/integrations.js';

const router = express.Router({ mergeParams: true });

// Todas as rotas de integração precisam de autenticação
router.use(verifyAuth);

// Rotas de integração
router.get('/:id', getIntegration);
router.post('/', createIntegration);
router.put('/:id', updateIntegration);

// Rota específica para validação de chave OpenAI
router.post('/openai/validate', validateOpenAIKey);

// Rota para testar prompts com OpenAI
router.post('/:id/test-prompt', testOpenAIPrompt);

// Rota para buscar modelos disponíveis da OpenAI
router.get('/:id/openai-models', getOpenAIModels);

export default router;