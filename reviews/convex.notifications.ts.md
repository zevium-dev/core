# Tiger-Style Review — `convex/notifications.ts`

This file is the **public read/mutation surface** for in-app notifications:
`listForOrg` (paginated realtime query + `unreadCount`), `markRead` (single),
`markAllRead` (bulk). It is mounted as a **realtime subscription** in the app
layout (`apps/web/src/components/notification-bell.tsx:109-115`), so every
defect here fires on every notification change for every connected member of
every org, not just on explicit user action.

---

## Verdict

**Incorrect.** The headline defect is a performance cliff: `listForOrg` is a
realtime subscription that, on every re-fire, runs **two** `by_org` index
scans — one for the page and one for `unreadCount` — and the unread counter
uses `.filter(readAt === undefined).collect()`, which is a **post-index-scan
filter** that materializes every notification (read and unread) the org has
ever produced, just to count them. There is no index on `readAt`
(`by_org` = `[clerkOrgId, createdAt]`, `by_ref` = `[refId]` — neither covers
`readAt`), so "bounded scan of the by_org index" in the code comment is wrong.
The same full-scan-then-filter pattern repeats in `markAllRead` on the write
path. On top of that, notifications are org-scoped with no per-user read
state and no role check, so any `org:member` can dismiss `low_balance` and
`transfer_failed` notifications for the entire org — including for the billing
admin who is the actual audience — with no audit trail; `markRead` is a
cross-org existence oracle via distinguishable error messages; `markAllRead`
returns a pre-snapshot `updated` count that drifts under concurrency and
patches in an unbounded sequential loop that can time out under the
notification-storm volume the sibling helper allows; and `markRead`'s
`{ ok: boolean }` return is dead — `ok` is always `true` or the call throws.

---

## File Stats

- File: `convex/notifications.ts` (96 lines)
- Exports: `NotificationView`, `NotificationsPage`, `listForOrg`, `markRead`,
  `markAllRead`
- Callers: `apps/web/src/components/notification-bell.tsx:110` (`listForOrg`
  as realtime subscription via `convexQuery`), `:118` (`markRead`), `:119`
  (`markAllRead`); tests `convex/notifications.test.ts`
- Schema: `notifications` table (`convex/schema.ts:108-127`); indexes
  `by_org` = `[clerkOrgId, createdAt]`, `by_ref` = `[refId]`; **no index on
  `readAt`**
- Auth: `requireIdentity` / `requireOrgMemberBySlug` from `convex/lib/auth.ts`
- Findings: 9 — P0: 0, P1: 3, P2: 4, P3: 2

---

## Findings

### [SEV: P1] `listForOrg` `unreadCount` is a full per-org scan on every realtime tick

**Location:** `convex/notifications.ts:34-46`

```ts
const result = await ctx.db
  .query("notifications")
  .withIndex("by_org", (q) => q.eq("clerkOrgId", org.clerkOrgId))
  .order("desc")
  .paginate(args.paginationOpts);

// Count unread — bounded scan of the by_org index (readAt undefined).
// This is a background/dashboard query, not a hot path.
const unreadRows = await ctx.db
  .query("notifications")
  .withIndex("by_org", (q) => q.eq("clerkOrgId", org.clerkOrgId))
  .filter((q) => q.eq(q.field("readAt"), undefined))
  .collect();

return {
  ...
  unreadCount: unreadRows.length,
};
```

**Problem:** The `by_org` index is `[clerkOrgId, createdAt]`
(`convex/schema.ts:125`). `withIndex("by_org", q => q.eq("clerkOrgId", ...))`
returns **every** notification for the org — read and unread — in index
order. `.filter(q => q.eq(q.field("readAt"), undefined))` is a
**post-index-scan filter** applied in JS after the rows are read; it cannot
use the index to narrow to unread rows because `readAt` is not part of any
index key. `.collect()` then materializes the full unread doc set into
memory solely to read `.length`. The code comment claiming "bounded scan of
the by_org index" and "not a hot path" is wrong on both counts:

1. The scan is bounded only by the org's total notification history, not by
   its unread count. An org with 50,000 historical notifications (most
   read) and 3 unread reads all 50,000 docs off the index, deserializes
   them, filters in JS, and discards 49,997.
