# Tiger Review — `convex/analytics.ts`

## Verdict

**Incorrect.** Two queries (`orgOverview`, `projectAnalytics`) scan `usageEvents`
on the wrong index (`by_org` / `by_project`) and post-filter on the event-time
field `at`, despite the schema defining purpose-built time-ordered indexes
`by_org_at` and `by_project_at`. The `.take(N)` cap silently drops events
outside the scan window, so every aggregate the dashboard renders — cycle spend,
projected spend, percentiles, per-endpoint tables, daily bars — can undercount
without any error. A fractional-`rangeDays` validation hole and an unbounded
linear projection compound the correctness problems. Cross-org scoping is
sound; the bugs are all in the aggregation/time-window layer.

## File Stats

- **Path:** `convex/analytics.ts`
- **Lines:** 363
- **Queries:** `orgOverview`, `projectAnalytics`
- **Helpers:** `startOfUtcDay`, `startOfUtcMonth`, `endOfUtcMonth`, `percentile`, `statusClass`, `projectLinearSpend`
- **Callers:** `apps/web/src/routes/app/index.tsx` (`orgOverview`), `apps/web/src/routes/app/projects/$projectSlug.tsx` (`projectAnalytics`)
- **Auth:** `requireOrgMemberBySlug` (org-scoped; cross-org leak verified absent)

## Findings

---

### [P1] `orgOverview` scans `by_org` + `.take(5000)` instead of the `by_org_at` time index — cycle/day totals and projected spend silently undercount

**Location:** `convex/analytics.ts:145-157, 207-219`; index defined at `convex/schema.ts:109`

```ts
    // Newest first via _creationTime; filter on event `at` for cycle window.
    const scanned = await ctx.db
      .query("usageEvents")
      .withIndex("by_org", (q) => q.eq("organizationId", org._id))
      .order("desc")
      .take(ORG_SCAN_CAP);

    const truncated = scanned.length >= ORG_SCAN_CAP;
```

**Problem.** The scan orders by `_creationTime desc` (Convex's default ordering for
`by_org`) and hard-caps at 5 000 rows, then filters `event.at >= cycleStart` /
`event.at >= dayStart` **after** the cap is applied. The schema already defines
`by_org_at` (`["organizationId","at"]`) — `convex/usage.ts:listForOrg` uses it
correctly with a `gte("at", …).lt("at", …)` range. Two failure modes:

1. **Cap undercount.** Any org with more than 5 000 events in the current UTC
   month loses the oldest-in-`_creationTime` cycle events. `callsCycle`,
   `creditsCycle`, `callsToday`, `creditsToday` are all silently wrong, and
   `projectedCycleSpend` is derived from the undercounted `creditsCycle`, so the
   projection inherits the error. The `truncated` flag is set but the dashboard
   still renders the wrong numbers as if they were totals.
2. **Late-ingestion miss below the cap.** Gateway retries/batches can persist an
   event whose `at` falls inside the cycle but whose `_creationTime` is newer
   than 5 000 already-stored rows. Such an event is pushed past the cap and
   never counted even when the true cycle volume is far below 5 000 — and
   `truncated` may be `false`, so the UI gives no signal at all.

**Impact.** Dashboard "calls this cycle / credits this cycle / projected spend"
are load-bearing numbers (the org uses them to decide when to top up). Silent
undercounting can mask a looming zero-balance, contradicting the project rule
"never surprise-overage." Realtime correctness — a stated default — is violated.

**Fix.** Range-scan the time index from `cycleStart` to `+∞`; no cap, no
post-filter. The `recent` list can be a separate small `take(20)` on the same
index ordered `desc`.

