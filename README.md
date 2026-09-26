# Telegram Group Paywall (Razorpay)

A small website that sells access to a private Telegram group. Payment is
verified **server-side**, two independent ways, so nothing about access
depends on what the customer's browser tells you:

1. **Checkout signature check** — Razorpay's checkout only returns a valid
   HMAC signature to the browser after a real successful payment. Your
   server recomputes that signature with your secret key; it can't be
   faked.
2. **Webhook (source of truth)** — Razorpay's own servers call your
   `/razorpay-webhook` endpoint directly when a payment is captured. This
   doesn't depend on the customer's browser at all, so it still works even
   if they close the tab right after paying.

Only after one of these confirms the payment does the server call the
Telegram Bot API to generate a **single-use invite link** (`member_limit: 1`,
expires in 10 minutes) and hand it to that specific customer.

## 1. Razorpay setup

1. Create an account at https://dashboard.razorpay.com (test mode is fine
   to start).
2. Go to **Settings → API Keys** → generate a key. Copy the Key ID and Key
   Secret into `.env`.
3. Go to **Settings → Webhooks** → add a webhook:
   - URL: `https://YOUR-DOMAIN/razorpay-webhook` (needs to be a public
     HTTPS URL — see deployment section)
   - Active events: check **payment.captured**
   - Set a secret; copy it into `.env` as `RAZORPAY_WEBHOOK_SECRET`
4. When you're ready to accept real money, complete Razorpay's KYC/activation
   and switch to your live keys.

## 2. Telegram bot setup

1. Message **@BotFather** on Telegram → `/newbot` → follow the prompts →
   copy the bot token into `.env` as `TELEGRAM_BOT_TOKEN`.
2. Create your private group/channel (or use an existing one).
3. Add your bot to the group **as an admin** with "Invite Users via Link"
   permission — it needs this to create invite links.
4. Get the chat ID:
   - Add `@userinfobot` or `@getidsbot` temporarily to the group, or
   - Send any message in the group, then visit
     `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser and
     look for `"chat":{"id": -100...}` in the response.
   - Put that number (it's negative) into `.env` as `TELEGRAM_CHAT_ID`.

## 3. Run locally

```bash
npm install
cp .env.example .env   # then fill in your real values
npm start
```

Visit `http://localhost:3000`. Note: Razorpay's webhook needs a public URL,
so for local testing use a tunnel like `ngrok http 3000` and put the ngrok
HTTPS URL into the Razorpay webhook settings temporarily.

## 4. Deploy

Any Node host works (Render, Railway, Fly.io, a VPS, etc.). Two things to
watch for:

- **Persistent storage**: this starter uses a simple `orders.json` file
  (`db.js`) so paid orders survive a restart. That's fine on a host with a
  persistent disk (Render, Railway, a VPS). On a serverless platform
  (Vercel, Netlify) the filesystem resets, so swap `db.js` for a real
  database (e.g. Postgres, SQLite on a mounted volume, or a hosted DB like
  Supabase) before deploying there.
- **HTTPS**: Razorpay requires an HTTPS webhook URL — any of the hosts
  above give you this automatically.

After deploying, update the webhook URL in Razorpay's dashboard to your
real domain.

## 5. Customize

- Price: change `PRODUCT_AMOUNT_INR` in `.env`.
- Copy/branding: edit `public/index.html`.
- Invite link expiry: change `10 * 60` in `createTelegramInviteLink` in
  `server.js` (seconds).

## How the flow works end to end

1. Customer opens the site, clicks **Pay Now**.
2. Browser asks your server to create a Razorpay order (`/create-order`).
3. Razorpay's checkout popup handles the actual UPI/card payment.
4. On success, the browser calls `/verify-payment` with Razorpay's
   signed response; your server checks the signature.
5. In parallel, Razorpay calls your `/razorpay-webhook` directly once the
   payment is captured — this is the authoritative confirmation.
6. Whichever confirmation arrives (usually both), your server calls the
   Telegram Bot API to create a one-time invite link and returns it to the
   customer, who is redirected straight into the group.

Nothing here trusts a screenshot, a claimed UTR number, or anything the
customer says — only Razorpay's own signed responses unlock the link.
