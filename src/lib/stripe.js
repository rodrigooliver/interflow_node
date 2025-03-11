import Stripe from 'stripe';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16', // Usar a versão mais recente da API
  maxNetworkRetries: 2, // Número de tentativas em caso de falha
});