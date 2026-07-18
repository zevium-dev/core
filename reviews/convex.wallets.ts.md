# Tiger-Style Review — `convex/wallets.ts`

## Verdict
NEEDS WORK — one P0 data-corruption race in wallet creation, plus multiple P1 correctness/contract bugs in the ledger primitive and settlement ingest. The credit ledger's core invariants (one wallet per org, idempotent materialization, canonical post-write state, org-scoped no-leak) are each violated by at least one path below.

## File Stats
- **Path:** `convex/wallets.ts`
- **LOC:** 463
- **Role:** Authoritative credit ledger for the platform. Appends signed `walletEntries`, materializes `wallets.balance`/`sequence`, exposes the edge Wallet DO checkpoint (`getGatewayWallet`), ingests gateway settlements (`recordUsage`), and grants/reverses/admin-adjusts credits. The single source of truth for org balances — every gateway block/allow decision derives from this file's state.

## Findings

---

### [SEV: P0] `getOrCreateWallet` can create duplicate wallets for one org, permanently bricking the ledger
**Location:** `convex/wallets.ts:29-47` (`getOrCreateWallet`); schema `wallets` table (`convex/schema.ts:48-53`).

```ts
async function getOrCreateWallet(ctx, organizationId) {
  const existing = await ctx.db
    .query("wallets")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .unique();
  if (existing !== null) return existing;
  const walletId = await ctx.db.insert("wallets", { organizationId, balance: 0, sequence: 0 });
  ...
}
```

**Problem:** The read-then-insert is not atomic against concurrent inserters. Convex indexes are **not unique constraints** — `.unique()` is a read helper that throws if >1 row matches, but it does not prevent two transactions from both observing zero rows and both inserting. OCC does not save this case: each transaction's read-set contains no overlapping document (the wallet doesn't exist yet), and the two inserts target different document ids, so there is no write-write conflict to trigger a retry. Both commit.

Two realistic concurrent callers:
- `ensureWallet` (public `mutation`, line 308) invoked from the web app while a Stripe webhook fires `grantPaymentCredits` for the same brand-new org.
- Two `ensureWallet` calls from two browser tabs / org switch.
- `upsertFromClerk` (organizations.ts) creating the org's wallet concurrent with the first settlement's `getOrCreateWallet`.

