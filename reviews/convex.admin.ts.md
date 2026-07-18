# Tiger-Style Review — `convex/admin.ts`

## Verdict
NEEDS WORK — admin role gating itself is correct (`requireAdmin`/`requireAdminInAction` both fail closed, env-driven, applied to every export). The real defects are in the privileged *side effects*: `retryPublisherTransfer` skips every eligibility re-check the normal payout path enforces and can clobber a concurrently-reversed/succeeded transfer's ledger state; `platformStats` contradicts its own "All bounded/indexed" doc with two unbounded `collect()` scans; and several smaller correctness/contract gaps (non-idempotent notification refIds, status filter not indexed, unused dead-code import) round it out. No admin-bypass/self-promotion or cross-org authz hole found — the admin boundary itself is sound.

## File Stats
- **Path:** `convex/admin.ts`
- **LOC:** 381
- **Role:** Platform-admin surface. Highest-privilege endpoints: platform-wide stats, org/project/usage listing, project visibility kill-switch (cross-org), publisher-transfer operator view, and Stripe Connect transfer retry. Every exported function must gate on `requireAdmin` (queries/mutations) or `requireAdminInAction` (actions).
- **Auth model:** `ADMIN_USER_IDS` env (comma-separated Clerk `subject` ids). Fail-closed when unset. No role table, no self-promotion path — admins are provisioned out-of-band via env. Correct.

## Findings

---

### [SEV: P1] `retryPublisherTransfer` bypasses connected-account eligibility re-check; can transfer to a disabled/restricted account
**Location:** `convex/admin.ts:335-372` (`retryPublisherTransfer` action); contrast `convex/payouts.ts:318-416` (`preparePublisherTransfer`).

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
  ...
```

**Problem:** The normal publisher-initiated path (`initiatePublisherTransfer` → `preparePublisherTransfer`) gates the transfer on a fresh read of `organizationPayments`: it requires `payoutsEnabled === true`, `disabledReason === undefined`, and a present `stripeConnectedAccountId` (`payouts.ts:325-333`). The admin retry path reads none of that — it takes the `stripeConnectedAccountId` snapshot stored on the transfer row (possibly days/weeks old) and fires `transfers.create` directly. Between the original transfer's creation and the admin retry, Stripe may have disabled payouts on the connected account (fraud hold, `requirements.past_due`, account rejected). `preparePublisherTransfer` would throw `"Connected account is not eligible for transfers"`; the retry blindly sends the money movement request.

**Impact:** A transfer can be pushed to an account Stripe has since disabled/flagged. In the benign case Stripe rejects it and `markPublisherTransferFailed` records the failure (status quo preserved). In the worse case the account is in a transiently-disabled state Stripe still accepts transfers for, or the snapshot's `stripeConnectedAccountId` is stale relative to the publisher's current account — funds move to a connected account that should no longer receive payouts, requiring manual Stripe reversal. For a *payout* primitive under admin control, the eligibility gate belongs on the retry path too.

**Fix:** Re-check eligibility inside the retry action (or fold retry through `preparePublisherTransfer`-style logic) before calling Stripe:
```ts
const profile = await ctx.runMutation(internal.payouts.getConnectProfileForTransferOrg, {
  publisherOrganizationId: transfer.publisherOrganizationId,
});
if (
  profile === null ||
  profile.stripeConnectedAccountId === undefined ||
  !profile.payoutsEnabled ||
  profile.disabledReason !== undefined
) {
  throw new Error("Connected account is no longer eligible for transfers");
}
```
At minimum assert `profile.stripeConnectedAccountId === transfer.stripeConnectedAccountId` to catch stale-snapshot drift.

---

### [SEV: P1] `retryPublisherTransfer` clobbers a concurrently-updated transfer status (race with Stripe webhook)
**Location:** `convex/admin.ts:356-366` (Stripe call + `markPublisherTransferSucceeded`); `convex/payouts.ts:426-455` (`markPublisherTransferSucceeded`); `convex/payouts.ts:466-523` (`projectStripeTransfer` webhook handler).

```ts
if (transfer.status === "succeeded" || transfer.status === "reversed") {
  return { transferId: transfer._id };
}
// ... gap: Stripe webhook may fire projectStripeTransfer here ...
const stripeTransfer = await stripeClient().transfers.create(...);
await ctx.runMutation(internal.payouts.markPublisherTransferSucceeded, {
  transferId: transfer._id,
  stripeTransferId: stripeTransfer.id,
});
```

**Problem:** The status read at T0 (`getPublisherTransfer`) and the Stripe `transfers.create` at T1 are in separate Convex transactions (this is an action). Between them, Stripe's async webhook can land: `projectStripeTransfer` (`payouts.ts:466`) looks up the transfer by `stripeTransferId` and patches its `status` to `succeeded`/`failed`/`reversed`. Because `markPublisherTransferSucceeded` (`payouts.ts:426`) patches `status: "succeeded"` **unconditionally** — no guard on the current status — the admin retry's success-marking can overwrite a `reversed` state (Stripe reversed the transfer between T0 and the admin's success callback) back to `succeeded`, while the earnings it flips to `transferred` were already moved to `failed`/`reversed` by `projectStripeTransfer`. The transfer row and its earnings are now mutually inconsistent: transfer says `succeeded`, some earnings say `reversed`.

The same applies in reverse: if the webhook marks `succeeded` between T0 and T1, the admin's Stripe call with the same idempotency key is a no-op (Stripe returns the original), but `markPublisherTransferSucceeded` runs again and re-patches — idempotent on status but re-iterates the earnings scan/patch unnecessarily; the dangerous case is the `reversed` overwrite.

**Impact:** Inconsistent payout ledger state under the (admittedly narrow) admin-retry-vs-webhook-reversal race. Earnings can end up marked `transferred` while the transfer they reference is later reversed by Stripe, leaving money double-counted or un-reversable. The idempotency key prevents a *double Stripe transfer*; it does not prevent the local ledger-status clobber.

**Fix:** Make `markPublisherTransferSucceeded` status-guarded (only patch if current status ∈ {`created`,`pending`,`failed`} — i.e. not already `succeeded`/`reversed`), and have the retry action re-fetch the transfer's current status immediately before calling `markPublisherTransferSucceeded`:
```ts
// in markPublisherTransferSucceeded (payouts.ts):
if (transfer.status === "succeeded" || transfer.status === "reversed") return;
```

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
```

