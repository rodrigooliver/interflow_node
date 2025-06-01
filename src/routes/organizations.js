import express from 'express';
import { verifyAuthSuperAdmin } from '../middleware/auth.js';
import { deleteOrganizationRoute, updateOrganizationRoute, createOrganizationRoute } from '../controllers/organizations/organizations-handlers.js';

const router = express.Router({ mergeParams: true });

// Todas as rotas do Stripe precisam de autenticação
router.use(verifyAuthSuperAdmin);

//Cadastrar organização
router.post('/', createOrganizationRoute);

//Excluir organização
router.delete('/:organizationId', deleteOrganizationRoute);

//Atualizar organização
router.put('/:organizationId', updateOrganizationRoute);


export default router;