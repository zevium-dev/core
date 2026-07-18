# Tiger-Style Deep Review — `convex/wallets.ts`

## Verdict
NEEDS WORK — no P0. The prior review's headline P0 (duplicate-wallet race permanently bricking the ledger) is **not reachable** under Convex's documented serializable isolation: the `by_organization` index-range read in `getOrCreateWallet` is tracked by OCC, so two concurrent inserts conflict and the second retries into the first's wallet (see §Verification below). The credit ledger's real defects are an unguarded arithmetic-perimeter cluster (materialized `balance`/`sequence` overflow, `publisherEarningSplit` multiplication overflow, no sign-by-`kind` guard in the primitive), a cross-wallet `refId`-collision leak in `appendWalletEntry`, a set of input-validation holes on the settlement ingest (`at`/`status`/`latencyMs` floats, no batch cap, unused `organizationId`, no self-dealing guard), and a missing audit trail on `applyAdminAdjustment`. 29 findings below: 0 P0, 7 P1, 15 P2, 7 P3.

## File Stats
- **Path:** `convex/wallets.ts` (462 LOC)
- **Role:** Authoritative credit ledger. Appends signed `walletEntries`, materializes `wallets.balance`/`sequence`, exposes the Wallet DO checkpoint (`getGatewayWallet`), ingests gateway settlements (`recordUsage`), grants/reverses/admin-adjusts credits. Every gateway allow/block decision derives from this file's state.
- **Cross-file read for verification:** `convex/schema.ts`, `convex/accounting.ts`, `convex/usage.ts`, `convex/billing.ts`, `convex/organizations.ts`, `convex/http.ts`, `convex/keySettings.ts`, `convex/lib/auth.ts`.

## Verification of Prior Review

| # | Prior claim | Verdict | Note |
|---|---|---|---|
| P0-1 | `getOrCreateWallet` duplicate-wallet race bricks ledger | **DOWNGRADE → P2** | Not reachable under Convex serializable isolation. OCC tracks the empty `by_organization` index range; a concurrent insert into that range invalidates the read set and forces retry. The Convex "unique documents" recipe explicitly endorses read-then-insert within one mutation. The brick *would* be catastrophic if a duplicate ever arose (every `.unique()` thereafter throws `NonUniqueResponseError`), but the race as described cannot produce one via mutations. |
| P1-3 | `recordUsage` ignores `settled.applied`, always reports `"applied"` | **DOWNGRADE → P3** | Within `recordUsage`, `appendWalletEntry` is only reached after the outer `by_ref` dedup (lines 379-394) returns `existing === null`. The outer and inner reads share one transaction snapshot, so the inner dedup is guaranteed `null` too — `settled.applied` is always `true` here. Defensive-only; the check should still exist for primitive-invariance hygiene. |
| P1-2,4,5,6,7,8,9; P2-10..16; P3-17..21 | (see below) | **CONFIRMED** | All reproduced against current source. |

---

## Findings

### [SEV: P1] Materialized `balance`/`sequence` are never safe-integer checked — silent precision loss past 2^53
**Location:** `convex/wallets.ts:107-108, 119` (`appendWalletEntry`).

```ts
const sequence = args.wallet.sequence + 1;
const balance = args.wallet.balance + args.amount;
...
await ctx.db.patch(args.wallet._id, { balance, sequence });
```

**Problem:** Every caller validates the input `amount` (`Number.isSafeInteger`), but the *output* `balance + amount` and `sequence + 1` are never checked. `applyAdminAdjustment` accepts any non-zero safe integer, so a single `amount: 9_007_199_254_740_991` write on a wallet with balance ≥ 0 produces `balance ≥ 2^53`, after which `Number.isSafeInteger` is false and every subsequent `balance + amount` propagates float precision loss. `sequence` is slower to overflow (~9×10^15 entries) but is equally unguarded. Once the materialized balance is a non-safe float, the edge DO's checkpoint reconciliation (`sequence` strictly-newer comparison) becomes non-deterministic and `creditsToUsdCents` / `publisherEarningSplit` operate on corrupted input.

**Impact:** Silent, non-recoverable ledger corruption once any balance crosses 2^53. Reached in two writes via `applyAdminAdjustment`.

**Fix:** In `appendWalletEntry`, after computing `balance`/`sequence`:
```ts
if (!Number.isSafeInteger(balance) || !Number.isSafeInteger(sequence)) {
  throw new Error("Ledger overflow: balance or sequence exceeds safe integer range");
}
```

---

### [SEV: P1] `appendWalletEntry`'s `refId`-collision branch is not scoped to the target wallet — cross-org silent no-op + balance/sequence leak
**Location:** `convex/wallets.ts:97-105` (called from `grantPaymentCredits:148`, `reversePaymentCredits:181`, `applyAdminAdjustment:211`).