**Problem:** The docstring promises "All bounded/indexed." `usageThisMonth` is indeed capped (`take(USAGE_STATS_CAP)`). But `organizations` and `projects` are loaded with bare `.collect()` — full scans with no index, no cap, no pagination. At platform scale (the admin panel is explicitly a platform-wide tool), both collections grow without bound. `organizations` has no count primitive; `projects` has a `by_visibility_status` index that *could* answer the draft/published counts without a scan, but isn't used. The function loads every org and every project document into the transaction only to call `.length` / `.filter(...).length`.

**Impact:** Unbounded memory/transaction cost on the admin overview page as the platform grows; the doc comment actively misleads reviewers into thinking the path is bounded. Not a correctness bug, but a real perf cliff and a false-contract doc.

**Fix:** Either fix the doc to say "usage is capped; org/project counts scan" and accept it for an admin tool, or — better — add `count()` semantics. For the status split, use the `by_visibility_status` index:
```ts
const draft = await ctx.db.query("projects")
  .withIndex("by_visibility_status", (q) =>
    q.eq("visibility", "private").eq("status", "draft")).count();
```
(Convex supports `.count()` on indexed queries.) For orgs, there is no narrower path, so document the scan or maintain a counter.

---

### [SEV: P2] `setProjectVisibility` notification refId embeds `Date.now()` — not idempotent across rapid re-toggles, and not deduped per visibility value
**Location:** `convex/admin.ts:234-241`.

```ts
await createNotification(ctx, {
  clerkOrgId: org.clerkOrgId,
  kind: "visibility_changed",
  title: "Project visibility changed",
  body: `Your project "${project.name}" visibility was set to ${args.visibility} by platform admin.`,
  refId: `visibility_changed:${args.projectId}:${Date.now()}`,
});
```

**Problem:** `createNotification` dedupes by `refId` (`lib/notifications.ts`). Here `refId` includes `Date.now()`, so every invocation produces a distinct refId — the dedup never fires. Two admin toggles in the same second (or an admin rapid-toggling public→private→public) generate duplicate notifications for the same logical event, and there is no guard that the visibility actually *changed* before notifying: setting `visibility: "public"` on a project that is already `public` still patches the doc (no-op write) and still fires a notification + webhook. Compare with the canonical pattern elsewhere (e.g. `transfer_failed:${transfer._id}`) which is stable per resource.

**Impact:** Notification spam on rapid toggles; a no-op visibility "change" (same value) notifies the org and fires `project.visibility_changed` to their webhook for nothing. Webhook consumers cannot dedupe because there is no monotonic per-change identifier.

**Fix:** Guard on actual change and use a stable-but-monotonic refId:
```ts
if (project.visibility === args.visibility) {
  return await ctx.db.get(args.projectId) as Doc<"projects">;
}
await ctx.db.patch(args.projectId, { visibility: args.visibility });
...
refId: `visibility_changed:${args.projectId}:${args.visibility}`,
```
(The `:visibility` suffix makes the latest state dedupable; if a truly per-event id is needed, accept an `idempotencyKey` arg instead of `Date.now()`.)

