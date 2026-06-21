# Polar-native meters + credits migration

Status: **planned** — implementation pending.
Branch: `feat/polar-credits-combined` (carries merged PR #127 + #147 onto refactored `develop`).
Supersedes the self-managed Redis credits model shipped in #127/#147.

## 1. Product context

Zevium.dev is an **API hub / gateway**. Orgs publish API **projects** (OpenAPI spec +
docs, public/private, draft/preview/active/archived). **Consumers** get Zevium API keys
and call those APIs **through the Zevium proxy** (`/api/proxy/*`) — the proxy forwards to
an allowlisted upstream host (`x-zevium-host`) on the consumer's behalf. The in-browser
explorer lets you try calls with your key.

So credits = **consumers paying Zevium for proxy throughput**.

Billing model (confirmed):

1. **Billing unit = organization.** A consumer org buys credits and spends them on proxy
   calls. Not per-user.
2. **Consumer pays.** The org that owns the API key making the call is billed.
3. **Polar meter/credits** is the sole credit mechanism. The `@better-auth/api-key`
   table's `remaining` / `refillAmount` / `requestCount` / `rateLimit*` are **not** the
   billing mechanism (those become dead/repurposed for rate-limiting only).
4. **Variable cost: flat rate per host, dynamic later.** `api1` = 3 units/call, `api2` =
   1 unit/call, `api3` = 50 units/call. A per-host price map drives this. Later: per-token
   metering (Polar `sum` over a tokens metadata field).

## 2. Research findings (Polar docs + installed SDK)

### 2.1 Meters

A **meter** = filter + aggregation over ingested **events**. Defines what usage to bill.

- Event fields: `name`, `externalCustomerId` (our **orgId**) OR `customerId` (Polar id),
  `metadata` (arbitrary JSON), optional `timestamp`, optional `externalId` (dedup),
  optional `organizationId` (Polar org, not ours).
- **Filter**: clauses (`property` `op` `value`) joined by `and`/`or`. Match event `name`
  - metadata keys (no `metadata.` prefix).
- **Aggregation**: `count` | `sum` | `avg` | `min` | `max` | `unique` over a property.
  → For per-host unit cost we use **`sum` over a `cost_units` metadata property**.
- **Unit** (scalar / token / custom) = presentational only.
- Created in dashboard; editable only before events are processed or purchases attach.
- SDK: `polar.meters.create({ name, filter, aggregation })`, `.quantities`.

### 2.2 Credits

Credits **pre-pay for usage**. They sit on the customer's (org's) **Polar meter balance**.

- Ingest event → Polar deducts `cost_units` from the meter balance. Balance 0 → overage
  charged per the product's metered price.
- **Credits-only mode** (our choice): do NOT add a metered price to the product → no
  billing triggers, meter is a pure balance tracker. We gate usage ourselves (Polar never
  blocks).
- Credits issued via a **Meter Credit benefit** (`type: "meter_credit"`) on a product:
  - One-time product → credit `units` once at purchase.
  - Subscription product → credit `units` every cycle, optional `rollover`.
  - Benefit props: `{ units: number, rollover: boolean, meterId: string }`.
- Balance = `creditedUnits - consumedUnits` on `CustomerStateMeter`.
- Polar does NOT block overage. We enforce the gate.

### 2.3 Event ingestion

- SDK: `polar.events.ingest({ events: [{ name, externalCustomerId, metadata, externalId }] })`.
- Events **immutable**. `externalId` = dedup key. Backdated `timestamp` allowed but
  billed by receive time.

### 2.4 `@better-auth/api-key` is org-aware (key finding)

The installed api-key plugin **supports `organizationId` + `metadata`** on `create`/`list`.
`verifyApiKey` returns `key: Omit<ApiKey, "key">` including metadata. BUT:

- Our `apikey` drizzle table has **no `organizationId` column** (schema.ts:117-151).
- `keys.tsx` creates keys **flat** (`auth.apiKey.create({ name })`) at
  `/app/settings/keys` — no org context.

→ Lightest org-binding: store `metadata: { orgId }` on key creation (the `metadata` JSON
column already exists), read `verification.key.metadata.orgId` in the proxy. **No schema
migration needed.** (Alternatively add a real `organizationId` column later for indexed
queries; metadata is enough for the proxy path.)

### 2.5 `@better-auth/polar` plugin is user-scoped (key finding)

The `polar()` better-auth plugin is **per-user**: `createCustomerOnSignUp` links
`external_id = userId`, and `usage`/`portal`/`checkout` plugins operate on the **session
user's** Polar customer. That does **not** fit org billing.

