# Tiger-Style Deep Review — `convex/schema.ts`

## Verdict

**Incorrect — and more dangerous than the prior review reported.** The schema is internally shaped well (typed FKs, a signed append-only ledger, a correctly-dimensioned vector index, idempotency `refId`s on every money-moving write), but it is built on a foundation Convex does not actually provide: **enforced uniqueness**. Every "one per X" contract in this schema — one wallet per org, one payment per checkout session, one ledger entry per `refId`, one `paymentEvents` row per Stripe event, one `publisherEarnings` row per settlement, one webhook endpoint per project, one user/org per Clerk id, one spec version per `(project, version)` — is defended by a read-then-insert TOCTOU pattern that races under concurrency. On the Stripe-webhook and Wallet-DO ingest paths, that race multiplies money. The prior review's 15 findings are all verified; this deep-dive confirms them and adds the systemic uniqueness gap (P1), the webhook-endpoint duplicate-bricking path (P2), two more dead/redundant indexes, the write-only `settleRefId` on `usageEvents`, the missing `payments.checkoutIntentId` index, and several data-modeling smells.

Convex has no native unique index. That is not a code bug — it is a schema-design constraint that this schema has not been defended against.

## File Stats

- File: `convex/schema.ts` (345 lines)
- Tables: 20 (`organizations`, `users`, `projects`, `specs`, `specVersions`, `wallets`, `walletEntries`, `usageEvents`, `notifications`, `webhookEndpoints`, `webhookDeliveries`, `keySettings`, `specEmbeddings`, `organizationPayments`, `checkoutIntents`, `paymentEvents`, `payments`, `publisherEarnings`, `publisherTransfers`, `connectedPayouts`)
- B-tree indexes: 38 · Vector indexes: 1 (`specEmbeddings.by_embedding`, 768 dims — **correct** for `gemini-embedding-001` with `outputDimensionality: 768`)
- Query surface cross-referenced: `wallets.ts`, `usage.ts`, `specs.ts`, `projects.ts`, `earnings.ts`, `notifications.ts`, `keySettings.ts`, `webhooks.ts`, `accounting.ts`, `payouts.ts`, `billing.ts`, `analytics.ts`, `admin.ts`, `catalogue.ts`, `cronTasks.ts`, `dev.ts`, `organizations.ts`, `users.ts`, `lib/notifications.ts`, `lib/auth.ts`, `http.ts` — plus all `*.test.ts` consumers
- Prior review: `reviews/convex.schema.ts.md` — 6 P2 + 9 P3, all verified below

---

## Findings

### [SEV: P1] Convex has no unique indexes — every "one per X" read-then-insert idempotency guard is a TOCTOU race, and on the money path it multiplies credits
**Location:** `convex/schema.ts` (every `.index(...)` is non-unique by Convex design) + the 18 read-then-insert sites:
- `users.upsertFromClerk` / `users.ensureUser` — `by_clerk_user` (`users.ts:14-18, 60-63`)
- `organizations.upsertFromClerk` / `ensureOrganization` — `by_clerk_org` (`organizations.ts:64-70, 92-98, 137-143`)
- `wallets.ensureWallet` / `getOrCreateWallet` — `by_organization` (`organizations.ts:16-21`, `wallets.ts:34-44`)
- `organizationPayments.*` — `by_organization` (`billing.ts:258-262`, `payouts.ts:154-158`)
- `specs.upsertDraft` — `by_project` (`specs.ts:62-67`)
- `specVersions.publishVersion` — `by_project_version` (`specs.ts:119-123`)
- `keySettings.upsertKeySetting` — `by_key` (`keySettings.ts:104-106 → 123`)
- `webhookEndpoints.upsertEndpoint` — `by_project` (`webhooks.ts:110-116`)
- `checkoutIntents.*` — `by_checkout_session` (`billing.ts:465-468, 716-719, 947-950`)
- `paymentEvents.recordPaymentEvent` — `by_stripe_event` (`billing.ts:400-404, 435-439`)
- `payments.fulfillCheckout` — `by_payment_intent` / `by_charge` (`billing.ts:480-484, 550-554, 608-612`)
- `walletEntries.appendWalletEntry` — `by_ref` (`wallets.ts:97-100`)
- `publisherEarnings.recordUsage` — `by_settlement` (`wallets.ts:437-441`)
- `publisherTransfers.createTransfer` — `by_idempotency_key` (`payouts.ts:376-380`)
- `connectedPayouts.recordPayout` — `by_stripe_payout` (`payouts.ts:552-556`)
- `notifications.createNotification` — `by_ref` (`lib/notifications.ts:37-39`)

**Problem:** Convex indexes are not unique and Convex provides no native unique constraint. Every one of these sites implements "insert if absent" as: read with `.withIndex(...).unique()` → if `null`, insert. Two concurrent mutations both snapshot the table before either writes, both see `null`, both insert a new document, and **both commit** — Convex's OCC only conflicts on write-write to the *same* document, and two brand-new documents don't share one. The `.unique()` query helper is a *reader* convenience (returns first match or throws if >1); it enforces nothing at the writer.