```ts
if (existing !== null) {
  const wallet = await ctx.db.get(existing.walletId);
  if (wallet === null) throw new Error("Wallet missing for existing entry");
  return { applied: false, wallet };   // ← no check that existing.walletId === args.wallet._id
}
```

**Problem:** On `refId` collision, the primitive returns the wallet that owns the *existing entry* — not the wallet the caller asked to mutate. The three internal-mutation callers then do `checkpoint(organization.clerkOrgId, result.wallet)`, stamping the **caller org's** `clerkOrgId` onto a `balance`/`sequence` pulled from a **different org's** wallet. For `applyAdminAdjustment` (admin-supplied `refId`) or any future caller reusing a refId prefix, this (a) silently drops the intended credit/reversal — the target org never gets its grant/adjustment — and (b) returns the other org's `balance` and `sequence` to the caller, which propagates to the billing action and to the edge DO checkpoint. `recordUsage` already guards this at its outer dedup (`existing.walletId === wallet._id` → `rejected`), but the primitive itself — the single chokepoint for grant/reverse/admin — does not.

**Impact:** Lost credits/reversals on refId collision; cross-org balance + sequence disclosure from the ledger primitive. Stripe PI/dispute ids are globally unique so the practical collision probability is low for grant/reverse, but `applyAdminAdjustment` refIds are admin-chosen and the contract violation is real regardless of current caller behavior.

**Fix:**
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
  organizationId: v.id("organizations"),   // ← required, validated, then discarded
  projectId: v.id("projects"),
  ...
  consumerClerkOrgId: v.string(),
});
```

**Problem:** The consumer org is resolved from `consumerClerkOrgId` (line 356) and the publisher from `event.projectId` (line 396). `event.organizationId` is never read, never stored on the `usageEvents` row (line 414 stores `organizationId: consumerOrg._id`), and never compared to anything. The http layer (`convex/http.ts:379`) passes the gateway-supplied publisher org id as `organizationId`. A caller can pass any org id — including one it does not own — and the field is silently accepted. The wallet actually debited is `consumerOrg` (from `consumerClerkOrgId`), not `event.organizationId`. A future caller that trusts `organizationId` for scoping will be wrong.

**Impact:** Misleading API surface; invites a future authz bug. The contract is ambiguous because two fields claim to identify the org.

**Fix:** Remove `organizationId` from `usageEventArg` (and from the gateway client + `parseIngestUsageBody` in `http.ts`). If kept for compatibility, validate `event.organizationId === consumerOrg._id` after resolution.

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

**Problem:** `Number.isFinite` accepts floats: `200.5`, `0.1`, `-3`. `event.status` is stored raw and aggregated downstream (`billing.cycleBreakdown`, `usage.listForOrg`). `event.at` is the `by_org_at` and `by_at` index key (schema `usageEvents`); a float epoch corrupts range scans (`gte`/`lt` on `since`/`until` in `usage.listForOrg` and `billing.cycleBreakdown`'s month window) and `desc` ordering — two entries with `at = 1000` and `at = 1000.5` interleave nondeterministically with a concurrent batch's `at = 1000`. `credits` — the only field touching the ledger — is correctly guarded with `Number.isSafeInteger`; the analytics fields are sloppy.

**Impact:** Polluted time-range queries, broken usage/billing ordering, non-integer HTTP statuses stored and aggregated.

**Fix:**
```ts
!Number.isSafeInteger(event.at) || event.at <= 0 ||
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

**Problem:** `v.array(usageEventArg)` accepts any length. The http `/ingest-usage` action caps at 500 (`http.ts` `parseIngestUsageBody`), but `recordUsage` is an `internalMutation` directly callable via `ctx.runMutation` from any action — including future cron/batch-replay paths — with no cap. A 10k-event batch does 10k `walletEntries` inserts + 10k `usageEvents` inserts + 10k `publisherEarnings` lookups + up to 10k `publisherEarnings` inserts + 10k `projects.get` in one transaction. Convex transaction size/time limits abort the whole batch atomically (no partial apply), returning 500 to the gateway, which retries the same oversized batch forever — livelock.

**Impact:** DoS / livelock vector if any caller ever sends an oversized batch. The http cap is the only defense and it lives in the wrong layer.

**Fix:**
```ts
const MAX_BATCH = 500;
if (args.events.length > MAX_BATCH) {
  throw new Error(`recordUsage batch exceeds ${MAX_BATCH} events`);
}
```

---

