import express from 'express';
import { verifyAuth } from '../middleware/auth.js';
import { 
  updateMember,
  inviteMember
} from '../controllers/member.js';

const router = express.Router({ mergeParams: true });

// Todas as rotas de member precisam de autenticação
router.use(verifyAuth);

// Rotas de member
router.put('/:id', updateMember);
router.post('/invite', inviteMember);

export default router;