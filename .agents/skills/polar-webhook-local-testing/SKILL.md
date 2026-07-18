---
name: polar-webhook-local-testing
description: "Test Polar.sh webhooks locally when the Polar CLI can't authenticate (SSH/headless), including filling Stripe checkout iframes via CDP"
---

# Polar Webhook Local Testing (Without Polar CLI)

## When to use
- Polar CLI `polar login` fails silently over SSH (no system keyring/libsecret)
- Need to test webhook delivery locally
- Need to automate Polar sandbox checkout (Stripe iframe card fill)

## Procedure

### 1. Set up cloudflared tunnel (no signup needed)
```bash
# Download portable binary (no sudo)
curl -fsSL -o ~/.local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x ~/.local/bin/cloudflared

# Start tunnel pointing at dev server
cloudflared tunnel --url http://localhost:5173
# → outputs https://random-words.trycloudflare.com
```

### 2. Configure Polar webhook in dashboard
- URL: `https://<tunnel>.trycloudflare.com/api/auth/polar/webhooks`
- Events: `order.paid`, `order.refunded`, `customer.state_changed`
- Copy secret → `.env` as `POLAR_WEBHOOK_SECRET`

### 3. Fix Vite 8 tunnel host blocking
Vite 8 blocks unknown hosts by default. Add to `vite.config.ts`:
```ts
export default defineConfig({
  server: { allowedHosts: true },
  // ...
});
```

### 4. Test webhook signature verification
Polar uses `standardwebhooks` library. Sign a test payload:
```js
const SW = require('standardwebhooks');
const secret = process.env.POLAR_WEBHOOK_SECRET;
const b64 = Buffer.from(secret, 'utf-8').toString('base64');
const wh = new SW.Webhook(b64);
const payload = JSON.stringify({
  type: 'order.paid',
  timestamp: new Date().toISOString(),
  data: { /* full Order object required — see SDK types */ }
});
const msgId = 'msg_' + crypto.randomUUID();
const sig = wh.sign(msgId, new Date(), payload);
// POST with headers: webhook-id, webhook-timestamp, webhook-signature
```

### 5. Fill Stripe checkout iframe via CDP
agent-browser can't reach cross-origin Stripe iframes. Use CDP directly:
```js
// 1. Get CDP URL from agent-browser
// 2. List targets — find Stripe payment frame (url includes 'elements-inner-accessory-target')
// 3. Attach to target, Runtime.evaluate to fill inputs:
//    - payment-numberInput (autocomplete=cc-number)
//    - payment-expiryInput (autocomplete=cc-exp)
//    - payment-cvcInput (autocomplete=cc-csc)
// Use native input value setter to trigger React/listener updates:
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
setter.call(input, '4242424242424242');
input.dispatchEvent(new Event('input', { bubbles: true }));
```

### 6. Use localhost for browser automation
Vite dynamic imports fail through tunnel URLs (module paths resolve to tunnel host). Use `http://localhost:PORT` directly for agent-browser automation. The webhook still fires through the tunnel (Polar → cloudflared → localhost).

## Key facts
- Polar sandbox API: `sandbox-api.polar.sh` (not `api.sandbox.polar.sh`)
- Test card: `4242 4242 4242 4242`, any future expiry, any CVC
- Polar webhook payload requires full Order object (all required fields from SDK type)
- `POLAR_WEBHOOK_SECRET` from dashboard starts with `whsec_`
- `POLAR_ACCESS_TOKEN` from dashboard starts with `polar_oat_`
- Sandbox and production tokens are separate — create in the right environment
- Polar PAT scopes needed: customers:read/write, customer_meters:read, events:read/write, orders:read, checkouts:write, products:read, meters:read, webhooks:read
