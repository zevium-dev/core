# Tiger Review: `convex/payouts.ts`

## Verdict

**INCORRECT — do not merge.** The file contains multiple money-out integrity
defects: illegal status transitions on out-of-order/duplicate Stripe webhooks
that can flip `reversed` earnings back to `transferred`, a retry path in
`preparePublisherTransfer` that strands new earnings behind any unresolved
failed transfer, a `getPayoutState` query whose totals only reflect the 100
most recent earnings rows, and refunds/disputes that never reverse
`publisherEarnings`. The idempotency-key design prevents direct double-payout
of the *same* transfer, but the surrounding state machine has holes that
produce reconciliation drift and silent money loss.

---

## File Stats

- **LOC:** 753
- **Role:** Stripe Connect publisher payouts — onboarding, connected-account
  projection, earnings maturation, transfer preparation/execution, payout
  mirroring, and the publisher-facing payout-state query.
- **Key exports:** `startOnboarding`, `releaseMatureEarnings`,
  `preparePublisherTransfer`, `getPublisherTransfer`,
  `markPublisherTransferSucceeded`, `markPublisherTransferFailed`,
  `projectStripeTransfer`, `projectConnectedPayout`,
  `initiatePublisherTransfer`, `getPayoutState`, `refreshConnectedAccount`,
  `setConnectedAccount`, `projectConnectedAccount`,
  `getConnectProfileForActiveOrg`, `connectAccountProjection`,
  `createOnboardingLink`, `transferToStripe`.
- **Consumers:** `convex/billing.ts` (webhook dispatch:
  `projectStripeTransfer`, `projectConnectedPayout`,
  `refreshConnectedAccount`), `convex/admin.ts` (`retryPublisherTransfer`,
  `listPublisherTransfers`), `apps/web/src/routes/app/earnings.tsx`
  (`getPayoutState`, `startOnboarding`, `initiatePublisherTransfer`),
  `apps/web/src/routes/admin/payouts.tsx` (`retryPublisherTransfer`).
- **Tests:** `convex/stripe-connect.test.ts` (6 tests; cover onboarding,
  capability gating, idempotent allocation, projection — no coverage of
  out-of-order webhooks, stranded-earnings, refund-reversal, or scale).

---

## Findings

### [SEV: P1] `projectStripeTransfer` allows illegal status transitions on out-of-order webhooks

**Location:** `convex/payouts.ts:493-533`

```ts
export const projectStripeTransfer = internalMutation({
  args: {
    stripeTransferId: v.string(),
    state: v.union(
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("reversed"),
    ),
    failureReason: v.optional(v.string()),
  },
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
    const earnings = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_publisher", (q) =>
        q.eq("publisherOrganizationId", transfer.publisherOrganizationId),
      )
      .filter((q) => q.eq(q.field("transferId"), transfer._id))
      .collect();
    const earningStatus =
      args.state === "succeeded" ? "transferred" : args.state;
    for (const earning of earnings) {
      await ctx.db.patch(earning._id, {
        status: earningStatus,
        updatedAt: now,
      });
    }
  },
});
```

**Problem:** Stripe delivers webhooks at-least-once with no ordering
guarantee. The billing dispatcher (`convex/billing.ts:840-856`) maps
`transfer.created` / `transfer.updated` → `state: "succeeded"`,
`transfer.reversed` → `"reversed"`. `projectStripeTransfer` patches
`status` and all allocated earnings to the incoming state **without checking
the current status**. If a `transfer.reversed` event is followed by a
duplicate or delayed `transfer.created` event, the transfer and its
earnings flip `reversed → succeeded` (i.e. earnings `reversed → transferred`).

**Impact:** The platform's Stripe transfer was reversed (money clawed back
from the publisher's connected account) but the DB now records the publisher
as paid. Ledger irreconcilable with Stripe. The publisher's `getPayoutState`
and the admin `listPublisherTransfers` view both lie about the money.
Duplicate `transfer.created` events are normal Stripe behaviour, so this is
reachable in production, not a theoretical race.

