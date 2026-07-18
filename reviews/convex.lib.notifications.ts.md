# Tiger-Style Review — `convex/lib/notifications.ts`

This file is the **entire write surface** for in-app notifications: a single
`createNotification(ctx, args)` helper plus its argument/result types. Every
producer in the repo (`admin.ts`, `cronTasks.ts`, `payouts.ts`, `specs.ts`,
`webhooks.ts`) routes through it, so every defect here multiplies across
billing, spec publishing, webhook delivery, and admin actions. The file is
small, which hides how much it is trusted.

---

## Verdict

**Incorrect.** The headline defect is that the documented "idempotent insert"
is not idempotent under concurrency: `by_ref` is a plain Convex index with no
uniqueness constraint, and the lookup-then-insert sequence is not atomic, so
two concurrent producers of the same `refId` both read `null` from
`.unique()` and both insert — producing duplicate notifications that defeat
every dedupe `refId` callers carefully construct. On top of that, the helper
performs zero input validation (unbounded `title`/`body`/`refId`/`clerkOrgId`,
no FK check on `clerkOrgId`), is the natural chokepoint for notification-storm
throttling and provides none, and ships a dead `transfer_sent` variant that
implies a producer which does not exist. None of these are theoretical: the
`webhook_failed` producer keys on per-delivery `refId`s and embeds raw
external HTTP error text into `body`, so a misconfigured publisher endpoint
already produces both unbounded duplicates and unbounded payload inflation
through this function.

---

## File Stats

- File: `convex/lib/notifications.ts` (50 lines)
- Exports: `NotificationKind`, `CreateNotificationArgs`,
  `CreateNotificationResult`, `createNotification`
- Callers: `convex/admin.ts:233` (`visibility_changed`),
  `convex/cronTasks.ts:35` (`low_balance`),
  `convex/payouts.ts:482` (`transfer_failed`),
  `convex/specs.ts:175` (`spec_published`), `convex/specs.ts:338`
  (`version_deprecated`), `convex/webhooks.ts:278` (`webhook_failed`);
  tests `convex/notifications.test.ts`
- Schema: `notifications` table (`convex/schema.ts:108-127`), indexes
  `by_org` = `[clerkOrgId, createdAt]` and `by_ref` = `[refId]`
- Findings: 8 — P0: 0, P1: 2, P2: 4, P3: 2

---

## Findings

### [SEV: P1] "Idempotent insert" is not atomic — concurrent same-`refId` writes produce duplicates

**Location:** `convex/lib/notifications.ts:32-50`

```ts
export async function createNotification(
  ctx: MutationCtx,
  args: CreateNotificationArgs,
): Promise<CreateNotificationResult> {
  const existing = await ctx.db
    .query("notifications")
    .withIndex("by_ref", (q) => q.eq("refId", args.refId))
    .unique();
  if (existing !== null) {
    return { created: false, id: existing._id };
  }

  const id = await ctx.db.insert("notifications", {
    clerkOrgId: args.clerkOrgId,
    kind: args.kind,
    title: args.title,
    body: args.body,
    refId: args.refId,
    createdAt: Date.now(),
  });
  return { created: true, id };
}
```

**Problem:** Convex indexes are **not** unique constraints. `withIndex("by_ref")
.unique()` is a query helper that returns at most one matching row — it does
not prevent a second row with the same `refId` from being inserted. The
lookup and the insert run in the same OCC transaction, but two **separate**
mutations executing concurrently each observe a database state in which no
row with that `refId` exists yet (the other transaction's insert is not
visible until commit). Both pass the `existing !== null` check, both call
`insert`, and two notifications with the identical `refId` are persisted.
The JSDoc contract — *"Idempotent notification insert. If a notification with
the same refId already exists, returns { created: false } without writing."*
— is only honored for single-writer serial execution.

This is not a hypothetical path. Producers deliberately construct stable
`refId`s precisely **because** they expect retries and concurrent delivery to
coalesce:

