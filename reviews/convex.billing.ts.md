# Tiger-Style Review — `convex/billing.ts`

## Verdict

**Incorrect — do not merge.** Billing = money, and this file has two independent
P0-class money-integrity defects: (1) failed Stripe webhook events are never
re-driven (no retry, no cron, the HTTP route `200`s before processing), so any
transient failure permanently drops a credit grant / refund reversal / dispute;
and (2) the refund and dispute reversal paths perform read → wallet-debit →
projection-write as three separate mutations across an action boundary with no
transactional coupling, so a crash mid-sequence (or two concurrent refund
events) diverges the authoritative wallet ledger from the `payments` projection.
Surrounding those are real secondary defects: dead code, missing event handlers,
non-idempotent finalize, and unredacted error storage.

## File Stats

- File: `convex/billing.ts` — 1048 lines
- Exports reviewed: 19 functions (queries/mutations/actions/helpers)
- Webhook ingress: `convex/http.ts` (`/stripe-webhook`, `/stripe-connect-webhook`, `/stripe-connect-v2-webhook`)
- Ledger grant path: `convex/wallets.ts` `grantPaymentCredits` / `reversePaymentCredits` / `appendWalletEntry`
- Schema: `convex/schema.ts` (`paymentEvents`, `payments`, `checkoutIntents`, `wallets`, `walletEntries`, `organizationPayments`)
- Cron: `convex/crons.ts` + `convex/cronTasks.ts` (only `low-balance-check`; **no failed-event re-drive**)

---

## Findings

### [SEV: P0] Failed Stripe webhook events are never reprocessed — permanent money loss

**Location:** `convex/billing.ts:391-420` (`receiveStripeEvent`), `convex/billing.ts:754-912` (`processStripeEvent`), `convex/http.ts:155-190` (route), `convex/crons.ts` (no re-drive).

**Problem:** The webhook route verifies the signature, calls `receiveStripeEvent`, and — only when `isNew` — schedules `processStripeEvent` via `ctx.scheduler.runAfter(0, …)` and **immediately returns `200`**. `processStripeEvent` runs asynchronously; on any throw it calls `markStripeEvent({ status: "failed", error })` and re-throws. Convex does not auto-retry a failed scheduled action. Stripe's own retry of the same event arrives at the route, hits `receiveStripeEvent`, finds the existing row, returns `{ isNew: false }`, and the route **returns `200` without re-scheduling**. There is no cron that re-scans `paymentEvents` for `status: "failed"` (or stale `"processing"`); `crons.ts` registers only `low-balance-check`.

**Trigger:** Any transient failure inside `processStripeEvent` — Stripe API 5xx on `stripe.checkout.sessions.retrieve` / `listLineItems` / `paymentIntents.retrieve` / `charges.retrieve`, a Convex transient, or any thrown `Error` from `fulfillStripeSession` / `upsertPaidPayment` / `grantPaymentCredits` / `applyRefund` / `reversePaymentCredits` / `finalizeRefund` / `applyDispute` / `finalizeDispute`.

**Impact:** A `checkout.session.completed` event that fails after `upsertPaidPayment` commits but before `grantPaymentCredits` → the user's card is charged, the `payments` row is `status: "paid"`, and the wallet is **never credited**. A `charge.refunded` event that fails → credits are **never reversed** on a refund. A `charge.dispute.created` that fails → disputed charge keeps its credits. All three are silent and permanent. This is the single most dangerous defect in the file.

**Fix:** Add a re-drive cron that scans `paymentEvents` for `status: "failed"` (and stale `"processing"` past a deadline) and re-schedules `processStripeEvent`, with an attempt cap. Idempotency already holds at the ledger (`walletEntries.by_ref`) and payment (`payments.by_payment_intent`) layers, so re-execution is safe. Alternatively, have the route `await` processing and return non-2xx on failure so Stripe retries — but the durable re-drive cron is the correct fix since Stripe's retry window (≤3 days) is shorter than operational reality.

---

### [SEV: P0] Refund/dispute reversal is not transactional — wallet ledger diverges from `payments` projection

