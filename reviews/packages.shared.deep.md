# Tiger Review — `packages/shared` deep-dive (openapi + pricing + mock + index) + gateway/convex context

**Scope.** `packages/shared/src/openapi.ts`, `packages/shared/src/pricing.ts`,
`packages/shared/src/mock.ts`, `packages/shared/src/index.ts` — read in full.
Context callers read in full: `apps/gateway/src/mock.ts`, `apps/gateway/src/pipeline.ts`,
`convex/specs.ts`. Supporting reads: `packages/shared/src/validate.ts`,
`apps/gateway/src/spec-source.ts`, `convex/lib/validate.ts`, `convex/schema.ts`,
`apps/gateway/src/discovery.ts`, `apps/web/src/lib/spec-pricing.ts`/`spec-endpoints.ts`.

Prior reviews claimed: openapi 4×P2 + 3×P3; pricing 1×P1 + 2×P2 + 1×P3; mock 1×P1
+ 1×P2 + 6×P3; index 2×P2 + 5×P3. **Verified and expanded below.** Two issues
escalated to **P0** that prior per-file reviews missed because they only become
visible when the shared parsers are traced into the gateway hot path:

1. Unauthenticated OOM/CPU DoS on the public `/mock/*` endpoint via unbounded-breadth
   schema synthesis.
2. SSRF (cloud-metadata + consumer-body exfiltration) via publisher-controlled
   `servers[0].url` with a protocol-only validation gate.

---

## Verdict

**REJECT.** The shared package is the gateway's pricing and parsing source of truth
and it currently makes two unauthenticated availability/confidentiality attacks
trivially reachable. The pricing extractor also has an inverted-by-accident
contract (`x-zevium-cost: 0` → charges 1; `x-zevium-cost: 0.5` → free) that silently
misprices every endpoint it touches. Ship-blocker until the SSRF allowlist, the
synthesis size/breadth caps, and the `cost: 0` / fractional-cost handling are fixed.

---

## File Stats

| File | LOC | Surface |
|---|---|---|
| `packages/shared/src/openapi.ts` | ~173 | `parseSpec`, `matchOperation`, `extractPricing`, `normalizePath`, `matchPathTemplate`, `joinUpstreamUrl` — gateway hot path |
| `packages/shared/src/pricing.ts` | 7 | `EndpointPricing` interface |
| `packages/shared/src/mock.ts` | ~120 | `generateMockResponse` — drives public `/mock/*` route |
| `packages/shared/src/index.ts` | ~47 | barrel re-exports + `CREDITS_PER_DOLLAR`/`PLATFORM_CUT` constants |
| `apps/gateway/src/mock.ts` | ~90 | public keyless mock route handler |
| `apps/gateway/src/pipeline.ts` | 411 | metered gateway proxy |
| `convex/specs.ts` | 388 | draft/publish/deprecate + public `getPublishedForGateway` |

---

## Findings

### [P0] Unauthenticated OOM/CPU DoS via unbounded-breadth schema synthesis on the public `/mock/*` route

**Location.** `packages/shared/src/mock.ts:79-99` (`synthesize`) +
`apps/gateway/src/mock.ts:80-87` (`generateMockResponse` caller, **public, keyless**).

```ts
// mock.ts
const MAX_DEPTH = 5;
// ...
function synthesize(rawSchema, components, depth) {
  // ...
  if (depth >= MAX_DEPTH) return depthCapValue(type);
  // ...
  case "object":
  default: {
    if (isRecord(schema.properties)) {
      const out = {};
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        out[key] = synthesize(propSchema, components, depth + 1); // ← breadth uncapped
      }
      return out;
    }
  }
  // array branch: return [synthesize(schema.items, components, depth + 1)];
}
```

```ts
// apps/gateway/src/mock.ts — /mock/:org/:project/* is PUBLIC, no API key
const mock = generateMockResponse(parsed, matched.pathTemplate, matched.method);
// ...
return new Response(JSON.stringify(mock.body), { ... });
```

**Problem.** `MAX_DEPTH = 5` caps depth but **breadth is completely unbounded**.
A published response schema of the self-referential shape below (well under Convex's
~1 MB document cap — roughly 300 bytes) produces `30^5 = 24.3M` synthesized nodes
(≈1.2 GB at ~50 B/node) before a single byte is serialized:

```json
{
  "components": { "schemas": { "N": { "type": "object", "properties": {
    "a": { "$ref": "#/components/schemas/N" }, "b": { "$ref": "#/components/schemas/N" },
    "c": { "$ref": "#/components/schemas/N" }, /* ... 30 keys ... */ } } } }
}
```

`resolveRef` does one hop per `synthesize` call, and each hop increments `depth`, so
recursion terminates at 5 — but the branching factor at every level is whatever the
publisher put in `properties` / `items`. There is **no node budget**, **no breadth
cap**, **no synthesized-output-size cap**, and **no wall-clock guard**. The synthesized
object is materialized fully in memory *before* `JSON.stringify` runs, so the Worker
island OOMs / hits CPU-limit before producing any response.

**Reachability.** `/mock/:org/:project/*` is intentionally keyless
(`apps/gateway/src/mock.ts:1-7` — "PUBLIC, no API key", "anonymous try-before-buy").
The attacker publishes the pathological spec once (one org-member auth, or by
hijacking any publisher account), then a **single unauthenticated GET** to
`/mock/<slug>/<slug>/<any-matched-path>` kills the Worker isolate. Cloudflare
Workers run many requests per isolate, so the blast radius is cross-tenant — a
single malicious project can degrade mock serving for every other project sharing
the isolate.