**Fix:** Guard transitions. `reversed` is terminal; `succeeded` should not
overwrite it. At minimum:
```tsuggestion
const TERMINAL: Record<string, boolean> = { reversed: true };
if (transfer.status !== undefined && TERMINAL[transfer.status]) return;
const FORWARD: Record<string, number> = {
  created: 0, pending: 1, succeeded: 2, failed: 1, reversed: 3,
};
if (FORWARD[transfer.status] > FORWARD[args.state]) return;
```

---

### [SEV: P1] `markPublisherTransferSucceeded` has no status guard — can resurrect `reversed`/`failed` transfers

**Location:** `convex/payouts.ts:426-456`

```ts
export const markPublisherTransferSucceeded = internalMutation({
  args: {
    transferId: v.id("publisherTransfers"),
    stripeTransferId: v.string(),
  },
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
    // ... patches ALL earnings with transferId === transfer._id to "transferred"
  },
});
```

**Problem:** No check on `transfer.status` before patching to `succeeded`.
Called from `transferToStripe` (`payouts.ts:587-599`) after a Stripe
`transfers.create` success, and from `admin.retryPublisherTransfer`
(`admin.ts:363-366`). If a transfer was already `reversed` (Stripe clawed
the money back) and then an admin retry or a concurrent `initiatePublisherTransfer`
succeeds at Stripe with the same idempotency key (returning the original
transfer object), this mutation flips the transfer and all its earnings back
to `succeeded`/`transferred`, erasing the reversal.

**Impact:** Same reconciliation drift as the previous finding but via a
different path — the mutation unconditionally overwrites terminal states.
Compounds with the missing guard in `projectStripeTransfer`.

**Fix:**
```suggestion
if (transfer.status === "reversed") {
  throw new Error("Cannot mark a reversed transfer as succeeded");
}
if (transfer.status === "succeeded") return;
```

---

### [SEV: P1] `preparePublisherTransfer` retry path strands new earnings behind any unresolved failed transfer

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
`created` / `pending` / `failed` state, the function **returns that transfer
immediately** and never scans `available` earnings. New earnings that matured
after the failed transfer was created are at `status: "available"` but can
never be selected for a new transfer — the retry short-circuit blocks the
new-transfer creation path. The publisher is stuck: they cannot withdraw
new earnings until the failed transfer is resolved (succeeded or reversed),
and `markPublisherTransferFailed` leaves earnings at `status: "failed"` with
no path back to `available` (see next finding).

**Impact:** A publisher whose transfer fails once (Stripe error, connected
account restriction, network blip) is permanently blocked from withdrawing
subsequent earnings until the failed transfer is manually resolved. The
admin `retryPublisherTransfer` action is the only recovery path, and it only
retries the specific failed transfer — it does not unblock new earnings.

**Fix:** Either (a) exclude `failed` from the retry short-circuit and let a
new transfer pick up `available` earnings (the failed transfer's earnings
remain at `failed` and need a separate reversal/recovery flow), or (b) when
a transfer is `failed`, reset its earnings to `available` and clear their
`transferId` so they can be re-selected. Option (a) is safer:
```suggestion
const retry = priorTransfers.find(
  (transfer) =>
    transfer.status === "created" || transfer.status === "pending",
);
```

---

### [SEV: P1] `markPublisherTransferFailed` sets earnings to `failed` with no recovery path to `available`

**Location:** `convex/payouts.ts:458-491`

```ts
for (const earning of earnings) {
  await ctx.db.patch(earning._id, { status: "failed", updatedAt: now });
}
```

**Problem:** When a transfer fails, all allocated earnings transition
`allocated_to_transfer → failed`. There is no code path in the codebase that
transitions `failed → available` or `failed → allocated_to_transfer`. The
only transitions out of `failed` are `markPublisherTransferSucceeded`
(`failed → transferred`, via retry success) and `projectStripeTransfer`
(`failed → reversed/succeeded`, via webhook). If the transfer can never be
retried successfully (e.g., connected account permanently closed, Stripe
rejects the idempotent retry forever, or the admin decides not to retry),
those earnings are permanently stranded at `failed` and never appear in
`available` again.

