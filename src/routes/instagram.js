import express from 'express';
import { handleInstagramWebhook, handleInstagramConnect } from '../controllers/channels/instagram.js';

const router = express.Router();

// Rotas de autenticação OAuth
router.get('/oauth', async (req, res) => {
  try {
    const { code, state } = req.query;
    
    // Decodifica o state que contém channelId e organizationId
    const stateData = JSON.parse(atob(state));
    console.log(stateData);
    const { channelId, organizationId } = stateData;

    // Passa os dados decodificados para o controller
    await handleInstagramConnect({
      code,
      channelId,
      organizationId
    });

    // Redireciona de volta para a página de canais após sucesso
    res.redirect(`${process.env.FRONTEND_URL}/app/channels/${channelId}/edit/instagram?success=true`);
  } catch (error) {
    console.error('Erro na autenticação do Instagram:', error);
    res.redirect(`${process.env.FRONTEND_URL}/app/channels/${channelId}/edit/instagram?error=auth_failed`);
  }
});

// Rotas de eventos
router.post('/event', handleInstagramWebhook);

// Verificação do webhook (necessário para o Instagram)
router.get('/event', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Verifica se o token corresponde ao configurado
  if (mode === 'subscribe' && token === process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

export default router; 