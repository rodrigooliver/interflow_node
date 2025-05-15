import express from 'express';
import { verifyAuthProfile } from '../middleware/auth.js';
import { 
  stripeAccountOnboarding,
  stripeAccountManager
} from '../controllers/stripe.js';
import { getPartnerOrganization } from '../controllers/organization.js';

const router = express.Router({ mergeParams: true });

// Todas as rotas do Stripe precisam de autenticaçãox
router.use(verifyAuthProfile);

// Create Stripe checkout session
router.post('/account-stripe/onboarding', stripeAccountOnboarding);
router.post('/account-stripe/manage', stripeAccountManager);
router.get('/partner/organizations', getPartnerOrganization);

export default router;