**Impact.** Unauthenticated availability DoS on a public route; OOM kills the
isolate and disrupts unrelated tenants. Combined with the SSRF below, the shared
mock/parsing surface is the weakest link in the gateway.

**Fix.** Hard caps *before* synthesis, not just depth:
- A **node budget** counter threaded through `synthesize` (e.g. `MAX_NODES = 1024`);
  return `depthCapValue` (or a sentinel) once exceeded.
- A **breadth cap** per object/array (`MAX_PROPERTIES = 64`, `MAX_ITEMS = 16`).
- A **total output size cap** on the synthesized body (e.g. 64 KiB); the mock route
  should 413/504 if `JSON.stringify(mock.body).length` exceeds it, or short-circuit
  synthesis.
- Optionally cap the raw `spec` string length inside `parseSpec` (see P2-3) so the
  breadth is bounded structurally.
- Resolve `$ref` with a **visited-set** so cyclic refs are detected explicitly rather
  than relying on the depth counter (defense in depth — the depth counter happens to
  work today but is fragile against future MAX_DEPTH bumps).

---

### [P0] SSRF via publisher-controlled `servers[0].url` (cloud metadata + consumer-body exfiltration)

**Location.** `packages/shared/src/openapi.ts:55-70` (parse) +
`packages/shared/src/validate.ts:62-90` (only protocol-validated) +
`apps/gateway/src/pipeline.ts:194-218` (fetch).

```ts
// validate.ts — the ONLY publish-time gate on the upstream URL
let url: URL | null = null;
try { url = new URL(first.url); } catch { url = null; }
if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
  // error: "servers[0].url must be an http(s) URL"
}
```

```ts
// openapi.ts — servers kept verbatim
if (isRecord(s) && typeof s.url === "string" && s.url.length > 0) {
  servers.push({ url: s.url });
}
```

```ts
// pipeline.ts — publisher URL + consumer request body/headers → fetch
const upstreamUrl = new URL(joinUpstreamUrl(matched.upstreamBaseUrl, route.remainderPath));
upstreamUrl.search = incoming.search;
const upstreamHeaders = filterRequestHeaders(request.headers);
// ...
upstreamRes = await fetchImpl(upstreamUrl.toString(), { method, headers: upstreamHeaders, body: request.body, ... });
```

**Problem.** Validation only checks `protocol === "http:" || "https:"`. There is no
host blocklist, no RFC1918 / link-local / loopback rejection, no DNS-rebinding
defense (grep across `packages/shared/src` for `169.254|127.0.0.1|localhost|isPrivate|metadata`
returns zero matches). A publisher of a **public** project can set
`servers[0].url` to any of:

- `http://169.254.169.254/latest/meta-data/iam/security-credentials/<role>/` — AWS
  IMDSv1 returns IAM credentials in the body, which the gateway streams back to the
  caller (the colluding publisher hits `/gateway/...` with their own key and reads the
  metadata response).
- `http://127.0.0.1:9222/json` (or any internal admin port) — internal service
  enumeration / SSRF into the Worker's VPC.
- `http://10.x.x.x/`, `http://192.168.x.x/`, `http://[::1]/` — any RFC1918 / loopback.
- `https://attacker.example/collect` — every consumer request body (the caller's API
  payload) and surviving headers are exfiltrated to the attacker. `filterRequestHeaders`
  strips `x-zevium-key` but not the consumer's `Authorization`, cookies, or the
  request body — all of which flow to the publisher-chosen upstream.

Because the project can be `visibility: "public"`, **any** authenticated consumer's
call is proxied to the attacker's URL — the publisher doesn't even need to be the
caller to harvest traffic.

**Impact.** Cloud credential theft (IMDS), internal network probing, and wholesale
exfiltration of consumer request bodies/headers. Classic server-side request forgery
with a protocol-only gate.

