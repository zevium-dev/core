# Tiger-Style Deep-Dive Review — `convex/billing.ts`

## Verdict

**Incorrect — do not merge. This is the money-in file and it is not safe to ship for real currency.** The file has at least three independent P0-class money-integrity defects, all stemming from one architectural root cause: **a single logical money operation (grant / refund / dispute) is split across multiple `internalMutation` calls invoked sequentially from an `internalAction`, with no transactional coupling, no retry, and no re-drive.** Convex actions are not transactional, Convex does not auto-retry failed scheduled actions, and the HTTP route returns `200` before processing begins. Any transient failure anywhere in the grant/refund/dispute pipeline permanently and silently drops the money movement. Surrounding those are real secondary defects: non-transactional reversal sequences that diverge the authoritative wallet ledger from the `payments` projection, event-scoped idempotency keys that bypass ledger dedup under concurrent delivery, dead code that masks a failed-grant gap, missing event handlers, unredacted error storage, and orphaned Stripe resources under race.

The ledger itself (`wallets.ts` `appendWalletEntry`) is well-designed — append-only, `refId`-deduped, OCC-protected at the single-mutation level. The defect is entirely in how `billing.ts` orchestrates calls *to* it across action boundaries.

## File Stats

- File: `convex/billing.ts` — 1048 lines
- Exports reviewed: 19 (queries/mutations/actions/helpers)
- Webhook ingress: `convex/http.ts` (`/stripe-webhook`, `/stripe-connect-webhook`, `/stripe-connect-v2-webhook`)
- Ledger grant path: `convex/wallets.ts` (`grantPaymentCredits` / `reversePaymentCredits` / `appendWalletEntry`)
- Schema: `convex/schema.ts` (`paymentEvents`, `payments`, `checkoutIntents`, `wallets`, `walletEntries`, `organizationPayments`)
- Cron: `convex/crons.ts` — **only `low-balance-check`**; no failed-event re-drive, no expired-intent sweep
- Tests: `convex/stripe-billing.test.ts` (6 cases), `convex/stripe-connect.test.ts` (6 cases)
- Prior review: `reviews/convex.billing.ts.md` (2 P0, 2 P1, 9 P2, 5 P3) — verified and expanded below

---

## Findings

### [SEV: P0] Failed Stripe webhook events are never reprocessed — permanent silent money loss

**Location:** `convex/billing.ts:391-420` (`receiveStripeEvent`), `convex/billing.ts:754-912` (`processStripeEvent`), `convex/http.ts:155-190` & `:218-253` (routes), `convex/crons.ts` (no re-drive).

**Problem:** The webhook route verifies the signature, calls `receiveStripeEvent`, and — only when `isNew` — schedules `processStripeEvent` via `ctx.scheduler.runAfter(0, …)` and **immediately returns `200`**. `processStripeEvent` runs asynchronously; on any throw it calls `markStripeEvent({ status: "failed", error })` and re-throws. Convex **does not auto-retry a failed scheduled action**. Stripe's own retry of the same event arrives at the route, hits `receiveStripeEvent`, finds the existing row, returns `{ isNew: false }`, and the route **returns `200` without re-scheduling**. There is no cron that re-scans `paymentEvents` for `status: "failed"` (or stale `"received"`/`"processing"`); `crons.ts` registers only `low-balance-check`.

```ts
// convex/billing.ts:899-910
} catch (error) {
  const message = error instanceof Error ? error.message.slice(0, 240) : "Stripe event processing failed";
  await ctx.runMutation(internal.billing.markStripeEvent, {
    stripeEventId: args.stripeEventId, status: "failed", error: message,
  });
  throw error;  // Convex does not retry this scheduled action
}
```

**Trigger:** Any transient failure inside `processStripeEvent` — Stripe API 5xx on `checkout.sessions.retrieve` / `listLineItems` / `paymentIntents.retrieve` / `charges.retrieve` / `disputes.retrieve`, a Convex transient, an OCC retry-exhaustion, or any thrown `Error` from `fulfillStripeSession` / `upsertPaidPayment` / `grantPaymentCredits` / `applyRefund` / `reversePaymentCredits` / `finalizeRefund` / `applyDispute` / `finalizeDispute`.

**Impact:**
- `checkout.session.completed` fails after `upsertPaidPayment` commits but before `grantPaymentCredits` → card charged, `payments.status = "paid"`, wallet **never credited**. UI shows the purchase as paid.
- `charge.refunded` fails → credits **never reversed** on a refund. Org keeps credited credits for a refunded charge.
- `charge.dispute.created` fails → disputed charge keeps its credits.

All three are silent and permanent. This is the single most dangerous defect in the file.

**Fix:** Add a re-drive cron that scans `paymentEvents` for `status: "failed"` (and stale `"received"`/`"processing"` past a deadline) and re-schedules `processStripeEvent`, with an attempt cap and backoff. Idempotency already holds at the ledger (`walletEntries.by_ref`) and payment (`payments.by_payment_intent`) layers, so re-execution is safe. Alternatively, have the route `await` processing and return non-2xx on failure so Stripe retries — but the durable re-drive cron is the correct fix since Stripe's retry window (≤3 days) is shorter than operational reality, and Stripe dedups by event id so its retries are already swallowed by `receiveStripeEvent`.

