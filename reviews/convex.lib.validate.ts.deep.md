# Tiger Deep Review — `convex/lib/validate.ts` + `packages/shared/src/validate.ts` (boundary validation)

## Verdict

**REJECT.** This is the marketplace's single publish-time gate for every
OpenAPI spec — pricing, routing, and upstream target are all blessed here
before a spec version is frozen into the immutable `specVersions` table and
fetched by the gateway data plane on every consumer call. The gate is
materially broken in five independent ways that are each provable from the
source:

1. **Billing integrity violation.** `x-zevium-cost: 0` passes validation
   with zero errors and zero warnings, but the gateway's `extractPricing`
   silently rewrites `0 → 1` — a publisher who advertises a free endpoint
   bills every consumer one credit per call.
2. **Publisher-funded quota is unvalidated.** `x-zevium-free-tier` is never
   inspected; the gateway silently floors (`0.5 → disabled`) or accepts
   unbounded (`"1e9"` → 1 billion free calls/day, publisher-funded) values.
3. **SSRF.** `servers[0].url` accepts `http://169.254.169.254/`,
   `http://localhost`, RFC1918 ranges — the only filter is `protocol ===
   http(s)`. The gateway fetches consumer requests to this URL with zero
   IP pinning; the consumer is debited for the SSRF probe.
4. **No input bounds.** `JSON.parse` runs on an unbounded `v.string()` with
   no byte cap; `paths` iteration is unbounded; the semver regex has no
   length cap and exhibits quadratic backtracking on crafted pre-release
   segments.
5. **Symbol collision.** `validateOpenApiSpec` resolves to two different
   return types across the Convex/`@zevium/shared` boundary (`SpecIssue[]`
   inside Convex via the shim alias, `SpecValidationResult` everywhere else).

The validator and the gateway (`openapi.ts`) were written separately and
never reconciled: `≥ 0` vs `> 0`, fractional floors, string-form numbers,
missing free-tier checks. The two halves disagree on every pricing field.

## File Stats

- **Files under review:**
  - `convex/lib/validate.ts` — 11-line re-export shim.
  - `packages/shared/src/validate.ts` — 192 lines, backing implementation.
- **Cross-referenced (read fully):**
  - `packages/shared/src/openapi.ts` — 173 lines, gateway spec parser +
    `extractPricing` / `matchOperation` / `joinUpstreamUrl` (the divergent
    consumer of every value this validator blesses).
  - `convex/specs.ts` — 388 lines, `saveDraft` / `publish` / `deprecateVersion`
    callers of `validateOpenApiSpec` + `isValidSemver`.
  - `convex/projects.ts` — 173 lines, `isValidSlug` caller.
  - `apps/gateway/src/pipeline.ts` — confirmed `fetchImpl(upstreamUrl, init)`
    with `redirect: "manual"` and **no IP blocklist** (the validator is the
    sole SSRF defense).
  - `apps/gateway/src/wallet.ts` — confirmed `consumeFreeTier(keyId, limit)`
    accepts any finite `limit > 0` including `1e9`.
- **Exports surfaced to Convex (via shim):** `isValidSlug`, `isValidSemver`,
  `hasErrors`, `type SpecIssue`, `collectOpenApiSpecIssues as validateOpenApiSpec`.
- **Exports NOT surfaced:** real `validateOpenApiSpec` (returns
  `SpecValidationResult`), `hasValidationErrors`, `SpecValidationResult`,
  `collectOpenApiSpecIssues` (under its own name).
- **Convex callers:** `convex/projects.ts` (`isValidSlug`),
  `convex/specs.ts` (`isValidSemver`, `SpecIssue`, `validateOpenApiSpec`),
  `convex/dev.ts` (`validateOpenApiSpec`).
- **Web/gateway callers** import directly from `@zevium/shared`, bypassing
  the shim.

---

## Findings

### [P0] `x-zevium-cost: 0` validates as a free endpoint but the gateway charges 1 credit per call

**Location.** `packages/shared/src/validate.ts:128-148` (validator cost
branch) vs `packages/shared/src/openapi.ts:141` (`extractPricing`).

**Problem.** The validator accepts any cost that is `typeof === "number"`,
`Number.isFinite`, and `>= 0`:

```ts
} else if (
  typeof cost !== "number" ||
  !Number.isFinite(cost) ||
  cost < 0
) {
  issues.push({ level: "error", path: ..., message: "x-zevium-cost must be a number ≥ 0" });
}
```

So `x-zevium-cost: 0` passes with **zero errors and zero warnings**. The web
editor's pricing badge renders "0 credits", the publisher publishes, and the
gateway calls `extractPricing`:

```ts
// openapi.ts:141
const cost = costRaw !== undefined && costRaw > 0 ? Math.floor(costRaw) : 1;
```

`costRaw > 0` is false for `0`, so `cost` falls through to the default `1`.
`pipeline.ts:165` then calls `wallet.reserve(reservationId, cost, ...)` with
`cost = 1`. Every call to that endpoint reserves 1 credit from the
consumer's wallet. The publisher advertised a free endpoint; the consumer is
charged.

**Verified divergence table:**

