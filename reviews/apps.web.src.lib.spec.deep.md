# Tiger Review — `apps/web/src/lib/spec-*` (spec editing lib)

Files reviewed (full read + tests + shared deps):
- `apps/web/src/lib/spec-import.ts` (+ `spec-import.test.ts`)
- `apps/web/src/lib/spec-yaml.ts` (+ `spec-yaml.test.ts`)
- `apps/web/src/lib/spec-pricing.ts` (no test)
- `apps/web/src/lib/spec-pricing-edit.ts` (+ `spec-pricing-edit.test.ts`)
- `apps/web/src/lib/spec-endpoints.ts` (+ `spec-endpoints.test.ts`)
- `apps/web/src/lib/spec-save-status.ts` (+ `spec-save-status.test.ts`)
- `packages/shared/src/openapi.ts` (source of truth: `parseSpec`, `extractPricing`, `asNumber`)
- `packages/shared/src/pricing.ts` (`EndpointPricing`)
- `packages/shared/src/validate.ts` (`collectOpenApiSpecIssues` — the save/publish gate)

`yaml@2.9.0` confirmed at runtime. All findings below are verified by reading source and, where noted, by executing the code.

---

## Verdict

The spec-editing surface has one genuine **P0** (server-side SSRF with no private-IP / metadata protection and a status-code oracle), a cluster of **P1** pricing-correctness bugs where the editor writes values the gateway silently rewrites (zero-cost trap, fractional credits, un-validated `freeTier`), and a stack of **P2** robustness/DoS holes (post-download size cap, YAML deep-nest main-thread DoS + error leak, array-root bypass, redirect-follow defeating any future allowlist). The pricing drift is the most insidious: a publisher sets `cost: 0` intending a free endpoint, validation passes, the editor rail shows `1`, and the gateway charges 1 credit — nobody is wrong, everybody is surprised.

---

## File Stats

| File | LOC | Tests | Findings |
|---|---|---|---|
| spec-import.ts | 92 | 3 cases, URL parse only | 1 P0, 2 P1, 3 P2, 1 P3 |
| spec-yaml.ts | 53 | 6 cases | 2 P2, 4 P3 |
| spec-pricing.ts | 57 | none | 1 P2, 3 P3 |
| spec-pricing-edit.ts | 87 | 13 cases | 1 P1, 2 P2, 2 P3 |
| spec-endpoints.ts | 50 | 3 cases | 1 P2, 3 P3 |
| spec-save-status.ts | 49 | 5 cases | 2 P3 |
| **Totals** | | | **1 P0, 3 P1, 9 P2, 14 P3** |

---

## Findings

### [P0] spec-import.ts — SSRF: no private/loopback/metadata-IP filtering; status-code leak = internal network scanner

**Location:** `parseImportSpecUrl` (lines 8–22) + `fetchSpecFromUrl.handler` (lines 51–92).

```ts
.refine((value) => {
  const u = new URL(value);
  return u.protocol === "http:" || u.protocol === "https:";
}, { message: "URL must be http(s)" })
```

```ts
if (!response.ok) {
  throw new Error(`URL returned HTTP ${response.status}`);
}
```

**Problem:** `fetchSpecFromUrl` is a `createServerFn` (server-side, runs on the web tier) that fetches an attacker-supplied URL. The only validation is `protocol === http(s)`. There is **no** denylist for:
- `127.0.0.1`, `localhost`, `[::1]`, `0.0.0.0`
- RFC1918 / link-local: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`
- Cloud metadata endpoints: `169.254.169.254` (AWS/GCP/Azure IMDS), `[fd00:ec2::254]`, `metadata.google.internal`
- Decimal / hex / octal encodings of loopback: `http://2130706433/`, `http://0x7f000001/`, `http://0177.0.0.1/`, `http://0/`

The thrown `URL returned HTTP ${response.status}` is surfaced to the caller (the editor toast via `humanError`), so an attacker can distinguish 200 / 401 / 403 / 404 / 500 / connection-refused on internal hosts — a textbook SSRF oracle. On a cloud-deployed web tier, `169.254.169.254/latest/meta-data/iam/...` can return IAM credentials over HTTP 200.