- `webhooks.ts:283` — `refId: \`webhook_failed:${args.deliveryId}\``. The
  Convex scheduler is at-least-once; `recordDeliveryAttempt` is an
  `internalMutation` that can be retried by the scheduler after a transient
  action failure, and the surrounding `deliverWebhook` action is retried up
  to `MAX_WEBHOOK_ATTEMPTS` times. A retry that straddles a prior committed
  attempt creates a duplicate `webhook_failed` notification for the same
  delivery.
- `payouts.ts:487` — `refId: \`transfer_failed:${transfer._id}\``.
  `markPublisherTransferFailed` is an `internalMutation` invoked from Stripe
  webhook processing (`processStripeEvent`), which Stripe delivers
  at-least-once; duplicate Stripe events for the same transfer id are normal.
- `cronTasks.ts:34` — `refId: \`low_balance:${org.clerkOrgId}:${dayKey}\``.
  The hourly cron can overlap a late prior run; both will read no existing row
  for the current UTC day at the moment they query.

**Impact:** Duplicate notifications in the org feed (visible via `listForOrg`
in `convex/notifications.ts:23-46`), inflated `unreadCount`, duplicate
`webhook_failed` alarms for one delivery, and double `transfer_failed`
notifications for one Stripe event. The idempotency guarantee that every
caller relies on is silently absent under the only condition it matters
under — concurrent retry.

**Fix:** Convex has no unique constraint, so true idempotency requires either
(a) a defensive re-check inside the same transaction is insufficient (OCC
still allows both to commit), so the realistic fix is to make the
**producers** idempotent at their own write boundary (e.g. gate the
`webhook_failed` insert on the `webhookDeliveries` row already being in
`status: "failed"` — if the patch is a no-op because the row is already
failed, skip the notification) and/or (b) accept that the helper is a
best-effort dedupe and rename the JSDoc to stop claiming idempotency, then
have consumers dedupe on read. At minimum, narrow the false contract.

---

### [SEV: P1] No input validation — unbounded `title`/`body`/`refId`/`clerkOrgId`; external error text reaches `body`

**Location:** `convex/lib/notifications.ts:14-21` (types), `:43-49` (insert)

```ts
export type CreateNotificationArgs = {
  clerkOrgId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  refId: string;
};
```

**Problem:** `createNotification` accepts arbitrary-length strings for
`title`, `body`, `refId`, and `clerkOrgId` with no cap, no trim, and no
content sanitization. The values are persisted verbatim into the
`notifications` table and returned verbatim to every member of the org via
`listForOrg` (`convex/notifications.ts:36-44`). The `webhook_failed` producer
(`webhooks.ts:282`) embeds the raw external transport error string into
`body`:

```ts
body: `Delivery of "${delivery.event}" failed after ${MAX_WEBHOOK_ATTEMPTS} attempts${args.error !== undefined ? `: ${args.error}` : ""}.`
```

`args.error` originates as `err.message` from `fetch` inside `postWebhook`
(`convex/lib/webhookDelivery.ts:81-83`) — i.e. unbounded, attacker-influenced
text from the publisher's own endpoint or the network path to it. That string
is persisted indefinitely and shown to all org members. A malicious or
misconfigured webhook target returning a multi-KB error body, or a fetch
error embedding internal hostnames/IPs/ports (`connect ECONNREFUSED
10.0.5.23:443`), lands in `notifications.body` with no truncation and no
allowlist. The `spec_published` and `version_deprecated` producers also
interpolate `project.name` / `args.message` (publisher-controlled free text)
into `body`; `args.message` is `v.optional(v.string())` with no length cap
in `specs.ts:329`.

`refId` is similarly unbounded; producers build it from `Date.now()` and ids,
so it is bounded in practice today, but the helper enforces nothing and a
future producer passing user input would silently inflate the `by_ref` index
keys.

**Impact:** Persistent unbounded payload in the `notifications` table
(Convex document-size limit approached on pathological inputs), unbounded
response size in `listForOrg`, and leakage of internal network topology /
hostnames / IPs into a publisher-org-visible feed. The cross-boundary concern
(webhook transport layer → notification display layer) flows through this
helper, which is the correct place to cap.

