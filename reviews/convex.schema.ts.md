# Tiger-Style Review — `convex/schema.ts`

## Verdict

**Incorrect.** The schema is internally coherent and the ledger/wallet design is sound, but it carries multiple dead/redundant indexes, at least one missing index for a real hot query pattern, two org-scoped tables keyed by the wrong identifier, an optional field the write path never leaves optional, and — most consequentially — **zero schema-level enforcement of the "published spec versions are immutable" invariant**, which is a stated product rule. Nothing here is corrupting data today, but the foundation is leaking: the schema cannot defend the contracts the rest of the codebase assumes it defends.

## File Stats

- File: `convex/schema.ts`
- Lines: 344
- Tables: 18 (`organizations`, `users`, `projects`, `specs`, `specVersions`, `wallets`, `walletEntries`, `usageEvents`, `notifications`, `webhookEndpoints`, `webhookDeliveries`, `keySettings`, `specEmbeddings`, `organizationPayments`, `checkoutIntents`, `paymentEvents`, `payments`, `publisherEarnings`, `publisherTransfers`, `connectedPayouts`)
- B-tree indexes: 38
- Vector indexes: 1 (`specEmbeddings.by_embedding`, 768 dims — correct for `gemini-embedding-001`)
- Cross-referenced query patterns in: `wallets.ts`, `usage.ts`, `specs.ts`, `projects.ts`, `earnings.ts`, `notifications.ts`, `keySettings.ts`, `webhooks.ts`, `accounting.ts`, `payouts.ts`, `billing.ts`, `analytics.ts`, `admin.ts`, `catalogue.ts`, `cronTasks.ts`, `dev.ts`, `organizations.ts`, `lib/notifications.ts`, `lib/auth.ts`

---

## Findings

### [SEV: P2] `specVersions.spec` immutability is unenforced — schema offers zero protection for a stated product rule
**Location:** `convex/schema.ts:43-57`
```ts
specVersions: defineTable({
  projectId: v.id("projects"),
  version: v.string(),
  spec: v.string(),            // ← plain mutable string
  publishedAt: v.number(),
  deprecatedAt: v.optional(v.number()),
  sunsetAt: v.optional(v.number()),
  deprecationMessage: v.optional(v.string()),
})
```
**Problem:** The product rule is "Published spec versions immutable" and the spec is "source of truth for pricing." The schema enforces none of it: `spec` is a plain `v.string()` and Convex imposes no field-level immutability. Any `ctx.db.patch(id, { spec: "..." })` in any current or future mutation silently rewrites a published, pricing-bearing spec body. The only thing preventing this is code-review discipline in `specs.ts` (where `deprecateVersion` carefully patches only metadata and `undeprecateVersion` uses `replace`). There is no schema guardrail — no append-only design, no separate immutable body table, no comment-level contract on the field itself.

**Impact:** A single future mutation that patches `spec` on a published version silently rewrites pricing-bearing data that consumers and the gateway have cached. The ledger (`walletEntries`) references `usageEventId` → `usageEvents` → `projectId`, not a spec version snapshot, so a mutated spec body is not detectable downstream. This is the highest-consequence contract in the control plane and the schema defends it with nothing.

**Fix:** At minimum, document the invariant on the field and add a guard function. Better: split the immutable body into a separate append-only `specVersionBodies` table (one row per version, never patched) so `specVersions` carries only metadata. Short of that, add a lint/test asserting no mutation outside `specs.ts` touches `specVersions.spec`.

---

### [SEV: P2] `publisherEarnings.by_status_available` index is dead — the cron queries it should serve scan instead
**Location:** `convex/schema.ts:302` and `convex/payouts.ts:300-310, 358-372`
```ts
.index("by_status_available", ["status", "availableAt"]),
```
**Problem:** `releaseMatureEarnings` (payouts.ts:300) and `preparePublisherTransfer` (payouts.ts:358) both query `publisherEarnings` via `by_publisher` then `.filter((q) => q.eq(q.field("status"), "pending_risk" | "available"))`. The `by_status_available` index — which exists precisely to serve `eq(status, ...).lte/gte(availableAt, ...)` — is never referenced anywhere in `convex/` (confirmed via grep). For a high-volume publisher the cron scans every earning row they have ever produced and filters in-process.

**Impact:** Two costs. (1) Write amplification: every `publisherEarnings` insert/maintains an index no query reads. (2) The release/transfer crons degrade linearly with publisher earnings history; a mature publisher with 100k+ settlement rows scans all of them on every cron tick instead of the few in the target status.

**Fix:** Either drop `by_status_available`, or — better — rewrite `releaseMatureEarnings` to sweep globally via `.withIndex("by_status_available", q => q.eq("status", "pending_risk").lte("availableAt", now))` (the index is *not* org-scoped, which is correct for a global cron) and rewrite `preparePublisherTransfer` to use a composite `by_publisher_status` index (see next finding).