**Impact:** Internal network reconnaissance, potential cloud credential theft via IMDS, access to admin/health endpoints bound to `127.0.0.1`. The status-code echo turns this into a port/host scanner.

**Fix:** Resolve the URL hostname, reject if it resolves to a private/loopback/link-local/metadata IP (covering all numeric encodings — `new URL` normalizes `0x7f000001` to `127.0.0.1` only after DNS; do the check on the resolved socket address). Use a single explicit egress allowlist, or at minimum:
```ts
const u = new URL(data.url);
const host = u.hostname;
if (host === "localhost" || host.endsWith(".localhost") ||
    host === "169.254.169.254" || host === "metadata.google.internal") throw …;
// then resolve + check IP ranges, then fetch with redirect:"manual" + AbortController
```
Also collapse the status code to a generic "URL is not reachable" for non-2xx instead of echoing `response.status`.

---

### [P1] spec-import.ts — No fetch timeout; `redirect:"follow"` chains without limit and defeats any future allowlist

**Location:** lines 54–69.

```ts
response = await fetch(data.url, {
  method: "GET",
  redirect: "follow",
  headers: { Accept: "application/json, application/yaml, text/yaml, text/plain, */*" },
});
```

**Problem:** No `AbortController` / timeout. A malicious or slow origin keeps the server function (and its HTTP request back to the editor) hanging for the full platform timeout — one cheap request pins a worker. `redirect:"follow"` means any future URL allowlist added to `parseImportSpecUrl` is trivially bypassable: the allowlist checks the *original* URL, then a 302 redirects to `http://169.254.169.254/…` or an internal host. There is also no cap on redirect chain length (the runtime caps ~20, but each hop is another outbound request).

**Impact:** DoS via slow-loris-style hangs; SSRF bypass-of-future-allowlist via redirect.

**Fix:** `AbortSignal.timeout(10_000)`, `redirect: "manual"` (or `"error"`), and re-validate each `Location` hop against the same denylist before following.

---

### [P1] spec-import.ts — Size cap is enforced *after* the full body is buffered into memory

**Location:** lines 71–85.

```ts
const lengthHeader = response.headers.get("content-length");
if (lengthHeader !== null) {
  const n = Number(lengthHeader);
  if (Number.isFinite(n) && n > MAX_SPEC_IMPORT_BYTES) throw new Error("Spec is larger than 2MB");
}
const buf = await response.arrayBuffer();   // <-- entire body in RAM
if (buf.byteLength > MAX_SPEC_IMPORT_BYTES) throw new Error("Spec is larger than 2MB");
```

**Problem:** If the origin omits `Content-Length` (chunked / streaming / `Transfer-Encoding: chunked`), the header check is skipped and `response.arrayBuffer()` buffers the **entire** body before the `byteLength` check rejects. A 10 GB chunked body OOMs the web tier before being rejected. The prior review's "size cap bypassable via streaming/chunked bodies" is confirmed and is still open.

**Impact:** Memory-exhaustion DoS of the server function with a single request.

**Fix:** Stream with `response.body.getReader()`, accumulate into a capped buffer, abort the moment the running total exceeds `MAX_SPEC_IMPORT_BYTES`:
```ts
const reader = response.body?.getReader();
const chunks: Uint8Array[] = [];
let total = 0;
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  total += value.byteLength;
  if (total > MAX_SPEC_IMPORT_BYTES) throw new Error("Spec is larger than 2MB");
  chunks.push(value);
}
const buf = new Uint8Array(total);
// …concat…
```

---

### [P1] spec-pricing-edit.ts — Zero-cost trap: `cost: 0` is written, passes `validateOpenApiSpec`, but the gateway charges 1 credit

**Location:** `applyField` (lines 32–43) + `extractPricing` in `packages/shared/src/openapi.ts`.

```ts
function applyField(op, key, value) {
  if (value === undefined) return;
  if (value === null || Number.isNaN(value)) { delete op[key]; return; }
  op[key] = value;   // <-- 0 is written verbatim
}
```
Gateway source-of-truth (`extractPricing`):
```ts
const cost = costRaw !== undefined && costRaw > 0 ? Math.floor(costRaw) : 1;
```
And `validateOpenApiSpec` only rejects `cost < 0`:
```ts
else if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) { /* error */ }
```

