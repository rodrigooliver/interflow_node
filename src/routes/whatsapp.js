import express from 'express';
import { handleWhatsAppWebhook, handleWhatsAppConnect, handleWhatsAppMediaProxy } from '../controllers/channels/whatsapp-official.js';

const router = express.Router();

// Rota de autenticação OAuth
router.get('/oauth', async (req, res) => {
  try {
    const { access_token, state } = req.query;
    
    // Decodifica o state que contém channelId e organizationId
    const stateData = JSON.parse(atob(state));
    console.log('WhatsApp OAuth state data:', stateData);
    const { channelId, organizationId } = stateData;

    // Passa os dados decodificados para o controller
    await handleWhatsAppConnect({
      accessToken: access_token,
      channelId,
      organizationId
    });

    // Redireciona de volta para a página de canais após sucesso
    res.redirect(`${process.env.FRONTEND_URL}/app/channels/${channelId}/edit/whatsapp-official?success=true`);
  } catch (error) {
    console.error('Erro na autenticação do WhatsApp:', error);
    res.redirect(`${process.env.FRONTEND_URL}/app/channels/${channelId}/edit/whatsapp-official?error=auth_failed`);
  }
});

// Rota para eventos do webhook
router.post('/event', handleWhatsAppWebhook);

// Verificação do webhook (necessário para o WhatsApp Business API)
router.get('/event', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  // Verifica se o token corresponde ao configurado
  if (mode === 'subscribe' && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Rota para o proxy de mídia do WhatsApp
router.get('/media-proxy', handleWhatsAppMediaProxy);

export default router; 