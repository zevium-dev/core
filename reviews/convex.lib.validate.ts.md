# Tiger Review — `convex/lib/validate.ts`

## Verdict

**Incorrect.** The file itself is a 6-line re-export shim, but it is the sole
boundary-validation surface imported by every Convex function that checks
slugs, semver, and OpenAPI specs (`convex/projects.ts`, `convex/specs.ts`,
`convex/dev.ts`). The backing implementation in `packages/shared/src/validate.ts`
that this shim exposes has multiple provable defects: the same exported symbol
(`validateOpenApiSpec`) resolves to two different return types across module
boundaries, the OpenAPI validator accepts pricing values the gateway silently
rewrites, it never validates `x-zevium-free-tier`, it accepts SSRF-enabling
upstream URLs, the semver regex is unbounded and ReDoS-prone, and there is no
size bound on parsed specs. Several helpers re-exported here are dead. This is
the first line of defense and it leaks.

## File Stats

- **File under review:** `convex/lib/validate.ts` (6 lines, re-export shim).
- **Backing implementation:** `packages/shared/src/validate.ts` (192 lines).
- **Exports surfaced to Convex:** `isValidSlug`, `isValidSemver`, `hasErrors`,
  `SpecIssue`, and `collectOpenApiSpecIssues as validateOpenApiSpec`.
- **Exports NOT surfaced (but exist in shared):** real `validateOpenApiSpec`
  (returns `SpecValidationResult`), `hasValidationErrors`, `SpecValidationResult`,
  `collectOpenApiSpecIssues` (under its own name).
- **Convex callers:** `convex/projects.ts` (`isValidSlug`),
  `convex/specs.ts` (`isValidSemver`, `SpecIssue`, `validateOpenApiSpec`),
  `convex/dev.ts` (`validateOpenApiSpec`).
- **Web/gateway callers** import directly from `@zevium/shared`, bypassing the
  shim entirely.

## Findings

### [P2] `validateOpenApiSpec` symbol is overloaded across the module boundary with two incompatible return-type contracts

**Location:** `convex/lib/validate.ts:6-11` (the shim) vs
`packages/shared/src/validate.ts:177-183` (the real `validateOpenApiSpec`).

**Problem:** The shim does:

```ts
export {
  isValidSlug,
  isValidSemver,
  hasErrors,
  type SpecIssue,
  collectOpenApiSpecIssues as validateOpenApiSpec,
} from "@zevium/shared";
```

`collectOpenApiSpecIssues` returns `SpecIssue[]`. The real
`validateOpenApiSpec` exported from `@zevium/shared` returns
`SpecValidationResult` (`{ errors, warnings }`). So the *same* symbol name
`validateOpenApiSpec` means two different things on either side of the
Convex/`@zevium/shared` boundary:

| Consumer | `validateOpenApiSpec(x)` returns |
|---|---|
| `convex/specs.ts`, `convex/dev.ts` (via shim) | `SpecIssue[]` |
| `packages/shared/src/validate.test.ts`, any web code importing `@zevium/shared` | `SpecValidationResult` |

TypeScript saves the Convex side from runtime breakage *only because* the alias
points at the `SpecIssue[]` function and callers use `.some(i => i.level ===
"error")`. But the contract is now latent-confusion: a developer who copies the
documented `validateOpenApiSpec` → `{ errors, warnings }` shape from
`packages/shared` into a Convex function will get a type error at best, and at
worst (after a refactor that swaps the alias back) silent semantic drift
between client and server validation results. The comment on line 2-4 even
calls `validateOpenApiSpec` the result-typed function while the export aliases
the array-typed one.

**Impact:** Boundary-validation contract is ambiguous; high risk of a future
change flipping server-side validation semantics without any test catching it
(the Convex side has no tests for `validateOpenApiSpec`'s return shape; the
shared tests assert the *other* return shape).

**Fix:** Stop aliasing. Re-export both functions under their real names and
update Convex callers to use `collectOpenApiSpecIssues` explicitly:

```ts
export {
  isValidSlug,
  isValidSemver,
  hasErrors,
  collectOpenApiSpecIssues,
  validateOpenApiSpec,
  type SpecIssue,
  type SpecValidationResult,
} from "@zevium/shared";
```

Then s/validateOpenApiSpec/collectOpenApiSpecIssues/ in `convex/specs.ts` and
`convex/dev.ts` (they already consume `SpecIssue[]`).

---

### [P2] `x-zevium-cost: 0` and fractional costs are accepted by the validator but silently rewritten by the gateway

**Location:** `packages/shared/src/validate.ts:141-149` (cost check) crossed
with `packages/shared/src/openapi.ts:144-147` (`extractPricing`).

**Problem:** The validator accepts any finite `number >= 0`:

```ts
} else if (
  typeof cost !== "number" ||
  !Number.isFinite(cost) ||
  cost < 0
) {
  issues.push({ ... message: "x-zevium-cost must be a number ≥ 0" });
}
```

But the gateway's `extractPricing` does:

```ts
const cost = costRaw !== undefined && costRaw > 0 ? Math.floor(costRaw) : 1;
```

So a spec the validator calls *valid* is silently rewritten at request time:

| `x-zevium-cost` in published spec | Validator | Gateway charges |
|---|---|---|
| `0` (free endpoint) | ✅ valid | **1 credit** (publisher's "free" endpoint is billed) |
| `1.5` | ✅ valid | **1 credit** (fractional silently floored) |
| `0.4` | ✅ valid | **1 credit** |

**Impact:** Publishers who set `x-zevium-cost: 0` (documented as a free
endpoint intent) have their endpoint silently billed at 1 credit. Consumers
are overcharged relative to the published contract. The validator is the
boundary that is supposed to make "what the spec says" == "what the gateway
charges"; it does not.

**Fix:** Decide the contract and enforce it at the validator (the boundary),
not the gateway:
- If `0` means free: validator keeps `>= 0`, `extractPricing` must return
  `cost: 0` and the wallet reserve path must accept a 0-credit charge.
- If `0` is invalid: validator rejects `cost < 1` (or `cost <= 0`) and the
  message becomes `"x-zevium-cost must be a positive integer ≥ 1"`.
- Either way, reject non-integers (`!Number.isInteger(cost)`) so the floor in
  `extractPricing` is never load-bearing.

---

### [P2] `x-zevium-free-tier` is not validated at all

**Location:** `packages/shared/src/validate.ts:113-150` (operation loop only
checks `x-zevium-cost`); cross with `packages/shared/src/openapi.ts:149-152`
(`extractPricing` reads `x-zevium-free-tier`).

**Problem:** The validator iterates every operation and checks `x-zevium-cost`
but never touches `x-zevium-free-tier`, even though `x-zevium-free-tier` is a
first-class pricing field (PRODUCT.md, README, FLOW.md, gateway DO counters).
`extractPricing` reads it via `asNumber`, which silently coerces:

| `x-zevium-free-tier` value | Validator | Gateway behavior |
|---|---|---|
| `-5` (typo / negative) | ✅ no issue | `> 0` false → free tier **silently disabled** |
| `"25"` (string) | ✅ no issue | parsed to 25 → enabled (validator never checked type) |
| `1.5` | ✅ no issue | floored to 1 |
| `Infinity`, `NaN` | ✅ no issue | `asNumber` returns undefined → disabled |
| `"abc"` | ✅ no issue | disabled |

**Impact:** A publisher who typos `x-zevium-free-tier: -5` or `"5"` (string)
publishes with zero validation feedback; their free tier is silently disabled
or silently coerced. The catalogue `hasFreeTier` badge and the per-key per-day
counter both derive from this unvalidated field. The boundary gives no signal.

**Fix:** Mirror the `x-zevium-cost` check for `x-zevium-free-tier` when
present: require `typeof === "number"`, `Number.isFinite`, `Number.isInteger`,
`>= 0` (or `>= 1`), else push an `error` issue at the same `$.paths[...].<method>.x-zevium-free-tier` path.

---

### [P2] `servers[0].url` validation accepts loopback / link-local / RFC1918 targets (SSRF enabler)

**Location:** `packages/shared/src/validate.ts:84-104` (URL protocol check).

**Problem:**

```ts
let url: URL | null = null;
try { url = new URL(first.url); } catch { url = null; }
if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
  issues.push({ ... message: "servers[0].url must be an http(s) URL" });
}
```

The check only verifies the scheme. It accepts, among others:
- `http://169.254.169.254/latest/meta-data/` (cloud metadata endpoint)
- `http://localhost:9222`, `http://127.0.0.1:8787`
- `http://10.0.0.1`, `http://192.168.1.1`
- `http://[::1]/` (IPv6 loopback)

The gateway proxies consumer requests to this URL via `joinUpstreamUrl` +
`fetch`. An authenticated org member can publish a spec whose `servers[0].url`
points at the metadata service or internal infra, then any consumer call to
that project is an SSRF probe from the gateway's network position. The
validator is the right place to reject private ranges at the publish boundary.

**Impact:** Server-side request forgement from the Cloudflare Worker
data-plane network position, reachable by any authenticated publisher.

**Fix:** Resolve the hostname and reject when it parses to a private /
loopback / link-local / unspecified address (or has a `localhost`/`*.local`
suffix), in addition to the scheme check. Re-test on every publish (the URL
lives in the immutable specVersions row).

---

### [P2] No size or cardinality bound on the parsed spec; `JSON.parse` + full `paths` traversal on every save/publish (and every keystroke on the client)

**Location:** `packages/shared/src/validate.ts:49-55` (`JSON.parse` with no
length guard), `:107-150` (unbounded `Object.entries(raw.paths)` +
nested `Object.entries(pathVal)`); Convex callers `convex/specs.ts:43`
(`args.spec: v.string()`, no max) and `convex/specs.ts:118` (`version:
v.string()`).

**Problem:** `collectOpenApiSpecIssues` immediately `JSON.parse`s the full
input and then walks every path × every operation. There is no bound on:

- `specText.length` — only Convex platform arg/doc limits (~1 MB) cap it
  server-side; the validator itself enforces nothing.
- `Object.keys(raw.paths).length` — a spec with 100 000 paths is iterated
  fully on every call.
- `Object.keys(pathVal).length` — same per path item.

`saveDraft` and `publish` are authenticated (`requireProjectMember`) but any
org member can call them. Each call allocates the full parse tree and walks
it; on the client (`spec-workspace.tsx:153-156`) the same function runs on
every 300ms-debounced keystroke against editor state.

**Impact:** Authenticated CPU/memory DoS at the Convex boundary (and a
client-side editor freeze). Convex's wall-clock timeout will eventually kill
the function, but a ~900 KB deeply-nested spec (under the doc limit) parsed on
every `saveDraft` is an cheaply-triggerable hot-path amplification.

**Fix:** Add an explicit `if (specText.length > MAX_SPEC_BYTES) return [...]
` guard at the top of `collectOpenApiSpecIssues` (e.g. 256 KB) and a path-count
cap (e.g. 1024) inside the loop, returning an error issue on overflow. Mirror
the byte cap in `convex/specs.ts` `saveDraft`/`publish` before calling
`validateOpenApiSpec`.

---

### [P2] `SEMVER_RE.test` has no length bound and exhibits quadratic backtracking on crafted pre-release segments

**Location:** `packages/shared/src/validate.ts:6-7` (regex),
`:15-17` (`isValidSemver`), called from `convex/specs.ts:104-105` on
`args.version.trim()` where `version: v.string()` (no max).

**Problem:** Two distinct issues compound:

1. **No length bound.** `isValidSemver` returns `true` for a megabyte-long
   valid semver string (`1.0.0-` + `a.`.repeat(50000) + `a`). The Convex
   `specVersions.version` field is `v.string()` with no cap; this gets stored
   and indexed (`by_project_version` index includes `version`).

2. **ReDoS.** The pre-release alternation
   `(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)` evaluates branches left-to-right.
   For a segment starting with `0` followed by digits then a non-matching
   char, branch 1 (`0`) fails the overall match (more chars follow), branch 2
   (`[1-9]\d*`) fails (first char is `0`), and branch 3 (`\d*[a-zA-Z-]...`)
   greedily consumes all digits then backtracks one char at a time looking for
   a letter that never comes. With M segments of `0`+N digits, total work is
   O(N·M). A crafted `version` like
   `1.0.0-` + (`0` + `9`.repeat(4000) + `.`).repeat(400) + `!`
   is rejected but only after ~10⁷ regex steps.

   `isValidSemver` is called from `publish` (authenticated), so an org member
   can hang a Convex function by submitting a crafted ~1 MB version string.

**Impact:** Authenticated ReDoS / memory inflation at the publish boundary;
stored megabyte-length version strings polluting the version index.

**Fix:** Bound the input first: `if (version.length > 200) return false;`
(semver 2.0.0 max sensible length is tiny). Consider anchoring with a simpler
non-backtracking check, or pre-validating that the string contains no `0\d+`
runs before the regex. The 200-char cap alone eliminates the ReDoS window.

---

### [P2] `openapi` field is checked for non-emptiness only; Swagger 2.0 / garbage strings pass

**Location:** `packages/shared/src/validate.ts:62-67`.

**Problem:**

```ts
if (typeof raw.openapi !== "string" || raw.openapi.trim() === "") {
  issues.push({ ... message: "Missing openapi field (expected OpenAPI 3.x version string)" });
}
```

The message promises "OpenAPI 3.x" enforcement; the code only rejects empty
strings. A spec with `openapi: "2.0"`, `openapi: "swagger"`, or
`openapi: "3.0.0"` all pass. The gateway `parseSpec` reads `openapi` as an
opaque optional string and never enforces 3.x either. A publisher uploading a
Swagger 2.0 doc passes validation, publishes, and the gateway then mishandles
it (Swagger 2.0 has no `paths.<method>.servers`/`webhooks`/3.1 features, and
uses `basePath`/`host` not `servers`). The defect surfaces downstream as
silent route/pricing failures, not at the boundary where it should.

**Impact:** Invalid specs pass the publish gate; failures surface as
mysterious 404s / wrong pricing at call time.

**Fix:** Enforce the version: require `raw.openapi` to match
`/^3\.(0|1)\.\d+(-.+)?$/` (or at least start with `3.`), and align the
message with the actual check.

---

### [P3] `paths: {}` (empty object) passes with zero issues; only a missing `paths` key warns

**Location:** `packages/shared/src/validate.ts:106-112`.

**Problem:**

```ts
if (!isRecord(raw.paths)) {
  issues.push({ level: "warning", path: "$.paths", message: "No paths object — catalogue will show zero endpoints" });
  return issues;
}
for (const [pathKey, pathVal] of Object.entries(raw.paths)) { ... }
```

- `paths` missing or non-object → warning + early return.
- `paths: {}` → `isRecord({})` true → no warning, loop body never executes,
  returns with **zero issues**.

So a spec with `{openapi:"3.1.0", servers:[{url:"https://x"}], paths:{}}`
passes validation *cleaner* (no warning at all) than a spec missing `paths`
(which gets a warning). A publisher can publish an endpoint-less spec and get
no signal at all.

**Impact:** Inconsistent boundary signal; degenerate specs publish silently.

**Fix:** Warn when `Object.keys(raw.paths).length === 0` with the same message
as the missing-paths branch.

---

### [P3] Path keys are not validated; malformed keys and `]`/`"` in keys break the issue-path format

**Location:** `packages/shared/src/validate.ts:113-150`.

**Problem:** OpenAPI requires every key in `paths` to start with `/`. The
validator never checks this; it uses the raw key directly in the issue path
via template literal:

```ts
path: `$.paths["${pathKey}"].${lower}.x-zevium-cost`,
```

A path key like `users` (no leading slash), `users"]$.foo` (contains `"]`),
or `a"b` (contains `"`) is accepted and produces a malformed,
non-JSONPath-compliant `issue.path`. The web editor (`json-code-editor.tsx:34`)
only stringifies `${issue.message} (${issue.path})` into a lint message, so
today it is display-only breakage, but any future consumer that parses
`issue.path` will mis-route. The gateway's `matchOperation` calls
`normalizePath(template)` which silently prepends `/` to a keyless template,
so a path missing its leading slash also matches inconsistently between
validation (accepts) and OpenAPI semantics (rejects).

**Impact:** Malformed specs accepted at the boundary; issue paths
unparseable; downstream inconsistency.

**Fix:** Validate `pathKey` starts with `/` and contains no `"` / `]` (or
escape them when interpolating into the issue path).

---

### [P3] Issue path format is non-JSONPath-compliant: `x-zevium-cost` is a bare dot-segment containing hyphens

**Location:** `packages/shared/src/validate.ts:140`,
`:124`, `:130`, e.g. `$.paths["/x"].get.x-zevium-cost`.

**Problem:** Path keys with `/` are bracket-quoted (`$.paths["/x"]`), but the
field `x-zevium-cost` is appended as a bare dot-segment. A consumer splitting
`issue.path` on `.` would get `x`, `zevium`, `cost` as three segments — the
hyphenated field name is ambiguous against the dot delimiter. JSONPath would
require `$.paths["/x"].get["x-zevium-cost"]`. The web editor currently only
stringifies the path, so there is no live breakage, but the format is
inconsistent within a single path string (mixed bracket and bare-dot
notation for keys that both contain reserved chars).

**Impact:** Future path-parsing consumers (linters, diff highlighters,
structured error reporting) will mis-tokenize the path.

**Fix:** Bracket-quote any segment that is not a bare ASCII identifier:
`$.paths["/x"].get["x-zevium-cost"]`.

---

### [P3] `hasErrors`, `hasValidationErrors`, real `validateOpenApiSpec`, and `SpecValidationResult` are dead in Convex

**Location:** `convex/lib/validate.ts:6-11` re-exports `hasErrors` (and aliases
the array function to `validateOpenApiSpec`).

**Problem:** A repo-wide grep for `hasErrors` shows it is imported only by
`packages/shared/src/validate.test.ts`. No Convex caller uses it: `convex/specs.ts`
and `convex/dev.ts` inline `issues.some((i) => i.level === "error")` instead.
`hasValidationErrors`, the real `validateOpenApiSpec`, and `SpecValidationResult`
are exported from `@zevium/shared` but only exercised by the shared test file.
The shim's `hasErrors` re-export is pure dead weight.

**Impact:** Surface area that implies an API contract nothing relies on;
future "cleanup" churn risk.

**Fix:** Drop `hasErrors` from the shim's re-export list (callers already
inline the check). In shared, either delete `hasValidationErrors` and the
result-typed `validateOpenApiSpec` or mark them clearly as the public API and
add a non-test consumer.