The Wallet DO serializes per-wallet ingest, which *partially* defends `walletEntries.by_ref` and `publisherEarnings.by_settlement` for the same consumer wallet — but only if every settlement for that wallet flows through the same DO with no overlap. The Stripe-webhook path has no such serialization: Stripe delivers with at-least-once semantics and redelivers on timeout. Trace for `checkout.session.completed` under concurrent delivery:
1. Both `recordPaymentEvent` calls read `paymentEvents.by_stripe_event` → `null` → both insert a `paymentEvents` row (duplicate event rows).
2. Both `processPaymentEvent` calls read `payments.by_checkout_session` → `null` → both insert a `payments` row (duplicate payments, **different `_id`s**).
3. Both `grantPaymentCredits` calls use `refId: \`payment:${paymentId}\`` — and because the two `paymentId`s differ, the `walletEntries.by_ref` dedupe **does not fire** → both append a `payment_grant` entry → **double credit grant**.

The same shape double-counts on `payment_intent.succeeded` redelivery, dispute creation (`payments.by_charge`), `publisherTransfers` (`by_idempotency_key` — the idempotency key is the *whole point* and it races), and `connectedPayouts`.

**Impact:** Money integrity. A retried/concurrent Stripe webhook can grant the same credit pack twice, reverse twice, or create two `publisherEarnings` rows for one settlement. The `walletEntries` ledger — the system's supposed source of truth — silently carries duplicate grants with distinct `refId`s, so even a full ledger audit would not flag it. The idempotency infrastructure (`refId`, `idempotencyKey`, `stripeEventId`) is theater without storage-level uniqueness.

**Fix:** Convex cannot enforce unique indexes, so enforce uniqueness via a **guard document per natural key**: a tiny table whose `_id` *is* the natural key (e.g., `paymentEventLocks` keyed by `stripeEventId` via `ctx.db.insert` with a deterministic id, or a `uniqueness` table where the natural key is encoded in `_id`). The first mutation to `patch` the guard wins; the second hits an OCC conflict and retries/rejects. Apply this pattern at minimum to: `paymentEvents.stripeEventId`, `payments.stripeCheckoutSessionId` / `stripePaymentIntentId` / `stripeChargeId`, `publisherTransfers.idempotencyKey`, `connectedPayouts.stripePayoutId`, `walletEntries.refId`, `publisherEarnings.usageSettlementRefId`, `organizations.clerkOrgId`, `users.clerkUserId`. Until then, every idempotency claim in this codebase is a race condition.

---

### [SEV: P2] `webhookEndpoints.by_project` is non-unique; a concurrent `upsertEndpoint` bricks webhook delivery for the project permanently
**Location:** `convex/schema.ts:135-143` and `convex/webhooks.ts:110-130, 155-158, 173-176`
```ts
webhookEndpoints: defineTable({
  projectId: v.id("projects"),
  url: v.string(),
  secret: v.string(),
  active: v.boolean(),
  createdAt: v.number(),
}).index("by_project", ["projectId"]);   // ← non-unique, but "one per project"
```
```ts
// webhooks.ts upsertEndpoint
const existing = await ctx.db
  .query("webhookEndpoints")
  .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
  .unique();                              // ← throws if >1 exists
if (existing === null) {
  const id = await ctx.db.insert("webhookEndpoints", { ... });
  ...
}
```
**Problem:** The schema comment says "one per project" and every reader (`getEndpoint`, `fireWebhookEvent`, `deleteEndpoint`, `regenerateSecret`, `listDeliveries`) calls `.withIndex("by_project").unique()`. The write path is read-then-insert with no uniqueness guard (this is the P1 race in miniature). Two concurrent `upsertEndpoint` calls for the same `projectId` (e.g., a user double-clicking "Save", or a retry) both read `null` and both insert → two endpoint rows. From that moment on, **every** `.unique()` lookup on `by_project` for that project **throws** ("Indexed query returned more than one result") — `fireWebhookEvent` throws, `getEndpoint` throws, `listDeliveries` throws, `regenerateSecret` throws. Webhook delivery for that project is bricked with no recovery path short of a manual DB delete. `deleteEndpoint` is also bricked (it uses `.unique()` too), so the user cannot self-recover via the API.

**Impact:** Permanent webhook-delivery outage for the affected project, including the security-relevant `fireWebhookEvent` path called from `specs.publish` / `specs.deprecateVersion` / `admin.setProjectVisibility`. Triggered by a benign UI double-submit.

**Fix:** Same guard-document pattern as the P1, OR — simpler here — make `projectId` the `_id` of the row (`defineTable` allows custom `_id` via `ctx.db.insert` with an explicit id, or use a `webhookEndpointLocks` table keyed by `projectId`). At minimum, change `upsertEndpoint` to handle the >1 case by deleting extras before patching, and change the readers to `.first()` + in-app enforcement rather than `.unique()`.

