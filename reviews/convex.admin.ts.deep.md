# Tiger-Style Deep-Dive Review — `convex/admin.ts`

## Verdict
NEEDS WORK (confirmed + expanded). The prior review's 2 P1 / 3 P2 / 3 P3 are all verified against current source. The admin *authz gate* itself remains sound (every export calls `requireAdmin` / `requireAdminInAction`; env-driven, fails closed; no self-promotion path; cross-org admin actions are intentional operator powers). But the privileged *side effects* are worse than first reported: `retryPublisherTransfer` has a second, independent P1 — it marks a transfer `succeeded` without ever inspecting the `status` Stripe actually returned, so a still-`pending` Stripe transfer is locally recorded as `succeeded` and its earnings flipped to `transferred`. The webhook/retry race is confirmed and traced into `payouts.ts:426` where `markPublisherTransferSucceeded` patches `status: "succeeded"` **unconditionally** with no current-state guard. New findings below: `listProjects` paginates-then-filters when only one of `status`/`visibility` is set (sparse pages, P2); no admin audit trail recording *which* admin acted (P2); `retryPublisherTransfer` can race the normal `initiatePublisherTransfer` path on a `created` transfer (P2); test coverage exists only for `listPublisherTransfers` (P2); plus several P3s (duplicated Stripe call logic vs `transferToStripe`, N+1 org/wallet fetches, re-fetch-after-patch, redundant in-memory filter on the indexed branch, `usageCapped` boundary). No P0: no admin bypass, no data loss primitive, no authz hole. Admin is the highest-privilege surface and the payout path under it is not yet safe to ship.

## File Stats
- **Path:** `convex/admin.ts`
- **LOC:** 381
- **Exports:** 8 (`isAdminQuery`, `platformStats`, `listOrgs`, `listProjects`, `recentUsage`, `setProjectVisibility`, `listPublisherTransfers`, `retryPublisherTransfer`) + 1 private (`requireAdminInAction`).
- **Role:** Platform-admin surface. Reads: platform-wide stats, org/project/usage listing, Stripe Connect transfer operator view. Writes: project visibility kill-switch (cross-org), Stripe transfer retry (cross-org, calls Stripe).
- **Auth model:** `ADMIN_USER_IDS` env (comma-separated Clerk `subject` ids). `requireAdmin` (`lib/auth.ts:120-136`) for queries/mutations; `requireAdminInAction` (`admin.ts:324-336`) for the action. Both fail closed when env unset/empty. No DB role table, no self-promotion path. Correct by design.
- **Cross-references verified:** `convex/lib/auth.ts`, `convex/payouts.ts` (`preparePublisherTransfer:318`, `getPublisherTransfer:417`, `markPublisherTransferSucceeded:426`, `markPublisherTransferFailed:458`, `projectStripeTransfer:466`, `transferToStripe:567`, `initiatePublisherTransfer:612`), `convex/schema.ts` (`publisherTransfers:304` — indexes `by_publisher`, `by_idempotency_key`, `by_stripe_transfer`; **no `by_status`**; `projects:32` — `by_visibility_status`; `usageEvents:111` — `by_at`), `convex/lib/notifications.ts` (`createNotification` dedupes by `refId`), `convex/webhooks.ts` (`fireWebhookEvent:60`), `convex/admin.test.ts` (covers `listPublisherTransfers` only).

## Findings

---

### [SEV: P1] `retryPublisherTransfer` marks a transfer `succeeded` without inspecting the status Stripe returned — a still-`pending` Stripe transfer is locally recorded as `succeeded`
**Location:** `convex/admin.ts:343-365` (Stripe call + unconditional `markPublisherTransferSucceeded`); `convex/payouts.ts:426-455` (`markPublisherTransferSucceeded` patches `status: "succeeded"` unconditionally).

```ts
// admin.ts retryPublisherTransfer
const stripeTransfer = await stripeClient().transfers.create(
  {
    amount: transfer.amount,
    currency: transfer.currency,
    destination: transfer.stripeConnectedAccountId,
    metadata: { publisherTransferId: transfer._id },
  },
  { idempotencyKey: transfer.idempotencyKey },
);
await ctx.runMutation(internal.payouts.markPublisherTransferSucceeded, {
  transferId: transfer._id,
  stripeTransferId: stripeTransfer.id,   // ← stripeTransfer.status is never inspected
});
```

```ts
// payouts.ts markPublisherTransferSucceeded — no guard, no status check
await ctx.db.patch(transfer._id, {
  stripeTransferId: args.stripeTransferId,
  status: "succeeded",                    // ← unconditional, regardless of Stripe's status
  failureReason: undefined,
  attemptedAt: now,
  updatedAt: now,
});
// ... then flips all linked earnings → "transferred"
```

**Problem:** Stripe's `transfers.create` is not synchronous-final. It can return a transfer object with `status: "pending"` (e.g. when the destination bank account is not yet ready, or the connected account is in a state requiring review). The retry action treats *any* non-throwing return as success: it passes `stripeTransfer.id` straight into `markPublisherTransferSucceeded`, which patches the Convex row to `status: "succeeded"` and flips every linked `publisherEarnings` row to `status: "transferred"` — all without ever reading `stripeTransfer.status`. This is an independent defect from the webhook-race P1 below; it fires even on a single-threaded, no-concurrency retry of a genuinely pending transfer.

The normal path (`transferToStripe` in `payouts.ts:567-605`) has the **exact same bug** — it also ignores `stripeTransfer.status`. So this is a systemic gap in the payout state machine that the admin retry surfaces as a privileged primitive. The webhook `projectStripeTransfer` (`payouts.ts:466`) is the *only* handler that maps Stripe's actual `status`/event to local state, and it runs asynchronously; the synchronous mutation path pre-empts it with an unconditional `succeeded`.

