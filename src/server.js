import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fileUpload from 'express-fileupload';
import Sentry from './lib/sentry.js';
import stripeRoutes from './routes/stripe.js';
import webhookRoutes from './routes/webhook.js';
import channelRoutes from './routes/channel.js';
import { initializeEmailChannels, cleanupEmailConnections } from './services/email.js';
import monitoringRoutes from './routes/monitoring.js';
import instagramRoutes from './routes/instagram.js';
import chatRoutes from './routes/chat.js';
import flowRoutes from './routes/flow.js';
import whatsappRoutes from './routes/whatsapp.js';
import integrationRoutes from './routes/integrations.js';
import promptRoutes from './routes/prompts.js';
import memberRoutes from './routes/member.js';
import { setupCronJobs } from './cron/index.js';
import { handleWebhook } from './controllers/stripe.js';
import { testEmailConnection } from './controllers/member.js';

// Load environment variables
dotenv.config();

// Initialize Express
const app = express();
const port = process.env.PORT || 3000;

// The request handler must be the first middleware on the app
app.use(Sentry.Handlers.requestHandler());

// Middleware
app.use(cors());

// Middleware personalizado para capturar o corpo bruto da requisição do Stripe
const stripeWebhookMiddleware = express.raw({type: 'application/json'});

// Função para processar o webhook do Stripe com o middleware correto
app.post('/api/webhook/stripe', stripeWebhookMiddleware, handleWebhook);

// Aumentar limites para permitir payloads JSON maiores com base64
app.use(express.json({
  limit: '50mb' // Aumentar para 50MB
}));

app.use(express.urlencoded({ 
  extended: true,
  limit: '50mb' // Aumentar para 50MB
}));

// Middleware para upload de arquivos
app.use(fileUpload({
  createParentPath: true,
  limits: { 
    fileSize: 50 * 1024 * 1024 // 50MB max file size
  },
}));


app.get('/', (req, res) => {
  return res.json({
    'text': 'Welcome to Interflow API',
  })
});

// Routes
app.use('/api/webhook/instagram', instagramRoutes);
app.use('/api/webhook/whatsapp', whatsappRoutes);
app.use('/api/:organizationId/stripe', stripeRoutes);
app.use('/api/:organizationId/webhook', webhookRoutes);
app.use('/api/:organizationId/channel', channelRoutes);
app.use('/api/:organizationId/chat', chatRoutes);
app.use('/api/:organizationId/flow', flowRoutes);
app.use('/api/:organizationId/integrations', integrationRoutes);
app.use('/api/:organizationId/prompts', promptRoutes);
app.use('/api/:organizationId/member', memberRoutes);
app.use('/api/monitoring', monitoringRoutes);
app.post('/api/test-email-connection', testEmailConnection);

// The error handler must be before any other error middleware and after all controllers
app.use(Sentry.Handlers.errorHandler());

// Optional fallthrough error handler
app.use(function onError(err, req, res, next) {
  // The error id is attached to `res.sentry` to be returned
  // and optionally displayed to the user for support.
  res.statusCode = 500;
  res.end(`${res.sentry}\n`);
});

let cronJobs;

// Função para inicializar todas as subscriptions e crons
async function initializeSubscriptions() {
  try {
    // Inicializa todos os cron jobs
    cronJobs = setupCronJobs();
    console.log('Cron jobs initialized successfully');
  } catch (error) {
    console.error('Error initializing subscriptions:', error);
    Sentry.captureException(error);
  }
}

// Gerencia o encerramento gracioso da aplicação
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Cleaning up...');

  // Para todos os cron jobs
  if (cronJobs) {
    Object.values(cronJobs).forEach(job => {
      if (job && typeof job.stop === 'function') {
        job.stop();
      }
    });
  }
  
  await cleanupEmailConnections();
  
  process.exit(0);
});

// Start server and initialize subscriptions
app.listen(port, async () => {
  console.log(`Server running on port ${port}`);
  
  // Inicializa as subscriptions após o servidor estar rodando
  if(process.env.NODE_ENV !== 'development') {
    console.log('Initializing subscriptions');
    await initializeSubscriptions();

     // Inicializa os canais de email
    await initializeEmailChannels();
  } else {
    console.log('Skipping subscriptions initialization in development mode');
  }
  
 
});