| `x-zevium-cost` in published spec | Validator | Gateway charges (`extractPricing`) |
|---|---|---|
| `0` (free intent) | ✅ valid, zero issues | **1 credit** |
| `1.5` | ✅ valid | 1 credit (`Math.floor(1.5)`) |
| `0.5` | ✅ valid | 1 credit (`Math.floor(0.5)=0` → `0 > 0` false → default `1`) |
| `100` | ✅ valid | 100 credits ✓ |
| `-1` | ❌ error | (unreachable) |

**Impact.** Direct revenue/billing integrity violation. A publisher who
intends a free endpoint (a common onboarding pattern — "try our API free")
silently bills every caller one credit per request. The wallet DO will
decline callers with zero balance, breaking the very onboarding the
publisher designed. No warning, no error, no log — the divergence is
entirely silent and only discoverable by reading two files in different
packages.

**Fix.** Decide one contract and enforce it on both sides. Either:
1. `0` is a valid free endpoint — then `extractPricing` MUST return
   `cost: 0` when `costRaw === 0` (and `wallet.reserve` / `pipeline.ts`
   must treat a 0-credit reserve as a no-op), **or**
2. `0` is invalid — then the validator must reject it:
   ```ts
   } else if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 1 || !Number.isInteger(cost)) {
     issues.push({ level: "error", ..., message: "x-zevium-cost must be a positive integer ≥ 1" });
   }
   ```
The current state — validator says "≥ 0", gateway says "> 0 else 1" — is the
worst of both worlds.

---

### [P0] `x-zevium-free-tier` is never validated; the gateway silently floors, disables, or accepts unbounded values

**Location.** `packages/shared/src/validate.ts:113-150` (operation loop
checks only `x-zevium-cost`) vs `packages/shared/src/openapi.ts:149-152`
(`extractPricing` free-tier branch) vs `apps/gateway/src/wallet.ts:589-592`
(`consumeFreeTier` limit check).

**Problem.** `extractPricing` reads `x-zevium-free-tier`:

```ts
const freeRaw = asNumber(op["x-zevium-free-tier"]);
const freeTier = freeRaw !== undefined && freeRaw > 0 ? Math.floor(freeRaw) : undefined;
```

This is load-bearing: `freeTier` drives publisher-funded free-call quotas
consumed in the wallet DO (`pipeline.ts:134` →
`wallet.consumeFreeTier(verified.keyId, freeTier, ...)`), surfaces in the
catalogue (`hasFreeTier` badge), and in the web pricing summary. But
`collectOpenApiSpecIssues` never inspects the field. Verified divergence:

| `x-zevium-free-tier` value | Validator | `extractPricing` result | Wallet behavior |
|---|---|---|---|
| `0` | ✅ no issue | `undefined` (disabled) | tier disabled |
| `-5` (typo) | ✅ no issue | `undefined` (disabled) | intended tier silently disabled |
| `0.5` | ✅ no issue | `undefined` (`Math.floor(0.5)=0` → `0 > 0` false) | silently disabled |
| `1.5` | ✅ no issue | `1` (`Math.floor`) | truncated |
| `"100"` (string) | ✅ no issue | `100` (via `asNumber` → `Number("100")`) | works, untyped |
| `"1e9"` (string) | ✅ no issue | `1000000000` | **1 billion free calls/day, publisher-funded** |
| `NaN` / `Infinity` | ✅ no issue | `undefined` | disabled |
| `"abc"` | ✅ no issue | `undefined` | disabled |

`consumeFreeTier` (`wallet.ts:589-592`) only checks `limit > 0` and
`Number.isFinite(limit)` — so `1e9` passes and grants a near-unlimited
publisher-funded quota.

**Impact.** Publisher-funded free-tier quotas are silently wrong in both
directions: a publisher who types `0.5` (thinking "half a credit" or a typo)
gets no free tier at all; a publisher who types `"1e9"` grants a
near-unlimited free tier funded from their own wallet balance, discovered
only when their balance drains. Combined with P0 #1, the two pricing fields
the spec is "source of truth" for are both broken contracts between validator
and gateway.

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

Then drop `Math.floor` from `extractPricing` — the validator becomes the sole
authority and the gateway stops doing silent normalization.

---

### [P1] SSRF: `servers[0].url` accepts internal IPs, localhost, and cloud metadata endpoints — the sole defense, with no gateway-side IP pinning

**Location.** `packages/shared/src/validate.ts:84-104` (URL protocol check)
vs `apps/gateway/src/pipeline.ts:234-245` (gateway fetch with
`redirect: "manual"` only, no IP blocklist).

**Problem.** The only URL constraint enforced by the validator is the scheme:

```ts
let url: URL | null = null;
try { url = new URL(first.url); } catch { url = null; }
if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
  issues.push({ level: "error", path: "$.servers[0].url", message: "servers[0].url must be an http(s) URL" });
}
```

This accepts every one of:
- `http://169.254.169.254/latest/meta-data/` — AWS/GCP/Azure cloud metadata
  (IMDS — leaks IAM credentials on any runtime with cloud access)
- `http://localhost:9222/`, `http://127.0.0.1:6379/` — loopback services on
  the gateway host or any intermediate proxy
- `http://10.0.0.1/`, `http://192.168.1.1/`, `http://[::1]/` — RFC1918 / ULA /
  loopback
- `http://169.254.169.254` with any path or port

The gateway fetches this URL on every consumer request
(`pipeline.ts:234-245`):