**Impact:** Payout ledger states `succeeded` / `transferred` for a transfer Stripe still considers `pending`. The org's earnings show as paid out; downstream UI (the `getPayoutState` totals in `payouts.ts:636-680` sum `transferred` credits) reports money as delivered that has not been delivered. If Stripe later fails the pending transfer, the webhook `projectStripeTransfer` flips it to `failed` — but the earnings it patches to `failed` were already shown to the publisher as `transferred`, and any reconciliation/reporting built on a point-in-time read is wrong. For a payout primitive, this is a real-money correctness defect, not a theoretical race.

**Fix:** Inspect `stripeTransfer.status` before marking success; only `succeeded` (and, if you choose, `paid`) should drive `markPublisherTransferSucceeded`. For `pending`, mark the transfer `pending` (or leave `created`/`pending`) and let the webhook finalize:
```ts
const stripeTransfer = await stripeClient().transfers.create(...);
if (stripeTransfer.status === "succeeded" || stripeTransfer.status === "paid") {
  await ctx.runMutation(internal.payouts.markPublisherTransferSucceeded, {
    transferId: transfer._id,
    stripeTransferId: stripeTransfer.id,
  });
} else {
  // pending / in_transit / etc. — record the stripeTransferId but let the webhook finalize status
  await ctx.runMutation(internal.payouts.recordStripeTransferId, {
    transferId: transfer._id,
    stripeTransferId: stripeTransfer.id,
  });
}
```
And/or make `markPublisherTransferSucceeded` itself status-guarded (see next finding). At minimum, stop trusting "Stripe did not throw" as "transfer succeeded".

---

### [SEV: P1] `retryPublisherTransfer` bypasses connected-account eligibility re-check; can transfer to a disabled/restricted/stale account
**Location:** `convex/admin.ts:335-372` (`retryPublisherTransfer`); contrast `convex/payouts.ts:318-416` (`preparePublisherTransfer`).

```ts
const transfer = await ctx.runMutation(
  internal.payouts.getPublisherTransfer,        // ← only checks existence, no eligibility
  { transferId: args.transferId },
);
if (transfer.status === "succeeded" || transfer.status === "reversed") {
  return { transferId: transfer._id };
}
try {
  const stripeTransfer = await stripeClient().transfers.create(
    {
      amount: transfer.amount,
      currency: transfer.currency,
      destination: transfer.stripeConnectedAccountId,   // ← stale snapshot, never re-validated
      metadata: { publisherTransferId: transfer._id },
    },
    { idempotencyKey: transfer.idempotencyKey },
  );
```

**Problem:** The normal publisher-initiated path (`initiatePublisherTransfer` → `preparePublisherTransfer`) gates the transfer on a fresh read of `organizationPayments`: it requires `payoutsEnabled === true`, `disabledReason === undefined`, and a present `stripeConnectedAccountId` (`payouts.ts:325-333`). The admin retry path reads none of that — it takes the `stripeConnectedAccountId` snapshot stored on the transfer row (possibly days/weeks old) and fires `transfers.create` directly. Between the original transfer's creation and the admin retry, Stripe may have disabled payouts on the connected account (fraud hold, `requirements.past_due`, account rejected). `preparePublisherTransfer` would throw `"Connected account is not eligible for transfers"`; the retry path blindly proceeds. Worse: if the publisher re-onboarded to a *different* connected account since the transfer was created, `transfer.stripeConnectedAccountId` is a stale pointer to the old (possibly closed) account — funds move to the wrong destination.

**Impact:** A transfer can be pushed to an account Stripe has since disabled/flagged, or to a no-longer-current connected account. In the benign case Stripe rejects and `markPublisherTransferFailed` records the failure. In the worse case the account is in a transiently-disabled state Stripe still accepts transfers for, or the snapshot is stale relative to the publisher's current account — funds move to a connected account that should no longer receive payouts, requiring manual Stripe reversal. For a *payout* primitive under admin control, the eligibility gate belongs on the retry path too.

**Fix:** Re-check eligibility inside the retry action before calling Stripe, and assert the snapshot matches the current account:
```ts
const profile = await ctx.runMutation(internal.payouts.getConnectProfileForActiveOrg, {
  clerkOrgId: /* resolve from transfer.publisherOrganizationId */,
});
if (
  profile === null ||
  profile.stripeConnectedAccountId === undefined ||
  !profile.payoutsEnabled ||
  profile.disabledReason !== undefined
) {
  throw new Error("Connected account is no longer eligible for transfers");
}
if (profile.stripeConnectedAccountId !== transfer.stripeConnectedAccountId) {
  throw new Error("Connected account has changed since transfer was created; recreate the transfer");
}
```
(Requires a `getConnectProfileForOrg` internal mutation keyed by org id, since `getConnectProfileForActiveOrg` keys off the *active Clerk org* claim — which the admin action does not have. This is itself a smell: the admin action has no clean way to re-read the profile because the profile reader assumes a user context.)

---

### [SEV: P1] `retryPublisherTransfer` clobbers concurrently-updated transfer/earnings status — race with Stripe webhook *and* with `markPublisherTransferSucceeded` having no status guard
**Location:** `convex/admin.ts:336-366` (status read at T0, Stripe call at T1, mark at T2); `convex/payouts.ts:426-455` (`markPublisherTransferSucceeded` patches unconditionally); `convex/payouts.ts:466-510` (`projectStripeTransfer` webhook handler).

