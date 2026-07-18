# Tiger Review — `apps/web/src/lib/` misc batch 1

Reviewed files (full source + their `.test.ts`):
- `relative-time.ts` / `relative-time.test.ts`
- `slug.ts` (no test)
- `utils.ts` (no test — `cn` only)
- `onboarding.ts` / `onboarding.test.ts`
- `project-helpers.ts` / `project-helpers.test.ts`
- `landing.ts` / `landing.test.ts`
- `line-diff.ts` / `line-diff.test.ts`
- `catalogue-card.ts` / `catalogue-card.test.ts`
- `catalogue-search.ts` / `catalogue-search.test.ts`
- `activity-filters.ts` / `activity-filters.test.ts`
- `admin-filters.ts` / `admin-filters.test.ts`

Also traced consumers for cross-boundary checks: `routes/app/projects/create.tsx` (slugify), `routes/index.tsx` + `routes/catalogue/$orgSlug.$projectSlug.tsx` + `routes/docs/agents.tsx` (`buildMcpConfigSnippet`/`mcpEndpointUrl`), `components/project-earnings-panel.tsx` + `routes/app/earnings.tsx` (`formatCreditsAsUsd`). No praise — only problems.

## Verdict

**FAIL (minor).** No P0/P1. Two P2 correctness defects — a CRLF-handling hole in `lineDiff` that marks every line as changed for Windows-authored specs, and a locale/timezone-derived SSR hydration mismatch in `formatRelativeTime`'s absolute-date fallback. The rest are P3 hardening nits: dead code, missing numeric guards, unescaped interpolation into a JSON snippet, and a non-exhaustive switch. None block release; the P2s should be fixed before merge because they silently corrupt real user output.

## File Stats

| File | LOC | Findings |
|---|---|---|
| `relative-time.ts` | 38 | 1 |
| `slug.ts` | 10 | 2 |
| `utils.ts` | 5 | 0 |
| `onboarding.ts` | 41 | 0 |
| `project-helpers.ts` | 56 | 1 |
| `landing.ts` | 96 | 1 |
| `line-diff.ts` | 67 | 2 |
| `catalogue-card.ts` | 31 | 1 |
| `catalogue-search.ts` | 23 | 1 |
| `activity-filters.ts` | 91 | 2 |
| `admin-filters.ts` | 121 | 1 |
| **Total** | — | **12** |

## Findings

### [SEV: P2] `lineDiff` splits on `\n` only — CRLF content marks every line as added/removed

**Location:** `apps/web/src/lib/line-diff.ts:18-19`

```ts
const a = oldText === "" ? [] : oldText.split("\n");
const b = newText === "" ? [] : newText.split("\n");
```

**Problem:** `String.prototype.split("\n")` does not strip a trailing `\r`. If either side is CRLF-terminated (the default for Windows-authored OpenAPI specs pasted from Notepad, or anything round-tripped through certain editors), every line carries a trailing `\r`. Line equality is then `a[i] === b[j]` comparing `"foo\r"` against `"foo"` — they never match, so `lcs[i][j]` stays 0 and the entire old side is emitted as `removed` and the entire new side as `added`. The "common subsequences aligned" test only covers LF input, so this is uncaught.

Real trigger: a user uploads a CRLF spec, then the in-browser editor normalizes to LF (or vice versa). The diff view shows 100% churn for a one-line edit.

**Impact:** Useless diffs for any cross-line-ending comparison; the spec editor becomes unreadable on Windows-sourced content.

**Fix:** Normalize line endings before splitting:
```ts
const a = oldText === "" ? [] : oldText.replace(/\r\n?/g, "\n").split("\n");
const b = newText === "" ? [] : newText.replace(/\r\n?/g, "\n").split("\n");
```
(Decide whether a pure `\r`-only classic-Mac ending should be normalized too; `\r\n?` covers both CRLF and lone CR.)

---

### [SEV: P2] `formatRelativeTime` absolute-date fallback is non-deterministic across SSR and browser → hydration mismatch

**Location:** `apps/web/src/lib/relative-time.ts:33-38`

```ts
// Beyond ~5 weeks the relative bucket loses meaning — show a real date.
return new Date(then).toLocaleDateString(undefined, {
  month: "short",
  day: "numeric",
});
```

**Problem:** Two sources of non-determinism in the >5-weeks fallback:

1. **Locale:** `toLocaleDateString(undefined, …)` passes `undefined` as the locale, which means "use the runtime's default locale." Under TanStack Start SSR, that default is whatever the Node process resolved (commonly `en-US` from ICU, but driven by `LANG`/`LC_*` and not guaranteed). In the browser it is `navigator.language` / OS locale. A notification older than ~5 weeks renders `"Jul 11"` server-side and `"11 jul"` (or `"11. Juli"`, etc.) client-side → React hydration warning + visible flash.
2. **Timezone:** `new Date(then).toLocaleDateString` formats in the host's local TZ. Server TZ (often UTC in containers) vs. user TZ can shift the `day` by ±1 for events near midnight. Same hydration symptom.