```ts
const upstreamUrl = new URL(joinUpstreamUrl(matched.upstreamBaseUrl, route.remainderPath));
// ...
const init: RequestInit & { duplex?: "half" } = {
  method: request.method,
  headers: upstreamHeaders,
  redirect: "manual",  // <-- the ONLY SSRF mitigation; no IP filtering
};
upstreamRes = await fetchImpl(upstreamUrl.toString(), init);
```

`redirect: "manual"` blocks redirect-based SSRF, but there is **no IP
pinning, no blocklist, no allowlist** at fetch time. The validator is the
sole line of defense, and it only checks the scheme.

**Caveat (verified).** The gateway runs on Cloudflare Workers, whose `fetch`
egresses through Cloudflare's network — the `169.254.169.254` metadata vector
is less directly exploitable than on a traditional EC2/GCE runtime. But:
loopback and RFC1918 targets may still reach internal Cloudflare services
or Worker bindings, and if the gateway runtime ever changes (or a
self-hosted gateway is added), every published spec with an internal URL
becomes immediately exploitable. The consumer's wallet is debited for the
SSRF call — the victim pays the attacker's recon.

**Impact.** Server-Side Request Forgery via the gateway data plane,
reachable by any authenticated org member (the publish auth bar). The victim
(consumer) is billed for the probe.

**Fix.** Add a host blocklist at the validator after URL construction:

```ts
const host = url.hostname.toLowerCase();
const blocked = isPrivateHost(host); // rejects 127.0.0.0/8, 10/8, 172.16/12,
// 192.168/16, 169.254/16, ::1, fc00::/7, "localhost", "*.local"
if (blocked) {
  issues.push({ level: "error", path: "$.servers[0].url",
    message: "servers[0].url must resolve to a public IP" });
}
```

Resolve the hostname at publish time and reject private resolutions. **Also**
enforce the same check at gateway fetch time (pin the resolved IP) to defeat
DNS rebinding — the publish-time check alone is not sufficient.

---

### [P1] Unbounded `JSON.parse` + unbounded `paths` iteration on every save/publish/keystroke

**Location.** `packages/shared/src/validate.ts:49-55` (`JSON.parse` with no
length guard), `:107-150` (unbounded `Object.entries(raw.paths)` + nested
`Object.entries(pathVal)`); Convex callers `convex/specs.ts:38` (`args.spec:
v.string()`, no max) and `convex/specs.ts:96` (`version: v.string()`, no max).

**Problem.** `collectOpenApiSpecIssues` immediately `JSON.parse`s the full
input, then walks every path × every operation. There is no bound on:

- `specText.length` — only Convex platform arg/doc limits (~1 MB) cap it
  server-side; the validator itself enforces nothing.
- `Object.keys(raw.paths).length` — a spec with 100 000 paths is iterated
  fully on every call, each pushing a `Missing x-zevium-cost` warning.
- `Object.keys(pathVal).length` — same per path item.
- The returned `issues` array length — 100k paths × 1 warning each = 100k
  issue objects returned in the `saveDraft` / `publish` mutation response
  (`convex/specs.ts:54` returns `issues: SpecIssue[]` to the client).

Two concrete vectors:
1. **Deeply nested JSON** (`{"a":{"a":{"a":...}}}` 100k deep) — V8's
   `JSON.parse` throws `RangeError: Maximum call stack size exceeded`, which
   IS caught and returned as an error — but the parse attempt consumes stack
   and CPU before failing.
2. **Wide flat JSON** (100k `paths` keys) — parses fine, then the loop
   iterates all of them, building an unbounded `issues` array returned to
   the client and stored in the mutation response.

The web spec-editor (`spec-workspace.tsx:155`) calls
`collectOpenApiSpecIssues(text)` on every 300ms-debounced keystroke — a
large paste freezes the tab.

**Impact.** Authenticated CPU/memory DoS at the Convex boundary + client-side
editor freeze + response-size amplification (100k warnings in a mutation
return). Convex's per-function CPU budget eventually kills the mutation, but
only after wasted compute, and the wide-array path can OOM the function
before the budget triggers.

**Fix.** Add a byte-length guard at the top of
`collectOpenApiSpecIssues` (before `JSON.parse`):

```ts
const MAX_SPEC_BYTES = 256 * 1024;
if (specText.length > MAX_SPEC_BYTES) {
  return [{ level: "error", path: "$",
    message: `Spec exceeds ${MAX_SPEC_BYTES} byte limit` }];
}
```

Cap the `paths` iteration: `Object.entries(raw.paths).slice(0, MAX_PATHS)`
with a warning when truncated. Cap the `issues` array length. Mirror the
byte cap in `convex/specs.ts` `saveDraft` / `publish` before calling
`validateOpenApiSpec`.

---

### [P1] `parseSpec` (gateway) performs zero URL validation — defense-in-depth gap; the validator is the only defense and it runs at publish time only

**Location.** `packages/shared/src/openapi.ts:64-76` (`parseSpec` servers
branch) vs `packages/shared/src/validate.ts:84-104` (validator URL check).

**Problem.** The gateway's `parseSpec` accepts any `servers` entry where
`s.url` is a non-empty string:

```ts
if (Array.isArray(raw.servers)) {
  for (const s of raw.servers) {
    if (isRecord(s) && typeof s.url === "string" && s.url.length > 0) {
      servers.push({ url: s.url });
    }
  }
}
```

