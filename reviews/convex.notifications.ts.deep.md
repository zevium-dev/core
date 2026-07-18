# Tiger-Style Deep-Dive — Notification Subsystem (`convex/notifications.ts` + `convex/lib/notifications.ts`)

This review unifies the **entire notification subsystem**: the write chokepoint
(`convex/lib/notifications.ts`, 50 lines — every producer routes here), the
public read/mutation surface (`convex/notifications.ts`, 96 lines —
`listForOrg`/`markRead`/`markAllRead`), the schema
(`convex/schema.ts:108-127`), the test suite (`convex/notifications.test.ts`),
and the realtime consumer (`apps/web/src/components/notification-bell.tsx`).
The two prior single-file reviews (5 P1 + 8 P2 + 4 P3 = 17 findings) are
**verified accurate** below; this deep-dive **expands** with 9 additional
findings that only surface when the files are read together — the
write-path/read-path coupling that turns the idempotency race into
user-visible duplicates, the schema's `readAt: undefined` choice that
*forces* the full-scan pattern, the bell's 50-row hard cap that contradicts
the badge count, the missing test coverage for the exact bugs the prior
reviews flag, and the error-leak path that promotes the cross-org oracle
from a server log into a user-visible toast.

---

## Verdict

**Incorrect and operationally fragile.** The notification subsystem is a
small amount of code carrying a large load: it is the only realtime
subscription mounted in the app shell (`notification-bell.tsx:109-115`), so
every defect fires on every notification change for every connected member
of every org. The two files are tightly coupled — `lib/notifications.ts`
writes rows that `notifications.ts` reads in realtime — and the coupling
amplifies every individual defect:

- The **idempotency race** in `createNotification` (P1, verified) produces
  duplicate `refId` rows, and `listForOrg` **does not dedupe by `refId`**
  (new P2), so duplicates land in the feed and inflate `unreadCount`.
- The **schema's `readAt: v.optional(v.number())`** choice (new P2) means
  unread rows cannot be indexed — `undefined` does not participate in any
  index key — which *forces* the full-per-org `.filter().collect()` scan
  in both `listForOrg` and `markAllRead` (verified P1s). The scan is not a
  careless implementation choice; it is the only option the schema permits.
- The **bell's `numItems: 50` hard cap** (new P2) means when an org has >50
  unread notifications (the exact storm scenario the lib review documents),
  the badge shows e.g. "147" but the popover lists only 50 rows with no
  "load more" and no notifications route — the count and the list disagree
  in the UI.
- The **`markRead` cross-org existence oracle** (verified P2) is worsened by
  `humanError` (`apps/web/src/lib/human-error.ts`), which surfaces raw
  `Error.message` strings ≤200 chars to the user toast — so the
  "Notification not found" vs "Not a member of this organization" branch
  distinction is not just a server log, it is a user-visible confirmation
  oracle.
- The **test suite** (new P2) covers none of the concurrency or drift bugs
  the prior reviews identify: no concurrent-same-`refId` test, no
  `markAllRead` cross-org rejection test, no already-read `markRead`
  timestamp-preservation test, no cursor-continuation pagination test.

On top of the verified and expanded findings, the subsystem ships **no TTL
or GC** on the `notifications` table, so the `by_org` scan grows monotonically
with the org's lifetime — every defect above gets worse over time, by
design.

---

## File Stats

- **`convex/lib/notifications.ts`** (50 lines): `NotificationKind`,
  `CreateNotificationArgs`, `CreateNotificationResult`, `createNotification`.
  Producers: `convex/admin.ts:233`, `convex/cronTasks.ts:35`,
  `convex/payouts.ts:482`, `convex/specs.ts:175`, `convex/specs.ts:338`,
  `convex/webhooks.ts:278`.
- **`convex/notifications.ts`** (96 lines): `NotificationView`,
  `NotificationsPage`, `listForOrg`, `markRead`, `markAllRead`.
  Consumer: `apps/web/src/components/notification-bell.tsx:110,118,119`.
