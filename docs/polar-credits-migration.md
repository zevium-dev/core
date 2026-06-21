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
- **Publisher org** (the org that published the API) earns a share per call.
- **Zevium** keeps the spread (markup).

Confirmed billing model:

1. **Billing unit = organization.** Consumer org recharges a credit pool; allocates
   sub-budgets to its members (users) and to API keys.
2. **Consumer pays.** The org owning the API key is billed.
3. **Polar meter/credits** is the sole prepaid-credit mechanism. `@better-auth/api-key`'s
   `remaining`/`refill*`/`requestCount` are **not** the billing mechanism.
4. **Variable cost: per-host unit rate** (`api1` = 3 units/call, `api2` = 1, `api3` = 50).
   Per-token dynamic pricing later.
5. **Charge only on upstream 2xx.** Non-2xx → no charge, no event.
6. **Markup**: consumer pays rate R; publisher earns R − M; Zevium keeps M. Consumers
   never see the cut — they pay the published rate. (See §5 for publisher payout.)
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

### 2.6 `@better-auth/api-key` supports metadata + organizationId

Plugin `create`/`list` accept `organizationId` + `metadata`; `verifyApiKey` returns
`key.metadata`. Our `apikey` table has a `metadata` JSON column already but no
`organizationId` column. Since this is a new app with no users (confirmed), we redesign
the key ownership model freely (§3.4).

### 2.7 The gap (current merged code)

