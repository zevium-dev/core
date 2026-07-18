## Verdict
NEEDS WORK — read path is functionally correct and well-authScoped, but the post-index `projectId`/`keyId` filter pattern combined with the missing composite indexes produces a real UX/perf cliff on the activity feed, and several smaller correctness sharp-edges around time-window validation and realtime amplification need addressing.

## File Stats
- **Path:** `convex/usage.ts`
- **LOC:** 103
- **Role:** Read-side consumer usage log. Exports a single paginated `query`, `listForOrg`, backed by the `usageEvents` table (`by_org_at` index). Powers the `/app/settings/activity` call log in the web app.
- **Note on contract framing:** The review brief describes this file as "usage ingestion." It is not. Ingestion (`recordUsage`) lives in `convex/wallets.ts` and is the subject of `reviews/convex.wallets.ts.md`. `convex/usage.ts` is purely the consumer-facing read path. Findings below are scoped accordingly; cross-file ingestion concerns are noted only where they intersect this read path.

## Findings

### [P2] Post-index `projectId`/`keyId` filtering yields empty/undersized pages and a stale per-page "more data" signal
**Location:** `convex/usage.ts:64-72` (filter `continue`s), `:92-96` (`return { ...result, page }`)

```ts
for (const event of result.page) {
  if (args.projectId !== undefined && event.projectId !== args.projectId) {
    continue;
  }
  if (args.keyId !== undefined && event.keyId !== args.keyId) {
    continue;
  }
  ...
}
return { ...result, page };
```

**Problem:** `result.page` is the raw `numItems`-sized page from `by_org_at`; the filter `continue`s drop items *after* the index scan. `result.isDone` and `result.continueCursor` come from the **unfiltered** result, so they reflect index exhaustion, not filter exhaustion. The returned `page` can be empty (or far shorter than `numItems`) while `isDone === false`.

This is *pagination-correct* in the strict sense — the cursor advances past the filtered-out rows, so they are never re-returned — but it creates a concrete UX defect in the only caller (`apps/web/src/routes/app/settings/activity.tsx:318-331`): the "Load more" button renders whenever `!isDone && continueCursor !== null`, so for a selective `keyId` filter on a high-volume org the user can click "Load more" and receive **zero new rows**, repeatedly, until the index scan finally lands on a matching event. `ACTIVITY_PAGE_SIZE = 25` (`apps/web/src/lib/activity-filters.ts:74`) makes this easy to hit: an org with thousands of events on `key_beta` and the user filtering to `key_alpha` (rare) will see multiple empty pages.

**Impact:** Activity feed appears broken ("Load more" returns nothing) for any org whose event distribution is skewed across keys/projects. The worst case is O(total_events / numItems) round-trips to assemble a small filtered result set. No data corruption, no leak — just a feed that feels hung.

**Fix:** Push `projectId` and `keyId` into the index when set, so the filter is applied by Convex's range scan rather than in JS. Add composite indexes (see next finding) and branch on which filter is present:

```ts
.withIndex("by_org_project_at", (q) => {
  const base = q.eq("organizationId", org._id);
  if (args.projectId !== undefined) {
    return args.since !== undefined && args.until !== undefined
      ? base.eq("projectId", args.projectId).gte("at", args.since).lt("at", args.until)
      : args.since !== undefined
        ? base.eq("projectId", args.projectId).gte("at", args.since)
        : args.until !== undefined
          ? base.eq("projectId", args.projectId).lt("at", args.until)
          : base.eq("projectId", args.projectId);
  }
  // fall through to by_org_at for keyId-only / no filter
  ...
})
```

For `keyId`, the index `by_org_key_at` lets the same pattern apply. If adding both composite indexes is rejected, at minimum document that `keyId` filtering is O(events_in_window) and cap `since`/`until` width when a keyId filter is present.

---

### [P2] No composite index for `projectId` or `keyId` filtering within an org
**Location:** `convex/schema.ts:104-111` (usageEvents indexes), consumed at `convex/usage.ts:34-50`

```ts
.index("by_org", ["organizationId"])
.index("by_project", ["projectId"])
.index("by_org_at", ["organizationId", "at"])
.index("by_project_at", ["projectId", "at"])
.index("by_at", ["at"]),
```

**Problem:** `by_org_at` is `[organizationId, at]` — neither `projectId` nor `keyId` is in the index key, so both filters fall through to post-index JS filtering (see previous finding). There is no `by_org_project_at` (`[organizationId, projectId, at]`) and no `by_org_key_at` (`[organizationId, keyId, at]`). The existing `by_project_at` cannot be substituted because it lacks `organizationId` — using it would scan *every consumer org's* calls to that publisher project, which is both a perf regression and a latent cross-org leak vector if any future refactor swaps the index naively.

**Impact:** The `keyId` filter — a first-class feature of the activity UI (`activity.tsx:202-210` filters by key) — can never be index-applied. For a high-volume consumer org this is the difference between a 25-row bounded index page and a multi-page scan.