---

### [SEV: P2] `specVersions.spec` immutability is unenforced — schema offers zero protection for a stated product rule *(prior P2 — verified, expanded)*
**Location:** `convex/schema.ts:43-57`
```ts
specVersions: defineTable({
  projectId: v.id("projects"),
  version: v.string(),
  spec: v.string(),            // ← plain mutable string; pricing-bearing
  publishedAt: v.number(),
  deprecatedAt: v.optional(v.number()),
  sunsetAt: v.optional(v.number()),
  deprecationMessage: v.optional(v.string()),
})
  .index("by_project", ["projectId"])
  .index("by_project_version", ["projectId", "version"])
  .index("by_project_published", ["projectId", "publishedAt"]),
```
**Problem:** Verified. The product rule is "Published spec versions immutable" and the spec body is the "source of truth for pricing." Nothing in the schema defends this: `spec` is a plain `v.string()` and Convex has no field-level immutability. Any `ctx.db.patch(id, { spec: "..." })` in any current or future mutation silently rewrites a published, pricing-bearing spec body. The only defense is code-review discipline in `specs.ts` (where `deprecateVersion` patches only metadata and `undeprecateVersion` uses `replace`). The `walletEntries` ledger references `usageEvents` → `projectId`, **not** a spec-version snapshot, so a mutated spec body is undetectable downstream — the gateway and consumers cache pricing that the control plane has silently rewritten. Compounding the P1 race: two concurrent `publishVersion` calls for the same `(projectId, version)` both pass the `by_project_version` null check and both insert, producing two "immutable" versions of the same semver — the `by_project_version.unique()` reader then throws for every subsequent lookup.

**Impact:** Highest-consequence contract in the control plane, defended by convention only. A single future `patch({ spec })` rewrites pricing history with no audit trail.

**Fix:** Split the immutable body into a separate append-only `specVersionBodies` table (one row per version, never patched in any mutation) so `specVersions` carries only metadata. Add a test asserting no mutation outside `specs.ts` touches `specVersions.spec` / `specVersionBodies`. And close the duplicate-publish race with the guard-document pattern from the P1.

---

### [SEV: P2] `publisherEarnings.by_status_available` is dead; the crons it should serve scan instead *(prior P2 — verified)*
**Location:** `convex/schema.ts:302` and `convex/payouts.ts:300-310, 358-372`
```ts
.index("by_status_available", ["status", "availableAt"]),
```
**Problem:** Verified via grep across all of `convex/` — zero `.withIndex("by_status_available", ...)` references. `releaseMatureEarnings` (payouts.ts:300) and `preparePublisherTransfer` (payouts.ts:358) both query `publisherEarnings` via `by_publisher` then `.filter((q) => q.eq(q.field("status"), "pending_risk" | "available"))`. For a high-volume publisher the cron scans every earning row they have ever produced and filters in-process.

**Impact:** Write amplification on every `publisherEarnings` insert; the release/transfer crons degrade linearly with publisher earnings history.

**Fix:** Either drop `by_status_available`, or — better — rewrite `releaseMatureEarnings` to sweep globally via `.withIndex("by_status_available", q => q.eq("status", "pending_risk").lte("availableAt", now))` (the index is intentionally not org-scoped, which is correct for a global cron).

---

### [SEV: P2] Missing `by_transfer` (and `by_publisher_status`) index on `publisherEarnings` — transfer-completion webhook scans the publisher's entire history *(prior P2 — verified, expanded)*
**Location:** `convex/schema.ts:278-303` (missing index) and `convex/payouts.ts:442-460, 470-490, 518-530`
```ts
const earnings = await ctx.db
  .query("publisherEarnings")
  .withIndex("by_publisher", (q) =>
    q.eq("publisherOrganizationId", transfer.publisherOrganizationId),
  )
  .filter((q) => q.eq(q.field("transferId"), transfer._id))
  .collect();
```
**Problem:** Verified. Three separate transfer-completion paths (`markPublisherTransferSucceeded`, `markPublisherTransferFailed`, and the reversal path) all scan the publisher's entire earnings history to find rows where `transferId === transfer._id`. `transferId` is an `Id<"publisherTransfers">` — a perfect index key — and this query runs on the Stripe-transfer webhook hot path. Additionally, `preparePublisherTransfer` (payouts.ts:359) filters by `status === "available"` after a `by_publisher` scan — there is no `by_publisher_status` composite to serve "this publisher's earnings in status X," which is the exact query the transfer-prep cron runs.

**Impact:** O(total publisher earnings) scan per Stripe-transfer webhook event, three times. Scales linearly with publisher success.

**Fix:** Add `.index("by_transfer", ["transferId"])` and `.index("by_publisher_status", ["publisherOrganizationId", "status", "availableAt"])`. Rewrite the three transfer-completion lookups to `withIndex("by_transfer", q => q.eq("transferId", transfer._id))` and the transfer-prep cron to `by_publisher_status`.

---

