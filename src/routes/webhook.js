import express from 'express';
import { handleWapiWebhook } from '../controllers/channels/wapi.js';
import { handleInstagramWebhook, handleInstagramConnect } from '../controllers/channels/instagram.js';
import { handleFacebookWebhook } from '../controllers/channels/facebook.js';

const router = express.Router({ mergeParams: true });

// WhatsApp WApi routes
router.post('/wapi/:channelId', handleWapiWebhook);
router.get('/wapi/:channelId', handleWapiWebhook);


// Instagram webhook handler
router.get('/instagram/:channelId/connect', handleInstagramConnect);
router.post('/instagram/:channelId', handleInstagramWebhook);

// Facebook webhook handler
router.post('/facebook/:channelId', handleFacebookWebhook);

export default router;