# Polar-native credits migration (user-scoped)

Status: **implemented (v2)** — typecheck + 92 tests pass. Branch: `feat/polar-credits-combined`.

## v2 — user-scoped rewrite (supersedes v1)

v1 (below) wired Polar credits as org-scoped (one Polar customer per org,
`externalId = orgId`) and side-stepped the `@polar-sh/better-auth` plugin
because the plugin is unambiguously user-scoped. v2 reverses that: billing
now follows the Polar-native model the plugin enforces.

### What changed

- **Billing unit = user, not org.** The `@polar-sh/better-auth` `polar()`
  plugin is mounted in `auth.tsx` with `createCustomerOnSignUp: true`; Polar
  customer `externalId = userId`. `organization.polarCustomerId` and
  `organization.polarBillingEmail` columns are dropped (migration `0015`).
- **Top-ups via the plugin checkout endpoint** (`POST /api/auth/checkout`)
  with FIXED one-time Polar products (each grants fixed `units` via a
  `meter_credit` benefit). Variable-amount top-ups are gone — this kills
  the §3.9 "can a one-time product grant variable units" unknown entirely.
  Product IDs are exposed to the browser via
  `VITE_PUBLIC_POLAR_TOPUP_PRODUCTS` (JSON array of `{id,label,priceCents,units}`).
- **Webhook via the plugin** (`POST /api/auth/polar/webhooks`) with typed
  `onOrderPaid`/`onOrderRefunded`/`onCustomerStateChanged` callbacks that
  invalidate the per-user `creditedUnits` cache. The hand-rolled
  `/api/polar/webhook` route is deleted. Update the Polar dashboard webhook
  URL to `https://zevium.dev/api/auth/polar/webhooks`.
- **API keys are user-owned** (`apiKey` plugin `references: "user"`); the
  one-key-per-user guard replaces the one-key-per-org-creator index
  (`apikey_one_per_user` unique partial index on `reference_id`). The
  `orgKey` tRPC router is renamed `userKey`.
- **Local gate is per-user**: `userConsumed` Redis counter
  (`user-pool-gate.ts`), `creditedUnits` cached per user. Same non-atomic
  SDK-only reserve/refund as v1 (no Redis Lua). v2 reconcile job remains
  future work.
- **Proxy route resolves `userId` from the API key's `referenceId`** and
  gates against that user's meter + `userConsumed`. `ingestProxyCall` uses
  `externalCustomerId = userId`.
- **Permissions**: `apikey.*` added to the default user permissions in
  `secure-procedure.ts` (key management is a user-level concern now, not
  an org-role concern).
- **Reading balance in-app**: the plugin `customer.state` endpoint is
  mounted (`/api/auth/customer/state`); the tRPC `credits.getBalance`
  RPC still exists for the settings page, reading
  `polarClient.customers.getStateExternal({ externalId: userId })` +
  `readConsumedUser(userId)` (same shape as v1, just user-keyed).

### v1 doc (org-scoped, superseded)

The remainder of this document describes the v1 org-scoped design. It is
kept for historical context; the v2 changes above are the source of truth.

## 1. Product context

Zevium.dev is an **API hub / gateway + marketplace**. Orgs publish API **projects**
(OpenAPI spec + docs). **Consumers** call those APIs through the Zevium proxy
(`/api/proxy/*`), which forwards to an allowlisted upstream host (`x-zevium-host`).

Two-sided:

- **Consumer org** pays Zevium for proxy throughput (prepaid credits).
- Zevium's spread vs upstream cost is handled outside the app (publisher/marketplace tracking is cut for v1 — see §3.10).

Confirmed billing model:

1. **Billing unit = organization.** Consumer org recharges a credit pool. Per-user limits are enforced via per-key plugin quotas (§3.4).
2. **Consumer pays.** The org owning the API key is billed.
3. **Polar meter/credits** is the prepaid-credit mechanism. `@better-auth/api-key`'s `remaining`/`refillAmount`/`refillInterval` are **repurposed** as the per-key request quota (per-user cap). `requestCount` is dead.
4. **Variable cost: per-host unit rate** (`api1` = 3 units/call, `api2` = 1, `api3` = 50). Per-token dynamic pricing later.
5. **Charge only on upstream 2xx.** Non-2xx → refund both gates (plugin `remaining` + `orgConsumed`), no event ingested.
6. **Top-up: min $20, up to any amount** the consumer wants.
7. **Top-up: min $20, up to any amount** the consumer wants.

## 2. Research findings

### 2.1 Polar credits auto-deduct per event (key fact)

> "Credits draw down per event. Incoming events deduct from the credit balance first;
> only when the balance hits zero does the metered price kick in (and that step is
> optional)." — Polar docs

So: ingest a `proxy_call` event with `metadata.cost_units = N` → Polar deducts N from
the org's meter credit balance automatically. **No manual deduction.** Credits-only mode
(no metered price) = balance just decrements, never invoiced for overage.

### 2.2 Polar does NOT block usage (key fact for the gate)

> "Polar doesn't block usage if the customer exceeds their balance. You're responsible
> for implementing the logic you need to prevent usage if they exceed it."

Polar only _tracks_ via events. The **gate is ours**. (See §3.6 — solved with a local
atomic counter, no TTL cache, no overspend.)

### 2.3 Meter credits vs wallets

- **Meter credits** (chosen): units granted via a `meter_credit` benefit on a product,
  consumed automatically by ingested events summing a metadata property. Balance in
  _units_. This is the documented "prepaid credits on your meters" feature.
- **Wallets** (SDK `walletsTopUp`): older prepaid _USD-cents_ balance. Not used — meter
  credits are the current, documented prepay mechanism and auto-deduct on events.

### 2.4 Customer = organization (research-backed)

Standard pattern (Vercel, Supabase, m3eter "pooled credits across org", Salable
"owner/grantee"): the **team/org is the billing entity**; members are internal grantees,
not billing customers. Polar `CustomerCreate` requires a **unique email** per Polar org +
optional `externalId` (= our orgId). So:

- **Polar customer = Zevium org**, `external_id = orgId`.
- Polar customer `email` = the org's **billing email** (new `billingEmail` column on
  `organization`, default = creator's email at org creation, editable). Unique per Polar
  org — a dedicated billing email avoids collisions if one user owns multiple orgs.
- Users are **not** Polar customers. They receive allocations from their org, tracked
  locally.

### 2.5 `@better-auth/polar` plugin is user-scoped (rejected)

The better-auth `polar()` plugin links `external_id = userId` and its `usage`/`portal`/
`checkout` endpoints operate on the session user. **Does not fit org billing.** → Do not
use it. Go direct `@polar-sh/sdk`, org-scoped. Keep `@polar-sh/sdk/webhooks`
`validateEvent` only.

### 2.6 `@better-auth/api-key` org model (referenceId, NOT a organizationId column)

Plugin source (`apiKeySchema`, lines 2135-2259) declares `referenceId` (indexed) but **no `organizationId` column**. The create flow (line 753-764) stores the owner in `referenceId`: org key → `referenceId = orgId`; user key → `referenceId = userId`. The `organizationId` param on create/list is for **permission scoping** (`checkOrgApiKeyPermission` queries the _member_ table, not apikey) and is NOT persisted as a dedicated column. `verifyApiKey` returns `key` including `referenceId` + `metadata`. Conclusion: for billing we use `referenceId` (make all proxy keys org-owned) — see §3.4.

### 2.7 The gap (current merged code)