**Fix:** Add to `schema.ts`:

```ts
.index("by_org_project_at", ["organizationId", "projectId", "at"])
.index("by_org_key_at", ["organizationId", "keyId", "at"])
```

Then route `listForOrg` to the appropriate index based on which filter is present (snippet in previous finding). Keep `by_org_at` for the unfiltered path.

---

### [P3] `since > until` silently returns an empty page (no validation)
**Location:** `convex/usage.ts:41-48`

```ts
if (args.since !== undefined && args.until !== undefined) {
  return base.gte("at", args.since).lt("at", args.until);
}
```

**Problem:** When a caller passes `since: 1000, until: 500`, the index range becomes `at >= 1000 AND at < 500` — an impossible range that yields an empty page with `isDone: true`. No error is raised. The validator (`v.number()`) rejects NaN/Infinity at the wire layer, but no semantic check ensures `since <= until`.

**Impact:** A buggy client (e.g., a time-range preset that computes `since` from a stale `now` and `until` from a fresher `now` under clock skew) would silently see "no activity" instead of an error. The in-app `activity-filters.ts` only ever sets `since` (window is `[since, now]`, `until` never used), so this is latent today — but the public query contract is sharp.

**Fix:**

```ts
if (args.since !== undefined && args.until !== undefined && args.since > args.until) {
  throw new Error("since must be <= until");
}
```

---

### [P3] Half-open `[since, until)` interval is undocumented and inconsistent with the UI's `[since, now]` model
**Location:** `convex/usage.ts:41-48`, doc-comment at `:23-27`

**Problem:** `since` is inclusive (`.gte`), `until` is exclusive (`.lt`). The JSDoc above the query says only "Newest first" — nothing about the interval semantics. The web client (`apps/web/src/lib/activity-filters.ts:21-24`) documents its window as `[since, now]` (closed) but never passes `until`, so the inconsistency is invisible in-product. A future caller that wants "events on day X" and passes `since: dayStart, until: dayEnd` (where `dayEnd = dayStart + 86_400_000`) will exclude events whose `at === dayEnd` — correct for a half-open model, surprising for a closed-model caller.

**Impact:** Latent off-by-one in any future caller that adopts a closed-interval mental model. No current data impact.

**Fix:** Either document the half-open semantics in the JSDoc, or make `until` inclusive (`.lte`) and update the web client's comment. Documenting is the smaller change:

```ts
/**
 * Paginated consumer call log for the org that paid (organizationId on events).
 * Index range: by_org_at. projectId/keyId filtered after the index scan.
 * Time window is half-open: [since, until). Newest first.
 */
```

---

### [P3] `resolveProject` performs no org-scope check on the fetched project — relies entirely on `recordUsage` having stored the correct publisher `projectId`
**Location:** `convex/usage.ts:52-62`

```ts
async function resolveProject(
  projectId: Id<"projects">,
): Promise<{ name: string; slug: string } | null> {
  if (projectCache.has(projectId)) {
    return projectCache.get(projectId) ?? null;
  }
  const project = await ctx.db.get(projectId);
  const view =
    project === null ? null : { name: project.name, slug: project.slug };
  projectCache.set(projectId, view);
  return view;
}
```

**Problem:** `ctx.db.get(projectId)` fetches any project by ID with no org check. The index scan at `:34-50` correctly scopes `usageEvents` to `organizationId === org._id` (the consumer's org), so today `event.projectId` is whatever `recordUsage` stored — which, per the cross-org metering design, is the *publisher's* project the consumer called. That is the intended display. But this read path provides zero defense-in-depth: if a future `recordUsage` regression (or a malicious batch from a compromised gateway secret) stored an arbitrary `projectId` on a consumer's event, `listForOrg` would happily surface that foreign project's `name` and `slug` to the consumer — a metadata leak with no alarm.

**Impact:** No leak today. The read path is a passive consumer of whatever the ingestion path writes. But the only thing preventing a leak is the correctness of `recordUsage`'s `event.projectId` assignment, which lives in another file and is reviewed separately. A defense-in-depth check here would be cheap.

**Fix (optional, defense-in-depth):** Skip the cross-org fetch when not necessary, or log a monitorable warning when the fetched project's `organizationId` equals a known-disallowed set. A lighter touch: just document the assumption in a comment on `resolveProject` so future readers know the trust boundary:

```ts
// Trust boundary: event.projectId is set by recordUsage to the publisher's
// project the consumer called. No org check here — relies on ingestion correctness.
```

---

### [P3] Realtime amplification: `listForOrg` re-runs on every `usageEvents` mutation for the org
**Location:** `convex/usage.ts:26` (`export const listForOrg = query({...})`)

**Problem:** `listForOrg` is a Convex `query`, so every subscribed client re-runs whenever any `usageEvents` row for the org changes (insert via `recordUsage`, or any future update). The wallet DO alarm flushes batches roughly every ~5s (`apps/gateway/src/wallet.ts:19-20`, `apps/gateway/src/usage.ts:2-3`), so an active consumer's activity feed re-runs on every flush — even if the user is parked on a stale cursor page that will never display the new rows (newer `at` lands above the current page's top).

