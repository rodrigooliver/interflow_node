import express from 'express';
import { verifyAuth } from '../middleware/auth.js';
import { 
  createTaskRoute, 
  updateTaskRoute, 
  deleteTaskRoute, 
  startTaskRoute, 
  completeTaskRoute, 
  cancelTaskRoute 
} from '../controllers/tasks/task-handlers.js';

const router = express.Router({ mergeParams: true });

// Todas as rotas de canal precisam de autenticação
router.use(verifyAuth);

//Cadastrar tarefas
router.post('/', createTaskRoute);

//Atualizar tarefas
router.put('/:id', updateTaskRoute);

//Excluir tarefas
router.delete('/:id', deleteTaskRoute);

//Alterar para em andamento
router.put('/:id/start', startTaskRoute);

//Alterar para concluído
router.put('/:id/complete', completeTaskRoute);

//Alterar para cancelado
router.put('/:id/cancel', cancelTaskRoute);


export default router;