**Fix:** Cap fields at the helper boundary — `title` ≤ 200 chars, `body` ≤
1024 chars, `refId` ≤ 200 chars — truncating with an ellipsis marker rather
than throwing (notifications are best-effort). Do not accept raw
transport-error text as `body` content; have the `webhook_failed` caller map
errors to a fixed vocabulary before calling. Reject/trim `clerkOrgId` to a
plausible Clerk org id shape.

---

### [SEV: P2] No `clerkOrgId` FK validation — orphaned notifications and latent cross-org-leak surface

**Location:** `convex/lib/notifications.ts:32-50`

**Problem:** `createNotification` writes `args.clerkOrgId` directly into the
row without confirming that an `organizations` row with that `clerkOrgId`
exists. The `organizations` table mirrors Clerk orgs
(`convex/schema.ts:10-16`, indexed `by_clerk_org`), and orgs can be deleted
or renamed on the Clerk side at any time. Every producer in the codebase
resolves `org.clerkOrgId` from a freshly-loaded `organizations` doc immediately
before calling, so today the id is fresh at call time — but the helper itself
is the enforcement point and enforces nothing. Two consequences:

1. **Orphaned notifications.** A producer that holds a stale `clerkOrgId`
   (e.g. `cronTasks.ts:30-43` loads `wallets` then `org` per row; if the org
   is deleted between loads — unlikely but possible — the notification is
   written for an org that no longer exists and is visible to nobody, with
   no cleanup path). Same for `payouts.ts:480-487` and `admin.ts:231-238`,
   which load `org` then call the helper without re-checking existence.
2. **Latent cross-org leak.** Should any future caller pass a
   user-influenced `clerkOrgId` (none do today, but the type is just
   `string`), the notification lands in another org's `by_org` view with no
   gate. The helper is the single chokepoint where this would be cheap to
   prevent.

**Impact:** Orphaned rows accumulating indefinitely (no GC, no TTL on
`notifications`); a single careless future caller becomes a cross-org
notification leak. The `by_org` index key is `clerkOrgId`, so the leak is
direct: `listForOrg` (`convex/notifications.ts:29-32`) filters by
`org.clerkOrgId` and returns whatever matches, including a notification a
different org's producer mistakenly keyed to this org.

**Fix:** Validate `clerkOrgId` against `organizations.by_clerk_org` inside
`createNotification` (one indexed `unique()` lookup) and return
`{ created: false, id: null }` if no such org exists. Document that callers
must pass the live `clerkOrgId` from the org doc, not a cached value.

---

### [SEV: P2] No rate limiting / coalescing at the single write chokepoint — notification storm vector

**Location:** `convex/lib/notifications.ts:32-50`

**Problem:** `createNotification` is the only path that writes to the
`notifications` table, which makes it the natural place to throttle — and it
imposes no per-org, per-kind, or per-`refId`-prefix rate limit, no coalescing,
and no cap on unread count per org. The `webhook_failed` producer is the
sharp edge: its `refId` is `webhook_failed:${deliveryId}`
(`webhooks.ts:283`), and `deliveryId` is unique per `fireWebhookEvent` call.
`fireWebhookEvent` is invoked on every `spec.published`
(`specs.ts:184-187`), `spec.deprecated` (`specs.ts:345-348`), and
`project.visibility_changed` (`admin.ts:241-244`). If a publisher's endpoint
is misconfigured and returns non-2xx, `recordDeliveryAttempt`
(`webhooks.ts:244-263`) retries up to `MAX_WEBHOOK_ATTEMPTS` and then calls
`createNotification` with a **fresh** `refId` for each delivery. Result: one
`webhook_failed` notification per failed delivery, no coalescing, no cap. A
publisher that publishes 50 spec versions with a broken endpoint gets 50
`webhook_failed` notifications in the feed, all unread, all with near-
identical bodies. `unreadCount` (computed via `.collect()` in
`convex/notifications.ts:35-39`) grows linearly and is recomputed in full
on every paginated `listForOrg` call.