**Fix.** Publish-time + runtime defense in depth:
- In `validate.ts` (shared, so it runs at `saveDraft`/`publish`): resolve the hostname
  and reject loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`), private
  (`10/8`, `172.16/12`, `192.168/16`), and `localhost`/`*.internal`/`*.local`/metadata
  hostnames. Reject if the URL carries credentials (`user:pass@`).
- At runtime in `pipeline.ts` (the gateway is the real enforcement boundary — never
  trust that the shared validator ran): re-validate the resolved IP *before* `fetchImpl`
  and pin DNS to the resolved address (or use an egress proxy with an allowlist) to
  defeat DNS rebinding / `localhost` aliases.
- Restrict `servers[0].url` to HTTPS in production.
- Document that `validateOpenApiSpec` is a UX gate, not a security boundary, and put
  the security check in the data plane.

---

### [P1] `extractPricing` is an inverted pricing table for sub-1 costs: `0` → 1 credit, `0.5` → 0 credits (free)

**Location.** `packages/shared/src/openapi.ts:144-153`.

```ts
export function extractPricing(op: OpenApiOperation): EndpointPricing {
  const costRaw = asNumber(op["x-zevium-cost"]);
  const cost = costRaw !== undefined && costRaw > 0 ? Math.floor(costRaw) : 1;  // ← 0 → 1
  const freeRaw = asNumber(op["x-zevium-free-tier"]);
  const freeTier =
    freeRaw !== undefined && freeRaw > 0 ? Math.floor(freeRaw) : undefined;
  return freeTier !== undefined ? { cost, freeTier } : { cost };
}
```

**Problem.** Three intertwined mispricings, all of which pass `validateOpenApiSpec`
(`validate.ts:139-149` only requires `typeof cost === "number" && Number.isFinite(cost) && cost >= 0`):

| `x-zevium-cost` | `costRaw` | `costRaw > 0`? | `Math.floor` | returned `cost` | publisher intent | actual charge |
|---|---|---|---|---|---|---|
| `0` | `0` | false | — | **1** | free | **1 credit** ❌ |
| `0.5` | `0.5` | true | `0` | **0** | fractional | **free** ❌ |
| `0.9` | `0.9` | true | `0` | **0** | ~1 | **free** ❌ |
| `1` | `1` | true | `1` | `1` | 1 | 1 ✓ |
| `3.9` | `3.9` | true | `3` | **3** | ~4 | **3** (floor, 23% under-charge) ❌ |

The semantics are **inverted** for sub-1 values: a publisher who types `0` (the
obvious "free endpoint" value) gets charged 1 credit per call, while a publisher who
types `0.5` or `0.9` gets a free endpoint. There is no consistent rounding mode —
`0` is special-cased to 1, but `0.5`/`0.9` floor to 0 (free), and `3.9` floors to 3
(revenue leak). `extractPricing` is the gateway's pricing source of truth, so this
propagates to:

- `apps/gateway/src/pipeline.ts:151` (`wallet.reserve(reservationId, cost, …)` —
  charges 1 on a `cost:0` endpoint, charges 0 on a `cost:0.5` endpoint).
- `apps/gateway/src/discovery.ts:64` (marketplace discovery shows wrong price).
- `apps/web/src/lib/spec-pricing.ts:34-37` and `spec-endpoints.ts:35` (publisher UI
  shows wrong min/max credits).
- `apps/web/src/routes/catalogue/$orgSlug.$projectSlug.tsx:119` (catalogue shows
  wrong price to consumers).

The `cost = 0` case is especially dangerous because a 0-credit `wallet.reserve`
likely succeeds trivially (reserves nothing), so `x-zevium-cost: 0.5` silently
becomes a free-for-all unmetered endpoint that bypasses the entire free-tier quota
mechanism.

**Impact.** Direct revenue impact (undercharging/leak), inverted publisher intent
(free endpoints charged, near-free endpoints free), and an unmetered-execution bypass
via `cost:0.5` that defeats the free-tier daily quota.

**Fix.** Make validation and extraction agree:
- `validate.ts`: require `Number.isInteger(cost) && cost >= 0` (reject fractions and
  negatives at `saveDraft`/`publish` with an error). Same for `x-zevium-free-tier`
  (see P1-2).
- `extractPricing`: drop the `> 0` special-case — `cost = Number.isInteger(costRaw) &&
  costRaw >= 0 ? costRaw : 1`. Honor `0` as free (and make `wallet.reserve(_, 0, _)`
  a documented no-op settle, or reject `cost:0` at publish if free-per-call isn't a
  supported product shape).
- Pick one rounding policy and document it; do not `Math.floor` floats that
  validation already rejected.

---

### [P1] `x-zevium-free-tier` is never validated; `extractPricing` silently floors / disables / unlimits it

**Location.** `packages/shared/src/validate.ts:118-154` (no free-tier check) +
`packages/shared/src/openapi.ts:147-152` (silent normalization).

```ts
// validate.ts — iterates operations, only inspects x-zevium-cost
const cost = opVal["x-zevium-cost"];
if (cost === undefined) { /* warning */ }
else if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) { /* error */ }
// x-zevium-free-tier: NOTHING.
```

```ts
// extractPricing — floor/disables/unlimits based on the raw value
const freeTier = freeRaw !== undefined && freeRaw > 0 ? Math.floor(freeRaw) : undefined;
```

**Problem.** `x-zevium-free-tier` is a first-class pricing knob
(`EndpointPricing.freeTier`, consumed by `pipeline.ts:159-178` and the catalogue's
`hasFreeTier`), yet `collectOpenApiSpecIssues` never inspects it. Every malformed
value silently becomes one of three unintended outcomes:

| `x-zevium-free-tier` | `extractPricing` result | effect |
|---|---|---|
| `1000000000` | `{ freeTier: 1_000_000_000 }` | publisher-funded near-unlimited free calls — no upper bound |
| `3.9` | `{ freeTier: 3 }` | silent floor, under-grants |
| `0.5` | `{ freeTier: 0 }` (returned) then pipeline `freeTier > 0` skips | silently disabled |
| `0` / `-5` / `"abc"` / `null` | `undefined` | silently disabled |

A publisher who fat-fingers `x-zevium-free-tier: 1000000000` grants a billion
publisher-funded free calls/day with zero validation feedback at save/publish time.

**Impact.** Publisher-funded cost blowup, silent quota corruption, and a validation
gap that lets adversarial publishers grant themselves effectively-unlimited free
distribution at the platform's expense (the platform still pays egress/upstream costs).

**Fix.** Add an `x-zevium-free-tier` branch to `collectOpenApiSpecIssues`: require
`Number.isInteger(v) && v >= 1` when present (error otherwise), and cap at a sane
maximum (e.g. 1_000_000). Make `extractPricing` assume pre-validated integers and stop
being load-bearing for normalization.

---

### [P1] Private project spec bodies leak via the public `specs:getPublishedForGateway` query

**Location.** `convex/specs.ts:256-318` (the `getPublishedForGateway` query).

```ts
/**
 * Public (no-auth) query for the gateway data plane.
 * Returns latest published immutable snapshot + org ids for wallet DO routing.
 */
