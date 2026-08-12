import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { whatsappWebhook } from './whatsappWebhook.js';
import { adminRouter } from './admin.js';
import { authRouter } from './auth.js';
import { stripeWebhook } from './stripeWebhook.js';
import { driverRouter } from './driverPortal.js';
import { startTrialCron } from './trialCron.js';
import './db.js'; // ensures schema is created on boot

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Stripe webhook needs the raw body for signature verification — must come before express.json().
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhook);

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

// The driver's mobile stop-list page — plain HTML/JS, no build step, no login,
// served straight from the backend so the WhatsApp link always resolves.
app.get('/driver.html', (req, res) => res.sendFile(path.join(__dirname, 'driver.html')));

app.use('/webhooks/whatsapp', whatsappWebhook);
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/driver', driverRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Scholar Transit backend running on port ${PORT}`);
  startTrialCron();
});