The pure-relative buckets (`"5m"`, `"3h"`, `"2d"`, `"4w"`) are TZ/locale-independent and fine — the bug is only on the absolute-date path, so it only bites old notifications, which is why it slips past the test suite (all tests use a fixed `now` and never assert the absolute-date string).

**Impact:** Hydration warnings and a flash of wrong date for notifications older than ~5 weeks. Visible to any user whose locale/TZ differs from the server's.

**Fix:** Pin an explicit locale and either render the date in UTC or accept that the component must be client-only past 5 weeks. Simplest:
```ts
return new Date(then).toLocaleDateString("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
```
Or, if you want viewer-local dates, push the formatting behind a `useEffect`/client-only boundary so SSR and first paint agree.

---

### [SEV: P3] `slugify`'s final `slice(0, 64)` can leave a trailing dash

**Location:** `apps/web/src/lib/slug.ts:3-10`

```ts
return input
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .replace(/-{2,}/g, "-")
  .slice(0, 64);
```

**Problem:** Edge-strip happens *before* the slice. If the collapsed slug is longer than 64 chars and position 63 (0-indexed) lands on a `-`, the slice cuts there and the returned slug ends with `-`. Concrete: `slugify("a".repeat(63) + "-" + "b".repeat(10))` → after collapse: `aaa…aaa-bbb…bbb` (74 chars) → after edge-strip: unchanged → `slice(0, 64)` = 63 `a`s + `-`. The slug sent to the server (consumer: `routes/app/projects/create.tsx:66,72`) ends in a dash.

**Impact:** Ugly/semantically-wrong slugs at the 64-char boundary; depends on whether the server re-canonicalizes. Cosmetic for short names; a real (if narrow) defect at the boundary.

**Fix:** Slice first, then strip trailing dashes again:
```ts
return input
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 64)
  .replace(/-+$/g, "");
```

---

### [SEV: P3] `slugify`'s `-{2,}` collapse is dead code

**Location:** `apps/web/src/lib/slug.ts:8`

```ts
.replace(/-{2,}/g, "-")
```

**Problem:** The preceding `[^a-z0-9]+/g` already replaces *any run of non-alphanumeric characters* (and `-` is non-alphanumeric) with a single `-`. After that step the string contains only `a-z0-9` and single `-`s — there cannot be a `--` run. The `-{2,}` replace can never match. Confirmed by tracing `---`, `"a---b"`, `"-a-"` etc. — all are already collapsed by the first regex.

**Impact:** Dead code; misleading to a future maintainer who might think the first regex leaves runs intact.

**Fix:** Delete the `.replace(/-{2,}/g, "-")` line (or merge its intent into a comment on the first replace).

---

### [SEV: P3] `lineDiff` has no input-size cap — O(m·n) time and space, tab-freeze on large pastes

**Location:** `apps/web/src/lib/line-diff.ts:20-30`

```ts
const lcs: number[][] = Array.from({ length: m + 1 }, () =>
  new Array<number>(n + 1).fill(0),
);
```

**Problem:** The module comment hedges "fine for spec-sized documents (hundreds of lines)" but enforces nothing. A user pasting a 10 000-line spec into the editor triggers 10^8 cell allocations (~800 MB as `number`), locking the tab; a 50 000-line paste OOMs. The function is called from the spec editor on user-supplied content, so the input is not trusted to be "spec-sized."

**Impact:** Client-side DoS / tab crash on large input; no guardrail.

**Fix:** Either cap `m`/`n` (e.g. `if (m > 4000 || n > 4000) return fallbackFlatDiff(a, b)`), or switch to Hirschberg's O(min(m,n))-space algorithm. A hard cap with a flat fallback is the minimal fix.

---

### [SEV: P3] `buildMcpConfigSnippet` interpolates `mcpUrl` into a JSON-looking string without escaping

**Location:** `apps/web/src/lib/landing.ts:40-54`