**Impact:** Once two wallet rows exist for one `organizationId`, every subsequent `getWalletForOrg(...).unique()` (and `getOrCreateWallet`'s own read) throws `NonUniqueResponseError`. The org can no longer grant credits, settle usage, fetch a checkpoint, or render its wallet view. The ledger is split across two `wallets` docs with independent `sequence` counters — `appendWalletEntry` writes go to whichever wallet the snapshot read first, so balance materialization diverges from the entries. Manual DB surgery is required to recover. This is the credit ledger's foundational invariant (one wallet per org) and it is unenforced.

**Fix:** Move wallet creation to the org-creation path only (already done in `organizations.upsertFromClerk`), and make `getOrCreateWallet` a strict "get or throw" in the wallet-mutation paths. If get-or-create must stay, add a guard that survives concurrency — e.g. insert unconditionally and reconcile, or route all wallet creation through a single internal mutation called only from `upsertFromClerk`. At minimum, after insert, re-query and delete duplicates / throw. The only real fix is to never call `getOrCreateWallet` from concurrent paths: `grantPaymentCredits`/`recordUsage`/`applyAdminAdjustment` should `getWalletForOrg` and throw if missing, since `upsertFromClerk` guarantees existence.

---

### [SEV: P1] `appendWalletEntry` never validates that the materialized `balance`/`sequence` are safe integers
**Location:** `convex/wallets.ts:107-108, 119`.

```ts
const sequence = args.wallet.sequence + 1;
const balance = args.wallet.balance + args.amount;
...
await ctx.db.patch(args.wallet._id, { balance, sequence });
```

**Problem:** Callers validate the input `amount` (`Number.isSafeInteger(args.amount)`), but nobody validates the output. `balance + amount` and `sequence + 1` can exceed `Number.MAX_SAFE_INTEGER` (2^53 − 1). `balance` reaches 2^53 after ~9.007 × 10^15 credits (~$900 billion at 10k/$1 — implausible for grants, but a malicious/buggy `applyAdminAdjustment` of `Number.MAX_SAFE_INTEGER` plus an existing grant does it in two writes; `sequence` reaches it after ~9 × 10^15 entries, also implausible but unguarded). Once the materialized balance is a non-safe float, every subsequent `balance + amount` propagates precision loss, and the edge DO's checkpoint reconciliation (`sequence` comparison) becomes non-deterministic. `creditsToUsdCents` and `publisherEarningSplit` in `accounting.ts` both guard their inputs with `Number.isSafeInteger`; the ledger primitive that *produces* balances does not.

**Impact:** Silent ledger corruption with precision loss once any balance or sequence crosses 2^53. Non-recoverable without manual intervention.

**Fix:** In `appendWalletEntry`, after computing `balance` and `sequence`:
```ts
if (!Number.isSafeInteger(balance) || !Number.isSafeInteger(sequence)) {
  throw new Error("Ledger overflow: balance or sequence exceeds safe integer range");
}
```

---

### [SEV: P1] `recordUsage` ignores `settled.applied` and always reports `status: "applied"`
**Location:** `convex/wallets.ts:426-457`.

```ts
const settled = await appendWalletEntry(ctx, { wallet, kind: "usage_settlement", amount: -event.credits, refId: event.settleRefId, usageEventId });
wallet = settled.wallet;
...
results.push({ refId: event.settleRefId, status: "applied" });  // ← unconditional
```

**Problem:** `appendWalletEntry` returns `{ applied: boolean, wallet }` and can return `applied: false` when its *internal* refId dedup (lines 97-105) finds a pre-existing entry that the outer dedup (lines 379-394) did not — possible during OCC retry windows where the snapshot changes between the outer read and the inner read within the same retried handler invocation, or simply as a defensive gap. The result is discarded: the gateway is told `status: "applied"` for a no-op. The docstring on `recordUsage` promises "Every event receives a durable outcome; callers retain only rejected items." If a duplicate is reported as `applied`, the gateway may re-ack or skip its own compensation accounting. The contract on `SettlementResult` (`"applied" | "already_applied" | "rejected"`) is violated.

**Impact:** Idempotency contract broken; gateway settlement ack state diverges from Convex ledger state. Under retry storms this can double-count or mis-route compensating actions.

**Fix:**
```ts
results.push({
  refId: event.settleRefId,
  status: settled.applied ? "applied" : "already_applied",
});
```

---

### [SEV: P1] `appendWalletEntry`'s refId-collision branch is not scoped to the target wallet — cross-org silent no-op + balance/sequence leak
**Location:** `convex/wallets.ts:97-105` (called from `grantPaymentCredits:148`, `reversePaymentCredits:181`, `applyAdminAdjustment:211`).

```ts
if (existing !== null) {
  const wallet = await ctx.db.get(existing.walletId);
  if (wallet === null) throw new Error("Wallet missing for existing entry");
  return { applied: false, wallet };   // ← no check that existing.walletId === args.wallet._id
}
```

**Problem:** When a `refId` already exists, `appendWalletEntry` returns the wallet that owns the *existing* entry — not the wallet the caller asked to mutate. The three internal mutation callers then do `checkpoint(organization.clerkOrgId, result.wallet)`, stamping the **caller org's** `clerkOrgId` onto a `balance`/`sequence` pulled from a **different org's** wallet. For `applyAdminAdjustment` (admin-supplied `refId`) and any refId-namespace collision (e.g. a future caller reusing a prefix), this (a) silently drops the intended credit/reversal — the target org never gets its grant/adjustment — and (b) returns the other org's `balance` and `sequence` to the caller, which propagates to the edge DO checkpoint and to billing action callers. `recordUsage` has its own scoped check (line 384) so it is not affected; the three single-entry mutations are.

**Impact:** Lost credits / lost reversals on refId collision; cross-org balance + sequence leak. The ledger's "never leak across orgs" invariant is broken for the grant/reverse/admin paths.

**Fix:** Scope the collision branch:
```ts
if (existing !== null) {
  if (existing.walletId !== args.wallet._id) {
    throw new Error("refId belongs to a different wallet");
  }
  return { applied: false, wallet: args.wallet };
}
```

---

### [SEV: P1] `recordUsage` requires `organizationId` in `usageEventArg` but never uses it — misleading, authz-defeating input
**Location:** `convex/wallets.ts:318` (validator), `convex/wallets.ts:356-460` (handler).

```ts
const usageEventArg = v.object({
  organizationId: v.id("organizations"),   // ← required, validated as Id<"organizations">, then discarded
  projectId: v.id("projects"),
  ...
  consumerClerkOrgId: v.string(),
});
```

**Problem:** The consumer org is resolved from `consumerClerkOrgId` (line 356) and the publisher from `event.projectId` (line 396). `event.organizationId` is never read, never stored on the `usageEvents` row (line 414-425 stores `organizationId: consumerOrg._id`), and never compared to anything. The gateway client (`apps/gateway/src/usage.ts`) sends the publisher's convex org id as `organizationId`. A caller can pass any org id — including one it does not own — and the field is silently accepted. This defeats any authz audit: a reader/reviewer assumes `organizationId` is the authoritative org, but the actual wallet debited is `consumerOrg` from `consumerClerkOrgId`. The field is a footgun.

**Impact:** Misleading API surface; a future caller that trusts `organizationId` for scoping will be wrong. No direct exploit (consumer is resolved via `consumerClerkOrgId`), but it invites a future authz bug and makes the contract ambiguous.

**Fix:** Remove `organizationId` from `usageEventArg` (and from the gateway client + `parseIngestUsageBody` in `http.ts`). If kept for compatibility, document it as ignored and validate it equals `consumerOrg._id` after resolution.

---

### [SEV: P1] `recordUsage` accepts non-integer `status`, `latencyMs`, and `at`; `at` is an index key
**Location:** `convex/wallets.ts:367-369` (validation), `convex/wallets.ts:414-425` (storage).

```ts
if (
  !Number.isFinite(event.at) ||
  !Number.isFinite(event.status) ||
  !Number.isFinite(event.latencyMs)
) { ... reject ... }
```

**Problem:** `Number.isFinite` accepts floats: `200.5`, `0.1`, `-3`. `event.status` is stored raw and aggregated downstream (`convex/billing.ts cycleBreakdown`, `convex/usage.ts listForOrg` count by status). `event.at` is the `by_org_at` and `by_at` index key (schema `usageEvents` indexes); a float epoch corrupts range scans (`gte`/`lt` on `since`/`until`) and `desc` ordering — two entries with `at = 1000` and `at = 1000.5` interleave nondeterministically with `at = 1000` from another batch. `credits` is correctly guarded with `Number.isSafeInteger`; `status`/`latencyMs`/`at` are not.

**Impact:** Polluted time-range queries, broken usage/billing ordering, non-integer HTTP statuses stored. `credits` — the only field that touches the ledger — is correctly integer-validated; the analytics fields are sloppy.

**Fix:**
```ts
!Number.isSafeInteger(event.at) || event.at < 0 ||
!Number.isSafeInteger(event.status) ||
!Number.isSafeInteger(event.latencyMs) || event.latencyMs < 0
```

---

### [SEV: P1] `recordUsage` has no batch-size cap; unbounded array argument can blow the transaction
**Location:** `convex/wallets.ts:338`.

```ts
export const recordUsage = internalMutation({
  args: { events: v.array(usageEventArg) },
  ...
});
```

**Problem:** `v.array(usageEventArg)` accepts any length. The http `/ingest-usage` action caps at 500 (`convex/http.ts` `parseIngestUsageBody`), but `recordUsage` is an `internalMutation` directly callable via `ctx.runMutation` from any action — including future cron/batch-replay paths — with no cap. A 10k-event batch does 10k `walletEntries` inserts + 10k `usageEvents` inserts + 10k `publisherEarnings` lookups + up to 10k `publisherEarnings` inserts + 10k `projects.get` in one transaction. Convex transaction size/time limits will abort the whole batch (atomically — no partial apply), wasting the work and returning 500 to the gateway, which will retry the same oversized batch forever.

**Impact:** DoS / livelock vector if any caller ever sends an oversized batch; wasted capacity. The http cap is the only defense and it is in the wrong layer.

**Fix:** Enforce the cap in `recordUsage` itself:
```ts
const MAX_BATCH = 500;
if (args.events.length > MAX_BATCH) {
  throw new Error(`recordUsage batch exceeds ${MAX_BATCH} events`);
}
```

---

### [SEV: P1] `recordUsage` doesn't validate `event.at` is a plausible epoch; negative/zero accepted as index key
**Location:** `convex/wallets.ts:367` (only `!Number.isFinite`), `convex/wallets.ts:423` (stored as `at`).

**Problem:** `at` is only checked for finiteness. A gateway bug or malicious payload with `at: -1` or `at: 0` is accepted, stored, and indexed under `by_org_at` / `by_at`. Downstream time-range queries (`billing.cycleBreakdown` for "current UTC month" via `gte(cycleStart)`, `usage.listForOrg` with `since`/`until`) will include or exclude these rows incorrectly; `order("desc")` puts bogus `at` values at the bottom, dropping them from paginated "recent" views.

**Impact:** Corrupted billing/usage time windows; silent missing-or-extra rows in analytics.

**Fix:** Require `event.at` to be a positive safe integer in a sane epoch range (e.g. `> 0` and `<= Date.now() + smallSkew`).

---

### [SEV: P1] `applyAdminAdjustment` has no audit trail — no admin identity, no reason, no admin-action log
**Location:** `convex/wallets.ts:195-222`.

```ts
export const applyAdminAdjustment = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    amount: v.number(),
    refId: v.string(),
  },
  ...
});
```

**Problem:** An admin can credit or debit any org's wallet by any non-zero safe-integer amount. The only record is a `walletEntries` row with `kind: "admin_adjustment"` and an admin-supplied `refId`. There is no `adminUserId`, no `reason`, no link to an admin-action audit table. For a credit ledger (the system of record for prepaid customer credits and publisher payouts), this is a material audit gap: any admin can create or destroy arbitrary credit with no accountable trace beyond a free-text refId they choose.

**Impact:** SOX/audit/compliance gap; no accountability for the most privileged ledger write.

**Fix:** Add `adminUserId: v.string()` and `reason: v.string()` to the args, persist them on the `walletEntries` row (new optional fields) or a dedicated `adminActions` table, and require a `requireAdmin`-style identity check at the calling action layer (the mutation itself is internal, so the action that invokes it must pass the verified admin id).

---

### [SEV: P2] `recordUsage` creates zero-amount `publisherEarning` rows for free-tier (`credits === 0`) settlements
**Location:** `convex/wallets.ts:435-456`.

```ts
const split = publisherEarningSplit(event.credits);  // credits may be 0
...
if (existingEarning === null) {
  await ctx.db.insert("publisherEarnings", {
    ...grossCredits: split.grossCredits, platformFeeCredits: split.platformFeeCredits, netCredits: split.publisherNetCredits,
    availableAt: now + PUBLISHER_RISK_HOLD_MS,
    status: "pending_risk",
    ...
  });
}
```

**Problem:** `credits === 0` passes the `event.credits < 0` guard (line 366). `publisherEarningSplit(0)` returns `{grossCredits:0, platformFeeCredits:0, publisherNetCredits:0}`. A `publisherEarnings` row with all-zero amounts and `status: "pending_risk"` is inserted, with `availableAt = now + 7d`. These rows will transition through the full earning lifecycle (`pending_risk` → `available` → `allocated_to_transfer` → `transferred`) for zero value, polluting the `by_status_available` and `by_publisher` indexes and any payout/aggregation query. Free-tier settlements also create a zero-amount `walletEntries` row (line 426-432) that increments `sequence` without mutating `balance` — inflating the edge DO's checkpoint sequence with non-mutating entries.

**Impact:** Ledger/earnings pollution; inflated sequence; wasted storage and index scans.

**Fix:** Skip the `publisherEarning` insert (and arguably the `walletEntry` insert) when `event.credits === 0`, or short-circuit free-tier events before the ledger path entirely.

---

### [SEV: P2] `walletView` orders entries by `_creationTime`, not `sequence` — `by_wallet` index lacks a sort field
**Location:** `convex/wallets.ts:280-284`; schema `walletEntries` index `by_wallet: ["walletId"]` (`convex/schema.ts:75`).

```ts
const entries = await ctx.db
  .query("walletEntries")
  .withIndex("by_wallet", (q) => q.eq("walletId", wallet._id))
  .order("desc")
  .take(50);
```

**Problem:** The `by_wallet` index is `["walletId"]` only — no `sequence` or `createdAt` in the index. `.order("desc")` therefore falls back to `_creationTime` (Convex's implicit ordering). The `WalletEntryView` exposes `sequence`, implying the list is sequence-ordered, but the 50-row window is creation-time-ordered. In practice `_creationTime` ≈ `createdAt` ≈ insert order ≈ sequence order for the happy path, but under OCC retry (a retried transaction re-inserts with a later `_creationTime` but an earlier `sequence` than a concurrently-committed sibling) or any future backfill, the `.take(50)` window will drop the wrong rows — showing entries 51–100-by-sequence while hiding 1–50, or vice versa.

**Impact:** Incorrect "recent entries" view under concurrency/retry; misleading ledger display.

**Fix:** Add `sequence` to the index: `.index("by_wallet", ["walletId", "sequence"])` and order by it, or sort the taken page in-memory by `sequence` before returning.

---

### [SEV: P2] `getGatewayWallet` returns `keySettings` even when the organization is null — orphaned settings leak to the edge
**Location:** `convex/wallets.ts:236-251`.

```ts
const organization = await getOrganizationByClerkId(ctx, args.clerkOrgId);
const wallet = organization === null ? null : await getWalletForOrg(ctx, organization._id);
const settings = await ctx.db
  .query("keySettings")
  .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
  .collect();
return {
  wallet: wallet === null ? { clerkOrgId: args.clerkOrgId, balance: 0, sequence: 0 } : checkpoint(...),
  keySettings: settings.map(toGatewayRow),
};
```

**Problem:** When `organization === null` (org deleted, never created, or stale `clerkOrgId`), the wallet checkpoint is synthesized as `{balance:0, sequence:0}` — reasonable — but `keySettings` is still queried and returned. If `keySettings` rows persist after org deletion (no cascade delete in `deleteFromClerk` per `organizations.ts`), the edge DO receives active key gates (monthly caps, `disabled` flags, rotation grace) for a non-existent org. The edge will honor them, potentially allowing or blocking keys for an org that no longer exists.

**Impact:** Stale/orphaned key settings honored by the edge for deleted/unknown orgs; confusing behavior; potential authz surprise if a `clerkOrgId` is reused.

**Fix:** When `organization === null`, return `keySettings: []` (and consider a `404`-style sentinel instead of a synthesized zero-balance checkpoint, so the edge knows the org is unknown rather than fresh).

---

### [SEV: P2] `appendWalletEntry` is the ledger primitive but performs no validation of `amount` or the resulting balance
**Location:** `convex/wallets.ts:86-125`.

**Problem:** `appendWalletEntry` is the single chokepoint through which every balance mutation flows, yet it trusts `args.amount` entirely. `recordUsage` validates `event.credits` then passes `-event.credits` (re-derivation, no re-check). `applyAdminAdjustment` allows any non-zero safe integer — a single `amount: -9_007_199_254_740_991` write creates `Number.MAX_SAFE_INTEGER` of debt in one entry, and combined with finding #2 the next grant overflows. There is no bound on the magnitude of a single entry, no sign check against `kind` (e.g. `usage_settlement` should be ≤ 0, `payment_grant` should be > 0), and no post-compute safe-integer check on `balance`. Defense-in-depth is absent at the one function that writes the ledger.

**Impact:** A caller bug or compromised internal action can write an arbitrary-magnitude ledger entry; the ledger primitive offers no last-line guard.

**Fix:** In `appendWalletEntry`, validate `Number.isSafeInteger(args.amount)`, enforce sign-by-`kind` invariants (grant > 0, usage_settlement ≤ 0, reversals < 0), and check the resulting `balance`/`sequence` are safe integers (see finding #2).

---

### [SEV: P2] Duplicated `getOrCreateWallet` implementation in `organizations.ts` — same race, drift risk
**Location:** `convex/organizations.ts:11-27` (`ensureWallet`), duplicating `convex/wallets.ts:29-47`.

**Problem:** Two independent copies of "get-or-create wallet" with identical logic and the identical P0 race (finding #1). A fix to one will not propagate to the other; the two can diverge. `organizations.ts`'s `ensureWallet` is called from `upsertFromClerk` (the org-creation path) and is the "canonical" wallet creator; `wallets.ts`'s `getOrCreateWallet` is called from every ledger mutation. Having both means the "wallets are only created at org creation" invariant is unenforceable — `wallets.ts` still creates them.

**Impact:** Race-fix drift; the P0 race persists in two places.

**Fix:** Delete `getOrCreateWallet` in `wallets.ts` and replace its call sites with `getWalletForOrg` + throw-on-missing (since `upsertFromClerk` guarantees the wallet exists). Keep a single `ensureWallet` in `organizations.ts`.

---

### [SEV: P2] `recordUsage` doesn't validate that `event.projectId` is a published project owned by a legitimate publisher
**Location:** `convex/wallets.ts:396-404, 444-455`.

```ts
const project = await ctx.db.get(event.projectId);
if (project === null) { reject; continue; }
...
await ctx.db.insert("publisherEarnings", {
  publisherOrganizationId: project.organizationId,
  projectId: project._id,
  ...
});
```

**Problem:** `event.projectId` is client-supplied (gateway). The only check is existence. No validation that `project.status === "published"`, that the project is live, or that the consumer is authorized to have called it. A compromised gateway (leaked `GATEWAY_INTERNAL_SECRET`) or a gateway bug can attribute a settlement to any project id, crediting that project's org with publisher earnings for calls never made to that project. The internal-secret boundary is the only defense; for publisher money movement, that is too thin.

**Impact:** Mis-attributed publisher earnings; a single leaked secret enables arbitrary publisher crediting.

**Fix:** Validate `project.status === "published"`; optionally cross-check the `endpoint`/`method` against the published spec (out of scope here, but at minimum reject draft/private projects).

---

### [SEV: P2] `getGatewayWallet` `.collect()` on `keySettings` is unbounded
**Location:** `convex/wallets.ts:241-244`.

```ts
const settings = await ctx.db
  .query("keySettings")
  .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
  .collect();
```

**Problem:** No `.take(N)` and no filter on `disabled` or expired `graceUntil`. An org that has rotated many keys returns every historical `keySettings` row on every checkpoint poll (`/wallet-grants` GET, called by the edge DO on its sync cadence). For a long-lived org this is unbounded growth in payload size and query cost per poll.

**Impact:** Unbounded read/payload on a hot edge-sync path.

**Fix:** Filter to active keys (`disabled === false` and `graceUntil` not expired or not set) and/or `.take(N)` with a sane cap.

---

### [SEV: P3] `getOrCreateWallet` does a redundant `ctx.db.get(walletId)` after insert
**Location:** `convex/wallets.ts:44-45`.

```ts
const walletId = await ctx.db.insert("wallets", { organizationId, balance: 0, sequence: 0 });
const wallet = await ctx.db.get(walletId);
if (wallet === null) throw new Error("Failed to create wallet");
return wallet;
```

**Problem:** The inserted document's content is fully known (`{organizationId, balance: 0, sequence: 0}` + `_id` + `_creationTime`). The extra `ctx.db.get` is a wasted read. Return the constructed object directly (with `_id: walletId` and `_creationTime` if needed).

**Impact:** Minor wasted read per wallet creation.

---

### [SEV: P3] `recordUsage` doesn't validate `event.endpoint`, `event.method`, `event.keyId` are non-empty
**Location:** `convex/wallets.ts:417-422` (stored raw from validator `v.string()`).

**Problem:** Empty strings pass `v.string()` and are stored, then surfaced in usage UI and billing breakdowns. A malformed gateway payload with `endpoint: ""` produces blank rows.

**Impact:** Minor data-quality; cosmetic in UI.

---

### [SEV: P3] `recordUsage` doesn't validate `event.status` is a real HTTP status (1xx–5xx)
**Location:** `convex/wallets.ts:420`. Any finite number is accepted (see finding #6 for the integer gap); even with the integer fix, `7` or `9999` would be accepted.

**Impact:** Minor; downstream status-bucketing may mis-handle out-of-range codes.

---

### [SEV: P3] `appendWalletEntry` `createdAt: Date.now()` is identical across a `recordUsage` batch — useless for intra-batch ordering
**Location:** `convex/wallets.ts:117`. Within one `recordUsage` transaction, all entries get near-identical `createdAt` values, so `sequence` is the only reliable intra-batch order. Combined with finding #11 (index lacks `sequence`), intra-batch ordering in `walletView` is effectively `_creationTime` = insertion order, which is correct here but fragile.

**Impact:** Minor; `sequence` is the canonical order, `createdAt` is not.

---

### [SEV: P3] Error messages leak internal structure to internal callers
**Location:** `convex/wallets.ts:103` ("Wallet missing for existing entry"), `146` ("Organization not found"), `358` ("Consumer organization not found"), `344` ("At least one settlement is required").

**Problem:** These are `internalMutation`s whose thrown messages propagate to the calling action. The http layer masks them (`{error: "ingest failed"}` / `"wallet checkpoint failed"`), but direct internal callers (tests, future actions) see the raw messages. Not a user-facing leak today, but inconsistent with the "never leak internal errors" product rule.

**Impact:** Minor; defense-in-depth.

---

### [SEV: P3] `recordUsage` `event.credits === 0` creates a zero-amount `walletEntry` that increments `sequence` without mutating balance
**Location:** `convex/wallets.ts:426-432`. A free-tier settlement with `credits: 0` inserts a `walletEntries` row (`amount: 0`) and bumps `sequence`. The edge DO's checkpoint reconciliation (strictly-newer `sequence`) will treat this as a real ledger advance. Inflates sequence and the `walletEntries` table with no-op entries.

**Impact:** Minor ledger noise; sequence diverges from "number of balance mutations."

---

## Summary

| Severity | Count |
|---|---|
| P0 | 1 |
| P1 | 8 |
| P2 | 7 |
| P3 | 6 |
| **Total** | **22** |

**Top 3 to fix first:**
1. **P0 — Duplicate-wallet race in `getOrCreateWallet`.** The single most dangerous defect: permanently bricks an org's ledger on a race that is reachable in normal operation (org-creation concurrent with first grant/settlement). Fix by making wallet creation happen *only* in `upsertFromClerk` and switching all mutation call sites to get-or-throw. Also delete the duplicated `ensureWallet` in `organizations.ts` (finding #14) to prevent drift.
2. **P1 — Cross-wallet refId-collision silent no-op + balance/sequence leak in `appendWalletEntry`.** The ledger primitive returns another org's wallet on `refId` collision without scoping. One-line guard (`existing.walletId !== args.wallet._id` → throw) closes a direct cross-org leak in the grant/reverse/admin paths.
3. **P1 — `recordUsage` reports `status: "applied"` ignoring `settled.applied`.** Violates the idempotency contract the file's own docstring promises. One-line fix restores canonical post-write state reporting.

Honorable mentions: safe-integer overflow guard on materialized `balance`/`sequence` (#2), unused `organizationId` input (#5), non-integer `at`/`status`/`latencyMs` accepted as index keys (#6), and the missing batch-size cap in `recordUsage` (#7) — all low-effort, high-value guards on the ledger's correctness perimeter.
