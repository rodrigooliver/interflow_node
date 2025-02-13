import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import stripeRoutes from './routes/stripe.js';
import webhookRoutes from './routes/webhook.js';
import { pollEmailChannels, testEmailConnection } from './services/email.js';

// Load environment variables
dotenv.config();

// Initialize Express
const app = express();
const port = process.env.PORT || 3000;

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
    console.error('Error testing email connection:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Start email polling
const POLLING_INTERVAL = 60000; // 1 minute
setInterval(pollEmailChannels, POLLING_INTERVAL);

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});