**Impact:** Publisher earnings silently trapped in `failed` status forever.
Combined with the previous finding, the publisher is doubly blocked: failed
earnings can't be re-withdrawn, and new earnings can't be withdrawn because
the failed transfer short-circuits `preparePublisherTransfer`.

**Fix:** Introduce an explicit `failed → available` recovery transition (e.g.
admin action `abandonPublisherTransfer` that clears `transferId` and resets
earnings to `available`), or have `markPublisherTransferFailed` reset
earnings to `available` immediately (treating the transfer as never-attempted)
since the Stripe money never moved.

---

### [SEV: P1] `getPayoutState` totals only reflect the 100 most recent earnings rows

**Location:** `convex/payouts.ts:640-705`

```ts
const earnings = await ctx.db
  .query("publisherEarnings")
  .withIndex("by_publisher", (q) =>
    q.eq("publisherOrganizationId", organization._id),
  )
  .order("desc")
  .take(100);
// ...
for (const earning of earnings) {
  if (earning.status === "pending_risk")
    totals.pendingRisk += earning.netCredits;
  else if (earning.status === "available")
    totals.available += earning.netCredits;
  else if (earning.status === "allocated_to_transfer")
    totals.allocated += earning.netCredits;
  else if (earning.status === "transferred")
    totals.transferred += earning.netCredits;
  // ...
}
```

**Problem:** The totals (`pendingRisk`, `available`, `allocated`,
`transferred`, `reversed`, `failed`) are computed by iterating over the 100
most recent `publisherEarnings` rows for the org. For any publisher with
more than 100 settlement rows, the totals are **understated** — historical
`transferred` earnings beyond the 100-row window are invisible. A publisher
who has withdrawn 50 times sees their `transferred` total capped at whatever
falls in the last 100 rows.