**Problem:** A publisher edits a cost to `0` (the obvious "make this free" intent). `applyPricingEdit` writes `"x-zevium-cost": 0`, returns `ok: true`. The document passes `validateOpenApiSpec` (0 is not `< 0`). At runtime the gateway sees `costRaw > 0` → false → defaults to **1 credit**. The editor rail (`listSpecEndpoints`) and summary (`summarizeDraftPricing`) both display **1** (because they also route through `extractPricing`). So the publisher sees "1 credit" everywhere, the stored spec says 0, and the gateway charges 1 — three different truths, none of them what the publisher intended.

**Impact:** Silent billing drift; "free" endpoints silently bill callers 1 credit. The publisher cannot express a zero-cost endpoint at all, but nothing tells them that.

**Fix:** Either (a) make `0` a legal cost end-to-end (fix `extractPricing` to allow `cost === 0`), or (b) reject `0` at write time in `applyField` (treat 0 like null/NaN → delete, and document that cost ≥ 1). Pick one and make editor + validation + gateway agree.

---

### [P1] spec-pricing-edit.ts — Fractional / non-integer costs and free-tiers: integer-cent violation, silently floored at gateway

**Location:** `applyField` writes any finite number; `extractPricing` does `Math.floor`; `validateOpenApiSpec` does **not** check `Number.isInteger`.

```ts
// validate.ts cost branch:
else if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) { /* error */ }
// no Number.isInteger(cost) check
```

**Problem:** `applyPricingEdit(BASE, { cost: 1.5 })` writes `"x-zevium-cost": 1.5`. Validation passes (1.5 is finite, ≥ 0). Gateway `Math.floor(1.5)` → 1. The publisher types 1.5, the spec stores 1.5, the gateway charges 1. Same for `freeTier: 3.7` → gateway floors to 3. There is no integer-cents invariant enforced anywhere in the write path.

**Impact:** Float-precision pricing drift. Credits are conceptually integers; storing fractions means the spec text, the displayed rail, and the billed amount all disagree.

**Fix:** In `applyField`, reject non-integer finite values (or `Math.round` them and document). In `validateOpenApiSpec`, add `!Number.isInteger(cost)` to the error branch for `x-zevium-cost` and a parallel integer/≥0 check for `x-zevium-free-tier`.

---

### [P1] spec-pricing-edit.ts — `x-zevium-free-tier` is never validated; negative / fractional / huge values persist

**Location:** `applyField` + `validate.ts` (which has **no** branch for `x-zevium-free-tier` at all).

**Problem:** `collectOpenApiSpecIssues` validates `x-zevium-cost` but never even reads `x-zevium-free-tier`. So:
- `freeTier: -10` → written, passes validation, gateway treats as `undefined` (`freeRaw > 0` false).
- `freeTier: 3.7` → written, passes validation, gateway floors to 3.
- `freeTier: 1e308` → written, passes validation, downstream integer overflow.
- `freeTier: 0` → written, gateway drops to `undefined`.

The publisher's editor rail (`listSpecEndpoints`) shows the free-tier value from `extractPricing`, which has already sanitized away all of the above — so the rail displays a sanitized value while the stored spec text contains garbage that silently vanishes at the gateway.

**Impact:** Stored-spec / gateway / rail three-way drift for every `freeTier` edge case; negative or absurd free-tier values are persisted into published specs.

**Fix:** Add a `x-zevium-free-tier` validation branch in `validate.ts` (`typeof !== number || !Number.isFinite || !Number.isInteger || < 0` → error). Validate in `applyField` before writing.

---

### [P2] spec-pricing-edit.ts — `Infinity` / `-Infinity` silently coerced to `null` by `JSON.stringify`, edit reports `ok: true`

**Location:** `applyField` (lines 36–42) + `return { ok: true, text: JSON.stringify(root, null, 2) }`.

```ts
if (value === null || Number.isNaN(value)) { delete op[key]; return; }
op[key] = value;
```