---

### [P3] `servers[1..N]` are never validated; a bad second server is silently ignored

**Location:** `packages/shared/src/validate.ts:75-104`.

**Problem:** Only `raw.servers[0]` is type- and URL-checked. A spec like
`{servers: [{url: "https://ok.com"}, {url: "ftp://bad"}, {url: 123}]}` passes
validation cleanly. This is *consistent* with the gateway, which only reads
`servers[0]?.url`, so today there is no runtime defect — but the validator's
silence about malformed trailing entries misleads publishers who expect
OpenAPI validation rather than "only the first server matters".

**Impact:** Misleading validation signal; a spec that would fail a real
OpenAPI validator passes here.

**Fix:** Either validate every entry (reject non-string URLs in any server),
or push a warning when `servers.length > 1` noting only `servers[0]` is used.

---

### [P3] Path-item `$ref` (OpenAPI 3.1) is not handled; operations under it get no cost check

**Location:** `packages/shared/src/validate.ts:115-150` (the
`for (const [method, opVal] of Object.entries(pathVal))` loop skips any key
not in `HTTP_METHODS`, including `$ref`).

**Problem:** OpenAPI 3.1 allows `paths["/x"]: { $ref: "#/components/pathItems/foo" }`.
The validator iterates keys and skips `$ref` (not a method), so a path item
that is purely a `$ref` produces no `x-zevium-cost` warning and no error. The
gateway `parseSpec` also does not resolve path-item `$ref`s, so the operation
ends up with default pricing (`cost: 1`). A publisher using path-item `$ref`
to share an operation across paths publishes with no pricing validation and
default 1-credit charges at runtime.

