# Tiger Review — `packages/shared/src/validate.ts`

## Verdict

**REJECT.** The validator is the single publish-time gate for every OpenAPI
spec in the marketplace, and it is materially broken in five independent ways.
It blesses `x-zevium-cost: 0` as a valid free endpoint while the gateway
(`extractPricing`) silently rewrites it to `1`, never validates
`x-zevium-free-tier` at all, accepts SSRF-enabling upstream URLs with zero
host filtering, performs an unbounded `JSON.parse` with no size/depth guard,
and ships two dead exports that exist only to be re-exported and re-inlined.
The semver regex is the canonical semver.org pattern (not catastrophic) but
operates on an unbounded input string with no length cap. The
`validateOpenApiSpec` / `collectOpenApiSpecIssues` name split across the
Convex boundary is a latent footgun already documented in the sibling review
of `convex/lib/validate.ts`.

## File Stats

- **Path:** `packages/shared/src/validate.ts`
- **Lines:** 192
- **Exports:** `isValidSlug`, `isValidSemver`, `SpecIssue`,
  `SpecValidationResult`, `collectOpenApiSpecIssues`, `validateOpenApiSpec`,
  `hasErrors`, `hasValidationErrors`
- **Consumers:**
  - `packages/shared/src/index.ts` (barrel re-export of all 8 symbols)
  - `packages/shared/src/validate.test.ts` (only caller of the structured
    `validateOpenApiSpec`, `hasErrors`, `hasValidationErrors`)
  - `apps/web/src/components/spec-editor/json-code-editor.tsx` and
    `spec-workspace.tsx` (call `collectOpenApiSpecIssues` directly)
  - `convex/lib/validate.ts` (re-exports `collectOpenApiSpecIssues` ALIASED
    as `validateOpenApiSpec`, plus `hasErrors` — see divergence below)
  - `convex/specs.ts:46,154` and `convex/dev.ts:300` (via the alias)

---

## Findings

### [P0] Spec-vs-gateway pricing divergence: `x-zevium-cost: 0` validates but the gateway charges 1 credit

**Location.** `packages/shared/src/validate.ts:128-148` (the cost branch of
`collectOpenApiSpecIssues`) vs `packages/shared/src/openapi.ts:140-146`
(`extractPricing`).

**Problem.** The validator accepts any cost that is `typeof === "number"`,
`Number.isFinite`, and `>= 0`:

```ts
} else if (
  typeof cost !== "number" ||
  !Number.isFinite(cost) ||
  cost < 0
) {
  issues.push({ level: "error", ... message: "x-zevium-cost must be a number ≥ 0" });
}
```

So `x-zevium-cost: 0` passes with **zero errors and zero warnings**. The web
editor's pricing badge then renders "0 credits", the publisher publishes, and
the gateway calls `extractPricing`:

```ts
// openapi.ts:141
const cost = costRaw !== undefined && costRaw > 0 ? Math.floor(costRaw) : 1;
```

`costRaw > 0` is false for `0`, so `cost` falls through to the default `1`.
Every call to that endpoint then reserves 1 credit from the consumer's wallet
(`pipeline.ts` → `wallet.reserve(reservationId, 1, …)`). The publisher
advertised a free endpoint; the consumer is charged.

**Impact.** Direct revenue/billing integrity violation. A publisher who
intends a free endpoint (a common onboarding pattern — "try our API free")
silently bills every caller one credit per request. The wallet DO will
decline callers with zero balance, breaking the very onboarding the publisher
designed. There is no warning, no error, no log — the divergence is entirely
silent and only discoverable by reading two files in different packages.

**Fix.** Decide one contract and enforce it on both sides. Either:
1. `0` is a valid free endpoint — then `extractPricing` MUST return
   `cost: 0` when `costRaw === 0` (and the wallet/consume path must handle a
   zero-credit reserve as a no-op), **or**
2. `0` is invalid — then the validator must reject it:
   ```ts
   } else if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 1 || !Number.isInteger(cost)) {
     issues.push({ level: "error", ..., message: "x-zevium-cost must be a positive integer ≥ 1" });
   }
   ```
The current state — validator says "≥ 0", gateway says "> 0 else 1" — is the
worst of both worlds.

---

### [P0] `x-zevium-free-tier` is never validated, yet the gateway silently floors / disables it