---

### [SEV: P2] Missing `by_transfer` index on `publisherEarnings.transferId` — `markPublisherTransferSucceeded` scans the publisher's entire history
**Location:** `convex/schema.ts:278-303` (missing index) and `convex/payouts.ts:442-460`
```ts
const earnings = await ctx.db
  .query("publisherEarnings")
  .withIndex("by_publisher", (q) =>
    q.eq("publisherOrganizationId", transfer.publisherOrganizationId),
  )
  .filter((q) => q.eq(q.field("transferId"), transfer._id))
  .collect();
```
**Problem:** On transfer success, the code must flip every earning allocated to this transfer from `allocated_to_transfer` → `transferred`. The schema has no index on `transferId`, so the query scans the publisher's entire earnings history and filters in-process. `transferId` is an `Id<"publisherTransfers">` — a perfect index key — and the query is on the Stripe-transfer webhook hot path.

**Impact:** O(total publisher earnings) scan per successful Stripe transfer. Scales poorly for high-volume publishers; blocks the transfer-completion webhook proportionally.

**Fix:** Add `.index("by_transfer", ["transferId"])` to `publisherEarnings`, then `withIndex("by_transfer", q => q.eq("transferId", transfer._id)).collect()`.

---

### [SEV: P2] `usageEvents.by_project_at` index is dead; `analytics.ts` comment claims "no time index" and undercounts as a result
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
**Problem:** The schema *does* define `by_org_at` and `by_project_at`, but `analytics.ts` is written as if neither exists. It queries `by_org` / `by_project` (single-field), orders by `_creationTime`, filters on `at` in-process, and caps the scan (`ORG_SCAN_CAP`, `PROJECT_SCAN_CAP`). The comment explicitly says "a by_org_at index is the fix" — that index already exists and is unused. `by_project_at` is referenced by *no* query in the entire `convex/` tree (grep-confirmed).

**Impact:** Analytics silently undercounts any org/project whose recent-event volume exceeds the cap, even though the schema already has the exact index that fixes it. The dead `by_project_at` also adds write amplification to every `usageEvents` insert for zero benefit.

**Fix:** Rewrite the two analytics scans to `.withIndex("by_org_at", q => q.eq("organizationId", org._id).gte("at", cycleStart).lt("at", cycleEnd))` and `by_project_at` analogously; remove the caps. Drop `by_project_at` if analytics won't adopt it.

---

### [SEV: P2] `notifications` and `keySettings` are org-scoped via `clerkOrgId: v.string()` instead of `organizationId: v.id("organizations")`
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
**Problem:** Every other org-scoped table (`projects`, `usageEvents`, `wallets`, `organizationPayments`, `checkoutIntents`, `payments`, `publisherEarnings`, `publisherTransfers`) keys off `organizationId: v.id("organizations")` — a typed FK. `notifications` and `keySettings` instead store the raw Clerk org id string. This is not a cross-org leak (both `notifications.markRead` and `keySettings.getOwnedRow` check the string), but it breaks the schema's referential consistency: there is no FK relationship to `organizations` for these two tables, no way to join by `_id`, and the org-scoping index is on a denormalized string that must be kept in sync with `organizations.clerkOrgId`. If Clerk ever rotates an org id (rare but documented for certain org operations), these tables silently detach.

**Impact:** Schema inconsistency, no FK integrity, and a separate code path for org resolution in `notifications.ts`/`keySettings.ts` (which call `requireOrgMemberBySlug` then use `org.clerkOrgId` rather than `org._id`). Migration hazard: any future query joining user-facing data across tables must special-case these two.

**Fix:** Add `organizationId: v.id("organizations")` to both tables (populate on insert from the resolved org), backfill, and migrate the `by_org` indexes to `["organizationId", ...]`. Keep `clerkOrgId` as a denormalized lookup field only if needed.

---

### [SEV: P2] `publisherEarnings.projectId` is optional but the write path always sets it; `earnings.forOrg` silently drops unprojected rows from the breakdown
**Location:** `convex/schema.ts:282` and `convex/earnings.ts:41-86`, `convex/wallets.ts:442-456`
```ts
publisherEarnings: defineTable({
  publisherOrganizationId: v.id("organizations"),
  /** Immutable published project that earned this settlement. */
  projectId: v.optional(v.id("projects")),   // ← optional, but recordUsage always sets it
  ...
```
**Problem:** `recordUsage` (wallets.ts:446) inserts `projectId: project._id` unconditionally after the null check, so the optionality is unused on the write path. On the read path, `earnings.forOrg` builds a `Map<Id<"projects">, ...>` keyed by `earning.projectId`; if any earning has `projectId === undefined`, it is grouped under the key `undefined`, and the subsequent `ctx.db.get(undefined)` returns `null`, so that earning's gross/net is counted in `allTime` but silently absent from `byProject`. The schema's optionality creates a code path the reader and writer disagree on.

