# Polar-native credits migration (hierarchical, org-scoped)

Status: **planned** — implementation pending.
Branch: `feat/polar-credits-combined` (carries merged PR #127 + #147 onto refactored `develop`).
Supersedes the self-managed Redis credits model shipped in #127/#147.

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

- **Per-key request quota** = `@better-auth/api-key` plugin's `remaining` / `refillAmount` / `refillInterval`. `verifyApiKey` runs `consumeRemaining()` — an atomic guarded decrement (`incrementOne({ where: { remaining: { gt: 0 } }, increment: -1 })`) with CAS refill on `lastRefillAt`. Throws `USAGE_EXCEEDED` at 0. **Plugin-native. We write no gate code** — just handle the thrown error.
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

- **All proxy keys are org-owned** — create with `referencesType: "organization"`, so the plugin sets `referenceId = orgId` (verified in plugin source, create flow line 753-764). The proxy reads `referenceId` → bills that org. **No dedicated `organizationId` column needed for billing** (the plugin does NOT declare one in `apiKeySchema`; its `organizationId` create param is for permission scoping only, persisted into `referenceId`). This collapses the user-owned-vs-org-owned billing split — there's only the org pool now (we cut user allocations in §3.1).
- **Track creator via `metadata.creatorUserId`** for attribution + the one-key-per-user constraint. The plugin's `metadata` column accepts arbitrary JSON.
- **Repurpose** `remaining` / `refillAmount` / `refillInterval` as the **per-key request quota** (per-user call cap). Plugin handles atomic decrement + auto-refill natively (§3.1). **Important:** this is request-count, not unit-cost. An expensive host (50 units/call) burns the same quota as a cheap one (1 unit/call).
- **Keep** `rateLimit*` for rate-limiting.
- **Drop** `requestCount` (dead; do not surface as billed usage). No `ownerType` / `ownerUserId` / `organizationId` columns — `referenceId` is the billing org.
- **One personal key per user per org** — server-side check at create: count keys where `referenceId = orgId AND metadata.creatorUserId = userId`. Prevents users stacking keys to bypass the per-user cap. (JSON-path count query is acceptable here — it's at create time, not per-proxy-call.)

### 3.5 Per-host unit cost (consumer rate only — publisher cut)

Publisher/marketplace tracking is **cut** (§3.10). The proxy charges the consumer rate per-host; Zevium's spread vs the upstream's actual cost is handled outside the app.

- `PROXY_HOST_UNIT_COSTS` env: CSV `host:units`, e.g. `api.openai.com:3,api.anthropic.com:1,api.example.com:50`. Units = what the consumer pays per call.
- Unpriced host → **403 fail-closed** (no free rides). No default fallback.
- Units ↔ USD: set by the meter_credit benefit. e.g. product $20 grants 2000 units → 1 unit = $0.01 → `api1` (3 units) = $0.03/call.

### 3.6 Local atomic gate (the only custom gate code)

Per-key quota gate is plugin-native (§3.1). The only custom gate is the **org-pool money gate**:

- One Redis key per org: `orgConsumed` (atomic counter). One Lua: `if creditedUnits − orgConsumed ≥ cost_units then incrby(orgConsumed, cost_units); return ok else insufficient`.
- `creditedUnits` cached (Redis) **with a TTL fallback (e.g. 5 min) + webhook invalidation** (§3.18). A missed webhook self-heals via TTL; webhooks keep it fresh. Polar is source of truth. (Earlier text said webhook-only — corrected: pure webhook invalidation risks permanent staleness on a dropped webhook.)
- No Polar-balance TTL cache for the gate decision. No overspend — the Lua is atomic.
- Event ingest **after** 2xx upstream response via `waitUntil` (non-blocking), `externalId = requestId` for dedup. Polar auto-deducts → org pool decrements at Polar. Local `orgConsumed` already incremented at gate time → stay in sync (reconcile via webhook `customer.state_changed`).

### 3.7 Cross-org keys view

Flat `/app/settings/keys` → cross-org view listing the user's keys across all orgs they belong to (derived query, no new state). Key creation remains org-scoped (org settings). Any org member can create keys (default; tighten later if needed).

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

Verified in plugin source (`claimUsageInDatabase`, lines 1734-1737): `consumeRemaining` runs **before** `consumeRateLimit`. So a call that hits the rate limit has **already** decremented `remaining` before `RATE_LIMITED` throws. The 2xx-only refund model must refund `remaining` when `verifyApiKey` throws `RATE_LIMITED` — not only on upstream non-2xx. The proxy catch block should refund both gates on ANY post-verify failure path (rate-limit, org-pool insufficient, upstream non-2xx, fetch throw).

### 3.18 `creditedUnits` cache needs a TTL fallback

Webhook-only invalidation means a **missed** `order.paid` webhook = permanent stale cache (org can't spend newly purchased credits). Add a TTL safety net (e.g. 5 min) so the cache self-heals even if every webhook is dropped. Webhook invalidation stays for freshness; TTL is the floor.

### 3.19 `orgConsumed` durability

`orgConsumed` (Redis) is authoritative for the gate. If Redis loses it (flush/restart without persistence), the counter resets to 0 → the gate thinks nothing was consumed → the org can spend its full `creditedUnits` again (overspend). Mitigations: (a) confirm Upstash persistence (AOF) is on for the credits Redis instance, (b) periodic reconcile job that recomputes `orgConsumed` from Polar's `consumedUnits` (v2). For v1: require Upstash persistence + document the risk.

### 3.20 Checkout MUST pass `customerId` (critical)

Verified in `CheckoutCreate` (Polar SDK): `customerId` is optional; if omitted + `customerEmail` is passed, Polar find-or-creates a customer by email. Since we use a **unique per-org billing email** (no collision), Polar would create a **new** customer for the checkout (no match). The purchased meter credits would be granted to the **new** customer, not the one we created in `ensureOrgCustomer` (which holds the org's `externalId` + meter state). Result: org's `getStateExternal({ externalId: orgId })` keeps returning 0; credits appear to vanish.

Fix: `createCreditsCheckout` must pass `customerId: org.polarCustomerId` explicitly. This links the checkout to the existing customer (carrying the meter_credit benefit + correct externalId). The `customerEmail` field is then unnecessary on the checkout (leave default).

### 3.21 Key create must be server-side (creatorUserId is client-trusted)

Verified in plugin source (create flow line 746): `metadata` is read from `ctx.body` and stored verbatim. The plugin does **not** validate that `metadata.creatorUserId` matches the session. A client could pass `metadata: { creatorUserId: "other-user-id" }` to bypass the one-key-per-user count check (the count queries by the real session userId, finds 0, allows the create). The limit is a UX guard, not a security boundary — but to be meaningful, `creatorUserId` must be set **server-side from the session**, not accepted from the client body.

Fix: do NOT use the client's `auth.apiKey.create` for org-owned keys. Add a server-side tRPC mutation (e.g. `orgKey.create`) that reads the session, then calls `auth.api.createApiKey` (server-side call, not client plugin) with: `referencesType` from config, `organizationId` from URL, `metadata: { creatorUserId: session.user.id }` **set by the server**, plus `permissions`, `rateLimit`, `prefix`, `name` from validated input. The client UI calls this tRPC mutation, not the auth client plugin. (Server-side calls are NOT subject to the `SERVER_ONLY_PROPERTY` check at line 751, so refill/permissions/remaining are settable from server.)

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

Sequence: request A → reserve Lua increments `orgConsumed` by cost → fetch upstream → upstream returns 2xx → `waitUntil(ingest)` queued → **worker killed before response sent or ingest completes** (Cloudflare worker shutdown, CPU limit). Client retries with a NEW request (new requestId) → reserve Lua increments `orgConsumed` again (no Polar dedup across requests because requestId is new) → second call succeeds, second ingest fires. Net: `orgConsumed` is 2× the actual Polar-side consumed, and Polar has 2 events for what the client intended as 1 call (or 1 event if the first ingest also completed). Bounded by retry count; the next reconcile (§3.19) corrects it. v1 accepts; document. v2: client-supplied `Idempotency-Key` header used as the Polar `externalId` so retries dedupe (requires SDK change).

### 3.29 Proxy auth header = `x-zevium-key` (verified against current impl)

The current proxy (`src/routes/api/proxy/$.ts`) already uses the `x-zevium-key` header for auth (line 60) and **strips it from the outbound** request before forwarding to the upstream (line 125) — no leak/conflict with the upstream's own `Authorization` header. The header design is correct; the migration must preserve it. Specify in the §4.4 flow: read `x-zevium-key` for `verifyApiKey`, strip from outbound headers. (No `Authorization`-header design needed — `x-zevium-key` avoids the dual-bearer conflict.)

### 3.30 Checkout needs `POLAR_PRICE_ID_CREDITS`, not just product ID

`CheckoutCreate` requires `productPriceId` (the specific price on the product), not `productId` (verified in SDK). For a one-time product with a custom (variable-amount) price, the product has one "custom" price; the env must hold that price's ID. Fix the env list: `POLAR_PRODUCT_ID_CREDITS` (for the dashboard reference) **and** `POLAR_PRICE_ID_CREDITS` (passed to checkout). The product ID alone is not enough.

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

For a one-time product with a **custom** (variable-amount) price, `CheckoutCreate` requires `productPriceId` (§3.30) **plus** the `amount` (in smallest currency unit, e.g. cents) **plus** the `currency` (e.g. `"usd"`). Fix the helper:

```ts
polar.checkouts.create({
  productPriceId: POLAR_PRICE_ID_CREDITS,
  customerId: org.polarCustomerId, // §3.20
  amount: amountUsd * 100, // cents
  currency: "usd",
  successUrl, // optional: append {CHECKOUT_ID}
  metadata: { orgId }, // copied to order.metadata.orgId
  customerIpAddress: request.cf?.clientIp, // fraud signal (optional)
});
```

Min $20 enforced server-side BEFORE calling Polar (reject if `amountUsd < 20`).

### 3.38 `prefix` set per-config in `auth.tsx`, not per-key

For consistency, set the api-key plugin's `prefix: "zevium"` in the plugin config in `auth.tsx` (alongside `references: "organization"` from §3.16), NOT per-key in `orgKey.create`. One place to change. All keys get `zevium_abc...` identifiers. The `orgKey.create` server-side call does NOT pass `prefix` (uses the config default).

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
- **`src/env/server.ts`**: drop `CREDITS_FLUSH_SECRET`. Add `POLAR_METER_ID`, `POLAR_PRODUCT_ID_CREDITS`, `POLAR_PRICE_ID_CREDITS`, `POLAR_WEBHOOK_SECRET`, `POLAR_ACCESS_TOKEN`, `POLAR_ORGANIZATION_ID`, `POLAR_SERVER`, `PROXY_PUBLIC_HOST` (for §3.36), `PROXY_HOST_UNIT_COSTS`.

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

- `apikey`: no new columns for billing. Create all proxy keys via a **server-side** tRPC mutation `orgKey.create` (§3.21) — NOT the client `auth.apiKey.create` — with `referencesType` from config, `organizationId` from URL, `metadata.creatorUserId` set server-side from the session. Store `metadata.creatorUserId` for attribution + one-key-per-user check (enforced by **unique partial index**, §3.22). Repurpose `remaining` / `refillAmount` / `refillInterval` as the per-key request quota. Drop `requestCount` (dead). No `ownerType` / `ownerUserId` / `organizationId` / `kind` columns. Keep `rateLimit*`.
- **No new tables.** `creditAllocation` and `publisherEarning` are gone. `creditLedger` already gone.
- Migration `0014` (credit_ledger) → replaced by `0015`: `organization.polarCustomerId`, `organization.billingEmail` + **unique partial index** `apikey_one_per_org_creator ON apikey(reference_id, json_extract(metadata,'$.creatorUserId')) WHERE reference_id IS NOT NULL` (§3.22). (apikey itself: no new columns — we use the plugin's existing `referenceId` + `metadata`.)
- `src/env/server.ts`: add `POLAR_METER_ID`, `PROXY_HOST_UNIT_COSTS`. Drop `CREDITS_FLUSH_SECRET`.

### 4.3 Code changes (minimal)

**`src/lib/server/polar.ts`** — org-scoped direct-SDK helpers (small):

- `ensureOrgCustomer(org)` — `polar.customers.create({ externalId: org.id, email: org.billingEmail (= \`org-${orgId}@billing.zevium.dev\`, §3.24), name: org.name, metadata: { orgId } })`if missing; persist`polarCustomerId`. Idempotent: if `externalId`already exists in Polar (retry), fetch by externalId and reuse — don't create a duplicate. Lazy-call from checkout/getOrgCreditedUnits if`polarCustomerId === null` (§3.23).
- `getOrgCreditedUnits(orgId): Promise<number>` — `polar.customerMeters.getStateExternal({ externalCustomerId: orgId, meterId: POLAR_METER_ID })` → meter `creditedUnits`. Redis-cached (TTL 5min, §3.18); invalidated by `order.paid` + `order.refunded` webhooks (primary) and `customer.state_changed` (secondary). Return 0 on no-active-meter / Polar error (gate → 402, do not throw).
- `createCreditsCheckout({ orgId, amountUsd, successUrl })` — Polar checkout. `metadata: { orgId }`. **Must pass `customerId: org.polarCustomerId`** to link to the existing customer (§3.20) — otherwise the purchased meter credits land on a new customer and never reach the org. If `polarCustomerId` is null, lazy `ensureOrgCustomer` first.
- `ingestProxyCall({ orgId, requestId, host, method, status, costUnits })` — `events.ingest(...)`. Polar auto-deducts.
- `getHostCost(host)` — parse `PROXY_HOST_UNIT_COSTS` → `{ costUnits }` or throw (fail-closed 403).

**`src/lib/server/org-pool-gate.ts`** (new, tiny) — the **only** custom gate code:

- One Lua script: `if creditedUnits − orgConsumed ≥ costUnits then incrby(orgConsumed, costUnits); return ok else insufficient`.
- Helpers: `reserve({ orgId, costUnits })`, `refund({ orgId, costUnits })` (decrement `orgConsumed` back on non-2xx).

**`src/routes/api/proxy/$.ts`** — billing block (minimal):

```
verifyApiKey({ body: { key, permissions: { api: ["read"] } } })
  // plugin atomic-guarded decrements remaining; throws USAGE_EXCEEDED at 0
if USAGE_EXCEEDED: return 429
cost = getHostCost(host)                                            // 403 if unpriced
reserve = orgPoolGate.reserve({ orgId: key.referenceId, cost })   // 402 if insufficient  // referenceId = orgId (org-owned key)
fetch upstream
if !upstream.ok:
  orgPoolGate.refund({...})                                         // refund money gate
  db.update(apikey).set({ remaining: sql`remaining + 1` }).where(eq(apikey.id, key.id))   // drizzle atomic refund
  throw new UpstreamNonOK(upstream)
stream response
on 2xx complete:
  waitUntil(ingestProxyCall({ orgId, requestId, host, method, status, costUnits: cost }))
  // no refund — both gates consumed stand
```

**`src/server/rpcs/credits/index.ts`** — org-scoped (small):

- `getBalance` → `{ orgPool: creditedUnits − orgConsumed }`.
- `createTopUp` → `createCreditsCheckout({ amountUsd ≥ 20 })`.
- `listTransactions` → `polar.orders.list({ customerId: org.polarCustomerId })`.

**`src/routes/app/.../credits.tsx`** — org pool + buy-credits input (min $20) + Polar order history.

**`src/routes/app/settings/keys.tsx`** (or org-scoped `/app/organizations/$org/settings/keys`) — org-scoped key create with `refillAmount`/`refillInterval`. Cross-org view at flat `/app/settings/keys`.

**`src/lib/server/auth.tsx`** — keep `apiKey` + `capCaptcha` + `twoFactor` + `organization` plugins. **Configure `apiKey({ references: "organization", ... })`** (§3.16, BLOCKER) so all keys are org-owned. No `polar()` plugin. Hook org creation → `ensureOrgCustomer`.

**Delete:**

- `src/lib/server/credits.ts` (CreditsManager), `credits-success.ts`, `CreditsRedisKey` (ledger/balance keys).
- `src/routes/api/credits/$.ts` (flush) + wrangler cron + `src/worker.ts` scheduled handler.
- `creditLedger` from schema (migration `0014` replaced by `0015`).
- `CREDITS_FLUSH_SECRET` env.
- Custom webhook body — replace with thin `validateEvent` handler that invalidates `creditedUnits` cache on `customer.state_changed`.
- No `creditAllocation` table. No `publisherEarning` table.

**Tests:**

- `getHostCost` (fail-closed on unpriced host).
- `orgPoolGate` Lua (reserve OK / insufficient / refund).
- Proxy: 2xx → ingest called + no refund; non-2xx → no ingest + both refunds; unpriced host → 403; exhausted key → 429 (USAGE_EXCEEDED); invalid key → 401.
- **Refund idempotency**: concurrent error paths (fetch throw + stream cancel) trigger refundBoth exactly once.
- Streaming cancel after 2xx headers → still charges (no refund).
- `ensureOrgCustomer` idempotent.
- One-key-per-user: creating a second org-owned key with the same `metadata.creatorUserId` under the same org fails (server-side count check).
- Rate-limited call: `verifyApiKey` throws `RATE_LIMITED` after burning `remaining`; proxy refunds `remaining` (§3.17).

### 4.4 Proxy gate flow (final, minimal)

```
// 1. Cheap checks first — reject bad hosts before any DB / Redis hit
normalize x-zevium-host
if !https or isPrivate or !PROXY_ALLOWED_HOSTS.includes or !PROXY_HOST_UNIT_COSTS[host]:
  return 403

// 2. Plugin gate (atomic guarded decrement on remaining > 0)
try:
  verification = await verifyApiKey({ key, permissions: { api: ["read"] } })
catch e:
  // verifyApiKey already decremented remaining (consumeRemaining runs before consumeRateLimit)
  if e.code === "RATE_LIMITED":
    // verification is undefined (threw before assignment); resolve key id from the raw key
    const row = await db.select({id}).from(apikey).where(eq(apikey.key, hashKey(zeviumKey))).limit(1)
    if (row) refundRemaining(row.id)  // §3.17 — rate-limited call burned a unit
    return 429  // with Retry-After
  if e.code === "USAGE_EXCEEDED": return 429  // remaining was 0, nothing consumed
  return 401  // KEY_NOT_FOUND / INVALID_API_KEY / disabled / expired
const orgId = verification.key.referenceId  // org-owned key → referenceId = orgId

// 3. Org-pool money gate (atomic Lua)
cost = getHostCost(host)
reserve = orgPoolGate.reserve(orgId, cost)
if !reserve.ok: return 402

// 4. Fetch + stream (with idempotent refund guard)
let refunded = false
const refundBoth = () => {
  if (refunded) return
  refunded = true
  orgPoolGate.refund(orgId, cost)
  db.update(apikey).set({ remaining: sql`remaining + 1` }).where(eq(apikey.id, verification.key.id))  // drizzle atomic refund
}
try:
  upstream = await fetch(targetUrl, { body, duplex: "half", headers, method })
  if !upstream.ok:
    refundBoth()
    throw new UpstreamNonOK(upstream)
  return new Response(streamWithCancelHook(upstream, refundBoth), { ... })
catch e:
  if !(e instanceof UpstreamNonOK): refundBoth()
  throw e

// 5. Post-2xx ingest (best-effort; non-blocking)
waitUntil(ingestProxyCall({ orgId, requestId, host, method, status, costUnits: cost }))
```

### 4.5 CI / verification

- `pnpm run ci` green; new tests pass.
- Manual (blocked on secrets/dashboard):
  - Org created → Polar customer created (`polarCustomerId` persisted).
  - Org recharges (min $20) → Polar `creditedUnits` increments → webhook invalidates cache.
  - Org member creates a key with `refillAmount`/`refillInterval` (e.g. 100/month).
  - User key call: `verifyApiKey` auto-decrements `remaining`; org pool reserves `cost_units` → 2xx → ingest → Polar auto-deducts; non-2xx → both refunded.
  - Unpriced host → 403.
  - `remaining` exhausted → 429 (USAGE_EXCEEDED).
  - Org pool exhausted → 402.

## 5. Known v1 limitations

- **`orgConsumed` is authoritative for gating; Polar is purchase ledger + external mirror.** Local `orgConsumed` and Polar's consumed drift if `events.ingest` fails post-2xx (network blip, outage). For v1 we accept drift — the gate never lets the org spend more than `creditedUnits`, and Polar's customer portal may briefly show a higher balance than reality. No reconcile/queue for v1. If drift becomes a problem: durable outbox for ingest + periodic reconcile job (v2).
- **`customer.state_changed` does NOT reconcile usage.** Per docs it fires on customer/subscription/benefit changes, not per ingested event. Use it to invalidate the `creditedUnits` cache after top-ups/refunds, not to reconcile `orgConsumed`.
- **Worker death between reserve and response = local double-charge (§3.28).** Cloudflare worker can be killed after the reserve Lua increments `orgConsumed` but before the response is sent or the `events.ingest` completes. Client retry uses a new requestId → second reserve + second ingest → `orgConsumed` is 2× actual Polar consumed. Bounded by retry count; corrected by the reconcile job (§3.19). v1 accepts.
- **Streaming cancel after 2xx headers → still charges.** Upstream returned success headers; client cancels the body stream. Polar event is ingested (2xx was sent). v1 documents as gray area; refund path does NOT cover client-side stream cancel.
- **Webhook handler must read RAW request body.** `validateEvent` from `@polar-sh/sdk/webhooks` needs the raw bytes (not parsed JSON). In TanStack Start, read via `await request.text()` or `request.arrayBuffer()` BEFORE any framework parsing. Easy to get wrong; the handler will silently fail signature verification if the body is re-serialized.

## 6. Open questions / blockers

## 7. Out of scope (follow-ups)

- Publisher payouts (Stripe Connect) — deferred to a follow-up. For now, no publisher accounting; Zevium keeps the spread externally.
- Per-token dynamic pricing (event metadata already forward-compatible).
- Volume pricing (Polar: "coming soon").
- Polar customer portal deep-link (build our own UI for now).

```

```