**Problem:** `Number.isNaN` catches `NaN` (→ delete) but not `Infinity` / `-Infinity`. `applyPricingEdit(BASE, { cost: Infinity })` sets `op["x-zevium-cost"] = Infinity`, then `JSON.stringify` converts `Infinity` → `null`. The returned `text` contains `"x-zevium-cost": null`, and the edit returns `{ ok: true }`. On the next parse/validate pass, `null !== undefined` so validation hits `typeof null !== "number"` → error — but the editor text was silently corrupted to `null` with a success return.

**Impact:** Silent spec corruption: the publisher's edit "succeeds" but the value becomes `null`, which then fails the next validation cycle with a confusing "must be a number" error pointing at a field the publisher never typed `null` into.

**Fix:** Treat non-finite values as delete (or reject): `if (value === null || !Number.isFinite(value)) { delete op[key]; return; }`.

---

### [P2] spec-import.ts — `contentType` is dead output; `fetchSpecFromUrl` return type lies about its contract

**Location:** lines 52, 71, 90.

```ts
async ({ data }): Promise<{ text: string; contentType: string | null }> => {
  …
  const contentType = response.headers.get("content-type");
  …
  return { text, contentType };
}
```

**Problem:** Confirmed by grep: every caller (`editor-toolbar.tsx:74`) destructures only `result.text`. `contentType` is computed, transported over the server-function boundary, and never read. The return type advertises a field that carries semantic weight (the caller might one day branch on YAML vs JSON content-type) but no caller does. This is a maintenance trap: someone will add `if (result.contentType?.includes("yaml"))` later, not realizing the value was never used/tested, and get silently wrong behavior.

**Impact:** Dead code, misleading API surface, future-accident bait.

**Fix:** Either drop the field from the return type + handler, or actually use it (e.g., to skip the YAML-detection heuristic in `convertSpecInputToJson` when the origin already declared `application/yaml`). Don't ship it unused.

---

### [P2] spec-yaml.ts — YAML array root bypasses the object guard (`typeof [] === "object"`)

**Location:** lines 24–31.

```ts
const doc = parseYaml(trimmed) as unknown;
if (doc === null || typeof doc !== "object") {
  return { ok: false, error: "YAML root must be an object" };
}
```

**Problem:** Verified at runtime: `parseYaml("- a\n- b")` returns `["a","b"]`. `typeof ["a","b"] === "object"` is `true`, so the guard does **not** reject arrays. The function returns `{ ok: true, json: "[\n  \"a\",\n  \"b\"\n]\n", convertedFromYaml: true }` — a JSON array as spec text. The error only surfaces later when `validateOpenApiSpec` reports "Root must be a JSON object", by which point the editor buffer has been replaced with invalid JSON. The test suite never exercises an array-root YAML paste.

**Impact:** A YAML array paste silently produces invalid spec text that the editor accepts and then fails validation at save with a confusing "Root must be an object" error pointing at a document the publisher believes they imported successfully.

**Fix:** `if (doc === null || typeof doc !== "object" || Array.isArray(doc))`.

---

### [P2] spec-yaml.ts — Deep-nesting / large paste DoS: parser stack-overflows on the main thread and leaks the internal error

**Location:** lines 24–35.

**Problem:** `convertSpecInputToJson` runs client-side (called from `editor-toolbar.tsx` on paste and from `spec-workspace.tsx` on every editor change). There is no input size cap and no depth limit. Verified at runtime with `yaml@2.9.0`:
- A 1000-deep nested YAML mapping throws `Maximum call stack size exceeded at line 903, column 1805: …` after ~50 ms.
- A 5000-deep paste blocks the main thread for ~250 ms before throwing; 7000-deep ~300 ms.
- The thrown `err.message` (including internal parser line/column) is interpolated into `Could not parse as JSON or YAML: ${message}` and shown in a toast — leaking parser internals.

The `yaml` package's default `maxAliasCount: 100` does mitigate the classic billion-laughs alias bomb (confirmed: throws `Excessive alias count indicates a resource exhaustion attack` in 9 ms), but there is no protection against raw structural depth.

**Impact:** A pasted 100 KB deeply-nested YAML freezes the editor tab for hundreds of ms and then shows a stack-trace-laced toast. Repeated pastes can hang the UI.

**Fix:** Cap `text.length` (e.g. `MAX_SPEC_IMPORT_BYTES`) before parsing; wrap `parseYaml` with a depth budget (the `yaml` package accepts `parse(text, { maxAliasCount, … })` but no direct depth option — pre-validate by counting leading-indent columns, or run the parse in a Web Worker / with a timeout). Sanitize the error to a fixed `"Could not parse as YAML"` without `${message}`.

