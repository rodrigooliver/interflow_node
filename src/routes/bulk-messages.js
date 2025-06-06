import express from 'express';
import { verifyAuth } from '../middleware/auth.js';
import { 
  createBulkMessageCampaignRoute,
  updateBulkMessageCampaignRoute,
  deleteBulkMessageCampaignRoute,
  getBulkMessageCampaignsRoute,
  getBulkMessageCampaignRoute,
  startBulkMessageCampaignRoute,
  cancelBulkMessageCampaignRoute,
  getBulkMessageQueueRoute,
  getBulkMessageLogsRoute,
  estimateRecipientsRoute,
  pauseBulkMessageCampaignRoute,
  resumeBulkMessageCampaignRoute
} from '../controllers/bulk-messages/bulk-message-handlers.js';

const router = express.Router({ mergeParams: true });

// Todas as rotas precisam de autenticação
router.use(verifyAuth);

// Rotas para campanhas
router.get('/', getBulkMessageCampaignsRoute);
router.get('/:id', getBulkMessageCampaignRoute);
router.post('/', createBulkMessageCampaignRoute);
router.put('/:id', updateBulkMessageCampaignRoute);
router.delete('/:id', deleteBulkMessageCampaignRoute);

// Rotas para controle de campanha
router.post('/:id/start', startBulkMessageCampaignRoute);
router.post('/:id/cancel', cancelBulkMessageCampaignRoute);
router.post('/:id/pause', pauseBulkMessageCampaignRoute);
router.post('/:id/resume', resumeBulkMessageCampaignRoute);

// Rotas para fila e logs
router.get('/:id/queue', getBulkMessageQueueRoute);
router.get('/:id/logs', getBulkMessageLogsRoute);

// Rota para estimar destinatários
router.post('/estimate-recipients', estimateRecipientsRoute);

export default router; 