```ts
// admin.ts — T0 read, T1 Stripe, T2 mark: three separate transactions (action)
if (transfer.status === "succeeded" || transfer.status === "reversed") {
  return { transferId: transfer._id };
}
// ... gap: Stripe webhook may fire projectStripeTransfer here ...
const stripeTransfer = await stripeClient().transfers.create(...);   // T1
await ctx.runMutation(internal.payouts.markPublisherTransferSucceeded, {  // T2
  transferId: transfer._id,
  stripeTransferId: stripeTransfer.id,
});
```

```ts
// payouts.ts:426 — no guard on transfer.status before patching to "succeeded"
const transfer = await ctx.db.get(args.transferId);
if (transfer === null) throw new Error("Publisher transfer not found");
const now = Date.now();
await ctx.db.patch(transfer._id, {
  stripeTransferId: args.stripeTransferId,
  status: "succeeded",                  // ← overwrites whatever status is currently there
  failureReason: undefined,
  attemptedAt: now,
  updatedAt: now,
});
```

**Problem:** The status read at T0 (`getPublisherTransfer`) and the Stripe `transfers.create` at T1 are in separate Convex transactions (this is an action — `ctx.runMutation` is a cross-transaction hop). Between T0 and T2, Stripe's async webhook can land: `projectStripeTransfer` (`payouts.ts:466`) looks up the transfer by `stripeTransferId` and patches `status` to `succeeded`/`failed`/`reversed`. Because `markPublisherTransferSucceeded` patches `status: "succeeded"` **unconditionally** — no guard on the current status — the admin retry's success-marking can overwrite a `reversed` state (Stripe reversed the transfer between T0 and T2) back to `succeeded`, while the earnings it flips to `transferred` were already moved to `failed`/`reversed` by `projectStripeTransfer`'s earnings loop. The two earnings-patch loops race on the same rows; last writer wins, and last writer is the admin retry, not the webhook.

The symmetric case is also broken: if the webhook marks `succeeded` between T0 and T1, the admin's Stripe call with the same idempotency key is a no-op (Stripe returns the original transfer), but `markPublisherTransferSucceeded` runs again, re-patches `status: "succeeded"` (idempotent on status) and re-iterates the entire earnings scan/patch loop unnecessarily. The *dangerous* case remains the `reversed` overwrite.

The Stripe idempotency key prevents a *double Stripe transfer*; it does **not** prevent the local ledger-status clobber, because the clobber happens in the Convex mutation that runs after Stripe returns, with no precondition on the row's current status.

**Impact:** Inconsistent payout ledger state under the admin-retry-vs-webhook-reversal race. Earnings can end up `transferred` while the transfer they reference is later reversed by Stripe, leaving money double-counted or un-reversable. Reconciliation against Stripe's view diverges; the webhook's authoritative `reversed` state is silently lost.

**Fix:** Make `markPublisherTransferSucceeded` status-guarded (only patch if current status ∈ {`created`, `pending`, `failed`} — i.e. *not* already `succeeded`/`reversed`), and re-fetch the transfer's current status immediately before marking:
```ts
// in markPublisherTransferSucceeded (payouts.ts:426):
if (transfer.status === "succeeded" || transfer.status === "reversed") return;
```
Apply the same guard to `markPublisherTransferFailed` (it currently also patches unconditionally, though its failure status is less destructive). Consider a single `setPublisherTransferState(transferId, from[], to, patch)` internal mutation that atomically checks pre-state, so every status transition is centralized and guarded.

---

### [SEV: P2] `listProjects` paginates-then-filters when only one of `status`/`visibility` is set — sparse/empty pages on the exact filters admins use
**Location:** `convex/admin.ts:143-185`.

```ts
// When both filters present, use the composite index for precise results.
// Otherwise paginate all and filter in-memory (admin tool, bounded scale).
let result;
if (status !== undefined && visibility !== undefined) {
  result = await ctx.db
    .query("projects")
    .withIndex("by_visibility_status", (q) =>
      q.eq("visibility", visibility).eq("status", status),
    )
    .order("desc")
    .paginate(args.paginationOpts);
} else {
  result = await ctx.db
    .query("projects")
    .order("desc")
    .paginate(args.paginationOpts);          // ← paginates ALL projects, no index
}

const page: AdminProjectView[] = result.page
  .filter((p) => {                            // ← post-pagination filter
    if (status !== undefined && p.status !== status) return false;
    if (visibility !== undefined && p.visibility !== visibility) {
      return false;
    }
    return true;
  })
  .map(...);
```