### [SEV: P2] `usageEvents.by_project_at` is dead; `analytics.ts` comment claims "no time index" and undercounts as a result *(prior P2 — verified)*
**Location:** `convex/schema.ts:110` and `convex/analytics.ts:6-9, 146-150, 255-259`
```ts
.index("by_project_at", ["projectId", "at"])
```
```ts
// analytics.ts:6-9
/**
 * Scan caps — usageEvents only has by_org / by_project (no time index).
 * Queries order by _creationTime desc, filter on `at`, and stop at these caps.
 * High-volume orgs will undercount past the cap; a by_org_at index is the fix.
 */
```
**Problem:** Verified. `by_org_at` and `by_project_at` both exist; `analytics.ts` is written as if neither does, queries the single-field `by_org`/`by_project`, orders by `_creationTime`, filters on `at` in-process, and caps the scan (`ORG_SCAN_CAP`, `PROJECT_SCAN_CAP`). The comment explicitly says "a by_org_at index is the fix" — that index already exists and is unused. `by_project_at` has zero query references anywhere in `convex/`.

**Impact:** Analytics silently undercounts any org/project whose recent-event volume exceeds the cap, even though the exact fix is sitting in the schema. Dead `by_project_at` adds write amplification to every `usageEvents` insert for no benefit.

**Fix:** Rewrite the two analytics scans to `.withIndex("by_org_at", q => q.eq("organizationId", org._id).gte("at", cycleStart).lt("at", cycleEnd))` and `by_project_at` analogously; remove the caps and the stale comment. Drop `by_project_at` only if analytics genuinely won't adopt it.

---

### [SEV: P2] `notifications` and `keySettings` are org-scoped via `clerkOrgId: v.string()` instead of `organizationId: v.id("organizations")` *(prior P2 — verified)*
**Location:** `convex/schema.ts:113-126` (`notifications`), `convex/schema.ts:155-169` (`keySettings`)
```ts
notifications: defineTable({
  clerkOrgId: v.string(),     // ← string, not v.id("organizations")
  ...
}).index("by_org", ["clerkOrgId", "createdAt"])

keySettings: defineTable({
  clerkOrgId: v.string(),     // ← string, not v.id("organizations")
  ...
}).index("by_org", ["clerkOrgId"])
```
**Problem:** Verified. Every other org-scoped table keys off `organizationId: v.id("organizations")` — a typed FK. These two store the raw Clerk org id string. No FK relationship to `organizations`, no join by `_id`, and the org-scoping index is on a denormalized string kept in sync with `organizations.clerkOrgId` only by convention. `notifications.ts` and `keySettings.ts` call `requireOrgMemberBySlug` then use `org.clerkOrgId` rather than `org._id` — a separate code path from every other org-scoped module.

**Impact:** Schema inconsistency, no FK integrity, migration hazard for any future cross-table org-scoped join. Combined with the P1 race on `organizations.by_clerk_org`, a Clerk org-id rotation would orphan every `notifications` and `keySettings` row with no cascade path.

**Fix:** Add `organizationId: v.id("organizations")` to both tables, backfill from the resolved org, migrate the `by_org` indexes to `["organizationId", ...]`. Keep `clerkOrgId` as a denormalized lookup field only if a hot path needs it.

---

### [SEV: P2] `publisherEarnings.projectId` is optional but the write path always sets it; `earnings.forOrg` silently drops unprojected rows *(prior P2 — verified)*
**Location:** `convex/schema.ts:282` and `convex/wallets.ts:442-456`, `convex/earnings.ts:41-86`
```ts
publisherEarnings: defineTable({
  publisherOrganizationId: v.id("organizations"),
  /** Immutable published project that earned this settlement. */
  projectId: v.optional(v.id("projects")),   // ← optional, but recordUsage always sets it
  ...
```
**Problem:** Verified. `recordUsage` (wallets.ts:446) inserts `projectId: project._id` unconditionally after the null check, so the optionality is unused on the write path. On the read path, `earnings.forOrg` builds a `Map<Id<"projects">, ...>` keyed by `earning.projectId`; any earning with `projectId === undefined` groups under key `undefined`, the subsequent `ctx.db.get(undefined)` returns `null`, so that earning's gross/net is counted in `allTime` but silently absent from `byProject`.

**Impact:** Latent: a future code path / migration / manual fix that creates an earning without `projectId` produces a publisher statement whose per-project breakdown under-reports while all-time totals stay correct — an inconsistency that is hard to detect.

**Fix:** Make `projectId: v.id("projects")` required (matches the actual write contract), or handle `undefined` explicitly in `forOrg` with an "unattributed" bucket.

---