### [SEV: P1] `recordUsage` doesn't validate `event.at` is a plausible epoch; negative/zero accepted as index key
**Location:** `convex/wallets.ts:367` (only `!Number.isFinite`), `convex/wallets.ts:423` (stored as `at`).

**Problem:** `at` is only checked for finiteness. A gateway bug or malicious payload with `at: -1` or `at: 0` is accepted, stored, and indexed under `by_org_at` / `by_at`. Downstream time-range queries (`billing.cycleBreakdown` for "current UTC month" via `gte(cycleStart)`, `usage.listForOrg` with `since`/`until`) include or exclude these rows incorrectly; `order("desc")` puts bogus `at` values at the bottom, dropping them from paginated "recent" views. Distinct from the integer-ness gap above: even safe-integer `at: 0` corrupts the time windows.

**Impact:** Corrupted billing/usage time windows; silent missing-or-extra rows in analytics.

**Fix:** Require `event.at > 0` and `event.at <= Date.now() + smallSkew` (allow ~60s clock skew).

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

**Problem:** An admin can credit or debit any org's wallet by any non-zero safe-integer amount. The only record is a `walletEntries` row with `kind: "admin_adjustment"` and an admin-supplied `refId`. There is no `adminUserId`, no `reason`, no link to an admin-action audit table. For a credit ledger that is the system of record for prepaid customer credits and publisher payouts, this is a material audit gap: any admin can create or destroy arbitrary credit with no accountable trace beyond a free-text refId they choose themselves. Combined with finding #1 (no overflow guard) and #2 (no cross-wallet scope check), the admin path is the single most dangerous ledger write and it is the least guarded.

**Impact:** SOX/audit/compliance gap; no accountability for the most privileged ledger write.

**Fix:** Add `adminUserId: v.string()` and `reason: v.string()` to the args, persist them on the `walletEntries` row (new optional fields) or a dedicated `adminActions` table, and require a `requireAdmin`-style identity check at the calling action layer (the mutation is internal, so the action that invokes it must pass the verified admin id).

---

### [SEV: P2] `getOrCreateWallet` race is not reachable under serializable isolation, but the invariant is implicit and wallet creation is un-centralized
**Location:** `convex/wallets.ts:29-47`; duplicated in `convex/organizations.ts:11-27`.

**Problem (verification of prior P0):** The prior review claimed OCC does not save the read-then-insert — that the two transactions share no overlapping document and the inserts target different ids, so there is no write-write conflict. This reasoning applies to row-level-locking (Read Committed) databases, **not to Convex**. Convex mutations execute under **serializable isolation** with OCC that tracks index-range reads (phantom protection). The `by_organization` `eq(orgId)` range scan — including the empty result — is part of the read set; a concurrent insert into that range invalidates it and forces a retry, after which the retry observes the first transaction's wallet. The Convex "unique documents" recipe explicitly endorses read-then-insert within one mutation for this reason.

So the duplicate-wallet race as described is **not reachable** via concurrent mutations (`grantPaymentCredits`, `recordUsage`, `applyAdminAdjustment`, `ensureWallet` are all `internalMutation`/`mutation` and therefore serializable). The "permanently bricks the ledger" consequence *would* be true if a duplicate ever arose (every subsequent `.unique()` throws `NonUniqueResponseError`), but the race cannot produce one.

What *is* a real concern: (a) wallet creation is scattered across `wallets.getOrCreateWallet` (every ledger mutation) and `organizations.ensureWallet` (org-creation path) — two independent copies that can drift; (b) the one-wallet-per-org invariant is enforced only implicitly via OCC, not by schema or a single creation chokepoint; (c) if a future migration, schema reset, or Convex OCC edge case ever produces a duplicate, the blast radius is catastrophic and unrecoverable without manual DB surgery.

**Impact:** Defense-in-depth gap; reliance on implementation-level OCC semantics rather than an explicit invariant. The duplicated `ensureWallet` in `organizations.ts` is drift risk.

**Fix:** Delete `wallets.getOrCreateWallet`; switch all mutation call sites (`grantPaymentCredits`, `reversePaymentCredits`, `applyAdminAdjustment`, `recordUsage`, `ensureWallet`) to `getWalletForOrg` + throw-on-missing, relying on `upsertFromClerk` as the sole wallet creator. This makes the invariant explicit and removes the second copy.

---

### [SEV: P2] `publisherEarningSplit` multiplication overflows safe-integer range for large gross credits
**Location:** `convex/accounting.ts:17-21` (called from `convex/wallets.ts:435`).

