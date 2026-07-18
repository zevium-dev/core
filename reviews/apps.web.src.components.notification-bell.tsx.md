# Tiger Review — `apps/web/src/components/notification-bell.tsx`

## Verdict

Incorrect — two real correctness/UX defects against the project's stated loading-state and animation rules, plus a minor waste in the always-on timer. No data-corruption or auth issues; Convex reactive updates keep `unreadCount` and row read-state in sync, and `markRead`/`markAllRead` are idempotent server-side. The block below flags the gaps the author would want closed before merge.

## File Stats

- File: `apps/web/src/components/notification-bell.tsx` (293 lines)
- Paired backend: `convex/notifications.ts` (`listForOrg`, `markRead`, `markAllRead`)
- Findings: 3 (P2: 1, P3: 2)

## Findings

### [P2] Initial-load window renders `EmptyState` instead of a skeleton

**Location** — `notification-bell.tsx:109-117, 130, 209-211`

```tsx
const { data } = useQuery(
  convexQuery(api.notifications.listForOrg, {
    orgSlug,
    paginationOpts: { numItems: 50, cursor: null },
  }),
);

const unread = data?.unreadCount ?? 0;
…
const page = data?.page ?? [];
…
{page.length === 0 ? (
  <EmptyState />
) : (
```

**Problem.** `useQuery` (non-suspense) yields `data === undefined` until the first Convex response lands. The code destructures only `{ data }` and never reads `isPending`. On the very first open of the bell — and on every org switch, which changes the `convexQuery` key and resets cached data to `undefined` — `page` defaults to `[]` and `unread` defaults to `0`, so the popover renders `<EmptyState />` ("You're all caught up") and the badge renders nothing. A user with 5 unread notifications who opens the popover during this ~tens-of-ms window is told they have no activity, then the list pops in once data arrives. The bell badge likewise flickers from "no dot" → "5" on org switch.

**Impact.** Misleading empty state during load; violates the project rule *"loading = layout-stable skeletons, isPending (never isLoading)"*. The codebase already follows this pattern elsewhere (`version-dialog.tsx:82-84` gates on `isPending || data === undefined`; `admin.tsx:46-47` gates on `isPending`), so this file is the outlier.

**Fix.** Destructure `isPending` from the query and render layout-stable skeletons (the project ships `Skeleton` in `components/ui/skeleton.tsx`) when `isPending && !data`, distinct from the genuine-empty `page.length === 0 && !isPending` path. Also gate the badge on `isPending` so the count doesn't flash `0` → `N` on org switch.

```suggestion
  const { data, isPending } = useQuery(
    convexQuery(api.notifications.listForOrg, {
      orgSlug,
      paginationOpts: { numItems: 50, cursor: null },
    }),
  );

  const unread = isPending ? 0 : (data?.unreadCount ?? 0);
```

```suggestion
        {isPending ? (
          <NotificationsSkeleton />
        ) : page.length === 0 ? (
          <EmptyState />
        ) : (
```

---

### [P3] `now` interval ticks forever while the popover is closed

**Location** — `notification-bell.tsx:91-96`

```tsx
  // Keep relative timestamps fresh while the bell is mounted.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TIME_TICK_MS);
    return () => clearInterval(id);
  }, []);
```

**Problem.** `BellWithOrg` is mounted permanently in the app header. The 60-second `setInterval` fires for the entire session, and each tick calls `setNow` → re-render of `BellWithOrg` and its subtree (badge, popover trigger, the closed `PopoverContent`'s trigger path). The `now` value is only consumed by `NotificationRow`'s `formatRelativeTime(createdAt, now)`, and rows only mount when the popover is open. So 99% of these ticks produce re-renders with no visible effect. The cleanup is correct — this is not a leak — but it is needless continuous work on a always-mounted component, and the comment ("while the bell is mounted") encodes the wrong lifecycle boundary.

**Impact.** Wasted re-renders every 60s for the lifetime of the session. Negligible per-tick, but the pattern is exactly the kind of always-on timer that compounds across a header full of bells.

**Fix.** Gate the interval on `open` so it only runs while timestamps are actually visible; seed `now` on open via the existing `onOpenAutoFocus` (already present) or in the effect.

```suggestion
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TIME_TICK_MS);
    return () => clearInterval(id);
  }, [open]);
```

---

### [P3] `markAllRead` has no optimistic update — visible lag between click and rows dimming

**Location** — `notification-bell.tsx:119-129, 197-202`

```tsx
  const { mutate: markAllRead, isPending: markingAll } = useMutation({
    mutationFn: () => markAllMut({ orgSlug }),
    onSuccess: () => toast.success("All notifications marked read"),
    onError: (err: unknown) =>
      toast.error(humanError(err, "Could not mark all read")),
  });
```

```tsx
            disabled={markingAll || unread === 0}
            onClick={() => markAllRead()}
```

**Problem.** Clicking "Mark all read" disables the button (`markingAll`) and waits for the server round-trip. During that window the list rows still render with `read={false}` (full opacity, no `data-[read=true]` dimming) until Convex reactively re-pushes `listForOrg`. There is a perceptible gap where the button says "working" but every row still looks unread. The project rule says *"optimistic where safe"* — marking all read is unambiguously safe (idempotent, server confirms, `markAllRead` handler re-queries and patches the true set). The sibling `markRead` per-row path is less of an issue because the popover closes immediately on click, so the stale row is never seen; `markAllRead` keeps the popover open.

**Impact.** Minor visible flicker; feels laggy on slow connections. No correctness issue — Convex reconciles to the true state regardless.

**Fix.** Add an `onMutate` that optimistically flips every cached row's `readAt` to `Date.now()` and sets `unreadCount` to `0` against the `convexQuery(api.notifications.listForOrg, …)` cache, with `onError` rolling back. Pattern is already established in `project-settings-panel.tsx:86-…` for the same `convexQuery` + `useConvexMutation` pairing.

---

## Summary

- 3 findings: **P2 ×1, P3 ×2**. No P0/P1.
- Top issues:
  1. **[P2]** Missing `isPending` gate → `EmptyState` shown during initial load and org-switch; violates the loading-state rule and is inconsistent with `version-dialog.tsx` / `admin.tsx`.
  2. **[P3]** Always-on 60s `now` interval re-renders the header bell for the whole session while the popover is closed.
  3. **[P3]** `markAllRead` skips the optimistic-update pattern the project mandates and that `project-settings-panel.tsx` already demonstrates.

- **Not flagged (verified clean):** `text-white` on `bg-destructive` matches the stock-shadcn convention in `badge.tsx:16` / `button.tsx:14` (the project keeps shadcn unmodified, so this is the canonical token pairing, not a raw-color violation). Inline `initial`/`animate` literals (`{ opacity: 0, y: 4 }`) match the established pattern in `motion/fade-in.tsx:30-31` and `motion/reveal.tsx:41-42` — `motion.ts` exports only easing/duration/stagger/spring tokens, not enter presets. `markRead`/`markAllRead` Convex handlers are idempotent and org-scoped, so the fire-and-forget `markRead` in `onRowClick` and the disabled-button gating on `markAllRead` are race-free. `useEffect` cleanup is correct.