---

### [P2] spec-yaml.ts — Raw `err.message` leaked to toast (information leak + UX)

**Location:** lines 32–35.

```ts
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: `Could not parse as JSON or YAML: ${message}` };
}
```

**Problem:** The `yaml` package embeds line/column and source snippets in its `YAMLParseError` messages (e.g. `Maximum call stack size exceeded at line 903, column 1805: <source snippet>`). These are surfaced verbatim into `toast.error(converted.error)` in `editor-toolbar.tsx:42`. This is the same anti-pattern flagged in the prior `spec-yaml.ts` review and it is still present. Internal parser state (and, for the stack-overflow case, V8 internals) reaches the user.

**Impact:** Ugly, potentially confusing error toasts; minor info leak of paste content back through the error.

**Fix:** Return a fixed `"Could not parse as JSON or YAML"` string; log `message` server-side if telemetry is needed.

---

### [P2] spec-pricing.ts — Summary min/max silently sanitize 0/negative/fractional costs, hiding drift from the publisher

**Location:** `summarizeDraftPricing` (lines 12–47), routing through `extractPricing`.

```ts
const pricing = extractPricing(op);
const cost = pricing.cost;
minCredits = minCredits === null ? cost : Math.min(minCredits, cost);
```

**Problem:** `extractPricing` returns `cost ≥ 1` for every input (0 → 1, -5 → 1, 1.5 → 1, missing → 1). So if a spec contains `"x-zevium-cost": 0` (the zero-cost trap above) or `1.5`, `summarizeDraftPricing` reports `minCredits: 1` / `maxCredits: 1` — the badge reads "1 endpoint, 1 credit" while the spec text literally says `0` or `1.5`. The publisher's mental model (from the editor text) and the summary badge disagree, and the badge always agrees with the gateway rather than with the document. This is the display-side half of the P1 pricing-drift cluster.

**Impact:** Hides the zero-cost / fractional-cost bugs from the publisher; the badge shows a sanitized value that does not match the document.

**Fix:** Compute min/max from the raw `op["x-zevium-cost"]` (with the same validation rules), not from the post-sanitized `extractPricing` output — or fix the underlying drift by making 0 / integers legal end-to-end.

---

### [P2] spec-endpoints.ts — Rail displays sanitized cost/freeTier, masking stored invalid values

**Location:** `listSpecEndpoints` (lines 23–45).

```ts
const pricing = extractPricing(op);
rows.push({ method, path, cost: pricing.cost, freeTier: pricing.freeTier, summary: … });
```

**Problem:** Same root cause as the P1 drift. A spec with `"x-zevium-cost": 0` renders a rail row with `cost: 1`. A spec with `"x-zevium-free-tier": -5` renders `freeTier: undefined` (the rail drops the key entirely). A spec with `1.5` renders `1`. The publisher edits a value, the rail shows a different value, and the stored spec contains yet another value. The rail is supposed to be the live WYSIWYG view of the document; instead it is a sanitized projection of what the gateway *would* charge.

**Impact:** The rail actively hides the zero-cost / fractional / negative bugs from the publisher at the exact moment they're editing.

**Fix:** Show the raw stored value when it's present, and surface an inline validation error (warning marker on the row) when the raw value is invalid, instead of silently rewriting it.

---

### [P2] spec-import.ts — URL schema has no max length

**Location:** `importSpecUrlSchema` (lines 8–22).

```ts
url: z.string().trim().url("Enter a valid URL").refine(…)
```

**Problem:** No `.max(N)`. A 1 MB URL passes validation and is forwarded to `fetch`. While `fetch` itself will reject pathologically long URLs, the validator is the intended gate and it accepts unbounded input.

**Impact:** Minor DoS / unbounded input at the validator.

**Fix:** `.max(2048)` (RFC 2616 recommends ≤ 255 but real OpenAPI URLs can be longer; 2 KB is safe).

---

### [P3] spec-yaml.ts — JSON branch accepts scalars / arrays / null and returns them as valid spec text

**Location:** lines 16–20.