export const getPublishedForGateway = query({
  args: { orgSlug: v.string(), projectSlug: v.string() },
  handler: async (ctx, args): Promise<{ spec: string; …; visibility: …; clerkOrgId: string; … } | null> => {
    const org = await getOrgBySlug(ctx, args.orgSlug);
    // …
    return { spec: latest.spec, …, clerkOrgId: org.clerkOrgId, visibility: project.visibility, … };
  },
});
```

**Problem.** This query is public (no `requireProjectMember`) by design — the
gateway Worker calls it keylessly to resolve the spec before the visibility check.
But the visibility check lives in `pipeline.ts:81-89`, **after** the fetch — it
controls whether the *response* is returned to the caller, not whether the *spec body*
is retrievable. The Convex query itself returns the **full spec body** + `clerkOrgId`
+ `organizationId` + `visibility` for **any** project (public *or private) given its
org+project slug. Anyone with the Convex deployment URL can call
`specs:getPublishedForGateway` directly and read a private project's spec: upstream
`servers[0].url`, pricing, response schemas, operationIds — everything.

`spec-source.ts:148-167` (`parsePublishedSpecPayload`) only re-shapes the payload; it
does not gate access. `apps/gateway/src/mock.ts` calls the same source and is
keyless.

**Impact.** Confidentiality leak of private project specifications (which include
upstream infrastructure URLs and proprietary schemas). The slugs are guessable
(`isValidSlug` allows short kebab-case, enumerable from the catalogue/Discovery API).

**Fix.** The data-plane/gateway-auth tension is real but solvable:
- Move the spec-fetch behind a Worker↔Convex shared secret (a gateway-scoped
  function key) so only the gateway can call `getPublishedForGateway`, not arbitrary
  Convex clients. Or
- Have the gateway call an authenticated internal query (`internal.query`) that the
  public surface never exposes. Or
- Return only the fields the gateway needs for the *visibility decision* first
  (`visibility`, `clerkOrgId`), and gate the `spec` body behind the key check.

---

### [P2] `Math.floor` on float `x-zevium-cost` is the wrong rounding mode for money — integer-cent contract unenforced

**Location.** `packages/shared/src/openapi.ts:146` + `packages/shared/src/pricing.ts:1-6`.

```ts
export interface EndpointPricing {
  /** Credits per call — `x-zevium-cost`, default 1 */
  cost: number;
  /** Free calls per day — `x-zevium-free-tier`, publisher-funded */
  freeTier?: number;
}
```

**Problem.** Credits are the platform's integer unit (`CREDITS_PER_DOLLAR = 10_000`,
`packages/shared/src/index.ts:5`), but `EndpointPricing.cost: number` carries no
integer invariant, and `extractPricing` applies `Math.floor` to a value validation
accepts as any finite `number >= 0`. Float credits are a money-handling smell:
`0.1 + 0.2 = 0.30000000000000004`-class bugs are one typo away, and `Math.floor`
always rounds **down** — for a platform taking a 5% cut, under-charging is the
leak direction. There is no `Number.isInteger` guard anywhere in the pricing path.

The prior `packages.shared.src.pricing.ts.md` review flagged the floor; this expands
it: the floor is not just imprecise, it is the **wrong direction** (the platform
loses on every fractional cost), and the type system does not prevent fractional
credits from existing.

**Impact.** Latent revenue leak on any fractional cost; the `cost: number` type
invites float-precision drift in downstream math (e.g. `cost * PLATFORM_CUT`).

**Fix.** Either (a) enforce `Number.isInteger(cost) && cost >= 0` at validation and
make `EndpointPricing.cost: number` a branded `IntegerCredits` type, or (b) if
fractional credits are intended, switch to integer cents internally and round
half-up at the boundary. Drop `Math.floor` once validation guarantees integers.

---

### [P2] No size cap on `parseSpec` input and no structural depth cap — parser DoS surface across 6 callers

**Location.** `packages/shared/src/openapi.ts:39-58` (`parseSpec` JSON.parse +
component-preservation) + callers `apps/gateway/src/{mock,pipeline,discovery,mcp}.ts`,
`apps/web/src/lib/{spec-pricing,spec-endpoints}.ts`, `apps/web/src/routes/catalogue/…`.

```ts
export function parseSpec(json: string): ParsedOpenApiSpec {
  let raw: unknown;
  try { raw = JSON.parse(json) as unknown; }   // ← no length pre-check
  catch (err) { … }
  // …
  const components = isRecord(raw.components)
    ? (raw.components as Record<string, unknown>)   // ← verbatim, no depth/breadth bound
    : undefined;
  // paths copied verbatim too
}
```

**Problem.** `parseSpec` is the entry point for 6 distinct call sites including the
public `/mock/*` route. There is no `json.length` pre-check, no streaming parser, no
cap on `paths` count, `components` size, or nesting depth. `JSON.parse` on a ~1 MB
Convex-stored spec is fine in isolation, but:
- The only length limit is Convex's ~1 MB document cap; nothing in `parseSpec` itself
  defends. `convex/schema.ts:46` declares `spec: v.string()` with no max-length
  validator, and `convex/specs.ts:33`/`:91`/`:163` accept any-length `spec` strings.
- `collectOpenApiSpecIssues` (`validate.ts:49-52`) also `JSON.parse`s with no length
  pre-check, on every `saveDraft` autosave tick — a pathologically large draft (under
  the doc cap) burns CPU on every 2-second autosave.
- `components` is preserved **verbatim** by reference, so the explosion potential is
  inherited by every `synthesize`/`resolveRef` consumer (see P0-1).

**Impact.** CPU-exhaustion DoS surface on every spec-consuming route; the mock route
is the worst case (public), but discovery/mcp also call `parseSpec` on
attacker-influenced published specs.

**Fix.** Add `if (json.length > MAX_SPEC_BYTES) throw new Error("spec too large")`
at the top of `parseSpec` (e.g. 256 KiB — the Convex doc cap is generous, but the
gateway doesn't need MBs). Mirror the cap in `collectOpenApiSpecIssues` and in
`convex/specs.ts` (`saveDraft`/`publish`) as a `SpecIssue` error before parsing.

---

### [P2] `validateOpenApiSpec` is a dead export whose name collides with a Convex shim alias of different return type

**Location.** `packages/shared/src/index.ts:33` (barrel) +
`packages/shared/src/validate.ts:177-183` (the `{errors,warnings}` form) +
`convex/lib/validate.ts:10` (`collectOpenApiSpecIssues as validateOpenApiSpec`).

```ts
// packages/shared/src/index.ts
export {
  // …
  collectOpenApiSpecIssues,
  validateOpenApiSpec,   // ← returns SpecValidationResult {errors, warnings}
  hasErrors,
  hasValidationErrors,
  // …
} from "./validate.js";
```

```ts
// convex/lib/validate.ts — shim
export {
  isValidSlug, isValidSemver, hasErrors, type SpecIssue,
  collectOpenApiSpecIssues as validateOpenApiSpec,   // ← returns SpecIssue[]
} from "@zevium/shared";
```

```ts
// convex/specs.ts:46, :154 + convex/dev.ts:300 — consume the ALIAS as an array
const issues = validateOpenApiSpec(args.spec);
issues.some((i) => i.level === "error");   // ← would TypeError on {errors, warnings}
```

**Verified.** Grep confirms the shared `validateOpenApiSpec` (the
`SpecValidationResult` form) has **zero external importers** — only its own unit test
`packages/shared/src/validate.test.ts:51-136` calls it. Every real consumer
(`convex/specs.ts`, `convex/dev.ts`) imports `validateOpenApiSpec` from
`convex/lib/validate`, which re-exports `collectOpenApiSpecIssues` under that name —
i.e. `SpecIssue[]`. Web/gateway consumers use `collectOpenApiSpecIssues` by its real
name.

So the symbol `validateOpenApiSpec` means two different things on either side of the
Convex/`@zevium/shared` boundary, and the shared barrel's version is dead weight
whose only effect is to make a future `import { validateOpenApiSpec } from
"@zevium/shared"` in `convex/` (the "real source" — a reasonable refactor) compile
successfully against `SpecIssue[]` call sites and then **TypeError at runtime** when
`.some` is called on `{errors, warnings}`.

**Impact.** Latent-confusion boundary contract; a one-line import-path swap in
`convex/` silently flips server-side validation return semantics and crashes.

**Fix.** Remove `validateOpenApiSpec` from the shared barrel (it's dead), or rename
the convex shim alias (`collectOpenApiSpecIssues as collectIssues`) and update the
three call sites to use the real name. Pick one canonical return shape and document it.

---

### [P2] `CREDITS_PER_DOLLAR` and `PLATFORM_CUT` are dead in the barrel; `apps/web` ships a divergent duplicate

**Location.** `packages/shared/src/index.ts:4-8`.

```ts
/** $1 = 10,000 credits (PRODUCT.md). One global constant, never per-API. */
export const CREDITS_PER_DOLLAR = 10_000;
/** Platform cut: 5%. Publishers keep 95%. */
export const PLATFORM_CUT = 0.05;
```

**Verified.** Grep for `import { … CREDITS_PER_DOLLAR|PLATFORM_CUT … } from
"@zevium/shared"` returns **zero** matches. `apps/web/src/lib/project-helpers.ts:2-5`
defines its own `export const CREDITS_PER_DOLLAR = 10_000` plus `PUBLISHER_SHARE =
0.95` and consumes those locally (`project-earnings-panel.tsx:14`,
`project-helpers.test.ts:4,13`). The shared constants and the web duplicate hold the
same value under the same name with no derivation link; `PLATFORM_CUT` (0.05) and the
web's `PUBLISHER_SHARE` (0.95) are the same fact expressed two ways.

**Impact.** A future ratio change (e.g. `12_000` credits/$, or 7% platform cut) edits
one and silently leaves the other — publisher-display math diverges from gateway
credit math with no test catching it.

**Fix.** Either wire `apps/web/src/lib/project-helpers.ts` to import
`CREDITS_PER_DOLLAR` (and `PUBLISHER_SHARE = 1 - PLATFORM_CUT`) from
`@zevium/shared` and delete the local copies, or remove the dead constants from
`index.ts` so the barrel stops claiming ownership it doesn't exercise. (Moving them
into `pricing.ts` and re-exporting would also fix the barrel's "only constants not
re-exported from a sibling" inconsistency noted in the prior index review.)

---

### [P2] `matchOperation` first-match-wins on `Object.entries(spec.paths)` — path template precedence is implicit and order-dependent

**Location.** `packages/shared/src/openapi.ts:72-104`.

```ts
for (const [template, pathItem] of Object.entries(spec.paths)) {
  // …
  const params = matchPathTemplate(template, requestPath);
  if (!params) continue;
  return { operation: op, method: m, pathTemplate: template, params, … };
}
```

**Problem.** OpenAPI does not define matching precedence between overlapping
templates. This implementation takes the **first** template (in JS object insertion
order, which is JSON key order from `JSON.parse`) whose segment count and literal
segments match. So:

- `{"/users/{id}": {"get": …}, "/users/me": {"get": …}}` — a GET `/users/me` matches
  `/users/{id}` (first) and never reaches `/users/me`. The `{id}` handler receives
  `params.id = "me"`.
- Reordering the JSON keys flips the match — non-deterministic across spec edits.

The comment acknowledges this ("First matching template wins (Object key order)"),
but it's a correctness trap: publishers must manually order specific-before-generic
templates, and there is no validation warning for shadowed routes.

**Impact.** Silent route shadowing; a publisher adding a generic route above a
specific one breaks the specific route with no error. Mock and pipeline both inherit
this.

**Fix.** Either (a) rank candidates by specificity (literal segments beat param
segments) and match the most-specific first — the standard OpenAPI-router approach;
or (b) emit a validation warning in `collectOpenApiSpecIssues` when two templates
for the same method can both match the same concrete path.

---

### [P2] `pipeline.ts` uses `reservationId = requestId` with no client idempotency key — retries double-charge

**Location.** `apps/gateway/src/pipeline.ts:139` (context caller, but driven by
`extractPricing`/`matchOperation` output).

```ts
const cost = matched.pricing.cost;
// …
const reservationId = requestId;   // ← requestId = crypto.randomUUID(), fresh per call
```

**Problem.** `requestId` is freshly generated per request (`defaultId =
crypto.randomUUID()`). The wallet's `reserve`/`duplicate`-status dedup keys on
`reservationId`, but since the id is unique per call, a consumer retry (after a
timeout, gateway 5xx, or network blip) gets a new id and **reserves and settles
again**. There is no `Idempotency-Key` header consumed from the client. This is a
shared-surface concern because `MatchedOperation`/`extractPricing` feed the reserve
amount, and the contract doc says "idempotent mutations" is a project rule.

**Impact.** Consumers are double-charged on retry; the wallet's dedup machinery is
dead weight without a stable client-supplied key.

**Fix.** Accept an optional `Idempotency-Key` request header (or reuse a client
request id header) and derive `reservationId` from it (scoped to `keyId`), falling
back to `requestId` only when absent. Document the header in the catalogue.

---

### [P3] `validateOpenApiSpec` accepts any non-empty `openapi` string — Swagger/future versions silently misparse

**Location.** `packages/shared/src/validate.ts:54-60`.

```ts
if (typeof raw.openapi !== "string" || raw.openapi.trim() === "") {
  issues.push({ level: "error", path: "$.openapi", message: "Missing openapi field…" });
}
```

**Problem.** `"openapi": "garbage"`, `"openapi": "4.0.0"`, and `"openapi": "3.0.0"`
are all equally accepted. `parseSpec` reads `servers`/`paths`/`components` which only
exist in OpenAPI 3.x; a Swagger 2.0 doc would use `swagger:` (rejected by the
`openapi` check) but a typo like `"openapi": "3.0"` (no patch) passes. No version
range check.

**Impact.** Silent misparse of malformed version strings; no early signal that the
doc isn't OpenAPI 3.x.

**Fix.** Require `/^3\.\d+(\.\d+)?$/` for `raw.openapi`.

---

### [P3] Mock only synthesizes `responses["200"]` — 201/204/default are ignored, returning `{}` with status 200

**Location.** `packages/shared/src/mock.ts:96-112` (`extractResponseSchema`).

```ts
const ok = responses["200"];
if (!isRecord(ok)) return undefined;
```

**Problem.** A POST with `responses: { "201": {…} }` and no `"200"` yields
`schema === undefined` → `body = {}` → the mock route returns `200 {}` instead of
`201`. `204 No Content` operations return `200 {}`. The `default` response is
ignored. Consumers testing against mocks get wrong status codes and empty bodies for
any non-200 success.

**Impact.** Mock responses misrepresent the contract; agent onboarding against the
mock sees incorrect statuses.

**Fix.** Iterate `201`/`202`/`204`/`default` (in that priority) for the success
schema; for `204`, return `{ status: 204, body: null }` (extend
`GeneratedMockResponse.status`).

---

### [P3] Mock matches only `content["application/json"]` exactly — charset suffixes and `+json` subtypes yield empty bodies

**Location.** `packages/shared/src/mock.ts:106`.

```ts
const media = content["application/json"];
if (!isRecord(media)) return undefined;
```

**Problem.** `application/json; charset=utf-8` (a legal and common media-type with
parameters), `application/problem+json`, `application/ld+json` all miss the exact key
lookup and produce `body = {}`. OpenAPI media types are RFC-7231 structured, not
exact strings.

**Impact.** Mocks for JSON-LD / problem-details / parameterized JSON endpoints are
empty.

**Fix.** Parse the media type with a structured header parser (or
`content-type.match(/^application\/(?:[\w.+-]+\+)?json\b/)`), taking the first JSON
variant.

---

### [P3] `resolveRef` resolves `#/components/schemas/__proto__` to `Object.prototype` (and ignores JSON Pointer `~0`/`~1` escaping)

