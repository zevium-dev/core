# Tiger Deep-Dive Review: `convex/payouts.ts`

## Verdict

**INCORRECT — do not merge.** Money-out surface with multiple integrity
defects that produce reconciliation drift, silent money loss, and — for any
real-volume publisher — a structurally broken payout pipeline. The
idempotency-key design prevents a naive double-payout of the *same* transfer,
but the surrounding state machine has holes wider than the prior review
identified. Most critically: the Stripe idempotency key is built by joining
*every* earning id into the key string, which exceeds Stripe's 255-character
limit at ~9 earnings, so **every non-trivial payout fails at Stripe before it
ever moves money**, and the failure is recorded as a transfer-level
`failed` with earnings stranded. On top of that, status transitions are
unguarded against out-of-order/duplicate webhooks, refunds/disputes never
reverse publisher earnings, totals are capped at 100 rows, sub-cent
residuals are destroyed, and there is no cron to mature earnings.

All 17 prior findings were verified against current source. Six additional
defects are documented below (marked **NEW**).

---

## File Stats

- **Path:** `convex/payouts.ts`
- **LOC:** 754
- **Role:** Stripe Connect publisher payouts — onboarding (`startOnboarding`,
  `createOnboardingLink`, `getConnectProfileForActiveOrg`,
  `setConnectedAccount`, `refreshConnectedAccount`, `connectAccountProjection`,
  `projectConnectedAccount`), earnings maturation (`releaseMatureEarnings`),
  transfer preparation/execution (`preparePublisherTransfer`,
  `getPublisherTransfer`, `markPublisherTransferSucceeded`,
  `markPublisherTransferFailed`, `projectStripeTransfer`, `transferToStripe`,
  `initiatePublisherTransfer`), payout mirroring (`projectConnectedPayout`),
  and the publisher-facing state query (`getPayoutState`).
- **Schema tables touched:** `organizations`, `organizationPayments`,
  `publisherEarnings`, `publisherTransfers`, `connectedPayouts`,
  `notifications`.
- **Consumers:** `convex/billing.ts:835` (`refreshConnectedAccount`),
  `convex/billing.ts:845` (`projectStripeTransfer`), `convex/billing.ts:868`
  (`projectConnectedPayout`), `convex/admin.ts:355-378` (`retryPublisherTransfer`
  → `getPublisherTransfer`/`markPublisherTransferSucceeded`/`markPublisherTransferFailed`),
  `convex/admin.ts:233-311` (`listPublisherTransfers`), web routes
  `app/earnings.tsx` (`getPayoutState`, `startOnboarding`,
  `initiatePublisherTransfer`), `admin/payouts.tsx` (`retryPublisherTransfer`).
- **Tests:** `convex/stripe-connect.test.ts` (6 tests). Coverage: onboarding
  link creation, capability projection, idempotent allocation dedupe,
  projection of succeeded/reversed/payout. **No coverage** of: out-of-order
  webhooks, stranded-earnings, refund-reversal, idempotency-key length,
  sub-cent residual, scale, or the `take(20)`/`take(100)` windows.
- **Auth model:** public `action`s (`startOnboarding`,
  `initiatePublisherTransfer`) and the public `query` `getPayoutState`
  authenticate via Clerk JWT active-org claim (`activeClerkOrgId` /
  `requireIdentity`). All `mark*`/`prepare*`/`project*`/`release*` functions
  are `internalMutation`/`internalAction` — no auth, callable only from
  Convex actions. `admin.retryPublisherTransfer` adds a separate
  `requireAdminInAction` gate (`ADMIN_USER_IDS` env).

---

## Findings

### [SEV: P1] **NEW** Stripe idempotency key exceeds the 255-character limit for any transfer covering ~9+ earnings — payouts structurally fail for real publishers

**Location:** `convex/payouts.ts:367-371`

```ts
const idempotencyKey = `publisher-transfer:${args.publisherOrganizationId}:${earnings
  .map((earning) => earning._id)
  .sort()
  .join(",")}`;
```

**Problem:** The idempotency key is the literal concatenation of every
earning id selected into the transfer, prefixed by
`publisher-transfer:<orgId>:`. Stripe's `Idempotency-Key` header is
documented to be **at most 255 characters**; longer keys are rejected with
`Invalid string: …; must be at most 255 characters`. Convex document ids
(table-qualified base32) are ~22 characters, so the key crosses 255 chars at
roughly 9 earnings:

| earnings | approx key length |
|---------:|------------------:|
| 1        | ~70 |
| 5        | ~165 |
| 8        | ~235 |
| 9        | ~258 ← rejected |
| 50       | ~1,200 |

A publisher whose 7-day risk hold releases 10 matured earnings in one batch
(the common case for any active marketplace publisher) produces a key Stripe
refuses. `stripeClient().transfers.create(..., { idempotencyKey })` throws,
`transferToStripe` catches, calls `markPublisherTransferFailed`, and rethrows.
The transfer and all its earnings land at `failed` (see the stranded-earnings
finding — there is no `failed → available` recovery path). The publisher can
never withdraw, because every subsequent `preparePublisherTransfer` returns
the same `failed` transfer via the `priorTransfers` retry short-circuit, and
even if it didn't, re-selecting the same earning set reproduces the same
over-long key.

**Impact:** The entire money-out pipeline is broken for any publisher with
more than a handful of matured earnings per withdrawal. The defect fails
safely (no money leaves) but permanently strands earnings. This is the most
severe functional defect in the file — arguably a P0 blocker on the payout
product, rated P1 only because no funds are lost.