| Concern          | Current (#127/#147)             | Target                                          |
| ---------------- | ------------------------------- | ----------------------------------------------- |
| Billing unit     | per-user (wrong)                | **org pool + per-user allocation**              |
| Balance          | Redis BITFIELD per user         | Polar meter credits (org) + local allocations   |
| Cost             | flat 1 cent/call                | **per-host unit rate, 2xx-only**                |
| Spend            | `CreditsManager.deduct` (Redis) | `polar.events.ingest` (auto-deduct)             |
| Top-up           | webhook→`CreditsManager.add`    | Polar meter_credit benefit (auto on purchase)   |
| Customer         | none (Polar as checkout only)   | Polar customer per org                          |
| Markup/publisher | none                            | **track publisher earnings (v1), payout later** |
| Key ownership    | `apikey.userId` only            | **org-owned or user-owned**                     |
| Overspend gate   | n/a                             | **local atomic counter** (no TTL cache)         |

## 3. Decisions

### 3.1 Two-tier credit hierarchy

- **Org pool** = Polar meter credit balance (the wallet). Recharged via Polar checkout.
  Source of truth for _purchased_ credits = Polar `creditedUnits`.
- **User allocation** = a local sub-budget the org grants a member
  (`creditAllocation` table: `orgId`, `userId`, `allocatedUnits`). The org can grant,
  increase, or revoke. **Local-only** — not in Polar.
- **API key ownership** determines which pool a call draws from:
  - **User-owned key** → draws from that user's allocation (local gate).
  - **Org-owned key** → draws from the org pool directly (local mirror gate).
- Both ultimately consume the org's Polar credits: a user-key call ingests an event to
  Polar (decrementing the org pool) AND decrements the user's local allocation.

### 3.2 Polar-native, org-scoped, direct SDK

Polar customer per org (`external_id = orgId`). Remove the better-auth `polar()` plugin.
Use `@polar-sh/sdk` directly. Delete `CreditsManager` / `credit_ledger` / custom webhook
body / flush cron.

### 3.3 Meter: `sum` over `cost_units`, event `proxy_call`

- Meter `proxy_calls`: filter `name = proxy_call`, aggregation `sum` over `cost_units`.
- Event: `{ name: "proxy_call", externalCustomerId: orgId, externalId: requestId,
metadata: { cost_units, host, method, status, publisherOrgId? } }`.
- Polar auto-deducts `cost_units` from the org's meter credit balance on ingest.
- Forward-compatible with per-token: add a `tokens` metadata field + a second meter later.

### 3.4 API key ownership redesign (no backward compat — new app, no users)

`apikey` table: replace flat `userId` ownership with:

- `ownerType: "org" | "user"` (not null)
- `ownerUserId: text` (nullable; set when `ownerType = "user"`)
- `orgId: text` (not null, FK→organization) — the org the key belongs to (always set;
  user-owned keys still belong to an org).
- Drop `remaining`/`refillAmount`/`refillInterval`/`requestCount` (dead for billing).
  Keep `rateLimit*` for rate-limiting.
- Migration: new table or alter. Since no data, a clean migration.
  Key creation UI moves org-scoped; the flat `/app/settings/keys` becomes a cross-org view
  gated by permission (§3.7).

### 3.5 Per-host unit cost + markup config

- `PROXY_HOST_UNIT_COSTS` env: CSV `host:consumerUnits:publisherUnits`, e.g.
  `api.openai.com:3:2,api.anthropic.com:1:0.7,api.example.com:50:40`.
  - `consumerUnits` (R) = what the consumer is charged.
  - `publisherUnits` (R−M) = what the publisher earns. Omit `:publisherUnits` for hosts
    with no in-system publisher (Zevium keeps 100%).
- Unpriced host → **403 fail-closed** (no free rides). No default fallback.
- Units ↔ USD: set by the meter_credit benefit. e.g. product $20 grants 2000 units ⇒
  1 unit = $0.01 ⇒ `api1` (3 units) = $0.03/call consumer, $0.02 publisher earn.

### 3.6 Local atomic gate (no overspend, no TTL cache)

- **User-owned key**: atomic Lua decrement on the user's local allocation counter;
  `if allocationRemaining < costUnits → 402`. Atomic ⇒ no overspend.
- **Org-owned key**: atomic check on `orgPoolRemaining = polarCredited − orgConsumed`.
  `polarCredited` = cached `creditedUnits` (invalidated on `customer.state_changed`
  webhook / purchase). `orgConsumed` = local atomic counter. Atomic ⇒ no overspend.
- No Polar-balance TTL cache, no stale-read overspend. (This is why we "won't need to
  touch" overspend — not because Polar blocks it, but because the local gate is atomic.)
- Ingest the event to Polar **after** a 2xx upstream response via `waitUntil`
  (non-blocking), `externalId = requestId` for dedup. Polar then auto-deducts; local
  counter already decremented at gate time ⇒ they stay in sync (reconcile periodically).

### 3.7 Cross-org keys view + permissions

Flat `/app/settings/keys` → cross-org view listing the user's keys across all orgs they
belong to, gated by org membership/permissions. Key creation stays org-scoped (in org
settings). (Open: which permission grants org-owned key creation? Default: org
`owner`/`admin`.)

### 3.8 Charge rule: 2xx only

Upstream non-2xx → no event ingested, no local decrement, no charge. (Gate decrements
happen post-success, so a failed call never decrements.) Refunds (Polar order refund) →
Polar reverses the meter credit natively; local counters reconcile via the
`customer.state_changed` webhook or a scheduled reconciliation.

### 3.9 Credit purchase: variable amount ≥ $20

- Goal: consumer pays any amount ≥ $20, gets proportional units.
- Meter_credit benefit grants **fixed** units per purchase, so variable-amount needs
  either (a) Polar support for proportional/quantity-driven crediting on one-time
  checkout, or (b) fixed tiers ($20/$50/$100/…) as fallback.
- **Open: verify in sandbox** whether a one-time product can grant units proportional to
  the paid amount. If yes → single product, min $20, custom amount. If no → fixed tiers
  for v1, variable later. (Default plan: assume proportional is possible; fall back to
  tiers if the dashboard/SDK doesn't allow it.)

### 3.10 Publisher earnings (v1: track only, no payout)

- On each successful consumer call to a host that has a publisher, record a
  `publisherEarning` ledger row: `publisherOrgId`, `consumerOrgId`, `host`, `units`
  (publisherUnits), `costUsd?`, `callId`, `createdAt`.
- **No payout in v1.** Payout to publishers via Stripe Connect (the standard marketplace
  mechanism — platform charges buyer, takes fee, pays connected account) is a follow-up.
- v1 keeps the ledger so earnings are queryable; settlement is manual until Stripe
  Connect lands.

### 3.11 Polar customer created on org creation

- Hook org creation → `polar.customers.create({ externalId: org.id, email:
org.billingEmail, name: org.name, metadata: { orgId } })`; store returned id as
  `organization.polarCustomerId`.
- `organization` table: add `polarCustomerId: text`, `billingEmail: text`.
- Backfill script `scripts/backfill-polar-customers.ts` for any pre-existing orgs (none
  expected — new app).

### 3.12 Webhook: thin `validateEvent` handler

Handle `customer.state_changed` → invalidate `polarCredited` cache for that org. Optional
logging of `order.paid`/`order.refunded`. **No `CreditsManager.add`** — Polar credits
the meter itself via the meter_credit benefit on purchase.

### 3.13 `@polar-sh/sdk` pinned 0.41.5 through this migration.

## 4. Plan

### 4.1 Polar dashboard setup (manual, blocks testing)

1. Meter `proxy_calls`: filter `name = proxy_call`, aggregation `sum` over `cost_units`.
2. One-time product "Credits" (credits-only: NO metered price).
3. Meter_credit benefit on product: `units`, `rollover = true`, `meterId = proxy_calls`.
   (Verify variable-amount crediting — §3.9.)
4. Webhook → `https://zevium.dev/api/polar/webhook`; subscribe to
   `customer.state_changed` (+ `order.paid`/`order.refunded` logging). Copy secret.
5. Env: `POLAR_METER_ID`, `POLAR_PRODUCT_ID_CREDITS`, `POLAR_ACCESS_TOKEN`,
   `POLAR_ORGANIZATION_ID`, `POLAR_SERVER`, `POLAR_WEBHOOK_SECRET`,
   `PROXY_HOST_UNIT_COSTS`. Drop `CREDITS_FLUSH_SECRET`.

### 4.2 Schema + env

- `organization`: add `polarCustomerId`, `billingEmail`.
- `apikey`: `ownerType`, `ownerUserId`, `orgId`; drop `remaining`/`refill*`/`requestCount`.
- New tables: `creditAllocation` (orgId, userId, allocatedUnits), `publisherEarning`
  (publisherOrgId, consumerOrgId, host, units, callId, createdAt).
- Drop `creditLedger` from schema; migration `0014` (credit_ledger) → replaced by `0015`
  (org cols + apikey redesign + new tables).
- `src/env/server.ts`: add `POLAR_METER_ID`, `PROXY_HOST_UNIT_COSTS`; drop
  `CREDITS_FLUSH_SECRET`.

### 4.3 Code changes

**`src/lib/server/polar.ts`** — org-scoped direct-SDK helpers:

- `ensureOrgCustomer(org)` — create Polar customer if missing, persist `polarCustomerId`.
- `getOrgCreditedUnits(orgId): Promise<number>` — `getStateExternal({ externalId })` →
  meter `creditedUnits`. Cached; invalidated by webhook.
- `createCreditsCheckout({ orgId, amountUsd, successUrl })` — Polar checkout (variable
  amount if supported, else tier product). `metadata: { orgId }`.
- `ingestProxyCall({ orgId, requestId, host, method, status, costUnits })` —
  `events.ingest(...)`.
- `getHostCost(host)` — parse `PROXY_HOST_UNIT_COSTS` → `{ consumerUnits, publisherUnits }`
  or throw (fail-closed).

**`src/lib/server/credits-gate.ts`** (new) — local atomic gate:

- `reserveUserCall({ orgId, userId, costUnits })` — Lua: decrement user allocation if ≥
  cost; return ok/insufficient.
- `reserveOrgCall({ orgId, costUnits })` — Lua: check `credited − consumed ≥ cost`,
  increment `orgConsumed`; return ok/insufficient.
- `commitOnSuccess(...)` / `rollbackOnFailure(...)` — for user keys, the reservation IS
  the spend (no refund on failure since we only charge 2xx). For org keys, decrement
  `orgConsumed` only on success (reserve-then-commit) OR decrement at gate and refund on
  non-2xx. (Decision: decrement at gate, refund on non-2xx — simpler, atomic.)

**`src/routes/api/proxy/$.ts`** — full rewrite of the billing block:

```
verifyApiKey → key (ownerType, ownerUserId, orgId)
cost = getHostCost(host)               // fail-closed 403 if unpriced
reserve = ownerType=user ? reserveUserCall : reserveOrgCall
if !reserve.ok: return 402 "Insufficient credits"
fetch upstream
if !upstream.ok: rollback reservation; throw UpstreamNonOK   // no charge
stream response
on 2xx complete:
  waitUntil(ingestProxyCall({ orgId, requestId, host, method, status, costUnits: cost.consumerUnits }))
  if cost.publisherUnits: waitUntil(recordPublisherEarning({...}))
```

**`src/server/rpcs/credits/index.ts`** — org-scoped:

- `getBalance` → `{ orgPool: credited−consumed, userAllocation: alloc−consumed }`.
- `createTopUp` → `createCreditsCheckout({ amountUsd ≥ 20 })`.
- `listTransactions` → Polar orders + local allocation history.
- `grantAllocation` / `revokeAllocation` (org admin) → mutate `creditAllocation`.

**`src/routes/app/.../credits.tsx`** — show org pool + the current user's allocation;
buy credits (min $20 input); transaction list.

**API keys** — org-scoped creation (ownerType picker), cross-org list view (§3.7).

**`src/lib/server/auth.tsx`** — remove `polar()` plugin. Keep `apiKey`+`capCaptcha`+
`twoFactor`+`organization`. Org creation → `ensureOrgCustomer`.

**Delete:** `src/lib/server/credits.ts`, `credits-success.ts`, custom webhook body,
`src/routes/api/credits/$.ts` flush + wrangler cron + `src/worker.ts` scheduled handler,
`credit_ledger`, `CREDITS_FLUSH_SECRET`, `CreditsRedisKey` ledger/balance keys (keep a
cache key for `creditedUnits`).

**Tests** — `getHostCost` (fail-closed), gate (user vs org, insufficient → 402, 2xx
ingest, non-2xx no-charge + refund), `ensureOrgCustomer` (idempotent), allocation
grant/revoke.

### 4.4 Proxy gate flow (final)

```
verifyApiKey → key{ownerType,ownerUserId,orgId}
cost = getHostCost(host)                          // 403 if unpriced
reserve (user-allocation OR org-pool, atomic)     // 402 if insufficient
fetch upstream
if !upstream.ok: rollback reservation; throw UpstreamNonOK
stream response
on 2xx complete:
  waitUntil(ingestProxyCall({…, costUnits: cost.consumerUnits}))   // Polar auto-deducts org pool
  if cost.publisherUnits: waitUntil(recordPublisherEarning({…}))
```

### 4.5 CI / verification

- `pnpm run ci` green; new tests pass.
- Manual (blocked on secrets/dashboard): org recharge (min $20) → pool increments →
  user allocation grant → user-key call → allocation decrements + org pool event
  ingested → org-key call → org pool decrements → 2xx only (non-2xx no charge) →
  unpriced host 403 → publisher earning recorded → 402 at 0.

## 5. Open questions / blockers

1. **Variable-amount crediting** (§3.9): does Polar support proportional meter credits
   on a one-time checkout (min $20, any amount)? Verify in sandbox; fallback = fixed
   tiers.
2. **Publisher model confirmation** (§3.10): is the "publisher" the org that published
   the API project? Does the proxy know which publisher org owns a host? (Currently
   proxy is host-based, not project-based — need host→publisherOrg mapping, or route
   calls via project.) **Biggest open question.**
3. **Markup config granularity** (§3.5): per-host `consumerUnits:publisherUnits` in env,
   or a DB table for runtime edits? Default: env for v1.
4. **Host→publisher mapping** (§5.2): if publishers are orgs, how does the proxy resolve
   `x-zevium-host` → publisherOrgId? Via the project the call belongs to? Needs the
   proxy to be project-aware (currently it's host-only). **May require proxy routing
   change.**
5. **Cross-org keys permission** (§3.7): which org role can create org-owned keys?
   Default: owner/admin.
6. **Reservation refund semantics** (§4.3): decrement-at-gate + refund-on-non-2xx vs
   reserve-then-commit. Default: decrement-at-gate + refund-on-non-2xx.
7. **Polar customer email uniqueness** (§2.4): `billingEmail` per org, default creator
   email. Confirm Polar accepts it / no collision. Default: yes.
8. **Overspend**: solved by local atomic gate (§3.6). Confirmed not a concern.
9. **Refund reversal** (§3.8): verify in sandbox that refunding a one-time order
   reverses the meter credit.
10. **Secrets** (blocks testing): `POLAR_METER_ID`, `POLAR_PRODUCT_ID_CREDITS`,
    `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_ORGANIZATION_ID`,
    `POLAR_SERVER`, `PROXY_HOST_UNIT_COSTS`, `UPSTASH_REDIS_REST_URL/TOKEN`. Drop
    `CREDITS_FLUSH_SECRET`.

## 6. Out of scope (follow-ups)

- Publisher payouts via Stripe Connect (v1 tracks earnings only).
- Per-token dynamic pricing (event metadata already forward-compatible).
- Volume pricing (Polar: "coming soon").
- Polar customer portal deep-link (build our own UI for now).