2. This is a **realtime subscription**. `notification-bell.tsx:109-115`
   mounts `convexQuery(api.notifications.listForOrg, ...)` in the app
   layout — every page that renders the bell holds this subscription open,
   and Convex re-runs the query on every notification change in the org
   (insert via `createNotification`, patch via `markRead`/`markAllRead`).
   Each re-fire repeats the full scan for every connected member.

This is amplified by the sibling-helper storm vector
(`reviews/convex.lib.notifications.ts.md` finding "No rate limiting /
coalescing"): a broken webhook endpoint produces one `webhook_failed`
notification per failed delivery, all unread, and every new insert re-triggers
this O(N) scan for every member.

**Impact:** Per-tick cost grows linearly with the org's lifetime notification
count, multiplied by the number of connected members, multiplied by the
write rate. A mature org with a misconfigured webhook can saturate Convex
query bandwidth on bell subscriptions alone. `unreadCount` is also returned
to the client on every page, so the response payload is correct but the cost
is pathological.

**Fix:** Add a dedicated index that lets unread rows be found without
scanning read rows. The cleanest is a separate denormalized counter (a
`notificationCounts` table keyed by `clerkOrgId` with an `unread` integer,
bumped by `createNotification` (+1) and `markRead`/`markAllRead` (−delta))
read by a single indexed lookup. If schema changes are off the table, at
minimum stop materializing full docs: count via a paginated walk using
`.paginate({ numItems: N, cursor })` and aggregate `page.length` without
holding the docs — but this is still O(N). The real fix is a counter
denormalization or an index `by_org_read` = `[clerkOrgId, readAt]` (with
`readAt` defaulted to a sentinel like `0` for unread so the index is usable;
`undefined` does not index).

---

### [SEV: P1] `markAllRead` scans the entire org notification history to find unread rows

**Location:** `convex/notifications.ts:83-93`

```ts
const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
const now = Date.now();
const unread = await ctx.db
  .query("notifications")
  .withIndex("by_org", (q) => q.eq("clerkOrgId", org.clerkOrgId))
  .filter((q) => q.eq(q.field("readAt"), undefined))
  .collect();
for (const n of unread) {
  await ctx.db.patch(n._id, { readAt: now });
}
return { updated: unread.length };
```

**Problem:** Same root cause as the `listForOrg` finding above, on the write
path. `.withIndex("by_org", ...)` returns the org's entire notification
history; `.filter(readAt === undefined)` is a post-scan JS filter; `.collect()`
materializes every unread doc. For an org with a large historical read set
and a small unread set, this is a full scan before the first patch. The scan
and the patches all run inside one OCC transaction, so the transaction is
held open for `scan_time + N × patch_time`, increasing contention with every
concurrent reader (including the realtime `listForOrg` subscriptions).

**Impact:** `markAllRead` latency grows with the org's lifetime notification
count, not its unread count. Under the `webhook_failed` storm this can run
into thousands of scanned docs plus thousands of sequential patches (see the
batching finding below), pushing the mutation toward Convex's transaction
time limit and causing full rollback on timeout — leaving the user stuck
with unread notifications and a "success" toast that never fires.

**Fix:** Same as the `listForOrg` fix — a `by_org_read` index or a
denormalized counter. For `markAllRead` specifically, if a counter is added,
the mutation becomes `patch notificationCounts set unread = 0` plus a single
bulk patch of the unread rows found via the new index (which can also be
paginated to avoid holding one giant transaction).

---

### [SEV: P1] Any org member can mark all notifications read for the entire org, including admin-targeted kinds

**Location:** `convex/notifications.ts:55-93` (`markRead`, `markAllRead`)

```ts
export const markRead = mutation({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const claims = await requireIdentity(ctx);
    ...
    if (notification.clerkOrgId !== claims.orgId) {
      throw new Error("Not a member of this organization");
    }
    if (notification.readAt !== undefined) return { ok: true };
    await ctx.db.patch(args.notificationId, { readAt: Date.now() });
    return { ok: true };
  },
});
```

**Problem:** The `notifications` table has no `userId` / `clerkUserId`
field (`convex/schema.ts:108-127`) — `readAt` is a single org-wide timestamp,
not per-user. Both `markRead` and `markAllRead` check only that the caller is
a member of the org (`requireIdentity` + `clerkOrgId` match, or
`requireOrgMemberBySlug`); neither checks `orgRole`. As a result:

- A `org:member` (lowest privilege) can call `markAllRead` and dismiss **every**
  unread notification for the entire org, including `low_balance`
  (audience: billing admin), `transfer_failed` (audience: earnings admin),
  `version_deprecated` (audience: spec maintainers), and `webhook_failed`
  (audience: integration owners).
- Once `readAt` is set, the notification renders at `opacity-60` and is
  visually deprioritized for every other member
  (`notification-bell.tsx` `data-read={read}` → `data-[read=true]:opacity-60`),
  and the badge `unreadCount` drops for everyone.
- There is no audit trail of *who* marked a notification read — `readAt` is a
  bare timestamp.

The kinds are not generic activity feed items; several are explicitly
role-targeted (`low_balance` from `cronTasks.ts:35`, `transfer_failed` from
`payouts.ts:484`). Letting any member silently dismiss them for the org is an
authz gap: read state is shared mutable state, and every member has write
access to all of it.

**Impact:** A low-privilege org member (or a compromised member account) can
suppress `low_balance` and `transfer_failed` alerts before the org's billing
admin sees them, with no record that the dismissal happened or who performed
it. This defeats the purpose of the alert kinds that originate from billing
and payout flows.

**Fix:** Either (a) add a `readBy: Id<"users">[]` or a separate per-user
`notificationReads` table so read state is per-user, and have
`listForOrg`'s `NotificationView.read` reflect the *caller's* read state, not
the org's; or (b) if org-wide read state is intentional, restrict
`markRead`/`markAllRead` to `org:admin` (`claims.orgRole === "org:admin"`)
for the role-targeted kinds, or at minimum gate `markAllRead` behind an
admin check. At the very least, record who marked read (`readBy` +
`readAt`) for auditability.

---

### [SEV: P2] `listForOrg` runs two `by_org` index scans per realtime re-fire

**Location:** `convex/notifications.ts:29-46`

```ts
const result = await ctx.db
  .query("notifications")
  .withIndex("by_org", (q) => q.eq("clerkOrgId", org.clerkOrgId))
  .order("desc")
  .paginate(args.paginationOpts);

const unreadRows = await ctx.db
  .query("notifications")
  .withIndex("by_org", (q) => q.eq("clerkOrgId", org.clerkOrgId))
  .filter((q) => q.eq(q.field("readAt"), undefined))
  .collect();
```

**Problem:** Each `listForOrg` invocation issues **two** `by_org` index
queries — one for the paginated page, one for the unread count — and the
query is a realtime subscription re-fired on every notification change for
every connected member. So a single `markRead` patch triggers, for every
member with the bell mounted: 2 × `by_org` scans × members. The page query
is paginated and cheap per call; the unread query is the pathological one
(see the P1 finding above), but even setting aside the filter, the doubling
is avoidable: the unread count does not need to live in the same query as
the page. It could be a separate lightweight query backed by a counter, so
that page-listing and badge-counting have independent re-fire scopes.

**Impact:** Doubles read cost and doubles the realtime amplification on
every notification write. Combined with the full-scan unread counter, this
is the difference between "slow" and "pathological."

**Fix:** Split `unreadCount` into a separate query backed by a denormalized
counter (see the P1 fix), so the page query stays a bounded paginated read
and the counter is an O(1) indexed lookup. This also lets the badge update
without re-paginating the list.

---

### [SEV: P2] `markRead` is a cross-org existence oracle via distinguishable error messages

**Location:** `convex/notifications.ts:57-65`

```ts
const notification = await ctx.db.get(args.notificationId);
if (notification === null) {
  throw new Error("Notification not found");
}
if (notification.clerkOrgId !== claims.orgId) {
  throw new Error("Not a member of this organization");
}
```

**Problem:** `markRead` throws two different error messages depending on
whether the supplied `notificationId` does not exist at all ("Notification
not found") versus exists but belongs to a different org ("Not a member of
this organization"). The `notificationId` argument is `v.id("notifications")`
— a typed Convex id — so an attacker cannot easily enumerate ids, but any id
leaked via a URL, log line, client-side cache, or a separate bug becomes a
confirmation oracle: the attacker learns whether that id exists and, if so,
that it belongs to a different org. The "Not a member of this organization"
message also leaks the fact that *some* org owns the notification, which is
unnecessary information for a caller who should not have been able to address
it in the first place.

The same pattern exists in `requireOrgMemberBySlug` / `requireProjectMember`
in `convex/lib/auth.ts`, so this is a codebase convention — but `markRead` is
the one place where the two branches are in the same handler and trivially
collapsible.

**Impact:** Low-severity information disclosure; enables existence probing
for any leaked notification id.

**Fix:** Return a single uniform error for both branches:

```ts
const notification = await ctx.db.get(args.notificationId);
if (notification === null || notification.clerkOrgId !== claims.orgId) {
  throw new Error("Notification not found");
}
```

---

### [SEV: P2] `markAllRead` patches in an unbounded sequential loop; can exceed transaction limits

**Location:** `convex/notifications.ts:89-91`

```ts
for (const n of unread) {
  await ctx.db.patch(n._id, { readAt: now });
}
return { updated: unread.length };
```

**Problem:** Every `patch` is a separate DB write, and the entire loop runs
inside the mutation's single OCC transaction. There is no batching, no
chunking, no cap on `unread.length`. Under the `webhook_failed` storm volume
that the sibling helper permits (one notification per failed delivery, no
coalescing — `reviews/convex.lib.notifications.ts.md`), an org can
accumulate thousands of unread notifications. A single `markAllRead` then:

1. Scans the full org history (see the P1 scan finding).
2. Issues thousands of sequential `patch` calls inside one transaction.
3. Holds the OCC transaction open for the entire duration, blocking
   concurrent readers (including the realtime `listForOrg` subscriptions
   for every member of the org).
4. Can exceed Convex's mutation transaction time / size limits, causing
   a full rollback — so none of the notifications get marked read and the
   user's "Mark all read" click silently fails to take effect (the toast
   only fires on `onSuccess`).

The mutation is idempotent (re-running finds zero unread), so a rollback is
recoverable by retry — but the client (`notification-bell.tsx:131-137`) does
not retry; it shows an error toast on `onError` and leaves the badge
untouched.

**Impact:** Under storm volume, `markAllRead` becomes a denial-of-service
against the org's own notification feed: it blocks realtime subscriptions
while it runs and may time out without applying any changes.

**Fix:** Chunk the patches — process in batches of e.g. 100 via a scheduled
internal mutation that paginates the unread set and patches each batch in
its own transaction, returning immediately with a "started" status and
letting the realtime subscription reconcile as batches commit. Or, with a
denormalized counter, the mutation becomes a single `notificationCounts`
patch (`unread = 0`) plus a background bulk-mark scheduled job.

---

### [SEV: P2] `markAllRead` returns a pre-snapshot `updated` count that drifts under concurrency

**Location:** `convex/notifications.ts:83-93`

```ts
const now = Date.now();
const unread = await ctx.db
  .query("notifications")
  .withIndex("by_org", (q) => q.eq("clerkOrgId", org.clerkOrgId))
  .filter((q) => q.eq(q.field("readAt"), undefined))
  .collect();
for (const n of unread) {
  await ctx.db.patch(n._id, { readAt: now });
}
return { updated: unread.length };
```

**Problem:** `updated` is `unread.length` — the size of the unread set at
the moment of `collect()`. Between `collect()` and the patch loop:

- A concurrent `markRead` (another member clicking a row) can patch one of
  the collected rows first; `markAllRead` then overwrites its `readAt` with
  `now`. The row was already read; `markAllRead` recounts it in `updated`
  even though it did not transition unread→read.
- A concurrent `createNotification` (e.g. a `webhook_failed` firing) inserts
  a new unread notification after the `collect()` snapshot; it is not in
  `unread`, is not patched, and remains unread. `updated` does not reflect
  it, and the badge `unreadCount` stays at `> 0` after the mutation returns
  "success."

The project contract says "return canonical post-write state." `updated` is
a pre-snapshot count, not a post-write canonical state. The client
(`notification-bell.tsx:131-137`) ignores `updated` and relies on the
realtime `unreadCount` to reconcile, so the drift is not user-visible — but
the return value is a lie: it does not equal the number of rows the
mutation actually transitioned, nor the remaining unread count.

**Impact:** Low (the UI ignores the value), but the mutation violates the
"canonical post-write state" contract and the `updated` field is
semantically unreliable for any future caller.

**Fix:** Either drop `updated` from the return type (the UI does not use it)
and return `{ ok: true }`, or recompute the post-write unread count and
return `{ updated, remaining }` where `remaining` is the count after the
patches. Given the realtime reconciliation, dropping `updated` is the
cleanest fix.

---

### [SEV: P3] `markRead` return type `{ ok: boolean }` is dead — `ok` is always `true`

**Location:** `convex/notifications.ts:51, 67, 73, 75`

```ts
handler: async (ctx, args): Promise<{ ok: boolean }> => {
  ...
  if (notification.readAt !== undefined) return { ok: true };
  await ctx.db.patch(args.notificationId, { readAt: Date.now() });
  return { ok: true };
},
```

**Problem:** Every return path yields `{ ok: true }`; the only other outcome
is a thrown error. `ok: boolean` implies the caller must handle a `false`
case, but no such case exists — the type advertises a failure mode the
implementation never produces. The client
(`notification-bell.tsx:121-127`) wraps the mutation in `useMutation` and
only defines `onError`; the `ok` field is never read. This is a dead field
that misleads future callers into writing `if (!result.ok)` branches that
can never execute.

**Impact:** Dead code; misleading API surface.

**Fix:** Either drop the return type to `Promise<void>` / `Promise<null>`
and rely on throw for failure, or return the post-write `readAt` timestamp
so the client can update its local cache without waiting for the realtime
re-fire:

```ts
handler: async (ctx, args): Promise<{ readAt: number }> => {
  ...
  if (notification.readAt !== undefined) return { readAt: notification.readAt };
  const readAt = Date.now();
  await ctx.db.patch(args.notificationId, { readAt });
  return { readAt };
},
```

---

### [SEV: P3] `markRead` authz is inconsistent with `markAllRead` — bypasses `requireOrgMemberBySlug`

**Location:** `convex/notifications.ts:55-75`

```ts
export const markRead = mutation({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const claims = await requireIdentity(ctx);
    if (claims.orgId === undefined) {
      throw new Error("No active organization on identity");
    }
    const notification = await ctx.db.get(args.notificationId);
    ...
    if (notification.clerkOrgId !== claims.orgId) {
      throw new Error("Not a member of this organization");
    }
    ...
  },
});
```

**Problem:** `markAllRead` resolves the org via `requireOrgMemberBySlug(ctx,
args.orgSlug)`, which (a) confirms the caller is authenticated, (b) confirms
an active org claim exists, (c) resolves the org by slug, and (d) confirms
the org's `clerkOrgId` matches the JWT's active org. `markRead` skips this
entire pipeline and re-implements a subset by hand: `requireIdentity` + manual
`orgId` undefined check + direct `clerkOrgId` string comparison. It does not
take an `orgSlug` argument, so there is no slug→org resolution and no
slug↔JWT-active-org consistency check.

The security boundary still holds (the `notification.clerkOrgId !==
claims.orgId` check is sufficient to prevent cross-org marking), but the
inconsistency means `markRead` is the only public mutation in the file that
does not go through `requireOrgMemberBySlug`. If the auth helper is later
tightened (e.g. to reject revoked org memberships, check `orgRole`, or
validate org existence), `markRead` will silently bypass the new check
because it does not route through it.

**Impact:** Maintenance hazard; future auth tightening will miss `markRead`.

**Fix:** Either route `markRead` through `requireOrgMemberBySlug` by adding
an `orgSlug: v.string()` argument (the client already knows the active org
slug — `notification-bell.tsx:111`), or extract a shared
`requireNotificationOwnership(ctx, notificationId)` helper used by both
`markRead` and a future single-read path, so the authz logic lives in one
place.

---

## Summary

- **9 findings**: P0: 0, P1: 3, P2: 4, P3: 2
- **Top 3:**
  1. **P1 — `listForOrg` full-scan `unreadCount` on every realtime tick.**
     No index on `readAt`; `.filter(readAt === undefined).collect()`
     materializes the org's entire notification history per re-fire per
     member. Add a denormalized counter or a `by_org_read` index.
  2. **P1 — `markAllRead` scans the full org history to find unread rows,
     then patches in an unbounded sequential loop.** Same missing index,
     plus O(N) patches in one transaction that can time out under storm
     volume.
  3. **P1 — Any org member can dismiss every notification for the entire
     org**, including role-targeted `low_balance` / `transfer_failed`
     alerts, with no per-user read state, no role check, and no audit
     trail. `readAt` is org-wide shared mutable state writable by every
     member.

- **Cross-cutting theme:** The file treats notifications as a cheap,
  org-wide, append-only log, but the schema has no index on `readAt`, no
  per-user read state, and no role gating — so the three operations that
  the realtime bell depends on (list, count unread, mark read) all degrade
  linearly with org size and are writable by any member. The
  `webhook_failed` storm vector documented in the sibling-helper review
  turns these linear costs into operational failures.
