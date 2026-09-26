require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { getOrder, setOrder } = require('./db');

const app = express();

const {
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  PRODUCT_AMOUNT_INR, // e.g. 499  (rupees, not paise)
  PORT
} = process.env;

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET
});

// ---------- Static frontend ----------
app.use(express.static('public'));

// ---------- JSON body parser for normal routes ----------
app.use('/create-order', express.json());
app.use('/verify-payment', express.json());

/**
 * 1) Create a Razorpay order.
 *    The frontend calls this before opening the Razorpay checkout popup.
 */
app.post('/create-order', async (req, res) => {
  try {
    const amountPaise = Math.round(Number(PRODUCT_AMOUNT_INR) * 100);

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: 'rcpt_' + Date.now(),
      notes: { purpose: 'telegram_group_access' }
    });

    setOrder(order.id, { status: 'created', amount: amountPaise });

    res.json({
      orderId: order.id,
      amount: amountPaise,
      keyId: RAZORPAY_KEY_ID
    });
  } catch (err) {
    console.error('create-order error', err);
    res.status(500).json({ error: 'Could not create order' });
  }
});

/**
 * 2) Client-side verification (fast path).
 *    Razorpay's checkout returns payment_id + order_id + signature to the
 *    browser ONLY after a genuinely successful payment. The signature is an
 *    HMAC made with your secret key, which the customer never has access to,
 *    so this cannot be faked by a screenshot or a made-up payment id.
 *    We still treat the webhook (below) as the ultimate source of truth,
 *    in case the browser closes before this call completes.
 */
app.post('/verify-payment', async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  const expected = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expected !== razorpay_signature) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    const inviteLink = await grantAccess(razorpay_order_id, razorpay_payment_id);
    res.json({ inviteLink });
  } catch (err) {
    console.error('verify-payment error', err);
    res.status(500).json({ error: 'Could not generate Telegram invite link' });
  }
});

/**
 * 3) Razorpay webhook (authoritative source of truth).
 *    Configure this URL in Razorpay Dashboard -> Settings -> Webhooks,
 *    subscribed to the "payment.captured" event, with a webhook secret
 *    that you also put in .env as RAZORPAY_WEBHOOK_SECRET.
 *    This fires from Razorpay's servers directly, so it can't be spoofed
 *    by the customer's browser at all.
 */
app.post(
  '/razorpay-webhook',
  express.raw({ type: '*/*' }),
  async (req, res) => {
    const signature = req.headers['x-razorpay-signature'];
    const expected = crypto
      .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
      .update(req.body) // raw buffer, required for signature to match
      .digest('hex');

    if (signature !== expected) {
      console.warn('Webhook signature mismatch');
      return res.status(400).send('invalid signature');
    }

    const payload = JSON.parse(req.body.toString('utf8'));

    if (payload.event === 'payment.captured') {
      const payment = payload.payload.payment.entity;
      try {
        await grantAccess(payment.order_id, payment.id);
      } catch (err) {
        console.error('webhook grantAccess error', err);
        // Still 200 the webhook so Razorpay doesn't endlessly retry;
        // log this somewhere you check (email/Slack alert) in production.
      }
    }

    res.status(200).send('ok');
  }
);

/**
 * Marks the order paid (idempotently) and returns a fresh, single-use
 * Telegram invite link. If access was already granted for this order
 * (e.g. both verify-payment AND the webhook fired), the same stored link
 * is returned instead of creating a second invite.
 */
async function grantAccess(orderId, paymentId) {
  const existing = getOrder(orderId);

  if (existing && existing.status === 'paid' && existing.inviteLink) {
    return existing.inviteLink;
  }

  const inviteLink = await createTelegramInviteLink(orderId);

  setOrder(orderId, {
    ...existing,
    status: 'paid',
    paymentId,
    inviteLink,
    paidAt: new Date().toISOString()
  });

  return inviteLink;
}

/**
 * Creates a one-time-use Telegram invite link (member_limit: 1) that
 * expires in 10 minutes, so it can't be shared or reused by anyone else.
 */
async function createTelegramInviteLink(orderId) {
  const expireDate = Math.floor(Date.now() / 1000) + 10 * 60; // 10 min from now

  const resp = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        member_limit: 1,
        expire_date: expireDate,
        name: `order_${orderId}`.slice(0, 32)
      })
    }
  );

  const data = await resp.json();
  if (!data.ok) {
    throw new Error('Telegram API error: ' + JSON.stringify(data));
  }
  return data.result.invite_link;
}

/**
 * Lets the success page poll for the invite link after a redirect,
 * in case the customer's payment was confirmed via webhook while
 * their browser was mid-redirect.
 */
app.get('/order-status', express.json(), (req, res) => {
  const order = getOrder(req.query.orderId);
  if (!order) return res.json({ status: 'unknown' });
  res.json({ status: order.status, inviteLink: order.inviteLink || null });
});

const port = PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
