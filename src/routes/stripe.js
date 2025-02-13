import express from 'express';
import { verifyAuth } from '../middleware/auth.js';
import { 
  createCheckoutSession,
  createPortalSession,
  handleWebhook
} from '../controllers/stripe.js';

const router = express.Router();

// Create Stripe checkout session
router.post('/create-checkout-session', verifyAuth, createCheckoutSession);

// Create Stripe customer portal session  
router.post('/create-portal-session', verifyAuth, createPortalSession);

// Stripe webhook handler
router.post('/webhook', express.raw({ type: 'application/json' }), handleWebhook);

export default router;