```ts
export function publisherEarningSplit(grossCredits) {
  if (!Number.isSafeInteger(grossCredits) || grossCredits < 0) throw ...;
  const platformFeeCredits = Math.floor(
    (grossCredits * PLATFORM_FEE_BASIS_POINTS) / BASIS_POINTS_DENOMINATOR,
  );
  return { grossCredits, platformFeeCredits, publisherNetCredits: grossCredits - platformFeeCredits };
}
```

**Problem:** The guard checks the *input* is a safe integer, but `grossCredits * PLATFORM_FEE_BASIS_POINTS` (= `grossCredits * 500`) overflows `Number.MAX_SAFE_INTEGER` (≈9.007×10^15) once `grossCredits > ~1.8×10^13`. At `grossCredits = 9_007_199_254_740_991` (MAX_SAFE_INTEGER), the product is ~4.5×10^18 — well past 2^53. `Math.floor` of a float that has lost precision yields a `platformFeeCredits` that no longer satisfies the documented invariant `gross = fee + net` exactly (the rounding is no longer floor-of-the-true-product). `recordUsage` passes `event.credits` (gateway-supplied, validated safe-integer ≥ 0) straight through. The precondition is an org wallet holding ≥ `grossCredits` balance — reachable via `applyAdminAdjustment` granting MAX_SAFE_INTEGER credits (no payment required), then a `recordUsage` event with matching `credits`. The split is then persisted to `publisherEarnings` with broken arithmetic, and the platform-fee/net numbers diverge from gross.

**Impact:** Ledger-invariant break (`gross ≠ fee + net`) for publisher earnings under large-credit scenarios; corrupts payout accounting. Reachable via admin adjustment + settlement.

**Fix:** Compute in a lossless domain. Either: (a) cap `grossCredits` to a safe bound (`grossCredits * 500 < 2^53` ⇒ `grossCredits ≤ 18_014_398_509_481`) and throw otherwise, or (b) compute `platformFeeCredits` via integer division: `Math.floor(grossCredits / 20)` (since 500/10000 = 1/20 exactly) which avoids the overflow entirely, then `net = gross - fee`.

---

### [SEV: P2] `grantPaymentCredits` does not cross-verify `paymentId` belongs to `organizationId` or that `amount === payment.grantedCredits`
**Location:** `convex/wallets.ts:128-160`.

**Problem:** `grantPaymentCredits` accepts `organizationId`, `paymentId`, `amount`, `refId` and grants `amount` credits against `organizationId`'s wallet, stamping `paymentId` on the entry. It never reads the `payments` table to verify (a) the payment exists, (b) `payment.organizationId === args.organizationId`, or (c) `args.amount === payment.grantedCredits - payment.reversedCredits`. The current caller (`billing.fulfillStripeSession`) sources `amount` from `upsertPaidPayment`'s return (`intent.credits`, server-owned) and `paymentId` from the same return, so the live path is correct — but the ledger primitive itself trusts the caller entirely. A future internal action (or a refactor that decouples the grant from the `upsertPaidPayment` return) could grant arbitrary credits with a fabricated or mismatched `paymentId`, and the ledger would accept it. The `refId` dedup prevents re-granting but not a wrong first grant.

**Impact:** Defense-in-depth gap at the ledger primitive; the grant's correctness depends entirely on the caller, not on the ledger verifying its own inputs against the payment record.

**Fix:** In `grantPaymentCredits`, read the `payments` row and assert `payment.organizationId === args.organizationId` and `args.amount === payment.grantedCredits` (and `payment.reversedCredits === 0` for a first grant). Throw otherwise.

---

### [SEV: P2] `reversePaymentCredits` does not cap reversal against `payment.grantedCredits − payment.reversedCredits`
**Location:** `convex/wallets.ts:163-192`.

**Problem:** `reversePaymentCredits` accepts any positive safe-integer `amount` and applies `-amount` to the wallet, explicitly "permitted to create debt." It never reads the `payments` row to verify `amount ≤ payment.grantedCredits − payment.reversedCredits`. The current caller (`billing.processStripeEvent`) sources `amount` from `cumulativeRefundCredits` / `applyDispute`, both of which cap to the remaining granted credits, so the live path is correct — but the primitive itself allows a caller bug to over-reverse, creating unbounded debt (a `−9_007_199_254_740_991` reversal on a 100-credit payment succeeds at the primitive level). Combined with finding #1 (no balance overflow guard), an over-reversal can push `balance` past `−2^53`.

**Impact:** Defense-in-depth gap; over-reversal creates unbounded, un-audited debt if any caller ever miscalculates.

**Fix:** In `reversePaymentCredits`, read the `payments` row, assert `args.paymentId` belongs to `args.organizationId`, and assert `args.amount ≤ payment.grantedCredits − payment.reversedCredits`. Throw otherwise.

---

