import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cron from 'node-cron';
import Sentry from './lib/sentry.js';
import stripeRoutes from './routes/stripe.js';
import webhookRoutes from './routes/webhook.js';
import channelRoutes from './routes/channel.js';
import { initializeEmailChannels, cleanupEmailConnections } from './services/email.js';
import { initSystemMessageSubscription } from './controllers/webhooks/message-handlers.js';
import monitoringRoutes from './routes/monitoring.js';
import instagramRoutes from './routes/instagram.js';
import { refreshInstagramTokens } from './cron/instagram-token-refresh.js';

// Load environment variables
dotenv.config();

// Initialize Express
const app = express();
const port = process.env.PORT || 3000;

// The request handler must be the first middleware on the app
app.use(Sentry.Handlers.requestHandler());

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/webhook/instagram', instagramRoutes);
app.use('/api/:organizationId/webhook', webhookRoutes);
app.use('/api/:organizationId/stripe', stripeRoutes);
app.use('/api/:organizationId/channel', channelRoutes);
app.use('/api/monitoring', monitoringRoutes);

// The error handler must be before any other error middleware and after all controllers
app.use(Sentry.Handlers.errorHandler());

// Optional fallthrough error handler
app.use(function onError(err, req, res, next) {
  // The error id is attached to `res.sentry` to be returned
  // and optionally displayed to the user for support.
  res.statusCode = 500;
  res.end(`${res.sentry}\n`);
});

let systemMessageSubscription;
let instagramTokenCron;

// Função para inicializar todas as subscriptions e crons
async function initializeSubscriptions() {
  try {
    systemMessageSubscription = await initSystemMessageSubscription();
    console.log('System message subscription initialized successfully');

    // Inicializa o cron do Instagram para executar todos os dias à meia-noite
    instagramTokenCron = cron.schedule('0 0 * * *', async () => {
      try {
        await refreshInstagramTokens();
        console.log('Instagram tokens refresh completed successfully');
      } catch (error) {
        console.error('Error refreshing Instagram tokens:', error);
        Sentry.captureException(error);
      }
    });
    console.log('Instagram token refresh cron initialized successfully');
  } catch (error) {
    console.error('Error initializing subscriptions:', error);
    Sentry.captureException(error);
  }
}

// Gerencia o encerramento gracioso da aplicação
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Cleaning up...');
  
  if (systemMessageSubscription) {
    await systemMessageSubscription.unsubscribe();
  }

  if (instagramTokenCron) {
    instagramTokenCron.stop();
  }
  
  await cleanupEmailConnections();
  
  process.exit(0);
});

// Start server and initialize subscriptions
app.listen(port, async () => {
  console.log(`Server running on port ${port}`);
  
  // Inicializa as subscriptions após o servidor estar rodando
  await initializeSubscriptions();
  
  // Inicializa os canais de email
  await initializeEmailChannels();
});