**Location.** `packages/shared/src/mock.ts:21-37`.

```ts
const match = /^#\/components\/schemas\/([^/]+)$/.exec(ref);
// …
const target = isRecord(schemas) ? schemas[name] : undefined;
return isRecord(target) ? target : schema;
```

**Problem.** (1) `schemas["__proto__"]` returns `Object.prototype` (inherited, not
own) — `isRecord(Object.prototype)` is `true`, so `resolveRef` returns
`Object.prototype` as the "schema". `synthesize` then walks it (harmlessly returns
`{}` since `Object.prototype` has no enumerable `properties`/`example`/`enum`), but
the contract is wrong: a `$ref` to `__proto__` should be treated as unresolvable.
(2) The `[^/]+` capture doesn't decode JSON Pointer escapes (`~1` → `/`, `~0` →
`~`), so schemas whose names contain `/` or `~` (encoded in `$ref` per RFC 6901)
never resolve. (3) No `constructor`/`prototype` guards either.

**Impact.** Wrong-but-harmless mock bodies for edge-case `$ref`s; latent footgun if
`synthesize` ever gains an enumeration over inherited keys.

**Fix.** Use `Object.create(null)` for parsed schema maps, or guard with
`Object.hasOwn(schemas, name)` and reject `__proto__`/`constructor`/`prototype`.
Decode `~0`/`~1` per RFC 6901.