→ **Do not use the better-auth polar plugin for the billing flow.** Go **direct SDK,
org-scoped** (`externalCustomerId = orgId`). Keep only `@polar-sh/sdk` + the `webhooks`
`validateEvent` helper (already in use). Remove the `polar()` plugin from `auth.tsx`.

### 2.6 Customer state shape (balance read)

`CustomerState.activeMeters: CustomerStateMeter[]`:

```ts
type CustomerStateMeter = {
  id: string;
  createdAt: Date;
  modifiedAt: Date | null;
  meterId: string;
  consumedUnits: number;
  creditedUnits: number;
  balance: number; // = credited - consumed
};
```

### 2.7 The gap (current merged code)

| Concern       | Current (PR #127/#147)               | Polar-native target                           |
| ------------- | ------------------------------------ | --------------------------------------------- |
| Billing unit  | per-user (bug for an org product)    | **per-org**                                   |
| Balance store | Redis `BITFIELD u63` per user        | Polar meter `balance` per org                 |
| Cost model    | flat 1 cent/call                     | **`sum(cost_units)`, per-host price map**     |
| Spend         | `CreditsManager.deduct` (Redis decr) | `polar.events.ingest` (event w/ cost_units)   |
| Top-up        | webhook → `CreditsManager.add`       | Polar meter_credit benefit (auto on purchase) |
| Customer      | (none — Polar as checkout only)      | Polar customer per org, `external_id = orgId` |
| Key→billable  | `apikey.userId` only                 | `apikey.metadata.orgId`                       |
| Webhook       | custom `/api/polar/webhook`          | `validateEvent` + thin handler (or drop)      |

## 3. Decisions

1. **Polar-native, org-scoped.** Polar customer per organization (`external_id = orgId`).
   Delete `CreditsManager` / `credit_ledger` / custom webhook / flush cron. Polar meter =
   single source of truth.
2. **Direct SDK, not the better-auth polar plugin.** The plugin is user-scoped; our
   billing is org-scoped. Remove `polar()` from `auth.tsx`. Use `@polar-sh/sdk` directly
   in the credits RPC + proxy + org-creation hook.
3. **Credits-only mode** (no metered price on the product). Hard pre-pay gate; no
   surprise overage invoices. We block at `balance < cost_units`.
4. **Meter: `sum` over `cost_units`** on event name `proxy_call`. Each event carries
   `metadata: { cost_units, host, method, status }`. Switching to per-token later = change
   the meter's aggregated property (or add a second meter); event shape already carries
   metadata, so forward-compatible.
5. **Per-host unit cost map.** Env `PROXY_HOST_UNIT_COSTS` = CSV `host:units`
   (e.g. `api.openai.com:3,api.anthropic.com:1,api.example.com:50`). Hosts in
   `PROXY_ALLOWED_HOSTS` **must** have a price; missing price → **fail closed** (403 or
   402). No implicit free calls. (Open: add `PROXY_DEFAULT_UNIT_COST` fallback? Default:
   no fallback, require explicit pricing.)
6. **API keys bound to org via `metadata.orgId`.** Key creation moves into org context
   (org's keys page), passes `metadata: { orgId }`. Proxy reads
   `verification.key.metadata.orgId` to find the billable org. No `apikey` schema change
   (metadata JSON column already exists). Reject keys without `orgId` metadata at the
   proxy (legacy flat keys → 403 with a "recreate key in your org" message).
7. **Polar customer created on org creation.** Hook the better-auth organization
   `create` flow (or the org-creation tRPC mutation) to call
   `polar.customers.create({ externalId: org.id, name, email: <creator email>, metadata: { orgId } })`.
   Store the returned Polar `customerId` on the `organization` table (new
   `polarCustomerId` column + migration) so checkout can use the internal id directly.
   Backfill existing orgs with a one-off script.
8. **Balance latency: short-TTL cache + post-success ingest.**
   - Read `getMeterBalance(orgId)` from a Redis-cached `getStateExternal` (TTL ~5s).
   - Compute `cost_units` from the host price map **before** forwarding; gate
     `if balance < cost_units → 402`.
   - Ingest the spend event **after** a successful upstream response via `waitUntil`
     (non-blocking), `externalId = requestId` for dedup.
   - Risk: within the TTL, concurrent calls can overspend. **Accepted for v1** (pre-pay,
     low-stakes). Mitigate later with an atomic local reservation if needed.
9. **Credit product: one fixed bundle for v1.** One one-time product → one meter_credit
   benefit granting `units`. Variable purchase amount ($5/$10/$20 → different bundles)
   is a follow-up (multiple products or amount-driven benefit). Keep checkout simple.
10. **`apikey.remaining` / `refill*` / `requestCount`**: not the billing mechanism. Leave
    the columns (plugin-managed) but treat as dead for billing; `rateLimit*` stays for
    rate-limiting. Document this so nobody wires them to credits.
11. **Webhook: keep a thin `validateEvent` handler** (existing route) for
    `customer.state_changed` (invalidate balance cache) + optional logging. **No
    `CreditsManager.add`** — Polar credits the meter itself via the meter_credit benefit.
    The handler can shrink dramatically.
12. **Refunds**: Polar reverses the meter credit natively on refund. No app code. Verify
    in sandbox.
13. **`@polar-sh/sdk` pinned 0.41.5** through this migration. Bump is separate.
14. **No migration of existing balances** — branch hasn't shipped. Redis test balances are
    disposable. Migration `0014` (creates `credit_ledger`) → revert/replace with the
    `organization.polarCustomerId` column add.

## 4. Plan

### 4.1 Polar dashboard setup (manual, blocks testing)

1. Create **meter** `proxy_calls`: filter `name = proxy_call`, aggregation **`sum`** over
   property `cost_units`.
2. Create **one-time product** "Credits" (credits-only: NO metered price).
3. Add **Meter Credit benefit** to product: `units = <bundle size>`, `rollover = true`,
   `meterId = proxy_calls`.
4. Webhook endpoint → `https://zevium.dev/api/polar/webhook`, subscribe to
   `customer.state_changed` (+ `order.paid`/`order.refunded` for logging). Copy secret.
5. Env: `POLAR_METER_ID`, `POLAR_PRODUCT_ID_CREDITS` (existing), `POLAR_ACCESS_TOKEN`,
   `POLAR_ORGANIZATION_ID`, `POLAR_SERVER`, `POLAR_WEBHOOK_SECRET` (existing),
   `PROXY_HOST_UNIT_COSTS`. Drop `CREDITS_FLUSH_SECRET`.

### 4.2 Schema + env

- `src/db/schema.ts` `organization`: add `polarCustomerId: text("polar_customer_id")`.
- Migration `0015`: `ALTER TABLE organization ADD COLUMN polar_customer_id TEXT`.
  (Revert/replace `0014`'s `credit_ledger` creation — drop the table + the schema export.)
- `src/env/server.ts`: add `POLAR_METER_ID: "string"`, `PROXY_HOST_UNIT_COSTS: "string > 0"`;
  drop `CREDITS_FLUSH_SECRET`.

### 4.3 Code changes

**`src/lib/server/polar.ts`** — org-scoped direct-SDK helpers:

- `ensureOrgCustomer(org): Promise<string>` — create Polar customer if `org.polarCustomerId`
  is null, persist it; else return existing. Called on org create + lazily.
- `getMeterBalance(orgId): Promise<number>` — `getStateExternal({ externalId: orgId })`,
  find the `proxy_calls` meter, return `balance`. Redis cache 5s.
- `ingestProxyCall({ orgId, requestId, host, method, status, costUnits }): Promise<void>`
  — `events.ingest({ events: [{ name: "proxy_call", externalCustomerId: orgId,
externalId: requestId, metadata: { cost_units: costUnits, host, method, status } }] })`.
- `createCreditsCheckout({ orgId, productId, successUrl }): Promise<{ url }>` —
  `checkouts.create({ customerId: org.polarCustomerId, productId, successUrl, metadata: { orgId } })`.
- `getHostUnitCost(host): number` — parse `PROXY_HOST_UNIT_COSTS`, return units or throw
  (fail closed).

**`src/routes/api/proxy/$.ts`** — replace the `CreditsManager` block:

```
verifyApiKey → key.metadata.orgId   (reject if missing → 403)
costUnits = getHostUnitCost(host)   (missing price → 403)
balance = getMeterBalance(orgId)    // cached 5s
if balance < costUnits: return 402 "Insufficient credits"
fetch upstream
if !upstream.ok: throw UpstreamNonOK (no charge — no event)
stream response to client
on stream complete: waitUntil(ingestProxyCall({ orgId, requestId, host, method, status, costUnits }))
```

Delete the deduct/refund/reserved-charge state machine + `PROXY_CALL_COST_CENTS`.

**`src/server/rpcs/credits/index.ts`** — rewrite, all org-scoped via context orgId:

- `getBalance` → `getMeterBalance(orgId)`.
- `listTransactions` → `polar.orders.list({ customerId: org.polarCustomerId })`.
- `createTopUpCheckout` → `createCreditsCheckout(...)`.
- `getInvoiceUrl` → `polar.orders.invoice({ id })`.

**`src/routes/app/settings/credits.tsx`** — keep UI shell; balance/transactions now
Polar-backed; success route drops polling (Polar credits async; state_changed webhook
refreshes cache, else 5s TTL).

**API keys → org context:**

- Move/extend key creation to an org-scoped page (e.g.
  `/app/organizations/$organizationSlug/settings/keys`) passing `metadata: { orgId }`.
- `keys.tsx` (flat `/app/settings/keys`) either deprecated or shows keys across orgs with
  an org picker. (Open: UX — see §5.)
- Proxy rejects keys lacking `metadata.orgId`.

**`src/lib/server/auth.tsx`** — remove `polar()` plugin (user-scoped, doesn't fit). Keep
`apiKey` + `capCaptcha` + `twoFactor` + `organization` plugins. Polar customer creation
moves to the org-creation path (polar.ts `ensureOrgCustomer`).

**Org creation hook** — call `ensureOrgCustomer(org)` after
`auth.api.createOrganization` / the org-creation tRPC mutation; persist `polarCustomerId`.

**Delete:**

- `src/lib/server/credits.ts` (CreditsManager), `src/lib/server/credits-success.ts`.
- `src/lib/shared/credits-keys.ts` (keep only a balance-cache key, inline).
- `src/routes/api/polar/webhook.ts` → shrink to `validateEvent` + cache invalidate (or
  keep minimal).
- `src/routes/api/credits/$.ts` (flush) + wrangler cron + `src/worker.ts` scheduled handler.
- `credit_ledger` from schema + migration 0014 → replace with 0015 (org `polarCustomerId`).
- `CREDITS_FLUSH_SECRET` env.

**Tests** — delete `credits.test.ts` (CreditsManager). Add:

- `getMeterBalance` (mock SDK, cache hit/miss).
- `getHostUnitCost` (price map parse, fail-closed).
- Proxy gate: balance < cost → 402; no orgId → 403; success → ingest called with right
  `cost_units` + `externalId`.

### 4.4 Proxy gate flow (final)

```
verifyApiKey → key.metadata.orgId          (missing → 403 "recreate key in your org")
costUnits = getHostUnitCost(host)           (missing price → 403 "host not priced")
balance = getMeterBalance(orgId)            // Redis-cached 5s
if balance < costUnits: return 402 "Insufficient credits"
fetch upstream
if !upstream.ok: throw UpstreamNonOK         (no charge)
stream response
on complete: waitUntil(ingestProxyCall({ orgId, requestId, host, method, status, costUnits }))
```

Post-success ingest + `externalId = requestId` ⇒ failed/retried calls don't double-charge.

### 4.5 CI / verification

- `pnpm run ci` green.
- New tests (§4.3) pass.
- Manual (blocked on secrets/dashboard): sandbox org → buy credits → meter balance
  increments → proxy call to a priced host → event ingested with cost_units → balance
  decrements → 402 at 0 → unpriced host → 403 → key w/o orgId → 403.

## 5. Open questions / blockers

1. **`PROXY_HOST_UNIT_COSTS` format + default** (§3.5): CSV `host:units`, fail-closed if
   unlisted. Confirm: no `PROXY_DEFAULT_UNIT_COST` fallback? Default: no fallback.
2. **Credit bundle size** (§3.9): one fixed `units` per product for v1. Pick the number.
3. **Flat `/app/settings/keys` page fate** (§4.3): deprecate, or keep as cross-org view
   with org picker? Keys must be org-scoped for billing.
4. **Existing flat API keys** (§3.6): legacy keys lack `metadata.orgId` → proxy 403s
   them. Acceptable (force recreate), or migrate by assigning a default org? Default:
   force recreate, surface a clear error.
5. **Polar customer `email`** (§3.7): orgs have no email. Use creator's email, or empty?
   Verify Polar requires email. Default: creator email at creation.
6. **Existing orgs backfill** (§3.7): one-off script creating Polar customers for each
   org. Write as `scripts/backfill-polar-customers.ts`.
7. **Overspend within cache TTL** (§3.8): accepted for v1. Confirm.
8. **Refund reversal** (§3.12): verify in sandbox.
9. **Secrets** (blocks testing): `POLAR_METER_ID`, `POLAR_PRODUCT_ID_CREDITS`,
   `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_ORGANIZATION_ID`, `POLAR_SERVER`,
   `PROXY_HOST_UNIT_COSTS`, `UPSTASH_REDIS_REST_URL/TOKEN`. Drop `CREDITS_FLUSH_SECRET`.

## 6. Out of scope

- Bumping `@polar-sh/sdk`.
- Per-token dynamic pricing (future; event metadata already forward-compatible).
- Volume pricing (Polar: "coming soon").
- Cost Insights / Cost tracking.
- Customer portal deep customization (use Polar-hosted portal later via direct SDK
  `customerPortal` session if needed — not the user-scoped better-auth plugin).