**Impact:** Incomplete coverage of the OpenAPI 3.1 surface the validator
claims to support (per the `openapi: "3.1.0"` accept-list in the test
fixtures).

**Fix:** Either resolve `$ref` to `components.pathItems` before validating
operations, or push a warning that path-item `$ref` is unsupported.

---

### [P3] `info`, `info.title`, `info.version` are not validated despite being OpenAPI-required

**Location:** `packages/shared/src/validate.ts` — no `raw.info` check at all.

**Problem:** OpenAPI requires `info` with `title` and `version`. The validator
never checks `info`'s presence or shape. `parseSpec` reads them as optional,
and the catalogue embedding (`internal.search.embedProject`) derives text from
`info.title`/`info.version` — a missing title silently degrades search quality
with no boundary signal.

**Impact:** Specs missing required metadata publish silently; catalogue search
quality degraded.

**Fix:** Require `isRecord(raw.info)` with non-empty string `title` and
`version`, else push an error at `$.info`.

---

### [P3] JSON parse error message embedded in the issue is engine-dependent and may include input snippets

**Location:** `packages/shared/src/validate.ts:50-58`.

**Problem:**

```ts
try { raw = JSON.parse(specText) as unknown; }
catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  return [{ level: "error", path: "$", message: `Invalid JSON: ${message}` }];
}
```