No scheme check, no host check, no `new URL()` parse attempt. The validator
does check the scheme, but only at publish time (`convex/specs.ts:155`). A
spec that reaches the gateway through any path that bypasses publish
validation — a pre-existing `specVersions` row published before validation
existed, a direct DB write, or a future code path that skips the validator —
is fetched with an unvalidated URL.

Concretely, `joinUpstreamUrl` (`openapi.ts:163-176`) does:

```ts
const u = new URL(base.includes("://") ? base : `https://${base}`);
```

A `servers[0].url` of `//attacker.com` (protocol-relative) is rejected by the
validator (`new URL("//attacker.com")` throws without a base URL), but
`parseSpec` accepts it (`typeof === "string" && length > 0`), and
`joinUpstreamUrl` turns it into `https:////attacker.com` → host
`attacker.com`. A spec that bypasses the validator thus reaches
`fetchImpl` with an attacker-controlled host.

**Impact.** Defense-in-depth gap. The validator is the sole URL defense and
it is bypassable by any non-`publish` code path that writes to
`specVersions`. The gateway trusts the URL verbatim.

**Fix.** `parseSpec` must validate the URL scheme and reject private hosts
itself, independent of the publish-time validator. The gateway should never
`fetch` a URL that hasn't passed both checks. At minimum, add the same
`scheme === http(s)` + private-host blocklist in `parseSpec` (or in
`matchOperation` before returning `upstreamBaseUrl`).

---

### [P2] `validateOpenApiSpec` symbol is overloaded across the module boundary with two incompatible return-type contracts

**Location.** `convex/lib/validate.ts:6-11` (the shim) vs
`packages/shared/src/validate.ts:177-183` (the real `validateOpenApiSpec`).

**Problem.** The shim does:

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

TypeScript saves the Convex side from runtime breakage *only because* the
alias points at the `SpecIssue[]` function and callers use `.some(i =>
i.level === "error")`. But the contract is latent-confusion: a developer
who copies the documented `validateOpenApiSpec` → `{ errors, warnings }`
shape from `packages/shared` into a Convex function gets a type error at
best, and at worst (after a refactor that swaps the alias back) silent
semantic drift between client and server validation results. The header
comment on `convex/lib/validate.ts:2-4` even calls `validateOpenApiSpec`
the result-typed function while the export aliases the array-typed one — the
confusion is documented in the comment that causes it.

**Verified callers (all use the array form):**
- `convex/specs.ts:46` — `const issues = validateOpenApiSpec(args.spec);` then
  `issues.some((i) => i.level === "error")`.
- `convex/specs.ts:154` — same pattern.
- `convex/dev.ts:300` — `const issues = validateOpenApiSpec(specJson);` then
  `issues.some(...)`.

No Convex caller uses the structured `{ errors, warnings }` form. The shim
does not even re-export `SpecValidationResult`, so the structured form is
unreachable from Convex.

**Impact.** Boundary-validation contract is ambiguous; high risk of a future
change flipping server-side validation semantics without any test catching
it (the Convex side has no tests for `validateOpenApiSpec`'s return shape;
the shared tests assert the *other* return shape).

**Fix.** Stop aliasing. Re-export both functions under their real names and
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

Then `s/validateOpenApiSpec/collectOpenApiSpecIssues/` in `convex/specs.ts`
and `convex/dev.ts` (they already consume `SpecIssue[]`).

---

### [P2] Fractional `x-zevium-cost` accepted by validator, silently floored by gateway — `1.9 → 1`, `0.5 → 1`

**Location.** `packages/shared/src/validate.ts:128-148` (validator accepts
non-integers) vs `packages/shared/src/openapi.ts:141` (`Math.floor`).

**Problem.** The validator accepts any finite `number >= 0`, including
non-integers. The gateway silently `Math.floor`s them:

```ts
const cost = costRaw !== undefined && costRaw > 0 ? Math.floor(costRaw) : 1;
```

- `x-zevium-cost: 1.9` → charges `1` (publisher loses 0.9 credits/call of
  intended revenue).
- `x-zevium-cost: 0.5` → `Math.floor(0.5) === 0` → `0 > 0` false → default
  `1` (consumer overcharged relative to the "0.5" the publisher typed).
- `x-zevium-cost: 100.7` → charges `100`.

There is no validator rule requiring integer costs, so the floor is doing
silent type-coercion on values the validator blessed.

**Impact.** Silent revenue divergence between published intent and billed
reality. A publisher who sets a fractional cost (typo, or coming from a
system that thinks in fractional credits) has their pricing silently
truncated with no publish-time signal.