```ts
try {
  JSON.parse(trimmed);
  return { ok: true, json: text, convertedFromYaml: false };
}
```

**Problem:** `JSON.parse("42")`, `JSON.parse("true")`, `JSON.parse("null")`, `JSON.parse("[1,2,3]")`, `JSON.parse('"hello"')` all succeed and are returned as `ok: true` spec text. The "is it an object root?" check only happens in the YAML branch. A paste of `null` becomes the editor's entire buffer.

**Impact:** Confusing downstream validation errors for paste inputs that are obviously not specs.

**Fix:** After `JSON.parse`, check `isRecord(result) && !Array.isArray(result)` in the JSON branch too.

---

### [P3] spec-yaml.ts — JSON branch returns untrimmed `text`, inconsistent with the YAML branch

**Location:** line 19 vs line 30.

```ts
return { ok: true, json: text, convertedFromYaml: false };       // raw, untrimmed
…
return { ok: true, json: `${JSON.stringify(doc, null, 2)}\n`, … }; // normalized
```

**Problem:** The JSON path returns the original `text` (leading/trailing whitespace preserved), the YAML path returns a re-serialized, newline-terminated string. Two pastes that are semantically identical produce different editor buffer contents depending on which branch handled them.

**Impact:** Inconsistent formatting; downstream "dirty" diffs can fire purely from whitespace.

**Fix:** Return `trimmed` (or `JSON.stringify(JSON.parse(trimmed), null, 2)`) in the JSON branch for consistency.

---

### [P3] spec-yaml.ts — `looksLikeYaml` is dead code

**Location:** lines 48–54.

**Problem:** Confirmed by grep: `looksLikeYaml` is exported and tested (`spec-yaml.test.ts:5-13`) but imported nowhere in `src/` outside its own test file. `convertSpecInputToJson` (the actual paste path) tries `JSON.parse` first and falls back to YAML, never calling `looksLikeYaml`. The function's heuristic ("leading non-`{`/`[` after strip") is also wrong for whitespace-prefixed JSON (`  {…}`) and for YAML that happens to start with `{` (flow style).

**Impact:** Dead, untested-in-practice code with a flawed heuristic; future contributor may wire it in and introduce bugs.

**Fix:** Delete `looksLikeYaml` and its tests, or actually use it as the branch selector.

---

### [P3] spec-yaml.ts — Prototype pollution via `__proto__` YAML keys is *not* possible (verified safe), but the code provides no defense-in-depth

**Problem:** Verified at runtime with `yaml@2.9.0`: `parse("__proto__:\n  polluted: yes\nlegit: ok")` returns a null-prototype object (`Object.create(null)`) with own key `"__proto__"`; `({}).polluted` stays `undefined`. So prototype pollution is **not currently exploitable** — but this safety is a property of the `yaml` package version, not of this code. A future bump (or a `JSON.parse` of attacker-controlled `{"__proto__":{...}}` JSON in the JSON branch — which `JSON.parse` also safely ignores) is the only thing standing between paste input and prototype writes.

**Impact:** None today; latent if the `yaml` version is ever downgraded or its default object factory changes.

**Fix:** After parsing, assert `Object.getPrototypeOf(doc) === Object.prototype || Object.getPrototypeOf(doc) === null` and reject otherwise; or explicitly `Object.create(null)` the result. Low priority.

---

### [P3] spec-pricing.ts — `PricingSummary.freeTier` is a *count of endpoints with a free tier*, not a free-tier value (type confusion)

**Location:** lines 6–11, 36–38.

```ts
export type PricingSummary = {
  endpointCount: number;
  minCredits: number | null;
  maxCredits: number | null;
  freeTier: number;   // <-- named like a value, is a count
};
```

**Problem:** `freeTier` is incremented by 1 for each endpoint where `pricing.freeTier > 0`. The field name reads as "the free tier value". Any consumer reading `summary.freeTier` will reasonably assume it's a per-day call quota, not a count of endpoints.

**Impact:** Future misuse; the `formatPricingSummary` label "free tier on 3" only makes sense because of an accident of phrasing.

**Fix:** Rename to `endpointCountWithFreeTier` (or `freeTierEndpointCount`).

---