### [SEV: P2] `recordUsage` allows self-dealing — consumer org == publisher org pays credits and earns 95% back
**Location:** `convex/wallets.ts:396-455`.

```ts
const project = await ctx.db.get(event.projectId);
if (project === null) { reject; continue; }
...
await ctx.db.insert("publisherEarnings", {
  publisherOrganizationId: project.organizationId,   // ← could equal consumerOrg._id
  ...
});
```

**Problem:** `recordUsage` debits `consumerOrg._id`'s wallet and credits `project.organizationId`'s publisher earnings with no check that `project.organizationId !== consumerOrg._id`. If a consumer org publishes a project and calls its own API, it pays N credits and immediately earns 95% of N back as a publisher (after the 7-day risk hold). This is a self-dealing / circular-credit vector: an org can manufacture publisher earnings (and eventual Stripe transfers) from its own prepaid balance, laundering credit-grant real money into publisher-payout real money at a 5% loss. There is no business rule or guard preventing it.

**Impact:** Self-dealing revenue leak; an org can convert consumer credits into publisher payouts for its own endpoints.

**Fix:** Reject the settlement when `project.organizationId === consumerOrg._id` (`status: "rejected"`, `reason: "self-dealing settlement"`), or apply a platform-fee-only settlement (consumer pays, no publisher earning created).

---

### [SEV: P2] `recordUsage` creates zero-amount `publisherEarning` rows and zero-amount `walletEntry` for `credits === 0` settlements
**Location:** `convex/wallets.ts:426-456`.

```ts
const split = publisherEarningSplit(event.credits);  // credits may be 0
...
if (existingEarning === null) {
  await ctx.db.insert("publisherEarnings", { ...grossCredits: 0, platformFeeCredits: 0, netCredits: 0, status: "pending_risk", ... });
}
results.push({ refId: event.settleRefId, status: "applied" });
```

**Problem:** `credits === 0` passes the `event.credits < 0` guard (line 366). `publisherEarningSplit(0)` returns all-zero amounts. A `publisherEarnings` row with all-zero amounts and `status: "pending_risk"` is inserted, with `availableAt = now + 7d`, transitioning through the full earning lifecycle (`pending_risk` → `available` → `allocated_to_transfer` → `transferred`) for zero value, polluting the `by_status_available` and `by_publisher` indexes and any payout/aggregation query. The same settlement also inserts a zero-amount `walletEntries` row (`amount: 0`) and bumps `sequence` — inflating the edge DO's checkpoint sequence with a non-mutating entry.

**Impact:** Ledger/earnings pollution; inflated sequence; wasted storage and index scans; zero-value rows flow through payout logic.

**Fix:** Short-circuit free-tier (`credits === 0`) events before the ledger path: record the `usageEvents` row for analytics (or skip it) but do not insert a `walletEntry` or `publisherEarning`, and return `status: "applied"` without touching `sequence`.

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

