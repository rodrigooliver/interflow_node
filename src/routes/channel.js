import express from 'express';
import Sentry from '../lib/sentry.js';
import { testWapiConnection, generateQrCode, resetWapiConnection, disconnectWapiInstance, createWapiChannel, updateWapiChannel, createInterflowChannel, deleteWapiChannel, transferChats } from '../controllers/channels/wapi.js';
import { testEmailConnection } from '../services/email.js';
import { verifyAuth, verifyPublicAuth } from '../middleware/auth.js';
import { deleteInstagramChannel } from '../controllers/channels/instagram.js';

const router = express.Router({ mergeParams: true });

// Todas as rotas de canal precisam de autenticação
router.use(verifyAuth);

// WhatsApp WApi routes
router.post('/wapi/test', testWapiConnection);
router.post('/wapi/interflow', createInterflowChannel);
router.post('/wapi', createWapiChannel);
router.put('/wapi/:channelId', updateWapiChannel);
router.delete('/wapi/:channelId', deleteWapiChannel);
router.post('/wapi/:channelId/qr', generateQrCode);
router.post('/wapi/:channelId/reset', resetWapiConnection);
router.post('/wapi/:channelId/disconnect', disconnectWapiInstance);
router.post('/wapi/:channelId/transfer', transferChats);
// Test email connection
router.post('/email/test', async (req, res) => {
  try {
    const result = await testEmailConnection(req.body);
    res.json(result);
  } catch (error) {
    Sentry.captureException(error);
    console.error('Error testing email connection:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

router.delete('/instagram/:channelId', deleteInstagramChannel);


export default router;