### [SEV: P2] `payments.checkoutIntentId` is a required FK with no index — and the duplicate-insert race on `by_checkout_session` makes two payments for one intent undetectable *(new)*
**Location:** `convex/schema.ts:252-272` and `convex/billing.ts:500-521`
```ts
payments: defineTable({
  organizationId: v.id("organizations"),
  checkoutIntentId: v.id("checkoutIntents"),   // ← required FK, no index
  stripeCheckoutSessionId: v.string(),
  stripePaymentIntentId: v.optional(v.string()),
  stripeChargeId: v.optional(v.string()),
  ...
})
  .index("by_organization", ["organizationId", "createdAt"])
  .index("by_checkout_session", ["stripeCheckoutSessionId"])
  .index("by_payment_intent", ["stripePaymentIntentId"])
  .index("by_charge", ["stripeChargeId"]),
```
**Problem:** `fulfillCheckout` (billing.ts:500-521) inserts a `payments` row with `checkoutIntentId: intent._id` as a required FK, but there is no index on `checkoutIntentId`. There is therefore no schema-supported way to answer "which payment(s) did this checkout intent produce?" — a query the dispute/refund paths and any reconciliation job will want. Worse, the only dedupe guarding "one payment per intent" is the read-then-insert on `by_checkout_session` (which races — see P1). If two `payments` rows are created for one intent (concurrent `checkout.session.completed` + `payment_intent.succeeded`, or a Stripe redelivery), there is no index that surfaces the duplicate, and the two rows have different `_id`s so the downstream `walletEntries.by_ref` dedupe (`payment:${paymentId}`) does not catch them either.

**Impact:** No bidirectional traceability from intent → payment; the duplicate-payment detection gap is silent.

**Fix:** Add `.index("by_checkout_intent", ["checkoutIntentId"])` and use it as a *second* idempotency check in `fulfillCheckout` (read by intent; if a payment already exists for this intent, return it instead of creating a new one). This does not close the race by itself — close it with the P1 guard-document pattern on `stripeCheckoutSessionId`.

---

### [SEV: P2] `cronTasks.checkLowBalances` does an unbounded `wallets` table scan with no cap or pagination *(new)*
**Location:** `convex/cronTasks.ts:25` and `convex/schema.ts:60-64`
```ts
const wallets = await ctx.db.query("wallets").collect();
let notified = 0;
for (const wallet of wallets) {
  if (wallet.balance >= LOW_BALANCE_THRESHOLD) continue;
  ...
}
```
**Problem:** The hourly low-balance cron scans the entire `wallets` table via `.collect()` with no cap. The comment acknowledges "wallets table is O(orgs)" and frames this as acceptable, but: (1) there is no `by_balance` / `by_low_balance` index, so the scan reads every wallet document on every tick; (2) for each low-balance wallet it then calls `ctx.db.get(wallet.organizationId)` + `createNotification` (which itself reads `notifications.by_ref`) — an N+1 inside the scan; (3) the `wallets` table has no `updatedAt`, so the cron cannot cheaply skip wallets whose balance hasn't changed since the last tick. As the org count grows this becomes a multi-hundred-ms serial mutation blocking the cron queue.

**Impact:** Linear-with-orgs hourly scan with an N+1; at scale, cron latency grows and the notification dedupe path is exercised on every tick even for wallets that haven't changed.

**Fix:** Either accept the scan but cap it (`.take(N)` + cursor continuation across ticks), or add a `by_low_balance` boolean/derived index — simpler: add `updatedAt` to `wallets` and a `by_updated_at` index, then scan only wallets touched since the last cron tick.

---

### [SEV: P3] `specEmbeddings` comment references the dead `text-embedding-004` model *(prior P3 — verified)*
**Location:** `convex/schema.ts:171`
```ts
// Catalogue semantic search (embedded on publish; Gemini text-embedding-004)
```
**Problem:** Verified. `text-embedding-004` is dead — the v1beta endpoint returns HTTP 404. The actual model is `gemini-embedding-001` with `outputDimensionality: 768`. The `dimensions: 768` on the vectorIndex (line 182) is correct for `gemini-embedding-001`, but the comment misleads any maintainer regenerating or debugging embeddings.

**Fix:** Update the comment to `gemini-embedding-001 (768 dims via outputDimensionality)`.

---

### [SEV: P3] `paymentEvents.by_object` index is dead *(prior P3 — verified)*
**Location:** `convex/schema.ts:249`
```ts
.index("by_object", ["objectId"]),
```
**Problem:** Verified — zero `.withIndex("by_object", ...)` references in `convex/`. Maintained on every `paymentEvents` insert (Stripe-webhook hot path) for no reader.

**Fix:** Drop the index, or wire up the intended "find all events for this Stripe object id" lookup (e.g., to detect duplicate delivery for the same object across event types).

---

### [SEV: P3] `specVersions.by_project` is a redundant prefix of `by_project_published` *(prior P3 — verified)*
**Location:** `convex/schema.ts:55-57`
```ts
.index("by_project", ["projectId"])
.index("by_project_version", ["projectId", "version"])
.index("by_project_published", ["projectId", "publishedAt"]),
```
**Problem:** Verified. `by_project_published` has `projectId` as its prefix, so Convex serves any `eq("projectId", ...)` query from it — including the `.collect()` cascades in `dev.ts:65`, `projects.ts:215`, and `dev.ts:287`. `by_project` adds a second maintained index for the same access path.

