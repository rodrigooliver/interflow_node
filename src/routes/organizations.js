import express from 'express';
import { verifyAuthSuperAdmin } from '../middleware/auth.js';
import { deleteOrganizationRoute, updateOrganizationRoute } from '../controllers/organizations/delete-handlers.js';

const router = express.Router({ mergeParams: true });

// Todas as rotas do Stripe precisam de autenticação
router.use(verifyAuthSuperAdmin);

// Excluir organização
router.delete('/:organizationId', deleteOrganizationRoute);
router.put('/:organizationId', updateOrganizationRoute);


export default router;