| Concern          | Current (#127/#147)             | Target                                                                |
| ---------------- | ------------------------------- | --------------------------------------------------------------------- |
| Billing unit     | per-user (wrong)                | **org pool + per-user allocation**                                    |
| Balance          | Redis BITFIELD per user         | Polar meter credits (org) + local allocations                         |
| Cost             | flat 1 cent/call                | **per-host unit rate, 2xx-only**                                      |
| Spend            | `CreditsManager.deduct` (Redis) | `polar.events.ingest` (auto-deduct)                                   |
| Top-up           | webhook→`CreditsManager.add`    | Polar meter_credit benefit (auto on purchase)                         |
| Customer         | none (Polar as checkout only)   | Polar customer per org                                                |
| Markup/publisher | none                            | **cut** (no publisher accounting; spread external)                    |
| Key ownership    | `apikey.userId` only            | **org-owned keys** (`referenceId = orgId`); per-key quota via plugin  |
| Overspend gate   | n/a                             | **local atomic counter** (`orgConsumed`) — the only custom gate state |

## 3. Decisions

### 3.1 Two-tier gate (plugin-native + Polar-native)

Two gates per proxy call. Each uses a native mechanism — **zero custom Lua** for the per-key gate.

- **Per-key request quota** = `@better-auth/api-key` plugin's `remaining` counter (v1: no refill; `refillAmount = null`, `refillInterval = null`). `verifyApiKey` runs `consumeRemaining()` — an atomic guarded decrement (`incrementOne({ where: { remaining: { gt: 0 } }, increment: -1 })`). Throws/returns `USAGE_EXCEEDED` at 0. **Plugin-native. We write no gate code** — just handle the returned/thrown error. The plugin supports CAS refill later, but v1 deliberately avoids refill windows (§3.31).
- **Org pool money gate** = Polar meter credits (`sum` over `cost_units`). Polar auto-deducts on ingested events. The pool balance = `creditedUnits − consumedUnits`. We gate against this with **one local atomic counter** (`orgConsumed`, Redis Lua): `creditedUnits − orgConsumed ≥ cost_units` then increment `orgConsumed`. This is the **only irreducible local gate state** (one Redis key per org). Alternative: live `getStateExternal` per call (drops the counter, adds per-call Polar latency).
- **A call passes only if both gates pass.** Per-key quota = per-user limit (one user, one key, one quota). Org pool = prepaid money (Polar).
- **Cuts** (to kill state): no `creditAllocation` table (per-key plugin quota replaces it); no `ownerType` / `ownerUserId` / `organizationId` columns on apikey (plugin's `referenceId` = orgId for org-owned keys); no publisher earnings (publisher/marketplace cut — see §3.5).

### 3.2 Polar-native, org-scoped, direct SDK

Polar customer per org (`external_id = orgId`). Remove the better-auth `polar()` plugin.
Use `@polar-sh/sdk` directly. Delete `CreditsManager` / `credit_ledger` / custom webhook
body / flush cron.

### 3.3 Meter: `sum` over `cost_units`, event `proxy_call`

- Meter `proxy_calls`: filter `name = proxy_call`, aggregation `sum` over `cost_units`.

- Event: `{ name: "proxy_call", externalCustomerId: orgId, externalId: requestId, metadata: { cost_units, host, method, status } }`.
- Polar auto-deducts `cost_units` from the org's meter credit balance on ingest.
- Forward-compatible with per-token: add a `tokens` metadata field + a second meter later.

### 3.4 API key schema — minimal (plugin-native)

- **All proxy keys are org-owned** — configure the api-key plugin with `references: "organization"` (§3.16), so the plugin sets `referenceId = orgId` on create (verified in plugin source, create flow line 753-764). This is a per-config plugin option, not a per-request `referencesType` body field. The proxy reads `referenceId` → bills that org. **No dedicated `organizationId` column needed for billing** (the plugin does NOT declare one in `apiKeySchema`; its `organizationId` create param is for permission scoping only, persisted into `referenceId`). This collapses the user-owned-vs-org-owned billing split — there's only the org pool now (we cut user allocations in §3.1).
- **Track creator via `metadata.creatorUserId`** for attribution + the one-key-per-user constraint. The plugin's `metadata` column accepts arbitrary JSON.
- **Repurpose** `remaining` as the **per-key request quota** (per-user call cap). v1 sets `refillAmount = null` and `refillInterval = null` (one-shot keys; user creates a new key when exhausted). **Important:** this is request-count, not unit-cost. An expensive host (50 units/call) burns the same quota as a cheap one (1 unit/call).
- **Keep** `rateLimit*` for rate-limiting.
- **Drop** `requestCount` (dead; do not surface as billed usage). No `ownerType` / `ownerUserId` / `organizationId` columns — `referenceId` is the billing org.
- **One personal key per user per org** — server-side check at create: count keys where `referenceId = orgId AND metadata.creatorUserId = userId`. Prevents users stacking keys to bypass the per-user cap. (JSON-path count query is acceptable here — it's at create time, not per-proxy-call.)

### 3.5 Per-host unit cost (consumer rate only — publisher cut)

Publisher/marketplace tracking is **cut** (§3.10). The proxy charges the consumer rate per-host; Zevium's spread vs the upstream's actual cost is handled outside the app.

- `PROXY_HOST_UNIT_COSTS` env: JSON object, e.g. `{"api.openai.com":3,"api.anthropic.com":1,"api.example.com":50}`. Keys are normalized exact hosts (lowercase, no trailing dot/port). Units = what the consumer pays per call. Wildcard allowlist entries require explicit per-host costs in v1 (fail-closed if unpriced).
- Unpriced host → **403 fail-closed** (no free rides). No default fallback.
- Units ↔ USD: set by the meter_credit benefit. e.g. product $20 grants 2000 units → 1 unit = $0.01 → `api1` (3 units) = $0.03/call.

### 3.6 Local atomic gate (the only custom gate code)

Per-key quota gate is plugin-native (§3.1). The only custom gate is the **org-pool money gate**:

- One Redis key per org: `orgConsumed` (atomic counter). One Lua: `if creditedUnits − orgConsumed ≥ cost_units then incrby(orgConsumed, cost_units); return ok else insufficient`.
- `creditedUnits` cached (Redis) **with a TTL fallback (e.g. 5 min) + webhook invalidation** (§3.18). A missed webhook self-heals via TTL; webhooks keep it fresh. Polar is source of truth. (Earlier text said webhook-only — corrected: pure webhook invalidation risks permanent staleness on a dropped webhook.)
- `creditedUnits` uses a short Redis TTL cache for the gate decision (e.g. 5 min). This is intentional: avoids a Polar API call on every proxy request while self-healing missed webhooks. No overspend beyond `creditedUnits` because the reserve Lua is atomic against local `orgConsumed`.
- Event ingest happens **after 2xx + body-complete** and is awaited synchronously before returning the response (§3.40/§3.59). `externalId = requestId` for Polar dedup. Polar auto-deducts → org pool decrements at Polar. Local `orgConsumed` already incremented at reserve time → usually stays in sync; drift is handled as v1 limitation (§5).

### 3.7 Cross-org keys view

Flat `/app/settings/keys` may remain as a cross-org view listing the user's keys across all orgs they belong to (derived query, no new state), but creation/update/delete must be org-scoped server tRPC (§3.58). Which roles can create keys is controlled by the `apiKey` grants in §3.14 (owner/admin/developer/member is a product decision; org creator always bypasses via Better Auth).

### 3.8 Charge rule: 2xx only (refund both gates on failure)

**Validation ordering matters:** cheap checks first (normalize `x-zevium-host`, https-only, not private, in `PROXY_ALLOWED_HOSTS`, has a price), then `verifyApiKey`, then `orgPoolGate.reserve`, then fetch. Bad hosts / unpriced hosts never burn plugin quota or org pool. This also limits pre-verification DoS surface (invalid hosts rejected before plugin DB hit).

**`verifyApiKey` error differentiation:**

- `KEY_NOT_FOUND` / `INVALID_API_KEY` / disabled / expired → **401**
- `USAGE_EXCEEDED` (quota exhausted) → **429**
- Rate limit exceeded → **429** with `Retry-After`. **Also refund `remaining`** — `verifyApiKey` runs `consumeRemaining` _before_ `consumeRateLimit`, so a rate-limited call already burned a unit (§3.17).

`verifyApiKey` returns `key: Omit<ApiKey, "key"> | null` including `referenceId` (= orgId for org-owned keys) — **no extra lookup needed** for orgId in the proxy.

**Refund idempotency:** use a request-scoped `let refunded = false` guard. Multiple error paths (fetch throw, upstream non-2xx, stream `cancel()`) can fire; without the guard, double-refund on retry/cancel+error would over-credit the org.

**Upstream non-2xx → refund both gates:**

- **Refund `apikey.remaining`**: plugin auto-decremented it on `verifyApiKey`. Use **atomic drizzle** `db.update(apikey).set({ remaining: sql`remaining + 1` }).where(...)` (§3.15) — the plugin's `incrementOne` is internal-only; `updateApiKey({remaining: stale+1})` races under concurrency and loses increments.
- **Refund `orgConsumed`**: decrement it back atomically.
- **No Polar event ingested** → no Polar charge. Polar is unaffected on failure.

**Streaming cancel mid-body:** if upstream already returned 2xx (status sent + headers received) and the client cancels before reading the full body, we **still charge**. The upstream responded successfully; the client chose not to read. This is the gray area — documented as v1 behavior. If the fetch throws before any response is received, the catch block fires and we refund (no charge).

Polar order refunds (consumer-initiated) → Polar reverses the meter credit natively; `order.refunded` webhook invalidates the `creditedUnits` cache.

### 3.9 Credit purchase: variable amount ≥ $20

- Goal: consumer pays any amount ≥ $20, gets proportional units.
- Meter_credit benefit grants **fixed** units per purchase, so variable-amount needs
  either (a) Polar support for proportional/quantity-driven crediting on one-time
  checkout, or (b) fixed tiers ($20/$50/$100/…) as fallback.
- **Open: verify in sandbox** whether a one-time product can grant units proportional to
  the paid amount. If yes → single product, min $20, custom amount. If no → fixed tiers
  for v1, variable later. (Default plan: assume proportional is possible; fall back to
  tiers if the dashboard/SDK doesn't allow it.)

### 3.10 Publisher earnings — CUT

Publisher/marketplace tracking is **cut** for v1. Rationale: the proxy is host-based (not project-based), there's no in-app publisher org to route earnings to, and the marketplace/payout story (Stripe Connect) is a separate large feature. Zevium keeps the spread between consumer rate and upstream cost by paying upstreams externally (outside the app).

Consequences: no `publisherOrgId`, no markup config, no `publisherEarning` ledger, no host→publisher mapping, no publisher payout flow. The `metadata.publisherOrgId?` field on the proxy_call event (§3.3) is removed. Pure consumer-pays-per-host.

### 3.11 Polar customer created on org creation

- Hook org creation → `polar.customers.create({ externalId: org.id, email:
org.billingEmail, name: org.name, metadata: { orgId } })`; store returned id as
  `organization.polarCustomerId`.
- `organization` table: add `polarCustomerId: text`, `billingEmail: text`.
- Backfill script `scripts/backfill-polar-customers.ts` for any pre-existing orgs (none
  expected — new app).

### 3.12 Webhook: thin `validateEvent` handler

Webhook subscriptions + triggers:

- **`order.paid`** (primary): invalidates `creditedUnits` cache for the org. Fires when a top-up purchase completes. **Required for cache invalidation after purchase.**
- **`order.refunded`**: invalidates `creditedUnits` cache (refund restores credited units at Polar).
- **`customer.state_changed`** (secondary): may also invalidate cache as a safety net (meter_credit benefit grant on purchase can trigger this, but not guaranteed synchronous with `order.paid`).

The doc previously claimed `customer.state_changed` covers purchase — **wrong**. Per Polar SDK source (`WebhookCustomerStateChangedPayload`): fires on customer create/update/delete, subscription create/update, benefit grant/revoke — **not** on `order.paid`. Need `order.paid` as the primary trigger for cache invalidation after a top-up.

Signature verification via `@polar-sh/sdk/webhooks` `validateEvent(raw, headers, POLAR_WEBHOOK_SECRET)`. **No `CreditsManager.add`** — Polar credits the meter itself via the meter_credit benefit. Handler is thin: validate, parse type. **OrgId extraction:** `order.paid`/`order.refunded` payloads carry Polar's internal `customerId` + `metadata` (NOT `externalId`). Read `data.metadata.orgId` (set at checkout, copied to the order); fallback to DB reverse-lookup by `organization.polarCustomerId === data.customerId`. `customer.state_changed` carries `data.externalId` (= orgId) directly.

### 3.13 `@polar-sh/sdk` pinned 0.41.5 through this migration.

### 3.14 Org access control must grant `apiKey` permissions (BLOCKER)

The api-key plugin's org-key creation calls `checkOrgApiKeyPermission(ctx, userId, orgId, "create")`, which delegates to the org plugin's `hasPermission({ permissions: { apiKey: [action] } })` (verified in plugin source `checkPermission`, line 558-567). The org's `apiKey` statement must include `"create"` (and `"read"`, `"update"`, `"delete"` for full UX). Our `organization-access.ts` statement set (`ac`, `invitation`, `member`, `organization`, `team`) has **no `apiKey` statement** — and the plugin does **not** export `defaultStatements.apiKey` (it only uses the org plugin's defaults, which don't include `apiKey`). So **no role can create org-owned keys** until we add one.

Required: add `apiKey: ["create", "read", "update", "delete"]` to the statement set in `src/lib/server/organization-access.ts`, and grant the same set to `owner` + `admin` (+ optionally `developer`). **Include `"update"`** — needed for the key enable/disable UX. Without this, every org-owned key create throws a permission error. Verified against `src/lib/server/organization-access.ts`.

**Note — org creator bypass:** the plugin's permission check passes `allowCreatorAllPermissions: true` (line 566), so the user who created the org automatically gets all `apiKey` actions regardless of role grants. The role grants matter for _non-creator_ members. So: a member with the `member` role can create keys only if we grant `apiKey:["create"]` to `member`; the org creator can always. Decide based on UX (do we want all members to create keys, or only owner/admin?).

### 3.15 Refund path: drizzle atomic, not plugin adapter

The plugin's `incrementOne` is `ctx.context.adapter.incrementOne` — **plugin-internal**, not exposed via `auth.api`. For the `remaining` refund, use drizzle directly with an atomic SQL increment:

```ts
db.update(apikey)
  .set({ remaining: sql`remaining + 1` })
  .where(eq(apikey.id, keyId));
```

Atomic at the SQL layer (same guarantees as the plugin's guarded decrement). Do NOT use `auth.api.updateApiKey({ remaining: stale + 1 })` — races under concurrency. (Earlier doc text said "via the adapter" — corrected to drizzle direct.)

### 3.16 api-key plugin config: `references: "organization"` (BLOCKER)

`referencesType` is read from `opts.references` — a **per-config plugin option** (default `"user"`), NOT a per-request body field (verified in plugin source, `claimUsageInDatabase` / create flow line 753). To make all keys org-owned (`referenceId = orgId`), set `references: "organization"` on the `apiKey(...)` plugin config in `src/lib/server/auth.tsx`. Without this, creates default to user-keys (`referenceId = userId`) and the org-billing model breaks (proxy can't resolve the billing org from a user-scoped `referenceId`).

Consequence: with `references: "organization"`, **every** key create requires `organizationId` in the body (plugin throws `ORGANIZATION_ID_REQUIRED` otherwise) + the `apiKey:["create"]` permission (§3.14). There are no user-owned keys under this config — which is exactly what we want (only the org pool exists). Set `metadata.creatorUserId` server-side for attribution + the one-key-per-user check.

### 3.17 Rate-limited calls burn `remaining` (refund on RATE_LIMITED too)

Verified in plugin source (`claimUsageInDatabase`, lines 1734-1737): `consumeRemaining` runs **before** `consumeRateLimit`. So a call that hits the rate limit has **already** decremented `remaining` before the verify endpoint returns/throws `RATE_LIMITED`. The proxy must refund `remaining` when `verifyApiKey` reports `RATE_LIMITED`. Since org-pool reserve happens after verify, there is no org-pool refund on this path.

### 3.18 `creditedUnits` cache needs a TTL fallback

Webhook-only invalidation means a **missed** `order.paid` webhook = permanent stale cache (org can't spend newly purchased credits). Add a TTL safety net (e.g. 5 min) so the cache self-heals even if every webhook is dropped. Webhook invalidation stays for freshness; TTL is the floor.

### 3.19 `orgConsumed` durability

`orgConsumed` (Redis) is authoritative for the gate. If Redis loses it (flush/restart without persistence), the counter resets to 0 → the gate thinks nothing was consumed → the org can spend its full `creditedUnits` again (overspend). Mitigations: (a) confirm Upstash persistence (AOF) is on for the credits Redis instance, (b) periodic reconcile job that recomputes `orgConsumed` from Polar's `consumedUnits` (v2). For v1: require Upstash persistence + document the risk.

### 3.20 Checkout MUST pass `customerId` (critical)

Verified in `CheckoutCreate` (Polar SDK): `customerId` is optional; if omitted + `customerEmail` is passed, Polar find-or-creates a customer by email. Since we use a **unique per-org billing email** (no collision), Polar would create a **new** customer for the checkout (no match). The purchased meter credits would be granted to the **new** customer, not the one we created in `ensureOrgCustomer` (which holds the org's `externalId` + meter state). Result: org's `getStateExternal({ externalId: orgId })` keeps returning 0; credits appear to vanish.

Fix: `createCreditsCheckout` must pass `customerId: org.polarCustomerId` explicitly. This links the checkout to the existing customer (carrying the meter_credit benefit + correct externalId). The `customerEmail` field is then unnecessary on the checkout (leave default).

### 3.21 Key create must be server-side (creatorUserId is client-trusted)

Verified in plugin source (create flow line 746): `metadata` is read from `ctx.body` and stored verbatim. The plugin does **not** validate that `metadata.creatorUserId` matches the session. A client could pass `metadata: { creatorUserId: "other-user-id" }` to bypass the one-key-per-user count check (the count queries by the real session userId, finds 0, allows the create). The limit is a UX guard, not a security boundary — but to be meaningful, `creatorUserId` must be set **server-side from the session**, not accepted from the client body.

Fix: do NOT use the client's `auth.apiKey.create` for org-owned keys. Add a server-side tRPC mutation (e.g. `orgKey.create`) that reads the session, then calls `auth.api.createApiKey` (server-side call, not client plugin) with: `organizationId` from URL, `metadata: { creatorUserId: session.user.id }` **set by the server**, explicit `permissions`, explicit `rateLimit`, explicit `remaining`, `expiresIn: null`, and `name` from validated input. Do **not** pass `referencesType`/`references` per request — org ownership comes from the plugin config (`references: "organization"`, §3.16). Do **not** pass `prefix` per key — the plugin config's `defaultPrefix` applies (§3.38/§3.52). The client UI calls this tRPC mutation, not the auth client plugin. (Server-side calls are NOT subject to the `SERVER_ONLY_PROPERTY` check at line 751, so refill/permissions/remaining are settable from server.)

### 3.22 One-key-per-user race → unique partial index

The create-time count check (server-side, §3.21) has a TOCTOU race: two concurrent creates both see count=0, both pass, both insert. Need a DB-level guard. Turso (libSQL/SQLite) supports functional indexes on JSON paths:

```sql
CREATE UNIQUE INDEX apikey_one_per_org_creator
  ON apikey (reference_id, json_extract(metadata, '$.creatorUserId'))
  WHERE reference_id IS NOT NULL;
```

This enforces one key per `(orgId, creatorUserId)` at the DB level. The second concurrent insert throws a unique-constraint error → the tRPC mutation maps it to a clean "you already have a key" error. Apply in the same `0015` migration that adds the org columns. (The plugin's apikey table accepts extra indexes via Drizzle.)

### 3.23 Org creation hook: mechanism + failure handling

Mechanism: orgs are created via `auth.api.createOrganization` (called from a tRPC mutation). Wrap that tRPC mutation (or use a `databaseHooks` `organization.create.after` hook) to call `ensureOrgCustomer(org)` after the org row is persisted. The doc previously said "hook org creation" generically — the concrete mechanism is the tRPC wrapper, since `databaseHooks` for org create have less control over the return value needed for the org id.

Failure handling: if `ensureOrgCustomer` fails (Polar API down, network), the org row exists with `polarCustomerId = null`. Do NOT roll back the org (the user already saw success). Add a **lazy fallback**: in `createCreditsCheckout` and `getOrgCreditedUnits`, if `org.polarCustomerId === null`, call `ensureOrgCustomer(org)` first, then proceed. Self-heals on next interaction. Log to PostHog for visibility.

### 3.24 Unique billing email formula

Polar requires `email` unique within the org (Zevium's Polar org). Defaulting to the creator's email collides when one user creates multiple Zevium orgs. Concrete formula: `billingEmail = \`org-${org.id}@billing.zevium.dev\``— deterministic, unique per org (orgId is a cuid), and clearly non-personal (no real inbox). Set in the org-create tRPC mutation (same place that calls`auth.api.createOrganization`) and persist on `organization.billingEmail`. Used by `ensureOrgCustomer` as the Polar customer email.

### 3.25 Lua must default nil `orgConsumed` to 0 + init at org creation

On the first-ever call for an org, `GET orgConsumed` returns `nil`. In Redis Lua, `tonumber(nil)` is `nil`, and `nil + cost` **throws a Lua error** → the gate errors → proxy 500 (or crashes the worker). Two fixes required:

1. **Lua script**: use `local cur = tonumber(redis.call('GET', KEYS[1])) or 0` (defaults nil to 0). All reserve/refund scripts must apply this.

2. **Init at org creation**: in the tRPC org-create mutation (same place that calls `ensureOrgCustomer`), after the org row is persisted, run `redis.set(\`orgConsumed:${orgId}\`, 0, { nx: true })`. Idempotent. Guarantees the key exists. Also run on first `getOrgCreditedUnits` if missing (defense in depth).

### 3.26 Unique index on `organization.polarCustomerId`

Add `UNIQUE INDEX org_polar_customer_id_idx ON organization(polar_customer_id) WHERE polar_customer_id IS NOT NULL` in migration `0015`. Prevents two orgs pointing to the same Polar customer (would happen if `ensureOrgCustomer` races + the unique-email trick fails, or if someone manually edits the column). Also makes the `order.paid` reverse-lookup (`WHERE polarCustomerId = data.customerId`) safely assume at most one match.

### 3.27 Key create must set `permissions: { api: ["read"] }` (verified)

Verified in plugin source (lines 1680-1684): if `verifyApiKey` is called with a `permissions` argument, the key's `permissions` column MUST be populated + parseable as JSON, otherwise it throws `KEY_NOT_FOUND` (401). Our proxy passes `permissions: { api: ["read"] }` to verify, so every key MUST be created with `permissions: { api: ["read"] }` — the absence of which would cause every proxy call to 401. The `orgKey.create` tRPC mutation must hardcode `permissions: { api: ["read"] }` (server-side, §3.21). Also set a default `prefix` (e.g. `zevium`) + `rateLimit` (e.g. `{ enabled: true, max: 60, timeWindow: "1m" }`) so rate limiting is on by default and keys are identifiable.

### 3.28 Worker death between reserve and response = local double-charge

Sequence: request A → reserve Lua increments `orgConsumed` by cost → fetch upstream → upstream returns 2xx → body stream starts → **worker killed before body-complete/commit+ingest** (Cloudflare worker shutdown, CPU limit). Client retries with a NEW request (new requestId) → reserve Lua increments `orgConsumed` again → second call succeeds. Net: `orgConsumed` can be higher than Polar consumed (over-reserved locally). Bounded by in-flight retry count; the next reconcile (§3.19/v2) corrects it. v1 accepts. v2: client-supplied `Idempotency-Key` header used as the Polar `externalId` so retries dedupe (requires SDK change).

### 3.29 Proxy auth header = `x-zevium-key` (verified against current impl)

The current proxy (`src/routes/api/proxy/$.ts`) already uses the `x-zevium-key` header for auth (line 60) and **strips it from the outbound** request before forwarding to the upstream (line 125) — no leak/conflict with the upstream's own `Authorization` header. The header design is correct; the migration must preserve it. Specify in the §4.4 flow: read `x-zevium-key` for `verifyApiKey`, strip from outbound headers. (No `Authorization`-header design needed — `x-zevium-key` avoids the dual-bearer conflict.)

### 3.30 Checkout uses custom price inline (product ID only, no `productPriceId`)

The implemented `createCreditsCheckout` passes `products: [POLAR_PRODUCT_ID_CREDITS]` **plus** a `prices` map carrying a `custom` amount type (`presetAmount: amountUsd * 100`, `priceCurrency: "usd"`). Polar creates the one-off price inline at checkout — no pre-made `productPriceId` env var is needed. So the env holds **only** `POLAR_PRODUCT_ID_CREDITS`; there is no `POLAR_PRICE_ID_CREDITS`. (Verified against `src/lib/server/polar.ts`.)

### 3.31 No refill by default (one-shot keys)

The doc never specified the default `refillAmount` / `refillInterval`. For v1, **no refill**: `refillAmount: null`, `refillInterval: null` (server-side in `orgKey.create`). The key is consumed until `remaining = 0`, then `USAGE_EXCEEDED` → the user creates a new key. Simpler than quota windows; no CAS-refill races to reason about. If we want periodic refill later, the plugin supports it per-key. Set a reasonable `remaining` default (e.g. `1000`) — configurable per key on create.

### 3.32 Refund of an already-spent order → org locked out until reconcile

When a one-time order is refunded, Polar reverses the meter credit grant. If the org already spent some of those credits, Polar's view is `creditedUnits = 0` (grant removed), `consumedUnits = X` (unchanged). The org's `getStateExternal` returns `max(0, creditedUnits - consumedUnits) = 0`. The local `orgConsumed` is still `X` (we never decrement on refund). The gate: `0 - X < cost` → 402. The org is **locked out** of all proxy calls until either (a) the reconcile job (v2) resets `orgConsumed` to match Polar's consumed, or (b) the org buys more credits (which sets `creditedUnits > 0` and the gate passes again). v1 accepts the temporary lockout; document. To avoid lockout: on `order.refunded`, cap `orgConsumed` to the new `creditedUnits` (best-effort, may over-clamp if consume happens concurrently). Defer to v2.

### 3.33 Webhook idempotency by `webhook-id` header (future-proofing)

Polar sends a `webhook-id` header on every delivery for dedup. Our current handler is idempotent (cache invalidation is safe to repeat), so redelivery is harmless. But once we add real side effects (PostHog events, DB writes per top-up), dedup by `webhook-id` in a Redis SET with TTL (e.g. 24h) to prevent double-processing. Build the dedup scaffolding now (cheap) so we don't bolt it on later. Not blocking for v1.

### 3.34 Redis key namespace: `zevium:*`

All Redis keys the migration creates MUST be namespaced to avoid collision with other apps sharing the same Upstash Redis instance (the existing cache module uses `${namespace}:...` — e.g. `cache:fnName:hash`). Use:

- `zevium:orgConsumed:${orgId}` — the atomic counter
- `zevium:credited:${orgId}` — the `creditedUnits` cache (TTL 5min)
- `zevium:webhookIds` (SET) — the dedup set (§3.33)

Add a single `REDIS_NAMESPACE = "zevium"` constant in `src/lib/server/redis.ts` (new tiny file) and prefix every key. Easy to forget when scattering `SET`/`GET` calls.

### 3.35 `rateLimit.timeWindow` is a NUMBER (ms), not a string

Correction: the api-key plugin reads `rateLimitTimeWindow` as a number (milliseconds) from the create body (verified in plugin source line 746). The `orgKey.create` spec in §3.27 said `timeWindow: "1m"` — **wrong**. Use `timeWindow: 60000` (number). Same for `expiresIn` (ms). All durations in the plugin are numbers in ms.

### 3.36 SSRF self-loop + DNS rebinding guards (security)

The proxy fetches whatever `x-zevium-host` says. Two real attack vectors the existing `isPrivate` check does NOT cover:

1. **Self-loop.** `x-zevium-host: zevium.dev` → the proxy fetches itself → infinite loop / recursive proxy. Add: reject if the normalized host equals the proxy's own hostname (from env, e.g. `PROXY_PUBLIC_HOST`).

2. **DNS rebinding.** A public hostname (e.g. `attacker.com`) resolves to a private IP (e.g. `169.254.169.254` AWS metadata). The `isPrivate` check is on the hostname string, not the resolved IP. Fix: `dns.resolve(host)` before `fetch`, reject if any resolved IP is private/loopback/link-local. Cache the resolution for the request (or short TTL) to avoid per-byte lookups.

Both belong in the cheap-checks step (§4.4 line 1) — before any DB/Redis hit, so they also limit DoS surface.

### 3.37 `createCreditsCheckout` needs `amount` + `currency` (verified)

For a one-time product with a **custom** (variable-amount) price, `CheckoutCreate` takes the product ID **plus** a `prices` entry declaring the custom amount (smallest currency unit, e.g. cents) **plus** `priceCurrency`. The implemented helper (`src/lib/server/polar.ts`):

```ts
const productId = serverEnv.POLAR_PRODUCT_ID_CREDITS;
const checkout = await polarClient.checkouts.create({
  customerId,
  metadata: { orgId: input.orgId },
  prices: {
    [productId]: [
      {
        amountType: "custom",
        presetAmount: input.amountUsd * 100,
        priceCurrency: "usd",
      },
    ],
  },
  products: [productId],
  successUrl: input.successUrl,
});
```

Min $20 enforced server-side BEFORE calling Polar (reject if `amountUsd < 20`).

````

Min $20 enforced server-side BEFORE calling Polar (reject if `amountUsd < 20`).

### 3.38 `prefix` set per-config in `auth.tsx`, not per-key

For consistency, set the api-key plugin's `defaultPrefix: "zev_"` in the plugin config in `auth.tsx` (alongside `references: "organization"` from §3.16), NOT per-key in `orgKey.create`. This preserves the existing repo convention (`src/lib/server/auth.tsx` currently uses `defaultPrefix: "zev_"`) and follows the plugin docs' recommendation to include a trailing underscore. The `orgKey.create` server-side call does NOT pass `prefix` (uses the config default).

### 3.39 Concrete deletion list (flush cron + worker + old credits files)

The doc said "delete the flush cron + worker handler" generically. Concrete files to delete (verified against the repo):

- **`wrangler.toml`**: remove `crons = ["0 0 * * *"]` (or the whole `[triggers]` block).
- **`src/worker.ts`**: remove the `scheduled` handler (lines 5-47). The whole file becomes a re-export of the TanStack Start server entry — can be deleted entirely if nothing else needs it.
- **`src/routes/api/credits/$.ts`**: delete (the flush endpoint hit by the cron).
- **`src/lib/server/credits.ts`**: delete (the `CreditsManager`).
- **`src/lib/server/credits-success.ts`**: delete (the old Polar checkout success redirect handler).
- **`src/lib/server/credits.test.ts`**: delete (tests for `CreditsManager`).
- **`src/lib/shared/credits-keys.ts`**: delete (shared key constants).
- **`src/routes/app/settings/credits/success.tsx`**: delete (old checkout success page). The rewritten credits page handles success inline.
- **`src/server/rpcs/credits/index.ts`**: rewrite (org-scoped, not user-scoped).
- **`src/routes/app/settings/credits.tsx`**: verify no stale `CreditsManager` imports.
- **`src/env/server.ts`**: drop `CREDITS_FLUSH_SECRET`. Add `POLAR_METER_ID`, `POLAR_PRODUCT_ID_CREDITS`, `POLAR_WEBHOOK_SECRET`, `POLAR_ACCESS_TOKEN`, `POLAR_ORGANIZATION_ID`, `POLAR_SERVER`, `PROXY_PUBLIC_HOST` (for §3.36), `PROXY_HOST_UNIT_COSTS`. (No `POLAR_PRICE_ID_CREDITS` — custom price is created inline at checkout, §3.30.)

### 3.40 `waitUntil` NOT available in TanStack Start route handlers (architectural)

Verified in `src/worker.ts` line 7: the Cloudflare `ExecutionContext` is dropped (`_ctx: ExecutionContext` → unused). The `defaultServerEntry.fetch(request)` call only receives the `Request` — no context is threaded into the TanStack Start app. So **route handlers (including the proxy) cannot call `ctx.waitUntil`**. The `waitUntil` API exists in the `scheduled` handler (line 9) but is unreachable from inside a route.

**Impact on the ingest path:** the proxy was designed to `waitUntil(events.ingest(...))` after a 2xx response to keep the worker alive for the background ingest. Without `waitUntil`, the worker may be killed after the response is sent → ingest lost → local `orgConsumed` up but Polar not charged (drift). The reconcile job corrects it, but the drift window is real.

**Options for v1:**

- **(a) Synchronous ingest (recommended for v1).** `await events.ingest(...)` BEFORE returning the response. Adds ~50-200ms latency per 2xx call. Guarantees the ingest completes. Simplest, no architectural change. **Pick this for v1.**
- **(b) Fire-and-forget.** `void events.ingest(...).catch(log)` — no await, no `waitUntil`. Worker may be killed before completion. Drift risk. Not recommended.
- **(c) Thread `ctx` through.** Modify `src/worker.ts` to pass `ctx` to a custom server entry that threads it into route handlers via a Hono middleware or a request-scoped AsyncLocalStorage. Architectural change, bigger surface. v2.

Update §4.4 flow: the proxy awaits `ingestProxyCall(...)` before returning the 2xx response. The refund path is unchanged. Document the latency cost.

### 3.41 Redirect bypass (SSRF) — `redirect: "error"`

The `fetch` API in Cloudflare Workers follows redirects by default (up to 20). If the upstream returns a 3xx with `Location: http://169.254.169.254/...` (AWS metadata) or `Location: http://zevium.dev/...` (self-loop), `fetch` follows it, **bypassing our allowlist + private-IP check** (which only ran on the initial host). Real SSRF bypass.

Fix: pass `redirect: "error"` to `fetch` in the proxy. Any redirect causes `fetch` to throw → proxy returns 502. Simple, no allowlist maintenance for redirect targets. Trade-off: upstreams that use 3xx for legitimate flows (e.g., auth redirects) will break. For an API proxy, this is acceptable — APIs rarely redirect. If a specific upstream needs redirect support, handle it per-host later.

### 3.42 `ensureOrgCustomer` — check for existing customer first

Current spec: `if missing, polar.customers.create(...)`. But: how do we know if it's missing? The doc assumed "check first, create if missing" but named the wrong API. The SDK does **not** support `customers.list({ externalId })`; instead it exposes `customers.getExternal({ externalId })`. Real impl:

```ts
let customer;
try {
  customer = await polar.customers.getExternal({ externalId: orgId });
} catch (err) {
  // Only create on true not-found; rethrow other SDK/network errors
  customer = await polar.customers.create({ externalId: orgId, email, name, metadata: { orgId } });
}
// persist customer.id as org.polarCustomerId
````

`externalId` is unique within the Polar org, so `getExternal` is the right idempotent lookup. Avoids the unsupported `list({ externalId })` shape and avoids a create-and-catch-duplicate race. If the SDK exposes a typed not-found error/status, branch on that explicitly; do not create on arbitrary network/500 errors.

### 3.43 Lua must reject `cost = 0`

The reserve script should reject `cost <= 0` to prevent no-op reserves (which would silently let a call through without consuming `orgConsumed`). The `getHostCost` function guarantees `cost > 0` (or throws 403), so `cost = 0` shouldn't reach the Lua — but defense in depth. Reject in the Lua: `if tonumber(ARGV[1]) <= 0 then return redis.error_reply('invalid cost') end`.

### 3.44 Webhook handler: filter by event type FIRST, then orgId

Polar's webhook endpoint receives ALL event types for the org (not just ours). Our handler should:

1. Validate signature (always).
2. Parse event type. If unknown (`subscription.created`, `benefit.updated`, etc.) → return 200 immediately (acknowledge to prevent retries, but do no work).
3. For `order.paid` / `order.refunded`: check `data.metadata.orgId` FIRST. If missing or not a valid org in our DB → return 200 (not our order, skip).
4. For `customer.state_changed`: check `data.externalId` FIRST. If missing or not a valid org → return 200 (not our customer, skip).

This filters out webhooks for other products/customers in the same Polar org before doing any work. Avoids log noise + wasted cache invalidations.

### 3.45 UI needs `getOrgBalance` RPC + same `orgConsumed` key as the gate

The credits page UI must show the **available balance** (= `creditedUnits - orgConsumed`). But `orgConsumed` is server-side Redis state — the UI can't read it directly. The doc never specified how the UI computes the available balance.

**Fix:** add a `getOrgBalance(orgId)` RPC in `src/server/rpcs/credits/index.ts` (the rewritten credits RPC). It does the SAME computation as the gate's reserve Lua, but read-only:

```ts
// peek.lua — read-only, no increment
const cur = tonumber(redis.call('GET', KEYS[1])) or 0  // KEYS[1] = zevium:orgConsumed:ORG_ID
local credited = tonumber(ARGV[1])                       // ARGV[1] = creditedUnits (from cache/Polar)
local available = credited - cur
if available < 0 then available = 0 end                // clamp for refund-lockout (§3.32)
return available
```

The UI calls `getOrgBalance(orgId)` → displays `available` as "X credits remaining." The gate's reserve Lua does the same computation atomically and increments on success. Both read/write the SAME `zevium:orgConsumed:ORG_ID` key → no drift between UI and gate. Refetch on mount + manual refresh button. The RPC lives in the same `credits` tRPC router that gets rewritten (§3.39).

### 3.46 Credits RPC surface (concrete list)

The doc said "rewrite `src/server/rpcs/credits/index.ts`" but never listed the procedures. Concrete list:

- `getBalance(orgId)` — returns `{ available, creditedUnits, consumedUnits }` via the peek Lua (§3.45).
- `createTopUp({ orgId, amountUsd, successUrl })` — validates `amountUsd >= 20`, lazy `ensureOrgCustomer` if needed, calls `createCreditsCheckout` (§3.37), returns the checkout URL for redirect.
- `listTopUps(orgId)` — recent top-ups. v1: query Polar's `orders.list({ customerId: org.polarCustomerId, productId: POLAR_PRODUCT_ID_CREDITS })`. Returns up to N recent. v2: local mirror table.
- `listCharges(orgId)` — recent charges (events.ingest). v1: query Polar's `events.list({ externalCustomerId: orgId, name: 'proxy_call' })`. Returns up to N recent. v2: local mirror.
- `listPerKeyUsage(orgId)` — per-key usage. Query the apikey table for the org's keys, join with the `kind` column... wait, we cut `kind`. Use `metadata.creatorUserId` for attribution. Returns keys with `remaining` + `name` + `creatorUserId`.

### 3.47 UI must poll balance after Polar checkout redirect

After Polar redirects the user back to `successUrl`, the `order.paid` webhook may not have fired yet (Polar webhook latency is typically < 5s but can be longer). The UI must poll `getOrgBalance` every 2s for up to 30s after returning, showing a "Processing top-up..." state until the balance updates. Then show the new balance + a success toast. Without polling, the user sees the stale balance and thinks the top-up failed.

### 3.48 Test plan (replaces deleted `credits.test.ts`)

Deleting `src/lib/server/credits.test.ts` (per §3.39) drops the existing test coverage. The migration introduces new billing logic that MUST be tested. Add:

- **`src/lib/server/org-pool-gate.test.ts`**: unit tests for the Lua scripts (mock `@upstash/redis`). Cover: reserve success, reserve insufficient, reserve nil orgConsumed, refund, refund idempotency, peek.
- **`src/lib/server/polar.test.ts`**: unit tests for the SDK helpers (mock `@polar-sh/sdk`). Cover: `ensureOrgCustomer` (list-first + create), `getOrgCreditedUnits` (cache miss + hit + no-active-meter), `createCreditsCheckout` (with `customerId` + `amount` + `currency`), `ingestProxyCall`.
- **`src/server/rpcs/credits/index.test.ts`**: RPC tests (mock the helpers). Cover: `getBalance`, `createTopUp` (validation + lazy `ensureOrgCustomer`), `listTopUps`, `listCharges`.
- **`src/routes/api/proxy/$.test.ts`**: proxy flow tests (mock `auth.api`, Redis, Polar). Cover: happy path 2xx, non-2xx refund, `RATE_LIMITED` refund, `USAGE_EXCEEDED` no-refund, insufficient org pool 402, invalid host 403, self-loop 403, DNS-rebinding 403, missing `x-zevium-key` 401, missing `x-zevium-host` 400.
- **`src/routes/api/polar/webhook.test.ts`**: webhook tests (mock `validateEvent`). Cover: signature fail 401, unknown event type 200, `order.paid` cache invalidation, `order.refunded` cache invalidation, `customer.state_changed` cache invalidation, non-our-org skip 200, idempotent redelivery.

Update `vitest.config.ts` if needed (the existing config covers `src/**/*.test.ts`). Fine.

### 3.49 AGENTS.md + README.md updates (follow-up)

The migration changes the architecture. Update:

- **`AGENTS.md`**: directory structure (add `src/lib/server/polar.ts`, `org-pool-gate.ts`, `redis.ts`; remove `credits.ts`, `credits-success.ts`); RPC list (rewrite `credits` RPC entry to org-scoped + list procedures from §3.46); env vars (add `POLAR_*` + `PROXY_PUBLIC_HOST` + `PROXY_HOST_UNIT_COSTS`; remove `CREDITS_FLUSH_SECRET`).
- **`README.md`**: proxy section (auth via `x-zevium-key`, pricing model); credits section (Polar-native, org pool, no metered price).

Not blocking for v1 — can ship the code first, update docs in a follow-up commit. But list here so it's not forgotten.

### 3.50 Refund Lua must validate `cur >= cost` to prevent negative `orgConsumed`

If the refund Lua does `INCRBY -cost` without validation, a bug or concurrent issue can drive `orgConsumed` below 0. Once negative, the reserve Lua computes `creditedUnits - (-X) = creditedUnits + X` → the gate **always passes** (the org appears to have unlimited credits). The org can overspend until the next reconcile resets `orgConsumed` to match Polar.

Fix: the refund Lua must validate before decrementing:

```lua
-- refund.lua
local cost = tonumber(ARGV[1])
if cost == nil or cost <= 0 then return redis.error_reply('invalid cost') end
local cur = tonumber(redis.call('GET', KEYS[1])) or 0
if cur < cost then return 0 end  -- refuse: would go negative; caller logs + reconciles
redis.call('INCRBY', KEYS[1], -cost)
return 1
```

Defense in depth: the reserve Lua should also clamp `cur` to `>= 0` so a pre-existing negative value can't break the gate:

```lua
-- reserve.lua (add to §3.25's `or 0` pattern)
local cur = tonumber(redis.call('GET', KEYS[1])) or 0
if cur < 0 then cur = 0; redis.call('SET', KEYS[1], 0) end  -- self-heal negative
```

Both fixes are one-liners. The peek Lua (§3.45) already clamps `available` to `>= 0`, so the UI is safe even if `orgConsumed` is briefly negative.

### 3.51 Current proxy patterns to preserve (verified against `src/routes/api/proxy/$.ts`)

Verified the current proxy implementation has patterns the migration must preserve:

1. **`userId` derivation breaks with org-owned keys (lines 138-148).** The current proxy derives `userId` from `verification.key.userId` / `verification.userId` / etc. With `references: "organization"`, the key has NO `userId` (it has `referenceId = orgId`). The `ApiKeyVerificationUserShapeZod` + safeParse dance will fail → the proxy returns 401 "API key verification did not include a user id." Fix: remove the `userId` derivation entirely. The billing unit is the org (`referenceId`), not the user. The `metadata.creatorUserId` is only for the one-key-per-user check (at create time), not at proxy time.

2. **Stream cancel handler must refund (lines 230-235).** The current proxy wraps `upstream.body` in a `ReadableStream` with a `cancel` callback that calls `refundReservedChargeInternal()`. This handles the "streaming cancel after 2xx" case (§5): the client cancels the body stream after the 2xx headers, the proxy refunds the charge. The migration must preserve this pattern — replace `refundReservedChargeInternal` (which calls `CreditsManager.add`) with the new `refundBoth` that calls `orgPoolGate.refund` + `db.update(apikey).set({remaining: sql\`remaining+1\`})`.

3. **Outbound header stripping (lines 125-127).** The current proxy strips `x-zevium-key`, `content-length`, and `cookie` from the outbound request. Preserve all three. `cookie` stripping is a privacy decision (don't leak the client's cookies to the upstream). `content-length` is set by `fetch` automatically.

4. **Response header stripping (line 219).** Strip `x-zevium-proxy-secret` from the response (don't leak the internal proxy secret to the client). Preserve.

5. **`UpstreamNonOK` custom error (line 212).** The current proxy throws a custom `UpstreamNonOK(upstream)` error after the refund. Preserve the pattern (it bubbles to the response handler which returns the upstream's status + body).

6. **Flat `PROXY_CALL_COST_CENTS` cost (line 157).** The current proxy uses a flat cost per call. The migration replaces with `cost = getHostCost(host)` (per-host variable). The `CreditsManager.add` refund (which takes `amountCents`) is replaced with `orgPoolGate.refund(orgId, cost)` + `apikey.remaining` refund (which take `costUnits`).

7. **`refundReservedCharge` state machine (lines 150-169).** The current proxy uses a `chargeState` state machine (`"not_reserved"` → `"reserved"` → `"refunded"` / `"committed"`) to prevent double-refund and double-commit. The migration must preserve this pattern with the new gate logic.

### 3.52 Exact `auth.tsx` plugin delta (current config conflicts with plan)

Current `src/lib/server/auth.tsx` has several settings that conflict with the migration plan. Exact changes:

```ts
apiKey({
  defaultPrefix: "zev_", // keep existing prefix; §3.38
  enableMetadata: true,
  keyExpiration: { defaultExpiresIn: null }, // no expiry by default; §3.31
  permissions: { defaultPermissions: { api: ["read"] } },
  rateLimit: { enabled: true, maxRequests: 60, timeWindow: 60_000 },
  references: "organization", // BLOCKER; §3.16
});
```

Specific conflicts verified in current file:

- Current config has **no `references: "organization"`** → defaults to user-owned keys (blocker).
- Current config has `keyExpiration.defaultExpiresIn = 30 days` → conflicts with §3.31 no-expiry keys. Set `defaultExpiresIn: null` or explicitly pass `expiresIn: null` on every server-side create. Prefer config default null.
- Current config has `rateLimit.maxRequests = 200` per minute → plan says default 60/min. Pick one. Current doc now specifies **60/min** (`maxRequests`, not `max`).
- Current config already has `permissions.defaultPermissions = { api: ["read"] }` and `enableMetadata: true` — keep them. Still pass permissions explicitly in `orgKey.create` for defense in depth (§3.27).
- Current config uses `defaultPrefix: "zev_"` — keep it; prior doc text said `prefix: "zevium"`, which is wrong for this plugin (`defaultPrefix` is the config key).

### 3.53 Remove `@polar-sh/better-auth` plugin from `auth.tsx` completely

Current `auth.tsx` still imports and uses:

```ts
import { checkout, polar } from "@polar-sh/better-auth";
// ...
polar({
  client: polarClient,
  createCustomerOnSignUp: true,
  use: [checkout()],
});
```

This is user-scoped and conflicts with org billing. Remove the import and plugin entirely. Consequences:

- No customer creation on user signup (correct; customers are org-scoped via `ensureOrgCustomer`).
- No Better Auth checkout helper (correct; `createCreditsCheckout` uses direct SDK).
- `src/lib/server/polar.ts` stops being a bare client export and becomes the helper module (`ensureOrgCustomer`, `getOrgCreditedUnits`, `createCreditsCheckout`, `ingestProxyCall`, `getHostCost`).
- Remove `@polar-sh/better-auth` dependency if nothing else imports it after migration; keep only `@polar-sh/sdk`.

### 3.54 Reuse existing `kv` module, don't add a parallel Redis client

The repo already has `src/lib/server/kv/index.ts` exporting `kv = new Redis({ automaticDeserialization: true, enableAutoPipelining: false, ... })`. The doc previously said "new `src/lib/server/redis.ts`" (§3.34). Better fix: reuse `kv` for `org-pool-gate`, credited cache, and webhook-id dedup. Add only a tiny key-builder module if needed (e.g. `src/lib/server/redis-keys.ts` with `REDIS_NAMESPACE = "zevium"`). Do NOT instantiate a second Upstash client.

`enableAutoPipelining: false` is important because this repo already documented that Upstash auto-pipelining breaks chainable helpers like `bitfield()`. Preserve it.

### 3.55 Schema file changes, not just migrations

The plan listed migrations, but implementation must update `src/db/schema.ts` too. Concrete schema deltas:

- Remove `creditLedger` table from `schema.ts` (currently lines 9-30). The migration drops `credit_ledger`; the schema must stop exporting it.
- Add `organization.polarCustomerId` (`text("polar_customer_id")`) and `organization.billingEmail` (`text("billing_email")`). Nullable because lazy `ensureOrgCustomer` may fill after org creation / after Polar outage.
- Add unique partial index on `organization.polarCustomerId`: `WHERE polar_customer_id IS NOT NULL`.
- Add unique partial/functional index on `apikey`: `(reference_id, json_extract(metadata, '$.creatorUserId')) WHERE reference_id IS NOT NULL`. This belongs in both the SQL migration and the Drizzle schema definition so future migrations don't try to re-add/drop it incorrectly.
- No `creditAllocation` / `publisherEarning` tables exist in current schema (verified); nothing to drop there.

### 3.56 Env file exact delta (`src/env/server.ts`)

Current `src/env/server.ts` still requires `CREDITS_FLUSH_SECRET` and lacks required new envs. Exact delta:

Remove:

- `CREDITS_FLUSH_SECRET` (currently required; app will keep demanding it unless removed).

Add required:

- `POLAR_METER_ID`
- ~~`POLAR_PRICE_ID_CREDITS`~~ not needed (custom price inline, §3.30)
- `PROXY_HOST_UNIT_COSTS`
- `PROXY_PUBLIC_HOST`

Already present, keep:

- `POLAR_ACCESS_TOKEN`
- `POLAR_PRODUCT_ID_CREDITS`
- `POLAR_SERVER`
- `POLAR_WEBHOOK_SECRET`
- `POLAR_ORGANIZATION_ID` (optional is okay if the SDK uses an org-scoped token; require it only if direct SDK calls need it).

Also update `.env.example` and Cloudflare secrets. Without `POLAR_METER_ID`/`POLAR_PRODUCT_ID_CREDITS`/`PROXY_HOST_UNIT_COSTS`, code compiles but billing fails at runtime.

### 3.57 Current credits page is user-scoped and wrong route

Current `src/routes/app/settings/credits.tsx` is still `/app/settings/credits`, calls user-scoped `credits.getBalance`, uses `balanceCents`, uses min `$1` UI (`min={1}` and default state `"10"`), shows Auto Top-Up placeholder, and calls `createTopUpCheckout({ amountCents })`. All conflict with org-pool Polar billing.

Required UI rewrite:

- Move/replace route under org context (e.g. `/app/organizations/$organizationSlug/settings/credits`) so billing unit is explicit.
- Loader/query must pass explicit `{ organizationSlug }` / org id, never global user state.
- Replace `balanceCents` with `available`, `creditedUnits`, `consumedUnits` from §3.45/§3.46.
- Enforce min `$20` in UI and server. Default input should be `20`, `min={20}`.
- Remove Auto Top-Up card for v1 (out of scope).
- Replace `listTransactions` with `listTopUps` + `listCharges` or a combined server-side view built from those.
- After checkout return, poll `getBalance` (§3.47).

### 3.58 Current keys page is client-auth/user-scoped and wrong snippet

Current `src/routes/app/settings/keys.tsx` is still `/app/settings/keys`, calls `auth.apiKey.list/create/update/delete` directly from the client, creates user-owned keys, and its snippet uses `Authorization: Bearer YOUR_API_KEY` against `https://zevium.dev/api/v1/scrapperApi/`. All wrong for org-owned proxy keys.

Required rewrite:

- Move/replace route under org context or make explicit cross-org view with org selector.
- Replace client `auth.apiKey.*` calls with server-side tRPC procedures (`orgKey.create/list/update/delete`) so `metadata.creatorUserId`, `organizationId`, `remaining`, `permissions`, and rate limit are server-controlled (§3.21).
- Pass `organizationId`/slug explicitly; do not rely on active organization state.
- Snippet must use `/api/proxy/...`, `x-zevium-key: <key>`, and `x-zevium-host: <target-host>`; keep upstream `Authorization` separate for the real API.
- Remove the "Credit Limit" input unless it maps to `remaining` (request quota) with clear wording. Do not imply dollar spend limit; org pool handles money.
- Add enable/disable toggle using `apiKey:["update"]` permission (hence §3.14 includes `update`).
- Use `useMutation` (`isPending`) instead of manual `useState(isPending)` per project convention.

### 3.59 Proxy response/body semantics need one decision: full-body success vs header success

Current proxy charges/commits when the upstream stream reaches `done` (line 240), and refunds on stream `cancel()` (lines 232-235) or read error. Earlier doc text sometimes says "charge after 2xx headers" and sometimes preserves cancel refund. Pick one precise v1 rule:

**Recommended v1 rule:** charge only after upstream returns 2xx **and** the upstream body stream completes successfully. If the client cancels the body stream or the upstream body read errors, refund both gates. This matches current proxy behavior and avoids charging for incomplete streamed responses. For no-body 2xx (204/HEAD), commit immediately.

If we instead charge at 2xx headers, delete/refactor the current cancel refund logic. Do not leave doc/code split-brained.

### 3.60 Proxy fetch timeout + abort signal

Current proxy does not set timeout or pass an abort signal. Migration should add:

- `AbortController` timeout (e.g. 25s or env-configurable) → upstream timeout returns 504/502 and refunds.
- Client disconnect should abort upstream fetch. In Workers, use `request.signal` if available; otherwise combine timeout signal with request abort signal where supported.
- Keep `duplex: "half"` for streaming request bodies.
- Keep `redirect: "error"` (§3.41).

This prevents hung upstreams from pinning worker resources and holding a reserved org balance indefinitely until the platform kills the request.

### 3.61 Migration numbering: `0014` exists; create `0015` to drop it

Verified `drizzle/0014_empty_plazm.sql`: it **creates** `credit_ledger`. So older wording "migration `0014` replaced by `0015`" is wrong. Do NOT edit/delete an existing migration already in the journal. Create a new migration after it:

- `0015_*`: `DROP TABLE credit_ledger`; add `organization.polar_customer_id`; add `organization.billing_email`; add unique indexes from §3.22/§3.26.
- Update `drizzle/meta/_journal.json` via `pnpm drizzle-kit generate` or a proper Drizzle migration workflow. Do not hand-edit the journal unless unavoidable.
- Since this is a new app/no users, dropping `credit_ledger` is fine. If any local dev DB has rows, they get discarded.

### 3.62 Current Polar webhook is old model and must be rewritten, not tweaked

Current `src/routes/api/polar/webhook.ts` is user-scoped and self-managed-credits scoped:

- imports `CreditsManager` and `CreditsRedisKey`
- only handles `order.paid`; no `order.refunded`, no `customer.state_changed`
- reads `metadata.userId`, not `metadata.orgId`
- increments local Redis credits via `CreditsManager.add`
- uses checkout/order id idempotency keys from `CreditsRedisKey`, not `webhook-id`
- filters by `productId` only, not org/customer identity
- returns 500 for pending idempotency, causing retries; okay for old apply-once semantics, wrong for thin invalidation-only handler

New handler is a **rewrite**: signature verify raw body, dedup by `webhook-id`, event-type filter (§3.44), derive org (`metadata.orgId` or `polarCustomerId` reverse lookup), invalidate `zevium:credited:${orgId}`, return 200. No `CreditsManager.add`; Polar credits itself via meter_credit benefit.

### 3.63 Current credits RPC uses old Polar checkout payload shape

Current `src/server/rpcs/credits/index.ts` calls `polarClient.checkouts.create({ products, prices })`, stores `metadata.userId`, takes `amountCents`, returns `balanceCents`, and lists transactions by `metadata.userId`. This is old user-credit model. New SDK plan uses `productPriceId`, `customerId`, `amount`, `currency`, and `metadata.orgId`. Do not patch old procedures in place blindly; rewrite router to §3.46 surface.

Also note current RPC has `getTopUpFromCheckout` and `getInvoiceUrl`. Decide v1 behavior:

- `getInvoiceUrl(orderId)` can stay only if rewritten org-scoped (`order.customerId === org.polarCustomerId` or `metadata.orgId === orgId`).
- `getTopUpFromCheckout(checkoutId)` likely disappears if the credits page polls `getBalance` after redirect (§3.47). If kept, it must be org-scoped and use order metadata/customerId, not `userId`.

### 3.64 Drizzle Zod exports must remove `CreditLedger*`

Current `src/db/zod.ts` exports `CreditLedgerSelectZod` and `CreditLedgerInsertZod` from `schema.creditLedger`. Once `creditLedger` is removed from `schema.ts`, those exports break typecheck. Remove them or replace with new org-balance schemas if needed. Grep found this, not obvious from schema alone.

### 3.65 Org-owned apikey schema still says `userId` in generated OpenAPI docs — ignore, but don't code against it

Plugin OpenAPI/types still expose legacy-looking `userId` properties in some list/get schemas, but the actual table ownership field is `referenceId` (verified in `types-BR70O3Q3.d.mts`: `referenceId` is "userId or organizationId based on config's references setting"). For org-owned keys, **never** use `userId` from plugin responses. Use `referenceId` for org, `metadata.creatorUserId` for attribution.

### 3.66 Existing `apiKey` default permissions reduce blast radius, but server create still explicit

Current `auth.tsx` already sets `permissions: { defaultPermissions: { api: ["read"] } }`. That means missing `permissions` in `orgKey.create` might still work. But keep §3.27: pass permissions explicitly in the server tRPC mutation. Reason: future config edits won't silently turn every proxy key into a 401 machine.

## 4. Plan

### 4.1 Polar dashboard setup (manual, blocks testing)

1. Meter `proxy_calls`: filter `name = proxy_call`, aggregation `sum` over `cost_units`.
2. One-time product "Credits" (credits-only: NO metered price).
3. Meter_credit benefit on product: `units`, `rollover = true`, `meterId = proxy_calls`.
   (Verify variable-amount crediting — §3.9.)
4. Webhook → `https://zevium.dev/api/polar/webhook`; subscribe to **`order.paid`** + **`order.refunded`** (primary cache-invalidation triggers) + `customer.state_changed` (secondary safety net). Copy secret.
5. Env: `POLAR_METER_ID`, `POLAR_PRODUCT_ID_CREDITS`, `POLAR_ACCESS_TOKEN`,
   `POLAR_ORGANIZATION_ID`, `POLAR_SERVER`, `POLAR_WEBHOOK_SECRET`,
   `PROXY_HOST_UNIT_COSTS`. Drop `CREDITS_FLUSH_SECRET`.

### 4.2 Schema + env (minimal)

- `apikey`: no new columns for billing. Create all proxy keys via a **server-side** tRPC mutation `orgKey.create` (§3.21) — NOT the client `auth.apiKey.create` — with `references` from plugin config, `organizationId` from URL, `metadata.creatorUserId` set server-side from the session, explicit `permissions: { api: ["read"] }`, `remaining`, no refill, and rate-limit defaults. Store `metadata.creatorUserId` for attribution + one-key-per-user check (enforced by **unique partial index**, §3.22). Drop `requestCount` from UI/logic (plugin may keep internal field). No `ownerType` / `ownerUserId` / `organizationId` / `kind` columns. Keep plugin `rateLimit*` columns.
- **No new tables.** `creditAllocation` and `publisherEarning` do not exist in current schema. `creditLedger` exists via `0014_empty_plazm.sql` and must be dropped by a new `0015` migration (§3.61).
- Migration `0015`: `DROP TABLE credit_ledger`; add `organization.polarCustomerId`, `organization.billingEmail`; add unique partial index on `organization.polarCustomerId`; add unique functional partial index `apikey_one_per_org_creator ON apikey(reference_id, json_extract(metadata,'$.creatorUserId')) WHERE reference_id IS NOT NULL` (§3.22/§3.26). Update `schema.ts` and `db/zod.ts` too (§3.55/§3.64).
- `src/env/server.ts`: add `POLAR_METER_ID`, `POLAR_PRODUCT_ID_CREDITS`, `PROXY_HOST_UNIT_COSTS`, `PROXY_PUBLIC_HOST`; drop required `CREDITS_FLUSH_SECRET` (§3.56).

### 4.3 Code changes (minimal)

**`src/lib/server/polar.ts`** — rewrite from bare `polarClient` export to org-scoped direct-SDK helpers:

- `ensureOrgCustomer(org)` — `customers.getExternal({ externalId: org.id })` first (§3.42), else `polar.customers.create({ externalId: org.id, email: org.billingEmail (formula in §3.24), name: org.name, metadata: { orgId } })`; persist `polarCustomerId`. Lazy-call from checkout/getOrgCreditedUnits if `polarCustomerId === null` (§3.23).
- `getOrgCreditedUnits(orgId): Promise<number>` — `polar.customerMeters.getStateExternal({ externalCustomerId: orgId, meterId: POLAR_METER_ID })` → meter `creditedUnits`. Redis-cached (TTL 5min, §3.18); invalidated by `order.paid` + `order.refunded` webhooks (primary) and `customer.state_changed` (secondary). Return 0 on no-active-meter / Polar error (gate → 402, do not throw).
- `createCreditsCheckout({ orgId, amountUsd, successUrl })` — `checkouts.create({ products: [POLAR_PRODUCT_ID_CREDITS], prices: { [productId]: [{ amountType: "custom", presetAmount: amountUsd * 100, priceCurrency: "usd" }] }, customerId, metadata: { orgId }, successUrl })` (§3.20/§3.30/§3.37).
- `ingestProxyCall({ orgId, requestId, host, method, status, costUnits })` — `events.ingest({ events: [{ name: "proxy_call", externalCustomerId: orgId, externalId: requestId, metadata: { cost_units: costUnits, host, method, status } }] })`. Polar auto-deducts.
- `getHostCost(host)` — parse `PROXY_HOST_UNIT_COSTS` JSON → positive integer `costUnits`; exact host only; throw fail-closed 403 on unpriced/zero/invalid.

**`src/lib/server/org-pool-gate.ts`** (new, tiny) — the **only** custom gate code:

- Redis keys use existing `kv` client and `zevium:` namespace (§3.34/§3.54).
- Reserve Lua: nil-safe, negative self-heal, cost > 0, check `creditedUnits - orgConsumed >= costUnits`, increment on success.
- Refund Lua: validates `cur >= cost` before decrementing (§3.50).
- Helpers: `reserve({ orgId, costUnits })`, `refund({ orgId, costUnits })`, `peek({ orgId, creditedUnits })`.

**`src/routes/api/proxy/$.ts`** — rewrite billing block: cheap host checks + self-loop/DNS/private + allowlist + cost lookup before DB/Redis; verify org-owned key; map API-key errors; reserve org pool; fetch with `redirect: "error"`, timeout, `duplex: "half"`; charge only after 2xx + body complete (§3.59); synchronously await `ingestProxyCall` because `waitUntil` is unavailable (§3.40); preserve current stream cancel/read-error refund patterns (§3.51).

**`src/server/rpcs/credits/index.ts`** — rewrite to §3.46 surface: `getBalance`, `createTopUp`, `listTopUps`, `listCharges`, `listPerKeyUsage`; remove user-scoped `balanceCents`, `listTransactions`, `createTopUpCheckout`, `getTopUpFromCheckout` unless rewritten org-scoped (§3.63).

**`src/routes/app/.../credits.tsx`** — org route/context, min $20, no auto-topup, balance from `getBalance`, top-up via `createTopUp`, checkout polling, top-ups/charges views (§3.57).

**`src/routes/app/settings/keys.tsx`** (or org-scoped `/app/organizations/$org/settings/keys`) — replace client `auth.apiKey.*` with server-side org-key tRPC; fix snippet to `x-zevium-key` + `x-zevium-host`; remove misleading dollar credit limit (§3.58). Cross-org view may remain flat if it explicitly groups by org.

**`src/lib/server/auth.tsx`** — remove `polar()` plugin; configure `apiKey` exactly per §3.52; keep `capCaptcha` + `twoFactor` + `organization`; add org creation hook/wrapper to lazy/create Polar customer (§3.23).

**`src/routes/api/polar/webhook.ts`** — rewrite old user-credit handler completely (§3.62): validate raw body, dedup by `webhook-id`, event-type filter, org extraction, cache invalidation. No `CreditsManager.add`.

**Delete:**

- `src/lib/server/credits.ts` (CreditsManager), `credits-success.ts`, `src/lib/server/credits.test.ts`, `src/lib/shared/credits-keys.ts`.
- `src/routes/api/credits/$.ts` (flush) + wrangler cron + `src/worker.ts` scheduled handler.
- `creditLedger` from schema and `CreditLedger*` Zod exports (§3.64).
- `CREDITS_FLUSH_SECRET` env.
- Old webhook idempotency/body code.
- No `creditAllocation` table. No `publisherEarning` table.

**Tests:**

- `getHostCost` (fail-closed on unpriced host, zero/negative cost rejected).
- `orgPoolGate` Lua (reserve OK / insufficient / nil-safe / negative self-heal / refund refuses negative / peek).
- Proxy: 2xx + body-complete → synchronous ingest called + no refund; upstream non-2xx → no ingest + both refunds; stream cancel/read error → both refunds; unpriced host → 403; exhausted key → 429 (USAGE_EXCEEDED); invalid key → 401.
- **Refund idempotency**: concurrent error paths (fetch throw + stream cancel/read error) trigger refundBoth exactly once.
- `ensureOrgCustomer` idempotent (list-first + create fallback).
- One-key-per-user: creating a second org-owned key with the same `metadata.creatorUserId` under the same org fails (DB unique index, not only server count check).
- Rate-limited key: `verifyApiKey` returns/throws `RATE_LIMITED` after burning `remaining`; proxy refunds `remaining` only (org pool not reserved yet).

### 4.4 Proxy gate flow (final, body-complete + synchronous ingest)

```ts
// 1. Cheap checks first — reject bad hosts before any DB / Redis hit
normalize x-zevium-host
if !https or selfHost or dnsPrivate or !allowlisted or !priced:
  return 403

// 2. Plugin gate (atomic guarded decrement on remaining > 0)
// NOTE: auth.api.verifyApiKey returns { valid, error, key } in this plugin version;
// it may also throw for transport/unexpected failures. Handle both.
verification = await verifyApiKey({ body: { key: zeviumKey, permissions: { api: ["read"] } } })
if !verification.valid:
  if verification.error?.code === "RATE_LIMITED":
    // consumeRemaining already ran before consumeRateLimit; key id unavailable from verification
    const hashed = await defaultKeyHasher(zeviumKey)
    const row = await db.select({ id: apikey.id }).from(apikey).where(eq(apikey.key, hashed)).limit(1)
    if (row) refundRemaining(row.id)
    return 429  // with Retry-After when available
  if verification.error?.code === "USAGE_EXCEEDED": return 429  // nothing consumed
  return 401  // KEY_NOT_FOUND / INVALID_API_KEY / disabled / expired / permission fail

const key = verification.key
if !key?.referenceId: return 401
const orgId = key.referenceId  // org-owned key → referenceId = orgId

// 3. Org-pool money gate (atomic Lua)
cost = getHostCost(host)
reserve = orgPoolGate.reserve(orgId, cost)
if !reserve.ok:
  refundRemaining(key.id) // plugin remaining already decremented, org pool not reserved
  return 402

// 4. Fetch + stream (state machine prevents double refund/commit)
state = "reserved"
refundBoth = once(() => {
  orgPoolGate.refund(orgId, cost)
  refundRemaining(key.id)
  state = "refunded"
})
commitAndIngest = once(async () => {
  // synchronous because route handlers cannot access Cloudflare waitUntil (§3.40)
  await ingestProxyCall({ orgId, requestId, host, method, status, costUnits: cost })
  state = "committed"
})

try:
  upstream = await fetch(targetUrl, {
    body,
    duplex: "half",
    headers,
    method,
    redirect: "error",
    signal: timeoutOrRequestAbortSignal,
  })
  if !upstream.ok:
    await refundBoth()
    throw new UpstreamNonOK(upstream)

  if !upstream.body:
    await commitAndIngest()
    return upstream response

  return new Response(
    streamWithCancelHook(
      upstream.body,
      onDone: commitAndIngest,
      onCancelOrReadError: refundBoth,
    ),
    { headers, status: upstream.status, statusText: upstream.statusText },
  )
catch e:
  if !(e instanceof UpstreamNonOK) and state === "reserved": await refundBoth()
  throw e
```

### 4.5 CI / verification

- `pnpm run ci` green; new tests pass.
- Manual (blocked on secrets/dashboard):
  - Org created → Polar customer created (`polarCustomerId` persisted).
  - Org recharges (min $20) → Polar `creditedUnits` increments → webhook invalidates cache.
  - Org member creates an org-owned key with `remaining` default (e.g. 1000), no refill, `permissions: { api: ["read"] }`, and metadata `creatorUserId`.
  - Proxy call: `verifyApiKey` auto-decrements `remaining`; org pool reserves `cost_units`; upstream 2xx + body-complete → synchronous ingest → Polar auto-deducts; non-2xx/cancel/read-error → both refunded.
  - Unpriced host / self-host / private DNS / redirect → 403 or 502 according to failure path.
  - `remaining` exhausted → 429 (USAGE_EXCEEDED).
  - Org pool exhausted → 402 and plugin `remaining` is refunded.

## 5. Known v1 limitations

- **`orgConsumed` is authoritative for gating; Polar is purchase ledger + external mirror.** Local `orgConsumed` and Polar consumed drift if `events.ingest` fails after body-complete (Polar outage/network blip). For v1 we accept drift — the gate never lets the org spend more than `creditedUnits`, and Polar's customer portal may briefly show a higher balance than reality. No durable outbox/reconcile for v1. If drift becomes a problem: durable outbox for ingest + periodic reconcile job (v2).
- **`customer.state_changed` does NOT reconcile usage.** Per docs it fires on customer/subscription/benefit changes, not per ingested event. Use it to invalidate the `creditedUnits` cache after top-ups/refunds, not to reconcile `orgConsumed`.
- **Worker death between reserve and body-complete = local over-reserve (§3.28).** If the worker is killed after reserve but before refund/commit, `orgConsumed` may remain too high. Bounded by in-flight request count; corrected by v2 reconcile. v1 accepts.
- **Client cancels / upstream body read error before body-complete → refund.** This is the chosen v1 rule (§3.59), matching current proxy stream cancel behavior. We do NOT charge at headers-only.
- **Webhook handler must read RAW request body.** `validateEvent` from `@polar-sh/sdk/webhooks` needs the raw bytes (not parsed JSON). In TanStack Start, read via `await request.text()` or `request.arrayBuffer()` BEFORE any framework parsing. Easy to get wrong; the handler will silently fail signature verification if the body is re-serialized.

## 6. Open questions / blockers

## 7. Out of scope (follow-ups)

- Publisher payouts (Stripe Connect) — deferred to a follow-up. For now, no publisher accounting; Zevium keeps the spread externally.
- Per-token dynamic pricing (event metadata already forward-compatible).
- Volume pricing (Polar: "coming soon").
- Polar customer portal deep-link (build our own UI for now).

```

```