**Impact:** Latent: if any earning is ever created without `projectId` (a future code path, a migration, a manual fix), the publisher's per-project statement silently under-reports while the all-time totals remain correct — an inconsistency that is hard to detect.

**Fix:** Make `projectId: v.id("projects")` required (matches the actual write contract), or handle `undefined` explicitly in `forOrg` with an "unattributed" bucket.

---

### [SEV: P3] `specEmbeddings` comment references the dead `text-embedding-004` model
**Location:** `convex/schema.ts:171`
```ts
// Catalogue semantic search (embedded on publish; Gemini text-embedding-004)
```
**Problem:** `text-embedding-004` is dead — the v1beta endpoint returns HTTP 404 ("models/text-embedding-004 is not found"). The actual model is `gemini-embedding-001` with `outputDimensionality: 768`. The `dimensions: 768` on the vectorIndex (line 182) is correct for `gemini-embedding-001`, but the comment misleads any maintainer regenerating or debugging embeddings.

**Impact:** Misinformation at the schema level; a maintainer following the comment would re-introduce the 404.

**Fix:** Update the comment to `gemini-embedding-001 (768 dims via outputDimensionality)`.

---

### [SEV: P3] `paymentEvents.by_object` index is dead
**Location:** `convex/schema.ts:249`
```ts
.index("by_object", ["objectId"]),
```
**Problem:** Grep across all of `convex/` finds no `.withIndex("by_object", ...)` call. The index is maintained on every `paymentEvents` insert for no reader.

**Impact:** Write amplification on a hot Stripe-webhook write path; no query benefit.

**Fix:** Drop the index, or wire up the intended "find all events for this Stripe object id" lookup (e.g., to detect duplicate event delivery for the same object across event types).

---

### [SEV: P3] `specVersions.by_project` is a redundant prefix of `by_project_published`
**Location:** `convex/schema.ts:55-57`
```ts
.index("by_project", ["projectId"])
.index("by_project_version", ["projectId", "version"])
.index("by_project_published", ["projectId", "publishedAt"]),
```
**Problem:** `by_project_published` has `projectId` as its prefix, so Convex can serve any `eq("projectId", ...)` query from it — including the `.collect()` cascades in `dev.ts:65`, `projects.ts:215`, and `dev.ts:287`. `by_project` adds a second maintained index for the same access path.

**Impact:** Redundant write amplification on every `specVersions` insert.

**Fix:** Drop `by_project`; migrate the three call sites to `by_project_published`.

---

### [SEV: P3] `usageEvents.by_org` and `by_project` are redundant prefixes of `by_org_at` / `by_project_at`
**Location:** `convex/schema.ts:107-110`
```ts
.index("by_org", ["organizationId"])
.index("by_project", ["projectId"])
.index("by_org_at", ["organizationId", "at"])
.index("by_project_at", ["projectId", "at"])
```
**Problem:** `by_org_at` and `by_project_at` make `by_org` and `by_project` strictly redundant (Convex serves `eq(org)` from the composite). `analytics.ts:148` and `analytics.ts:257` use the single-field variants — and as noted above, they *should* be using the time-composites with a range. So these two single-field indexes are both redundant *and* the enablers of a suboptimal query pattern.

**Impact:** Double indexing on the highest-volume table in the system (`usageEvents`). Every gateway settlement insert maintains four indexes when two would do.

**Fix:** Drop `by_org` and `by_project`; migrate `analytics.ts` to the time-composite indexes with proper `at` ranges (resolving the P2 above at the same time).

---

### [SEV: P3] Money/credit fields typed as `v.number()` (float64) — no schema-level integer guard on the ledger
**Location:** `convex/schema.ts:60, 67, 86, 96, 274-289, 305-313, 318-326, 333-340` (and `usageEvents.credits` line 99)
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
**Problem:** Credits are integer units (`accounting.ts`: `$1 = 10_000 credits`, "credits must be a non-negative safe integer") and all arithmetic is integer-floored. But the schema accepts any float64 at the validator level. Application-layer guards (`Number.isSafeInteger` in `grantPaymentCredits`, `reversePaymentCredits`, `applyAdminAdjustment`, `recordUsage`, `publisherEarningSplit`) defend the write paths today, but the schema — the foundation — does not. A future mutation that bypasses those helpers (or a bug in them) can persist `1.5` credits into `wallets.balance`, and the ledger would silently carry fractional credit forever.