**Fix.** In `collectOpenApiSpecIssues`, require `Number.isInteger(cost)`
(plus `cost >= 1` per P0 #1's resolution) and emit an error for non-integer
costs. Then drop the `Math.floor` from `extractPricing` — the validator
becomes the sole authority and the gateway stops coercing.

---

### [P2] `asNumber` accepts string-form numbers (`"1e9"`, `"0x10"`) in `extractPricing` — type contract divergence with validator

**Location.** `packages/shared/src/openapi.ts:46-53` (`asNumber`) vs
`packages/shared/src/validate.ts:128-138` (validator `typeof cost !== "number"`).

**Problem.**

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

`Number("1e9")` → `1000000000`; `Number("0x10")` → `16`;
`Number("  5  ")` → `5`. The validator's `typeof cost !== "number"` check
rejects string costs as errors, but `extractPricing` goes through `asNumber`,
which happily parses strings. So the validator and the gateway disagree on
the type contract for cost:

| `x-zevium-cost` value | Validator | `extractPricing` via `asNumber` |
|---|---|---|
| `1` (number) | ✅ | `1` ✓ |
| `"1"` (string) | ❌ error | `1` (would bill 1 if it reached gateway) |
| `"1e9"` (string) | ❌ error | `1000000000` (would bill 1B) |
| `"0x10"` (string) | ❌ error | `16` |

A spec with `x-zevium-cost: "1e9"` FAILS validation (string), but a spec
that somehow reaches the gateway with a string cost (via a hand-crafted
published spec, a pre-validation version, or a future change that relaxes
the validator) would silently bill 1 billion credits per call.

**Impact.** Type contract divergence between validator and gateway. The
validator's strictness is the only thing preventing string-form costs from
reaching `asNumber`, and that strictness is not load-bearing in
`extractPricing` — `asNumber` will accept strings the moment they slip past.

**Fix.** Tighten `asNumber` to reject strings (return `undefined` unless
`typeof value === "number"`). Pricing should be a JSON number, full stop.
The gateway should not be doing type coercion that masks invalid specs.

---

### [P2] `SEMVER_RE` has no length bound and exhibits quadratic backtracking on crafted `0`-prefixed pre-release segments

**Location.** `packages/shared/src/validate.ts:6-7` (regex), `:15-17`
(`isValidSemver`), called from `convex/specs.ts:97` on `args.version.trim()`
where `version: v.string()` (no max).

**Problem.** Two distinct issues compound:

1. **No length bound.** `isValidSemver` returns `true` for a megabyte-long
   valid semver string (`1.0.0-` + `a.`.repeat(50000) + `a`). The Convex
   `specVersions.version` field is `v.string()` with no cap; this gets stored
   and indexed (`by_project_version` index includes `version`).

2. **Quadratic backtracking (verified, NOT catastrophic-exponential).** The
   pre-release alternation
   `(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)` evaluates branches
   left-to-right. For a segment of N zeros followed by no letter:
   - Branch 1 (`0`) matches the first `0`, but the outer repetition
     `(?:\.(?:...))*` then needs a `.` — if the next char is `0` (not `.`),
     the segment match fails at branch 1.
   - Branch 2 (`[1-9]\d*`) fails (first char is `0`).
   - Branch 3 (`\d*[a-zA-Z-]...`) greedily consumes all N digits, then
     backtracks one char at a time looking for a letter that never comes —
     O(N) work per segment.

   With M segments of N zeros, total work is O(N·M). A crafted `version`
   like `1.0.0-` + (`0` + `9`.repeat(4000) + `.`).repeat(400) + `!` is
   rejected but only after ~10⁷ regex steps.

   **Honest assessment:** this is NOT exponential/catastrophic ReDoS (there
   are no overlapping nested quantifiers like `(a+)+`). It is quadratic CPU
   amplification on crafted input. Still a DoS vector at the authenticated
   publish boundary.

**Impact.** Authenticated quadratic-CPU DoS at the publish boundary; stored
megabyte-length version strings polluting the version index. Convex's
function CPU budget will eventually kill the function, but a ~1MB version
string consumes disproportionate compute before that.

**Fix.** Bound the input first: `if (version.length > 200) return false;`
(semver 2.0.0 max sensible length is tiny — `1.0.0-alpha.beta.gamma+build.2024`
is well under 100 chars). The 200-char cap alone eliminates the quadratic
window. Apply the same cap in `convex/specs.ts` `publish` before calling
`isValidSemver`.

---

### [P2] `saveDraft` / `publish` return unbounded `issues` arrays in mutation responses — response-size amplification

**Location.** `convex/specs.ts:46-56` (`saveDraft` returns
`issues: SpecIssue[]`), `convex/specs.ts:154-170` (`publish` returns
`issues: SpecIssue[]`), `packages/shared/src/validate.ts:113-150` (pushes a
warning per missing-cost operation).

**Problem.** Both `saveDraft` and `publish` return the full `issues` array
to the client. For a spec with N paths each missing `x-zevium-cost`, the
validator pushes N warning objects. A spec with 10 000 paths (well under the
unbounded `paths` cap from P1 #2) returns 10 000 `SpecIssue` objects in the
mutation response, each with `{ level, path, message }`. The web editor's
`mergeIssues` (`spec-workspace.tsx:90-94`) then deduplicates and renders all
of them.

**Impact.** Response-size amplification: a 10 000-path spec with no costs
produces a ~500 KB mutation response of warnings. Convex mutation responses
are not designed for this; the client re-renders 10 000 lint diagnostics on
every save.

**Fix.** Cap the `issues` array in `collectOpenApiSpecIssues` (e.g.
`MAX_ISSUES = 100`), and when truncated push a final summary issue:
`"... and N more issues (truncated)"`. Alternatively, deduplicate missing-
cost warnings into a single summary: `"N operations missing x-zevium-cost"`.

---

### [P2] Malformed path templates never validated at publish boundary — `{}`, `{a/b}`, non-`/`-prefixed keys silently misbehave at gateway

**Location.** `packages/shared/src/validate.ts:113-150` (path loop never
validates `pathKey` shape) vs `packages/shared/src/openapi.ts:115-137`
(`matchPathTemplate` / `normalizePath`).

**Problem.** The validator iterates `Object.entries(raw.paths)` and uses
`pathKey` directly in the issue path (`$.paths["${pathKey}"]`) without
checking that it is a valid OpenAPI path template. Meanwhile the gateway's
`matchPathTemplate` has specific expectations:

- `pathKey` should start with `/` (OpenAPI requirement) — but
  `normalizePath` silently prepends `/` to a keyless template, so `users`
  and `/users` match the same request. The validator accepts both.
- `{}` (empty braces) — `matchPathTemplate` checks `ts.length > 2`, so `{}`
  (length 2) is treated as a literal segment that only matches the literal
  string `{}`. A publisher who writes `{}` as a param never matches.
- `{a/b}` (slash inside braces) — `normalizePath` splits on `/`, so `{a/b}`
  becomes two segments `["{a", "b}"]`. `{a` starts with `{` but doesn't end
  with `}`, so it's treated as a literal. The template silently never matches
  its intent.
- `{a}{b}` (adjacent params) — `matchPathTemplate` treats the whole segment
  as a single param (starts with `{`, ends with `}`), `name = "a}{b"`. This
  is a nonsensical param name that gets captured and forwarded.

None of these are flagged at publish time. A publisher with a malformed
template publishes successfully and discovers the route doesn't match at
runtime.

**Impact.** Malformed specs pass the publish gate; route failures surface as
mysterious 404s at call time with no publish-time signal.

**Fix.** Validate `pathKey` in the path loop:
- Must start with `/`.
- Must not contain `{` or `}` except as balanced `{name}` segments.
- Param names inside `{}` must be non-empty and match `[a-zA-Z_][a-zA-Z0-9_]*`.
- Push an error at `$.paths["${pathKey}"]` on violation.

---

### [P2] Credentials embedded in `servers[0].url` are not flagged — leak into immutable storage and gateway fetch

**Location.** `packages/shared/src/validate.ts:84-104` (URL check does not
inspect `url.username` / `url.password`).

**Problem.** The validator's URL check only verifies the scheme. A URL like
`https://user:pass@internal-host/api` passes the `http(s)` check and is
stored verbatim in the immutable `specVersions` row (`convex/specs.ts:132`).
The gateway then uses this URL in `fetchImpl(upstreamUrl, { headers:
upstreamHeaders })` — the credentials are in the URL, not headers, so they
are sent to the upstream. If the fetch fails, the error message
(`pipeline.ts:264` `err.message`) may include the URL with credentials.

The URL is also visible to any org member who can read the published spec
(`getVersion` query), and to the gateway's `getPublishedForGateway` (no-
auth, public).

**Impact.** Credentials embedded in the upstream URL are stored in an
immutable, potentially public record and may leak in error messages.

**Fix.** Reject `servers[0].url` when `url.username` or `url.password` is
non-empty:

```ts
if (url.username || url.password) {
  issues.push({ level: "error", path: "$.servers[0].url",
    message: "servers[0].url must not contain embedded credentials" });
}
```

---

### [P3] `openapi` field checked for non-emptiness only; Swagger 2.0 / garbage strings pass

**Location.** `packages/shared/src/validate.ts:62-67`.

**Problem.**

```ts
if (typeof raw.openapi !== "string" || raw.openapi.trim() === "") {
  issues.push({ ... message: "Missing openapi field (expected OpenAPI 3.x version string)" });
}
```

The message promises "OpenAPI 3.x" enforcement; the code only rejects empty
strings. `openapi: "2.0"`, `openapi: "swagger"`, `openapi: "banana"`,
`openapi: "4.0.0"` all pass. The gateway's `parseSpec` (`openapi.ts:64`)
also stores the string verbatim without acting on it. A Swagger 2.0 spec
(which uses `host` + `basePath`, not `servers`) would pass the `servers`
check only if the publisher manually adds a `servers` array, then
mis-parse at the gateway.

**Impact.** Invalid specs pass the publish gate; failures surface as
mysterious 404s / wrong pricing at call time.

**Fix.** Enforce the version: require `raw.openapi` to match
`/^3\.(0|1)\.\d+(-.+)?$/` (or at least start with `3.`), and align the
message with the actual check.

---

### [P3] `paths: {}` (empty object) passes with zero issues — inconsistent signal vs missing `paths`

**Location.** `packages/shared/src/validate.ts:106-112`.

**Problem.**

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
(which gets a warning). A publisher can publish an endpoint-less spec and
get no signal.

**Impact.** Inconsistent boundary signal; degenerate specs publish silently.

**Fix.** Warn when `Object.keys(raw.paths).length === 0` with the same
message as the missing-paths branch.

---

### [P3] `hasErrors`, `hasValidationErrors`, real `validateOpenApiSpec`, and `SpecValidationResult` are dead in Convex

**Location.** `convex/lib/validate.ts:6-11` re-exports `hasErrors` (and
aliases the array function to `validateOpenApiSpec`).

**Problem.** Verified callers:
- `convex/specs.ts:48` — `effectiveIssues.some((i) => i.level === "error")`
  (inlined, does not call `hasErrors`).
- `convex/specs.ts:156` — `issues.some((i) => i.level === "error")` (inlined).
- `convex/dev.ts:301` — `issues.some((i) => i.level === "error")` (inlined).
- `apps/web/src/components/spec-editor/spec-workspace.tsx:158,278` —
  `issues.some(...)` (inlined).

So `hasErrors` is re-exported through the shim but **never invoked**. The
real `validateOpenApiSpec`, `hasValidationErrors`, and `SpecValidationResult`
are exported from `@zevium/shared` but only exercised by
`packages/shared/src/validate.test.ts`. The shim does not even surface
`SpecValidationResult`, so the structured form is unreachable from Convex.

**Impact.** Dead code in the public surface; misleading API surface
(`hasValidationErrors` suggests the structured form is the primary API,
which it isn't). `hasErrors` being re-exported by Convex and then never
called is doubly dead.

**Fix.** Drop `hasErrors` from the shim's re-export list (callers already
inline the check). In shared, either delete `hasValidationErrors` and the
result-typed `validateOpenApiSpec` or mark them clearly as the public API
and add a non-test consumer. Update `validate.test.ts` accordingly.

---

### [P3] Path keys not validated; `"` / `]` in keys break the issue-path format

**Location.** `packages/shared/src/validate.ts:113-150`.

**Problem.** OpenAPI requires every key in `paths` to start with `/`. The
validator never checks this; it uses the raw key directly in the issue path
via template literal:

```ts
path: `$.paths["${pathKey}"].${lower}.x-zevium-cost`,
```

A path key like `users` (no leading slash), `users"]$.foo` (contains `"]`),
or `a"b` (contains `"`) is accepted and produces a malformed,
non-JSONPath-compliant `issue.path`. The web editor
(`json-code-editor.tsx:34`) only stringifies `${issue.message} (${issue.path})`
into a lint message, so today it is display-only breakage, but any future
consumer that parses `issue.path` will mis-route. The gateway's
`matchOperation` calls `normalizePath(template)` which silently prepends `/`
to a keyless template, so a path missing its leading slash also matches
inconsistently between validation (accepts) and OpenAPI semantics (rejects).

**Impact.** Malformed specs accepted at the boundary; issue paths
unparseable; downstream inconsistency.

**Fix.** Validate `pathKey` starts with `/` and contains no `"` / `]` (or
escape them when interpolating into the issue path).

---

### [P3] Issue path format is non-JSONPath-compliant: `x-zevium-cost` is a bare dot-segment containing hyphens

**Location.** `packages/shared/src/validate.ts:140`, `:124`, `:130`, e.g.
`$.paths["/x"].get.x-zevium-cost`.

**Problem.** Path keys with `/` are bracket-quoted (`$.paths["/x"]`), but
the field `x-zevium-cost` is appended as a bare dot-segment. A consumer
splitting `issue.path` on `.` would get `x`, `zevium`, `cost` as three
segments — the hyphenated field name is ambiguous against the dot delimiter.
JSONPath would require `$.paths["/x"].get["x-zevium-cost"]`. The web editor
currently only stringifies the path, so there is no live breakage, but the
format is inconsistent within a single path string (mixed bracket and
bare-dot notation for keys that both contain reserved chars).

**Impact.** Future path-parsing consumers (linters, diff highlighters,
structured error reporting) will mis-tokenize the path.

**Fix.** Bracket-quote any segment that is not a bare ASCII identifier:
`$.paths["/x"].get["x-zevium-cost"]`.

---

### [P3] `servers[1..N]` never validated; bad trailing entries silently ignored

**Location.** `packages/shared/src/validate.ts:75-104`.

**Problem.** Only `raw.servers[0]` is type- and URL-checked. A spec like
`{servers: [{url: "https://ok.com"}, {url: "ftp://bad"}, {url: 123}]}` passes
validation cleanly. This is *consistent* with the gateway, which only reads
`servers[0]?.url`, so today there is no runtime defect — but the validator's
silence about malformed trailing entries misleads publishers who expect
OpenAPI validation rather than "only the first server matters".

**Impact.** Misleading validation signal; a spec that would fail a real
OpenAPI validator passes here.

**Fix.** Either validate every entry (reject non-string URLs in any server),
or push a warning when `servers.length > 1` noting only `servers[0]` is used.

---

### [P3] Path-item `$ref` (OpenAPI 3.1) not handled; operations under it get no cost check

**Location.** `packages/shared/src/validate.ts:115-150` (the
`for (const [method, opVal] of Object.entries(pathVal))` loop skips any key
not in `HTTP_METHODS`, including `$ref`).

**Problem.** OpenAPI 3.1 allows `paths["/x"]: { $ref:
"#/components/pathItems/foo" }`. The validator iterates keys and skips
`$ref` (not a method), so a path item that is purely a `$ref` produces no
`x-zevium-cost` warning and no error. The gateway `parseSpec` also does not
resolve path-item `$ref`s, so the operation ends up with default pricing
(`cost: 1`). A publisher using path-item `$ref` to share an operation across
paths publishes with no pricing validation and default 1-credit charges at
runtime.

**Impact.** Incomplete coverage of the OpenAPI 3.1 surface the validator
claims to support (per the `openapi: "3.1.0"` accept-list in the test
fixtures).

**Fix.** Either resolve `$ref` to `components.pathItems` before validating
operations, or push a warning that path-item `$ref` is unsupported.

---

### [P3] `info` / `info.title` / `info.version` not validated despite being OpenAPI-required

**Location.** `packages/shared/src/validate.ts` — no `raw.info` check at
all.

**Problem.** OpenAPI requires `info` with `title` and `version`. The
validator never checks `info`'s presence or shape. `parseSpec`
(`openapi.ts:70-76`) reads them as optional, and the catalogue embedding
(`internal.search.embedProject`) derives text from `info.title` /
`info.version` — a missing title silently degrades search quality with no
boundary signal.

**Impact.** Specs missing required metadata publish silently; catalogue
search quality degraded.

**Fix.** Require `isRecord(raw.info)` with non-empty string `title` and
`version`, else push an error at `$.info`.

---

### [P3] JSON parse error message is engine-dependent — breaks `mergeIssues` deduplication

**Location.** `packages/shared/src/validate.ts:50-58`.

**Problem.**

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
`saveDraft` / `publish` `issues`. The web editor's `mergeIssues`
(`spec-workspace.tsx:90-94`) keys dedup on
`${i.level}|${i.path}|${i.message}` — so the client-computed JSON-parse
error and the server-returned JSON-parse error for the same input produce
different messages and are NOT deduplicated, resulting in duplicate
diagnostics.

**Impact.** Client/server issue-dedup misses on JSON-parse errors because
the message strings differ by engine; minor position-snippet exposure of
user input.

**Fix.** Synthesize a stable message (e.g. `"Invalid JSON"`) instead of
forwarding the engine message verbatim. If position info is needed, add a
structured `position` field to `SpecIssue`.

---

### [P3] `isRecord` duplicated in `validate.ts` and `openapi.ts`; `HTTP_METHODS` duplicated across three files

**Location.** `packages/shared/src/validate.ts:31-33` and
`packages/shared/src/openapi.ts:40-42` (identical `isRecord`);
`packages/shared/src/validate.ts:25-35`, `packages/shared/src/openapi.ts:13-23`
(identical `HTTP_METHODS` records).

**Problem.** Identical helpers in two files of the same package, plus the
`HTTP_METHODS` record duplicated. Future divergence risk; e.g. if
`openapi.ts` adds `trace` support but `validate.ts` doesn't (or vice versa),
the validator and gateway disagree on which methods are valid.

**Impact.** Trivial duplication today; divergence risk is real for
`HTTP_METHODS` since it drives which operations get cost-checked (validator)
vs. which get matched (gateway).

**Fix.** Move `isRecord` and `HTTP_METHODS` to a shared internal `utils.ts`
and import from both. Ensure the validator and gateway share the exact same
method set.

---

### [P3] `saveDraft` runs `validateOpenApiSpec("")` on empty draft then discards the result

**Location.** `convex/specs.ts:43-48`.

**Problem.**

```ts
const issues = validateOpenApiSpec(args.spec);  // runs on ""
const effectiveIssues = args.spec.trim() === "" ? [] : issues;
```

For an empty draft (`args.spec = ""`), the code calls
`validateOpenApiSpec("")` which does `JSON.parse("")` → throws → allocates
and returns `[{level:"error", path:"$", message:"Invalid JSON: ..."}]`,
then `effectiveIssues = []` discards it. The parse + allocation is wasted
work on every empty-draft save.

**Impact.** Minor CPU/allocation waste on the empty-draft save path.

**Fix.** Guard before validating:

```ts
if (args.spec.trim() === "") {
  // empty draft is allowed; skip validation entirely
  ...save empty...
  return { ok: true, issues: [], draft: args.spec, lastSavedAt: now };
}
const issues = validateOpenApiSpec(args.spec);
```

---

## Summary

**Counts:** 2 × P0, 3 × P1, 7 × P2, 8 × P3. (20 findings total.)

**Top 3:**

1. **[P0] `x-zevium-cost: 0` validates as free but the gateway charges 1
   credit per call.** The validator accepts `>= 0`; `extractPricing` rewrites
   `0 → 1` via `costRaw > 0 ? Math.floor : 1`. A publisher who advertises a
   free endpoint silently bills every consumer one credit per request —
   billing integrity violation with no signal at any layer.
2. **[P0] `x-zevium-free-tier` is never validated.** The gateway silently
   floors (`0.5 → disabled`) or accepts unbounded (`"1e9"` → 1 billion free
   calls/day, publisher-funded) values for a publisher-funded quota. The
   `Math.floor` + `> 0` guard in `extractPricing` is doing all the
   validation work the validator refuses to do, silently.
3. **[P1] SSRF: `servers[0].url` accepts `http://169.254.169.254`,
   `localhost`, RFC1918.** The only filter is `protocol === http(s)`. The
   gateway fetches consumer requests to this URL with `redirect: "manual"`
   and no IP pinning — the validator is the sole defense, and it's at
   publish time only (`parseSpec` does zero URL validation). A publisher can
   route every consumer request through the gateway to cloud metadata /
   internal services, and the consumer is debited for the SSRF call.

**Theme.** This file is the marketplace's pricing and routing gate, and the
gateway (`openapi.ts`) silently re-normalizes every value this validator
blesses. The two halves were written separately and never reconciled: cost
`≥ 0` vs `> 0`, fractional floors, string-form numbers, missing free-tier
validation. Fix the contract once, enforce it in the validator (the
boundary), and strip the silent normalizers from `extractPricing`. The SSRF,
unbounded-parse, and `parseSpec`-no-validation issues are independent and
urgent regardless — they are the boundary this file is supposed to defend,
and it leaks.