The same shape exists for `low_balance` (capped at one-per-org-per-day by
the cron's `refId`, so safe), `transfer_failed` (one per transfer id, safe),
`spec_published` (one per version id — a publisher scripting rapid publishes
floods their own feed, lower severity), and `version_deprecated` (one per
version, safe).

**Impact:** Feed spam, `unreadCount` inflation, and a full-table-per-org
scan in `listForOrg`'s unread counter on every page load (see also the
sibling-file scan issue, out of scope here but amplified by storm volume).
The helper is the right place to cap unread notifications per org per kind
within a window (e.g. "at most one `webhook_failed` per org per hour,
superseding prior unread ones of the same kind").

**Fix:** Add an optional coalescing hint to `CreateNotificationArgs` (e.g.
`coalesceKey?: string` and `coalesceWithinMs?: number`); when set, the
helper marks prior unread notifications with the same `coalesceKey` as
superseded (or simply skips creation if a recent one exists). At minimum,
expose a per-org-per-kind rate limit so a broken endpoint cannot storm the
feed. Barring that, narrow the `webhook_failed` `refId` to include a
coarsened time bucket so retries within a window collapse.

---

### [SEV: P2] `transfer_sent` notification kind is dead — declared but never produced

**Location:** `convex/lib/notifications.ts:7-12`, `convex/schema.ts:122-123`

```ts
export type NotificationKind =
  | "low_balance"
  | "spec_published"
  | "version_deprecated"
  | "webhook_failed"
  | "visibility_changed"
  | "transfer_failed"
  | "transfer_sent";
```

**Problem:** `transfer_sent` is declared in the `NotificationKind` union and
in the `notifications.kind` schema validator, but no producer in the repo
ever creates a notification of this kind. Grep for `kind: "transfer_sent"`
across `convex/` returns zero hits; the only `transfer_*` producer is
`payouts.ts:484` (`transfer_failed`). The successful-publisher-transfer path
(`payouts.ts` — `markPublisherTransferSucceeded` or equivalent) either does
not exist, does not notify, or was wired to a different kind. A consumer
polling the feed (or a future `listForOrg` filter by kind) sees a kind in
the type union that can never appear, which is a type-safety lie: the union
overstates the reachable runtime values.

**Impact:** Dead variant in a public-ish type; implies a notification path
that does not exist; misleading to any consumer that switches on `kind`
believing `transfer_sent` is reachable. Also bloats the schema union for no
benefit.

**Fix:** Either remove `transfer_sent` from `NotificationKind` and the
schema union (a Convex schema migration — safe because no rows exist with
this kind), or wire the publisher-transfer-succeeded path to emit it. If
kept as a placeholder, mark it explicitly and do not export it in the
runtime type union until a producer exists.

---

### [SEV: P2] `createdAt: Date.now()` is not monotonic across concurrent inserts — `by_org` ordering is unstable within a millisecond

**Location:** `convex/lib/notifications.ts:48`

```ts
const id = await ctx.db.insert("notifications", {
  ...
  refId: args.refId,
  createdAt: Date.now(),
});
```

**Problem:** The `by_org` index is `[clerkOrgId, createdAt]`
(`convex/schema.ts:124`), and `listForOrg` paginates it with `order("desc")`
(`convex/notifications.ts:29-32`). `createdAt` is `Date.now()` — millisecond
resolution. Two notifications inserted for the same org within the same
millisecond (plausible during a `webhook_failed` storm, or when a single
Stripe event triggers both a `transfer_failed` and a sibling notification)
share an identical `createdAt` and their relative order in the index is
undefined; Convex does not guarantee secondary ordering by `_id`. Pagination
over `order("desc")` on a non-unique key can therefore return rows in
non-deterministic order across page boundaries, and a cursor paginated
mid-storm can skip or repeat rows. The `_id` itself is monotonic but is not
part of the index, so it cannot rescue ordering.

**Impact:** Non-deterministic feed ordering under burst writes; potential
duplicate or missing rows across pagination cursors during a notification
storm — exactly the moment stable paging matters most.

**Fix:** Either extend the `by_org` index to `[clerkOrgId, createdAt, _id]`
(not directly expressible — `_id` cannot be appended to a Convex index
beyond using it as the implicit tiebreaker, which Convex does for
`_creationTime`-based ordering). The clean fix is to use `_creationTime`
(automatically monotonic) for ordering instead of a manual `createdAt`
field — but that requires migrating the index and the `NotificationView`.
Short of that, accept the instability and document it; do not rely on
strict newest-first paging during bursts.

---

### [SEV: P3] `kind` is type-only — no runtime guard against a TS-bypassed caller

**Location:** `convex/lib/notifications.ts:6-12`, `:32-50`

**Problem:** `CreateNotificationArgs.kind` is typed as `NotificationKind`
and the `notifications` table schema (`schema.ts:113-122`) is a `v.union` of
literals, so a TS-correct caller is constrained and a runtime-invalid kind
will throw at `insert` time from the Convex validator. However, the helper
itself does no runtime check, and any caller using `as any` / `as
NotificationKind` (or a JS caller) passes an arbitrary string that only fails
at the DB layer with a generic validation error rather than a typed
`createNotification` error. Defense-in-depth is absent.

**Impact:** Low. The DB validator is the real backstop; this is a
clean-error-message and early-failure concern only.

**Fix:** Optional: assert `kind` against the literal set at the top of
`createNotification` and throw a typed error. Not blocking.

---

### [SEV: P3] `CreateNotificationResult.id` is nullable but callers never branch on `null`

**Location:** `convex/lib/notifications.ts:23-27`, `:37-38`

```ts
export type CreateNotificationResult = {
  created: boolean;
  id: Id<"notifications"> | null;
};
```

**Problem:** The result type declares `id: Id<"notifications"> | null`, but
the implementation only returns `null` in a branch that does not exist: the
`existing !== null` path returns `existing._id` (non-null), and the insert
path returns the freshly-created `id` (non-null). There is no code path that
returns `{ created: ..., id: null }`. The nullable type is therefore dead —
a lie about reachable runtime states that forces every caller (`admin.ts`,
`cronTasks.ts:37-41`, `payouts.ts`, `specs.ts`, `webhooks.ts`) to either
ignore `id` or handle a `null` that can never occur. `cronTasks.ts:41` reads
`result.created` only; the others ignore the result entirely. The nullable
`id` suggests a failure mode the helper does not actually produce, which
will mislead the next maintainer into adding a `null` check that does
nothing or, worse, into relying on `null` to signal a real error that the
helper never emits.

**Impact:** Misleading API surface; dead branch in the type; minor
maintenance hazard.

**Fix:** Either narrow the type to `id: Id<"notifications">` (matching
reality), or introduce an actual `id: null` failure path (e.g. when
`clerkOrgId` validation fails per the FK finding above) and have callers
handle it. Do not ship a nullable field with no producing branch.

---

## Summary

8 findings — **P0: 0, P1: 2, P2: 4, P3: 2**.

Top 3:

1. **[P1] Idempotency is not atomic.** `by_ref` is not a unique constraint;
   concurrent same-`refId` producers both pass `.unique()` and both insert,
   defeating every dedupe `refId` callers construct. The JSDoc contract is
   false under the only condition it matters under — concurrent retry
   (scheduler duplicates, Stripe redeliveries, overlapping crons).
2. **[P1] No input validation; external error text reaches `body`.** The
   helper accepts unbounded `title`/`body`/`refId`/`clerkOrgId` and persists
   them verbatim; the `webhook_failed` producer embeds raw `fetch` error
   messages (hostnames, IPs, ports, arbitrary length) into the org-visible
   feed.
3. **[P2] No rate limiting / coalescing at the write chokepoint.** The
   `webhook_failed` producer's per-delivery `refId` means a broken publisher
   endpoint storms the feed with one notification per failed delivery, with
   no coalescing, no unread cap, and a full-per-org `.collect()` unread
   counter on every `listForOrg` page load.

The dead `transfer_sent` variant, the unstable `createdAt` ordering under
burst writes, the missing `clerkOrgId` FK check, and the misleading nullable
`id` are secondary but should not ship.
