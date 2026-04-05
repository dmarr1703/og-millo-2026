require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('.'));   // serve index.html + static files

// ── Health check ─────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', mode: 'live', timestamp: new Date().toISOString() });
});

// ── Config (sends publishable key to client) ─────────────────
app.get('/api/config', (_req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

// ── Create Payment Intent ─────────────────────────────────────
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency = 'usd', metadata = {} } = req.body;

    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Stripe expects amount in cents
    const amountInCents = Math.round(Number(amount) * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount:   amountInCents,
      currency,
      automatic_payment_methods: { enabled: true },
      metadata: {
        platform: 'millo-marketplace',
        ...metadata
      }
    });

    console.log(`[Stripe] PaymentIntent created: ${paymentIntent.id} — $${(amountInCents/100).toFixed(2)}`);
    res.json({ clientSecret: paymentIntent.client_secret, id: paymentIntent.id });

  } catch (err) {
    console.error('[Stripe] Error creating PaymentIntent:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Retrieve PaymentIntent status ─────────────────────────────
app.get('/api/payment-intent/:id', async (req, res) => {
  try {
    const pi = await stripe.paymentIntents.retrieve(req.params.id);
    res.json({ status: pi.status, amount: pi.amount, currency: pi.currency });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ── Webhook (for production use) ─────────────────────────────
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    // No webhook secret configured — just acknowledge
    return res.json({ received: true });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[Webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'payment_intent.succeeded':
      console.log('[Webhook] Payment succeeded:', event.data.object.id);
      break;
    case 'payment_intent.payment_failed':
      console.log('[Webhook] Payment failed:', event.data.object.id);
      break;
    default:
      console.log('[Webhook] Unhandled event type:', event.type);
  }

  res.json({ received: true });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Millo Payment Server running on http://0.0.0.0:${PORT}`);
  console.log(`   Mode: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? '🟢 LIVE' : '🟡 TEST'}`);
  console.log(`   Health: http://localhost:${PORT}/api/health\n`);
});
