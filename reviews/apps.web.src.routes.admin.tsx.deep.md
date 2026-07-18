# Tiger Deep Review — Admin Panel

Scope: `apps/web/src/routes/admin.tsx`, `admin/index.tsx`, `admin/orgs.tsx`, `admin/projects.tsx`, `admin/payouts.tsx`, `convex/admin.ts`, `apps/web/src/components/admin-header.tsx`.

Prior review: 4 P2 + 5 P3. This pass verifies and expands to **2 P1 + 9 P2 + 10 P3**. The most serious miss in the prior pass was the realtime-staleness bug in the accumulated-pagination state machine and the money-movement correctness gap in `retryPublisherTransfer` (prior P1 in `convex/admin.ts` is confirmed and sharpened here with the UI/backend contradiction).

---

## Verdict

**SHIPPABLE WITH CHANGES.** Server-side admin authorization is real (`requireAdmin` / `isAdmin` both gate on `process.env.ADMIN_USER_IDS` and every mutation/action re-checks), so this is *not* a "client-trusts-client" hole. But two correctness defects land on real money and real admin workflows: (1) `retryPublisherTransfer` marks a transfer `succeeded` and all its earnings `transferred` the instant `stripe.transfers.create` returns, without inspecting the Stripe transfer's actual status — Connect transfers routinely sit in `pending`/`in_transit` for days and can later `fail`/`reversed`; (2) the accumulated-pagination pattern in orgs/projects/payouts is append-only, so once `cursor !== null` the Convex realtime subscription can never update an existing row in local state — admins act on stale visibility, stale balances, and stale transfer statuses. On top of that, `platformStats` does two unbounded `.collect()` full-table scans on every subscription tick, the transfer list filters in memory with no status index, and there are raw Tailwind colors + a hand-rolled `<select>` that violate the project's stated UI rules.

---

## File Stats

| File | Lines | Notes |
|---|---|---|
| `apps/web/src/routes/admin.tsx` | ~96 | Layout, beforeLoad, isAdminQuery gate, skeleton |
| `apps/web/src/routes/admin/index.tsx` | ~193 | Overview: platformStats + recentUsage cards/table |
| `apps/web/src/routes/admin/orgs.tsx` | ~193 | Paginated orgs table |
| `apps/web/src/routes/admin/projects.tsx` | ~471 | Paginated projects + kill switch + org-name map |
| `apps/web/src/routes/admin/payouts.tsx` | ~409 | Paginated transfers + retry dialog |
| `convex/admin.ts` | 381 | All admin queries/mutations/action |
| `apps/web/src/components/admin-header.tsx` | ~48 | Top nav |

---

## Findings

### [SEV: P1] `retryPublisherTransfer` marks transfer `succeeded` without inspecting Stripe status — premature money-movement state

**Location:** `convex/admin.ts:retryPublisherTransfer` (lines ~360-381)

```ts
const stripeTransfer = await stripeClient().transfers.create(
  { amount: transfer.amount, currency: transfer.currency,
    destination: transfer.stripeConnectedAccountId,
    metadata: { publisherTransferId: transfer._id } },
  { idempotencyKey: transfer.idempotencyKey },
);
await ctx.runMutation(internal.payouts.markPublisherTransferSucceeded, {
  transferId: transfer._id,
  stripeTransferId: stripeTransfer.id,
});
```

**Problem:** `stripe.transfers.create` for Connect transfers is synchronous in the API-call sense but the *transfer itself* is not necessarily `paid` — Connect transfers move through `pending` → `in_transit` → `paid`/`failed`/`canceled`/`reversed` over hours to days (ACH). The action treats "no exception thrown" as "succeeded" and calls `markPublisherTransferSucceeded`, which (see `convex/payouts.ts:426`) patches `status: "succeeded"` AND flips every attached `publisherEarnings` row to `status: "transferred"`.

**Impact:** Earnings are reported as `transferred` to publishers potentially days before the money actually settles. If the transfer later `fail`s or is `reversed` by Stripe, the local state must be reconciled by a webhook — and nothing in this file guarantees that reconciliation exists or is idempotent against the premature `succeeded` marking. The UI dialog (`RetryTransferDialog` in `payouts.tsx`) even *contradicts* the backend: it warns "Retry does not mark the transfer paid. Stripe events determine the final transfer state." — but the action does exactly the opposite. An admin reading the dialog and an auditor reading the code will reach different conclusions about whether the system trusts Stripe webhooks for final state.