**Location.** `packages/shared/src/validate.ts:117-155` (the operation loop
checks only `x-zevium-cost`) vs `packages/shared/src/openapi.ts:148-150`
(`extractPricing` free-tier branch).

**Problem.** `extractPricing` reads `x-zevium-free-tier`:

```ts
const freeRaw = asNumber(op["x-zevium-free-tier"]);
const freeTier = freeRaw !== undefined && freeRaw > 0 ? Math.floor(freeRaw) : undefined;
```

This is load-bearing: `freeTier` drives publisher-funded free-call quotas
consumed in the wallet DO (`consumeFreeTier`), surfaces in the catalogue
(`convex/catalogue.ts` `hasFreeTier`), and in the web pricing summary. But
`collectOpenApiSpecIssues` never inspects the field. Concretely, the
following all publish with zero errors and zero warnings:

| `x-zevium-free-tier` value | Validator | Gateway result | Publisher intent → actual |
|---|---|---|---|
| `0` | ✅ | `undefined` (disabled) | "0 free" → tier disabled, probably fine but undocumented |
| `-5` | ✅ | `undefined` (disabled) | intended tier → silently disabled |
| `0.5` | ✅ | `undefined` (0.5 floored via `> 0`? no — `Math.floor(0.5)=0`, then `0 > 0` false → `undefined`) | intended fractional → silently disabled |
| `"100"` (string) | ✅ | `100` (via `asNumber`) | works, but untyped |
| `"1e9"` | ✅ | `1000000000` | near-unlimited publisher-funded quota |
| `NaN` / `Infinity` | ✅ | `undefined` | — |
| `"abc"` | ✅ | `undefined` | intended tier → silently disabled |

The `Math.floor` + `> 0` guard is doing all the validation work that the
validator refuses to do, and it does it **silently** — the publisher's typed
quota is either truncated or dropped with no signal at publish time.

**Impact.** Publisher-funded free-tier quotas are silently wrong in both
directions: a publisher who types `0.5` (thinking "half a credit" or a typo)
gets no free tier at all; a publisher who types `"1e9"` grants a
near-unlimited free tier funded from their own wallet balance, which they
will discover only when their balance drains. Combined with P0 #1, the two
pricing fields the spec is "source of truth" for are both broken contracts
between validator and gateway.

**Fix.** Validate `x-zevium-free-tier` in the same operation loop as
`x-zevium-cost`. Require a positive integer when present:

```ts
const freeTier = opVal["x-zevium-free-tier"];
if (freeTier !== undefined) {
  if (typeof freeTier !== "number" || !Number.isFinite(freeTier)
      || !Number.isInteger(freeTier) || freeTier < 1) {
    issues.push({
      level: "error",
      path: `$.paths["${pathKey}"].${lower}.x-zevium-free-tier`,
      message: "x-zevium-free-tier must be a positive integer ≥ 1",
    });
  }
}
```

Then remove the `Math.floor` from `extractPricing` — the validator becomes
the single source of truth and the gateway stops doing silent normalization.

---

### [P1] SSRF: `servers[0].url` accepts internal IPs, localhost, and cloud metadata endpoints

**Location.** `packages/shared/src/validate.ts:81-112` (the servers branch).

**Problem.** The only URL constraint is `protocol === "http:" || "https:"`:

```ts
let url: URL | null = null;
try { url = new URL(first.url); } catch { url = null; }
if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
  issues.push({ level: "error", ..., message: "servers[0].url must be an http(s) URL" });
}
```

This accepts every one of:
- `http://169.254.169.254/latest/meta-data/` — AWS/GCP/Azure cloud metadata
  (the link-local IMDS endpoint; on the Worker runtime this resolves through
  the gateway's fetch, and on any backend with cloud access it leaks
  instance credentials / IAM tokens)
- `http://localhost:9222/`, `http://127.0.0.1:6379/` — loopback services on
  the gateway host or any intermediate proxy
- `http://10.0.0.1/`, `http://192.168.1.1/`, `http://[::1]/` — RFC1918 /
  ULA / loopback
- `http://169.254.169.254` with any path or port