The `SyntaxError.message` from `JSON.parse` differs by engine: V8/QuickJS
(Convex) says `Unexpected token } in JSON at position 42`, SpiderMonkey
(browser) says `JSON.parse: unexpected non-whitespace character after JSON
data at line 1 column 5 of the JSON data`, etc. Some engines include a
snippet of the offending input. This message is returned to the client via
`saveDraft`/`publish` `issues`. It is not a server-internals leak (it
describes user input), but it is a non-deterministic, engine-specific string
that makes server-returned issues differ from client-computed ones for the
same input — problematic for `mergeIssues` deduplication in
`spec-workspace.tsx:90-94` (which keys on `message`).

**Impact:** Client/server issue-dedup misses on JSON-parse errors because the
message strings differ by engine; minor position-snippet exposure of user
input.

**Fix:** Synthesize a stable message (e.g. `"Invalid JSON"` plus a fixed
`position` field on `SpecIssue` if needed) instead of forwarding the engine
message verbatim.

---

## Summary

**Counts:** 0 × P0, 0 × P1, 7 × P2, 8 × P3. (15 findings total.)

**Top 3:**

1. **`validateOpenApiSpec` symbol overload (P2).** The shim aliases
   `collectOpenApiSpecIssues` to the name `validateOpenApiSpec`, so the same
   symbol resolves to `SpecIssue[]` inside Convex and `SpecValidationResult`
   everywhere else. Latent cross-boundary contract drift; rename the alias.
2. **Pricing validator/gateway disagreement (P2).** `x-zevium-cost: 0` and
   fractional costs are accepted by the validator and silently rewritten
   (`0 → 1`, floor) by `extractPricing`; `x-zevium-free-tier` is not validated
   at all. The boundary lies about what the gateway will charge.
3. **SSRF + ReDoS at the boundary (P2).** `servers[0].url` accepts
   `http://169.254.169.254` and internal ranges; the semver regex has no
   length cap and quadratic backtracking on crafted `0`-prefixed pre-release
   segments. Both are authenticated DoS/SSRF vectors reachable from the
   publish boundary that this file is supposed to defend.
