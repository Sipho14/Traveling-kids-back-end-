import { Router } from 'express';
import Stripe from 'stripe';
import { handleStripeEvent } from '../services/billing.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
export const stripeWebhook = Router();

// Mounted with express.raw() in server.js — Stripe requires the raw body to verify the signature.
stripeWebhook.post('/', (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  handleStripeEvent(event);
  res.json({ received: true });
});