```ts
export function buildMcpConfigSnippet(mcpUrl: string): string {
  return `{
  "mcpServers": {
    "zevium": {
      "url": "${mcpUrl}",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}`;
}
```

**Problem:** `mcpUrl` is interpolated verbatim into a string presented to the user as a copy-paste JSON config. If `VITE_GATEWAY_URL` ever contains a `"`, `\`, or newline (misconfigured env, or a future URL carrying a query string with an encoded quote that an operator mistakenly decodes), the emitted snippet is invalid JSON and the user's MCP client fails to parse it on paste. The test only asserts `.toContain('"url": "http://localhost:8787/mcp"')`, so a regression here is invisible.

**Impact:** Broken MCP config snippets for users when env is non-trivial; the function silently emits malformed JSON.

**Fix:** Build the snippet with `JSON.stringify` so escaping is correct by construction:
```ts
export function buildMcpConfigSnippet(mcpUrl: string): string {
  const config = {
    mcpServers: {
      zevium: {
        url: mcpUrl,
        headers: { Authorization: "Bearer YOUR_API_KEY" },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}
```

---

### [SEV: P3] `formatCataloguePriceRange` trusts `minCost`/`maxCost` shape — NaN, inversion, undefined render literally

**Location:** `apps/web/src/lib/catalogue-card.ts:11-22`

```ts
if (pricing.endpointCount === 0) return null;
if (pricing.minCost === pricing.maxCost) {
  return `${pricing.minCost} cr/call`;
}
return `${pricing.minCost}–${pricing.maxCost} cr/call`;
```

**Problem:** No guards for: (a) `minCost > maxCost` (inverted rollup) → `"8–1 cr/call"`; (b) `NaN` fields → `"NaN cr/call"` or `"NaN–NaN cr/call"`; (c) `undefined` fields when `endpointCount > 0` (broken server rollup) → `"undefined–undefined cr/call"`. The `minCost === maxCost` equality check also passes for `undefined === undefined` and `NaN === NaN` is false (so NaN falls into the range branch, but both are still NaN). The tests only cover the happy path.

**Impact:** Garbage chips surface to users if the `catalogue.listPublic` rollup ever returns malformed data; no defensive layer.

**Fix:**
```ts
const { minCost, maxCost } = pricing;
if (
  typeof minCost !== "number" || typeof maxCost !== "number" ||
  !Number.isFinite(minCost) || !Number.isFinite(maxCost)
) return null;
const lo = Math.min(minCost, maxCost);
const hi = Math.max(minCost, maxCost);
if (lo === hi) return `${lo} cr/call`;
return `${lo}–${hi} cr/call`;
```

---

### [SEV: P3] `formatCreditsAsUsd` renders negative sub-cent amounts as `"$-0.0005"` (misplaced sign)

**Location:** `apps/web/src/lib/project-helpers.ts:17-31`

```ts
const fixed = dollars.toFixed(fractionDigits);
const cleaned =
  fractionDigits === 4 ? fixed.replace(/(\.\d{2}\d*?)0+$/, "$1") : fixed;
return `$${cleaned}`;
```

**Problem:** For `credits` in `(-100, 0)` (e.g. a reversed earning or negative net), `dollars` is a negative sub-cent value. `abs` is still `< 0.01`, so `fractionDigits = 4`, `fixed = "-0.0005"`, the trailing-zero regex doesn't match, and the return is `"$-0.0005"` — sign between the `$` and the digits. Accounting UIs render negative currency as `-$0.0005` or `($0.0005)`, never `$-0.0005`. The `ProjectEarningsPanel` consumer (`components/project-earnings-panel.tsx:125,136`) displays `grossCredits`/`netCredits`; if a reversed earning ever produces a negative, the panel shows malformed currency. No test covers the negative branch.

**Impact:** Malformed currency display for negative sub-cent amounts; accounting/audit surface.

**Fix:** Handle the sign explicitly:
```ts
const sign = dollars < 0 ? "-" : "";
const fixed = Math.abs(dollars).toFixed(fractionDigits);
const cleaned =
  fractionDigits === 4 ? fixed.replace(/(\.\d{2}\d*?)0+$/, "$1") : fixed;
return `${sign}$${cleaned}`;
```

---

### [SEV: P3] `activitySinceMs` switch has no exhaustiveness guard — a new `ActivityTimeRange` variant silently behaves as "all"

**Location:** `apps/web/src/lib/activity-filters.ts:24-33`

```ts
export function activitySinceMs(
  range: ActivityTimeRange,
  now: number = Date.now(),
): number | undefined {
  switch (range) {
    case "24h": return now - 24 * HOUR_MS;
    case "7d":  return now - 7 * DAY_MS;
    case "30d": return now - 30 * DAY_MS;
    case "all": return undefined;
  }
}
```

**Problem:** The return type is `number | undefined`, so TypeScript does not flag a missing case as an implicit-`undefined` return (undefined is already in the signature). If a future variant (e.g. `"90d"`, `"ytd"`) is added to `ActivityTimeRange` without a case here, the function silently returns `undefined` — i.e. "all time" — with no compile error and no test. `parseActivityTimeRange` would also need updating, but the type system won't force this function to come along.

**Impact:** Latent: a new range variant silently degrades to "all time" in the `since` computation while the UI chip shows the new label.

**Fix:** Add a default branch that the type system rejects, or assert exhaustiveness:
```ts
switch (range) {
  case "24h": return now - 24 * HOUR_MS;
  case "7d":  return now - 7 * DAY_MS;
  case "30d": return now - 30 * DAY_MS;
  case "all": return undefined;
  default: {
    const _exhaustive: never = range;
    throw new Error(`Unhandled range: ${String(_exhaustive)}`);
  }
}
```

---

### [SEV: P3] `mergeUsagePages` with `replace: true` does not dedupe within `incoming`

**Location:** `apps/web/src/lib/activity-filters.ts:57-60`

```ts
if (replace) {
  return [...incoming];
}
```

**Problem:** The non-replace path carefully dedupes by `_id` (across existing ∪ incoming and within incoming). The replace path just spreads `incoming` verbatim. If a Convex page ever returns duplicate `_id`s (a bug or a synthetic merge), the replace path happily surfaces dupes to the list, while the append path would have collapsed them. The asymmetry is unexplained and the tests don't exercise duplicate `_id`s within `incoming`.

**Impact:** Duplicate rows in the activity list on a filter reset / first page if the underlying query returns dupes; the dedupe invariant is inconsistently applied.

**Fix:** Dedupe in both branches, or document why `replace` is trusted:
```ts
if (replace) {
  const seen = new Set<string>();
  return incoming.filter((row) =>
    seen.has(row._id) ? false : (seen.add(row._id), true),
  );
}
```

---

### [SEV: P3] `relevanceFraction` does not guard `Infinity` — maps to `1.0` / "100% match"

**Location:** `apps/web/src/lib/catalogue-search.ts:8-11`

```ts
export function relevanceFraction(score: number): number {
  if (Number.isNaN(score)) return 0;
  return Math.max(0, Math.min(1, score));
}
```

**Problem:** Only `NaN` is special-cased. `Number.POSITIVE_INFINITY` passes through `Math.min(1, Infinity) → 1` and `Math.max(0, 1) → 1`, so an `Infinity` score (which Convex `vectorSearch` should never return, but a future code path or a manual call might) renders as `"100% match"`. `-Infinity` correctly clamps to 0. The asymmetry is a smell; the test covers NaN but not ±Infinity.

**Impact:** Misleading "100% match" chip if an infinite score ever reaches the formatter.

**Fix:**
```ts
export function relevanceFraction(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score));
}
```
(This also subsumes the NaN check.)

---

### [SEV: P3] `orgDisplayName` / `orgDisplayNameByClerkId` return `""` when both name and slug are empty

**Location:** `apps/web/src/lib/admin-filters.ts:64-69`, `:111-116`

```ts
export function orgDisplayName(orgId, map): string {
  const entry = map.get(orgId);
  if (entry === undefined) return "—";
  return entry.name.length > 0 ? entry.name : entry.slug;
}
```

**Problem:** If an org row has both `name: ""` and `slug: ""` (a data bug, or a partially-migrated org), the function returns `""`. The admin table renders a blank cell where the documented fallback is `"—"`. The "prefers name, falls back to slug" contract silently produces an empty string when both are absent. The test only exercises `name=""` with a non-empty slug fallback.

**Impact:** Blank cells in admin tables for malformed org rows; inconsistent with the "—" fallback contract.

**Fix:**
```ts
const name = entry.name.length > 0 ? entry.name : entry.slug;
return name.length > 0 ? name : "—";
```
Apply to both `orgDisplayName` and `orgDisplayNameByClerkId`.

---

## Summary

**Counts:** 0 × P0 · 0 × P1 · 2 × P2 · 10 × P3 — 12 findings total.

**Top 3 to fix before merge:**

1. **`lineDiff` CRLF handling (P2)** — silently produces all-changed diffs for Windows-authored specs; one-line normalize fix.
2. **`formatRelativeTime` absolute-date fallback (P2)** — `toLocaleDateString(undefined, …)` causes SSR hydration mismatch on locale/TZ divergence; pin locale + timeZone.
3. **`slugify` trailing-dash + dead `-{2,}` collapse (P3 × 2)** — slice-then-strip and delete dead code; both narrow but the slug is user-visible and persisted.

**Cross-cutting notes (not filed as findings — no provable defect):**
- `onboarding.ts`'s `shouldShowOnboarding` only guards `keysLoaded` against false-flash; the comment explicitly scopes it to keys, but `hasCall`/`hasTopUp` flashes are not guarded. Whether that is intentional depends on whether calls/balance are guaranteed loaded by the time keys resolve — could not verify from this batch alone.
- `parseTagsInput` in `project-helpers.ts` claims to "mirror server normalization in `projects.update`" but the server normalizer is outside this batch; the claim is unverified here.
- `landing.ts`'s `mcpEndpointUrl` / `discoveryEndpointUrl` / `tryItBaseUrl` only strip a *trailing* `/gateway$`; mid-path `/gateway/` segments pass through unchanged. Appears deliberate per tests; flagging only as a behavior note.