```suggestion
    const cycleEvents = await ctx.db
      .query("usageEvents")
      .withIndex("by_org_at", (q) =>
        q.eq("organizationId", org._id).gte("at", cycleStart),
      )
      .order("desc")
      .collect();

    let callsCycle = 0;
    let creditsCycle = 0;
    const recent: UsageEventView[] = [];
    const projectCache = new Map<Id<"projects">, { slug: string; name: string } | null>();

    async function resolveProject(projectId: Id<"projects">): Promise<{ slug: string; name: string } | null> {
      if (projectCache.has(projectId)) return projectCache.get(projectId) ?? null;
      const project = await ctx.db.get(projectId);
      const view = project === null ? null : { slug: project.slug, name: project.name };
      projectCache.set(projectId, view);
      return view;
    }

    for (const event of cycleEvents) {
      callsCycle += 1;
      creditsCycle += event.credits;
      if (event.at >= dayStart) {
        callsToday += 1;
        creditsToday += event.credits;
      }
      if (recent.length < RECENT_LIMIT) {
        const project = await resolveProject(event.projectId);
        recent.push({ _id: event._id, projectId: event.projectId, projectSlug: project?.slug ?? null, projectName: project?.name ?? null, endpoint: event.endpoint, method: event.method, credits: event.credits, status: event.status, latencyMs: event.latencyMs, keyId: event.keyId, at: event.at });
      }
    }
```

---

### [P1] `projectAnalytics` scans `by_project` + `.take(10000)` instead of the `by_project_at` index — every stat silently undercounts for high-volume projects

**Location:** `convex/analytics.ts:255-261, 277-321`; index defined at `convex/schema.ts:110`

```ts
    const scanned = await ctx.db
      .query("usageEvents")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .order("desc")
      .take(PROJECT_SCAN_CAP);

    const truncated = scanned.length >= PROJECT_SCAN_CAP;
    const inRange = scanned.filter((e) => e.at >= rangeStart);
```

**Problem.** Identical antipattern to `orgOverview`. The scan orders by
`_creationTime desc` and caps at 10 000, then filters `at >= rangeStart`
post-scan. For a published project with more than 10 000 calls in the last
`rangeDays` (default 7) — exactly the high-volume publisher this analytics view
exists for — the cap drops the oldest-in-`_creationTime` in-range rows. Every
output field derived from `inRange` is then wrong:

- `calls`, `credits`, `successRate`, `errors4xx`, `errors5xx`
- `p50` / `p95` / `p99` (percentiles computed over a truncated sample —
  systematically biased, not just undercounted)
- per-endpoint `EndpointStats` (calls, credits, errors, percentiles)
- `callsByDay` daily bars (older days in the window go to zero first)

The `truncated` flag is surfaced, but the UI cannot distinguish "scan hit cap,
all in-range events counted" from "scan hit cap, in-range events dropped," and
all numbers are still rendered as if authoritative.

Additionally, late-ingested events (gateway retry with `at` inside the window
but `_creationTime` newer than 10 000 stored rows) are silently dropped even
when true window volume is well below 10 000.

**Impact.** Publisher sees understated call volume and biased latency
percentiles on exactly the projects they care most about. Percentile bias is
the subtlest harm: dropping the oldest `at`-events skews the tail downward,
hiding real p99 regressions.

**Fix.** Range-scan `by_project_at` from `rangeStart`; no cap.

```suggestion
    const inRange = await ctx.db
      .query("usageEvents")
      .withIndex("by_project_at", (q) =>
        q.eq("projectId", project._id).gte("at", rangeStart),
      )
      .order("desc")
      .collect();
```

(Remove `scanned`, `truncated`, and the `inRange = scanned.filter(...)` line;
`truncated`/`scanCap` fields should then be dropped from `ProjectAnalytics` or
kept always-`false` — see the P3 finding on stale fields.)

---

### [P2] `projectAnalytics` accepts fractional `rangeDays` in `(0, 1)`, producing a degenerate empty result with a future `rangeStart` and `callsByDay` of length 0

**Location:** `convex/analytics.ts:244-253, 277`

```ts
    const rawDays = args.rangeDays ?? 7;
    const rangeDays =
      Number.isFinite(rawDays) && rawDays > 0
        ? Math.min(Math.floor(rawDays), 90)
        : 7;
    ...
    const rangeStart = dayStart - (rangeDays - 1) * 86_400_000;
    ...
    const callsByDay = Array.from({ length: rangeDays }, () => 0);
```