**Problem:** Convex `.filter()` applies *after* pagination — it takes the page of N rows and filters those. When the caller passes only `status` (e.g. `status: "draft"`) or only `visibility` (e.g. `visibility: "private"`), the else branch paginates the entire `projects` table by `_creationTime` desc and then filters the page in-memory. On a platform with many published/public projects, a `status: "draft"` query returns a page of 20 published projects → 0 matching after filter → the admin UI must keep calling `continueCursor` to skip whole pages until it accumulates any draft rows. The `by_visibility_status` index is composite on `(visibility, status)` and cannot answer a single-dimension filter efficiently (you'd need two range scans, one per visibility value, for a status-only query). The comment "(admin tool, bounded scale)" is a false promise — `projects` is unbounded.

This is the same class of defect as `listPublisherTransfers`'s status filter (prior P2 #5), in the same file, on the same admin surface. The schema *has* `by_visibility_status` but the filter shape doesn't match it for single-dimension queries.

**Impact:** Sluggish/empty-page pagination on the admin projects view for the exact filters admins use most (draft projects, private projects). Functionally correct (no data loss) but pathological at scale.

**Fix:** For single-dimension filters, issue two indexed range scans (one per value of the other dimension) and merge, or add a `by_status` index (`["status", "createdAt"]`) and a `by_visibility` index if single-dimension filters are common. At minimum, document that single-filter queries paginate-then-filter and may return sparse pages, so the UI doesn't assume a full page.

---

### [SEV: P2] `setProjectVisibility` notification `refId` embeds `Date.now()` — non-idempotent; no-op "change" still patches/notifies/fires webhook
**Location:** `convex/admin.ts:204-249`.

```ts
const project = await ctx.db.get(args.projectId);
if (project === null) {
  throw new Error("Project not found");
}

await ctx.db.patch(args.projectId, { visibility: args.visibility });   // ← no change-check

const org = await ctx.db.get(project.organizationId);
if (org !== null) {
  await createNotification(ctx, {
    clerkOrgId: org.clerkOrgId,
    kind: "visibility_changed",
    title: "Project visibility changed",
    body: `Your project "${project.name}" visibility was set to ${args.visibility} by platform admin.`,
    refId: `visibility_changed:${args.projectId}:${Date.now()}`,   // ← Date.now() → never dedupes
  });
}

await fireWebhookEvent(ctx, args.projectId, "project.visibility_changed", {
  projectId: args.projectId,
  visibility: args.visibility,
});
```

**Problem:** Two coupled defects:
1. **No change-check.** Setting `visibility: "public"` on a project that is already `public` still runs the `patch` (a no-op write that still bumps the doc's `_creationTime`? — no, `patch` only updates specified fields; but it does write), still inserts a notification, and still queues a webhook delivery. `createNotification` dedupes by `refId`, but `refId` includes `Date.now()` (defect #2), so the dedupe never fires — every call, including no-op calls, produces a fresh notification + webhook.
2. **`Date.now()` in `refId`.** `createNotification` (`lib/notifications.ts`) is idempotent by `refId` *only when the refId is stable*. Here every invocation — including a Convex automatic retry of the mutation on a transient OCC conflict — produces a distinct refId. So a single logical admin action can materialize as 2+ notifications and 2+ webhook deliveries. Compare with the canonical stable pattern elsewhere (`transfer_failed:${transfer._id}` in `payouts.ts:500`).

**Impact:** Notification spam on rapid toggles or no-op toggles; webhook consumers cannot dedupe `project.visibility_changed` because there is no monotonic per-change identifier. A Convex retry (transient error) duplicates the side effects. For a kill-switch primitive that fires webhooks to customer endpoints, this is a real reliability defect, not just noise.

**Fix:** Guard on actual change and use a stable-but-monotonic refId:
```ts
if (project.visibility === args.visibility) {
  return await ctx.db.get(args.projectId) as Doc<"projects">;
}
await ctx.db.patch(args.projectId, { visibility: args.visibility });
...
refId: `visibility_changed:${args.projectId}:${args.visibility}`,
```
If a truly per-event id is needed (so a public→private→public cycle produces two notifications), accept an explicit `idempotencyKey` arg from the caller instead of `Date.now()`, so Convex retries reuse the same key.

---

### [SEV: P2] `platformStats` doc claims "All bounded/indexed" but performs two unbounded `collect()` table scans
**Location:** `convex/admin.ts:53-56, 65-66` (comment + `collect()` calls).

```ts
/**
 * Platform-wide counts. All bounded/indexed.
 * usageThisMonth scans by_at index from month start, capped at USAGE_STATS_CAP.
 */
export const platformStats = query({
  ...
  handler: async (ctx): Promise<PlatformStats> => {
    await requireAdmin(ctx);
    const allOrgs = await ctx.db.query("organizations").collect();      // ← full table scan
    const allProjects = await ctx.db.query("projects").collect();        // ← full table scan
    const draft = allProjects.filter((p) => p.status === "draft").length;
    const published = allProjects.filter(
      (p) => p.status === "published",
    ).length;
```

**Problem:** The docstring promises "All bounded/indexed." `usageThisMonth` is indeed capped (`take(USAGE_STATS_CAP)`). But `organizations` and `projects` are loaded with bare `.collect()` — full scans with no index, no cap, no pagination. At platform scale (the admin panel is explicitly a platform-wide tool), both collections grow without bound. Every org and every project document is materialized into the transaction only to call `.length` / `.filter(...).length`. `projects` has a `by_visibility_status` index that *could* answer the draft/published counts without a scan (two `count()` queries, one per visibility value, or four keyed by visibility+status), but it isn't used. `organizations` has no count primitive.

The comment is actively misleading: a reviewer reading "All bounded/indexed" will not flag this path during review, which is how unbounded admin queries survive to production.

**Impact:** Unbounded memory/transaction cost on the admin overview page as the platform grows; false-contract doc that defeats review. Not a correctness bug.

**Fix:** Use Convex `.count()` on indexed queries for the status split:
```ts
const draftCount = await ctx.db.query("projects")
  .withIndex("by_visibility_status", (q) =>
    q.eq("visibility", "private").eq("status", "draft")).count();
// + public/draft, private/published, public/published → sum
```
For orgs, there is no narrower path — either maintain a counter, or fix the doc to say "org/project counts scan; usage is capped" and accept it for an admin tool. Do not leave the false "bounded/indexed" claim.

---

### [SEV: P2] No admin audit trail — `setProjectVisibility` and `retryPublisherTransfer` record no record of *which* admin acted
**Location:** `convex/admin.ts:204-249` (`setProjectVisibility`), `convex/admin.ts:338-372` (`retryPublisherTransfer`); `lib/auth.ts:120-136` (`requireAdmin` returns `OrgIdentityClaims` with `subject` — used by neither mutation).

**Problem:** `requireAdmin` returns the admin's `OrgIdentityClaims` (including `subject`, the Clerk user id). Neither `setProjectVisibility` nor `retryPublisherTransfer` captures or persists it. The notification body says `"by platform admin"` — no operator id. The webhook payload (`{ projectId, visibility }`) carries no actor. The transfer retry writes nothing about who triggered it. There is no `adminActions` table, no `performedBy` field on the project doc, no log row in `publisherTransfers`.

For a kill-switch that changes a project's visibility across org boundaries, and for a primitive that moves money to a connected account, the absence of an audit trail is a real governance defect. If two admins share an env-configured id list, there is no way to attribute an action after the fact. If an admin subject is compromised and removed from `ADMIN_USER_IDS`, their past actions are unattributable.

**Impact:** No accountability for the highest-privilege operations in the system. In an incident review (e.g. "who set project X to public? who retried the transfer to org Y?"), there is nothing to investigate. This is the kind of gap that gets flagged in a SOC 2 / security review.

**Fix:** Add an `adminActions` table (`{ actorSubject, action, targetId, payload, at }`) and write a row at the start of every admin mutation/action. At minimum, include `actorSubject` in the notification body and the webhook payload for `setProjectVisibility`, and add `retriedBy` / `retriedAt` to `publisherTransfers` (or a sibling `publisherTransferAttempts` table) so each retry is attributable.

---

### [SEV: P2] `retryPublisherTransfer` can race the normal `initiatePublisherTransfer` path on a `created` transfer — double Stripe attempt, no lock
**Location:** `convex/admin.ts:336-365` (retry proceeds on `status === "created" | "pending" | "failed"`); `convex/payouts.ts:612-638` (`initiatePublisherTransfer` → `preparePublisherTransfer` returns existing `created`/`pending`/`failed` row → `transferToStripe`).

```ts
// admin.ts retryPublisherTransfer — proceeds for created/pending/failed
if (transfer.status === "succeeded" || transfer.status === "reversed") {
  return { transferId: transfer._id };
}
// proceeds to Stripe.create with the same idempotencyKey
```

```ts
// payouts.ts preparePublisherTransfer — returns the existing created/pending/failed row for retry
const retry = priorTransfers.find(
  (transfer) =>
    transfer.status === "created" ||
    transfer.status === "pending" ||
    transfer.status === "failed",
);
if (retry !== undefined) {
  return { transferId: retry._id, ... };   // ← initiatePublisherTransfer then calls transferToStripe on it
}
```

**Problem:** Both the admin retry and the normal publisher path can operate on the same `created`/`pending`/`failed` transfer. If a publisher clicks "withdraw" (`initiatePublisherTransfer`) at the same moment an admin clicks "retry" (`retryPublisherTransfer`), both call `stripeClient().transfers.create` with the same idempotency key. Stripe's idempotency layer saves a duplicate *transfer* (the second call returns the first's transfer object), but both paths then call `markPublisherTransferSucceeded` — two cross-transaction mutations that each re-scan and re-patch the earnings loop. There is no row lock, no `attemptedAt`-based "in-flight" marker that the other path checks, and no compare-and-set on `status` before calling Stripe. `preparePublisherTransfer` finds the existing row and returns it without marking it "in-flight"; the admin action does the same.

**Impact:** No double-charge (Stripe idempotency holds), but two concurrent earnings-patch loops on the same rows, two webhook deliveries (if `markPublisherTransferSucceeded` ever fires one — currently it doesn't, but the pattern is fragile), and an undefined ordering of which `markSucceeded` lands last. Combined with the unconditional-status-clobber P1 above, this widens the race window. For a money primitive, "Stripe dedupes the API call" is not a sufficient concurrency argument.

**Fix:** Before calling Stripe, atomically claim the transfer: a `claimPublisherTransferForAttempt(transferId)` internal mutation that patches `attemptedAt = now` and `status = "pending"` only if `status ∈ {created, failed}` (compare-and-set), throwing if already claimed by a recent `attemptedAt`. Both the admin retry and the normal path must go through this claim; the loser throws "transfer already in flight".

---

### [SEV: P2] `listPublisherTransfers` status filter uses `.filter()` (no `by_status` index) — paginates-then-filters, starves pagination on rare statuses
**Location:** `convex/admin.ts:303-310`; schema `publisherTransfers` (`schema.ts:304-322` has `by_publisher`, `by_idempotency_key`, `by_stripe_transfer` — **no `by_status`**).

```ts
const q = ctx.db.query("publisherTransfers");
const result = args.status
  ? await q
      .order("desc")
      .filter((qq) => qq.eq(qq.field("status"), args.status!))
      .paginate(args.paginationOpts)
  : await q.order("desc").paginate(args.paginationOpts);
```

**Problem:** Same class as the `listProjects` P2 above. `.filter()` applies *after* pagination. When filtering for a rare status (`reversed`, `failed`) across a large table of `succeeded` transfers, a page of 20 `succeeded` rows yields an empty filtered page; the client must keep paginating until it accumulates any matching rows. This is the exact filter `retryPublisherTransfer` operates on — the admin "failed transfers" view, the most useful admin filter, is the one most penalized. The `by_status` index doesn't exist; `by_status_available` is on `publisherEarnings`, not `publisherTransfers`.

**Impact:** Sluggish/empty-page pagination on the admin payouts filter for the statuses admins care about most. No data loss.

**Fix:** Add `by_status` index to `publisherTransfers` (`.index("by_status", ["status", "createdAt"])`) and switch the filtered branch to `withIndex`. The unfiltered path stays as-is.

---

### [SEV: P2] Test coverage exists only for `listPublisherTransfers` — no tests for `platformStats`, `listOrgs`, `listProjects`, `recentUsage`, `setProjectVisibility`, `retryPublisherTransfer`
**Location:** `convex/admin.test.ts` (entire file — 2 tests, both on `listPublisherTransfers`).

**Problem:** The test file asserts (a) non-admin fails closed and (b) `listPublisherTransfers` returns operator-safe state without a `destination` field. That's it. The two P1 defects (`retryPublisherTransfer` ignoring Stripe status, bypassing eligibility, racing the webhook), the `setProjectVisibility` no-op-notify + non-idempotent refId, the `platformStats` unbounded scans, and the `listProjects` sparse-page filter are all untested. `retryPublisherTransfer` — the highest-stakes primitive in the file, calling Stripe — has zero coverage. A regression in `markPublisherTransferSucceeded`'s (currently absent) status guard would not be caught.

**Impact:** The payout state machine under admin control can be refactored or broken without any test failing. For a money primitive, this is a process defect.

**Fix:** Add tests for: (1) `retryPublisherTransfer` on a `pending` Stripe return does not mark `succeeded` (mock `stripeClient`); (2) `retryPublisherTransfer` rejects when connected account is disabled (mock profile reader); (3) `retryPublisherTransfer` does not clobber a `reversed` status (set up `reversed`, call retry, assert status unchanged); (4) `setProjectVisibility` no-op when unchanged (no notification inserted, no webhook queued); (5) `setProjectVisibility` with same `refId` across retries dedupes notifications; (6) non-admin rejected on `setProjectVisibility` and `retryPublisherTransfer`.

---

### [SEV: P3] `retryPublisherTransfer` duplicates `transferToStripe` logic from `payouts.ts:567` — drift risk, two copies of the Stripe call
**Location:** `convex/admin.ts:343-371` (inline Stripe call + mark); `convex/payouts.ts:567-605` (`transferToStripe` helper).

```ts
// admin.ts retryPublisherTransfer — inlines the Stripe call
const stripeTransfer = await stripeClient().transfers.create(
  {
    amount: transfer.amount,
    currency: transfer.currency,
    destination: transfer.stripeConnectedAccountId,
    metadata: { publisherTransferId: transfer._id },
  },
  { idempotencyKey: transfer.idempotencyKey },
);
await ctx.runMutation(internal.payouts.markPublisherTransferSucceeded, ...);
// catch → markPublisherTransferFailed, rethrow
```

```ts
// payouts.ts transferToStripe — same shape, same fields, same idempotency
const stripeTransfer = await stripeClient().transfers.create(
  {
    amount: transfer.amount,
    currency: transfer.currency,
    destination: transfer.stripeConnectedAccountId,
    metadata: { publisherTransferId: transfer._id },
  },
  { idempotencyKey: transfer.idempotencyKey },
);
```

**Problem:** The Stripe `transfers.create` call, the metadata shape, the idempotency key, the success/failure marking, and the error slicing (`error.message.slice(0, 240)`) are duplicated byte-for-byte between `retryPublisherTransfer` and `transferToStripe`. The P1 fix above (inspect `stripeTransfer.status` before marking succeeded) must be applied in both places or the two paths diverge — and the admin path is the one most likely to be forgotten because it's in a different file. There is no shared `attemptPublisherTransfer(ctx, transfer)` action that both call.

**Impact:** Drift risk on the money primitive. Any future change to the Stripe call (metadata, error handling, status mapping) must be made in two places. The two copies have already drifted in *intent* — the normal path's `transferToStripe` is the "canonical" one, but the admin path is the one reviewers are less likely to read.

**Fix:** Extract `attemptPublisherTransfer(ctx, transfer)` into `payouts.ts` (an internal action or a shared helper) and have both `initiatePublisherTransfer` and `retryPublisherTransfer` call it. Delete the inlined copy in `admin.ts`.

---

### [SEV: P3] `requireAdminInAction` duplicates `requireAdmin` logic instead of reusing the lib — drift risk on the security-critical gate
**Location:** `convex/admin.ts:324-336` (`requireAdminInAction`) vs `convex/lib/auth.ts:120-136` (`requireAdmin`).

```ts
async function requireAdminInAction(ctx: ActionCtx): Promise<void> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw new Error("Not authenticated");
  const configured = process.env.ADMIN_USER_IDS;
  if (configured === undefined || configured.trim() === "") {
    throw new Error("Admin access not configured");
  }
  const allowed = configured.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
  if (!allowed.includes(identity.subject))
    throw new Error("Not authorized as admin");
}
```

**Problem:** `lib/auth.ts` already has `requireAdmin` and `isAdmin`; both read `ADMIN_USER_IDS`, split, trim, filter, and `includes(claims.subject)` with byte-identical semantics and the same error strings. The action version exists only because `requireAdmin` is typed for `QueryCtx | MutationCtx` (no `ActionCtx`). The two copies have already drifted slightly: `requireAdmin` returns the `OrgIdentityClaims`; `requireAdminInAction` returns `void` and re-fetches the identity inline, discarding the claims — which is why the audit-trail P2 above has no actor to record. Any future change to the admin gate (a role claim, a deny-list, a rate limit, an IP allowlist) must be made in two places or the action path silently diverges from the query/mutation path.

**Impact:** Drift risk on the single most security-critical gate in the system. No current behavioral difference, but the audit-trail gap is a downstream symptom.

**Fix:** Generalize `requireAdmin`'s `DbCtx` to also accept `ActionCtx` (or extract a pure `checkAdminFromIdentity(identity): OrgIdentityClaims` that both call), return the claims, and delete `requireAdminInAction`. Then `retryPublisherTransfer` can capture `claims.subject` for the audit trail.

---

### [SEV: P3] `listOrgs` and `listPublisherTransfers` perform N+1 fetches per page row
**Location:** `convex/admin.ts:99-117` (`listOrgs` wallet fetch per org); `convex/admin.ts:312-318` (`listPublisherTransfers` org fetch per transfer via `Promise.all`).

```ts
// listOrgs — per-org wallet fetch
for (const org of result.page) {
  const wallet = await ctx.db
    .query("wallets")
    .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
    .unique();
  page.push({ ..., balance: wallet?.balance ?? 0 });
}
```

```ts
// listPublisherTransfers — per-transfer org fetch
const page = await Promise.all(
  result.page.map(async (transfer) => {
    const organization = await ctx.db.get(transfer.publisherOrganizationId);
    return { ..., publisherOrganizationName: organization?.name ?? "Deleted organization", ... };
  }),
);
```

**Problem:** Both queries paginate the parent table then issue one follow-up indexed `get`/`unique` per row in the page. Bounded by `numItems` (default page size), so not unbounded — but it's N round-trips per page where N = page size. `listOrgs` uses a sequential `for` loop (not even `Promise.all`), so the wallet fetches are serial. For a page of 50 orgs, that's 50 sequential wallet lookups.

**Impact:** Latency on admin list views proportional to page size. Not a correctness issue.

**Fix:** Batch the follow-up reads: collect the parent ids from the page, issue a single `q.eq`-or-`in` query for the children, build a `Map<id, child>`, then map over the page. For `listOrgs`, fetch all wallets for the page's org ids in one query (or use a denormalized `balance` field on `organizations` if it's read frequently from the admin view).

---

### [SEV: P3] `setProjectVisibility` re-fetches the project after patching in the same transaction — redundant read
**Location:** `convex/admin.ts:245-249`.

```ts
await fireWebhookEvent(ctx, args.projectId, "project.visibility_changed", {
  projectId: args.projectId,
  visibility: args.visibility,
});

const updated = await ctx.db.get(args.projectId);   // ← redundant; the patch already happened
if (updated === null) {
  throw new Error("Failed to load project");
}
return updated;
```

**Problem:** The mutation already has `project` from the earlier `ctx.db.get(args.projectId)` (`admin.ts:209`). The `patch` (`admin.ts:213`) only updates `visibility` to `args.visibility` — a known value. The returned `updated` doc is `project` with `visibility: args.visibility`. Re-fetching adds a round-trip for no information gain; the only justification would be reading `_creationTime`/other auto-fields, none of which the patch changes.

**Impact:** One redundant DB read per call. Trivial.

**Fix:** Return `{ ...project, visibility: args.visibility }` (typed as `Doc<"projects">`) and drop the re-fetch. Or, if the patch could touch auto-managed fields, document why.

---

### [SEV: P3] `listProjects` indexed branch still runs a redundant in-memory `.filter()` that can never reject
**Location:** `convex/admin.ts:176-184`.

```ts
if (status !== undefined && visibility !== undefined) {
  result = await ctx.db
    .query("projects")
    .withIndex("by_visibility_status", (q) =>
      q.eq("visibility", visibility).eq("status", status),
    )
    .order("desc")
    .paginate(args.paginationOpts);
} else { ... }

const page: AdminProjectView[] = result.page
  .filter((p) => {
    if (status !== undefined && p.status !== status) return false;     // ← on indexed branch, p.status === status always
    if (visibility !== undefined && p.visibility !== visibility) {     // ← on indexed branch, p.visibility === visibility always
      return false;
    }
    return true;
  })
  .map(...);
```

**Problem:** When both filters are set, the `by_visibility_status` index already guarantees every row in `result.page` has the requested `visibility` and `status`. The subsequent `.filter()` re-checks both conditions and can never reject a row on that branch. It exists only to cover the else branch. Dead predicate on the indexed path.

**Impact:** None functional. Minor readability/clarity — a reader may wonder if the index is non-authoritative.

**Fix:** Split the branch so only the else branch filters, or add a comment noting the indexed branch's filter is a no-op kept for uniformity.

---

### [SEV: P3] `platformStats.usageCapped` reports `true` at exactly `USAGE_STATS_CAP` (50,000) — ambiguous boundary
**Location:** `convex/admin.ts:80-84`.

```ts
const monthEvents = await ctx.db
  .query("usageEvents")
  .withIndex("by_at", (q) => q.gte("at", monthStart))
  .take(USAGE_STATS_CAP);

return {
  ...
  usageThisMonth: monthEvents.length,
  usageCapped: monthEvents.length >= USAGE_STATS_CAP,
  usageCap: USAGE_STATS_CAP,
};
```

**Problem:** `take(N)` returns up to N rows. If exactly 50,000 events exist, `monthEvents.length === 50_000` and `usageCapped === true` even though the count is exact (no more rows exist). The flag is named "capped" but actually means "the take() hit its limit, *or* the count happens to equal the limit." A consumer cannot distinguish "exactly 50,000 events" from "≥50,000 events (unknown true count)". The doc says "capped at USAGE_STATS_CAP" which is correct for the take, but the boolean conflates "we hit the cap" with "the cap equals the count."

**Impact:** Minor — an admin dashboard showing `usageThisMonth: 50000, usageCapped: true` is ambiguous. Not a correctness bug.

**Fix:** Rename to `usageTruncated` (clearer: the take was truncated) and document that the true count is unknown when `true`. Or query a separate `count()` (Convex supports `.count()` on indexed queries) for the exact figure and drop the cap.

---

### [SEV: P3] `retryPublisherTransfer` rethrows the raw Stripe error to the admin client — potential leak of Stripe internals
**Location:** `convex/admin.ts:366-370`.

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
  throw error;   // ← raw Stripe error propagates to admin client
}
```

**Problem:** The `reason` stored on the transfer is sliced to 240 chars but sanitized only by truncation — Stripe error messages can include account ids, request ids, `bank_account` fragments, and rate-limit details. The stored `failureReason` is admin-visible (via `listPublisherTransfers`), which is fine. But the `throw error` at the end propagates the *full* raw Stripe error object to the admin client (the action's return path), not the sliced+sanitized `reason`. The project rules say "never leak internal errors"; this leaks Stripe's internal error structure to whatever client invoked `retryPublisherTransfer`.

**Impact:** Admin-only surface, so blast radius is small, but it violates the project's own "never leak internal errors" rule and could expose Stripe account identifiers in client logs.

**Fix:** Throw a sanitized error: `throw new Error("Stripe transfer failed; see transfer failureReason for details")`. Keep the raw error in the stored `failureReason` (admin-visible) but not in the thrown value.

---

### [SEV: P3] `recentUsage` `lte(Date.now())` upper bound is a no-op — `by_at` already covers all rows
**Location:** `convex/admin.ts:217-220`.

```ts
const events = await ctx.db
  .query("usageEvents")
  .withIndex("by_at", (q) => q.lte("at", Date.now()))
  .order("desc")
  .take(100);