**Fix:** Do not embed the earning set into the idempotency key. Derive the
key from a stable per-transfer source: either the Convex `publisherTransfers._id`
(assigned after insert) or a server-generated UUID stored on the transfer
row. The earning→transfer linkage is already durable via
`publisherEarnings.transferId`; the idempotency key only needs to identify
the *transfer attempt*, not its contents:
```tsuggestion
const transferId = await ctx.db.insert("publisherTransfers", {
  …,
  idempotencyKey: `publisher-transfer:${transferId}`,  // or a generated uuid
  …
});
```
(Insert first to obtain `_id`, then patch the idempotency key, or use a
`crypto.randomUUID()`.)

---

### [SEV: P1] `projectStripeTransfer` allows illegal status transitions on out-of-order / duplicate webhooks (`reversed → succeeded`)

**Location:** `convex/payouts.ts:493-533`

```ts
handler: async (ctx, args): Promise<void> => {
  const transfer = await ctx.db
    .query("publisherTransfers")
    .withIndex("by_stripe_transfer", (q) =>
      q.eq("stripeTransferId", args.stripeTransferId),
    )
    .unique();
  if (transfer === null) return;
  const now = Date.now();
  await ctx.db.patch(transfer._id, {
    status: args.state,
    failureReason: args.failureReason,
    updatedAt: now,
  });
  …
  const earningStatus =
    args.state === "succeeded" ? "transferred" : args.state;
  for (const earning of earnings) {
    await ctx.db.patch(earning._id, { status: earningStatus, updatedAt: now });
  }
},
```

**Problem:** Stripe delivers webhooks at-least-once with no ordering
guarantee. `projectStripeTransfer` unconditionally overwrites both the
transfer `status` and every allocated earning's `status` with the incoming
`state`, with no check on the current status. The billing dispatcher
(`convex/billing.ts:843-855`) maps `transfer.created` / `transfer.updated`
→ `"succeeded"`, `transfer.failed` → `"failed"`, `transfer.reversed` →
`"reversed"`. If a `transfer.reversed` event is followed by a duplicate or
delayed `transfer.created`/`transfer.updated` event (normal Stripe
behaviour — `transfer.created` is sent on creation and may be redelivered),
the transfer and its earnings flip `reversed → succeeded` /
`reversed → transferred`. Stripe clawed the money back from the publisher's
connected account, but the DB now records the publisher as paid.

**Impact:** Ledger irreconcilable with Stripe. `getPayoutState` and the
admin `listPublisherTransfers` view both lie about the money.
`duplicate-transfer.created` is a routine Stripe redelivery, so this is
reachable in production, not a theoretical race.

**Fix:** Make transitions forward-only and terminal states sticky:
```tsuggestion
const TERMINAL = new Set(["reversed", "succeeded"]);
if (transfer.status !== undefined && TERMINAL.has(transfer.status)) return;
const RANK = { created: 0, pending: 1, failed: 1, succeeded: 2, reversed: 3 };
if (RANK[transfer.status] > RANK[args.state]) return;
```

---

### [SEV: P1] `markPublisherTransferSucceeded` has no status guard — can resurrect `reversed` / `failed` transfers

**Location:** `convex/payouts.ts:426-456`

```ts
handler: async (ctx, args): Promise<void> => {
  const transfer = await ctx.db.get(args.transferId);
  if (transfer === null) throw new Error("Publisher transfer not found");
  const now = Date.now();
  await ctx.db.patch(transfer._id, {
    stripeTransferId: args.stripeTransferId,
    status: "succeeded",
    failureReason: undefined,
    attemptedAt: now,
    updatedAt: now,
  });
  // … patches ALL earnings with transferId === transfer._id to "transferred"
},
```

**Problem:** No check on `transfer.status` before patching to `succeeded`.
Called from `transferToStripe` (`payouts.ts:595`) after a Stripe
`transfers.create` success, and from `admin.retryPublisherTransfer`
(`admin.ts:363`). If a transfer was already `reversed` (Stripe clawed the
money back) and then an admin retry or a concurrent `initiatePublisherTransfer`
succeeds at Stripe with the same idempotency key (Stripe returns the original
transfer object on key reuse), this mutation flips the transfer and all its
earnings back to `succeeded`/`transferred`, erasing the reversal. The
`admin.retryPublisherTransfer` guard (`if (status === "succeeded" || "reversed") return;`)
runs in a *separate* mutation read (`getPublisherTransfer`) before the Stripe
call — a `transfer.reversed` webhook landing between the read and the
`markPublisherTransferSucceeded` write defeats it.

**Impact:** Same reconciliation-drift class as the previous finding via a
different path. Compounds with the missing guard in `projectStripeTransfer`.

**Fix:**
```suggestion
if (transfer.status === "reversed") {
  throw new Error("Cannot mark a reversed transfer as succeeded");
}
if (transfer.status === "succeeded" &&
    transfer.stripeTransferId === args.stripeTransferId) return;
```

---

### [SEV: P1] `preparePublisherTransfer` retry short-circuit strands new earnings behind any unresolved failed/created/pending transfer

**Location:** `convex/payouts.ts:335-347`

```ts
const priorTransfers = await ctx.db
  .query("publisherTransfers")
  .withIndex("by_publisher", (q) =>
    q.eq("publisherOrganizationId", args.publisherOrganizationId),
  )
  .order("desc")
  .take(20);
const retry = priorTransfers.find(
  (transfer) =>
    transfer.status === "created" ||
    transfer.status === "pending" ||
    transfer.status === "failed",
);
if (retry !== undefined) {
  return {
    transferId: retry._id,
    connectedAccountId: retry.stripeConnectedAccountId,
    amount: retry.amount,
    currency: retry.currency,
    idempotencyKey: retry.idempotencyKey,
  };
}
```