**Location:** `convex/billing.ts:542-600` (`applyRefund` + `finalizeRefund`), `convex/billing.ts:604-655` (`applyDispute` + `finalizeDispute`), `convex/billing.ts:770-830` (caller in `processStripeEvent`), `convex/wallets.ts:138-186` (`appendWalletEntry`).

**Problem:** Reversal is split across **three separate Convex mutations** invoked sequentially from an action (not a single transaction):

1. `applyRefund` — **reads** `payment.reversedCredits`, computes `creditsToReverse` + `targetReversedCredits`, returns them. Commits nothing.
2. `reversePaymentCredits` — **appends** a `walletEntries` row (`-amount`) and patches `wallets.balance`/`sequence`. Commits.
3. `finalizeRefund` — **writes** `payment.reversedCredits = min(granted, targetReversedCredits)` and `status`. Commits.

If the action crashes (process restart, uncaught throw in step 2's scheduling, OOM) between step 2 and step 3, the wallet ledger is debited but `payment.reversedCredits` stays at its pre-step-1 value. The next refund event then calls `applyRefund`, reads the **stale** `reversedCredits`, recomputes `creditsToReverse` against the cumulative `totalRefundedAmount`, and debits the wallet **again** — overdrawing it. `finalizeRefund` then caps `payment.reversedCredits` to the cumulative target, **hiding** the over-debit. The authoritative ledger (`walletEntries`) and the projection (`payments.reversedCredits`) now disagree, and the projection is the smaller number — so the loss is invisible to any UI that reads `payments`.

**Trigger:** Any partial failure between `reversePaymentCredits` and `finalizeRefund` (or `finalizeDispute`). Disputes have the identical shape.

**Impact:** Wallet balances become wrong with no alarm. A org can be debited 2× the refund amount while `payments.reversedCredits` reports the correct cumulative figure. Money integrity broken at the core ledger.

**Fix:** Make the reversal a **single** mutation that, in one Convex transaction, reads `payment`, re-derives the cumulative target, appends the `walletEntries` row (deduped by `refId`), patches `wallets`, and patches `payments.reversedCredits` + `status`. The current `applyRefund` → `reversePaymentCredits` → `finalizeRefund` split exists only to reuse `grantPaymentCredits`/`reversePaymentCredits`; fold the read+write into one `internalMutation`.

---

### [SEV: P1] Concurrent refund events double-debit the wallet (event-scoped `refId` bypasses ledger dedup)

**Location:** `convex/billing.ts:542-580` (`applyRefund` returns `refId: \`stripe:refund:${args.stripeRefundId}\``), `convex/billing.ts:778-797` (caller passes `stripeRefundId: args.stripeEventId`), `convex/wallets.ts:147-160` (dedup is `by_ref`).

**Problem:** The reversal `refId` is keyed by the **Stripe event id** (`stripe:refund:evt_…`), not by the refund id or the (charge, cumulative-target) pair. Stripe emits a separate `charge.refunded` event for each partial-refund action, each with a distinct `event.id`. `appendWalletEntry` dedups only by `refId`, so two distinct event ids produce two distinct ledger entries even when they target the same cumulative state. Two `processStripeEvent` actions running concurrently (Convex does not serialize actions per-key) both read `reversedCredits = 0`, both compute `creditsToReverse = X`, both append `-X`, and `finalizeRefund` then writes `reversedCredits = target` once — masking the double debit.

**Trigger:** Two `charge.refunded` webhooks for the same charge delivered close in time (e.g., a partial refund followed quickly by another, or a Stripe retry arriving while the original is still processing — note the route's `isNew` dedup does not gate the *already-scheduled* action).

**Impact:** Wallet over-debited; ledger and projection diverge (see P0 above). Cumulative-refund math is only correct under strict serialization, which the code does not enforce.

**Fix:** Either (a) key the reversal `refId` by the cumulative target bucket (e.g., `stripe:refund:${chargeId}:${targetReversedCredits}`) so the dedup catches redundant work, or (b) perform the entire refund in one transactional mutation that re-reads `reversedCredits` inside the same OCC window as the append (this also fixes the P0 above).

---

### [SEV: P1] `upsertPaidPayment` commits `status: "paid"` before the wallet grant — a failed grant orphans a "paid" payment with zero credits

**Location:** `convex/billing.ts:657-710` (`fulfillStripeSession`), `convex/billing.ts:456-526` (`upsertPaidPayment` sets `status: "paid"`), `convex/billing.ts:696-707` (grant + `markPaymentGrantRecorded` after).

**Problem:** `fulfillStripeSession` calls `upsertPaidPayment` (which inserts/patches `payments.status = "paid"`) and only then calls `grantPaymentCredits`. If `grantPaymentCredits` throws (transient Convex error, schema validation, anything), the `payments` row is already `paid` and the action throws → `markStripeEvent("failed")`. Per the P0 finding, the event is never re-driven, so the grant never happens. The user has been charged, the system reports the payment as `paid`, and the wallet balance is unchanged.

**Impact:** Silent loss of purchased credits with no operational signal beyond a `failed` row that nothing re-drives. The `getBillingState` UI shows the payment as `paid`, so support has no obvious clue that credits were never granted.

**Fix:** Either set `payments.status = "pending"` in `upsertPaidPayment` and only flip to `"paid"` after `grantPaymentCredits` succeeds (the existing `markPaymentGrantRecorded` was clearly intended for this — see dead-code finding), or perform payment-upsert + grant in one transactional mutation. Either way, pair with the re-drive cron in the P0 finding.

---

### [SEV: P2] `markPaymentGrantRecorded` is dead code — its guard never holds

**Location:** `convex/billing.ts:528-540`.

**Problem:** The handler only patches when `payment.status === "pending"`:
```ts
if (payment.status === "pending") {
  await ctx.db.patch(payment._id, { status: "paid", updatedAt: Date.now() });
}
```
But `upsertPaidPayment` (the only producer of the payment row, called immediately before this in `fulfillStripeSession`) always sets `status: "paid"` — on both the insert path (line 511) and the patch path (line 489). So `payment.status` is never `"pending"` here, the guard is always false, and the function is a no-op. Its name and docstring ("record the grant") imply it is the post-grant status flip; in reality it does nothing, which is exactly the gap the P1 above exploits.

**Impact:** Misleading control flow; the intended pending→paid transition is absent, so a failed grant leaves the payment looking complete.

**Fix:** Make `upsertPaidPayment` insert/patch as `"pending"` and let `markPaymentGrantRecorded` flip to `"paid"` after `grantPaymentCredits` succeeds (delete the `if` guard — always patch to `"paid"`).

---

### [SEV: P2] `payment_intent.succeeded` is not handled — no recovery for a missed `checkout.session.completed`

**Location:** `convex/billing.ts:766-895` (switch in `processStripeEvent`).

**Problem:** The switch handles `checkout.session.completed` and `checkout.session.async_payment_succeeded` but has no `payment_intent.succeeded` case. `payment_intent.payment_failed` is handled (no-op), but the success counterpart falls to `default` → `markStripeEvent("ignored")`. If the `checkout.session.completed` event is ever lost/dropped (per the P0 finding, any transient failure permanently drops it), there is no secondary event to recover the grant.

**Impact:** A single missed checkout-completion event = permanently un-credited purchase. The refund/dispute paths use `fulfillPaymentForCharge` (which lists checkout sessions by payment_intent) to self-heal, but a clean paid payment with no subsequent refund/dispute is never recovered.

**Fix:** Add `case "payment_intent.succeeded":` that resolves the checkout session and calls `fulfillStripeSession`. Idempotency holds via `payments.by_payment_intent` + `walletEntries.by_ref`.

---

### [SEV: P2] `checkout.session.completed` for async-payment methods is permanently marked `"failed"`

**Location:** `convex/billing.ts:670-680` (`fulfillStripeSession` immutable-facts check), `convex/billing.ts:754-895` (switch routes `completed` and `async_payment_succeeded` to the same function).

**Problem:** For asynchronous payment methods (bank transfer, etc.), Stripe fires `checkout.session.completed` with `payment_status: "unpaid"`, then later fires `checkout.session.async_payment_succeeded` once paid. `fulfillStripeSession` throws `"Stripe Checkout session does not match its immutable intent"` when `session.payment_status !== "paid"`. The catch in `processStripeEvent` marks the `completed` event `status: "failed"` with that error stored in `lastError`. The later `async_payment_succeeded` event recovers the grant, but the `completed` event is stuck `"failed"` forever and, per the P0 finding, is never re-driven.

**Impact:** Misleading event state; noisy `lastError` on a non-error; and if the `async_payment_succeeded` event also fails (same P0 mechanism), the purchase is lost with the `completed` event already "failed" — obscuring the real failure point.

**Fix:** Treat `payment_status: "unpaid"` on `checkout.session.completed` as a no-op (mark `"ignored"` or a dedicated `"waiting"` status), not a failure.

---

### [SEV: P2] `charge.dispute.closed` is not handled — `disabledReason` is set but never cleared; won disputes never restored

**Location:** `convex/billing.ts:604-635` (`applyDispute` sets `disabledReason: "Payment dispute under review"`), `convex/billing.ts:766-895` (switch has only `charge.dispute.created`).

**Problem:** `applyDispute` unconditionally sets `organizationPayments.disabledReason` on dispute creation. There is no `charge.dispute.closed` (or `charge.dispute.funded`/`won`/`lost`) case in the switch, so when a dispute is closed — including when the merchant **wins** — `disabledReason` is never cleared and the org's payment profile stays "under review" indefinitely. The reversal is also never adjusted on closure (a won dispute should arguably restore the reversed credits).

**Impact:** Orgs that win disputes are permanently flagged disabled in the payment profile; support must manually clear `disabledReason`.

**Fix:** Add `charge.dispute.closed` handling that clears `disabledReason` on `status: "won"` and adjusts reversal on `status: "lost"` (credits already reversed at creation, so loss is a no-op; win should reverse the reversal).

---

### [SEV: P2] `finalizeDispute` is non-idempotent — re-driving double-counts `reversedCredits`

**Location:** `convex/billing.ts:640-655` (`finalizeDispute`), caller `convex/billing.ts:822-825`.

**Problem:** `finalizeDispute` writes:
```ts
reversedCredits: Math.min(
  payment.grantedCredits,
  payment.reversedCredits + args.creditsReversed,
),
```
This is additive. The wallet-side dedup (`reversePaymentCredits` by `refId = stripe:dispute:${disputeId}:created`) is idempotent, so the **ledger** is safe on re-drive. But `finalizeDispute` is **not** guarded by any idempotency check — if the dispute event is ever re-processed (a future re-drive cron per the P0 fix, or any retry), `payment.reversedCredits` is incremented again by `creditsReversed`, double-counting the projection. Once a re-drive cron lands (which it must, per P0), this becomes a live bug.

**Impact:** `payments.reversedCredits` overstates the reversal; combined with the wallet ledger being correct, the projection and ledger diverge.

**Fix:** Make `finalizeDispute` idempotent: compute the target from the dispute state (as `finalizeRefund` does with `targetReversedCredits`) and set `reversedCredits = min(granted, target)`, not `reversed + creditsReversed`. Or fold into the single-transaction reversal mutation from the P0 fix.

---

### [SEV: P2] `lastError` stores unredacted internal/SDK error text

**Location:** `convex/billing.ts:900-909`.

**Problem:**
```ts
const message =
  error instanceof Error
    ? error.message.slice(0, 240)
    : "Stripe event processing failed";
await ctx.runMutation(internal.billing.markStripeEvent, {
  stripeEventId: args.stripeEventId,
  status: "failed",
  error: message,
});
```
Arbitrary `Error.message` from Stripe SDK, Convex internals, or thrown application errors is persisted verbatim (truncated to 240 chars) into `paymentEvents.lastError`. This can include request URLs, internal ids, or stack-adjacent text. While not returned to clients by `getBillingState` (which does not project `lastError`), it is durable PII-adjacent operational data with no redaction.

**Impact:** Sensitive internal detail persisted indefinitely; surface area for log/DB access leakage.

**Fix:** Map known error classes to stable codes (`"stripe_api_error"`, `"intent_mismatch"`, `"unknown"`) and store the code, not the raw message. Keep raw text in `console.error` only.

---

### [SEV: P2] `upsertPaidPayment` existing-payment path does not verify the checkout session matches

**Location:** `convex/billing.ts:493-520` (`existing !== null` branch).

**Problem:** When a `payments` row already exists for the payment intent (`by_payment_intent`), the handler checks `existing.organizationId !== intent.organizationId` but **not** `existing.stripeCheckoutSessionId !== args.stripeCheckoutSessionId`. It then patches `stripeChargeId` and `status: "paid"`. If a payment intent were ever associated with a second checkout session (Stripe does not do this for Checkout Sessions today, but the code does not enforce it), the second session's charge would be silently attributed to the first session's payment row, and `intent.status` would be flipped to `"complete"` for the second intent while the payment still references the first.

**Impact:** Defense-in-depth gap; incorrect attribution if Stripe ever relaxes PI reuse or a manual replay supplies a mismatched pair.

**Fix:** Assert `existing.stripeCheckoutSessionId === args.stripeCheckoutSessionId` (and `existing.checkoutIntentId === intent._id`) in the existing-payment branch; throw on mismatch.

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
If `stripe.checkout.sessions.list({ payment_intent })` returns empty (session lookup miss, or a charge not created via Checkout), the function returns silently. The caller (`charge.refunded` / `charge.dispute.created`) then proceeds to `applyRefund`/`applyDispute`, which look up `payments.by_charge`; if no payment row was ever created (because fulfillment never ran), both return `{ kind: "ignored" }` and the refund/dispute is silently dropped with no event-level signal.

**Impact:** A refund or dispute for an un-fulfilled charge is dropped silently; the event is marked `"processed"`, not `"failed"`, so the P0 re-drive (once added) would not pick it up.

**Fix:** When `session === undefined` and no `payments` row exists for the charge, mark the event `"failed"` (or a dedicated `"unfulfillable"`) so it is visible and re-drivable, rather than `"processed"`.

---

### [SEV: P2] `createCheckout` can orphan Stripe customers on concurrent first-checkout

**Location:** `convex/billing.ts:333-388` (`createCheckout` action), `convex/billing.ts:295-309` (`setStripeCustomer`).

**Problem:** Two members of the same org starting the org's first checkout concurrently both observe `prepared.stripeCustomerId === null`, both call `stripe.customers.create({ idempotencyKey: \`customer:${organizationId}\` })`. Stripe's idempotency key dedups within its window, but if the two requests land outside that window (or the key has aged out), two distinct customers are created. `setStripeCustomer` keeps whichever wins the race (`profile.stripeCustomerId !== undefined && !== args.stripeCustomerId` → returns existing) and the other customer is orphaned in Stripe with no reference.

**Impact:** Orphaned Stripe customer records; potential confusion if the loser customer is later billed by Stripe for unrelated activity.

**Fix:** Make `setStripeCustomer` the single source of truth — call `stripe.customers.create` only after a `setStripeCustomer`-style mutation confirms the profile still lacks a customer (lookup-then-create inside one mutation, or a unique constraint). At minimum, log/warn when a created customer is discarded.

---

### [SEV: P3] `cycleBreakdown` — unbounded `.collect()` + N+1 project lookups

**Location:** `convex/billing.ts:985-1048`.

**Problem:** `ctx.db.query("usageEvents").withIndex("by_org_at", …).collect()` loads an entire org-month of usage events into memory, then `Promise.all([...byProject.entries()].map(async ([projectId, row]) => ctx.db.get(projectId)))` performs one `db.get` per distinct project. For a high-volume org this is O(monthly calls) memory and O(projects) round-trips. Also, `totalCredits` is computed both in the `byKey`/`byProject` loops *and* again via `events.reduce` — redundant.

**Impact:** Performance degradation and memory pressure for active orgs; not a correctness bug.

**Fix:** Paginate or aggregate server-side; fetch projects via a single `db` batch query; drop the redundant `reduce`.

---

### [SEV: P3] `getBillingState` projects `failureReason` which is never written

**Location:** `convex/billing.ts:955-965` (projection), `convex/billing.ts:456-655` (no `failureReason` writer anywhere in `billing.ts`).

**Problem:** The payments projection includes `failureReason: payment.failureReason`, but no code path in `billing.ts` ever sets `payments.failureReason`. The field is always `undefined`. Dead projection that implies a failure surface which does not exist.

**Impact:** Client UI that keys off `failureReason` (the web billing route renders payment status) will never see a reason; misleading API shape.

**Fix:** Either wire `failureReason` on the failure paths (`payment_intent.payment_failed`, async payment failed, etc.), or drop it from the projection.

---

### [SEV: P3] `applyRefund` parameter `stripeRefundId` actually receives the Stripe event id

**Location:** `convex/billing.ts:542-545` (arg name), `convex/billing.ts:573` (used in `refId`), `convex/billing.ts:778-781` (caller passes `args.stripeEventId`).

**Problem:** The argument is named `stripeRefundId` and used to build `refId: \`stripe:refund:${args.stripeRefundId}\``, but the caller passes `stripeRefundId: args.stripeEventId`. So the value is the **event** id, not the refund id. The resulting `refId` is `stripe:refund:evt_…` — event-scoped, not refund-scoped (this is the root of the P1 double-debit finding). The parameter name actively misleads readers about the idempotency domain.

**Impact:** Reviewer/maintainer confusion; the idempotency key looks refund-scoped but is event-scoped.

**Fix:** Rename the parameter to `stripeEventId` (matching the caller), or — better, if refund-scoped dedup is desired — pass the actual refund id from the charge object and key the `refId` off it (but note this changes idempotency semantics; pair with the P1 fix).

---

### [SEV: P3] `stripeClient()` constructs a new `Stripe` instance per call

**Location:** `convex/billing.ts:128-133`.

**Problem:** Every `createCheckout`, every `processStripeEvent`, and every webhook route verification instantiates a fresh `new Stripe(secretKey, …)`. Cheap but not free, and called on the hot webhook path.

**Impact:** Negligible per-call overhead; not a correctness bug.

**Fix:** Memoize per-process (module-level lazy singleton).

---

### [SEV: P3] `createCheckout` has no client-idempotency — double-click creates two intents and two Stripe sessions

**Location:** `convex/billing.ts:226-247` (`prepareCheckoutIntent` always inserts), `convex/billing.ts:333-388` (`createCheckout` always proceeds).

**Problem:** A double-click on "Buy" calls `createCheckout` twice. `prepareCheckoutIntent` inserts a new `checkoutIntents` row each time (no idempotency key from the client), and `createHostedCheckout` uses `idempotencyKey: \`checkout:${checkoutIntentId}\`` — which differs per intent, so Stripe creates two distinct Checkout Sessions. One is abandoned.

**Impact:** Orphaned intents/sessions; cluttered `checkoutIntents` table; minor Stripe session overhead.

**Fix:** Accept an optional client-supplied idempotency key on `createCheckout` and reuse it to short-circuit duplicate intent creation, or dedupe pending intents for the same (org, pack) within a short window.

---

## Summary

- **Findings:** 18 (P0: 2, P1: 2, P2: 9, P3: 5)
- **Top 3:**
  1. **[P0] Failed Stripe events are never re-driven** — `receiveStripeEvent` dedupes Stripe's retry away (`isNew: false` → no re-schedule), `processStripeEvent` marks failures `"failed"` and re-throws, no cron re-scans, route `200`s before processing. Any transient failure permanently drops a grant / refund reversal / dispute. Add a re-drive cron over `paymentEvents` (idempotency already holds downstream).
  2. **[P0] Refund/dispute reversal is non-transactional across 3 mutations** — `applyRefund` (read) → `reversePaymentCredits` (wallet debit) → `finalizeRefund` (projection write) commit independently; a crash mid-sequence leaves the ledger debited but the projection stale, and the next event over-debits. Fold read+debit+projection into one `internalMutation`.
  3. **[P1] Concurrent refund events double-debit the wallet** — reversal `refId` is event-scoped (`stripe:refund:${eventId}`), so two distinct refund events bypass `walletEntries.by_ref` dedup and both append `-amount`; `finalizeRefund` then caps the projection to the cumulative target, hiding the over-debit. Key the `refId` by the cumulative target, or perform the reversal in one transactional mutation.

Cross-cutting note: the file's core design — splitting a single logical money operation (grant / refund / dispute) across multiple `internalMutation` calls from an `internalAction` — is the common root of P0 #2, P1 #3, P1 #4, and P2 #9. The action boundary is not transactional, and Convex does not retry failed scheduled actions. Until the re-drive cron (P0 #1) and single-transaction reversal (P0 #2) land, this file is unsafe to ship for real money.