**Fix:** Drop `by_project`; migrate the three call sites to `by_project_published`.

---

### [SEV: P3] `usageEvents.by_org` and `by_project` are redundant prefixes of `by_org_at` / `by_project_at` *(prior P3 — verified)*
**Location:** `convex/schema.ts:107-110`
```ts
.index("by_org", ["organizationId"])
.index("by_project", ["projectId"])
.index("by_org_at", ["organizationId", "at"])
.index("by_project_at", ["projectId", "at"])
```
**Problem:** Verified. `by_org_at` and `by_project_at` make `by_org` and `by_project` strictly redundant (Convex serves `eq(org)` from the composite). `analytics.ts:148` and `analytics.ts:257` use the single-field variants — and as noted in the P2 above, they *should* be using the time-composites with a range. So these two single-field indexes are both redundant *and* the enablers of a suboptimal query pattern.

**Fix:** Drop `by_org` and `by_project`; migrate `analytics.ts` to the time-composite indexes with proper `at` ranges.

---

### [SEV: P3] Money/credit fields typed as `v.number()` (float64) — no schema-level integer guard on the ledger *(prior P3 — verified, expanded)*
**Location:** `convex/schema.ts:60, 67, 86, 96, 99, 274-289, 305-313, 318-326, 333-340`
```ts
wallets:           balance: v.number(),    sequence: v.number(),
walletEntries:     amount: v.number(),
payments:          amount: v.number(),    grantedCredits: v.number(),  reversedCredits: v.number(),
checkoutIntents:   amount: v.number(),    credits: v.number(),
publisherEarnings: grossCredits: v.number(), platformFeeCredits: v.number(), netCredits: v.number(),
publisherTransfers: amount: v.number(),
connectedPayouts:  amount: v.number(),
usageEvents:       credits: v.number(),
```
**Problem:** Verified. Credits are integer units (`accounting.ts`: `$1 = 10_000 credits`, "credits must be a non-negative safe integer") and all arithmetic is integer-floored. The schema accepts any float64 at the validator level. Application-layer guards (`Number.isSafeInteger` in `grantPaymentCredits`, `reversePaymentCredits`, `applyAdminAdjustment`, `recordUsage`, `publisherEarningSplit`) defend the write paths today, but the schema does not. A future mutation that bypasses those helpers can persist `1.5` credits into `wallets.balance` and the ledger carries fractional credit forever. Also note: `sequence` is typed `v.number()` but is a monotonic integer — same float64 gap, and `sequence` is the ledger's checkpoint-reconciliation key, so any precision loss at large values is a correctness bug.

**Impact:** Defense-in-depth gap. Convex has no native int64 validator distinct from float64, so the schema cannot fully close this — but the absence of any integer-domain validation at the storage boundary is a foundation-level weakness for a system whose entire integrity rests on integer credit math.

**Fix:** Add a centralized `assertIntegerCredits(...)` helper invoked at every insert/patch that touches a credit field; document the invariant on each field. For `sequence`, consider capping at `Number.MAX_SAFE_INTEGER` and asserting.

---

### [SEV: P3] `walletEntries` has no `by_wallet_sequence` composite — `walletView` orders by `_creationTime`, not logical `sequence` *(prior P3 — verified)*
**Location:** `convex/schema.ts:80-83` and `convex/wallets.ts:281-287`
```ts
walletEntries: defineTable({ walletId, kind, amount, refId, sequence, ... })
  .index("by_wallet", ["walletId"])
  .index("by_ref", ["refId"]),
```
```ts
const entries = await ctx.db
  .query("walletEntries")
  .withIndex("by_wallet", (q) => q.eq("walletId", wallet._id))
  .order("desc")          // orders by _creationTime
  .take(50);
```
**Problem:** Verified. The ledger has an explicit monotonic `sequence` field, but the "recent 50 entries" view orders by `_creationTime`. Today `sequence` and `_creationTime` are correlated (both set in the same `appendWalletEntry` txn), but they are not the same: a backdated or retried entry could have a `_creationTime` that does not match its `sequence` ordering. The schema provides no index to order by `sequence`.

**Fix:** Add `.index("by_wallet_sequence", ["walletId", "sequence"])` and order the view by `sequence` desc.

---

### [SEV: P3] `notifications.by_ref` idempotency index is global, not org-scoped *(prior P3 — verified, expanded)*
**Location:** `convex/schema.ts:127` and `convex/lib/notifications.ts:36-39`
```ts
.index("by_ref", ["refId"])
```
**Problem:** Verified. `createNotification` dedupes by `.withIndex("by_ref", q => q.eq("refId", args.refId)).unique()` — a *global* lookup, not org-scoped. Today every `refId` embeds a globally-unique id (`spec_published:${versionId}`, `version_deprecated:${versionId}`, `low_balance:${clerkOrgId}:${dayKey}`), so cross-org collision is impossible by construction. But the schema offers no protection: a future `refId` pattern that reuses a non-globally-unique token across orgs would silently suppress the second org's notification. Compounded by the P1 race: two concurrent `createNotification` calls with the same `refId` both read `null`, both insert, then every subsequent `.unique()` lookup throws — breaking the notification bell for that refId.

