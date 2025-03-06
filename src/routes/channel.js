import express from 'express';
import Sentry from '../lib/sentry.js';
import { testWapiConnection, generateQrCode, resetWapiConnection, disconnectWapiInstance, createWapiChannel, updateWapiChannel, createInterflowChannel, deleteWapiChannel, transferChats } from '../controllers/channels/wapi.js';
import { testEmailConnection } from '../services/email.js';
import { verifyAuth, verifyPublicAuth } from '../middleware/auth.js';
import { deleteInstagramChannel } from '../controllers/channels/instagram.js';
import { handleWhatsAppConnect, getWhatsAppTemplates, createWhatsAppTemplate, updateWhatsAppTemplate, deleteWhatsAppTemplate } from '../controllers/channels/whatsapp-official.js';
import { processWhatsAppStep } from '../controllers/channels/whatsapp-embedded.js';

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
router.post('/wapi/:channelId/test', testWapiConnection);

// WhatsApp Official API routes
router.post('/whatsapp/:channelId/setup', async (req, res) => {
  try {
    const { channelId } = req.params;
    const organizationId = req.params.organizationId || req.body.organizationId;
    const { accessToken, sessionInfo } = req.body;
    
    await handleWhatsAppConnect({
      accessToken,
      channelId,
      organizationId,
      sessionInfo
    });
    
    res.json({ success: true });
  } catch (error) {
    Sentry.captureException(error);
    console.error('Error setting up WhatsApp channel:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// WhatsApp - Processar etapa de configuração
router.post('/whatsapp/:channelId/process-step', async (req, res) => {
  try {
    // Adicionar channelId dos parâmetros da URL ao corpo da requisição
    req.body.channelId = req.params.channelId;
    
    // Adicionar organizationId ao corpo da requisição
    req.body.organizationId = req.params.organizationId || req.body.organizationId;
    
    // Processar a etapa
    await processWhatsAppStep(req, res);
  } catch (error) {
    Sentry.captureException(error);
    console.error('Erro ao processar etapa do WhatsApp:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Erro ao processar etapa do WhatsApp' 
    });
  }
});

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

// WhatsApp Official API Templates routes
router.get('/whatsapp/:channelId/templates', getWhatsAppTemplates);
router.post('/whatsapp/:channelId/templates', createWhatsAppTemplate);
router.put('/whatsapp/:channelId/templates/:templateId', updateWhatsAppTemplate);
router.delete('/whatsapp/:channelId/templates/:templateId', deleteWhatsAppTemplate);

export default router;