import express from 'express';
import { verifyAuth } from '../middleware/auth.js';
import { 
  updateMember,
  deleteMember,
  inviteMember,
  joinOrganization,
  testEmailConnection
} from '../controllers/member.js';

const router = express.Router({ mergeParams: true });

// Todas as rotas de member precisam de autenticação
router.use(verifyAuth);

// Rotas de member
router.put('/:id', updateMember);
router.delete('/:id', deleteMember);
router.post('/invite', inviteMember);
router.post('/join', joinOrganization);
router.post('/test-email', testEmailConnection);


export default router;