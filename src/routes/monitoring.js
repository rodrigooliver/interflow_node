import express from 'express';
import { emailManager } from '../services/email.js';

const router = express.Router();

router.get('/metrics', (req, res) => {
  const metrics = emailManager.getMetrics();
  res.json(metrics);
});

export default router; 