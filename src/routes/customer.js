import express from 'express';
import { verifyAuth } from '../middleware/auth.js';
import { createCustomerRoute, importCustomersRoute, deleteCustomerRoute } from '../controllers/customer/customer-handler.js';

const router = express.Router({ mergeParams: true });

// Todas as rotas de canal precisam de autenticação
router.use(verifyAuth);

router.post('/', createCustomerRoute);

//Rota para excluir cliente
router.delete('/:id', deleteCustomerRoute);

//Rota para importar clientes
router.post('/import', importCustomersRoute);

export default router;