---

### [SEV: P0] Scheduler-failure variant: event stored as `"received"` but never processed when `runAfter(0, ...)` throws

**Location:** `convex/http.ts:182-188` & `:244-250` (schedule-after-receipt), `convex/billing.ts:391-420` (`receiveStripeEvent` commits before schedule).

**Problem:** The route calls `receiveStripeEvent` (a mutation that **commits** the `paymentEvents` row with `status: "received"`) and then calls `ctx.scheduler.runAfter(0, internal.billing.processStripeEvent, …)` as a **separate** operation. These are not in the same transaction. If the scheduler call throws (transient Convex error, function deployment in progress, rate limit), the route's httpAction throws → returns non-2xx → Stripe retries. On the retry, `receiveStripeEvent` finds the already-committed row, returns `{ isNew: false }`, and the route **returns `200` without scheduling**. The event is now permanently stuck in `status: "received"` with no `processStripeEvent` ever scheduled.

```ts
// convex/http.ts:178-191
const receipt = await ctx.runMutation(internal.billing.receiveStripeEvent, { … });  // commits
if (receipt.isNew) {
  await ctx.scheduler.runAfter(0, internal.billing.processStripeEvent, { … });  // if THIS throws…
}
return new Response(null, { status: 200 });  // …Stripe retries → isNew:false → never scheduled
```

**Trigger:** Any transient failure in `ctx.scheduler.runAfter` after the receipt mutation commits.

**Impact:** Same as P0 #1 — silent permanent money loss, but for a *different* failure point (scheduling, not processing). The event row exists in `"received"` status, which no cron re-scans.

**Fix:** Same re-drive cron as P0 #1 — scan for stale `status: "received"` rows (e.g., older than 5 minutes) and schedule `processStripeEvent`. The `receivedAt` timestamp is already persisted for this purpose.

---

### [SEV: P0] Refund/dispute reversal is not transactional — wallet ledger diverges from `payments` projection

**Location:** `convex/billing.ts:542-600` (`applyRefund` + `finalizeRefund`), `convex/billing.ts:604-655` (`applyDispute` + `finalizeDispute`), `convex/billing.ts:770-830` (caller in `processStripeEvent`), `convex/wallets.ts:138-186` (`appendWalletEntry`).

**Problem:** Reversal is split across **three separate Convex mutations** invoked sequentially from an action (not a single transaction):

1. `applyRefund` — **reads** `payment.reversedCredits`, computes `creditsToReverse` + `targetReversedCredits`, returns them. Commits nothing.
2. `reversePaymentCredits` — **appends** a `walletEntries` row (`-amount`) and patches `wallets.balance`/`sequence`. **Commits.**
3. `finalizeRefund` — **writes** `payment.reversedCredits = min(granted, targetReversedCredits)` and `status`. **Commits.**