### [P3] spec-pricing.ts — `formatPricingSummary` has no singular form: "1 endpoints"

**Location:** lines 50–63.

```ts
if (summary.endpointCount === 0) return "0 endpoints";
…
return `${summary.endpointCount} endpoints, ${range}${free}`;
```

**Problem:** `endpointCount === 1` → "1 endpoints, …". The repo has a `creditsLabel` helper whose entire docstring calls out "1 credits" bugs as the reason it exists — and this function ignores it for the endpoint count (and only uses it for the equal-range case). Also the free-tier clause ", free tier on 3" has no unit ("3 what?").

**Impact:** Grammatical nit; inconsistent with the `creditsLabel` convention the rest of the codebase enforces.

**Fix:** `const noun = summary.endpointCount === 1 ? "endpoint" : "endpoints"`; and ", free tier on 3 endpoint(s)".

---

### [P3] spec-pricing.ts — No tests for `summarizeDraftPricing` / `formatPricingSummary`

**Problem:** Every other spec lib has a `.test.ts`. `spec-pricing.ts` has none. The zero-cost / fractional-cost / negative-cost drift described in the P2 above would have been caught by a simple `summarizeDraftPricing('{"paths":{"/x":{"get":{"x-zevium-cost":0}}}}')` assertion.

**Impact:** Untracked behavior on a billing-relevant surface.

**Fix:** Add a test file mirroring `spec-endpoints.test.ts`.

---

### [P3] spec-pricing-edit.ts — Method case-insensitive match can target a colliding key; only the first match is edited

**Location:** lines 60–67.

```ts
const lower = edit.method.toLowerCase();
let op: Record<string, unknown> | null = null;
for (const [key, val] of Object.entries(pathItem)) {
  if (key.toLowerCase() === lower && isRecord(val)) { op = val; break; }
}
```

**Problem:** If a pathItem has both `GET` and `get` (legal JSON, illegal OpenAPI but not rejected here), only the first in insertion order is edited and the second is silently left alone. The re-serialized document still contains both keys.

**Impact:** Edge case; mostly a trap if a publisher ever hand-edits case-colliding method keys.

**Fix:** Normalize method keys to lower-case on write, or reject pathItems with case-colliding methods.

---

### [P3] spec-pricing-edit.ts — `edit.path` of `"__proto__"` / `"constructor"` accesses Object.prototype / the constructor (no pollution, but smell)

**Location:** line 56.

```ts
const pathItem = paths[edit.path];
```

**Problem:** `paths["__proto__"]` returns `Object.prototype`, which `isRecord` accepts (`typeof Object.prototype === "object"`, not null, not array). `Object.entries(Object.prototype)` is `[]`, so `op` stays `null` and the function returns `{ ok: false }`. Safe by accident, but the access pattern is a code smell and there is no test pinning it.

**Impact:** None today; latent footgun.

**Fix:** `Object.create(null)` the parsed `paths`, or guard `edit.path` against `__proto__`/`constructor`/`prototype`.

---

### [P3] spec-endpoints.ts — Returns `null` on parse error vs `[]` on blank — inconsistent return contract

**Location:** lines 24–26.

```ts
const trimmed = specText.trim();
if (trimmed === "") return [];
…
catch { return null; }
```

**Problem:** Blank → `[]`, invalid → `null`. Callers (`spec-workspace.tsx:171`) handle `null` by setting `endpointsStale`, but the two empty-states are semantically different and the type `SpecEndpointRow[] | null` forces every caller to branch.

**Impact:** Minor API ergonomics; easy to mishandle (forgetting the `null` check returns an empty rail for a broken spec).

**Fix:** Pick one: return `[]` for both and surface validity separately, or always `null` for "no rows".

---

### [P3] spec-endpoints.ts — `summary` only falls back to `op.summary`, ignoring `operationId` / `description`

**Location:** lines 38–41.

```ts
summary: typeof op.summary === "string" && op.summary.trim() !== ""
  ? op.summary : undefined,
```

**Problem:** OpenAPI operations commonly omit `summary` and only have `operationId` or `description`. The rail shows a blank label for those, even though a reasonable display string is available.

**Impact:** UX; rail rows with no label.

**Fix:** Fall back to `operationId`, then first line of `description`.

---