---

### [SEV: P2] `listPublisherTransfers` status filter uses `.filter()` (no `by_status` index) — paginates-then-filters, can starve pagination
**Location:** `convex/admin.ts:303-310`; schema `publisherTransfers` (`convex/schema.ts` has `by_publisher`, `by_idempotency_key`, `by_stripe_transfer` — no `by_status`).

```ts
const result = args.status
  ? await q.order("desc")
      .filter((qq) => qq.eq(qq.field("status"), args.status!))
      .paginate(args.paginationOpts)
  : await q.order("desc").paginate(args.paginationOpts);
```

**Problem:** Convex `.filter()` applies *after* pagination — it takes the page of N rows and filters those. When filtering for a rare status (e.g. `reversed`, `failed`) across a large table of `succeeded` transfers, a page of 20 `succeeded` rows yields an empty filtered page; the client must keep paginating (`continueCursor`) until it accumulates any matching rows. This is functionally correct but pathological for rare-status queries: the admin "failed transfers" view (the most useful admin filter — it's exactly what `retryPublisherTransfer` operates on) can return many empty pages before the first hit. The `by_status` index doesn't exist, and `by_status_available` is on `publisherEarnings`, not `publisherTransfers`.

**Impact:** Sluggish/empty-page pagination on the admin payouts filter for the exact statuses admins care about most (failed/reversed). No data loss.

**Fix:** Add a `by_status` index to `publisherTransfers` (`.index("by_status", ["status", "createdAt"])`) and switch the filtered branch to `withIndex`. The unfiltered path stays as-is.

---

### [SEV: P3] `requireAdminInAction` duplicates `requireAdmin` logic instead of reusing the lib — drift risk
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

**Problem:** `lib/auth.ts` already has `requireAdmin` and `isAdmin`; both read `ADMIN_USER_IDS`, split, trim, filter, and `includes(claims.subject)` with byte-identical semantics and identical error strings ("Not authorized as admin"). The action version exists only because `requireAdmin` is typed for `QueryCtx | MutationCtx` (no `ActionCtx`). The two copies have already drifted slightly: `requireAdmin` returns the `OrgIdentityClaims`; `requireAdminInAction` returns `void` and re-fetches the identity inline. Any future change to the admin gate (e.g. adding a role claim, a deny-list, a rate limit) must be made in two places or the action path silently diverges from the query/mutation path.

**Impact:** Drift risk on the single most security-critical gate in the system. No current behavioral difference.

**Fix:** Generalize `requireAdmin`'s `DbCtx` to also accept `ActionCtx` (or extract a pure `checkAdminFromIdentity(identity)` that both call), and delete `requireAdminInAction`.

---

### [SEV: P3] Unused import `stripeClient` path is fine, but `internal` import only used for `payouts.*` — dead `Doc`/`Id` usage in retry return type is fine; `startOfUtcMonth` is fine
**Location:** `convex/admin.ts:1-10`.

**Problem:** Minor — no dead imports found on inspection. `stripeClient`, `internal`, `fireWebhookEvent`, `createNotification`, `isAdmin`, `requireAdmin` are all used. Listing here only to note I checked and found nothing actionable at P3 beyond the above. *(No change required.)*

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
- **P1:** 2 — retryPublisherTransfer skips connected-account eligibility re-check (#1); retry-vs-webhook race clobbers transfer/earnings status consistency (#2).
- **P2:** 3 — platformStats false "bounded/indexed" doc + unbounded scans (#3); setProjectVisibility non-idempotent refId + no-op-change notify/webhook (#4); listPublisherTransfers status filter not indexed, starves pagination (#5).
- **P3:** 3 — duplicated requireAdminInAction drift risk (#6); recentUsage no-op lte bound (#7); import audit clean (#8).

**Top 3 to fix before merge:**
1. Gate `retryPublisherTransfer` on fresh `organizationPayments` eligibility + stale-snapshot check (P1 #1).
2. Make `markPublisherTransferSucceeded` status-guarded so the admin retry can't overwrite a concurrent `reversed`/`succeeded` (P1 #2).
3. Fix `setProjectVisibility` to no-op when visibility is unchanged and use a stable refId (P2 #4).

**Authz posture:** sound. Every exported query/mutation/action gates on admin; `requireAdmin` fails closed on unset env; no self-promotion path exists (admins are env-provisioned, not role-promoted); cross-org admin actions (visibility kill-switch, transfer retry) are intentional platform-operator powers, not bypasses. The bugs are in *what the admin does after the gate*, not the gate itself.
