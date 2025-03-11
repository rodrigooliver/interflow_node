import express from 'express';
import { verifyAuth } from '../middleware/auth.js';
import { 
  createCheckoutSession,
  createPortalSession,
  handleWebhook
} from '../controllers/stripe.js';

const router = express.Router({ mergeParams: true });

// Todas as rotas do Stripe precisam de autenticação
router.use(verifyAuth);

// Create Stripe checkout session
router.post('/create-checkout-session', createCheckoutSession);

// Create Stripe customer portal session  
router.post('/create-portal-session', createPortalSession);



export default router;