**Problem:** If any of the publisher's 20 most recent transfers is in
`created` / `pending` / `failed` state, the function returns that transfer
immediately and **never scans `available` earnings**. New earnings that
matured after the failed transfer was created sit at `status: "available"`
but can never be selected — the retry short-circuit blocks the new-transfer
creation path. The publisher is stuck: they cannot withdraw new earnings
until the failed transfer is resolved, and `markPublisherTransferFailed`
leaves earnings at `status: "failed"` with no path back to `available`
(next finding). Combined with the idempotency-key-length defect above,
this is the typical steady state for any active publisher: the first
multi-earning withdrawal fails at Stripe, the transfer and its earnings
land at `failed`, and every subsequent "Withdraw" click returns the same
dead transfer.

**Impact:** A publisher whose transfer fails once (Stripe error, connected
account restriction, network blip, or the 255-char key bug) is permanently
blocked from withdrawing subsequent earnings until manual operator
intervention. The admin `retryPublisherTransfer` only retries the specific
failed transfer — it does not unblock new earnings.

**Fix:** Exclude `failed` from the short-circuit (a failed transfer's
Stripe money never moved, so its earnings should be released back to
`available` for re-selection by a fresh transfer):
```suggestion
const retry = priorTransfers.find(
  (transfer) =>
    transfer.status === "created" || transfer.status === "pending",
);
```
and add an explicit recovery transition (see next finding).

---

### [SEV: P1] `markPublisherTransferFailed` sets earnings to `failed` with no recovery path to `available`

**Location:** `convex/payouts.ts:458-491`

```ts
for (const earning of earnings) {
  await ctx.db.patch(earning._id, { status: "failed", updatedAt: now });
}
```

**Problem:** When a transfer fails, all allocated earnings transition
`allocated_to_transfer → failed`. There is **no code path anywhere in the
codebase** that transitions `failed → available` or
`failed → allocated_to_transfer` (grep-confirmed: the only writers of
`publisherEarnings.status` are `recordUsage` insert at `pending_risk`,
`releaseMatureEarnings` `pending_risk → available`, `preparePublisherTransfer`
`available → allocated_to_transfer`, `markPublisherTransferSucceeded`/`Failed`/
`projectStripeTransfer` — none reset `failed` back to `available`). The only
transitions out of `failed` are `markPublisherTransferSucceeded`
(`failed → transferred`, via retry success) and `projectStripeTransfer`
(`failed → reversed/succeeded`, via webhook). If the transfer can never be
retried successfully (connected account permanently closed, Stripe rejects
the idempotent retry forever, or the admin decides not to retry), those
earnings are permanently stranded at `failed`.

**Impact:** Publisher earnings silently trapped in `failed` status forever.
Combined with the previous finding, the publisher is doubly blocked: failed
earnings can't be re-withdrawn, and new earnings can't be withdrawn because
the failed transfer short-circuits `preparePublisherTransfer`.

**Fix:** Either (a) in `markPublisherTransferFailed`, reset earnings to
`available` (clearing `transferId`) since the Stripe money never moved, or
(b) introduce an explicit admin `abandonPublisherTransfer` action that
clears `transferId` and resets earnings to `available`. Option (a) is
simpler and safe — a failed Stripe transfer created no obligation.

---

### [SEV: P1] `getPayoutState` totals only reflect the 100 most recent earnings rows

**Location:** `convex/payouts.ts:658-705`

```ts
const earnings = await ctx.db
  .query("publisherEarnings")
  .withIndex("by_publisher", (q) =>
    q.eq("publisherOrganizationId", organization._id),
  )
  .order("desc")
  .take(100);
// …
for (const earning of earnings) {
  if (earning.status === "pending_risk") totals.pendingRisk += earning.netCredits;
  else if (earning.status === "available") totals.available += earning.netCredits;
  else if (earning.status === "allocated_to_transfer") totals.allocated += earning.netCredits;
  else if (earning.status === "transferred") totals.transferred += earning.netCredits;
  else if (earning.status === "reversed") totals.reversed += earning.netCredits;
  else totals.failed += earning.netCredits;
}
```

**Problem:** The six totals are computed by iterating the 100 most recent
`publisherEarnings` rows for the org. For any publisher with >100
settlement rows, the totals are **understated** — historical `transferred`
earnings beyond the 100-row window are invisible. A publisher who has
withdrawn 50 times (each producing a batch of earnings at `transferred`)
sees their `transferred` total capped at whatever falls in the last 100
rows. The `available` figure (which drives the implied "Withdraw" amount)
may also be wrong if >100 rows are currently `available`.

**Impact:** Publisher-facing earnings/payout UI shows wrong balances on the
money-out surface. Publishers make withdrawal decisions based on these
numbers. Compounds with the `earnings.forOrg` query (`convex/earnings.ts`)
which has its own unbounded `.collect()` defect — the two surfaces disagree.

**Fix:** Compute totals via a separate aggregation query (or maintain a
materialized `publisherEarningsTotals` document updated on each status
transition), rather than deriving from a `take(100)` window. The row list
can stay capped at 100 for display, but totals must be authoritative.

---

### [SEV: P1] Refunds and disputes never reverse `publisherEarnings` — publisher keeps earnings for refunded calls

**Location:** `convex/payouts.ts` (whole file — absence of reversal path);
consumer side `convex/billing.ts:776-836` calls
`internal.wallets.reversePaymentCredits` only.