**Impact:** The publisher-facing earnings/payout UI shows wrong balances.
The `available` figure (which drives the "Withdraw" button's implied amount)
may be correct if there are <100 available rows, but `transferred` is
definitely wrong for any active publisher. This is a money-out surface —
publishers make decisions based on these numbers.

**Fix:** Compute totals via a separate aggregation query (or maintain a
materialized `publisherEarningsTotals` document updated on each status
transition), rather than deriving them from a `take(100)` window.

---

### [SEV: P1] Refunds and disputes never reverse `publisherEarnings` — publisher keeps earnings for refunded calls

**Location:** `convex/payouts.ts` (whole file — absence of reversal path);
consumer side `convex/billing.ts:776-836` calls
`internal.wallets.reversePaymentCredits` only.

**Problem:** When a consumer charge is refunded or disputed, `billing.ts`
calls `reversePaymentCredits` which debits the **consumer** wallet only.
No code path ever patches the corresponding `publisherEarnings` row. The
`status: "reversed"` value in the `publisherEarnings` schema union is
written **only** by `projectStripeTransfer` (Stripe transfer reversal, i.e.
the platform clawing back from the publisher's connected account) — never
by the refund/dispute flow. `preparePublisherTransfer` selects
`status === "available"` earnings without checking whether the underlying
consumer payment was refunded.

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

**Impact:** Platform pays publishers for refunded/disputed revenue. The 7-day
risk hold only catches refunds within the hold window; chargebacks commonly
arrive 30-120 days after the charge. This is a direct money leak.

**Fix:** In `billing.ts`'s `charge.refunded` / `charge.dispute.created`
handlers, after reversing consumer credits, locate the `publisherEarnings`
rows for the refunded settlement(s) and transition them to `reversed`
(or delete them if not yet allocated). `preparePublisherTransfer` must skip
`reversed` earnings (it currently only selects `available`, so once they're
`reversed` they're excluded — but the transition needs to be wired).

---

### [SEV: P2] `transferToStripe` rethrows Stripe errors to the publisher client

**Location:** `convex/payouts.ts:575-609`

```ts
} catch (error) {
  const reason =
    error instanceof Error
      ? error.message.slice(0, 240)
      : "Stripe transfer failed";
  await ctx.runMutation(internal.payouts.markPublisherTransferFailed, {
    transferId: transfer._id,
    reason,
  });
  throw error;
}
```

**Problem:** The raw Stripe error is rethrown from `transferToStripe`, bubbles
through `initiatePublisherTransfer` (a public `action`), and reaches the
publisher UI. Stripe error messages can contain internal details: connected
account IDs, capability requirements, decline codes, and raw API messages.
The product rule says "Never leak internal errors to users." The
`failureReason` is correctly truncated and stored in the DB for admin view,
but the thrown error bypasses that sanitization.

**Impact:** Internal Stripe details surface in the publisher's browser
console and toast error. Information leak; confusing UX.

**Fix:**
```suggestion
} catch (error) {
  const reason =
    error instanceof Error
      ? error.message.slice(0, 240)
      : "Stripe transfer failed";
  await ctx.runMutation(internal.payouts.markPublisherTransferFailed, {
    transferId: transfer._id,
    reason,
  });
  throw new Error("Publisher transfer could not be completed. See transfer details.");
}
```

---

### [SEV: P2] `releaseMatureEarnings` has no cron — earnings sit at `pending_risk` until the publisher clicks Withdraw

**Location:** `convex/payouts.ts:296-316`; `convex/crons.ts` (only
`low-balance-check` is registered).

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
`initiatePublisherTransfer` (`payouts.ts:620`). There is no cron job that
periodically matures earnings across all orgs. If a publisher never clicks
"Withdraw," their earnings stay at `pending_risk` indefinitely even after the
7-day risk hold expires. `convex/earnings.ts:forOrg` counts `pending_risk`
rows in `allTime.netCredits`, so the publisher sees "earned" amounts that are
not actually withdrawable, and the `by_status_available` index (which exists
precisely for a global `eq(status, "pending_risk").lte(availableAt, now)`
sweep) is never used by any query.

**Impact:** Stale `pending_risk` state; the `by_status_available` index is
dead weight (write amplification with no reader); publisher statement is
misleading about withdrawable vs pending amounts until they initiate a
transfer.

**Fix:** Register a cron (`crons.hourly` or `crons.daily`) that calls a
global variant of `releaseMatureEarnings` using the `by_status_available`
index: `.withIndex("by_status_available", q => q.eq("status", "pending_risk").lte("availableAt", now))`.

---

### [SEV: P2] All earnings-status mutations use `.filter()` after `by_publisher` — full publisher-history scan on every call

**Location:** `convex/payouts.ts:300-310` (`releaseMatureEarnings`),
`payouts.ts:358-365` (`preparePublisherTransfer`),
`payouts.ts:442-449` (`markPublisherTransferSucceeded`),
`payouts.ts:470-477` (`markPublisherTransferFailed`),
`payouts.ts:517-524` (`projectStripeTransfer`),
`payouts.ts:658-664` (`getPayoutState`).

**Problem:** Every status-transition mutation queries
`publisherEarnings` via the `by_publisher` index (which scopes by
`publisherOrganizationId, createdAt`) and then applies an in-memory
`.filter((q) => q.eq(q.field("status"), ...))` or
`.filter((q) => q.eq(q.field("transferId"), ...))`. Convex's `.filter()` is
applied after reading all matching index rows — so each of these reads every
`publisherEarnings` row the publisher has **ever** produced. There is a
`by_status_available` index on `["status", "availableAt"]` but it is not
org-scoped and is never read. There is no composite `by_publisher_status` or
`by_transfer` index.

**Impact:** Each payout operation (and each webhook-driven
`projectStripeTransfer` / `markPublisherTransfer*`) degrades linearly with
publisher earnings history. A mature publisher with 100k+ settlement rows
scans all of them on every webhook delivery. The `transferId` filter is
especially bad — there's no index on `transferId` at all, so
`markPublisherTransferSucceeded` / `markPublisherTransferFailed` /
`projectStripeTransfer` each do a full publisher-history scan to find the
handful of rows allocated to one transfer.

**Fix:** Add composite indexes
`by_publisher_status: ["publisherOrganizationId", "status"]` and
`by_transfer: ["transferId"]` and rewrite the queries to use them. For
`releaseMatureEarnings`, use the existing `by_status_available` index in a
global cron.

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

**Problem:** If the Stripe account is closed (`account.closed === true`), the
action returns without projecting any state. The DB still shows the last-known
`payoutsEnabled: true` / `disabledReason: undefined` state from before closure.
`preparePublisherTransfer` checks `profile.payoutsEnabled &&
profile.disabledReason === undefined` — so it will continue to allow transfer
preparation for a closed account. The Stripe `transfers.create` call will
then fail at Stripe (the connected account is closed), producing a `failed`
transfer and stranding earnings (see prior findings).

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
// ...
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
no carry-forward, no platform-grant. Over thousands of transfers, this
accumulates as permanent platform liability (platform under-paid publishers
by the residual, but the ledger says they were paid in full).

**Impact:** Ledger irreconcilable with Stripe transfers. Platform
systematically under-pays publishers by sub-cent residuals while the ledger
claims full payment. Any audit comparing `publisherTransfers.amount` (cents)
against `sum(publisherEarnings.netCredits where transferId = ...)` will find
a discrepancy for every transfer where `netCredits mod 100 !== 0`.

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
`markPublisherTransferSucceeded` executing, the lookup returns `null` and the
event is silently dropped. The transfer stays at `created` / `succeeded`
with no record of the reversal/failure.

**Impact:** Lost reversal/failure events → transfer and earnings permanently
record the wrong state. The platform's money was reversed by Stripe but the
DB shows `succeeded`. Same class of reconciliation drift as the
out-of-order finding, via a different window.

**Fix:** The webhook handler in `billing.ts` already retrieves the full
Stripe transfer object; pass the `metadata.publisherTransferId` (set in
`transferToStripe` at `payouts.ts:584`) into `projectStripeTransfer` and
look up by Convex `_id` as a fallback when the `stripeTransferId` lookup
misses.

---

### [SEV: P3] `chargesEnabled` is hardcoded to `false` — dead field across the projection/DB/UI

**Location:** `convex/payouts.ts:222` (`connectAccountProjection` returns
`chargesEnabled: false`), `payouts.ts:184` (`projectConnectedAccount` arg),
`schema.ts:241` (`organizationPayments.chargesEnabled`).

**Problem:** `connectAccountProjection` always returns
`chargesEnabled: false`. The field is never set to `true` by any code path.
Zevium uses Connect for payouts only, so the field is conceptually dead, but
it remains in the schema, the projection, the mutation args, and the admin
profile view — forcing every reader to reason about a state that can never
occur.

**Impact:** Dead code; minor schema/maintenance cost. No correctness defect.

**Fix:** Remove `chargesEnabled` from the schema, projection, and
`projectConnectedAccount` args; or document that Connect is payouts-only and
the field is reserved.

---

### [SEV: P3] `projectConnectedPayout` accepts any `stripeConnectedAccountId` from webhooks without validating it maps to a known profile

**Location:** `convex/payouts.ts:535-573`

```ts
const existing = await ctx.db
  .query("connectedPayouts")
  .withIndex("by_stripe_payout", (q) =>
    q.eq("stripePayoutId", args.stripePayoutId),
  )
  .unique();
// ... upserts by stripePayoutId, using args.stripeConnectedAccountId verbatim
```

**Problem:** The mutation trusts `args.stripeConnectedAccountId` (sourced
from `billing.ts:869` as `args.stripeAccount`) and stores it without checking
that an `organizationPayments` row exists for that account. If a misrouted
webhook (or a `stripeAccount` value of `"platform"`, which `billing.ts:861`
uses for platform-scoped payouts) reaches this mutation, a `connectedPayouts`
row is inserted with `stripeConnectedAccountId: "platform"` — a value no
org owns. The row is invisible in `getPayoutState` (which filters by the
org's real connected account id) but pollutes the table and the
`by_connected_account` index.

**Impact:** Table pollution; no cross-org data leak (the row is invisible to
all orgs), but the `by_connected_account` index accumulates junk rows under
`"platform"`.

**Fix:** Validate that `args.stripeConnectedAccountId` resolves to an
`organizationPayments` row before inserting; reject otherwise.

---

### [SEV: P3] `initiatePublisherTransfer` has no rate limiting — spam-clicking triggers Stripe API calls

**Location:** `convex/payouts.ts:612-638`

**Problem:** The action has no args and no per-org rate limit. A publisher
spamming the "Withdraw" button fires many `initiatePublisherTransfer`
actions. The idempotency key dedupes the Stripe side (same transfer
returned), and `preparePublisherTransfer`'s `priorTransfers` short-circuit
returns the in-flight transfer, so there's no double-payout — but each click
still burns a Stripe `transfers.create` API call (rate-limited by Stripe)
and a Convex action invocation.

**Impact:** Stripe API quota burn; no money risk.

**Fix:** Track `attemptedAt` on the transfer and reject re-invocation within
a short window (e.g., 30s) from the client side, or rely on the
`priorTransfers` short-circuit to skip the Stripe call when the transfer is
already `created`/`pending`.

---

### [SEV: P3] `priorTransfers` uses `take(20)` — older stuck transfers are orphaned

**Location:** `convex/payouts.ts:335-347`

**Problem:** The retry short-circuit scans only the 20 most recent
`publisherTransfers` rows for the org. If a publisher has >20 transfers and
the 20 most recent are all `succeeded`/`reversed`, but an older transfer
(e.g. #21) is stuck at `failed`, the failed transfer is not found by the
retry path. Its earnings remain stranded at `failed` forever (no recovery
path, see prior finding).

**Impact:** Edge case; requires 20+ more recent transfers after a failed
one. But for a high-volume publisher over time, this is reachable.

**Fix:** Query specifically for non-terminal transfers
(`status in ["created", "pending", "failed"]`) via an index, rather than
scanning the 20 most recent and filtering.

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

## Summary

- **P0:** 0
- **P1:** 6 (illegal status transitions in `projectStripeTransfer`; no status guard in `markPublisherTransferSucceeded`; stranded earnings behind failed transfers; no `failed → available` recovery path; `getPayoutState` totals capped at 100 rows; refunds/disputes never reverse publisher earnings)
- **P2:** 6 (`transferToStripe` error leak; no `releaseMatureEarnings` cron; full-history `.filter()` scans; stale state on closed accounts; sub-cent residual destroyed; `projectStripeTransfer` drops early-arrival events)
- **P3:** 5 (dead `chargesEnabled`; unvalidated `stripeConnectedAccountId` in payouts; no rate limit; `take(20)` orphan window; `attemptedAt` inconsistency)
- **Total:** 17

**Top 3 to fix first:**

1. **P1 — Illegal status transitions.** `projectStripeTransfer` and
   `markPublisherTransferSucceeded` patch transfer/earnings status with no
   guard against resurrecting `reversed` or `failed` transfers. Stripe
   delivers duplicate/out-of-order webhooks normally; this produces
   reconciliation drift where the DB says "paid" but Stripe clawed the money
   back. Add forward-only transition guards.
2. **P1 — Stranded earnings + no `failed → available` recovery.**
   `preparePublisherTransfer`'s retry short-circuit returns any failed
   transfer and never scans new `available` earnings, while
   `markPublisherTransferFailed` leaves earnings at `failed` with no path
   back. A single failed transfer permanently blocks the publisher from
   withdrawing any future earnings. Either exclude `failed` from the
   short-circuit or add an explicit recovery/abandon flow.
3. **P1 — Refunds/disputes never reverse `publisherEarnings`.** The
   `charge.refunded` / `charge.dispute.created` handlers reverse only the
   consumer wallet; the publisher's earning row stays at `available` or
   `transferred` and is paid out. The platform pays publishers for refunded
   revenue. Wire the refund/dispute flow to transition the corresponding
   `publisherEarnings` to `reversed`.