### [P3] spec-endpoints.ts — No cap on endpoint count; a 10 000-path spec produces 10 000 rows

**Location:** lines 27–44.

**Problem:** `listSpecEndpoints` iterates every path × every method with no limit. A megabyte spec with thousands of paths renders thousands of rail rows in one go.

**Impact:** UI jank on large specs.

**Fix:** Cap at e.g. 200 rows with a "+N more" indicator.

---

### [P3] spec-save-status.ts — `formatSavedAgo` max unit is "days"; "saved 365 days ago" for a year-old save

**Location:** lines 17–29.

**Problem:** No weeks/months/years. `days = Math.floor(hr / 24)` grows unbounded; a spec saved a year ago shows "saved 365 days ago". Not wrong, just unergonomic.

**Impact:** Trivial UX nit.

**Fix:** Add week/month/year thresholds, or cap at "saved a long time ago".

---

### [P3] spec-save-status.ts — `deriveSaveStatus` shows "saved X ago" (not "fix errors") when `hasClientErrors && !dirty`

**Location:** lines 35–47.

```ts
if (input.hasClientErrors && input.dirty) return { kind: "fix-errors", … };
if (input.dirty) return { kind: "unsaved", … };
if (input.lastSavedAt !== null && input.lastSavedAt > 0) return { kind: "saved", … };
```

**Problem:** If the loaded spec already has client errors but isn't dirty (just opened), the status reads "saved 8s ago" — there is no signal that the document the publisher is looking at has errors. The "fix-errors" state only fires when dirty.

**Impact:** A publisher opens a broken spec and sees a reassuring "saved" badge.

**Fix:** `if (input.hasClientErrors) return { kind: "fix-errors", label: "fix errors" };` independent of dirty.

---

### [P3] spec-import.ts — Test suite only covers `parseImportSpecUrl`, never `fetchSpecFromUrl`

**Location:** `spec-import.test.ts`.

**Problem:** The SSRF, timeout, size-cap, redirect, and status-leak behaviors of the server function are completely untested. The 3 tests only assert URL string parsing.

**Impact:** The P0/P1 findings above have no regression protection.

**Fix:** Add unit tests against `fetchSpecFromUrl` with a mock `fetch` (or `msw`) covering: private IP rejection, timeout, oversized `Content-Length`, oversized chunked body, redirect to internal host, status-code sanitization.

---

## Summary

**Counts:** 1 P0 · 3 P1 · 9 P2 · 14 P3 — 27 findings total.

**Top 3 to fix first:**

1. **P0 — SSRF oracle in `fetchSpecFromUrl`.** No private/loopback/metadata-IP filtering, status codes echoed to the caller, `redirect:"follow"`, no timeout. On a cloud-deployed web tier this is IMDS-credential-theft-grade. Add a resolved-IP denylist, `redirect:"manual"`, `AbortSignal.timeout`, and a generic non-2xx message.

2. **P1 — Pricing drift cluster (`spec-pricing-edit.ts` + `extractPricing` + `validate.ts`).** Zero-cost trap, fractional costs, and un-validated `freeTier` all write values that `extractPricing` silently rewrites at the gateway, while `validateOpenApiSpec` lets them through. The editor, the stored spec, and the gateway hold three different truths. The cheapest correct fix is to make `applyField` reject non-integer / negative / non-finite inputs and add an `x-zevium-free-tier` validation branch — and decide explicitly whether `0` is a legal cost.

3. **P2 — `spec-import.ts` post-download size cap + `spec-yaml.ts` deep-nest DoS.** Both are cheap memory/CPU exhaustion vectors on the server function and the editor tab respectively, and the YAML parser's stack-overflow message is leaked into the user-facing toast. Stream-cap the import body; cap paste size and sanitize the YAML parse error.

**Cross-cutting theme:** the editor write path (`applyPricingEdit`), the display path (`listSpecEndpoints` / `summarizeDraftPricing`), the validation path (`validateOpenApiSpec`), and the runtime path (`extractPricing`) all apply *different* sanitization rules to the same two extension keys. The result is systematic three-way drift that is invisible to publishers until a caller is billed the wrong amount. The structural fix is a single shared `normalizePricing(op)` used by all four paths so they cannot disagree.
