/**
 * Millo — Stripe Checkout Backend
 * ─────────────────────────────────────────────────────────────────────
 * Endpoints:
 *   GET  /                          → serves index.html (the SPA)
 *   GET  /config                    → returns publishable key to frontend
 *   POST /create-checkout-session   → creates a Stripe Checkout Session
 *   GET  /checkout/success          → success redirect page
 *   GET  /checkout/cancel           → cancel redirect page
 *   POST /webhook                   → Stripe webhook handler
 *   GET  /payment-status/:sessionId → poll payment/listing status
 * ─────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();

const express    = require('express');
const path       = require('path');
const cors       = require('cors');
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bodyParser = require('body-parser');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── In-memory store: pendingProducts[sessionId] = productData ───────────────
// In production this would be a database (e.g. PostgreSQL / Redis).
const pendingProducts   = {};   // awaiting webhook confirmation
const confirmedPayments = {};   // sessionId → { product, paidAt }

// ─── Middleware ───────────────────────────────────────────────────────────────

// Stripe webhooks MUST receive the raw body for signature verification.
// We mount the webhook route BEFORE the JSON body-parser.
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  handleStripeWebhook
);

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));   // serves index.html + assets

// ─── Config route ─────────────────────────────────────────────────────────────
app.get('/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

// ─── Create Checkout Session ──────────────────────────────────────────────────
app.post('/create-checkout-session', async (req, res) => {
  const {
    productName,
    category,
    price,
    stock,
    imageUrl,
    description,
    supplierName,
    supplierEmail,
  } = req.body;

  // Basic server-side validation
  if (!productName || !category || !price || !stock) {
    return res.status(400).json({ error: 'Missing required product fields.' });
  }

  // Build the public URL (works locally AND behind a proxy)
  const origin = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',

      // ── Line item: $25 CAD listing fee ─────────────────────────────────────
      line_items: [
        {
          price_data: {
            currency: 'cad',
            unit_amount: 2500,           // Stripe amounts are in cents → $25.00 CAD
            product_data: {
              name: 'Product Listing Fee',
              description: `One-time fee to list "${productName}" on Millo Marketplace`,
              images: imageUrl ? [imageUrl] : [],
              metadata: { productName, category },
            },
          },
          quantity: 1,
        },
      ],

      // ── Customer info pre-fill ──────────────────────────────────────────────
      customer_email: supplierEmail || undefined,

      // ── Redirect URLs ───────────────────────────────────────────────────────
      success_url: `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${origin}/checkout/cancel`,

      // ── Metadata forwarded to webhook ───────────────────────────────────────
      metadata: {
        productName,
        category,
        price:        String(price),
        stock:        String(stock),
        imageUrl:     imageUrl    || '',
        description:  description || '',
        supplierName: supplierName || '',
      },
    });

    // Stash the product data so we can act on it when the webhook fires
    pendingProducts[session.id] = {
      productName,
      category,
      price:        parseFloat(price),
      stock:        parseInt(stock, 10),
      imageUrl:     imageUrl    || '',
      description:  description || '',
      supplierName: supplierName || '',
      sessionId:    session.id,
      status:       'pending_payment',
      createdAt:    new Date().toISOString(),
    };

    res.json({ url: session.url, sessionId: session.id });

  } catch (err) {
    console.error('Stripe session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Stripe Webhook Handler ───────────────────────────────────────────────────
function handleStripeWebhook(req, res) {
  const sig     = req.headers['stripe-signature'];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  if (secret) {
    // Verify signature when a webhook secret is configured
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
      console.error('⚠️  Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  } else {
    // No secret configured — parse raw body directly (dev / test without CLI)
    try {
      event = JSON.parse(req.body.toString());
      console.warn('⚠️  STRIPE_WEBHOOK_SECRET not set — skipping signature verification!');
    } catch (err) {
      return res.status(400).send('Invalid JSON');
    }
  }

  console.log(`\n✅  Stripe webhook received: ${event.type}`);

  switch (event.type) {

    // ── Payment completed ────────────────────────────────────────────────────
    case 'checkout.session.completed': {
      const session   = event.data.object;
      const sessionId = session.id;

      const meta = session.metadata || {};
      const productData = pendingProducts[sessionId] || {
        productName:  meta.productName  || 'Unknown Product',
        category:     meta.category     || 'Other',
        price:        parseFloat(meta.price || 0),
        stock:        parseInt(meta.stock || 0, 10),
        imageUrl:     meta.imageUrl     || '',
        description:  meta.description  || '',
        supplierName: meta.supplierName || '',
      };

      confirmedPayments[sessionId] = {
        ...productData,
        sessionId,
        status:         'payment_confirmed',
        paidAt:         new Date().toISOString(),
        stripeSessionId: sessionId,
        amountPaid:     session.amount_total,
        currency:       session.currency,
        customerEmail:  session.customer_details?.email || '',
      };

      // Remove from pending queue
      delete pendingProducts[sessionId];

      console.log(`\n🎉  Payment confirmed for: "${productData.productName}"`);
      console.log(`    Session ID : ${sessionId}`);
      console.log(`    Amount     : ${session.currency?.toUpperCase()} ${(session.amount_total / 100).toFixed(2)}`);
      console.log(`    Customer   : ${session.customer_details?.email || 'n/a'}`);
      break;
    }

    // ── Payment failed / expired ─────────────────────────────────────────────
    case 'checkout.session.expired':
    case 'payment_intent.payment_failed': {
      const sessionId = event.data.object.id || event.data.object.metadata?.sessionId;
      if (sessionId && pendingProducts[sessionId]) {
        pendingProducts[sessionId].status = 'payment_failed';
        console.log(`❌  Payment failed/expired for session: ${sessionId}`);
      }
      break;
    }

    default:
      // Acknowledge events we don't process
      break;
  }

  res.json({ received: true });
}

// ─── Poll payment status ──────────────────────────────────────────────────────
app.get('/payment-status/:sessionId', (req, res) => {
  const { sessionId } = req.params;

  if (confirmedPayments[sessionId]) {
    return res.json({ status: 'confirmed', data: confirmedPayments[sessionId] });
  }
  if (pendingProducts[sessionId]) {
    return res.json({ status: pendingProducts[sessionId].status || 'pending_payment' });
  }

  // Not found locally — query Stripe directly
  stripe.checkout.sessions.retrieve(sessionId)
    .then(session => {
      if (session.payment_status === 'paid') {
        return res.json({ status: 'confirmed' });
      }
      res.json({ status: session.status || 'unknown' });
    })
    .catch(() => res.json({ status: 'unknown' }));
});

// ─── Success page ─────────────────────────────────────────────────────────────
app.get('/checkout/success', (req, res) => {
  const sessionId = req.query.session_id || '';
  res.send(buildSuccessPage(sessionId));
});

// ─── Cancel page ──────────────────────────────────────────────────────────────
app.get('/checkout/cancel', (_req, res) => {
  res.send(buildCancelPage());
});

// ─── Catch-all → SPA ─────────────────────────────────────────────────────────
// Express 5 requires the named wildcard syntax {*splat}
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n🚀  Millo server running');
  console.log(`    Local  : http://localhost:${PORT}`);
  console.log(`    Stripe : ${process.env.STRIPE_SECRET_KEY ? 'configured ✅' : 'NOT configured ⚠️  — set STRIPE_SECRET_KEY in .env'}`);
  console.log(`    Webhook: ${process.env.STRIPE_WEBHOOK_SECRET ? 'configured ✅' : 'NOT configured ⚠️  — set STRIPE_WEBHOOK_SECRET in .env'}\n`);
});

// ─── HTML helpers ─────────────────────────────────────────────────────────────
function buildSuccessPage(sessionId) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Payment Successful — Millo</title>
  <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet"/>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet"/>
  <style>
    body { background:#000; color:#fff; font-family:'Inter',sans-serif; }
    .gold { color:#d4af37; }
    .card { background:#1a1a1a; border:1px solid #333; border-radius:16px; padding:48px; max-width:520px; margin:80px auto; text-align:center; box-shadow:0 20px 60px rgba(212,175,55,0.15); }
    .icon-circle { width:80px; height:80px; background:rgba(16,185,129,0.15); border:2px solid #10b981; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 24px; }
    .btn { background:#d4af37; color:#000; border:none; padding:14px 32px; border-radius:8px; font-weight:700; font-size:1rem; cursor:pointer; text-decoration:none; display:inline-block; margin-top:8px; transition:background 0.2s; }
    .btn:hover { background:#b8972e; }
    .badge { display:inline-flex; align-items:center; gap:6px; background:rgba(16,185,129,0.12); border:1px solid #10b981; color:#10b981; padding:6px 14px; border-radius:999px; font-size:0.85rem; font-weight:600; margin-top:16px; }
    .session-id { font-size:0.7rem; color:#555; margin-top:16px; word-break:break-all; }
    #listing-status { margin-top:20px; padding:12px 16px; border-radius:8px; background:#222; border:1px solid #444; font-size:0.9rem; display:none; }
    .spinner { display:inline-block; width:16px; height:16px; border:2px solid #444; border-top-color:#d4af37; border-radius:50%; animation:spin 0.8s linear infinite; vertical-align:middle; margin-right:6px; }
    @keyframes spin { to { transform:rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-circle">
      <i class="fas fa-check text-green-400 text-3xl"></i>
    </div>
    <h1 class="text-3xl font-bold mb-2">Payment Successful!</h1>
    <p class="text-gray-400 mb-4">Your <span class="gold font-bold">$25.00 CAD</span> listing fee has been received.</p>
    <div class="badge"><i class="fas fa-shield-alt"></i> Stripe Verified Payment</div>

    <div id="listing-status"></div>

    <div class="mt-8 p-4" style="background:#111; border-radius:10px; text-align:left; border:1px solid #2a2a2a;">
      <h3 class="font-semibold text-sm text-gray-300 mb-2"><i class="fas fa-tasks mr-2 gold"></i>What happens next?</h3>
      <ul class="text-sm text-gray-400 space-y-2">
        <li><i class="fas fa-check-circle text-green-400 mr-2"></i>Payment confirmed via Stripe webhook</li>
        <li><i class="fas fa-check-circle text-green-400 mr-2"></i>Your product is being reviewed</li>
        <li><i class="fas fa-clock text-yellow-400 mr-2"></i>Listing goes live within minutes</li>
        <li><i class="fas fa-envelope text-blue-400 mr-2"></i>Confirmation email sent to you</li>
      </ul>
    </div>

    ${sessionId ? `<p class="session-id">Session: ${sessionId}</p>` : ''}

    <div class="flex gap-3 mt-8" style="justify-content:center;">
      <a href="/#marketplace" class="btn" onclick="if(window.opener){window.opener.postMessage({type:'product-added'},'*');setTimeout(()=>window.close(),500);return false;}"><i class="fas fa-shopping-bag mr-2"></i>View Your Product</a>
      <a href="/" class="btn-secondary btn-compact"><i class="fas fa-home mr-2"></i>Home</a>
    </div>
  </div>

  <script>
    const SESSION_ID = '${sessionId}';
    const statusEl   = document.getElementById('listing-status');

    async function pollStatus(attempts) {
      if (!SESSION_ID || attempts <= 0) return;
      try {
        const res  = await fetch('/payment-status/' + SESSION_ID);
        const data = await res.json();

        if (data.status === 'confirmed') {
          statusEl.style.display = 'block';
          statusEl.style.borderColor = '#10b981';
          statusEl.style.color = '#10b981';
          statusEl.innerHTML = '<i class="fas fa-check-circle mr-2"></i>Webhook confirmed — product listing activated!';

          // Persist confirmed product to localStorage for the SPA
          if (data.data) {
            const products = JSON.parse(localStorage.getItem('milloProducts') || '[]');
            const alreadyAdded = products.some(p => p.sessionId === SESSION_ID);
            if (!alreadyAdded) {
              const existing = products.map(p => p.id).filter(Boolean);
              const newId = existing.length ? Math.max(...existing) + 1 : 1;
              products.push({
                id:          newId,
                name:        data.data.productName,
                price:       data.data.price,
                category:    data.data.category,
                description: data.data.description,
                stock:       data.data.stock,
                image:       data.data.imageUrl,
                supplier:    data.data.supplierName,
                sales:       0,
                revenue:     0,
                status:      'active',
                sessionId:   SESSION_ID,
                dateAdded:   new Date().toISOString().split('T')[0],
              });
              localStorage.setItem('milloProducts', JSON.stringify(products));
            }
          }
          return;
        }

        // Not yet confirmed — show spinner and retry
        statusEl.style.display = 'block';
        statusEl.style.borderColor = '#444';
        statusEl.style.color = '#aaa';
        statusEl.innerHTML = '<span class="spinner"></span>Waiting for webhook confirmation...';
        setTimeout(() => pollStatus(attempts - 1), 2000);

      } catch (e) {
        // Silently retry
        setTimeout(() => pollStatus(attempts - 1), 2000);
      }
    }

    // Start polling immediately (up to 15 attempts = 30 seconds)
    pollStatus(15);
  </script>
</body>
</html>`;
}

function buildCancelPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Payment Cancelled — Millo</title>
  <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet"/>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet"/>
  <style>
    body { background:#000; color:#fff; font-family:'Inter',sans-serif; }
    .gold { color:#d4af37; }
    .card { background:#1a1a1a; border:1px solid #333; border-radius:16px; padding:48px; max-width:480px; margin:80px auto; text-align:center; box-shadow:0 20px 60px rgba(0,0,0,0.4); }
    .icon-circle { width:80px; height:80px; background:rgba(239,68,68,0.12); border:2px solid #ef4444; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 24px; }
    .btn { background:#d4af37; color:#000; border:none; padding:14px 32px; border-radius:8px; font-weight:700; font-size:1rem; cursor:pointer; text-decoration:none; display:inline-block; margin-top:8px; transition:background 0.2s; }
    .btn:hover { background:#b8972e; }
    .btn-outline { background:transparent; color:#d4af37; border:2px solid #d4af37; }
    .btn-outline:hover { background:#d4af37; color:#000; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-circle">
      <i class="fas fa-times text-red-400 text-3xl"></i>
    </div>
    <h1 class="text-3xl font-bold mb-2">Payment Cancelled</h1>
    <p class="text-gray-400 mb-6">No charge was made. You can retry listing your product at any time.</p>
    <div class="flex gap-3" style="justify-content:center; flex-wrap:wrap;">
      <a href="/" class="btn"><i class="fas fa-redo mr-2"></i>Try Again</a>
      <a href="/" class="btn btn-outline"><i class="fas fa-home mr-2"></i>Home</a>
    </div>
  </div>
</body>
</html>`;
}
