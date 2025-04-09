import express from 'express';
import { supabase } from '../lib/supabase.js';

const router = express.Router({ mergeParams: true });


router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });
  res.json({ data, error });
});

router.post('/signup', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signUp({
    email,
    password
  });
  res.json({ data, error });
});

router.post('/recover-password', async (req, res) => {
  const { email } = req.body;
  const { data, error } = await supabase.auth.resetPasswordForEmail(email);
  res.json({ data, error });
});

export default router;