**Impact:** Wasted control-plane work proportional to (subscribed clients on this org) × (flush frequency). Bounded by `numItems` per run, so not unbounded, but for a consumer with the activity tab open in multiple browser tabs, the re-run cost multiplies. The query result for a cursor-paginated page is deterministic across flushes (cursor encodes position), so most re-runs return the same bytes — pure overhead.

**Fix:** Consider gating the realtime subscription to the first page only (cursor === null) in the web client, or accept the cost. Alternatively, expose a non-realtime variant (`query` with `paginationOpts` is inherently realtime; switching to a one-shot `action`-backed fetch would lose realtime). Document the tradeoff if keeping as-is.

---

### [P3] `settleRefId` is stored on `usageEvents` but omitted from `UsageListItem` — no support/debug surface
**Location:** `convex/usage.ts:4-18` (type), `:76-88` (page build), `convex/schema.ts:97-103` (schema has `settleRefId`)

```ts
export type UsageListItem = {
  _id: Id<"usageEvents">;
  projectId: Id<"projects">;
  ...
  keyId: string;
  at: number;
  // no settleRefId
};
```

**Problem:** `usageEvents.settleRefId` is the stable gateway settlement reference (`settle:{reservationId}`) and is the *only* durable correlation key between a row in this feed and a `walletEntries` ledger entry (`walletEntries.usageEventId` → `usageEvents._id`, and `walletEntries.refId === usageEvents.settleRefId`). The activity UI does not surface it, so a support engineer looking at "why was I charged 15 credits for this call?" has no in-product way to read the refId off the row and jump to the ledger.

**Impact:** Support/debugging friction. Not a correctness bug.

**Fix:** Add `settleRefId: string | null` to `UsageListItem` (the schema marks it `v.optional`, so historical rows may have `undefined`; normalize to `null`):

```ts
settleRefId: event.settleRefId ?? null,
```

---

### [P3] `projectCache.get(projectId) ?? null` is redundant after `projectCache.has(projectId)`
**Location:** `convex/usage.ts:57-58`

```ts
if (projectCache.has(projectId)) {
  return projectCache.get(projectId) ?? null;
}
```

**Problem:** `Map.has(k)` true implies `Map.get(k)` returns the stored value (which is `{name, slug} | null` per the cache's value type) — never `undefined`. The `?? null` coerces a value that the type system already proves cannot be `undefined` here. Dead defensive code.

**Impact:** None functional. Suggests the author was uncertain about the cache value type; readers may wonder whether `undefined` is actually possible (it is not).

**Fix:**

```ts
if (projectCache.has(projectId)) {
  return projectCache.get(projectId) ?? null;
}
// equivalently, without the redundant coalesce:
// return projectCache.get(projectId) as { name: string; slug: string } | null;
```

Or restructure to avoid the double lookup:

```ts
const cached = projectCache.get(projectId);
if (cached !== undefined) return cached;
```

---

### [P3] `usageEvents` table has no TTL, archival, or partitioning strategy — `by_org_at` index grows unbounded
**Location:** `convex/schema.ts:104-111` (indexes), consumed by `convex/usage.ts:34-50`

**Problem:** Every gateway-metered call inserts one row. There is no retention policy, no monthly/quarterly rollup table, no archival. The `by_org_at` index — the hot path for `listForOrg` — grows linearly with total call volume across all orgs. Convex indexes are B-trees; depth grows logarithmically, but the *leaf scan* for a paginated `desc` query with a wide `since` (e.g., `all` time range in the activity UI) is bounded by `numItems` per page, so it does not degrade catastrophically — but the table itself has no upper bound, and `billing.cycleBreakdown` (which does an unbounded `.collect()` over the month range per the test fixture in `convex/usage.test.ts:280-310`) will get slower as months accumulate.

**Impact:** Long-term perf degradation of the activity feed and the billing breakdown. Not a `listForOrg` bug per se, but the read path inherits the consequence.

**Fix:** Out of scope for this file alone, but flag for the team: define a retention window (e.g., 90 days of raw `usageEvents`, older rolled into a monthly `usageRollups` table) and have `listForOrg` cap `since` to the retention window, returning a pointer to the rollup for older data. At minimum, document the growth assumption.

## Summary
**Counts:** P0: 0 · P1: 0 · P2: 2 · P3: 6

**Top 3 to fix first:**
1. **Add `by_org_project_at` and `by_org_key_at` indexes and route `listForOrg` to them when the corresponding filter is set** (P2 #2) — this is the root cause of the empty-page UX defect and the only finding with a visible product impact.
2. **Fix the empty-page UX cliff** (P2 #1) — either via the index fix above, or by documenting that `page.length < numItems` does not imply `isDone` and updating the web client to auto-continue through empty pages when a filter is active.
3. **Validate `since <= until`** (P3 #3) — one-line guard against a class of silent-empty bugs.
