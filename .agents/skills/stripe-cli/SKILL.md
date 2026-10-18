---
name: stripe-cli
description: Operate Zevium's Stripe account from the terminal with the `stripe` CLI: test-mode products and prices for credit packs, webhook endpoints and v2 event destinations for the Convex ledger, triggering and listening to test events, reading charges/refunds/transfers/Connect accounts, request logs. Use for "create the pack prices", "set up Stripe webhooks", "trigger a checkout event", "why did this payment not credit", or any Stripe account task. For integration design (which API, Connect shape), use stripe-best-practices.
---

# Stripe CLI

`stripe whoami` shows the login; `stripe login` opens a browser, so the owner runs it. Commands default to **test mode**; `--live` switches. Zevium is test-mode only: live keys and objects are refused by the code until the #315 gates clear and a reviewed change removes the test-only enforcement. Never pass `--live` without that.

## Finding commands

```bash
stripe resources                      # every API resource
stripe prices create --help           # common params
stripe help prices create             # full param list
stripe v2 core event_destinations --help
stripe get /v1/prices/<id>            # raw GET/POST/DELETE for anything else
```

`--dry-run` previews a write. Pass `-i <key>` (idempotency) on creates you might retry, so a retry doesn't make a second price or endpoint.

## What Zevium needs in Stripe

Source of truth is [convex-activation.md](../../notes/architecture/convex-activation.md) step 4; read it before changing destinations, since event lists change with the code.

- **Pack prices:** fixed one-time USD prices for $10/$50/$100 packs → `NEXT_STRIPE_PRICE_PACK_{10,50,100}`. `createCheckout` refuses any price that is inactive, recurring, non-USD or a different amount, so create them to match exactly. No card-fee prices while #318 is off.
- **Three destinations on the same Convex site** (`https://<deployment>.convex.site`): `/stripe-webhook` (platform snapshot events), `/stripe-connect-webhook` (connected-account payout events), `/stripe-connect-v2-webhook` (Accounts v2 thin events, a v2 event destination). Each signing secret goes to its own Convex env var (`NEXT_STRIPE_WEBHOOK_SECRET`, `NEXT_STRIPE_CONNECT_WEBHOOK_SECRET`, `NEXT_STRIPE_V2_WEBHOOK_SECRET`).
- Keep new destinations disabled until the matching Convex code is deployed, and old ones disabled after: one payment delivered to two ledgers double-credits.

## Secrets

Creating a webhook endpoint returns its signing secret once. Pipe it straight into Convex instead of printing it:

```bash
stripe webhook_endpoints create ... | jq -r .secret | pnpm exec convex env set NEXT_STRIPE_WEBHOOK_SECRET --deployment <name>
```

Check the endpoint exists afterwards with a list that drops the secret. API keys, signing secrets and customer data never go in chat, notes, PRs or logs.

## Testing locally

`stripe listen --forward-to <convex-site>/stripe-webhook` prints a temporary signing secret for that session; `stripe trigger checkout.session.completed` fires a fixture event. Fixture sessions have no `checkoutIntentId` metadata, so `convex/stripeEvents.ts` throws "Unknown Checkout", retries, and finally parks the receipt as `needs_review`, which an operator then has to clear. Only trigger fixtures against a disposable deployment. The real money journey is the authenticated browser drill in #315.