**Problem:** When a consumer charge is refunded or disputed, `billing.ts`
calls `reversePaymentCredits` which debits the **consumer** wallet only
(`walletEntries` insert, kind `refund_reversal`/`dispute_reversal`). **No
code path ever patches the corresponding `publisherEarnings` row.** Grep
confirms: `publisherEarnings.status: "reversed"` is written only by
`projectStripeTransfer` (Stripe transfer reversal — platform clawing back
from the publisher's *connected account*), never by the refund/dispute flow.
`preparePublisherTransfer` selects `status === "available"` earnings without
checking whether the underlying consumer payment was refunded.

Sequence:
1. Consumer call settles → `publisherEarnings` at `pending_risk` (7-day hold).
2. 7 days pass → `available`.
3. Publisher withdraws → `transferred`. Stripe transfer sent.
4. Day 30: consumer disputes → `reversePaymentCredits` debits consumer
   wallet. `publisherEarnings` stays at `transferred`. Platform is out the
   money; publisher was paid for a refunded call.

Even before withdrawal: a refunded call's earning sits at `available` and
will be selected by the next `preparePublisherTransfer`, paying the publisher
for revenue that was returned to the consumer.

**Impact:** Platform pays publishers for refunded/disputed revenue. The
7-day risk hold only catches refunds within the hold window; chargebacks
commonly arrive 30-120 days after the charge. Direct money leak.

**Fix:** In `billing.ts`'s `charge.refunded` / `charge.dispute.created`
handlers, after reversing consumer credits, locate the `publisherEarnings`
rows for the refunded settlement(s) via `by_settlement`
(`usageSettlementRefId`) and transition them to `reversed` (or delete if
not yet allocated). `preparePublisherTransfer` already selects only
`available`, so once reversed they're excluded — but the transition must be
wired. The refund handler already has the `stripeChargeId`; the link from
charge → settlement ref lives in `payments` / `usageEvents.settleRefId`.

---

### [SEV: P2] `transferToStripe` rethrows raw Stripe errors to the publisher client

**Location:** `convex/payouts.ts:575-609`

```ts
} catch (error) {
  const reason =
    error instanceof Error ? error.message.slice(0, 240) : "Stripe transfer failed";
  await ctx.runMutation(internal.payouts.markPublisherTransferFailed, {
    transferId: transfer._id,
    reason,
  });
  throw error;
}
```

**Problem:** The raw Stripe error is rethrown, bubbles through the public
`action` `initiatePublisherTransfer`, and reaches the publisher UI. Stripe
error messages contain internal details: connected account ids, capability
requirements, decline codes, raw API messages, and — for the 255-char key
bug — the full over-length key string. The product rule says "Never leak
internal errors to users." The `failureReason` is correctly truncated and
stored for admin view, but the thrown error bypasses that sanitization.

**Impact:** Internal Stripe details surface in the publisher's browser
console and toast. Information leak; confusing UX. For the idempotency-key
defect, the leaked error contains every earning id in the transfer.

**Fix:**
```suggestion
  await ctx.runMutation(internal.payouts.markPublisherTransferFailed, {
    transferId: transfer._id,
    reason,
  });
  throw new Error("Publisher transfer could not be completed. See transfer details.");
```

---

### [SEV: P2] `releaseMatureEarnings` has no cron — earnings sit at `pending_risk` until the publisher clicks Withdraw

**Location:** `convex/payouts.ts:296-316`; `convex/crons.ts` (only
`low-balance-check` registered).

```ts
export const releaseMatureEarnings = internalMutation({
  args: { publisherOrganizationId: v.id("organizations") },
  handler: async (ctx, args): Promise<void> => {
    const now = Date.now();
    const pending = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_publisher", (q) =>
        q.eq("publisherOrganizationId", args.publisherOrganizationId),
      )
      .filter((q) => q.eq(q.field("status"), "pending_risk"))
      .collect();
    for (const earning of pending) {
      if (earning.availableAt <= now) {
        await ctx.db.patch(earning._id, { status: "available", updatedAt: now });
      }
    }
  },
});
```

**Problem:** `releaseMatureEarnings` is called **only** from inside
`initiatePublisherTransfer` (`payouts.ts:620`). No cron matures earnings
across all orgs. If a publisher never clicks "Withdraw," earnings stay at
`pending_risk` indefinitely after the 7-day risk hold expires.
`convex/earnings.ts:forOrg` sums `pending_risk` rows into `allTime.netCredits`,
so the publisher sees "earned" amounts that are not withdrawable. The
`by_status_available` index (`schema.ts:302`) — which exists precisely for
a global `eq(status, "pending_risk").lte(availableAt, now)` sweep — is
never read by any query (grep-confirmed dead index).

**Impact:** Stale `pending_risk` state; dead index (write amplification with
no reader); publisher statement is misleading about withdrawable vs pending
amounts until they initiate a transfer.

**Fix:** Register a cron that calls a global variant of `releaseMatureEarnings`
using the `by_status_available` index:
```tsuggestion
// crons.ts
crons.hourly("release-mature-earnings", { minuteUTC: 5 },
  internal.payouts.releaseMatureEarningsAll);
// payouts.ts
export const releaseMatureEarningsAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const pending = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_status_available", (q) =>
        q.eq("status", "pending_risk").lte("availableAt", now),
      )
      .take(500);
    for (const e of pending) await ctx.db.patch(e._id, { status: "available", updatedAt: now });
  },
});
```

---

### [SEV: P2] All earnings-status mutations use `.filter()` after `by_publisher` — full publisher-history scan on every call

**Location:** `payouts.ts:300-310` (`releaseMatureEarnings`),
`payouts.ts:358-365` (`preparePublisherTransfer`),
`payouts.ts:442-449` (`markPublisherTransferSucceeded`),
`payouts.ts:470-477` (`markPublisherTransferFailed`),
`payouts.ts:517-524` (`projectStripeTransfer`),
`payouts.ts:658-664` (`getPayoutState`).

**Problem:** Every status-transition mutation queries `publisherEarnings`
via the `by_publisher` index (scopes by `publisherOrganizationId, createdAt`)
then applies an in-memory `.filter((q) => q.eq(q.field("status"), …))` or
`.filter((q) => q.eq(q.field("transferId"), …))`. Convex's `.filter()` runs
*after* reading all matching index rows, so each of these reads every
`publisherEarnings` row the publisher has **ever** produced. The
`by_status_available` index on `["status", "availableAt"]` is not org-scoped
and is never read. There is **no composite `by_publisher_status` index and
no `by_transfer` index** — `markPublisherTransferSucceeded` /
`markPublisherTransferFailed` / `projectStripeTransfer` each do a full
publisher-history scan to find the handful of rows allocated to one
transfer, despite `publisherEarnings.transferId` being the natural lookup
key.

**Impact:** Each payout operation and each webhook-driven
`projectStripeTransfer` / `markPublisherTransfer*` degrades linearly with
publisher earnings history. A mature publisher with 100k+ settlement rows
scans all of them on every webhook delivery. Webhook processing time grows
unboundedly; Convex mutation timeouts become likely.

**Fix:** Add composite indexes
`by_publisher_status: ["publisherOrganizationId", "status"]` and
`by_transfer: ["transferId"]` (schema migration), and rewrite the queries
to use them. For `releaseMatureEarnings`, use the existing
`by_status_available` index in a global cron.

---

### [SEV: P2] `refreshConnectedAccount` silently returns on `account.closed` without disabling payouts in DB

**Location:** `convex/payouts.ts:231-244`

```ts
export const refreshConnectedAccount = internalAction({
  args: { stripeConnectedAccountId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const account = await stripeClient().v2.core.accounts.retrieve(
      args.stripeConnectedAccountId,
      { include: ["configuration.recipient", "requirements"] },
    );
    if (account.closed === true) return;
    await ctx.runMutation(internal.payouts.projectConnectedAccount, {
      stripeConnectedAccountId: account.id,
      ...connectAccountProjection(account),
    });
  },
});
```

**Problem:** If the Stripe account is closed (`account.closed === true`),
the action returns without projecting any state. The DB retains the
last-known `payoutsEnabled: true` / `disabledReason: undefined` from before
closure. `preparePublisherTransfer` checks `profile.payoutsEnabled &&
profile.disabledReason === undefined` — so it continues to allow transfer
preparation for a closed account. The Stripe `transfers.create` then fails
(the connected account is closed), producing a `failed` transfer and
stranding earnings (see prior findings).

**Impact:** Stale `payoutsEnabled` for closed accounts; failed-transfer
cascade; publisher UX shows "enabled" when the account is dead.

**Fix:**
```suggestion
if (account.closed === true) {
  await ctx.runMutation(internal.payouts.projectConnectedAccount, {
    stripeConnectedAccountId: args.stripeConnectedAccountId,
    detailsSubmitted: false,
    chargesEnabled: false,
    payoutsEnabled: false,
    disabledReason: "Connected account is closed",
    requirements: [],
  });
  return;
}
```

---

### [SEV: P2] Sub-cent residual destroyed on every transfer — ledger never reconciles with Stripe amount

**Location:** `convex/payouts.ts:358-371`, `convex/accounting.ts:38-43`.

```ts
const credits = earnings.reduce(
  (total, earning) => total + earning.netCredits,
  0,
);
const amount = creditsToUsdCents(credits);  // Math.floor((credits * 100) / 10_000)
if (amount <= 0) throw new Error("Available earnings are below one cent");
// …
for (const earning of earnings) {
  await ctx.db.patch(earning._id, {
    status: "allocated_to_transfer",
    transferId,
    updatedAt: now,
  });
}
```

**Problem:** `creditsToUsdCents` floors. If aggregate `netCredits = 150`,
`amount = 1` cent (= 100 credits). The full 150 credits are marked
`allocated_to_transfer` → `transferred`, but only 100 credits worth of money
left Stripe. The 50-credit residual is silently destroyed — no ledger entry,
no carry-forward, no platform grant. Over thousands of transfers, this
accumulates as permanent platform liability (platform under-paid publishers
by the residual, but the ledger says they were paid in full).

**Impact:** Ledger irreconcilable with Stripe transfers. Platform
systematically under-pays publishers by sub-cent residuals while the ledger
claims full payment. Any audit comparing `publisherTransfers.amount` (cents)
against `sum(publisherEarnings.netCredits where transferId = …)` will find a
discrepancy for every transfer where `netCredits mod 100 !== 0`.

**Fix:** Track the residual explicitly — either a `residualCredits` field on
`publisherTransfers` carried into the next transfer, or a platform-side
`publisherEarnings` adjustment row crediting the residual back to the
publisher's withdrawable balance.

---

### [SEV: P2] `projectStripeTransfer` drops events that arrive before `stripeTransferId` is set on the transfer

**Location:** `convex/payouts.ts:493-533` (the `if (transfer === null) return;`
early return).

**Problem:** `projectStripeTransfer` looks up the transfer by
`stripeTransferId` via the `by_stripe_transfer` index. But
`stripeTransferId` is only set on the transfer **after**
`markPublisherTransferSucceeded` runs (inside `transferToStripe`, after the
Stripe call returns). If a `transfer.reversed` or `transfer.failed` webhook
arrives in the window between Stripe accepting the transfer and
`markPublisherTransferSucceeded` executing, the lookup returns `null` and
the event is silently dropped. The transfer stays at `created` /
`succeeded` with no record of the reversal/failure.

**Impact:** Lost reversal/failure events → transfer and earnings permanently
record the wrong state. Same class of reconciliation drift as the
out-of-order finding, via a different window.

**Fix:** The webhook handler in `billing.ts:844` already retrieves the full
Stripe transfer object, which carries `metadata.publisherTransferId` (set in
`transferToStripe` at `payouts.ts:584`). Pass that into
`projectStripeTransfer` and look up by Convex `_id` as a fallback when the
`stripeTransferId` lookup misses.

---

### [SEV: P2] **NEW** `projectStripeTransfer` state is derived from webhook event type, not from the retrieved Stripe transfer object's actual state

**Location:** `convex/billing.ts:844-855` (caller) →
`convex/payouts.ts:493-533` (mutation).

```ts
case "transfer.created":
case "transfer.updated":
case "transfer.failed":
case "transfer.reversed": {
  const transfer = await stripe.transfers.retrieve(args.objectId);
  await ctx.runMutation(internal.payouts.projectStripeTransfer, {
    stripeTransferId: transfer.id,
    state:
      args.eventType === "transfer.reversed"
        ? "reversed"
        : args.eventType === "transfer.failed"
          ? "failed"
          : "succeeded",
    failureReason: undefined,
  });
  break;
}
```

**Problem:** The handler retrieves the full Stripe transfer object but uses
only `transfer.id` — the `state` passed to `projectStripeTransfer` is
derived purely from `args.eventType`. A `transfer.updated` event for a
transfer that Stripe internally records as reversed (reversals exist on the
transfer) or failed (`transfer.failure_reason` set, or
`transfer.reversals.data` non-empty) is mapped to `"succeeded"`. Stripe does
not guarantee that `transfer.reversed` is the *only* event emitted after a
reversal — `transfer.updated` is routinely fired on any change. This is the
root-cause amplifier behind the illegal-transitions P1: even if
`projectStripeTransfer` grew a status guard, the *input* state is wrong.

**Impact:** Reversed/failed transfers get re-projected as `succeeded` on
every subsequent `transfer.updated` webhook. Independent of the missing
guard, the projection is unreliable.

**Fix:** Derive `state` from the retrieved transfer object:
```suggestion
const transfer = await stripe.transfers.retrieve(args.objectId);
const reversed = (transfer.reversals?.total_count ?? 0) > 0;
const state = reversed || args.eventType === "transfer.reversed"
  ? "reversed"
  : args.eventType === "transfer.failed" || transfer.failure_reason
    ? "failed"
    : "succeeded";
```
Pass `failureReason: transfer.failure_reason ?? undefined`.

---

### [SEV: P2] **NEW** `markPublisherTransferSucceeded` never emits a `transfer_sent` notification — success is silent; `transfer_sent` notification kind is dead

**Location:** `convex/payouts.ts:426-456` (absence of notification);
`convex/schema.ts:122-123` (`transfer_sent` literal);
`convex/lib/notifications.ts:7-12` (declared kind).

**Problem:** `markPublisherTransferFailed` creates a `transfer_failed`
notification (`payouts.ts:484`). The symmetric success path —
`markPublisherTransferSucceeded` — creates **no** notification. Grep
confirms `kind: "transfer_sent"` has zero producers across `convex/`. The
schema and `NotificationKind` union carry the literal, the web
`notification-bell.tsx` renders an icon and route for it, but it is never
fired. A publisher who initiates a transfer sees no in-app confirmation that
money was sent (only the absence of a failure notification).

**Impact:** Asymmetric UX — failures notify, successes don't. Dead schema
variant misleads consumers switching on `kind`.

**Fix:** In `markPublisherTransferSucceeded`, after patching the transfer,
emit a `transfer_sent` notification (idempotent via `refId:
transfer_sent:${transfer._id}`).

---

### [SEV: P2] **NEW** `transferToStripe` catch block: if `markPublisherTransferFailed` itself throws, the transfer is left at `created`/`pending` while Stripe already rejected

**Location:** `convex/payouts.ts:587-608`

```ts
} catch (error) {
  const reason =
    error instanceof Error ? error.message.slice(0, 240) : "Stripe transfer failed";
  await ctx.runMutation(internal.payouts.markPublisherTransferFailed, {
    transferId: transfer._id,
    reason,
  });
  throw error;
}
```

**Problem:** `markPublisherTransferFailed` does non-trivial work inside its
mutation: it patches the transfer, scans `publisherEarnings` (full
publisher-history scan, see prior P2), patches each earning to `failed`, and
calls `createNotification`. If any of that throws (e.g. Convex mutation
timeout from the full-history scan on a large publisher, or a notification
insert failure), the error propagates out of the catch block — the original
Stripe `error` is still rethrown, but the transfer was never marked `failed`.
It stays at `created` (or whatever `preparePublisherTransfer` set). Stripe
rejected the transfer; the DB still thinks it's in flight. The next
`initiatePublisherTransfer` call sees `created` via the retry short-circuit
and re-calls `transferToStripe` with the same idempotency key — Stripe
returns the original rejection, the catch runs again, and if
`markPublisherTransferFailed` fails again the loop continues. Earnings stay
at `allocated_to_transfer` indefinitely.

**Impact:** Silent stuck-state when the failure-recording mutation itself
fails. No observability — the publisher sees a generic error and the
transfer appears "in flight" forever.

**Fix:** Wrap the `markPublisherTransferFailed` call in its own try/catch
and log/swallow its failure separately, so the original Stripe error is
always rethrown but failure-recording best-effort is isolated. Better:
record failure status directly in `transferToStripe`'s calling mutation
context (but `transferToStripe` is an action, so it must call the
internalMutation — at minimum guard it).

---

### [SEV: P2] **NEW** `setConnectedAccount` silently ignores a mismatched `stripeConnectedAccountId`

**Location:** `convex/payouts.ts:151-172`

```ts
handler: async (ctx, args): Promise<string> => {
  const existing = await ctx.db
    .query("organizationPayments")
    .withIndex("by_organization", (q) =>
      q.eq("organizationId", args.organizationId),
    )
    .unique();
  if (existing === null) throw new Error("Payment profile not found");
  if (
    existing.stripeConnectedAccountId !== undefined &&
    existing.stripeConnectedAccountId !== args.stripeConnectedAccountId
  ) {
    return existing.stripeConnectedAccountId;
  }
  await ctx.db.patch(existing._id, {
    stripeConnectedAccountId: args.stripeConnectedAccountId,
    updatedAt: Date.now(),
  });
  return args.stripeConnectedAccountId;
},
```

**Problem:** If the org already has a `stripeConnectedAccountId` that
differs from the incoming one, the mutation **silently returns the existing
id without throwing and without persisting the new one**. The caller
(`startOnboarding`) has just created a Stripe onboarding link for the *new*
account id (returned from `createOnboardingLink`), persisted nothing, and
returns that onboarding URL to the publisher. The publisher completes
onboarding on the new account, but `preparePublisherTransfer` reads the
*old* account id from the DB — transfers go to the old account (which may
be closed/restricted). The `connect-account:${organizationId}` idempotency
key in `createOnboardingLink` makes account re-creation rare (Stripe returns
the same account id on key reuse), so in practice the mismatch path is
unreachable *if* the idempotency key is always used — but `createOnboardingLink`
only uses the key when `connectedAccountId === null` (first-time onboarding).
On subsequent onboarding calls the key is not sent, so Stripe can return a
*new* account id, and this mutation silently discards it.

**Impact:** Publisher onboards a new connected account but payouts route to
the old one. Confusing at best, money-misrouting at worst if the old
account is stale.

**Fix:** Throw on mismatch (force explicit admin reconciliation) or update
the stored id (treat re-onboarding as intentional re-binding). Silently
returning the old id is the worst option.

---

### [SEV: P3] `chargesEnabled` is hardcoded to `false` — dead field across projection/DB/UI

**Location:** `payouts.ts:222` (`connectAccountProjection` returns
`chargesEnabled: false`), `payouts.ts:184` (`projectConnectedAccount` arg),
`schema.ts:241` (`organizationPayments.chargesEnabled`).

**Problem:** `connectAccountProjection` always returns `chargesEnabled: false`.
The field is never set to `true` by any code path. Zevium uses Connect for
payouts only, so the field is conceptually dead, but it remains in the
schema, projection, mutation args, and admin profile view — forcing every
reader to reason about a state that can never occur.

**Impact:** Dead code; minor schema/maintenance cost. No correctness defect.

**Fix:** Remove `chargesEnabled` from the schema, projection, and
`projectConnectedAccount` args; or document that Connect is payouts-only.

---

### [SEV: P3] `projectConnectedPayout` accepts any `stripeConnectedAccountId` from webhooks without validating it maps to a known profile

**Location:** `convex/payouts.ts:535-573`; caller `convex/billing.ts:861-868`.

**Problem:** The mutation trusts `args.stripeConnectedAccountId` (sourced
from `billing.ts:869` as `args.stripeAccount`) and stores it without
checking that an `organizationPayments` row exists for that account. The
billing dispatcher's `payout.*` branch explicitly handles
`args.stripeAccount === "platform"` by retrieving the payout from the
platform account (`billing.ts:861-866`), then passes
`stripeConnectedAccountId: args.stripeAccount` (i.e. the literal string
`"platform"`) into `projectConnectedPayout`. A `connectedPayouts` row with
`stripeConnectedAccountId: "platform"` is inserted — a value no org owns.
The row is invisible in `getPayoutState` (which filters by the org's real
connected account id) but pollutes the table and the `by_connected_account`
index.

**Impact:** Table/index pollution; no cross-org data leak (the row is
invisible to all orgs).

**Fix:** In `billing.ts`, skip `projectConnectedPayout` when
`args.stripeAccount === "platform"` (platform payouts are not Connect
payouts). In `projectConnectedPayout`, validate that
`args.stripeConnectedAccountId` resolves to an `organizationPayments` row
before inserting.

---

### [SEV: P3] `initiatePublisherTransfer` has no rate limiting — spam-clicking burns Stripe API quota

**Location:** `convex/payouts.ts:612-638`.

**Problem:** The action has no args and no per-org rate limit. A publisher
spamming "Withdraw" fires many `initiatePublisherTransfer` actions. The
idempotency key dedupes the Stripe side (same transfer returned) and
`preparePublisherTransfer`'s `priorTransfers` short-circuit returns the
in-flight transfer, so there's no double-payout — but each click still burns
a Stripe `transfers.create` API call (rate-limited by Stripe) and a Convex
action invocation. With the 255-char key bug, each click also re-fails and
re-marks-failed.

**Impact:** Stripe API quota burn; no money risk.

**Fix:** Track `attemptedAt` on the transfer and reject re-invocation within
a short window (e.g. 30s), or rely on the `priorTransfers` short-circuit to
skip the Stripe call when the transfer is already `created`/`pending`.

---

### [SEV: P3] `priorTransfers` uses `take(20)` — older stuck transfers are orphaned

**Location:** `convex/payouts.ts:335-347`.

**Problem:** The retry short-circuit scans only the 20 most recent
`publisherTransfers` rows for the org. If a publisher has >20 transfers and
the 20 most recent are all `succeeded`/`reversed`, but an older transfer
(e.g. #21) is stuck at `failed`, the failed transfer is not found by the
retry path. Its earnings remain stranded at `failed` forever (no recovery
path, see prior finding).

**Impact:** Edge case; requires 20+ more recent transfers after a failed
one. Reachable for a high-volume publisher over time.

**Fix:** Query specifically for non-terminal transfers
(`status in ["created", "pending", "failed"]`) via a composite
`by_publisher_status` index, rather than scanning the 20 most recent and
filtering.

---

### [SEV: P3] `markPublisherTransferSucceeded` / `projectStripeTransfer` set `attemptedAt` inconsistently

**Location:** `payouts.ts:439` (`markPublisherTransferSucceeded` sets
`attemptedAt: now`), `payouts.ts:511-514` (`projectStripeTransfer` does not
set `attemptedAt`), `payouts.ts:474` (`markPublisherTransferFailed` sets
`attemptedAt: now`).

**Problem:** `attemptedAt` is set by the direct mark mutations but not by
the webhook-driven `projectStripeTransfer`. A transfer that transitions to
`succeeded` via webhook (rather than via `transferToStripe`) has
`attemptedAt: undefined`. The admin `listPublisherTransfers` view exposes
`createdAt`/`updatedAt` but not `attemptedAt`, so the inconsistency is
currently invisible — but it's a latent data-quality issue for any future
audit/reconciliation query.

**Impact:** Minor; no current consumer reads `attemptedAt`. Inconsistent
state for audit.

**Fix:** Set `attemptedAt` in `projectStripeTransfer` when transitioning to
a terminal state, or drop the field if unused.

---

### [SEV: P3] **NEW** `preparePublisherTransfer` retry path sends to the OLD `stripeConnectedAccountId` even after the org re-onboards a new account

**Location:** `convex/payouts.ts:340-346`

```ts
if (retry !== undefined) {
  return {
    transferId: retry._id,
    connectedAccountId: retry.stripeConnectedAccountId,  // ← stale
    amount: retry.amount,
    currency: retry.currency,
    idempotencyKey: retry.idempotencyKey,
  };
}
```

**Problem:** For a retry, the returned `connectedAccountId` is the
`stripeConnectedAccountId` captured on the transfer row at creation time —
not the org's *current* connected account from `organizationPayments`. If
the org re-onboarded a new connected account between transfer creation and
retry (see the `setConnectedAccount` silent-ignore finding), the retry
sends money to the old (possibly closed) account while the DB now points at
the new one. `transferToStripe` then calls Stripe with the old destination.

**Impact:** Retry misroutes to a stale connected account. Edge case
(requires re-onboarding between transfer creation and retry), but a
money-out misroute is high-severity when it occurs.

**Fix:** For retries, look up the org's current connected account from
`organizationPayments` and either send to the current one or refuse the
retry if the account has changed (forcing a fresh transfer).

---

## Summary

- **P0:** 0
- **P1:** 7
- **P2:** 10
- **P3:** 6
- **Total:** 23

(17 carried forward and verified from the prior review + 6 new.)

**Top 3 to fix first:**

1. **P1 — Stripe idempotency key exceeds 255 chars for ≥9 earnings (NEW).**
   The entire payout pipeline fails at Stripe for any real-volume
   publisher. Earnings strand at `failed` with no recovery. This is the
   root cause that makes every other money-out defect acute rather than
   rare. Derive the key from `publisherTransfers._id` or a UUID, not the
   earning set.
2. **P1 — Illegal status transitions in `projectStripeTransfer` +
   `markPublisherTransferSucceeded`.** No guard against resurrecting
   `reversed`/`failed` transfers. Stripe delivers duplicate/out-of-order
   webhooks normally; the DB ends up saying "paid" while Stripe clawed the
   money back. Add forward-only transition guards. (The
   event-type-vs-transfer-object P2 is the root-cause amplifier.)
3. **P1 — Stranded earnings + no `failed → available` recovery.**
   `preparePublisherTransfer`'s retry short-circuit returns any failed
   transfer and never scans new `available` earnings, while
   `markPublisherTransferFailed` leaves earnings at `failed` with no path
   back. A single failed transfer permanently blocks the publisher from
   withdrawing any future earnings. Either exclude `failed` from the
   short-circuit and reset failed earnings to `available`, or add an
   explicit abandon/recovery flow.

**Recurring theme:** The state machine around the (correct) idempotency-key
design is unguarded and uninstrumented. Status transitions are written
without checking the current status; the failure-recording mutation is not
failure-isolated; the cron that should mature earnings doesn't exist; and
the index that should serve the maturation sweep is dead. Every money-out
defect here is either an unguarded transition or a missing recovery path —
the fix pattern is the same in every case: forward-only transitions,
terminal-state stickiness, and an explicit recovery flow for every
non-terminal failure.