**Fix:** Either document the "refId must be globally unique" contract on the field, or make the index `["clerkOrgId", "refId"]` and scope the dedupe lookup (and apply the P1 guard-document pattern).

---

### [SEV: P3] Inconsistent org-scoping index naming across tables *(prior P3 — verified)*
**Location:** `convex/schema.ts` (multiple)
**Problem:** Verified. The same conceptual "scoped to one org" index has four different names:
- `by_clerk_org` — `organizations`
- `by_organization` — `wallets`, `organizationPayments`
- `by_org` — `projects`, `usageEvents`, `notifications`, `keySettings`
- `by_publisher` — `publisherEarnings`, `publisherTransfers`

Navigation and grep friction; a maintainer looking for "the org index" must know four names. Contributes to the stale-comment / wrong-index drift seen in the `analytics.ts` P2.

**Fix:** Standardize on one name (e.g., `by_organization`) across all org-scoped tables.

---

### [SEV: P3] `keySettings.by_key` is a global index on `keyId`, relying entirely on Clerk keyId global uniqueness *(prior P3 — verified)*
**Location:** `convex/schema.ts:169` and `convex/keySettings.ts:103-106`
```ts
.index("by_key", ["keyId"])
```
```ts
const existing = await ctx.db
  .query("keySettings")
  .withIndex("by_key", (q) => q.eq("keyId", keyId))
  .unique();   // throws if two rows share keyId
```
**Problem:** Verified. `getOwnedRow` looks up by `keyId` globally with `.unique()`. Correct only if Clerk keyIds are globally unique across orgs — which they are. But the index is not org-scoped, so a reused keyId (Clerk data export/import, test-seeding mistake) makes `.unique()` throw and the upsert errors rather than dedupes across orgs. Also races per P1: two concurrent `upsertKeySetting` for the same key both read `null`, both insert, then every subsequent `.unique()` throws — bricking key-settings for that key the same way the P2 webhook-endpoint finding bricks webhooks.

**Fix:** Make the lookup org-scoped: `.index("by_org_key", ["clerkOrgId", "keyId"])` (or `["organizationId", "keyId"]` after the P2 org-id migration) and query with both fields. Apply the P1 guard pattern.

---

### [SEV: P3] `usageEvents.settleRefId` is write-only metadata on the Convex side — no index, no reader *(new)*
**Location:** `convex/schema.ts:97-106`
```ts
usageEvents: defineTable({
  organizationId: v.id("organizations"),
  ...
  settleRefId: v.optional(v.string()),
})
  .index("by_org", ["organizationId"])
  .index("by_project", ["projectId"])
  .index("by_org_at", ["organizationId", "at"])
  .index("by_project_at", ["projectId", "at"])
  .index("by_at", ["at"]),
```
**Problem:** Grep across `convex/` finds zero reads of `usageEvents.settleRefId` — no `.withIndex` lookup, no `.filter` on the field. The Wallet DO's dedupe runs against `walletEntries.by_ref` (`wallets.ts:380`), not `usageEvents.settleRefId`. The schema comment says "every new Wallet DO ingest validates and persists it," implying it is a forensics/reconciliation key — but the Convex side never reads it back, so there is no path to reconcile a `usageEvents` row to its settlement other than scanning by org/time. If `settleRefId` is the intended audit key for usage events (which the naming strongly implies), it is unreadable without a full scan.

**Impact:** Low. The field is not dead (it is persisted and could be queried by external forensics), but the schema provides no efficient access path, so any future "find the usage event for this settlement" query is a table scan.

**Fix:** Either add `.index("by_settle_ref", ["settleRefId"])` and document it as the audit lookup key, or drop the field if it truly has no Convex-side reader (and rely on `walletEntries.usageEventId` for the join, which *is* indexed implicitly via `_id`).

---

### [SEV: P3] `connectedPayouts` has no `createdAt` — only `updatedAt`, and the `by_connected_account` index keys on `updatedAt` *(new)*
**Location:** `convex/schema.ts:323-341`
```ts
connectedPayouts: defineTable({
  stripeConnectedAccountId: v.string(),
  stripePayoutId: v.string(),
  amount: v.number(),
  currency: v.string(),
  arrivalDate: v.optional(v.number()),
  status: v.union(...),
  failureCode: v.optional(v.string()),
  updatedAt: v.number(),          // ← no createdAt
})
  .index("by_connected_account", ["stripeConnectedAccountId", "updatedAt"])
  .index("by_stripe_payout", ["stripePayoutId"]),
```
**Problem:** `connectedPayouts` records Stripe payout lifecycle events but has only `updatedAt`. `recordPayout` (payouts.ts:567-571) inserts-or-patches in place, so the original creation timestamp is lost on every status transition. The `by_connected_account` index orders by `updatedAt`, which means "list this account's payouts newest-first by last update" — a payout that failed and was later patched will jump to the top of the list even though it arrived long ago. `arrivalDate` is the Stripe-side arrival time but is optional and not the index key.