- **`convex/schema.ts:108-127`**: `notifications` table; indexes
  `by_org` = `[clerkOrgId, createdAt]`, `by_ref` = `[refId]`. No index on
  `readAt`; no TTL.
- **`convex/notifications.test.ts`** (302 lines): 10 test cases across
  `createNotification`, `listForOrg` (auth + data), `markRead`, `markAllRead`.
- **`apps/web/src/components/notification-bell.tsx`** (241 lines):
  `NotificationBell`, `BellWithOrg`, `NotificationRow`, `EmptyState`.
- Auth: `requireIdentity` / `requireOrgMemberBySlug` (`convex/lib/auth.ts`).
- **Findings (this deep-dive): 26** — P0: 0, P1: 5, P2: 13, P3: 8.
  (17 verified from prior reviews + 9 new.)

---

## Findings

### [SEV: P1] VERIFIED — `createNotification` idempotency is not atomic; concurrent same-`refId` writes duplicate

**Location:** `convex/lib/notifications.ts:32-50`

Convex indexes are not unique constraints. Two concurrent mutations each
observe `null` from `.unique()` and each insert — producing two rows with
identical `refId`. The JSDoc contract ("Idempotent notification insert…
returns `{ created: false }` without writing") holds only for single-writer
serial execution. Every producer constructs stable `refId`s precisely because
it expects concurrent retry (`webhooks.ts:283` scheduler retries,
`payouts.ts:487` Stripe redelivery, `cronTasks.ts:34` overlapping hourly
runs). Verified accurate. See the new P2 below for how duplicates become
user-visible.

---

### [SEV: P1] VERIFIED — `listForOrg` `unreadCount` is a full per-org scan on every realtime tick

**Location:** `convex/notifications.ts:34-46`

The `by_org` index is `[clerkOrgId, createdAt]`; `readAt` is in no index.
`.filter(readAt === undefined).collect()` is a post-scan JS filter that
materializes the org's entire notification history (read + unread) solely to
read `.length`. The code comment ("bounded scan of the by_org index", "not a
hot path") is wrong: the scan is bounded by lifetime notification count, and
this is a realtime subscription re-fired on every notification change for
every connected member. Verified accurate. The root cause is the schema
choice (new P2 below) — `readAt: undefined` cannot index.

---

### [SEV: P1] VERIFIED — `markAllRead` full-scans org history then patches in an unbounded sequential loop

**Location:** `convex/notifications.ts:83-93`

Same missing-index root cause on the write path, plus an unbounded
`for (const n of unread) await ctx.db.patch(...)` loop inside one OCC
transaction. Under the `webhook_failed` storm volume the lib review
documents, this can scan thousands of rows and issue thousands of sequential
patches, holding the transaction open and risking Convex's transaction
time/size limit — on timeout, full rollback, no notifications marked read,
no retry from the client (`notification-bell.tsx:128-133` shows only an error
toast). Verified accurate.

---

### [SEV: P1] VERIFIED — Any org member can mark all notifications read for the entire org, including role-targeted kinds

**Location:** `convex/notifications.ts:55-93`

No `userId`/`clerkUserId` field on the table (`schema.ts:108-127`); `readAt`
is a single org-wide timestamp. Neither `markRead` nor `markAllRead` checks
`orgRole`. A lowest-privilege `org:member` can dismiss `low_balance`
(audience: billing admin, from `cronTasks.ts:35`), `transfer_failed`
(audience: earnings admin, from `payouts.ts:482`), `version_deprecated`,
and `webhook_failed` for the entire org with no audit trail of who dismissed.
Verified accurate.

---

### [SEV: P1] VERIFIED — No input validation; external transport error text reaches `body`

**Location:** `convex/lib/notifications.ts:14-21, 43-49`

Unbounded `title`/`body`/`refId`/`clerkOrgId`. The `webhook_failed` producer
(`webhooks.ts:282`) embeds raw `fetch` error messages (hostnames, IPs, ports,
arbitrary length) into `body`, persisted indefinitely and shown to all org
members via `listForOrg`. `spec_published`/`version_deprecated` interpolate
publisher-controlled `project.name`/`args.message`. Verified accurate. This
is the cross-boundary leak path: webhook transport layer → notification
display layer, flowing through a helper that enforces no cap.

---

### [SEV: P2] NEW — `listForOrg` does not dedupe by `refId`; race-produced duplicates are user-visible

**Location:** `convex/notifications.ts:36-44` (return mapping), bridge to
`convex/lib/notifications.ts:32-50`

The idempotency race (P1 above) produces duplicate rows with identical
`refId`. `listForOrg` returns `page` mapped 1:1 from the paginated
`by_org` scan with **no deduplication by `refId`** — duplicates are returned
as separate `NotificationView` entries with distinct `_id`s but identical
`refId`/`title`/`body`. The client (`notification-bell.tsx:206-217`)
renders `page.map(...)` directly with `key={n._id}`, so duplicates appear as
duplicate rows in the popover. `unreadCount` (the full-scan `.collect().length`)
counts duplicates too, so the badge double-counts.

This is the read-side amplifier that makes the write-side race a
user-visible defect rather than a silent internal duplication. The
`refId` field is already in `NotificationView` — the helper promises
dedup-by-`refId`, the read path exposes the dedup key, but nobody dedupes.

**Impact:** Duplicate notification rows and inflated badge counts under
concurrent retry — exactly the condition the `refId` contract exists to
prevent. The user sees two identical "Webhook delivery failed" entries for
one delivery.

**Fix:** Dedupe `result.page` by `refId` before mapping to `NotificationView`
(keep the newest `_id` per `refId`). Better: fix the write-side race so
duplicates cannot exist. But until Convex offers unique constraints,
read-side dedup is the only safety net, and it is absent.

---

### [SEV: P2] NEW — Schema's `readAt: v.optional(v.number())` makes unread rows unindexable, forcing the full-scan pattern

**Location:** `convex/schema.ts:108-127`

```ts
notifications: defineTable({
  ...
  readAt: v.optional(v.number()),
  createdAt: v.number(),
})
  .index("by_org", ["clerkOrgId", "createdAt"])
  .index("by_ref", ["refId"]),
```

`readAt` is `undefined` for unread rows. In Convex, `undefined` field values
do not participate in index keys — an index `["clerkOrgId", "readAt"]`
cannot equality-scan `readAt === undefined` because there is no key to match.
This is why `listForOrg` and `markAllRead` both fall back to
`.withIndex("by_org").filter(readAt === undefined).collect()` — a post-scan
JS filter. The verified P1 full-scan findings are not careless
implementations; they are the **only option the schema permits**. The code
comment in `listForOrg` ("bounded scan of the by_org index") reveals the
author did not realize `undefined` cannot index.

**Impact:** The performance cliff is structural, not incidental. Adding an
index alone does not fix it unless `readAt` uses a sentinel (e.g. `0` for
unread, real timestamp for read) so the index key is always present.

**Fix:** Migrate `readAt` to a non-optional `number` with a sentinel default
(`0` = unread) and add index `by_org_read` = `[clerkOrgId, readAt]`. Then
unread queries become `withIndex("by_org_read", q => q.eq("clerkOrgId", x).eq("readAt", 0))`
— a bounded index lookup, no scan. Or denormalize an `unread` counter in a
`notificationCounts` table (preferred — O(1) for the badge).

---

### [SEV: P2] NEW — Bell hard-caps the feed at 50 rows; no load-more, no notifications route — count and list disagree under storm

**Location:** `apps/web/src/components/notification-bell.tsx:109-115, 206-217`

```ts
const { data } = useQuery(
  convexQuery(api.notifications.listForOrg, {
    orgSlug,
    paginationOpts: { numItems: 50, cursor: null },
  }),
);
```

`convexQuery` with a static `paginationOpts` is a single-page realtime query —
it does not expose `loadMore` (that requires `usePaginatedQuery`). The
popover renders `page.map(...)` in a `max-h-80 overflow-y-auto` list with no
"load more" affordance and no link to a dedicated notifications route (none
exists in `apps/web/src/routes/`). So when an org has >50 notifications
(the `webhook_failed` storm scenario the lib review documents can produce
hundreds), the badge shows the true `unreadCount` (e.g. 147) but the popover
lists only 50 rows. The count and the list disagree in the UI, and
notifications 51-147 are unreachable until the user clicks "Mark all read"
(which does clear all of them via `markAllRead`'s full scan).

**Impact:** Under storm volume — the exact scenario the subsystem is most
stressed by — the bell becomes a broken window: a badge screaming "147
unread" with a list showing 50. The user cannot inspect the rest.

**Fix:** Either add a dedicated `/app/notifications` route with full
paginated access (and make the bell a link to it), or switch the bell to
`usePaginatedQuery` with a "Load more" button at the list footer. At minimum,
cap `unreadCount` display at the number of rows actually showable, or
surface "(and N more)" copy.

---

### [SEV: P2] NEW — `humanError` surfaces raw `markRead` error messages to the user, promoting the cross-org oracle to a user-visible toast

**Location:** `convex/notifications.ts:57-65` (error branches) ×
`apps/web/src/lib/human-error.ts:6-20` × `apps/web/src/components/notification-bell.tsx:124-126`

The prior review flagged that `markRead`'s two distinguishable error
branches ("Notification not found" vs "Not a member of this organization")
form a cross-org existence oracle. That understates it: `humanError` returns
`err.message` verbatim when it is ≤200 chars and does not match its internal
denylist — and `markRead`'s errors are short, plain strings that pass every
filter. So the branch distinction is not merely a server log; it is rendered
in a `sonner` toast to the end user via `onError: (err) => toast.error(humanError(err, "Could not mark notification read"))`.
An attacker probing a leaked `notificationId` sees the exact branch text in
their browser.

The project rules (`CONTRACT`) say "never leak internal errors."
`markRead`'s "Notification not found" / "Not a member of this organization"
/ "No active organization on identity" are internal authorization
state-leaking messages that `humanError` faithfully forwards.

**Impact:** The existence oracle is user-visible and requires no network
inspection — just read the toast. Violates the project's no-internal-errors
rule.

**Fix:** Collapse the two branches to a single uniform error (per the prior
P2 fix) AND have `humanError` treat `markRead`/`markAllRead` errors as
non-displayable (return the fallback). Or throw a `ConvexError` with a
generic message and have `humanError` already exclude `ConvexError` — but
the current code throws plain `Error`, which `humanError` happily surfaces.

---

### [SEV: P2] NEW — No TTL or GC on the `notifications` table; `by_org` scan grows monotonically

**Location:** `convex/schema.ts:108-127`

The `notifications` table has no `ttl` config and no cleanup path. Read
notifications persist forever. Every defect above is time-amplified: the
`listForOrg` unread scan, the `markAllRead` scan, the `by_org` index size,
the realtime re-fire cost all grow linearly with the org's lifetime
notification count. The prior FK finding notes "no GC, no TTL"; this
elevates it to P2 because the verified P1 scan findings make the missing TTL
a direct performance multiplier, not just storage hygiene. The
`webhook_failed` storm path can insert hundreds of rows per broken endpoint
per day, all retained indefinitely.

**Impact:** The subsystem degrades monotonically with org age. A
two-year-old org with a historically misconfigured webhook has a `by_org`
scan cost proportional to its lifetime notification count on every realtime
tick for every member.

**Fix:** Add `tableTTL` (Convex does not support per-row TTL natively; use a
scheduled cron that deletes notifications older than N days where
`readAt !== undefined`, or a periodic `markAllRead`-then-archive). At
minimum, schedule a daily internal mutation that deletes read notifications
older than 90 days.

---

### [SEV: P2] NEW — Test suite covers none of the concurrency/drift bugs the prior reviews flag

**Location:** `convex/notifications.test.ts`

The test file (302 lines, 10 cases) verifies the happy paths and basic auth
rejection, but is silent on every defect the prior reviews identify:

1. **No concurrent-same-`refId` test.** The P1 idempotency race has no test.
   `convex-test` runs single-threaded so a true concurrency test is hard,
   but a test that calls `createNotification` twice in the same
   `t.run(async (ctx) => { ... })` transaction (same ctx, two inserts) would
   at least document the expected behavior.
2. **No `markAllRead` cross-org rejection test.** `markRead` has a
   "rejects non-org notification" test (line ~225); `markAllRead` has none.
   A non-member calling `markAllRead` with another org's slug is untested —
   the auth is assumed to work by symmetry, never asserted.
3. **No already-read `markRead` timestamp-preservation test.** `markRead`
   early-returns `if (notification.readAt !== undefined) return { ok: true }`
   — it preserves the original `readAt` rather than overwriting with a new
   timestamp. This is a real behavioral contract (re-marking read does not
   bump the timestamp) with no test. A regression that removes the guard
   would pass every existing test.
4. **No cursor-continuation pagination test.** "returns all notifications
   across pages" (line ~262) uses `numItems: 50` in a single call, not
   cursor-chained `numItems: 2` across multiple `continueCursor` calls. The
   pagination contract (newest-first stability, no skip/repeat across
   cursors) is untested — and the `createdAt` millisecond-collision ordering
   instability (prior P2) is exactly the kind of bug this would catch.
5. **No `markAllRead` concurrent-insert drift test.** The prior P2 finding
   that `updated` drifts when a `createNotification` fires between
   `collect()` and the patch loop is untested.
6. **No `listForOrg` dedup-by-`refId` test** (new P2 above) — duplicates in
   the page are never asserted against.

**Impact:** The tests give false confidence: every green test passes because
it exercises only the paths that already work. The bugs the reviews found
are in paths no test touches.

**Fix:** Add tests for each of the six cases above. The concurrent-idempotency
and drift cases may require documenting expected behavior under
single-threaded `convex-test` rather than truly reproducing the race — but
the contract must be asserted.

---

### [SEV: P2] VERIFIED — `listForOrg` runs two `by_org` index scans per realtime re-fire

**Location:** `convex/notifications.ts:29-46`

One paginated page query + one full-scan unread count, both re-fired on
every notification change for every connected member. 2 × `by_org` scans ×
members per write. Verified accurate.

---

### [SEV: P2] VERIFIED — `markRead` is a cross-org existence oracle via distinguishable error messages

**Location:** `convex/notifications.ts:57-65`

Two different errors ("Notification not found" vs "Not a member of this
organization") leak whether a `notificationId` exists and, if so, that it
belongs to another org. Verified accurate. **Expanded above** (new P2): the
leak is user-visible via `humanError`, not merely a server log.

---

### [SEV: P2] VERIFIED — `markAllRead` patches in an unbounded sequential loop; can exceed transaction limits

**Location:** `convex/notifications.ts:89-91`

No batching/chunking; thousands of patches in one OCC transaction under
storm volume; rollback leaves the user stuck with no client retry. Verified
accurate.

---

### [SEV: P2] VERIFIED — `markAllRead` returns a pre-snapshot `updated` count that drifts under concurrency

**Location:** `convex/notifications.ts:83-93`

`updated = unread.length` at `collect()` time. A concurrent `markRead`
overwrites an already-read row's `readAt`; a concurrent `createNotification`
inserts a new unread row not in the snapshot. `updated` is neither the
count of transitions performed nor the remaining unread. The UI ignores the
value, but the return type lies. Verified accurate.

---

### [SEV: P2] VERIFIED — No `clerkOrgId` FK validation; orphaned notifications and latent cross-org-leak surface

**Location:** `convex/lib/notifications.ts:32-50`

The helper writes `args.clerkOrgId` without confirming an `organizations`
row exists. Today every producer resolves `org.clerkOrgId` from a fresh
doc, but the helper is the enforcement point and enforces nothing. Orphaned
rows (org deleted between load and insert) accumulate with no cleanup; a
future careless caller passing a user-influenced `clerkOrgId` becomes a
cross-org leak via `by_org`. Verified accurate.

---

### [SEV: P2] VERIFIED — No rate limiting / coalescing at the write chokepoint; `webhook_failed` storms the feed

**Location:** `convex/lib/notifications.ts:32-50`

The `webhook_failed` producer keys `refId` on per-delivery `deliveryId`
(`webhooks.ts:283`); a misconfigured endpoint produces one notification per
failed delivery with no coalescing, no per-org-per-kind cap, no unread cap.
A publisher publishing 50 spec versions with a broken endpoint gets 50
near-identical `webhook_failed` notifications. Verified accurate. **Expanded**
by the new bell-truncation P2: those 50+ notifications cannot even all be
viewed in the popover.

---

### [SEV: P2] VERIFIED — `transfer_sent` notification kind is dead; declared but never produced

**Location:** `convex/lib/notifications.ts:7-12`, `convex/schema.ts:122`

`kind: "transfer_sent"` is in the union and schema but no producer emits it.
Verified accurate. **Expanded:** the dead kind also propagates to the client —
`apps/web/src/components/notification-bell.tsx:39-47` (`KIND_ICON`) and
`:49-58` (`KIND_DESTINATION`) both carry a `transfer_sent` entry that can
never match, a dead branch in two lookup tables.

---

### [SEV: P2] VERIFIED — `createdAt: Date.now()` is not monotonic across concurrent inserts; `by_org` ordering unstable within a millisecond

**Location:** `convex/lib/notifications.ts:48`

`by_org` = `[clerkOrgId, createdAt]`; `Date.now()` is millisecond resolution.
Two inserts in the same millisecond (plausible during a storm) share
`createdAt` and their index order is undefined. Pagination over
`order("desc")` on a non-unique key can skip/repeat rows across cursors.
Verified accurate.

---

### [SEV: P3] NEW — `markRead` has no optimistic update; violates project "optimistic where safe" convention

**Location:** `apps/web/src/components/notification-bell.tsx:121-127, 138-145`

```ts
const { mutate: markRead } = useMutation({
  mutationFn: (notificationId: Id<"notifications">) =>
    markReadMut({ notificationId }),
  onError: (err: unknown) =>
    toast.error(humanError(err, "Could not mark notification read")),
});
```

`markRead` is fire-and-forget with `onError` only — no `onSuccess`, no
optimistic update. The row's `data-read` state and the badge `unreadCount`
both wait for the realtime `listForOrg` re-fire to reconcile. Clicking a row
leaves it visually unread for the ~100ms until Convex re-fires. The project
convention (`CONTEXT`: "optimistic where safe") calls for optimistic updates
where the operation is safe — and marking a row read is exactly that: the
worst case of an optimistic flip is a brief visual inconsistency if the
mutation fails, which is recoverable. The `markAllRead` mutation
(`:128-133`) has the same gap but is lower-frequency.

**Impact:** Sub-perceptual lag on row click; convention violation. Minor.

**Fix:** Add an optimistic update to `useMutation` that flips the row's
`read` state and decrements `unreadCount` in the cached `listForOrg` data,
rolling back on `onError`.

---

### [SEV: P3] NEW — `now` interval runs every 60s even when the popover is closed

**Location:** `apps/web/src/components/notification-bell.tsx:104-107`

```ts
const [now, setNow] = useState(() => Date.now());
useEffect(() => {
  const id = setInterval(() => setNow(Date.now()), TIME_TICK_MS);
  return () => clearInterval(id);
}, []);
```

The `setInterval` runs for the entire lifetime of `BellWithOrg` (always
mounted in the app shell), re-rendering the component every 60s to keep
relative timestamps fresh — but `now` is only consumed by `NotificationRow`'s
`formatRelativeTime`, which only renders when the popover is open. The
interval fires regardless of popover state. Minor wasted renders, but the
bell is in the app shell on every authenticated page.

**Impact:** Negligible; a tidy fix is to gate the interval on `open`.

---

### [SEV: P3] NEW — Test file ships a dead `internal` import

**Location:** `convex/notifications.test.ts:4`

```ts
import { internal } from "./_generated/api";
```

`internal` is imported and never referenced in any test. Dead import;
lint noise. Remove it.

---

### [SEV: P3] VERIFIED — `markRead` return type `{ ok: boolean }` is dead; `ok` is always `true`

**Location:** `convex/notifications.ts:51, 67, 73, 75`

Every return path yields `{ ok: true }`; the only other outcome is a throw.
`ok: boolean` advertises a failure mode the implementation never produces; the
client never reads `ok`. Verified accurate.

---

### [SEV: P3] VERIFIED — `markRead` authz is inconsistent with `markAllRead`; bypasses `requireOrgMemberBySlug`

**Location:** `convex/notifications.ts:55-75`

`markAllRead` routes through `requireOrgMemberBySlug` (auth + slug→org
resolution + JWT-active-org consistency); `markRead` re-implements a subset
by hand (`requireIdentity` + manual `orgId` check + direct `clerkOrgId`
string compare) with no `orgSlug` arg. The security boundary holds, but the
inconsistency means future auth tightening (role checks, revoked-membership
checks) will silently miss `markRead`. Verified accurate.

---

### [SEV: P3] VERIFIED — `kind` is type-only; no runtime guard against a TS-bypassed caller

**Location:** `convex/lib/notifications.ts:6-12, 32-50`

`CreateNotificationArgs.kind` is TS-typed `NotificationKind`; the DB validator
is the real backstop. The helper does no runtime assertion, so a JS/`as any`
caller gets a generic validation error at insert rather than a typed
`createNotification` error. Defense-in-depth absent. Verified accurate.

---

### [SEV: P3] VERIFIED — `CreateNotificationResult.id` is nullable but no code path returns `null`

**Location:** `convex/lib/notifications.ts:23-27, 37-38`

The `id: Id<"notifications"> | null` type advertises a `null` failure mode
that does not exist — `existing._id` and the insert `id` are both non-null.
Dead branch in the type; forces callers to handle a `null` that never
occurs. Verified accurate.

---

## Summary

- **Findings: 26** — P0: 0, P1: 5, P2: 13, P3: 8.
  (17 verified from prior single-file reviews + 9 new from the combined
  deep-dive.)

- **Top 3:**

  1. **P1 — `listForOrg` full-scan `unreadCount` on every realtime tick,
     structurally forced by the schema's `readAt: undefined` choice.** The
     `by_org` index cannot equality-scan `undefined`; the unread counter
     materializes the org's entire notification history per re-fire per
     member. Fix the schema (sentinel `readAt` + `by_org_read` index, or a
     denormalized counter) — not the query.
  2. **P1 — `createNotification` idempotency race + `listForOrg` does not
     dedupe by `refId`.** The write-side race produces duplicate `refId`
     rows; the read-side exposes them verbatim to the feed and inflates
     `unreadCount`. The `refId` dedup contract is unenforced on both ends.
  3. **P1 — `markAllRead` full-scans org history then patches in an
     unbounded sequential loop in one transaction**, plus any `org:member`
     can dismiss every role-targeted notification (`low_balance`,
     `transfer_failed`) for the entire org with no per-user read state, no
     role check, and no audit trail. The bell then truncates the result at
     50 rows with no load-more, so the storm that caused the bug also hides
     its full extent from the user.

- **Cross-cutting theme:** The two files are a tightly coupled write/read
  pair where every individual defect is amplified by the coupling: the
  idempotency race becomes user-visible because the read path doesn't dedupe;
  the full-scan unread counter is unavoidable because the schema's
  `readAt: undefined` cannot index; the `webhook_failed` storm is
  unfixable-in-UI because the bell caps at 50 and offers no route; the
  cross-org oracle is user-visible because `humanError` forwards raw error
  text. The subsystem also has no test coverage for any of its concurrency
  or drift contracts, and no GC/TTL, so every defect worsens monotonically
  with org age. The fix is structural (schema + counter denormalization +
  per-user or role-gated read state + read-side dedup), not a patch on any
  single function.