**Impact:** Defense-in-depth gap. Convex does not have a native int64 validator distinct from float64, so the schema cannot fully close this — but the absence of any integer-domain validation at the storage boundary is still a foundation-level weakness for a system whose entire integrity rests on integer credit math.

**Fix:** Where Convex offers it, prefer integer validators; otherwise add a centralized `assertIntegerCredits(...)` helper invoked at every insert/patch that touches a credit field, and document the invariant on the fields.

---

### [SEV: P3] `walletEntries` has no `by_wallet_sequence` composite — `walletView` orders by `_creationTime`, not logical `sequence`
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
**Problem:** The ledger has an explicit monotonic `sequence` field, but the "recent 50 entries" view orders by `_creationTime`. Today `sequence` and `_creationTime` are correlated (both set in the same `appendWalletEntry` txn), but they are not the same thing: a backdated or retried entry could have a `_creationTime` that does not match its `sequence` ordering. The schema provides no index to order by `sequence`.

**Impact:** Low. The wallet UI may display entries in an order that does not match the logical ledger order under edge conditions (e.g., an admin backdated entry, or a future migration that inserts historical entries).

**Fix:** Add `.index("by_wallet_sequence", ["walletId", "sequence"])` and order the view by `sequence` desc.

---

### [SEV: P3] `notifications.by_ref` idempotency index is global, not org-scoped
**Location:** `convex/schema.ts:127` and `convex/lib/notifications.ts:36-39`
```ts
.index("by_ref", ["refId"])
```
**Problem:** `createNotification` dedupes by `.withIndex("by_ref", q => q.eq("refId", args.refId)).unique()` — a *global* lookup, not org-scoped. Today every `refId` embeds a globally-unique id (`spec_published:${versionId}`, `version_deprecated:${versionId}`), so cross-org collision is impossible. But the schema offers no protection: a future `refId` pattern that reuses a non-globally-unique token across orgs would silently suppress the second org's notification.

**Impact:** Low today, but the idempotency contract is enforced by refId-construction convention, not by the schema.

**Fix:** Either document the "refId must be globally unique" contract on the field, or make the index `["clerkOrgId", "refId"]` and scope the dedupe lookup.

---

### [SEV: P3] Inconsistent org-scoping index naming across tables
**Location:** `convex/schema.ts` (multiple)
**Problem:** The same conceptual "scoped to one org" index has four different names:
- `by_clerk_org` — `organizations`
- `by_organization` — `wallets`, `organizationPayments`
- `by_org` — `projects`, `usageEvents`, `notifications`, `keySettings`
- `by_publisher` — `publisherEarnings`, `publisherTransfers`

**Impact:** Navigation and grep friction; a maintainer looking for "the org index" must know four names. Contributes to the kind of stale-comment / wrong-index drift seen in the `analytics.ts` finding above.

**Fix:** Standardize on one name (e.g., `by_organization`) across all org-scoped tables.

---

### [SEV: P3] `keySettings.by_key` is a global index on `keyId`, relying entirely on Clerk keyId global uniqueness
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
**Problem:** `getOwnedRow` looks up by `keyId` globally with `.unique()`. This is correct only if Clerk keyIds are globally unique across orgs — which they are. But the index is not org-scoped, so if a keyId were ever reused across orgs (a Clerk data export/import, a test-seeding mistake), `.unique()` would throw and the upsert would error rather than dedupe across orgs.

**Impact:** Low. Relies on an external invariant (Clerk keyId uniqueness) with no schema-level co-scoping.

**Fix:** Make the lookup org-scoped: `.index("by_org_key", ["clerkOrgId", "keyId"])` and query with both fields. Defense-in-depth at near-zero cost.

---

## Summary

**Counts:** 0 P0 · 0 P1 · 6 P2 · 9 P3 — 15 findings total.

**Top 3:**
1. **`specVersions.spec` immutability is unenforced at the schema level** (P2) — the control plane's most load-bearing invariant (published, pricing-bearing spec bodies are immutable) is defended by nothing in the schema and relies entirely on code-review discipline in `specs.ts`.
2. **Dead `by_status_available` + missing `by_transfer` index on `publisherEarnings`** (P2 × 2) — the earnings/transfer crons scan the publisher's entire history because the index that exists is unused and the index that's needed doesn't exist.
3. **`usageEvents.by_project_at` is dead while `analytics.ts` undercounts and claims "no time index"** (P2) — the exact index the code says is missing is sitting in the schema, unused, while high-volume orgs are silently undercounted.

**Recurring theme:** The schema defines several indexes ahead of the code that should consume them (`by_status_available`, `by_project_at`), then the code was written/stale as if they didn't exist — so the schema carries dead weight *and* the queries still scan. Reconciling schema intent with query reality is the single highest-leverage cleanup here.