**Impact:** Payout history ordering is "last mutated" not "arrived"; the creation timestamp is irrecoverable after the first patch. Reconciliation against Stripe's own `created` field is impossible.

**Fix:** Add `createdAt: v.number()` set once on insert; change the index to `["stripeConnectedAccountId", "createdAt"]` (or `arrivalDate` if populated) for stable arrival-ordered history.

---

### [SEV: P3] `organizationPayments.requirements` is `v.array(v.string())` — flattens Stripe's structured requirements object *(new)*
**Location:** `convex/schema.ts:226`
```ts
requirements: v.array(v.string()),
```
**Problem:** `payouts.ts:208-213` builds this array by flattening Stripe's `account.requirements.entries` to a string per entry, dropping the `current_deadline`, `disabled_reason`, and `minimum_deadline.status` structure that the entry filter itself reads. The schema encodes the lossy flattening: a future "show me what's due by when" UI has no structured data to render and must re-fetch from Stripe.

**Impact:** Data-modeling loss; the stored form cannot answer the questions the filter logic implies the product cares about.

**Fix:** Store the structured Stripe requirements array (e.g., `v.array(v.object({ field, current_deadline, status, ... }))`) or store the raw JSON `v.string()` if schema stability is a concern. At minimum, document why the flattening is intentional.

---

### [SEV: P3] `checkoutIntents.status` transitions are not timestamped; `expiresAt` has no index for an expiry sweep *(new)*
**Location:** `convex/schema.ts:213-243`
```ts
checkoutIntents: defineTable({
  ...
  status: v.union(v.literal("created"), v.literal("open"), ...),
  createdAt: v.number(),
  updatedAt: v.number(),
  expiresAt: v.number(),
})
  .index("by_organization", ["organizationId", "createdAt"])
  .index("by_checkout_session", ["stripeCheckoutSessionId"])
  .index("by_payment_intent", ["stripePaymentIntentId"]),
```
**Problem:** `checkoutIntents` has an `expiresAt` field and a `status` lifecycle, but there is no index that serves "find all intents in status `created`/`open` whose `expiresAt` < now" — the natural cron sweep to expire stale checkouts. There is also no per-status timestamp (e.g., `completedAt`, `failedAt`), so the lifecycle is only reconstructible from `updatedAt`, which any field touch bumps. If a checkout-expiry cron is ever added it will need a `by_status_expires` index; without one it scans the whole table.

**Impact:** No efficient expiry sweep; checkout-intent lifecycle audit requires full scan + `updatedAt` inference.

**Fix:** Add `.index("by_status_expires", ["status", "expiresAt"])` if/when an expiry cron lands, and add per-status timestamps (`completedAt`, `expiredAt`) on transition for auditability.

---

## Summary

**Counts:** 0 P0 · 1 P1 · 9 P2 · 10 P3 — 20 findings total. (Prior review: 0 P0 · 0 P1 · 6 P2 · 9 P3 = 15. This review verifies all 15 prior findings and adds 5 new: 1 P1, 3 P2, 4 P3... net of re-sorting, +5 findings, with the prior 9 P3 → 10 P3 reflecting one prior P3 split.)

**Top 3:**
1. **P1 — Convex has no unique indexes; every read-then-insert idempotency guard races.** On the Stripe-webhook path this multiplies credit grants and publisher earnings because the downstream `walletEntries.by_ref` / `publisherEarnings.by_settlement` dedupe keys derive from the duplicated row's `_id`, so the idempotency infrastructure is theater. This is the schema's foundational defect and it was not called out in the prior review.
2. **P2 — `webhookEndpoints.by_project` non-unique + `.unique()` readers bricks a project's webhook delivery permanently** on a concurrent upsert, with no self-service recovery (the `deleteEndpoint` reader also throws). New finding.
3. **P2 — `specVersions.spec` immutability + duplicate-publish race.** The control plane's most load-bearing invariant (published, pricing-bearing spec bodies are immutable) is defended by nothing in the schema, and the `by_project_version` dedupe races, allowing two "immutable" versions of the same semver.

**Recurring theme:** The schema defines indexes ahead of the code that should consume them (`by_status_available`, `by_project_at`, `by_org_at`) and then the code is written as if they didn't exist — so the schema carries dead weight *and* the queries still scan. The deeper recurring theme is **convention-as-constraint**: uniqueness, immutability, integer-domain money, org-scoping via FK, and "one per X" cardinality are all enforced by code-review discipline, none by the schema, and Convex's lack of native unique indexes means the convention cannot be upgraded to a constraint without the guard-document pattern. The schema is a clear expression of intent that the storage engine cannot backstop.