**Problem.** For `rangeDays = 0.5`: `Number.isFinite(0.5)` is `true` and
`0.5 > 0` is `true`, so the guard passes; `Math.floor(0.5)` is `0`;
`Math.min(0, 90)` is `0`. So `rangeDays` becomes `0`. Consequences:

- `rangeStart = dayStart - (0 - 1) * 86_400_000 = dayStart + 86_400_000` — a
  timestamp one day **in the future**.
- `inRange = scanned.filter(e => e.at >= rangeStart)` is empty (no event has a
  future `at`), so `calls = 0`, percentiles are `null`, endpoints is `[]`.
- `callsByDay = []` (length 0), `rangeDays: 0` returned to the client.

The query returns `null`? No — it returns a fully-shaped `ProjectAnalytics` with
zeros and a future `rangeStart`, no error, no fallback to 7. Any value in
`(0, 1)` (`0.5`, `0.9`, `0.1`) triggers this. A client passing a bad
`rangeDays` gets a silently empty analytics view instead of the documented
default.

**Impact.** Garbage-in produces a confusing empty-chart state with a future
`rangeStart` rather than the intended 7-day fallback. The validation contract
("default 7") is violated for an entire interval of inputs.

**Fix.** Require `rawDays >= 1` (integer) before accepting; otherwise default.

```suggestion
    const rawDays = args.rangeDays ?? 7;
    const rangeDays =
      Number.isFinite(rawDays) && rawDays >= 1
        ? Math.min(Math.floor(rawDays), 90)
        : 7;
```

---

### [P2] `orgOverview` "recent 20" is ordered by `_creationTime`, not by event time `at` — late-ingested events surface at the top

**Location:** `convex/analytics.ts:146-150, 189-204`

```ts
      .withIndex("by_org", (q) => q.eq("organizationId", org._id))
      .order("desc")
      .take(ORG_SCAN_CAP);
    ...
      if (recent.length < RECENT_LIMIT) {
        ...
        recent.push({ ... at: event.at });
      }
```

**Problem.** "Recent calls" semantically means most-recent by call time (`at`).
The scan orders by `_creationTime desc`. When the gateway batches, retries, or
replays events (a documented path — `settleRefId` idempotency exists precisely
for redelivery), an event with an old `at` but fresh `_creationTime` is inserted
at the top of `recent`, ahead of events that actually happened more recently.
The dashboard "recent calls" list can thus show stale call-time entries above
genuinely newer ones.

**Impact.** Misleading "recent activity" feed for any org that experiences
gateway retry/batching. Low-frequency orgs never notice; the bug only bites the
operational scenarios where recency matters most.

**Fix.** Drive `recent` from a `by_org_at` range scan ordered by `at` (see the
P1 fix, which already produces an `at`-ordered `cycleEvents` — `recent` is
simply the first 20 of that scan).

---

### [P2] `projectLinearSpend` produces billions-of-credits projections in the first instant of a cycle

**Location:** `convex/analytics.ts:117-126, 215`

```ts
function projectLinearSpend(creditsCycle, cycleStart, now): number {
  if (creditsCycle <= 0) return 0;
  const elapsed = Math.max(now - cycleStart, 1);
  const cycleMs = Math.max(endOfUtcMonth(now) - cycleStart, 1);
  return Math.round((creditsCycle / elapsed) * cycleMs);
}
```

**Problem.** `elapsed` is floored to `1` millisecond. At the very start of a
UTC month (e.g. `00:00:00.001` on the 1st), if a single event carrying 1 credit
has already landed, `elapsed = 1` and `cycleMs` for a 31-day month is
`2_678_400_000`. Projection = `1 / 1 * 2_678_400_000 = 2.68e9` credits. The
dashboard "projected cycle spend" tile renders a meaningless multi-billion
figure for the first moments of every month. The `creditsCycle <= 0` guard only
short-circuits when *no* event has landed; a single early event is enough to
trigger the blowup.

**Impact.** The projected-spend tile is a load-bearing number (the org uses it
to budget). For the first seconds-to-minutes of each month it can show
absurd values. Even a few minutes in, `elapsed = 300_000` yields
`creditsCycle * 8_928` — still wildly inflated until a meaningful fraction of
the month has elapsed.