If the action crashes (process restart, uncaught throw in step 2's scheduling, OOM, deployment) between step 2 and step 3, the wallet ledger is debited but `payment.reversedCredits` stays at its pre-step-1 value. The next refund event then calls `applyRefund`, reads the **stale** `reversedCredits`, recomputes `creditsToReverse` against the cumulative `totalRefundedAmount`, and debits the wallet **again** — overdrawing it. `finalizeRefund` then caps `payment.reversedCredits` to the cumulative target, **hiding** the over-debit. The authoritative ledger (`walletEntries`) and the projection (`payments.reversedCredits`) now disagree, and the projection is the smaller number — so the loss is invisible to any UI that reads `payments`.

```ts
// Three independent commits across an action boundary — not transactional:
const refund = await ctx.runMutation(internal.billing.applyRefund, { … });        // read-only commit
if (refund.creditsToReverse > 0) {
  await ctx.runMutation(internal.wallets.reversePaymentCredits, { … });          // WALLET DEBIT commits
}
await ctx.runMutation(internal.billing.finalizeRefund, { … });                    // PROJECTION commits
```

**Trigger:** Any partial failure between `reversePaymentCredits` and `finalizeRefund` (or `finalizeDispute`). Disputes have the identical shape.

**Impact:** Wallet balances become wrong with no alarm. An org can be debited 2× the refund amount while `payments.reversedCredits` reports the correct cumulative figure. Money integrity broken at the core ledger.

**Fix:** Make the reversal a **single** `internalMutation` that, in one Convex transaction, reads `payment`, re-derives the cumulative target, appends the `walletEntries` row (deduped by `refId`), patches `wallets`, and patches `payments.reversedCredits` + `status`. The current `applyRefund` → `reversePaymentCredits` → `finalizeRefund` split exists only to reuse the wallet-side helpers; fold the read+debit+projection into one transactional mutation.

---

### [SEV: P1] `upsertPaidPayment` commits `status: "paid"` before the wallet grant — a failed grant orphans a "paid" payment with zero credits

**Location:** `convex/billing.ts:657-710` (`fulfillStripeSession`), `convex/billing.ts:456-526` (`upsertPaidPayment` sets `status: "paid"`), `convex/billing.ts:696-707` (grant + `markPaymentGrantRecorded` after).

**Problem:** `fulfillStripeSession` calls `upsertPaidPayment` (which inserts/patches `payments.status = "paid"`) and only then calls `grantPaymentCredits`. If `grantPaymentCredits` throws (transient Convex error, OCC retry exhaustion, schema validation, anything), the `payments` row is already `paid` and the action throws → `markStripeEvent("failed")`. Per P0 #1, the event is never re-driven, so the grant never happens. The user has been charged, the system reports the payment as `paid`, and the wallet balance is unchanged.

```ts
// convex/billing.ts:689-706
const paid = await ctx.runMutation(internal.billing.upsertPaidPayment, { … });  // status: "paid" committed
await ctx.runMutation(internal.wallets.grantPaymentCredits, { … });              // if THIS throws…
await ctx.runMutation(internal.billing.markPaymentGrantRecorded, { … });          // …this never runs
```

**Impact:** Silent loss of purchased credits with no operational signal beyond a `failed` event row that nothing re-drives. The `getBillingState` UI shows the payment as `paid`, so support has no obvious clue that credits were never granted.

**Fix:** Set `payments.status = "pending"` in `upsertPaidPayment` and only flip to `"paid"` after `grantPaymentCredits` succeeds (the existing `markPaymentGrantRecorded` was clearly intended for this — see dead-code finding below). Or perform payment-upsert + grant in one transactional mutation. Pair with the re-drive cron in P0 #1.

---

### [SEV: P1] Concurrent refund events double-debit the wallet — event-scoped `refId` bypasses ledger dedup

**Location:** `convex/billing.ts:542-580` (`applyRefund` returns `refId: \`stripe:refund:${args.stripeRefundId}\``), `convex/billing.ts:778-781` (caller passes `stripeRefundId: args.stripeEventId`), `convex/wallets.ts:147-160` (dedup is `by_ref`).

**Problem:** The reversal `refId` is keyed by the **Stripe event id** (`stripe:refund:evt_…`), not by the refund id or the (charge, cumulative-target) pair. Stripe emits a separate `charge.refunded` event for each partial-refund action, each with a distinct `event.id`. `appendWalletEntry` dedups only by `refId`, so two distinct event ids produce two distinct ledger entries even when they target the same cumulative state. Two `processStripeEvent` actions running concurrently (Convex does not serialize actions per-key) both read `reversedCredits = 0`, both compute `creditsToReverse = X`, both append `-X`, and `finalizeRefund` then writes `reversedCredits = target` once — masking the double debit.

The OCC window in `appendWalletEntry` protects a *single* mutation's read-modify-write of `wallets.balance`, but the three-mutation `applyRefund` → `reversePaymentCredits` → `finalizeRefund` sequence spans three separate transactions — the read of `payment.reversedCredits` in step 1 is not OCC-coupled to the write in step 3.

**Trigger:** Two `charge.refunded` webhooks for the same charge delivered close in time — a partial refund followed quickly by another, or a Stripe retry arriving while the original is still processing (the route's `isNew` dedup does not gate the *already-scheduled* action).

**Impact:** Wallet over-debited; ledger and projection diverge (see P0 #3). Cumulative-refund math is only correct under strict serialization, which the code does not enforce.

**Fix:** Either (a) key the reversal `refId` by the cumulative target bucket (e.g., `stripe:refund:${chargeId}:${targetReversedCredits}`) so the dedup catches redundant work, or (b) perform the entire refund in one transactional mutation that re-reads `reversedCredits` inside the same OCC window as the append (this also fixes P0 #3).

---

### [SEV: P1] `finalizeDispute` is non-idempotent — re-driving double-counts `reversedCredits`

**Location:** `convex/billing.ts:640-655` (`finalizeDispute`), caller `convex/billing.ts:822-825`.

**Problem:** `finalizeDispute` writes:
```ts
reversedCredits: Math.min(payment.grantedCredits, payment.reversedCredits + args.creditsReversed),
```
This is **additive**. The wallet-side dedup (`reversePaymentCredits` by `refId = stripe:dispute:${disputeId}:created`) is idempotent, so the **ledger** is safe on re-drive. But `finalizeDispute` is **not** guarded by any idempotency check — if the dispute event is ever re-processed (a future re-drive cron per the P0 fix, or any retry), `payment.reversedCredits` is incremented again by `creditsReversed`, double-counting the projection. Once a re-drive cron lands (which it must, per P0 #1), this becomes a live bug.

The asymmetry with `applyRefund` is the root cause: `applyRefund` returns `targetReversedCredits` and `finalizeRefund` writes `reversedCredits = min(granted, target)` (a **set**, idempotent). `applyDispute` returns only `creditsToReverse` (no target), forcing `finalizeDispute` to be additive.

**Impact:** `payments.reversedCredits` overstates the reversal; combined with the wallet ledger being correct, the projection and ledger diverge.

**Fix:** Make `finalizeDispute` idempotent: have `applyDispute` return a `targetReversedCredits` (as `applyRefund` does) and set `reversedCredits = min(granted, target)`, not `reversed + creditsReversed`. Or fold into the single-transaction reversal mutation from P0 #3.

---

### [SEV: P1] `markStripeEvent("processing")` is outside the try/catch — a failure here crashes the action uncaught

**Location:** `convex/billing.ts:762-766`.

**Problem:**
```ts
const stripe = stripeClient();
await ctx.runMutation(internal.billing.markStripeEvent, {   // OUTSIDE try
  stripeEventId: args.stripeEventId, status: "processing",
});
try {
  switch (args.eventType) { … }
```
The `markStripeEvent("processing")` call is before the `try` block. If it throws (transient Convex error, OCC retry exhaustion, deployment in progress), the action throws with **no catch**, no `markStripeEvent("failed")`, and no `lastError` recorded. The event stays in `status: "received"` (or whatever prior status) with no signal that processing was even attempted. Combined with P0 #1 (no re-drive), this is another silent-drop path.

**Impact:** Events that fail at the `markStripeEvent("processing")` step are invisible to operators — they're not even marked `"failed"`, so a re-drive cron scanning for `status: "failed"` would miss them.

**Fix:** Move the `markStripeEvent("processing")` call inside the try block, or (better) make the entire action body one try/catch that always records a terminal status. Ensure the re-drive cron scans for stale `"received"` *and* `"processing"` rows, not just `"failed"`.

---

### [SEV: P1] `payment_intent.payment_failed` / `checkout.session.async_payment_failed` are silent no-ops — `checkoutIntents.status` is never set to `"failed"` or `"expired"`

**Location:** `convex/billing.ts:768-772` (the two no-op cases), `convex/billing.ts:226-247` (`prepareCheckoutIntent` sets `expiresAt` but nothing sweeps).

**Problem:** The switch handles `checkout.session.async_payment_failed` and `payment_intent.payment_failed` as **empty break statements** — no mutation, no status update, no `failureReason`. They fall through to `markStripeEvent("processed")`, so the event looks done. But the corresponding `checkoutIntents` row stays in `status: "open"` forever (or `"created"` if the session was never attached). The `checkoutIntents.status` union includes `"failed"` and `"expired"` literals, but **no code path in `billing.ts` ever writes either** (verified by grep across the whole `convex/` tree). Additionally, no cron sweeps expired intents (`expiresAt = now + 30min`), so stale `"open"`/`"created"` intents accumulate indefinitely.

```ts
case "checkout.session.async_payment_failed":
case "payment_intent.payment_failed":
  break;  // silent no-op — intent stays "open" forever
```

**Impact:**
- `getBillingState`'s `checkout` projection returns `status: "open"` for a failed/abandoned checkout, misleading the UI into showing a spinner or "in progress" state.
- `checkoutIntents` table grows unbounded with stale rows; `by_organization` index scans return dead intents.
- `payments.failureReason` (projected by `getBillingState`) is never written by any path, so the client can never surface why a checkout failed.

**Fix:** On `payment_intent.payment_failed` / `checkout.session.async_payment_failed`, patch the corresponding `checkoutIntents` row to `status: "failed"` (and optionally `payments.failureReason` if a payment row exists). Add a cron (or extend the re-drive cron) that sweeps `checkoutIntents` past `expiresAt` in `"created"`/`"open"` status and marks them `"expired"`.

---

### [SEV: P2] `payment_intent.succeeded` is not handled — no recovery for a missed `checkout.session.completed`

**Location:** `convex/billing.ts:766-895` (switch in `processStripeEvent`).

**Problem:** The switch handles `checkout.session.completed` and `checkout.session.async_payment_succeeded` but has no `payment_intent.succeeded` case. `payment_intent.payment_failed` is handled (no-op), but the success counterpart falls to `default` → `markStripeEvent("ignored")`. If the `checkout.session.completed` event is ever lost/dropped (per P0 #1, any transient failure permanently drops it), there is no secondary event to recover the grant.

The refund/dispute paths self-heal via `fulfillPaymentForCharge` (which lists checkout sessions by payment_intent), but a clean paid payment with no subsequent refund/dispute is **never recovered** — there is no scheduled reconciliation that scans for paid payment intents without a `payments` row.

**Impact:** A single missed checkout-completion event = permanently un-credited purchase. The customer's card is charged, no credits granted, no alarm.

**Fix:** Add `case "payment_intent.succeeded":` that resolves the checkout session (`stripe.checkout.sessions.list({ payment_intent })`) and calls `fulfillStripeSession`. Idempotency holds via `payments.by_payment_intent` + `walletEntries.by_ref`. Alternatively, add a reconciliation cron that scans Stripe for paid payment intents without a `payments` row.

---

### [SEV: P2] `checkout.session.completed` for async-payment methods is permanently marked `"failed"`

**Location:** `convex/billing.ts:670-680` (`fulfillStripeSession` immutable-facts check), `convex/billing.ts:766-773` (switch routes `completed` and `async_payment_succeeded` to the same function).

**Problem:** For asynchronous payment methods (bank transfer, etc.), Stripe fires `checkout.session.completed` with `payment_status: "unpaid"`, then later fires `checkout.session.async_payment_succeeded` once paid. `fulfillStripeSession` throws `"Stripe Checkout session does not match its immutable intent"` when `session.payment_status !== "paid"`. The catch in `processStripeEvent` marks the `completed` event `status: "failed"` with that error stored in `lastError`. The later `async_payment_succeeded` event recovers the grant, but the `completed` event is stuck `"failed"` forever and, per P0 #1, is never re-driven.

**Impact:** Misleading event state; noisy `lastError` on a non-error; and if the `async_payment_succeeded` event also fails (same P0 mechanism), the purchase is lost with the `completed` event already `"failed"` — obscuring the real failure point for operators.

**Fix:** Treat `payment_status: "unpaid"` on `checkout.session.completed` as a no-op (mark `"ignored"` or a dedicated `"waiting"` status), not a failure.

---

### [SEV: P2] `charge.dispute.closed` is not handled — `disabledReason` is set but never cleared; won disputes never restored

**Location:** `convex/billing.ts:604-635` (`applyDispute` sets `disabledReason: "Payment dispute under review"`), `convex/billing.ts:766-895` (switch has only `charge.dispute.created`).

**Problem:** `applyDispute` unconditionally sets `organizationPayments.disabledReason` on dispute creation. There is no `charge.dispute.closed` (or `charge.dispute.funded`/`won`/`lost`) case in the switch, so when a dispute is closed — including when the merchant **wins** — `disabledReason` is never cleared and the org's payment profile stays "under review" indefinitely. The reversal is also never adjusted on closure: a won dispute should arguably restore the reversed credits (the reversal was a hold, not a final loss).

Worse, `applyDispute` overwrites any existing `disabledReason` without preserving prior value — if the connect-account flow set `disabledReason: "Transfers: restricted…"`, a dispute clobbers it, and a future dispute-close handler clearing the field would lose the connect-account reason too.

**Impact:** Orgs that win disputes are permanently flagged disabled in the payment profile; `payouts.ts:331` blocks all transfers while `disabledReason !== undefined`, so won-dispute orgs cannot receive payouts. Support must manually clear `disabledReason`.

**Fix:** Add `charge.dispute.closed` handling that: on `status: "won"` clears `disabledReason` (restoring any prior connect-account reason — store dispute reason separately, not on the shared `disabledReason` field) and reverses the dispute reversal (restoring credits); on `status: "lost"` confirms the reversal as final. Use a dedicated `disputed` flag or a separate field rather than overloading `disabledReason`.

---

### [SEV: P2] `lastError` stores unredacted internal/SDK error text

**Location:** `convex/billing.ts:900-909`.

**Problem:**
```ts
const message = error instanceof Error
  ? error.message.slice(0, 240)
  : "Stripe event processing failed";
await ctx.runMutation(internal.billing.markStripeEvent, {
  stripeEventId: args.stripeEventId, status: "failed", error: message,
});
```
Arbitrary `Error.message` from Stripe SDK, Convex internals, or thrown application errors is persisted verbatim (truncated to 240 chars) into `paymentEvents.lastError`. This can include request URLs, internal ids, stack-adjacent text, or PII. While not returned to clients by `getBillingState` (which does not project `lastError`), it is durable PII-adjacent operational data with no redaction.

**Impact:** Sensitive internal detail persisted indefinitely; surface area for log/DB access leakage.

**Fix:** Map known error classes to stable codes (`"stripe_api_error"`, `"intent_mismatch"`, `"unknown"`) and store the code, not the raw message. Keep raw text in `console.error` only.

---

### [SEV: P2] `upsertPaidPayment` existing-payment path does not verify the checkout session matches

**Location:** `convex/billing.ts:493-520` (`existing !== null` branch).

**Problem:** When a `payments` row already exists for the payment intent (`by_payment_intent`), the handler checks `existing.organizationId !== intent.organizationId` but **not** `existing.stripeCheckoutSessionId !== args.stripeCheckoutSessionId` nor `existing.checkoutIntentId !== intent._id`. It then patches `stripeChargeId` and `status: "paid"`, and patches `intent.status = "complete"` for the *current* intent. If a payment intent were ever associated with a second checkout session (Stripe does not do this for Checkout Sessions today, but the code does not enforce it), the second session's charge would be silently attributed to the first session's payment row, and the second intent would be flipped to `"complete"` while the payment still references the first.

**Impact:** Defense-in-depth gap; incorrect attribution if Stripe ever relaxes PI reuse or a manual replay supplies a mismatched pair.

**Fix:** Assert `existing.stripeCheckoutSessionId === args.stripeCheckoutSessionId` and `existing.checkoutIntentId === intent._id` in the existing-payment branch; throw on mismatch.

---

### [SEV: P2] `fulfillPaymentForCharge` silently no-ops when no Checkout session is found — masks missing payment rows

**Location:** `convex/billing.ts:737-745`.

**Problem:**
```ts
const session = sessions.data[0];
if (session !== undefined) {
  await fulfillStripeSession(ctx, stripe, session.id);
}
```
If `stripe.checkout.sessions.list({ payment_intent })` returns empty (session lookup miss, or a charge not created via Checkout), the function returns silently. The caller (`charge.refunded` / `charge.dispute.created`) then proceeds to `applyRefund`/`applyDispute`, which look up `payments.by_charge`; if no payment row was ever created (because fulfillment never ran), both return `{ kind: "ignored" }` and the refund/dispute is silently dropped. The event is then marked `"processed"` (not `"failed"`), so the P0 re-drive (once added) would not pick it up.

**Impact:** A refund or dispute for an un-fulfilled charge is dropped silently; the event is marked `"processed"`, not `"failed"`, so no re-drive would recover it.

**Fix:** When `session === undefined` and no `payments` row exists for the charge, mark the event `"failed"` (or a dedicated `"unfulfillable"`) so it is visible and re-drivable, rather than `"processed"`.

---

### [SEV: P2] `createCheckout` can orphan Stripe customers on concurrent first-checkout

**Location:** `convex/billing.ts:333-388` (`createCheckout` action), `convex/billing.ts:295-309` (`setStripeCustomer`).

**Problem:** Two members of the same org starting the org's first checkout concurrently both observe `prepared.stripeCustomerId === null`, both call `stripe.customers.create({ idempotencyKey: \`customer:${organizationId}\` })`. Stripe's idempotency key dedups within its window, but if the two requests land outside that window (or the key has aged out — Stripe's window is ~24h), two distinct customers are created. `setStripeCustomer` keeps whichever wins the race (`profile.stripeCustomerId !== undefined && !== args.stripeCustomerId` → returns existing) and the other customer is orphaned in Stripe with no reference.

**Impact:** Orphaned Stripe customer records; potential confusion if the loser customer is later billed by Stripe for unrelated activity; future `customer:${organizationId}` idempotency key may return the orphaned customer on a fresh create.

**Fix:** Make `setStripeCustomer` the single source of truth — call `stripe.customers.create` only after a `setStripeCustomer`-style mutation confirms the profile still lacks a customer (lookup-then-create inside one mutation, or a unique constraint). At minimum, log/warn when a created customer is discarded.

---

### [SEV: P2] `markPaymentGrantRecorded` is dead code — its guard never holds

**Location:** `convex/billing.ts:528-540`.

**Problem:** The handler only patches when `payment.status === "pending"`:
```ts
if (payment.status === "pending") {
  await ctx.db.patch(payment._id, { status: "paid", updatedAt: Date.now() });
}
```
But `upsertPaidPayment` (the only producer of the payment row, called immediately before this in `fulfillStripeSession`) always sets `status: "paid"` — on both the insert path (line 511) and the patch path (line 489). So `payment.status` is never `"pending"` here, the guard is always false, and the function is a no-op. Its name and docstring ("record the grant") imply it is the post-grant status flip; in reality it does nothing, which is exactly the gap that P1 #4 exploits.

**Impact:** Misleading control flow; the intended pending→paid transition is absent, so a failed grant leaves the payment looking complete.

**Fix:** Make `upsertPaidPayment` insert/patch as `"pending"` and let `markPaymentGrantRecorded` flip to `"paid"` after `grantPaymentCredits` succeeds (delete the `if` guard — always patch to `"paid"`).

---

### [SEV: P2] `getBillingState` projects `failureReason` (never written) but omits `reversedCredits`

**Location:** `convex/billing.ts:955-965` (projection), `convex/billing.ts:456-655` (no `failureReason` writer anywhere).

**Problem:** The payments projection includes `failureReason: payment.failureReason`, but no code path in `billing.ts` ever sets `payments.failureReason` (verified by grep). The field is always `undefined`. Dead projection that implies a failure surface which does not exist. Simultaneously, the projection omits `reversedCredits`, so for a `partially_refunded` or `disputed` payment, the client cannot display how much was reversed — it sees `credits = payment.grantedCredits` (the gross grant) with no indication that some were reversed.

**Impact:** Client UI that keys off `failureReason` will never show a reason; client UI showing payment history cannot distinguish a fully-granted payment from a partially-refunded one.

**Fix:** Either wire `failureReason` on the failure paths (`payment_intent.payment_failed`, async payment failed) or drop it from the projection. Add `reversedCredits` to the projection so the client can compute net credits (`grantedCredits - reversedCredits`).

---

### [SEV: P2] `applyRefund` parameter `stripeRefundId` actually receives the Stripe event id — misleading name + wrong idempotency domain

**Location:** `convex/billing.ts:542-545` (arg name), `convex/billing.ts:573` (used in `refId`), `convex/billing.ts:778-781` (caller passes `args.stripeEventId`).

**Problem:** The argument is named `stripeRefundId` and used to build `refId: \`stripe:refund:${args.stripeRefundId}\``, but the caller passes `stripeRefundId: args.stripeEventId`. So the value is the **event** id, not the refund id. The resulting `refId` is `stripe:refund:evt_…` — event-scoped, not refund-scoped. This is the root of P1 #5 (concurrent double-debit). The parameter name actively misleads readers about the idempotency domain: a reviewer reading `applyRefund({ stripeRefundId, … })` assumes dedup is per-refund, but it is per-event.

**Impact:** Reviewer/maintainer confusion; the idempotency key looks refund-scoped but is event-scoped, masking the double-debit risk.

**Fix:** Rename the parameter to `stripeEventId` (matching the caller), or — better, if refund-scoped dedup is desired — pass the actual refund id from the charge object (`charge.refunds.data[0].id` or the refund from the event) and key the `refId` off it (but note this changes idempotency semantics; pair with the P1 #5 fix).

---

### [SEV: P3] `cycleBreakdown` — unbounded `.collect()` + N+1 project lookups + redundant reduce

**Location:** `convex/billing.ts:985-1048`.

**Problem:** `ctx.db.query("usageEvents").withIndex("by_org_at", …).collect()` loads an entire org-month of usage events into memory, then `Promise.all([...byProject.entries()].map(async ([projectId, row]) => ctx.db.get(projectId)))` performs one `db.get` per distinct project. For a high-volume org (millions of calls/month) this is O(monthly calls) memory and O(projects) round-trips. Also, `totalCredits` is computed both in the `byKey`/`byProject` loops *and* again via `events.reduce` — redundant.

**Impact:** Performance degradation and memory pressure for active orgs; not a correctness bug.

**Fix:** Paginate or aggregate server-side; fetch projects via a single `db` batch query; drop the redundant `reduce`.

---

### [SEV: P3] `stripeClient()` constructs a new `Stripe` instance per call

**Location:** `convex/billing.ts:128-133`.

**Problem:** Every `createCheckout`, every `processStripeEvent`, and every webhook route verification instantiates a fresh `new Stripe(secretKey, …)`. Cheap but not free, and called on the hot webhook path (every Stripe event).

**Impact:** Negligible per-call overhead; not a correctness bug.

**Fix:** Memoize per-process (module-level lazy singleton).

---

### [SEV: P3] `createCheckout` has no client-idempotency — double-click creates two intents and two Stripe sessions

**Location:** `convex/billing.ts:226-247` (`prepareCheckoutIntent` always inserts), `convex/billing.ts:333-388` (`createCheckout` always proceeds).

**Problem:** A double-click on "Buy" calls `createCheckout` twice. `prepareCheckoutIntent` inserts a new `checkoutIntents` row each time (no idempotency key from the client), and `createHostedCheckout` uses `idempotencyKey: \`checkout:${checkoutIntentId}\`` — which differs per intent, so Stripe creates two distinct Checkout Sessions. One is abandoned. Combined with the missing expired-intent sweep (P1 #8), abandoned intents accumulate.

**Impact:** Orphaned intents/sessions; cluttered `checkoutIntents` table; minor Stripe session overhead.

**Fix:** Accept an optional client-supplied idempotency key on `createCheckout` and reuse it to short-circuit duplicate intent creation, or dedupe pending intents for the same (org, pack) within a short window.

---

### [SEV: P3] `receiveStripeEvent` increments `attempts` without bound on duplicate delivery

**Location:** `convex/billing.ts:391-420`.

**Problem:** On duplicate delivery (`existing !== null`), the handler patches `attempts: existing.attempts + 1` with no cap. A misconfigured Stripe endpoint or a retry storm could inflate `attempts` unboundedly. Not a money bug, but unbounded counter growth with no alerting.

**Impact:** Unbounded counter; minor.

**Fix:** Cap `attempts` at a reasonable maximum or stop incrementing past a threshold; the counter is informational only.

---

### [SEV: P3] `processStripeEvent` `default` case returns early but `payment_intent.payment_failed` falls through to `"processed"`

**Location:** `convex/billing.ts:768-899`.

**Problem:** The `default` case marks `"ignored"` and `return`s (correct). But `payment_intent.payment_failed` and `checkout.session.async_payment_failed` are empty `break` cases that fall through to the post-switch `markStripeEvent("processed")` (line 896). A failed payment is thus recorded as `"processed"` with no signal that anything was skipped. This is semantically misleading: `"processed"` implies a money movement or state transition occurred, but neither did.

**Impact:** Misleading event state; operators scanning for un-fulfilled payments cannot distinguish "successfully processed" from "no-op failure".

**Fix:** Mark these cases as `"ignored"` (or a dedicated `"no_op"` status), not `"processed"`.

---

## Summary

- **Findings:** 22 (P0: 3, P1: 5, P2: 9, P3: 5)
- **Prior review verified:** all 18 prior findings confirmed against current source (2 P0, 2 P1, 9 P2, 5 P3). The prior P0 #1 (no re-drive) is confirmed and **expanded** into a distinct P0 #2 (scheduler-failure variant: event committed as `"received"` but `runAfter` throws → Stripe retry dedupes → stuck forever).
- **New findings added:** 4
  - **[P0 #2]** Scheduler-failure variant of the re-drive gap — `receiveStripeEvent` commits before `runAfter(0, ...)`; if scheduling throws, Stripe's retry hits `isNew: false` and the event is never scheduled. Stuck in `"received"`, which no cron re-scans.
  - **[P1 #6]** `finalizeDispute` is non-idempotent — additive `reversedCredits + creditsReversed` double-counts on re-drive (the ledger is safe via `refId`, but the projection diverges). Root cause is the asymmetry: `applyRefund` returns `targetReversedCredits`, `applyDispute` does not.
  - **[P1 #7]** `markStripeEvent("processing")` is outside the try/catch — a transient failure here crashes the action with no `markStripeEvent("failed")` and no `lastError`; the event is invisible to operators and to a `status: "failed"` re-drive scan.
  - **[P1 #8]** `payment_intent.payment_failed` / `checkout.session.async_payment_failed` are silent no-ops — `checkoutIntents.status` is never set to `"failed"` or `"expired"` by any code path; stale intents accumulate; `failureReason` is never written; no expired-intent sweep cron exists.

### Top 3

1. **[P0 #1 + #2 + #3] The money-movement pipeline is non-transactional, non-retried, and non-re-driven.** `receiveStripeEvent` dedupes Stripe's retry away (`isNew: false` → no re-schedule); `processStripeEvent` marks failures `"failed"` and re-throws (Convex doesn't auto-retry); the route `200`s before processing; `markStripeEvent("processing")` sits outside the try; the scheduler call can throw after the receipt commits; and no cron re-scans `paymentEvents` for `failed`/stale `received`/`processing`. Any transient failure permanently and silently drops a grant / refund reversal / dispute. The refund/dispute reversal is further split across 3 independent mutations (`applyRefund` → `reversePaymentCredits` → `finalizeRefund`), so a crash mid-sequence leaves the ledger debited but the projection stale, and the next event over-debits. **Fix:** add a re-drive cron over `paymentEvents` (idempotency holds downstream) and fold each money operation into a single transactional `internalMutation`.

2. **[P1 #5] Concurrent refund events double-debit the wallet.** The reversal `refId` is event-scoped (`stripe:refund:${eventId}`), so two distinct refund events for the same charge bypass `walletEntries.by_ref` dedup and both append `-amount`. `finalizeRefund` then caps the projection to the cumulative target, hiding the over-debit. The OCC window in `appendWalletEntry` protects a single mutation but not the three-mutation read-debit-write span. **Fix:** key the `refId` by the cumulative target bucket, or perform the reversal in one transactional mutation.

3. **[P1 #4 + #8 + dead-code] The pending→paid transition for payments is absent, and failed checkouts are silently abandoned.** `upsertPaidPayment` commits `status: "paid"` before `grantPaymentCredits` runs; if the grant fails (per P0 #1, unrecoverable), the payment looks paid with zero credits. `markPaymentGrantRecorded` was clearly intended to flip pending→paid post-grant, but its guard never holds (dead code) because `upsertPaidPayment` already set `"paid"`. Separately, `payment_intent.payment_failed` and `checkout.session.async_payment_failed` are no-ops that never set `checkoutIntents.status = "failed"` (no code path writes `"failed"` or `"expired"` for intents), so failed/abandoned checkouts stay `"open"` forever with no expired-intent sweep. **Fix:** insert payments as `"pending"`, flip to `"paid"` only after grant; handle failure events by marking intents `"failed"`; add an expired-intent sweep cron.

### Cross-cutting root cause

The file's core design — splitting a single logical money operation (grant / refund / dispute) across multiple `internalMutation` calls from an `internalAction` — is the common root of P0 #1, P0 #2, P0 #3, P1 #4, P1 #5, P1 #6, and P1 #7. The action boundary is not transactional, Convex does not retry failed scheduled actions, and the HTTP route returns `200` before processing begins. The ledger primitive (`appendWalletEntry`) is correct in isolation; the orchestration above it is not. Until (a) the re-drive cron lands, (b) each money operation is folded into a single transactional mutation, and (c) the pending→paid transition is restored, **this file is unsafe to ship for real money.**

### Test coverage gaps

The existing tests (`stripe-billing.test.ts`) cover: pack catalogue immutability, duplicate-event receipt dedup, idempotent grant under repeated `upsertPaidPayment` + `grantPaymentCredits`, signature verification, cumulative refund capping, and dispute-as-debt. They do **not** cover:
- Concurrent refund event delivery (P1 #5 double-debit) — the most dangerous money bug after the P0s.
- Failure/re-drive paths — no test simulates a `processStripeEvent` throw + re-drive.
- `payment_intent.succeeded` recovery (P2 #9).
- `checkout.session.completed` with `payment_status: "unpaid"` (P2 #10).
- `charge.dispute.closed` handling (P2 #11 — doesn't exist).
- `createCheckout` customer-orphan race (P2 #13).
- Failed-checkout intent status transition (P1 #8 — doesn't exist).
- `markPaymentGrantRecorded` dead-code guard (P2 #14 — the test would assert the no-op).

The tests assert the happy-path idempotency contracts but not the failure/concurrency contracts that actually determine money safety.