**Fix:** Inspect `stripeTransfer` before marking. At minimum: only call `markPublisherTransferSucceeded` when `stripeTransfer.reversed === false && stripeTransfer.destination_payment exists`; otherwise call a `markPublisherTransferPending` (new status path) or leave the row in `created`/`pending` and let the existing webhook flow set `succeeded`. Reconcile the dialog copy with whatever the action actually does. If the existing non-retry flow (line ~595) shares this pattern, fix both.

---

### [SEV: P1] Accumulated pagination is append-only — realtime updates never refresh existing rows

**Location:** `apps/web/src/routes/admin/orgs.tsx` (useEffect ~L51), `admin/projects.tsx` (useEffect ~L140), `admin/payouts.tsx` (useEffect ~L105), helper `mergeUsagePages` in `apps/web/src/lib/activity-filters.ts`

```ts
// mergeUsagePages — replace only when cursor === null
if (replace) return [...incoming];
const seen = new Set(existing.map((row) => row._id));
const next = [...existing];
for (const row of incoming) {
  if (!seen.has(row._id)) { seen.add(row._id); next.push(row); }
}
return next;
```

**Problem:** The admin tables accumulate paginated pages into local `rows` state. When the Convex realtime subscription pushes an updated page (e.g., an org's wallet balance dropped after a charge, a project's `visibility` was just force-changed, a transfer's status moved `pending → succeeded` via webhook), `mergeUsagePages` is called with `replace = cursor === null`. Once the admin has clicked "Load more" even once, `cursor !== null`, so `replace` is `false` and the merge skips any incoming row whose `_id` is already in state. The existing row keeps its stale snapshot forever (until a filter change or manual refetch resets `cursor` to null).

`payouts.tsx` reimplements the same append-only logic inline with the same defect.

**Impact:** This is the admin panel acting on stale data:
- **Projects:** after `setProjectVisibility` succeeds, the just-toggled row in the table still shows the *old* visibility badge and the *old* kill-switch button label — the admin cannot tell their action took effect from the UI. (The mutation's `onSuccess` only shows a toast; it does not refetch or reset `cursor`.)
- **Orgs:** wallet balances drift from reality as charges land; the admin sees yesterday's balance.
- **Payouts:** a transfer that the webhook just moved to `succeeded` still shows `failed` with the retry button enabled — an admin could click retry on a transfer that has *already* been retried/succeeded, relying entirely on the Stripe idempotency key to save them.

**Fix:** Change the merge to update existing entries by `_id` regardless of `replace`:

```ts
const byId = new Map(existing.map((r) => [r._id, r]));
for (const r of incoming) byId.set(r._id, r);   // overwrite with fresher snapshot
return replace ? [...incoming] : [...byId.values()];
```

(Validate that `mergeUsagePages` is used elsewhere — `activity-filters` is shared by the settings activity log, so the same fix applies there too.)

---

### [SEV: P2] `platformStats` does two unbounded `.collect()` full-table scans per subscription tick

**Location:** `convex/admin.ts:platformStats` (~L36-72)

```ts
const allOrgs = await ctx.db.query("organizations").collect();
const allProjects = await ctx.db.query("projects").collect();
const draft = allProjects.filter((p) => p.status === "draft").length;
const published = allProjects.filter((p) => p.status === "published").length;
```

**Problem:** Comment claims "All bounded/indexed" — false. `.collect()` on `organizations` and `projects` pulls every document into the function. This runs on *every* Convex subscription update (the overview page mounts a live `convexQuery`), so any write anywhere on the platform re-runs both full scans. Counts are computed in JS by filtering the full project list twice.

**Impact:** O(orgs + projects) memory and time per tick. At platform scale (thousands of orgs/projects) this becomes a hot-path Convex function that scales linearly with total data, not with the page size. The usage count is correctly capped (`USAGE_STATS_CAP`); org/project counts are not.

**Fix:** Maintain counter docs (e.g., a `platformCounts` singleton updated by triggers) or use indexed `.withIndex("by_status", ...).take(N)` paginated counts if approximate is acceptable. At minimum, count via indexed queries (`by_visibility_status` already exists per `listProjects`) rather than `.collect().filter`.

---

### [SEV: P2] `listPublisherTransfers` filters in memory with no status index

**Location:** `convex/admin.ts:listPublisherTransfers` (~L242-260)

```ts
const result = args.status
  ? await q.order("desc").filter((qq) => qq.eq(qq.field("status"), args.status!))
      .paginate(args.paginationOpts)
  : await q.order("desc").paginate(args.paginationOpts);
```

**Problem:** Convex `filter()` runs *after* pagination ordering. For a status like `"failed"` that matches a tiny fraction of rows, each 25-row page may require scanning and discarding many non-matching transfers before filling the page. Combined with `order("desc")` (no index hint), this is a full scan per page.

**Impact:** The payouts filter buttons (`All / created / pending / succeeded / failed / reversed`) become progressively slower as total transfer volume grows — exactly the surface an admin uses to find stuck payouts. Worst case: a rare status on a large table returns a 25-row page only after walking the entire table.

**Fix:** Add a `by_status` (or `by_status_createdAt` composite) index on `publisherTransfers` and use `.withIndex("by_status", q => q.eq("status", status))` for the filtered path. Keep the unfiltered path on the `by_creationTime`-equivalent index.

---

### [SEV: P2] `useOrgNameMap` loads every org on projects page mount — should be a server-side join

**Location:** `apps/web/src/routes/admin/projects.tsx:useOrgNameMap` (~L366-405)

```ts
function useOrgNameMap() {
  // pages through every org once (admin tool, bounded scale)
  const [cursor, setCursor] = useState<string | null>(null);
  // ... auto-advances via useEffect until isDone
}
```

**Problem:** `listProjects` returns `organizationId` but not the org name/slug, so the client compensates by paging through *all* orgs (100 per page) until exhausted, building a `Map` in component state. The comment "bounded scale" is doing a lot of work — there is no bound; it's a function of total org count.

**Impact:** Every visit to `/admin/projects` fires `ceil(orgs / 100)` extra Convex round-trips, holding the full org list in memory on the client, just to render the `Org` column. This is strictly worse than a server-side join: more requests, more client memory, more latency before the table is usable, and a second realtime subscription (orgs) running for the lifetime of the projects page even though only the projects in the current view matter.

**Fix:** Have `listProjects` join the org name/slug server-side (it already has the `organizationId`; one `ctx.db.get(project.organizationId)` per row, or batch via a `by_organization` index scan). Drop `useOrgNameMap` entirely. If the join is too expensive per page, return a `Map<orgId, {name, slug}>` of only the orgs referenced by the current page.

---

### [SEV: P2] Raw Tailwind colors in `RetryTransferDialog` violate the semantic-token-only rule

**Location:** `apps/web/src/routes/admin/payouts.tsx` (~L355-360)

```tsx
<div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-muted-foreground">
  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
```

**Problem:** Project rule: "semantic color tokens only (bg-primary) — raw Tailwind colors rejected." `amber-500/30`, `amber-500/10`, `amber-600`, `dark:amber-400` are raw palette colors.

**Impact:** Theme inconsistency — the rest of the admin shell uses `bg-muted`, `text-muted-foreground`, `variant="destructive"`, etc. A warning surface that doesn't track the design tokens will look wrong under future theme changes and sets a precedent for other pages copying the pattern.

**Fix:** Use a semantic token. If no `warning` token exists yet, define one (e.g., `--warning` in CSS vars + a `bg-warning/10 border-warning/30 text-warning` set) and reuse. Or use the existing `destructive`/`muted` pairing for the warning callout.

---

### [SEV: P2] Native `<select>` with hand-rolled `SELECT_CLASS` instead of stock shadcn Select

**Location:** `apps/web/src/routes/admin/projects.tsx` (~L25-27, usage ~L171-203)

```tsx
const SELECT_CLASS =
  "flex h-9 min-w-[9rem] rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] duration-[var(--dur-instant)] ease-[var(--ease)] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";
...
<select id="admin-status" className={SELECT_CLASS} ...>
```

**Problem:** Project rule: "stock shadcn unmodified." The codebase ships a shadcn `Select` component; this hand-rolls a native `<select>` with a bespoke class string duplicating shadcn's focus-ring recipe. It will drift from the design system's focus ring, keyboard behavior, and dark-mode handling.

**Impact:** Inconsistent keyboard/accessibility semantics (native `<select>` vs. radix Select), duplicated style recipe that must be maintained by hand, and a precedent for other admin pages to copy the raw class. The `min-w-[9rem]` is also a magic number.

**Fix:** Replace with the shadcn `Select`/`SelectTrigger`/`SelectContent`/`SelectItem` components already in the repo.

---

### [SEV: P2] `setProjectVisibility` notification `refId` embeds `Date.now()` — defeats dedup

**Location:** `convex/admin.ts:setProjectVisibility` (~L196)

```ts
refId: `visibility_changed:${projectId}:${Date.now()}`,
```

**Problem:** If `createNotification` dedupes by `refId` (the typical pattern), embedding `Date.now()` makes every notification unique, so rapid toggles (public → private → public within seconds) produce three notifications instead of coalescing.

**Impact:** Notification spam to the owning org for a single admin session of toggling. Also, if the same admin toggles back and forth, the org sees a sequence of contradictory notifications ("set to private" then "set to public") rather than a single reconciled one.

**Fix:** Drop the timestamp: `refId: \`visibility_changed:${projectId}\`` (or include a coarse window like the day). Let `updatedAt` on the notification carry freshness if needed.

---

### [SEV: P2] `AdminHeader` nav hidden on mobile with no fallback

**Location:** `apps/web/src/components/admin-header.tsx` (~L29)

```tsx
<nav className="ml-4 hidden items-center gap-0.5 sm:flex">
```

**Problem:** Below `sm`, the nav is `hidden`. There is no mobile menu, no hamburger, no bottom nav. The only always-visible element is the "Back to app" button.

**Impact:** An admin on a phone (or a narrow desktop window) who lands on `/admin` can see the overview but cannot navigate to `/admin/orgs`, `/admin/projects`, or `/admin/payouts` without typing the URL. The admin panel is "desktop-first staff surface" per the comment, but there's no explicit gate preventing mobile use, and the routes are reachable.

**Fix:** Either add a mobile sheet/dropdown nav, or make the nav wrap (e.g., `flex-wrap` + `sm:hidden` removal with smaller touch targets). At minimum, document that mobile is unsupported and consider a `max-sm:hidden` admin notice.

---

### [SEV: P2] Duplicated accumulated-pagination state machine across orgs/projects/payouts

**Location:** `admin/orgs.tsx`, `admin/projects.tsx`, `admin/payouts.tsx` (each ~L40-60)

```ts
const [cursor, setCursor] = useState<string | null>(null);
const [rows, setRows] = useState<T[]>([]);
const [isDone, setIsDone] = useState(false);
const [continueCursor, setContinueCursor] = useState<string | null>(null);
// + useEffect merging pages
// + firstPagePending / loadMorePending / canLoadMore derived flags
```

**Problem:** The same 4-state + 2-effect + 3-derived-flag pattern is copy-pasted three times (and `useOrgNameMap` makes a fourth variant). `payouts.tsx` even reimplements `mergeUsagePages` inline instead of importing the shared helper. When the P1 staleness fix lands, it must be applied in 3-4 places or bugs will diverge.

**Impact:** Maintenance hazard — fixing the append-only merge (P1) requires touching every consumer, and the inline payouts variant is easy to miss. Future changes (e.g., cursor reset on filter change — already present in projects but absent in payouts/orgs for non-cursor filters) will land inconsistently.

**Fix:** Extract `useAccumulatedPagination<T extends {_id: string}>(query, {pageSize, resetDeps})` returning `{rows, firstPagePending, loadMorePending, canLoadMore, loadMore, reset}`. Have all three pages and `useOrgNameMap` use it. Centralize the merge fix.

---

### [SEV: P2] `requireAdminInAction` reimplements `requireAdmin` with divergent error behavior

**Location:** `convex/admin.ts:requireAdminInAction` (~L327-337) vs `convex/lib/auth.ts:requireAdmin`

```ts
async function requireAdminInAction(ctx: ActionCtx): Promise<void> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw new Error("Not authenticated");
  const configured = process.env.ADMIN_USER_IDS;
  if (configured === undefined || configured.trim() === "") {
    throw new Error("Admin access not configured");
  }
  // ... same split/trim/filter logic, hand-duplicated
}
```

**Problem:** `requireAdmin` (lib/auth) goes through `requireIdentity` (which throws the project's canonical not-signed-in error, possibly a redirect-shaped error) and returns the claims. `requireAdminInAction` re-derives identity directly and throws a bare `Error`. The admin-ids parsing is copy-pasted. Two sources of truth for "who is an admin."

**Impact:** If admin authorization ever moves off `ADMIN_USER_IDS` (e.g., to a Clerk role or a `admins` table), the action path (`retryPublisherTransfer` — the money-moving one) will silently keep the old logic while queries/mutations update. The most dangerous code path is the least likely to track changes.

**Fix:** Add an action-compatible `requireAdminAction(ctx: ActionCtx)` to `convex/lib/auth.ts` that shares the parsing with `requireAdmin` (extract `parseAdminIds()`), and call it from `retryPublisherTransfer`. Delete the local copy.

---

### [SEV: P3] `NotAuthorized` uses `<a href="/app">` while `AdminHeader` uses `<Link to="/app">`

**Location:** `apps/web/src/routes/admin.tsx` (~L78)

```tsx
<Button asChild variant="outline" size="sm">
  <a href="/app">Back to app</a>
</Button>
```

vs `admin-header.tsx`: `<Link to="/app">Back to app</Link>`.

**Problem:** Native anchor triggers a full document reload and loses client-side router state. Inconsistent with the rest of the app.

**Fix:** Use `<Link to="/app">`.

---

### [SEV: P3] `PublisherTransfer.publisherOrganizationId` typed as `string` on client, `Id<"organizations">` on server

**Location:** `apps/web/src/routes/admin/payouts.tsx` (~L31)

```ts
type PublisherTransfer = {
  id: Id<"publisherTransfers">;
  publisherOrganizationId: string;   // server returns Id<"organizations">
  ...
};
```

**Problem:** The client redefines the server's `AdminPublisherTransferView` by hand and weakens the org id type to `string`. Future server-side field renames/type changes won't catch here.

**Fix:** `import type { AdminPublisherTransferView } from "../../../../../convex/admin"` and derive the row type from it (as `admin/index.tsx` already does for `PlatformStats`/`AdminUsageView`).

---

### [SEV: P3] `listOrgs` does an N+1 wallet lookup per org in the page

**Location:** `convex/admin.ts:listOrgs` (~L88-100)

```ts
for (const org of result.page) {
  const wallet = await ctx.db
    .query("wallets")
    .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
    .unique();
  page.push({ ..., balance: wallet?.balance ?? 0 });
}
```

**Problem:** One wallets query per org per page (25 sequential queries). Bounded by page size, but serial `await` in a loop.

**Fix:** `Promise.all` the per-org wallet lookups, or batch via a single `wallets` scan filtered to the page's org ids.

---

### [SEV: P3] `setProjectVisibility` returns full `Doc<"projects">` but the client ignores it

**Location:** `convex/admin.ts:setProjectVisibility` returns `Doc<"projects">`; `projects.tsx` `toggleMutation` `onSuccess: (_data, vars) => ...` discards `_data`.

**Problem:** Over-fetch — the full project doc (including fields the client never uses) crosses the wire on every toggle.

**Fix:** Return `null`/`void`, or return just `{ _id, visibility }` if the client should optimistically apply it.

---

### [SEV: P3] `admin/orgs.tsx` unnecessary `as AdminOrgView[]` cast

**Location:** `admin/orgs.tsx` (~L51)

```ts
const page = orgsQuery.data.page as AdminOrgView[];
```

**Problem:** `convexQuery` is already typed via `api.admin.listOrgs`; the cast is dead weight that could mask future type drift.

**Fix:** Drop the cast.

---

### [SEV: P3] `AdminShellSkeleton` doesn't match the real header layout

**Location:** `apps/web/src/routes/admin.tsx:AdminShellSkeleton` (~L83-93)

```tsx
<div className="flex h-14 items-center gap-2 border-b px-4">
  <Skeleton className="h-4 w-28" />
  <Skeleton className="h-4 w-20" />
</div>
```

**Problem:** Real header is `h-14` with a `BrandMark` (size-5) + "Zevium Admin" text + nav links + a right-aligned button. The skeleton has no brand mark placeholder, no right-aligned button placeholder, no nav. The skeleton→real swap causes a visible layout shift (CLS) on the header row.

**Fix:** Mirror the real header structure: a size-5 circle + text bar + nav bars + right-aligned button bar.

---

### [SEV: P3] Overview usage table shows raw `projectId` Convex Id, not a resolvable label

**Location:** `admin/index.tsx` (~L130)

```tsx
<td className="px-2 py-2.5 font-mono text-xs text-muted-foreground">
  {event.projectId}
</td>
```

**Problem:** Admins see a Convex `Id<"projects">` (`"..."` 32-char string) under "Project." It's not clickable, not human-readable, not joinable to a name without a separate lookup. Same for org id (not shown but implied).

**Fix:** Join project name/slug in `recentUsage` (server-side, like `listPublisherTransfers` joins org name) and render that; link to `/admin/projects?...` if filtered search is supported.

---

### [SEV: P3] `humanError` call in projects omits fallback message; payouts includes it — inconsistent

**Location:** `admin/projects.tsx` (~L162) `toast.error(humanError(err));` vs `admin/payouts.tsx` (~L99) `toast.error(humanError(error, "Could not retry this Stripe transfer."));`

**Problem:** When the error is opaque, projects shows whatever `humanError` defaults to (possibly empty/generic), while payouts shows a contextual message. Inconsistent UX.

**Fix:** Pass a contextual fallback in projects too: `humanError(err, "Could not change project visibility.")`.

---

### [SEV: P3] "Recent credits" card title is ambiguous

**Location:** `admin/index.tsx` (~L114-120)

```tsx
<CardTitle className="text-3xl tabular-nums">
  <NumberTicker value={sumCredits(usage)} />
</CardTitle>
<CardContent className="text-xs text-muted-foreground">
  Summed across the {usage.length} most recent events
</CardContent>
```

**Problem:** Card description says "Recent credits" / "Calls this month" — but this card sums credits across the *100 most recent events* (capped by `recentUsage`'s `.take(100)`), not "recent credits" in any time-bounded sense. An admin comparing "Calls this month" (month-bounded count) to "Recent credits" (last-100-events sum) will be confused about the denominator.

**Fix:** Rename to "Credits in last 100 events" or scope the sum to the same month window as `usageThisMonth`.

---

### [SEV: P3] Redundant `!isAuthenticated` branch in `AdminLayout`

**Location:** `apps/web/src/routes/admin.tsx` (~L46)

```ts
const { isLoading: convexAuthLoading, isAuthenticated } = useConvexAuth();
const adminQuery = useQuery(convexQuery(api.admin.isAdminQuery, {}));
if (convexAuthLoading || !isAuthenticated || adminQuery.isPending) {
  return <AdminShellSkeleton />;
}
```

**Problem:** `isAdminQuery` already returns `false` for unauthenticated users (it calls `isAdmin` which returns false when `identity === null`). The `!isAuthenticated` short-circuit is harmless but means the skeleton shows for an unauthenticated user instead of `NotAuthorized` — a minor flash avoidance, but it also means `useConvexAuth` must report `isAuthenticated` before `adminQuery` resolves, which can add a render cycle.

**Fix:** Either keep it (defensible, avoids a flappy `NotAuthorized` flash during sign-out) and document *why*, or drop it and let `isAdminQuery` be the single source of truth. Not a bug; just clarify intent.

---

## Summary

**Counts:** P0: 0 · P1: 2 · P2: 9 · P3: 10 · **Total: 21**

**Top 3 to fix first:**

1. **P1 — `retryPublisherTransfer` premature `succeeded` marking.** Real money movement. The action marks a transfer and all its earnings as `succeeded`/`transferred` the moment `stripe.transfers.create` returns, ignoring Stripe's actual transfer lifecycle. The UI dialog explicitly promises the opposite. Inspect `stripeTransfer` status before marking, or defer to the webhook.

2. **P1 — Append-only accumulated pagination.** `mergeUsagePages` (and payouts' inline clone) never overwrites an existing `_id` once `cursor !== null`, so the Convex realtime subscription cannot refresh rows already in local state. Admins see stale project visibility immediately after toggling, stale org balances, and stale transfer statuses with a live "Retry" button on already-retried transfers. One-line merge fix, but it must land in every consumer.

3. **P2 — `platformStats` unbounded `.collect()` + `listPublisherTransfers` in-memory filter.** Both admin-overview hot paths do full-table work on every subscription tick; the transfer-status filter has no index. These will degrade as the platform grows and are the exact surfaces admins lean on to find problems.

**Cross-cutting note:** the accumulated-pagination duplication (P2) is the load-bearing tech-debt here — extracting `useAccumulatedPagination` makes the P1 staleness fix a one-liner and prevents the three pages from drifting further. The admin authorization itself is sound server-side; the layout's client gate is a UX layer, not a security boundary, and every mutation/action re-checks via `requireAdmin`/`requireAdminInAction`. The one drift to close is `requireAdminInAction` duplicating `requireAdmin` (P2) — especially because the duplicated path guards the money-moving action.
