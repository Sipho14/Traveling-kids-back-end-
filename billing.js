import Stripe from 'stripe';
import { db, getBusiness } from '../db/index.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

// Payment link a PARENT uses to pay their child's transportation fees.
export async function createPaymentLink({ parentId, studentId, amountCents, periodLabel }) {
  const payment = db.prepare(
    'INSERT INTO payments (parent_id, student_id, amount_cents, period_label) VALUES (?, ?, ?, ?)'
  ).run(parentId, studentId, amountCents, periodLabel);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: 'usd',
        unit_amount: amountCents,
        product_data: { name: `School transportation — ${periodLabel}` }
      },
      quantity: 1
    }],
    success_url: `${process.env.APP_URL}/pay/success?payment_id=${payment.lastInsertRowid}`,
    cancel_url: `${process.env.APP_URL}/pay/cancel`,
    metadata: { payment_id: String(payment.lastInsertRowid) }
  });

  db.prepare('UPDATE payments SET stripe_checkout_session_id = ? WHERE id = ?')
    .run(session.id, payment.lastInsertRowid);

  return { payment_url: session.url, payment_id: payment.lastInsertRowid };
}

// Called once the owner's 30-day trial ends: creates the recurring subscription checkout.
export async function createOwnerSubscriptionCheckout() {
  const business = getBusiness();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: business.stripe_customer_id || undefined,
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: `${process.env.APP_URL}/billing/success`,
    cancel_url: `${process.env.APP_URL}/billing/cancel`
  });
  return session.url;
}

// Stripe webhook handler — call from routes/stripeWebhook.js with the raw request body.
export function handleStripeEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.metadata?.payment_id) {
        db.prepare("UPDATE payments SET status = 'paid', paid_at = datetime('now') WHERE id = ?")
          .run(session.metadata.payment_id);
      }
      if (session.mode === 'subscription') {
        db.prepare("UPDATE business SET subscription_status = 'active', stripe_subscription_id = ?, stripe_customer_id = ? WHERE id = 1")
          .run(session.subscription, session.customer);
      }
      break;
    }
    case 'invoice.payment_failed': {
      db.prepare("UPDATE business SET subscription_status = 'past_due' WHERE id = 1").run();
      db.prepare("INSERT INTO alerts (type, message) VALUES ('payment_failed', 'Subscription payment failed — update billing details.')").run();
      break;
    }
    case 'customer.subscription.deleted': {
      db.prepare("UPDATE business SET subscription_status = 'canceled' WHERE id = 1").run();
      break;
    }
  }
}