**Problem:** The `by_wallet` index is `["walletId"]` only — no `sequence` or `createdAt`. `.order("desc")` falls back to `_creationTime` (Convex's implicit ordering). The `WalletEntryView` exposes `sequence`, implying sequence-order, but the 50-row window is creation-time-ordered. Under OCC retry (a retried transaction re-inserts with a later `_creationTime` but an earlier `sequence` than a concurrently-committed sibling) or any future backfill, the `.take(50)` window drops the wrong rows — showing entries 51–100-by-sequence while hiding 1–50, or vice versa.

**Impact:** Incorrect "recent entries" view under concurrency/retry; misleading ledger display.

**Fix:** Add `sequence` to the index: `.index("by_wallet", ["walletId", "sequence"])` and order by it, or sort the taken page in-memory by `sequence` desc before returning.

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

**Problem:** When `organization === null` (org deleted, never created, or stale `clerkOrgId`), the wallet checkpoint is synthesized as `{balance:0, sequence:0}` — reasonable — but `keySettings` is still queried and returned. If `keySettings` rows persist after org deletion (no cascade delete in `organizations.deleteFromClerk` — it deletes the wallet and entries but **not** keySettings), the edge DO receives active key gates (monthly caps, `disabled` flags, rotation grace) for a non-existent org. The edge will honor them, potentially allowing or blocking keys for an org that no longer exists. Verified: `organizations.deleteFromClerk` (lines 84-114) deletes wallet + walletEntries but has no `keySettings` cleanup.

**Impact:** Stale/orphaned key settings honored by the edge for deleted/unknown orgs; authz surprise if a `clerkOrgId` is ever reused.

**Fix:** When `organization === null`, return `keySettings: []`. Add `keySettings` cleanup to `deleteFromClerk`. Consider a `404`-style sentinel instead of a synthesized zero-balance checkpoint so the edge knows the org is unknown rather than fresh.

---

### [SEV: P2] `appendWalletEntry` is the ledger primitive but performs no validation of `amount`, sign-by-`kind`, or resulting balance
**Location:** `convex/wallets.ts:86-125`.

**Problem:** `appendWalletEntry` is the single chokepoint through which every balance mutation flows, yet it trusts `args.amount` entirely. `recordUsage` validates `event.credits` then passes `-event.credits` (re-derivation, no re-check at the primitive). `applyAdminAdjustment` allows any non-zero safe integer. There is no bound on the magnitude of a single entry, no sign check against `kind` (e.g. `usage_settlement` should be ≤ 0, `payment_grant` should be > 0, `refund_reversal`/`dispute_reversal` should be < 0, `admin_adjustment` any sign), and no post-compute safe-integer check on `balance` (finding #1). Defense-in-depth is absent at the one function that writes the ledger. A caller bug or compromised internal action can write an arbitrary-magnitude, wrong-signed entry and the primitive offers no last-line guard.

**Impact:** Ledger primitive offers no invariants of its own; all guards are caller-side and thus bypassable by any future caller.

**Fix:** In `appendWalletEntry`: validate `Number.isSafeInteger(args.amount)`; enforce sign-by-`kind` (`payment_grant > 0`, `usage_settlement ≤ 0`, `refund_reversal`/`dispute_reversal < 0`); check resulting `balance`/`sequence` are safe integers.

---

### [SEV: P2] `recordUsage` doesn't validate that `event.projectId` is a published project owned by a legitimate publisher
**Location:** `convex/wallets.ts:396-404, 444-455`.

```ts
const project = await ctx.db.get(event.projectId);
if (project === null) { reject; continue; }
...
await ctx.db.insert("publisherEarnings", { publisherOrganizationId: project.organizationId, projectId: project._id, ... });
```

**Problem:** `event.projectId` is client-supplied (gateway). The only check is existence. No validation that `project.status === "published"`, that the project is live, or that the consumer is authorized to have called it. A compromised gateway (leaked `GATEWAY_INTERNAL_SECRET`) or a gateway bug can attribute a settlement to any project id, crediting that project's org with publisher earnings for calls never made to that project. The internal-secret boundary is the only defense; for publisher money movement, that is too thin.

**Impact:** Mis-attributed publisher earnings; a single leaked gateway secret enables arbitrary publisher crediting.

**Fix:** Validate `project.status === "published"` and reject draft/private projects before creating the earning.

---

### [SEV: P2] `getGatewayWallet` `.collect()` on `keySettings` is unbounded and unfiltered
**Location:** `convex/wallets.ts:241-244`.

```ts
const settings = await ctx.db
  .query("keySettings")
  .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
  .collect();
```

**Problem:** No `.take(N)` and no filter on `disabled` or expired `graceUntil`. An org that has rotated many keys returns every historical `keySettings` row on every checkpoint poll (`/wallet-grants` GET, called by the edge DO on its sync cadence). For a long-lived org this is unbounded growth in payload size and query cost per poll. Combined with finding #12 (orphaned settings not cleaned on org deletion), the row count only grows.

**Impact:** Unbounded read/payload on a hot edge-sync path; degrades over the org's lifetime.

**Fix:** Filter to active keys (`disabled === false` and (`graceUntil` unset or `graceUntil > Date.now()`)) and/or `.take(N)` with a sane cap.

---

### [SEV: P2] `appendWalletEntry`'s `.unique()` on `by_ref` throws `NonUniqueResponseError` if a duplicate `refId` ever exists
**Location:** `convex/wallets.ts:97-100`; schema has no DB-level unique constraint on `walletEntries.refId` (`convex/schema.ts:67-77`).

**Problem:** The schema documents `refId` as "Globally unique business id" but enforces nothing at the DB level — uniqueness is asserted only by `.unique()` at read time, which *throws* if >1 row matches. If a duplicate `refId` ever arises (via a Convex OCC edge case, a future code path that doesn't go through `appendWalletEntry`, a manual backfill, or the `existingEarning`/`walletEntry` two-table idempotency split ever desyncing), then every subsequent `appendWalletEntry` call — and thus every `grantPaymentCredits`, `reversePaymentCredits`, `applyAdminAdjustment`, and `recordUsage` — throws `NonUniqueResponseError` for that `refId`. The ledger primitive has no graceful degradation for the one invariant it most relies on.

**Impact:** Latent fragility; a single duplicate `refId` bricks the grant/reverse/admin/settlement path for that refId until manual DB surgery.

**Fix:** Use `.take(2)` + explicit duplicate detection that returns a deterministic `applied: false` (using the first row) instead of `.unique()` which throws. Or add a unique index if Convex supports it for this table shape.

---

### [SEV: P2] `recordUsage` is all-or-nothing when the consumer org is deleted — gateway livelocks with no dead-letter
**Location:** `convex/wallets.ts:356-358`.

```ts
const consumerOrg = await getOrganizationByClerkId(ctx, clerkOrgId);
if (consumerOrg === null) throw new Error("Consumer organization not found");
```

**Problem:** If the consumer org is deleted between gateway authorization and settlement (e.g. the org deleted their account while in-flight usage events were queued), `getOrganizationByClerkId` returns null and the entire batch throws. The http layer returns 500 (`"ingest failed"`), and the gateway retries the same batch indefinitely — the events can never be settled (no permanent-reject / dead-letter path). The batch is also all-or-nothing: a single event whose `consumerClerkOrgId` resolves to a deleted org poisons every other event in the batch (though the top-of-handler check requires all events share one `consumerClerkOrgId`, so they're all the same org — but the point stands: no durable rejection).

**Impact:** Gateway livelock on a deleted-consumer batch; served usage is never settled or durably rejected.

**Fix:** Return a structured `{ results: [...rejected...], permanent: true }` for a null consumer org instead of throwing, so the gateway can drop the batch. Or add a dead-letter table.

---

### [SEV: P2] `recordUsage` rejects insufficient-balance events after the gateway already served the request — revenue leak
**Location:** `convex/wallets.ts:405-410`.

```ts
if (wallet.balance - event.credits < 0) {
  results.push({ refId: event.settleRefId, status: "rejected", reason: "insufficient authoritative balance" });
  continue;
}
```

**Problem:** The gateway's Wallet DO authorizes a call based on its cached checkpoint (balance was sufficient at sync time), serves the API response, then asynchronously settles. If a concurrent settlement drained the authoritative balance below `event.credits` between the gateway's authorization and Convex's settlement, `recordUsage` rejects the event — but the consumer already received the service. The rejected event is not recorded in `usageEvents`, no `walletEntry` is created, and the gateway is told to retain it as rejected. The consumer got free service. This is inherent to the checkpoint-authorize-then-reconcile architecture, but there is no compensating mechanism (e.g. allow the balance to go slightly negative for in-flight authorized usage, or track an "authorized but unsettled" reservation).

**Impact:** Served-but-unbilled usage under concurrent balance drain; revenue leak proportional to race frequency.

**Fix:** Either (a) allow `recordUsage` to apply the entry and create debt (negative balance) for events the gateway authorized (requires the gateway to pass an authorization token proving it checked), or (b) accept the leak and document it, or (c) introduce a reservation/hold step that decouples authorization from settlement.

---

### [SEV: P3] `recordUsage` ignores `settled.applied` and always reports `"applied"` — defensive fragility
**Location:** `convex/wallets.ts:426-457`.

```ts
const settled = await appendWalletEntry(ctx, { wallet, kind: "usage_settlement", amount: -event.credits, refId: event.settleRefId, usageEventId });
wallet = settled.wallet;
...
results.push({ refId: event.settleRefId, status: "applied" });  // ← unconditional
```

**Problem:** Within `recordUsage`, `appendWalletEntry` is only reached after the outer `by_ref` dedup (lines 379-394) returns `existing === null`. The outer and inner reads share one transaction snapshot, so the inner dedup is guaranteed `null` too — `settled.applied` is always `true` here, so `status: "applied"` is currently correct. However, the code relies on an invariant that is not expressed locally: if the outer dedup is ever refactored away or the primitive's snapshot semantics change, this silently misreports `"applied"` for a no-op, violating the `SettlementResult` contract (`"applied" | "already_applied"`).

**Impact:** No live bug; defensive fragility. The `applied` flag exists specifically to be checked.

**Fix:** `results.push({ refId: event.settleRefId, status: settled.applied ? "applied" : "already_applied" });`

---

### [SEV: P3] `getOrCreateWallet` does a redundant `ctx.db.get(walletId)` after insert
**Location:** `convex/wallets.ts:44-45`.

```ts
const walletId = await ctx.db.insert("wallets", { organizationId, balance: 0, sequence: 0 });
const wallet = await ctx.db.get(walletId);
if (wallet === null) throw new Error("Failed to create wallet");
return wallet;
```

**Problem:** The inserted document's content is fully known (`{organizationId, balance: 0, sequence: 0}` + `_id` + `_creationTime`). The extra `ctx.db.get` is a wasted read. Return the constructed object directly.

**Impact:** Minor wasted read per wallet creation.

---

### [SEV: P3] `recordUsage` doesn't validate `event.endpoint`, `event.method`, `event.keyId` are non-empty
**Location:** `convex/wallets.ts:417-422` (stored raw from validator `v.string()`).

**Problem:** Empty strings pass `v.string()` and are stored, then surfaced in usage UI and billing breakdowns. A malformed gateway payload with `endpoint: ""` produces blank rows.

**Impact:** Minor data-quality; cosmetic in UI.

---

### [SEV: P3] `recordUsage` doesn't validate `event.status` is a real HTTP status (1xx–5xx)
**Location:** `convex/wallets.ts:420`. Any finite number is accepted (see finding on integer gap); even with the integer fix, `7` or `9999` would be accepted.

**Impact:** Minor; downstream status-bucketing may mis-handle out-of-range codes.

---

### [SEV: P3] `appendWalletEntry` `createdAt: Date.now()` is identical across a `recordUsage` batch — useless for intra-batch ordering
**Location:** `convex/wallets.ts:117`. Within one `recordUsage` transaction, all entries get near-identical `createdAt` values, so `sequence` is the only reliable intra-batch order. Combined with the `by_wallet` index lacking `sequence`, intra-batch ordering in `walletView` falls back to `_creationTime` = insertion order, which is correct here but fragile.

**Impact:** Minor; `sequence` is the canonical order, `createdAt` is not.

---

### [SEV: P3] Error messages leak internal structure to internal callers
**Location:** `convex/wallets.ts:103` ("Wallet missing for existing entry"), `146` ("Organization not found"), `358` ("Consumer organization not found"), `344` ("At least one settlement is required").

**Problem:** These are `internalMutation`s whose thrown messages propagate to the calling action. The http layer masks them (`{error: "ingest failed"}` / `"wallet checkpoint failed"`), but direct internal callers (tests, future actions) see the raw messages. Inconsistent with the "never leak internal errors" product rule.

**Impact:** Minor; defense-in-depth.

---

### [SEV: P3] `recordUsage` does a per-event `ctx.db.get(event.projectId)` with no cache — N reads in a batch
**Location:** `convex/wallets.ts:396`.

**Problem:** `usage.listForOrg` already demonstrates a `projectCache` pattern for this exact lookup. `recordUsage` re-fetches the project doc for every event in the batch. For a 500-event batch with repeated projects (common — one consumer hitting one publisher endpoint), this is up to 500 reads instead of ≤ N unique projects. `getOrCreateWallet` and the outer `by_ref` dedup are already per-event reads; this adds a third.

**Impact:** Minor wasted read capacity per batch; scales with batch size × project cardinality.

**Fix:** Hoist a `Map<Id<"projects">, Doc<"projects"> | null>` cache, mirroring `usage.listForOrg`'s `resolveProject`.

---

## Summary

| Severity | Count |
|---|---|
| P0 | 0 |
| P1 | 7 |
| P2 | 15 |
| P3 | 7 |
| **Total** | **29** |

**Verification deltas vs prior review:**
- **P0-1 (duplicate-wallet race) → DOWNGRADE to P2.** Not reachable under Convex's documented serializable isolation; OCC tracks the empty `by_organization` index range (phantom protection), so concurrent inserts conflict and retry into the first's wallet. The prior review's "no write-write conflict" argument applies to Read Committed row-locking databases, not to Convex. The brick-*if*-duplicate consequence is real, but the race cannot produce the duplicate via mutations.
- **P1-3 (ignores `settled.applied`) → DOWNGRADE to P3.** Within `recordUsage`, the outer `by_ref` dedup guarantees the inner dedup sees `null` on the same snapshot, so `applied` is always `true`; defensive-only.

**Top 3 to fix first:**
1. **P1 — Cross-wallet `refId`-collision leak in `appendWalletEntry` (#2).** One-line guard (`existing.walletId !== args.wallet._id` → throw) closes a cross-org balance/sequence disclosure at the ledger primitive, affecting grant/reverse/admin paths.
2. **P1 — Materialized `balance`/`sequence` overflow (#1) + `publisherEarningSplit` multiplication overflow (P2 #9).** The arithmetic-perimeter cluster: the primitive never checks the output is a safe integer, and the only caller of `publisherEarningSplit` passes gateway credits straight through. Both fixable with guards in the primitive and a lossless fee computation (`Math.floor(grossCredits / 20)`).
3. **P1 — `applyAdminAdjustment` has no audit trail, no bound, no scope check (#7 + #2 + #1).** The most privileged ledger write is the least guarded: arbitrary magnitude, admin-chosen refId, no admin identity or reason persisted. Pair the audit fields with the overflow guard and the cross-wallet scope check to harden the admin path end-to-end.