A publisher is an authenticated org member — that's a low bar for an SSRF
amplifier in a multi-tenant marketplace. The gateway proxies consumer
requests to `servers[0].url` (`joinUpstreamUrl` in `openapi.ts:158-176`), so
a malicious publisher can make every consumer request hit the metadata
endpoint and exfiltrate the response. Even without malicious intent, a
publisher pasting `http://localhost:3000` for testing publishes a spec that
400s/timeout-spins for every consumer.

**Impact.** Server-Side Request Forgery via the gateway data plane. Severity
is amplified because the consumer's wallet is debited for the call that
performs the SSRF — the victim pays the attacker's recon. Cloud metadata
endpoints can return IAM credentials; loopback endpoints can hit internal
admin surfaces.

**Fix.** Add a host allowlist / blocklist check after URL construction. At
minimum block:
- link-local `169.254.0.0/16`
- loopback `127.0.0.0/8`, `::1`
- RFC1918 `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (unless an
  explicit internal-mode flag is set)
- ULA `fc00::/7`
- hostnames that resolve to any of the above (resolve at publish time and
  reject — note this is best-effort against DNS rebinding, so the gateway
  fetch must ALSO pin the resolved IP, not just the publish-time check)

Emit an `error`-level issue at `$.servers[0].url` with a message like
"servers[0].url must resolve to a public IP". Enforce the same check at
gateway fetch time, not just publish time, to defeat rebinding.

---

### [P1] Unbounded `JSON.parse` with no size or depth guard

**Location.** `packages/shared/src/validate.ts:51-60`:

```ts
let raw: unknown;
try {
  raw = JSON.parse(specText) as unknown;
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  return [{ level: "error", path: "$", message: `Invalid JSON: ${message}` }];
}
```

**Problem.** `specText` is `v.string()` at every caller
(`convex/specs.ts:38`, `convex/dev.ts`) with no length cap. The first thing
this function does is `JSON.parse` it — a full in-memory parse of an
attacker-controlled blob. Convex has platform-level arg/doc limits, but
nothing in this layer defends against a ~1MB+ deeply-nested JSON payload
designed to blow up parse time or stack. After parse, the validator
recurses only one level into `paths.{path}.{method}` (so depth isn't the
main concern post-parse), but the parse itself is unguarded.

Two concrete vectors:
1. **Deeply nested JSON** (e.g. `{"a":{"a":{"a":...}}}` 100k deep) — V8's
   `JSON.parse` has a recursion limit and will throw `RangeError: Maximum
   call stack size exceeded`, which IS caught here and returned as an error
   — but the parse attempt itself consumes stack and CPU before failing.
2. **Wide flat JSON** (a `paths` object with 100k keys) — parses fine, then
   the `for (const [pathKey, pathVal] of Object.entries(raw.paths))` loop
   iterates all of them, each pushing a `Missing x-zevium-cost` warning,
   building an unbounded `issues` array returned to the caller and stored
   in the Convex mutation response.

**Impact.** A publisher can submit a spec that consumes disproportionate
CPU/memory during validation, and (because `saveDraft` returns the full
`issues` array) can amplify storage of warnings far beyond the spec size.
Convex's per-function CPU budget will eventually kill the mutation, but
only after wasted compute, and the wide-array path can OOM the function
before the budget triggers.

**Fix.** Add a byte-length guard at the top of
`collectOpenApiSpecIssues` (before `JSON.parse`):

```ts
const MAX_SPEC_BYTES = 256 * 1024;
if (specText.length > MAX_SPEC_BYTES) {
  return [{
    level: "error", path: "$",
    message: `Spec exceeds ${MAX_SPEC_BYTES} byte limit`,
  }];
}
```

And cap the `paths` iteration: `Object.entries(raw.paths).slice(0, MAX_PATHS)`
with a warning when truncated, and cap the `issues` array length. The
byte-length guard belongs in `saveDraft`/`publish` too (per
`convex/specs.ts` review) but adding it here makes the shared function
self-defending for its web callers (`spec-editor` calls
`collectOpenApiSpecIssues` on every keystroke via the linter — a giant
paste in the editor would otherwise freeze the tab).

---

### [P2] `validateOpenApiSpec` (structured form) is dead and its name collides with a Convex alias of a different return type

**Location.** `packages/shared/src/validate.ts:177-183` and
`packages/shared/src/index.ts:33`.

**Problem.** The real `validateOpenApiSpec`:

```ts
export function validateOpenApiSpec(specText: string): SpecValidationResult {
  const issues = collectOpenApiSpecIssues(specText);
  return {
    errors: issues.filter((i) => i.level === "error"),
    warnings: issues.filter((i) => i.level === "warning"),
  };
}
```

has **zero external importers**. Its only caller is its own unit test
(`validate.test.ts:53,62,73,88,100,116,133`). Every production caller —
`convex/specs.ts:46,154`, `convex/dev.ts:300`, the web spec-editor — calls
`collectOpenApiSpecIssues` (directly, or aliased as `validateOpenApiSpec`
through `convex/lib/validate.ts:10`).

So the symbol `validateOpenApiSpec` resolves to two different return shapes
depending on import path:

| Importer | `validateOpenApiSpec(x)` returns |
|---|---|
| `convex/specs.ts`, `convex/dev.ts` (via `./lib/validate` shim) | `SpecIssue[]` |
| `@zevium/shared` direct, `validate.test.ts` | `SpecValidationResult` |

A maintainer who reasonably switches a Convex import from `"./lib/validate"`
to `"@zevium/shared"` (expecting the "real" source) gets a type error at
best; after a refactor that swaps the alias back, silent semantic drift
between client and server validation results at worst. The header comment
on `convex/lib/validate.ts:2-4` even calls `validateOpenApiSpec` the
result-typed function while the export aliases the array-typed one — the
confusion is documented in the comment that causes it.

**Impact.** Latent cross-boundary contract footgun. No test covers the
Convex-side return shape (the shim has no tests); the shared tests assert
the *other* return shape. A one-line import-path change silently flips
server-side validation semantics.

**Fix.** Pick one public API. Since every real consumer wants the raw
`SpecIssue[]` (the web linter iterates issues in discovery order; the
convex callers `issues.some(...)`), remove `validateOpenApiSpec` (and
`hasValidationErrors`, which only exists to serve it) from both
`validate.ts` and `index.ts`. Keep `collectOpenApiSpecIssues` as the sole
entry point and delete the alias in `convex/lib/validate.ts` — re-export
`collectOpenApiSpecIssues` under its real name and update
`convex/specs.ts` / `convex/dev.ts` call sites. If the structured form is
genuinely wanted, keep it but rename it (e.g. `validateOpenApiSpecStructured`)
so the names stop colliding.

---

### [P2] `extractPricing` floors fractional `x-zevium-cost` silently — `1.9` charges 1, `0.5` charges 0 (→ see P0 #1)

**Location.** `packages/shared/src/openapi.ts:141`:

```ts
const cost = costRaw !== undefined && costRaw > 0 ? Math.floor(costRaw) : 1;
```

**Problem.** The validator accepts any finite number `>= 0`, including
non-integers (`1.9`, `0.5`, `100.7`). The gateway silently `Math.floor`s
them. `x-zevium-cost: 1.9` → charges `1` (publisher loses 0.9 credits/call
of intended revenue). `x-zevium-cost: 0.5` → `Math.floor(0.5) === 0`, then
`0 > 0` is false → falls to default `1` (consumer overcharged relative to
the "0.5" the publisher typed, and the publisher's "round down to 0" intent
is ignored). `x-zevium-cost: 100.7` → charges `100`.

There is no validator rule requiring integer costs, so the floor is doing
silent type-coercion on values the validator blessed.

**Impact.** Silent revenue divergence between published intent and billed
reality. A publisher who sets a fractional cost (typo, or coming from a
system that thinks in fractional credits) has their pricing silently
truncated with no publish-time signal.

**Fix.** In `collectOpenApiSpecIssues`, require
`Number.isInteger(cost) && cost >= 1` (or `>= 0` per P0 #1's resolution)
and emit an error for non-integer costs. Then drop the `Math.floor` from
`extractPricing` — the validator becomes the sole authority and the gateway
stops coercing.

---

### [P2] `asNumber` accepts string-form numbers including `"1e9"`, `"0x10"`, scientific notation for `x-zevium-cost` / `x-zevium-free-tier`

**Location.** `packages/shared/src/openapi.ts:46-53`:

```ts
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
```

**Problem.** `Number("1e9")` → `1000000000`; `Number("0x10")` → `16`;
`Number("  5  ")` → `5`. The validator's `typeof cost !== "number"` check
rejects string costs as errors (`validate.ts:128`), but `extractPricing`
goes through `asNumber`, which happily parses strings. So the validator and
the gateway disagree on the type contract for cost: validator says "must be
a JSON number", gateway accepts "any string `Number()` can parse".

A spec with `x-zevium-cost: "1e9"` would FAIL validation (string), but a
spec that somehow reaches the gateway with a string cost (e.g. via a
hand-crafted published spec, or if a future change relaxes the validator)
would silently bill 1 billion credits per call.

**Impact.** Type contract divergence between validator and gateway. The
validator's strictness is the only thing preventing string-form costs from
reaching `asNumber`, and that strictness is not load-bearing in
`extractPricing` — `asNumber` will accept strings the moment they slip past.

**Fix.** Either tighten `asNumber` to reject strings (return `undefined`
unless `typeof value === "number"`), or loosen the validator to accept
string-form numbers consistently with the gateway. The former is safer —
pricing should be a JSON number, full stop.

---

### [P2] `asNumber` + `extractPricing` accept `NaN`/`Infinity`-producing inputs inconsistently

**Location.** `packages/shared/src/openapi.ts:46-53` and `validate.ts:128-138`.

**Problem.** The validator uses `Number.isFinite(cost)` to reject `NaN` /
`Infinity`. `asNumber` also guards with `Number.isFinite(n)`. But the two
checks operate on different value spaces: the validator checks the raw JSON
value, `asNumber` checks the post-`Number()` value. For a JSON `number`,
both agree. For a JSON `string`, the validator rejects before `asNumber`
runs — but only at publish time. If a string cost reaches `extractPricing`
(by bypassing publish validation, or via a spec version published before
validation existed), `asNumber` will parse `"Infinity"` → `Number("Infinity")`
→ `Infinity` → `Number.isFinite(Infinity)` false → `undefined` → cost falls
to default `1`. Silent.

**Impact.** Defense-in-depth gap. The validator is the only guard, and the
gateway's parser is permissive in ways the validator doesn't mirror.

**Fix.** Make `extractPricing` reject (or explicitly default with a logged
warning) any cost that isn't a finite integer, rather than silently
flooring/defaulting. The gateway should not be doing normalization work
that masks invalid specs.

---

### [P3] `hasErrors` / `hasValidationErrors` are dead trivial wrappers re-exported but never called

**Location.** `packages/shared/src/validate.ts:185-191` and
`packages/shared/src/index.ts:34-35`.

**Problem.**

```ts
export function hasErrors(issues: SpecIssue[]): boolean {
  return issues.some((i) => i.level === "error");
}
export function hasValidationErrors(result: SpecValidationResult): boolean {
  return result.errors.length > 0;
}
```

`hasValidationErrors` has zero external importers — only
`validate.test.ts:58,136` calls it, and only because the test exercises the
`validateOpenApiSpec` structured form (which is itself dead — see P2 above).
`hasErrors` is re-exported through `convex/lib/validate.ts:8` but never
invoked: `convex/dev.ts:301` and `convex/specs.ts:155` inline
`issues.some((i) => i.level === "error")` themselves. The web spec-editor
(`spec-workspace.tsx:158`, `:278`) also inlines `issues.some(...)`.

So both helpers exist, are exported through two barrels, and every real
caller reinlines the one-liner they wrap.

**Impact.** Dead code in the public surface, and a misleading API surface
(`hasValidationErrors` suggests the structured form is the primary API,
which it isn't). `hasErrors` being re-exported by Convex and then never
called is doubly dead.

**Fix.** Remove both from `validate.ts` and `index.ts`. If a helper is
wanted, collapse to one (`hasErrors(issues)`) and actually use it at the
call sites instead of re-inlining. Update `validate.test.ts` to drop the
structured-form tests (or keep them if you keep `validateOpenApiSpec`).

---

### [P3] SLUG_RE / SEMVER_RE: semver is the canonical safe pattern but operates on unbounded input

**Location.** `packages/shared/src/validate.ts:5-9`.

```ts
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
```

**Problem.** This is the canonical semver.org regex (also shipped by the
`semver` package's `valid()`). It is **not** catastrophically backtracking —
the alternation `0|[1-9]\d*|\d*[a-zA-Z-]...` does have overlap on pure-digit
segments (e.g. `00`), but each segment is bounded and the repetition
`(?:\.(?:...))*` is linear per segment. Manual analysis of the worst case
(`1.2.3-` followed by N segments of `00`) shows linear-in-N backtracking per
segment, not exponential. So no ReDoS.

However: `isValidSemver(version)` is called from `convex/specs.ts:97` on
`args.version` (`v.string()`, unbounded). A pathologically long version
string (e.g. 1MB of `0.0.0-0.0...0`) does linear regex work — not
catastrophic, but unbounded. The version field has no length cap anywhere.

**Impact.** Low. No ReDoS, but no input bound either. The risk is
CPU-amplification via a huge version string at publish time, bounded by
Convex's function CPU budget.

**Fix.** Add `version.length > 256` guard in `isValidSemver` (or in the
caller) before running the regex. Semver versions longer than 256 chars are
not legitimate. Optional given Convex budgets, but cheap defense.

---

### [P3] `collectOpenApiSpecIssues` does not validate `openapi` version range, only presence

**Location.** `packages/shared/src/validate.ts:65-70`.

**Problem.** The check is:

```ts
if (typeof raw.openapi !== "string" || raw.openapi.trim() === "") {
  issues.push({ level: "error", ..., message: "Missing openapi field (expected OpenAPI 3.x version string)" });
}
```

The message says "expected OpenAPI 3.x version string" but the code accepts
any non-empty string. `openapi: "2.0"`, `openapi: "banana"`,
`openapi: "4.0.0"` all pass. The gateway's `parseSpec`
(`openapi.ts:64`) also just stores the string verbatim without acting on
it, so a Swagger 2.0 spec (which has a different `paths`/`basePath`/
`host` shape than OpenAPI 3.x) would pass validation and then mis-parse at
the gateway: `servers` doesn't exist in Swagger 2.0 (it uses `host` +
`basePath`), so the validator's `servers[0].url` check would fail — but a
spec that omits both `servers` and `host` and puts a `servers` array with a
valid-looking URL alongside Swagger 2.0 semantics would pass.

**Impact.** Low. Most publishers paste OpenAPI 3.x. But the
message-vs-code mismatch is misleading, and Swagger 2.0 specs would
silently misroute at the gateway.

**Fix.** Either validate the version (`/^3\.\d+\.\d+$/`) and update the
message to match, or change the message to "Missing openapi field" without
the "3.x" claim.

---

### [P3] `isRecord` defined in both `validate.ts` and `openapi.ts` — duplicated helper

**Location.** `packages/shared/src/validate.ts:31-33` and
`packages/shared/src/openapi.ts:40-42`.

**Problem.** Identical function in two files of the same package:

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

**Impact.** Trivial duplication; future divergence risk is near-zero but
it's the kind of thing a shared internal util file should hold.

**Fix.** Move to a shared internal `utils.ts` (or `internal.ts`) and import
from both. Minor.

---

## Summary

- **Findings:** 12 (P0: 2, P1: 2, P2: 4, P3: 4)
- **Top 3:**
  1. **[P0]** `x-zevium-cost: 0` validates as free but the gateway charges
     1 credit per call — silent billing of "free" endpoints (validator ↔
     `extractPricing` contract divergence).
  2. **[P0]** `x-zevium-free-tier` is never validated; the gateway silently
     floors (`0.5` → disabled) or accepts unbounded (`"1e9"` → 1B free
     calls) values for a publisher-funded quota.
  3. **[P1]** SSRF: `servers[0].url` accepts `http://169.254.169.254`,
     `localhost`, RFC1918 — a publisher can route every consumer request
     through the gateway to cloud metadata / internal services, and the
     consumer is billed for the SSRF call.

**Theme.** This file is the marketplace's pricing and routing gate, and the
gateway (`openapi.ts`) silently re-normalizes every value this validator
blesses. The two halves were clearly written separately and never
reconciled: cost `≥ 0` vs `> 0`, fractional floors, string-form numbers,
missing free-tier validation. Fix the contract once, enforce it in the
validator, and strip the silent normalizers from `extractPricing`. The
SSRF and unbounded-parse issues are independent and urgent regardless.
