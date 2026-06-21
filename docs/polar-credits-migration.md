# Polar-native meters + credits migration

Status: **planned** — implementation pending.
Branch: `feat/polar-credits-combined` (carries merged PR #127 + #147 onto refactored `develop`).
Supersedes the self-managed Redis credits model shipped in #127/#147.

## 1. Why

PR #127 + #147 wired up Polar.sh **only as a payment processor**. The actual credit
balance lives in our Redis (`CreditsManager`, a `BITFIELD u63` counter) + a
`credit_ledger` Drizzle table + a Redis stream. Polar has no idea how many credits a
user has spent. This reinvents Polar's native meters/credits, so:

- Balance can drift from Polar (two sources of truth).
- No native Polar customer portal / analytics / refunds on meter balance.
- We carry a custom ledger, a custom webhook, a custom flush cron, custom KV keys.

Polar ships a first-class Usage-Based Billing stack (meters + credits + customer state
+ webhooks) and a `@polar-sh/better-auth` plugin that exposes it over typed endpoints.
Migrating to it makes Polar the single source of truth and deletes a lot of bespoke
code.

## 2. Research findings (Polar docs + installed SDK)

### 2.1 Meters
A **meter** = filter + aggregation over ingested **events**. Defines what usage to bill.

- Event fields: `name`, `externalCustomerId` (our userId) OR `customerId` (Polar id),
  `metadata` (arbitrary JSON), optional `timestamp`, optional `externalId` (dedup),
  optional `organizationId`.
- **Filter**: clauses (`property` `op` `value`) joined by `and`/`or`. Match event
  `name` + metadata keys (no `metadata.` prefix).
- **Aggregation**: `count` | `sum` | `avg` | `min` | `max` | `unique` over a property.
- **Unit** (scalar / token / custom with label + multiplier) = presentational only;
  does not change billing math.
- Created in dashboard; editable only before events are processed or purchases attach.
- SDK: `polar.meters.create({ name, filter, aggregation })`, `.get`, `.list`, `.quantities`.

### 2.2 Credits
Credits **pre-pay for usage**. They sit on the customer's **Polar meter balance**, not
our DB.

- Ingest event → Polar deducts from meter balance. Balance hits 0 → overage charged per
  the product's **metered price**.
- **Credits-only mode**: do NOT add a metered price to the product → no billing triggers,
  meter is a pure balance tracker. We gate usage ourselves (Polar never blocks).
- Credits are issued via a **Meter Credit benefit** (`type: "meter_credit"`) attached to a
  product:
  - One-time product → credit `units` once at purchase.
  - Subscription product → credit `units` every cycle, optional `rollover`.
  - Benefit props: `{ units: number, rollover: boolean, meterId: string }`.
- **Balance tracking**: Customer State API (`customers.getStateExternal`) returns the full
  `CustomerState` including `activeMeters[]` with `{ consumedUnits, creditedUnits, balance }`
  where `balance = creditedUnits - consumedUnits`. Or `customerMeters.list`.
- **Polar does NOT block overage.** We enforce the gate.

### 2.3 Event ingestion
- SDK: `polar.events.ingest({ events: [{ name, externalCustomerId, metadata, externalId, timestamp }] })`.
- Events are **immutable** (cannot edit/delete).
- Backdated `timestamp` allowed, but Polar attributes events to the billing cycle by
  **receive time**, not the timestamp. No retroactive invoices.
- `externalId` = your dedup key (idempotent ingestion).

### 2.4 `@polar-sh/better-auth` plugin (installed, v1.8.4)
The `polar()` better-auth plugin options:
- `client: Polar` — the SDK client.
- `createCustomerOnSignUp: true` — creates a Polar customer on signup, linking
  `external_id = userId`. This is the customer ↔ user mapping (no manual customer
  creation needed).
- `getCustomerCreateParams` — custom metadata at customer creation.
- `use: [...]` — plugins: `checkout`, `usage`, `portal`, `webhooks`.

Plugin endpoints (mounted on the better-auth handler, all session-authenticated):
- **`usage({ creditProducts })`**:
  - `POST /usage/ingest` — `{ event: string, metadata: Record<string,string|number|boolean> }`
    → ingests an event for the authenticated user (`externalCustomerId = userId`).
  - `GET /usage/meters/list` → the user's customer meters (balance).
- **`portal()`**:
  - `GET /customer/state` → full `CustomerState` (meters incl. balance).
  - `GET /customer/benefits/list`, `/customer/subscriptions/list`, `/customer/orders/list`.
  - `POST /customer/portal` → Polar customer portal URL.
- **`checkout({ products, successUrl, returnUrl })`**:
  - `POST /checkout` → `{ url, redirect }` (already used by the credits page).
- **`webhooks({ secret, onOrderPaid, onCustomerStateChanged, ... })`**:
  - `POST /polar/webhooks` — single typed webhook endpoint. Handlers are typed callbacks
    (`onOrderPaid`, `onCustomerStateChanged`, `onBenefitGrantCreated`, etc.).

### 2.5 Customer state shape (what we read for balance)
`CustomerState.activeMeters: CustomerStateMeter[]` where:
```ts
type CustomerStateMeter = {
  id: string;
  createdAt: Date;
  modifiedAt: Date | null;
  meterId: string;
  consumedUnits: number;   // events summed so far
  creditedUnits: number;   // credits granted (purchases/benefits)
  balance: number;         // creditedUnits - consumedUnits
};
```

### 2.6 The gap (current merged code)
| Concern | Current (PR #127/#147) | Polar-native target |
|---|---|---|
| Balance store | Redis `BITFIELD u63` per user | Polar meter `balance` |
| Ledger | `credit_ledger` table + Redis stream | Polar (immutable events) |
| Spend | `CreditsManager.deduct` (Redis decr) | `polar.events.ingest` (event) |
| Top-up | webhook → `CreditsManager.add` | Polar meter_credit benefit (auto on purchase) |
| Balance read | Redis bitfield read | `customers.getStateExternal` / `/usage/meters/list` |
| Webhook | custom `/api/polar/webhook` (manual) | better-auth `/polar/webhooks` (typed) |
| Refund | `CreditsManager.add` on refund event | Polar handles meter reversal natively |
| Flush cron | `/api/credits/flush` | not needed |

## 3. Decisions

1. **Polar-native path B.** Delete self-managed credits. Polar meter = single source of
   truth.
2. **Credits-only mode** (no metered price on the product). Rationale: per-proxy-call
   overage billing would surprise users with invoices; we want a hard pre-pay gate. The
   meter exists purely as a balance tracker. We block at `balance <= 0`.
3. **Meter: `count` aggregation over a `proxy_call` event.** One event = one proxy call.
   Future: switch to `sum` over a `tokens`/`duration` metadata field if we meter real
   cost. Start simple (1 call = 1 unit).
   - Event: `{ name: "proxy_call", externalCustomerId: userId, externalId: requestId, metadata: { host, method, status } }`.
4. **Cost model: 1 unit per proxy call** (matches current `PROXY_CALL_COST_CENTS = 1` → 1
   credit unit per call). Credits product prices in **units**, not cents. The checkout
   `amount` becomes "buy N units", not "buy $N". UI reworded accordingly.
   - Open question: do we want `sum` over a `cost_cents` metadata field instead, so a
     call can cost >1 unit? Decision: **no for v1**, keep 1 unit = 1 call. Revisit when
     calls have variable cost.
5. **Gate location: server-side in the proxy handler.** Polar never blocks, so we check
   balance before forwarding and ingest after a successful response. See §4.3.
6. **Balance latency strategy: short-TTL cache + best-effort ingest.** Per-call Polar
   round trips (check + ingest) add latency to every proxied request. Mitigation:
   - Read balance from a Redis-cached `CustomerState` (TTL ~5s) for the gate decision.
     Fall back to direct `getStateExternal` on cache miss.
   - Ingest the spend event **after** the upstream responds, via `waitUntil` (non-blocking
     to the client). Use `externalId = requestId` so a retried/duplicate ingest is deduped
     by Polar.
   - Risk: within the cache TTL, a burst of concurrent calls could overspend. Acceptable
     for v1 (pre-pay, low-stakes). Mitigate later with an atomic local reservation if
     needed.
7. **Use the better-auth `usage` + `portal` + `webhooks` plugins** for authenticated
   frontend flows (credits page reads meter balance via `/usage/meters/list`, checkout via
   `/checkout`). Use **direct SDK** (`polar.events.ingest`, `polar.customers.getStateExternal`)
   **server-side in the proxy** (no session there, API-key auth).
8. **Drop `CreditsManager`, `credit_ledger`, the custom webhook route, the flush cron,
   `CreditsRedisKey` ledger/balance keys.** Keep Redis only for the balance cache (short
   TTL) — a new simple cache key, not the bitfield ledger.
9. **Meter/product/benefit created in the Polar dashboard**, not via SDK in app code.
   Config (meter id, product id, benefit id) via env. Rationale: one-time setup, dashboard
   gives the preview tooling, and meters can't be edited after events attach.
10. **`createCustomerOnSignUp: true`** — rely on the plugin to create the Polar customer
    per user. No manual customer creation. Existing users without a Polar customer: created
    lazily on first checkout/state read (Polar auto-creates on first external-id touch) —
    verify, else add a backfill.
11. **Webhook: switch to the better-auth `/polar/webhooks` endpoint** with typed handlers.
    We still need `onCustomerStateChanged` (optional: refresh balance cache) and may keep a
    log. The old `order.paid`-driven `CreditsManager.add` is **deleted** — Polar credits the
    meter itself via the meter_credit benefit.
12. **Refunds**: Polar reverses the meter credit natively on refund. No app code. (Verify
    meter_credit benefit reversal behavior in sandbox.)
13. **`@polar-sh/sdk` pinned at 0.41.5** (polar's tested version). Do not bump during this
    migration; bump is a separate concern.
14. **Migration of existing balances**: none needed in code — this branch has not shipped.
    If any sandbox balances exist in Redis, they are test data; drop them.

## 4. Plan

### 4.1 Polar dashboard setup (manual, blocks code testing)
1. Create **meter** `proxy_calls`: filter `name = proxy_call`, aggregation `count`.
2. Create **one-time product** "Credits" (credits-only: NO metered price).
3. Add **Meter Credit benefit** to the product: `units = <credits per purchase>`,
   `rollover = true`, `meterId = proxy_calls meter id`.
   - If we want flexible amounts ($5/$10/$20 → different unit bundles), create one
     product per bundle, OR use one product and issue credits via `amount`-driven logic.
     Decision needed in §3.4 — **for v1: one product, one fixed bundle**, revisit.
4. Create **webhook endpoint** → URL `https://zevium.dev/api/auth/polar/webhooks` (better-auth
   plugin mounts under the auth handler path), subscribe to `customer.state_changed` +
   `order.paid` + `order.refunded`. Copy signing secret.
5. Capture into env: `POLAR_METER_ID`, `POLAR_PRODUCT_ID_CREDITS` (rename existing var),
   `POLAR_WEBHOOK_SECRET` (already set), `POLAR_ACCESS_TOKEN`, `POLAR_ORGANIZATION_ID`,
   `POLAR_SERVER`.

### 4.2 Code changes

**`src/lib/server/auth.tsx`** — enable plugins:
```ts
polar({
  client: polarClient,
  createCustomerOnSignUp: true,
  use: [
    checkout({ successUrl: "/app/settings/credits/success", returnUrl: "/app/settings/credits" }),
    usage({ creditProducts: [{ productId: serverEnv.POLAR_PRODUCT_ID_CREDITS, slug: "credits" }] }),
    portal({ returnUrl: "/app/settings/credits" }),
    webhooks({ secret: serverEnv.POLAR_WEBHOOK_SECRET }),
  ],
}),
```

**`src/lib/server/polar.ts`** — add typed helpers (server-side, direct SDK):
- `getMeterBalance(userId): Promise<number>` — `polar.customers.getStateExternal({ externalId: userId })`,
  find the `proxy_calls` meter in `activeMeters`, return `balance`. Cache in Redis 5s.
- `ingestProxyCall({ userId, requestId, host, method, status }): Promise<void>` —
  `polar.events.ingest({ events: [{ name: "proxy_call", externalCustomerId: userId, externalId: requestId, metadata: {...} }] })`.

**`src/routes/api/proxy/$.ts`** — replace `CreditsManager` block:
- Before fetch: `const balance = await getMeterBalance(userId); if (balance <= 0) return 402`.
- After successful upstream response: `waitUntil(ingestProxyCall(...))` (non-blocking).
- Remove the deduct/refund/reserved-charge state machine (Polar handles it).
- Keep `PROXY_CALL_COST_CENTS` removed — cost is now 1 unit/call (see §3.4).

**`src/server/rpcs/credits/index.ts`** — rewrite:
- `getBalance` → read from `getMeterBalance(userId)` (cached).
- `listTransactions` → `polar.orders.list({ customerId })` or the customer-portal orders
  endpoint. The "transaction" concept becomes Polar orders.
- `createTopUpCheckout` → already uses `/checkout`; keep, but the return is a Polar
  checkout URL. The success route no longer polls for a Redis balance bump — it just shows
  "success, balance updated" (Polar credits async via benefit; state_changes webhook
  refreshes cache).
- `getInvoiceUrl` → `polar.orders.invoice` or portal order invoice.

**`src/routes/app/settings/credits.tsx`** — UI:
- Balance reads from `trpc.credits.getBalance` (now Polar-backed).
- "Buy Credits" → fixed bundle(s) from the credit products config.
- Transaction list → Polar orders.
- Drop the success-route polling logic; keep the success page as a simple confirmation.

**Delete:**
- `src/lib/server/credits.ts` (CreditsManager).
- `src/lib/server/credits-success.ts` (polling helper).
- `src/lib/shared/credits-keys.ts` (keep only a balance-cache key, or move inline).
- `src/routes/api/polar/webhook.ts` (replaced by better-auth `/polar/webhooks`).
- `src/routes/api/credits/$.ts` (flush endpoint) + the wrangler cron trigger +
  `src/worker.ts` scheduled handler.
- `credit_ledger` from `src/db/schema.ts` + migration `0014` (replace with a no-op/empty
  migration or a drop migration `0015`).
- `CREDITS_FLUSH_SECRET` env var.

**`src/env/server.ts`** — add `POLAR_METER_ID: "string"`, drop `CREDITS_FLUSH_SECRET`.

**Tests** — `src/lib/server/credits.test.ts` (CreditsManager unit tests) deleted. Add
tests for `getMeterBalance` (mock SDK) + proxy gate (balance 0 → 402, balance >0 →
ingest called).

### 4.3 Proxy gate flow (final)
```
verifyApiKey → userId
balance = getMeterBalance(userId)        // cached 5s
if balance <= 0: return 402 "Insufficient credits"
fetch upstream
if !upstream.ok: throw UpstreamNonOK (no charge — no event ingested)
stream response to client
on stream complete: waitUntil(ingestProxyCall({ userId, requestId, ... }))  // dedup via externalId
```
Note: because ingest is post-success and deduped by `requestId`, a failed/retried call
does not double-charge. A call that errors mid-stream may or may not ingest — acceptable
(Polar `externalId` dedup protects retries).

### 4.4 CI / verification
- `pnpm run ci` green (typecheck, oxlint, eslint, vitest, build, format).
- New/updated tests for balance cache + proxy gate.
- Manual (blocked on secrets): sandbox checkout → meter balance increments → proxy call
  ingests event → balance decrements → 402 at 0.

## 5. Open questions / blockers

1. **Credit bundle model** (§3.4 / §4.1.3): one fixed bundle product vs. multiple. Needs a
   product decision. Default: one fixed bundle for v1.
2. **Variable cost** (§3.4): 1 unit/call vs. `sum(cost_cents)`. Default: 1 unit/call.
3. **Overspend within cache TTL** (§3.6): acceptable for v1? If not, need an atomic local
   reservation (Redis decr as a *hold*, reconcile against Polar). Default: accept.
4. **Existing users without a Polar customer** (§3.10): confirm `createCustomerOnSignUp`
   covers new users; decide backfill for pre-existing users (one-off script calling
   `polar.customers.create({ externalId: userId })`).
5. **Refund reversal** (§3.12): verify in sandbox that refunding a one-time order
   reverses the meter credit.
6. **Secrets** (blocks testing): `POLAR_METER_ID`, `POLAR_PRODUCT_ID_CREDITS`,
   `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_ORGANIZATION_ID`, `POLAR_SERVER`,
   `UPSTASH_REDIS_REST_URL/TOKEN` (balance cache). Drop `CREDITS_FLUSH_SECRET`.
7. **Migration `0014`** currently creates `credit_ledger`. Replace with a drop, or since
   this branch hasn't shipped, revert `0014` to empty and drop `credit_ledger` from
   schema.

## 6. Out of scope
- Bumping `@polar-sh/sdk`.
- Volume pricing (Polar: "coming soon").
- Cost Insights / Cost tracking (separate Polar feature).
- Customer portal deep customization (use Polar-hosted portal via `portal()` plugin).