---

### [P3] `joinUpstreamUrl` trailing-slash replace is convoluted and the `try/catch` fallback is dead code

**Location.** `packages/shared/src/openapi.ts:159-175`.

```ts
u.pathname = `${prefix}${path === "/" ? "" : path}` || "/";
return u
  .toString()
  .replace(/\/$/, path === "/" && prefix === "" ? "/" : "");
```

**Problem.** The `.replace(/\/$/, path === "/" && prefix === "" ? "/" : "")` ternary
inside a replace is hard to reason about (intent: don't strip the root "/"). Since
`path` is `normalizePath`-ed (no trailing slash except root) and `prefix` is
`u.pathname.replace(/\/+$/, "")`, the only case `toString()` ends with `/` is
root — so the replace is effectively a no-op everywhere. The `catch { return
\`${base}${path === "/" ? "" : path}\`; }` fallback is unreachable in practice:
`validate.ts` guarantees `servers[0].url` parses as an `http(s)` URL, so
`new URL(base.includes("://") ? base : \`https://${base}\`)` cannot throw for a
published spec. Dead defensive code that misleads readers into thinking the fallback
is a real path.

**Impact.** Readability/maintainability; no live bug, but the convoluted logic
invites future edits that break the root case.

**Fix.** Simplify to `u.pathname = \`${prefix}${path === "/" ? "" : path}\` || "/";
return u.toString();` and drop the `try/catch` (or assert the URL is pre-validated
and throw a programmer error in the catch).

---

### [P3] `matchPathTemplate` accepts malformed param segments (`{a}{b}`, `{}`, empty names) without validation

**Location.** `packages/shared/src/openapi.ts:184-210`.

```ts
if (ts.startsWith("{") && ts.endsWith("}") && ts.length > 2) {
  const name = ts.slice(1, -1);
  if (!name) return null;   // ← only catches {}; { } slips through as name=" "
  params[name] = ps;
}
```

**Problem.** `{a}{b}` (two params in one segment) matches as a single param named
`a}{b`. `{ }` (space) matches as name `" "`. OpenAPI restricts param names to
`/^[A-Za-z_][A-Za-z0-9_]*$/` per segment, but nothing enforces it. These produce
garbage param names that flow into `MatchedOperation.params` (and any downstream
usage/logging). `{}` is correctly rejected by `ts.length > 2`.

**Impact.** Garbage path params for malformed templates; no validation feedback.

**Fix.** Validate the param name with the OpenAPI regex and `return null` (or warn)
on malformed templates in `collectOpenApiSpecIssues`.

---

### [P3] `parseSpec` accepts any `pathKey` (empty, spaces, unbalanced braces) as a path template

**Location.** `packages/shared/src/openapi.ts:60-71`.

```ts
for (const [pathKey, pathVal] of Object.entries(raw.paths)) {
  if (!isRecord(pathVal)) continue;
  // … no pathKey validation
  paths[pathKey] = item;
}
```

**Problem.** `pathKey` like `""`, `"users"` (no leading slash), `"/users/{unclosed"`,
or `"/users/{id}/"` (trailing slash — normalized away later) are all stored. OpenAPI
requires path templates to start with `/`. No validation warning.

**Impact.** Malformed path templates silently never match (or match unexpectedly);
no publish-time signal.

**Fix.** In `collectOpenApiSpecIssues`, warn if a path key doesn't start with `/`
or contains unbalanced braces.

---

### [P3] `undeprecateVersion` uses `ctx.db.replace` to drop optional fields — fragile against future schema additions

**Location.** `convex/specs.ts:356-381`.

```ts
await ctx.db.replace(args.versionId, {
  projectId: version.projectId,
  version: version.version,
  spec: version.spec,
  publishedAt: version.publishedAt,
});
```

**Problem.** `replace` is used to unset `deprecatedAt`/`sunsetAt`/`deprecationMessage`
because `patch` can't delete optional fields. But `replace` rewrites the *entire*
document with an explicitly-listed field set — any field added to the `specVersions`
schema later (e.g. `deprecatedById`, `replacementVersionId`) is silently dropped on
undeprecate. Also, undeprecate doesn't fire a webhook/notification (deprecate does),
leaving consumers who saw a deprecation header with no signal that it was withdrawn.

**Impact.** Future schema fields lost on undeprecate; asymmetric event surface.

**Fix.** Track the deprecation fields explicitly and `patch` them to `undefined`
once Convex supports it, or list every schema field in the `replace` and add a test
that fails when the schema grows.

---

### [P3] `getVersion` leaks version existence via 500-vs-403 distinction

**Location.** `convex/specs.ts:240-253`.

```ts
const row = await ctx.db.get(args.versionId);
if (row === null) {
  throw new Error("Spec version not found");   // → surfaces as 500-ish
}
await requireProjectMember(ctx, row.projectId); // → 403 for non-members
```

**Problem.** A non-member who guesses a valid `versionId` gets a 403 from
`requireProjectMember`; an invalid id gets "Spec version not found". The distinction
reveals whether a version exists. (Convex `v.id("specVersions")` ids are
cryptographically random, so guessing is impractical — hence P3 not higher.)

**Impact.** Theoretical existence oracle; low practical risk given id entropy.

**Fix.** Do the membership check first (against the project derived from the id's
existence), or return a uniform 404 for both null and non-member cases.

---

### [P3] Mock `explicitExample`/`enum[0]` return publisher-controlled JSON verbatim with no size/structure cap

**Location.** `packages/shared/src/mock.ts:49-71`.

```ts
function explicitExample(schema) {
  if ("example" in schema) return { found: true, value: schema.example };  // ← verbatim
  // …
}
// …
if (Array.isArray(schema.enum) && schema.enum.length > 0) {
  return schema.enum[0];   // ← verbatim, first element only
}
```

**Problem.** `schema.example` and `schema.enum[0]` short-circuit synthesis and
return publisher-controlled JSON as-is. Bounded by the Convex ~1 MB doc cap, so not
a DoS vector on its own, but: (a) the mock route returns this body with
`content-type: application/json`, so XSS is mitigated, but a publisher can still
serve misleading/malicious-looking example data to anonymous catalogue browsers
(phishing-style URLs in `example` strings); (b) a deeply nested `example` (e.g.
250k nested `{`) can stack-overflow `JSON.stringify(mock.body)` in the mock handler,
returning a 500 — minor availability niggle.

**Impact.** Trust boundary: publisher-controlled content served to anonymous users
with no sanitization; minor stringify-stack-overflow on pathological examples.

**Fix.** Cap `JSON.stringify(mock.body).length` in the mock route and 413 if
exceeded; consider sanitizing URL-shaped strings in `stringExample` (already
hardcoded to `https://example.com`) — the `example` field bypasses that safety.

---

### [P3] `parseSpec` uses `servers[0]` only — OpenAPI multi-server / server variables ignored

**Location.** `packages/shared/src/openapi.ts:55-70` + `:88` (`spec.servers[0]?.url ?? ""`).

**Problem.** `matchOperation.upstreamBaseUrl` is always `servers[0].url`. OpenAPI
supports multiple servers (prod/staging) and `servers[i].variables` (templated
URLs). A spec that lists `servers: [{url: "https://staging.example.com"}, {url:
"https://api.example.com"}]` always proxies to staging. Server variables
(`{scheme}://{host}`) are passed through raw, so `new URL("https://{host}")` throws
in `joinUpstreamUrl`'s `try` and falls to the dead `catch` (P3-9) producing a
malformed URL → `new URL(...)` in `pipeline.ts:194` throws → 500.

**Impact.** Multi-server specs misroute; templated server URLs 500.

**Fix.** Either resolve server variables (reject unknown vars at validation) or
document `servers[0]`-only as a deliberate limitation and validate that
`servers[0].url` contains no `{var}`.

---

## Summary

**Counts.** P0: **2** · P1: **3** · P2: **6** · P3: **11** — **22 findings total.**

The prior per-file reviews (openapi 4×P2+3×P3; pricing 1×P1+2×P2+1×P3; mock 1×P1+1×P2+6×P3;
index 2×P2+5×P3 = 4+4+8+7 = 23 nominal) were **verified, not just restated**: every
prior finding re-appears here with its mechanism re-checked against the current
source (e.g. the `cost:0→1` rewrite confirmed at `openapi.ts:146`; the
`validateOpenApiSpec` collision confirmed via the `convex/lib/validate.ts` shim).
Two P0s and several P1/P2s are **new**: the prior reviews treated each file in
isolation and so missed that `parseSpec`+`generateMockResponse` feed a **public
keyless** route (mock OOM DoS) and that `servers[0].url` flows unchecked into
`fetchImpl` (SSRF).

**Top 3.**

1. **[P0] Unauthenticated OOM/CPU DoS on `/mock/*`** — unbounded-breadth schema
   synthesis (`MAX_DEPTH=5` but no node/breadth/output cap). A ~300-byte published
   spec kills the Worker isolate on a single keyless GET. Cross-tenant blast radius.
2. **[P0] SSRF via `servers[0].url`** — protocol-only validation; publisher of a
   public project can point the gateway at `169.254.169.254`, internal RFC1918, or an
   attacker host, exfiltrating cloud metadata and consumer request bodies/headers.
3. **[P1] Inverted pricing table for sub-1 costs** — `x-zevium-cost: 0` charges 1
   credit (publisher-intended free), `x-zevium-cost: 0.5` charges 0 (free, bypassing
   the free-tier quota). The floor+special-case logic is load-bearing for semantics
   validation never enforced; revenue leak + unmetered-execution bypass.

**Cross-cutting theme.** The shared package is treated as a thin parsing helper, but
it is the gateway's security and pricing boundary. Two systemic gaps recur: (a)
`validateOpenApiSpec` is a UX gate that the data plane trusts as a security gate
(SSRF, size, free-tier, integer-ness all rely on it, and it checks none of them
adequately); (b) `extractPricing`/`synthesize` normalize attacker-controlled values
silently instead of rejecting them. Every "silent floor / silent disable / silent
default to 1" is a latent exploit. Fix the boundary: validate strictly at publish,
extract defensively at runtime, and put the SSRF + size + node-budget enforcement
in the gateway, not in the barrel.
