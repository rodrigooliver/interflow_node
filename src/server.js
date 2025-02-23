import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Sentry from './lib/sentry.js';
import stripeRoutes from './routes/stripe.js';
import webhookRoutes from './routes/webhook.js';
import { pollEmailChannels, testEmailConnection } from './services/email.js';
import { initSystemMessageSubscription } from './controllers/webhooks/message-handlers.js';

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
app.use('/api/stripe', stripeRoutes);
app.use('/api/webhook', webhookRoutes);

// Test email connection
app.post('/api/test-email-connection', async (req, res) => {
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

// Função para inicializar todas as subscriptions
async function initializeSubscriptions() {
  try {
    systemMessageSubscription = await initSystemMessageSubscription();
    console.log('System message subscription initialized successfully');
  } catch (error) {
    console.error('Error initializing system message subscription:', error);
    Sentry.captureException(error);
  }
}

// Gerencia o encerramento gracioso da aplicação
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Cleaning up...');
  
  if (systemMessageSubscription) {
    await systemMessageSubscription.unsubscribe();
  }
  
  process.exit(0);
});

// Start server and initialize subscriptions
app.listen(port, async () => {
  console.log(`Server running on port ${port}`);
  
  // Inicializa as subscriptions após o servidor estar rodando
  await initializeSubscriptions();
  
  // Start email polling if needed
  // const POLLING_INTERVAL = 60000; // 1 minute
  // setInterval(pollEmailChannels, POLLING_INTERVAL);
});