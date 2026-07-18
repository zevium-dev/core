---
name: polar-better-auth-user-scoped-billing
description: "When migrating Polar credits to the @polar-sh/better-auth plugin — wire user-scoped billing (externalId=userId), fixed-price top-up products, plugin-mounted webhooks, and the apiKey plugin's user-references mode."
---

## When to use

Migration from a custom/self-managed Polar credits model to the `@polar-sh/better-auth` plugin's expected user-scoped model. The plugin is **unambiguously user-scoped** — `customer.state`, `usage`, `checkout`, `portal` all key to `session.user.id` and `externalCustomerId = userId`. Do not fight it; billing unit = user.

## Plugin surface map

`polar({ client, createCustomerOnSignUp, use: [...] })` mounts these endpoints under `/api/auth/...`:

| Sub-plugin | Endpoint | Scope |
|---|---|---|
| `checkout()` | `POST /api/auth/checkout` | session user, `externalCustomerId: session.user.id` |
| `portal()` | `POST/GET /api/auth/customer/portal` + `/customer/state` + `/customer/benefits/list` + `/customer/subscriptions/list` + `/customer/orders/list` | session user |
| `usage()` | `GET /api/auth/usage/meters/list` + `POST /api/auth/usage/ingest` | session user |
| `webhooks({ secret, onOrderPaid, onOrderRefunded, onCustomerStateChanged, ... })` | `POST /api/auth/polar/webhooks` | raw body, no session |

The plugin's `checkout` calls `polar.checkouts.create({ externalCustomerId: session.user.id, products, ... })` — it auto-binds the Polar customer. `createCustomerOnSignUp: true` auto-creates `customers.create({ email, name, externalId: user.id })` on signup.

## Top-up model: fixed products, NOT custom amount

The Polar-native model is **fixed one-time products** with a `meter_credit` benefit granting fixed `units`. Drop variable-amount top-ups entirely — they require an unverified `prices: { [productId]: [{ amountType: "custom", presetAmount }] }` inline price and add a §3.9-class unknown.

Expose fixed product IDs to the browser via a Vite env var (e.g. `VITE_PUBLIC_POLAR_TOPUP_PRODUCTS` = JSON array of `{ id, label, priceCents, units }`). The client calls `auth.checkout({ products: [productId] })` and redirects to the returned URL.

## Webhook migration

Delete the hand-rolled `/api/polar/webhook` route. Mount plugin `webhooks()` with typed callbacks:

```ts
webhooks({
  secret: serverEnv.POLAR_WEBHOOK_SECRET,
  onOrderPaid: async (payload) => {
    const userId = payload.data.customer.externalId;
    if (userId) await invalidateUserCreditedCache(userId);
  },
  onOrderRefunded: async (payload) => { /* same */ },
  onCustomerStateChanged: async (payload) => {
    const userId = payload.data.externalId;
    if (userId) await invalidateUserCreditedCache(userId);
  },
})
```

Polar dashboard webhook URL must change from `/api/polar/webhook` to `/api/auth/polar/webhooks`.

## `apiKey` plugin: user-owned keys

Set `references: "user"` (not `"organization"`). `referenceId = userId` on create. The plugin's `listApiKeys` (no `organizationId` query) returns `{ apiKeys: ApiKey[], total, limit, offset }`. Server-side tRPC can wrap it with a Zod parse to validate the shape:

```ts
const raw = await authServer.api.listApiKeys({ headers: ctx.raw.req.headers });
const parsed = z.object({ apiKeys: KeyRow.array() }).parse(raw);
```

Add `apikey.*` to the default user permissions in `secureProcedure` (key management becomes a user-level concern, not an org-role concern). The per-user one-key guard is a unique partial index `apikey_one_per_user ON apikey(reference_id) WHERE reference_id IS NOT NULL`.

## Local credit gate (still needed — Polar doesn't gate)

Polar's docs are explicit: "Polar doesn't block usage… You're responsible for implementing the logic." Keep a local Redis mirror: `userConsumed` counter + cached `creditedUnits` (TTL 5min, invalidated by webhook). Gate math: `creditedUnits - userConsumed >= cost` → allow, `INCRBY userConsumed cost`.

The non-atomic SDK-only reserve (no Lua) is acceptable if you accept bounded overspend under concurrency + a v2 reconcile job. Lua via `@upstash/redis` `createScript` is the only readymade upgrade that fits exactly.

## Proxy route (no session)

API-key auth gives `key.referenceId = userId`. Use raw `polarClient.customers.getStateExternal({ externalId: userId })` for balance (plugin `customer.state` requires a session the proxy doesn't have). Ingest via raw `polarClient.events.ingest({ events: [{ externalCustomerId: userId, externalId: requestId, name: "proxy_call", metadata: { cost_units, ... } }] })`.

## Migration artifacts

- Migration: drop `organization.polarCustomerId` + `organization.polarBillingEmail` columns; drop `apikey_one_per_org_creator` index; add `apikey_one_per_user`.
- Drop `POLAR_ORGANIZATION_ID` and `POLAR_PRODUCT_ID_CREDITS` from `src/env/server.ts` (no longer referenced).
- Add `VITE_PUBLIC_POLAR_TOPUP_PRODUCTS` to `src/env/client.ts` + `src/vite-env.d.ts` `ImportMetaEnv`.
- Wire `polarClient()` client plugin in `src/lib/auth/index.ts` so `auth.checkout()` is callable from the browser.