```

**Problem:** `lte("at", Date.now())` filters to all events with `at ≤ now`, which is every legitimately-written row (future-dated usage events don't exist in this system). The bound adds no selectivity; it forces the index range to start at `−∞` and end at `now`, which is the entire index. A plain `.order("desc").take(100)` on the `by_at` index is equivalent and clearer. Harmless but slightly misleading — a reader may think there's a future-event case being guarded against.

**Impact:** None functional. Readability/clarity only.

**Fix:** Drop the `lte` and rely on `.order("desc").take(100)`, or add a comment explaining what future-dated row is being excluded.

---

## Summary
- **P0:** 0
- **P1:** 3 — `retryPublisherTransfer` marks `succeeded` without inspecting Stripe's returned `status` (NEW, #1); `retryPublisherTransfer` bypasses connected-account eligibility re-check (prior, verified #2); `retryPublisherTransfer` clobbers concurrently-updated transfer/earnings status via `markPublisherTransferSucceeded` having no status guard (prior, verified + traced into `payouts.ts:426`, #3).
- **P2:** 6 — `listProjects` paginates-then-filters on single-dimension queries (NEW, #4); `setProjectVisibility` non-idempotent `refId` + no-op-change notify/webhook (prior, verified #5); `platformStats` false "bounded/indexed" doc + unbounded `collect()` scans (prior, verified #6); no admin audit trail for `setProjectVisibility` / `retryPublisherTransfer` (NEW, #7); `retryPublisherTransfer` races the normal `initiatePublisherTransfer` path on a `created` transfer (NEW, #8); `listPublisherTransfers` status filter not indexed, starves pagination (prior, verified #9); test coverage only for `listPublisherTransfers` (NEW, #10).
- **P3:** 7 — `retryPublisherTransfer` duplicates `transferToStripe` logic (NEW, #11); `requireAdminInAction` duplicates `requireAdmin` (prior, verified #12); `listOrgs`/`listPublisherTransfers` N+1 per-row fetches (NEW, #13); `setProjectVisibility` re-fetches after patch (NEW, #14); `listProjects` indexed branch has a dead `.filter()` (NEW, #15); `platformStats.usageCapped` ambiguous boundary at exactly 50,000 (NEW, #16); `retryPublisherTransfer` rethrows raw Stripe error to client (NEW, #17); `recentUsage` no-op `lte` bound (prior, verified #18).

**Top 3 to fix before merge:**
1. **Stop trusting "Stripe did not throw" as "transfer succeeded."** In `retryPublisherTransfer` (and the shared `transferToStripe`), inspect `stripeTransfer.status` and only call `markPublisherTransferSucceeded` when Stripe says `succeeded`/`paid`; otherwise record the `stripeTransferId` and let the webhook finalize (P1 #1).
2. **Make `markPublisherTransferSucceeded` status-guarded** so the admin retry (and the normal path) cannot overwrite a concurrent `reversed`/`succeeded` state — centralize the transition in a compare-and-set internal mutation (P1 #3). While there, re-check connected-account eligibility + staleness in the retry path (P1 #2).
3. **Fix `setProjectVisibility` to no-op on unchanged visibility and use a stable `refId`** so Convex retries and rapid toggles don't produce duplicate notifications + webhook deliveries (P2 #5).

**Authz posture (verified):** sound. Every exported query/mutation/action gates on admin (`requireAdmin` for 7 exports, `requireAdminInAction` for the action); `requireAdmin` fails closed on unset/empty `ADMIN_USER_IDS`; no self-promotion path exists (admins are env-provisioned out-of-band, not role-promoted via any mutation); cross-org admin actions (visibility kill-switch, transfer retry) are intentional platform-operator powers, not bypasses; `isAdminQuery` returns only the caller's own admin status (no enumeration). No admin-bypass, no cross-org authz hole, no data-exfiltration primitive beyond the intended operator-view fields. The bugs are in *what the admin does after the gate* — the payout state machine — not the gate itself. The gate's one defect is duplication (`requireAdminInAction`), which is a P3 drift risk, not a current bypass.