**Fix.** Floor `elapsed` to a sane minimum (e.g. 1 hour) and/or refuse to
project until a minimum elapsed window has passed.

```suggestion
function projectLinearSpend(creditsCycle: number, cycleStart: number, now: number): number {
  if (creditsCycle <= 0) return 0;
  const HOUR_MS = 3_600_000;
  const elapsed = Math.max(now - cycleStart, HOUR_MS);
  const cycleMs = Math.max(endOfUtcMonth(now) - cycleStart, 1);
  return Math.round((creditsCycle / elapsed) * cycleMs);
}
```

---

### [P3] Top-of-file comment is factually stale: claims "usageEvents only has by_org / by_project (no time index)" but `by_org_at` / `by_project_at` / `by_at` all exist

**Location:** `convex/analytics.ts:6-10`

```ts
/**
 * Scan caps — usageEvents only has by_org / by_project (no time index).
 * Queries order by _creationTime desc, filter on `at`, and stop at these caps.
 * High-volume orgs will undercount past the cap; a by_org_at index is the fix.
 */
```

**Problem.** `convex/schema.ts:109-111` defines `by_org_at`, `by_project_at`,
and `by_at`. The comment's "no time index" and "a by_org_at index is the fix"
are both false as of the current schema — the index exists and is already used
by `convex/usage.ts:listForOrg`. The comment actively misleads any maintainer
into believing the cap-and-filter design is unavoidable.

**Impact.** Misinformation that justifies the P1 bugs above. Future maintainers
will not fix the scan because the comment tells them the index is missing.

**Fix.** Delete the comment (and the caps, once P1 fixes land) or rewrite it to
describe the actual strategy.

---

### [P3] `truncated` flag conflates "scan hit cap" with "totals undercount" — and becomes dead once the P1 fixes land

**Location:** `convex/analytics.ts:152, 216-217, 261, 349-350`

```ts
    const truncated = scanned.length >= ORG_SCAN_CAP;
    ...
      truncated,
      scanCap: ORG_SCAN_CAP,
```

**Problem.** `truncated` is true whenever `scanned.length >= CAP`, but the
scan is bounded by `_creationTime`, not by the cycle/window. So `truncated=true`
can mean either (a) every in-window event was counted and the cap was hit by
out-of-window rows, or (b) in-window events were actually dropped. The UI
cannot tell which, and renders the flag as a generic "may undercount" warning.
Once the P1 fixes switch to a time-indexed range scan with no cap, `truncated`
and `scanCap` become dead fields on both `OrgOverview` and `ProjectAnalytics`
and on the exported types.

**Impact.** Ambiguous UX signal today; dead API surface after the correct fix.

**Fix.** After the P1 fix, remove `truncated` / `scanCap` from both return
types and the web consumers; if a cap is retained for safety, redefine
`truncated` to mean specifically "in-window events were dropped" (requires a
second count or an overflow signal from the scan).

---

## Summary

- **7 findings** — **0 P0**, **2 P1**, **3 P2**, **2 P3**
- **Top 3:**
  1. `orgOverview` ignores the existing `by_org_at` index, capping the scan at
     5 000 `_creationTime`-ordered rows and silently undercounting cycle spend,
     projected spend, and the recent-events feed (P1).
  2. `projectAnalytics` ignores the existing `by_project_at` index, capping at
     10 000 and silently biasing counts, percentiles, and daily bars for the
     highest-volume publishers it is meant to serve (P1).
  3. `rangeDays` validation accepts `(0, 1)` values, collapsing to
     `rangeDays = 0`, a future `rangeStart`, and an empty result instead of the
     documented 7-day default (P2).

**Cross-org leak check:** clean. Both queries resolve the org via
`requireOrgMemberBySlug` (JWT org claim must match the slug's
`clerkOrgId`); `projectAnalytics` further scopes the project lookup through
`by_org_slug` (`organizationId` + `slug`), so a caller cannot address another
org's project slug. `usageEvents` are filtered by the caller's own
`organizationId` (consumer view in `orgOverview`) or by a project the caller
owns (publisher view in `projectAnalytics`); no `organizationId` from the
opposite tenant is returned in any output shape. No leak path found.
