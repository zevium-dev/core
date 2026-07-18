# Tiger Deep-Dive Review — `apps/gateway/src/mock.ts` (+ `packages/shared/src/mock.ts`)

## Verdict

**Incorrect — ship blocker.** The keyless `/mock` route is an anonymous,
unauthenticated, unrate-limited, zero-credit surface that synthesizes response
bodies from publisher-controlled specs, and it has **two independent
security-regression / DoS paths that ship to production**:

1. **Private-spec information disclosure** — the keyless patch (`32d5c17`)
   added a `visibility` gate to the metered `/gateway` pipeline but **not** to
   `/mock`, so any anonymous caller who guesses an org+project slug can read
   the full response schema (paths, field names, enums, examples) of a
   **private** API. The test suite *asserts* the broken behavior.
2. **`O(N^MAX_DEPTH)` synthesis explosion** — `MAX_DEPTH = 5` bounds depth but
   not branching factor; a 2 KB self-referential spec with `N≈20` recursive
   `$ref` properties fans out to ~3.2 × 10⁶ `synthesize` calls and an output
   object tree well over the Worker's 128 MB ceiling. Anonymous + unrate-limited
   = a free publisher-planted OOM.

Beyond the two blockers, the mock drops **every** product signal the metered
pipeline carries (deprecation/Sunset/Link headers, usage analytics, real cost
reporting, edge caching), ships admitted dead code (`MockDeps.keyVerifier`),
and the synthesizer silently collapses the most common OpenAPI composition
styles (`allOf`/`oneOf`/`anyOf`/`additionalProperties`/`const`/`default`/
response-level `$ref`/`201`/`type:["string","null"]`) to `{}`, defeating the
"try-before-buy" purpose. **20 findings: P0=0, P1=2, P2=4, P3=14.**

The prior review found 2 P1 + 2 P2 + 2 P3 on the gateway file. This deep-dive
**verifies** all of those (with one factual correction on the example-size
bound) and **expands** with 12 additional findings: deprecation-header gap,
analytics blindness, missing `Cache-Control`, misleading `x-zevium-cost: "0"`,
`const`/`default`/`example:null` fidelity gaps, `__proto__` local prototype
pollution, `invalid_spec` → 404 hiding data-integrity issues, unguarded
`JSON.stringify` leak surface, slug-validation gap, array-without-items `[null]`,
`hostname` format returning a URL, and the cache-coupling hazard.

## File Stats

| File | Lines | Role |
|---|---|---|
| `apps/gateway/src/mock.ts` | 98 | Gateway `/mock/:org/:project/*` route handler (keyless, anonymous, 0 credits) |
| `packages/shared/src/mock.ts` | 180 | Spec-driven mock body synthesizer (`generateMockResponse` + `synthesize`) |
| `packages/shared/src/mock.test.ts` | 237 | Synthesizer unit tests (only `N=1` recursion case) |
| `apps/gateway/test/mock.test.ts` | 287 | Worker-level mock route tests (fixtures `visibility: "private"`) |

**Dispatch (verified, `apps/gateway/src/index.ts:198-219`):** `/mock/*` is
matched **after** `parseGatewayPath` (which only accepts `parts[0]==="gateway"`),
so mock traffic cannot leak into the metered `/gateway` pipeline. The
auth-bypass-into-metered-path concern is clear — the bugs are on the mock
surface itself and in the shared synthesizer.

**Keyless patch (verified, `git log apps/gateway/src/mock.ts`):** commit
`32d5c17` "fix: cross-org metering (consumer wallet pays, private 404s),
keyless mock, gateway CORS" simultaneously (a) added
`published.visibility !== "public" && verified.orgId !== published.clerkOrgId
→ 404` to `pipeline.ts:88-95`, and (b) deleted the mock's old
`verified.orgId !== published.clerkOrgId → 401 org_mismatch` gate — but never
added the visibility check in its place. The mock lost its only auth gate in
the same commit that introduced the visibility concept elsewhere.

## Findings

### [P1] Private project specs leaked to anonymous callers via `/mock`

**Location** — `apps/gateway/src/mock.ts:55-88` (`handleMockRequest`); the gate
that should exist is at `apps/gateway/src/pipeline.ts:88-95`.

```ts
// apps/gateway/src/mock.ts:55-67
const published = await deps.specSource.getPublishedSpec(
  route.orgSlug,
  route.projectSlug,
);
if (!published) {
  return jsonError(404, "project_not_found", "Unknown project", requestId);
}
// ← no visibility check here →
let parsed;
try {
  parsed = parseSpec(published.spec);
} catch { ... }
```

```ts
// apps/gateway/src/pipeline.ts:88-95 — the gate the mock should mirror
// Private projects only accept keys whose org owns the project — foreign
// keys get 404 (never leak that a private project exists) not 401/403.
if (
  published.visibility !== "public" &&
  verified.orgId !== published.clerkOrgId
) {
  return jsonError(404, "project_not_found", "Unknown project", requestId);
}
```

**Problem.** `handleMockRequest` calls `deps.specSource.getPublishedSpec(...)`
and immediately consumes `published.spec` to synthesize a mock body. It never
reads `published.visibility`. `ConvexSpecSource` backs onto
`specs:getPublishedForGateway` (`apps/gateway/src/spec-source.ts:43-54`,
`convex/specs.ts`), which returns *any* project with `status === "published"`
— including `visibility: "private"` — and surfaces `visibility` precisely so
the data plane can gate on it. The keyless patch removed the mock's old
`org_mismatch → 401` gate and replaced it with nothing. `parsePublishedSpecPayload`
(`spec-source.ts:159-167`) even defaults unknown/absent visibility to
`"private"` (fail-closed), but the mock never consults the field, so the
fail-closed default is wasted on the one route that needs it most.

**Impact.** Any anonymous caller who knows or guesses an `orgSlug`+`projectSlug`
pair can enumerate the **full response schema** of a private API — endpoint
paths (via the matched `pathTemplate`), field names, enum values, `example`
payloads, and `components.schemas` shapes — by hitting
`/mock/:org/:project/<path>`. This is a direct regression of the product rule
"never leak that a private project exists," a clean information-disclosure
vulnerability, and a CORS-amplified one (see P3/NEW — `withCors` sets
`Access-Control-Allow-Origin: *` on mock responses at `cors.ts:33-38`, so any
website can cross-origin probe private project mocks once the slugs are known).

**Test enshrines the bug.** `apps/gateway/test/mock.test.ts:67-71` fixtures
`visibility: "private"` and the `"keyless request serves mock"` test
(`mock.test.ts:139-152`) asserts `res.status === 200` against that private
fixture with no `authorization` header. The test *enforces* the broken
behavior — a future fix will need to flip this test, and any reviewer relying
on green tests is misled.

**Fix** — gate mock on visibility before parsing, mirroring the pipeline's
fail-closed stance:
```ts
if (published.visibility !== "public") {
  return jsonError(404, "project_not_found", "Unknown project", requestId);
}
```
Place it immediately after the `!published` check (before `parseSpec`, so a
private project's spec is never even parsed for an anonymous caller). Update
`mock.test.ts` to assert 404 for private projects and add a public-project
fixture for the happy path.

---

### [P1] `synthesize` depth cap does not bound branching — `O(N^5)` Worker OOM/CPU DoS

**Location** — `packages/shared/src/mock.ts:25-34` (`resolveRef`),
`:74-128` (`synthesize`), `:108-119` (object branch).

```ts
// packages/shared/src/mock.ts:25
const MAX_DEPTH = 5;

// packages/shared/src/mock.ts:108-119
case "object":
default: {
  if (isRecord(schema.properties)) {
    const out: Record<string, unknown> = {};
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      out[key] = synthesize(propSchema, components, depth + 1);
    }
    return out;
  }
  return {};
}
```

**Problem.** `MAX_DEPTH = 5` caps recursion **depth** but the object branch
iterates **every** entry of `schema.properties` and recurses into each at
`depth + 1` — there is no bound on **breadth** (per-object property count) or
**total node count**. `resolveRef` is one-hop per call, so a single
self-referential schema in `components.schemas` with `N` recursive `$ref`
properties expands to a full N-ary tree of depth 5:

```json
{
  "components": { "schemas": { "Node": {
    "type": "object",
    "properties": {
      "a": { "$ref": "#/components/schemas/Node" },
      "b": { "$ref": "#/components/schemas/Node" },
      ... N keys ...
    }
  }}}
}
```

**Trace.** `synthesize(Node, _, 0)` → depth 0 < 5 → recurse N props at depth 1.
Each `synthesize({$ref:Node}, _, d)` resolves `Node` (one hop), passes the
explicit-example/enum/inferType checks, then at `d < 5` recurses N props at
`d+1`. Total `synthesize` calls before the depth cap fires at `d=5`:
`Σ_{d=0}^{5} N^d ≈ N^5`. The **output object tree** is the same size (each
leaf is `depthCapValue("object")` → `{}`), and that tree is what kills the
Worker — `JSON.stringify(mock.body)` at `apps/gateway/src/mock.ts:89` then
attempts to serialize it.

**Threshold analysis (not in prior review).** Each node is a `{}` (≥ 2 bytes
serialized `"{}"`) plus the parent object overhead (~50–80 bytes per containing
object with N keys). The output is `O(N^5)` nodes:
- `N=10` → ~111 k nodes, ~6 MB — survives, wastes CPU.
- `N=15` → ~760 k nodes, ~38 MB — borderline; CPU spike.
- `N=20` → ~3.2 × 10⁶ nodes, ~160 MB — **OOM** (Worker limit 128 MB).
- `N=50` → ~3.9 × 10⁸ nodes — instant OOM + multi-second CPU before the
  Cloudflare 1101 (the prior review's number, confirmed).
- `N=100` → ~10¹⁰ nodes — absurd.

The source spec is ~2 KB for any `N` — well under Convex's ~1 MB document
limit, so the spec-size guardrail does **not** contain this. The depth-cap
doc comment (`packages/shared/src/mock.ts:62` — "stops
runaway/self-referential schemas") is false for breadth.

**Test gap (verified).** `packages/shared/src/mock.test.ts:240-289` exercises
only `N=1` (a single `child` property), which terminates in 6 `synthesize`
calls. The test claims to assert "no stack overflow / unbounded growth from
the cycle" while structurally incapable of detecting any `N>1` explosion.
`apps/gateway/test/mock.test.ts` uses a flat 2-property schema, also
incapable of detecting it.

**Impact.** The `/mock` route is deliberately keyless and anonymous
(`apps/gateway/src/mock.ts:1-8`). Any consumer can trigger this against any
published spec a publisher planted with a pathological recursive-breadth
schema; a publisher can also self-trigger. A single request exhausts the
Worker's CPU budget and 128 MB memory on one `generateMockResponse` call,
surfacing as a generic Cloudflare 1101 (internal-error leak — see the related
P3 finding on the unwrapped `JSON.stringify`) and burning platform Worker CPU
billing. There is no rate limit on `/mock` (verified — the only `rate_limited`
code in the gateway is `wallet.ts:894-898`, for grant-sync, unrelated).

**Fix** — impose a global synthesis budget (call/node counter) **and** a
per-object width cap; the width cap alone is insufficient because the
explosion is multiplicative across depth:
```ts
const MAX_DEPTH = 5;
const MAX_NODES = 4096;     // total synthesis budget
const MAX_PROPS = 64;      // per-object width cap

function synthesize(
  rawSchema: unknown,
  components: Record<string, unknown> | undefined,
  depth: number,
  budget: { count: number },
): unknown {
  if (budget.count++ > MAX_NODES) return null;
  if (!isRecord(rawSchema)) return null;
  const schema = typeof rawSchema.$ref === "string"
    ? resolveRef(rawSchema, components)
    : rawSchema;
  const explicit = explicitExample(schema);
  if (explicit.found) return explicit.value;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const type = inferType(schema);
  if (depth >= MAX_DEPTH) return depthCapValue(type);
  switch (type) {
    // ...
    case "object":
    default: {
      if (isRecord(schema.properties)) {
        const out: Record<string, unknown> = Object.create(null);
        const entries = Object.entries(schema.properties).slice(0, MAX_PROPS);
        for (const [key, propSchema] of entries) {
          out[key] = synthesize(propSchema, components, depth + 1, budget);
        }
        return out;
      }
      return Object.create(null);
    }
  }
}
```
Thread `budget` from `generateMockResponse`. Add a test with `N=50` recursive
properties asserting `budget` clamps and the body is bounded.

---

### [P2] Mock drops RFC 8594 deprecation / Sunset / Link signalling

**Location** — `apps/gateway/src/mock.ts:79-89` (response construction) vs.
`apps/gateway/src/pipeline.ts:377-391` (pipeline sets the headers).

```ts
// apps/gateway/src/mock.ts:84-89 — mock response headers
return new Response(JSON.stringify(mock.body), {
  status: mock.status,
  headers: {
    "content-type": mock.contentType,
    "x-zevium-mock": "1",
    "x-zevium-cost": "0",
    "x-zevium-request-id": requestId,
  },
});
```

```ts
// apps/gateway/src/pipeline.ts:377-391 — the signalling the mock omits
if (published.deprecatedAt !== undefined) {
  outHeaders.set("Deprecation", `@${Math.floor(published.deprecatedAt / 1000)}`);
  outHeaders.append("Link", `<https://zevium.dev/catalogue/${route.orgSlug}/${route.projectSlug}>; rel="deprecation"`);
  if (published.sunsetAt !== undefined) {
    outHeaders.set("Sunset", new Date(published.sunsetAt).toUTCString());
  }
}
```

**Problem.** `PublishedSpec` carries `deprecatedAt`, `sunsetAt`, and
`deprecationMessage` (`spec-source.ts:22-28`), and `parsePublishedSpecPayload`
faithfully propagates them. The metered pipeline surfaces them as RFC 8594
`Deprecation`/`Sunset`/`Link` headers on every response. The mock — which is
the explicit "agent onboarding / try-before-buy surface" (`mock.ts:1-8`) —
reads **none** of them. `cors.ts:11` even pre-declares `deprecation, sunset,
link` in `EXPOSE_HEADERS`, confirming the design intent that these headers
reach browser callers; the mock never sets them, so the expose-list entry is
dead for mock traffic.

**Impact.** An agent (or human) evaluating an API via `/mock` to decide
whether to integrate receives **zero warning** that the API is deprecated or
scheduled for removal. They build against a soon-to-disappear endpoint,
discover the deprecation only on first metered call, and break in production.
This is a product-rule gap on the exact surface designed to prevent that
failure mode. `deprecationMessage` (human-readable reason) is never surfaced
anywhere on the mock either.

**Fix** — mirror the pipeline's deprecation block in `handleMockRequest`
before constructing the `Response`, and optionally echo
`deprecationMessage` as `X-Zevium-Deprecation-Message`.

---

### [P2] Mock traffic is invisible to analytics — no `emitUsage`, no rate visibility

**Location** — `apps/gateway/src/mock.ts:55-89` (entire handler) vs.
`apps/gateway/src/pipeline.ts:329-371` + `:393-407` (`emitUsage` on every path).

**Problem.** The metered pipeline calls `emitUsage(ctx, deps, {...})` on
**every** outcome — success, blocked, free-tier, refunded, upstream-error —
feeding the `UsageSink` (→ Convex `recordUsage` → analytics/usage tables). The
mock handler emits **nothing**. There is no `UsageSink` in `MockDeps`
(`mock.ts:18-23`) and no `ctx` parameter (mock's signature is
`handleMockRequest(request, deps, route)` — it doesn't even receive the
`ExecutionContext`, so `ctx.waitUntil` is unavailable).

**Impact.** (1) The P1 breadth-explosion DoS is **invisible to ops** — no
spike shows in usage dashboards because mock traffic is uninstrumented. (2)
Product cannot measure try-before-buy funnel (mock hits → conversion to
metered keys), which is the core success metric of the catalogue surface
described in `mock.ts:1-8`. (3) No per-org/per-project mock-traffic signal
for abuse detection. Combined with the missing rate limit (P2 below) and
missing `Cache-Control` (P2 below), the mock is a fully dark endpoint.

**Fix** — thread `ctx: ExecutionContext` and a `usageSink: UsageSink` (or a
dedicated lightweight `MockUsageSink` interface) into `MockDeps`, and emit a
mock-specific usage event (cost: 0, outcome: "mock") on every request
including 404s. At minimum, emit on success so the funnel is measurable.

---

### [P2] No `Cache-Control` on deterministic mock 200s — CPU amplification

**Location** — `apps/gateway/src/mock.ts:84-89` (no cache header) vs.
`apps/gateway/src/discovery.ts:134-135,143-144` (discovery sets
`cache-control: public, max-age=60`).

**Problem.** A mock 200 response is a pure deterministic function of the
**immutable** published spec version + pathTemplate + method. It is the
ideal edge-cache candidate. Yet `handleMockRequest` sets no `Cache-Control`
header, so Cloudflare's edge cache never stores it and every anonymous
request re-runs `parseSpec` (JSON.parse of the full spec) + `matchOperation`
+ `synthesize` + `JSON.stringify`. The sibling `/discovery` endpoint
(`discovery.ts:134-135`) already establishes the pattern with
`cache-control: public, max-age=60`. The mock is the only public read
endpoint without it.

**Impact.** For any large-spec public project, an anonymous attacker can
hammer `/mock/:org/:project/*` to burn worker CPU time per request (compounded
by the P2 per-request re-parse and the P1 synthesis budget). With
`Cache-Control: public, max-age=60` the edge collapses identical requests to
near-zero cost. Note: caching must be keyed only on the immutable published
version — since `CachedSpecSource` caches the raw string for 30s and a
re-publish changes the spec, `max-age=60` is a safe bound (matches discovery).

**Fix** — add `"cache-control": "public, max-age=60"` to the mock 200 headers
(mirror `discovery.ts`). Do **not** cache 404s (`no-store`) to avoid negative
caching of transient states.

---

### [P2] Per-request spec re-parse + no rate limit — anonymous CPU amplification

**Location** — `apps/gateway/src/mock.ts:57-67` (re-parse) +
`apps/gateway/src/index.ts:209-214` (no rate limit on `/mock`).

```ts
// apps/gateway/src/mock.ts:57-67
let parsed;
try {
  parsed = parseSpec(published.spec);   // ← JSON.parse + full structural shaping, every request
} catch {
  return jsonError(404, "invalid_spec", "Published spec unreadable", requestId);
}
```

**Problem.** `CachedSpecSource` (`spec-source.ts:55-90`) caches the **raw spec
string** for 30s, but `handleMockRequest` calls `parseSpec(published.spec)`
(JSON.parse + full structural shaping of `paths`/`components`/`servers`) on
**every** request, then `matchOperation` + `synthesize` + `JSON.stringify`.
For a large spec the per-request CPU is dominated by `JSON.parse`. There is
no rate limiting on `/mock` (verified: the only `rate_limited` code in the
gateway is `wallet.ts:894-898` for grant-sync). An anonymous attacker can
hammer `/mock/:org/:project/*` for any large-spec public project to burn
worker CPU time.

**Impact.** CPU-amplification DoS surface on the keyless route, distinct from
the P1 synthesis explosion (this one fires on **any** large benign spec, no
malicious schema needed). The 30s raw-string cache saves only the Convex
round-trip — it does nothing for the parse cost.

**Fix** — cache the `ParsedOpenApiSpec` (and ideally the synthesized body)
in `CachedSpecSource` alongside the raw string, keyed by spec version hash;
or rely on the P2 `Cache-Control` fix above to collapse identical requests at
the edge. A per-IP rate limit is defense-in-depth.

> **Coupling hazard (new, P3):** if the P2 fix caches the parsed spec across
> requests, `synthesize`'s `explicitExample` branch returns `schema.example`
> **by reference** (`packages/shared/src/mock.ts:84-85`) without deep-cloning.
> Today this is harmless (`parseSpec` runs per request and `JSON.stringify`
> is read-only), but a cached `ParsedOpenApiSpec` would let a future caller
> that mutates the mock body corrupt the cached spec for all subsequent
> requests. Deep-clone the explicit-example value (or freeze the parsed spec)
> at the same time as introducing caching.

---

### [P2] Uncapped `example` / `enum[0]` size — publisher-amplifiable body

**Location** — `packages/shared/src/mock.ts:84-104` (`explicitExample`),
`:89-91` (enum return), `:86-88` (explicit return precedes depth check).

```ts
// packages/shared/src/mock.ts:86-91
const explicit = explicitExample(schema);
if (explicit.found) return explicit.value;   // ← returned BEFORE depth >= MAX_DEPTH check
...
if (Array.isArray(schema.enum) && schema.enum.length > 0) {
  return schema.enum[0];                       // ← also unbounded
}
...
if (depth >= MAX_DEPTH) return depthCapValue(type);
```

**Problem.** `explicitExample` returns `schema.example` /
`schema.examples[0]` / `Object.values(schema.examples)[0].value` **verbatim**,
and `synthesize` returns it before the `depth >= MAX_DEPTH` check, so
`MAX_DEPTH` does not apply to explicit examples or enum values. A published
spec whose response schema carries a large `example` object (or a single large
`enum` string) is `JSON.stringify`d in full on every anonymous `/mock` request
(`apps/gateway/src/mock.ts:89`).

**Correction to prior review.** The prior review claimed "a published spec
whose response schema carries `example: <100MB nested object>`". This is
impossible: Convex enforces a ~1 MB document limit on the stored spec string,
so `published.spec` is ≤ ~1 MB and any single `example` value within it is
bounded by that. The amplification is therefore **~1 MB per request**, not
100 MB — still meaningful (1 MB × thousands of anonymous unrate-limited
requests = bandwidth + `JSON.stringify` CPU), and the synthesized output can
still **far exceed** the spec size via the P1 recursive-`$ref` expansion (the
output is `O(N^5)`, the spec is `O(N)`). So the size-cap finding stands, but
the bound is ~1 MB for the explicit-example path and unbounded for the
synthesis path.

**Impact.** Per-request memory/CPU amplification on the keyless route,
anonymously triggerable against any spec with a large example. Combined with
the missing `Cache-Control` (P2) and missing rate limit (P2), a free-tier
publisher can plant a pathological example and amplify.

**Fix** — cap serialized body length in `handleMockRequest` (reject/truncate
above e.g. 256 KB → `jsonError(413, "payload_too_large", ...)`) and/or cap the
synthesis node budget (P1 fix covers this). Caching the synthesized body
keyed by `(specVersion, pathTemplate, method)` makes the per-request cost
amortized to zero.

---

### [P3] Dead code — `MockDeps.keyVerifier` plumbed but unused

**Location** — `apps/gateway/src/mock.ts:18-23` (type),
`apps/gateway/src/index.ts:118-122` (`mockDeps` passes it),
`apps/gateway/test/mock.test.ts:50-58` (fixtures construct a
`FixtureKeyVerifier` for the keyless route).

```ts
// apps/gateway/src/mock.ts:18-23
export type MockDeps = {
  /** Unused since mock went keyless; kept so test deps stay uniform. */
  keyVerifier?: KeyVerifier;
  specSource: SpecSource;
  idGenerator?: () => string;
};
```

**Problem.** The keyless patch left `keyVerifier?: KeyVerifier` on `MockDeps`
with an explicit "Unused" comment, and `mockDeps()` (`index.ts:118-122`) still
passes `keyVerifier: deps.keyVerifier`. Nothing in `handleMockRequest` reads
`deps.keyVerifier`. This is admitted dead code that actively misleads readers
and reviewers into thinking the mock does any auth at all — exactly the wrong
signal next to a route that just lost its auth gate (P1). It also forces every
test fixture to construct a `FixtureKeyVerifier` even when testing the keyless
path (`mock.test.ts:50-58`).

**Fix** — drop `keyVerifier` from `MockDeps` and from `mockDeps()`. If
test-deps uniformity genuinely matters, factor a shared `WorkerDeps` subset
instead of carrying a dead field on the mock's public type. Remove the now-
unnecessary `FixtureKeyVerifier` construction from mock test fixtures.

---

### [P3] Only `responses["200"]` + exact `application/json` honored — 201/202/default/`+json` collapse to `{}`

**Location** — `packages/shared/src/mock.ts:147-158` (`extractResponseSchema`).

```ts
// packages/shared/src/mock.ts:151-158
const ok = responses["200"];
if (!isRecord(ok)) return undefined;
const content = ok.content;
if (!isRecord(content)) return undefined;
const media = content["application/json"];
if (!isRecord(media)) return undefined;
return media.schema;
```

**Problem.** Operations whose success response is `201 Created` / `202
Accepted` / `2XX` / `default` (standard for POST/PUT) yield
`schema === undefined` → `generateMockResponse` falls back to `{}`. Same for
media types `application/json; charset=utf-8`, `application/vnd.foo+json`,
`application/problem+json` — none match the exact `application/json` key. The
caller (`mock.ts:80-87`) then returns HTTP 200 with an empty object, which is
a poor try-before-buy experience for create endpoints and silently
misrepresents the response shape. (`generateMockResponse` returns `null` only
when the *operation* is unknown, not when the response is missing — so this
is a silent quality gap, not a crash.)

**Fix** — scan `2xx` then `default`; match `application/json` and any
`*+json` media type:
```ts
const ok = responses["200"] ?? responses["201"] ?? responses["202"]
  ?? responses["2XX"] ?? responses["default"];
// ...
const media = content["application/json"]
  ?? Object.entries(content).find(([k]) => k === "application/json"
      || k.endsWith("+json"))?.[1];
```

---

### [P3] `allOf` / `oneOf` / `anyOf` / `additionalProperties` silently produce `{}`

**Location** — `packages/shared/src/mock.ts:108-119` (object branch only
consults `schema.properties`).

**Problem.** The object branch only reads `schema.properties`. Schemas
expressed via `allOf`/`oneOf`/`anyOf` (extremely common in real OpenAPI specs
— `PaginatedResponse: allOf: [BaseResponse, { properties: { items: [...] } }]`)
have no top-level `properties` and synthesize to `{}`, even when every member
has rich properties. Likewise `additionalProperties: {schema}` with no
`properties` yields `{}`. The mock silently returns an empty object for the
most common composition style in published specs, defeating the try-before-buy
purpose.

**Fix** — for `allOf`, merge member `properties` (respecting the P1 node
budget); for `oneOf`/`anyOf`, synthesize the first member; for
`additionalProperties`, emit one sample key (e.g. `"key"`).

---

### [P3] `type: "null"` and multi-type arrays (`type: ["string","null"]`) synthesize as `{}`

**Location** — `packages/shared/src/mock.ts:67-72` (`inferType`) + `:95-128`
(switch has no `null` case).

```ts
// packages/shared/src/mock.ts:67-72
function inferType(schema: Record<string, unknown>): string {
  if (typeof schema.type === "string") return schema.type;  // ← arrays fall through
  if (isRecord(schema.properties)) return "object";
  if (schema.items !== undefined) return "array";
  return "object";
}
```

**Problem.** JSON Schema / OpenAPI 3.1 permits `type` to be an array
(`{ type: ["string", "null"] }`). `typeof schema.type === "string"` is `false`
for arrays → falls through to `"object"` → synthesizes `{}`. A declared
`type: "null"` returns `"null"` from `inferType` but the switch has no
`case "null"` → default object branch → `{}` instead of `null`. Fidelity bug
for nullable fields and explicit null types; consumers trying the API see an
object where the spec promises `null` or a string-or-null.

**Fix:**
```ts
function inferType(schema: Record<string, unknown>): string {
  const t = schema.type;
  if (typeof t === "string") return t;
  if (Array.isArray(t) && t.length > 0) return t[0] as string;
  if (isRecord(schema.properties)) return "object";
  if (schema.items !== undefined) return "array";
  return "object";
}
// in the switch:
case "null":
  return null;
```

---

### [P3] Response-level and media-type `$ref` not resolved

**Location** — `packages/shared/src/mock.ts:151-163` (`extractResponseSchema`).

**Problem.** `responses["200"]` may itself be
`{ $ref: "#/components/responses/Foo" }` — `isRecord` is true but
`ok.content` is undefined → returns `undefined` → body falls back to `{}`. Same
for `content["application/json"]: { $ref: ... }`. One-hop `$ref` resolution
only happens inside `synthesize`, not at the response/media-type layer. The
`resolveRef` helper exists but is not reused here, and `resolveRef`'s regex
only matches `#/components/schemas/...` (not `#/components/responses/...`), so
it would need generalizing. Any spec that factors its 200 response through
`components.responses` gets an empty mock.

**Fix** — resolve `$ref` in `extractResponseSchema` (generalize `resolveRef`
to also accept `#/components/responses/...`, or add a dedicated resolver).

---

### [P3] `__proto__` / `constructor` local prototype pollution via `properties` keys

**Location** — `packages/shared/src/mock.ts:108-119` (object branch),
`:28-31` (`resolveRef` lookup).

```ts
// packages/shared/src/mock.ts:111-115
const out: Record<string, unknown> = {};
for (const [key, propSchema] of Object.entries(schema.properties)) {
  out[key] = synthesize(propSchema, components, depth + 1);
}
```

```ts
// packages/shared/src/mock.ts:28-31 — resolveRef lookup
const name = match[1]!;
const schemas = isRecord(components) ? components.schemas : undefined;
const target = isRecord(schemas) ? schemas[name] : undefined;
```

**Problem (two related sinks).** (1) `out` is a plain `{}`. `JSON.parse`
creates `__proto__` as an **own** property (it does not trigger the setter),
so `Object.entries(schema.properties)` yields `[["__proto__", {...}]]`, and
`out["__proto__"] = synthesize(...)` triggers the `Object.prototype.__proto__`
setter — setting `out`'s `[[Prototype]]` to the synthesized value rather
than creating an own property. The effect is **local** to `out` (it does not
pollute `Object.prototype` globally), and `JSON.stringify(out)` drops
inherited properties so the serialized output is unaffected. But the returned
`out` object has an unexpected prototype chain, and the pattern becomes a
real prototype-pollution sink the day any code path inspects `out` with `in` /
`hasOwnProperty` inversion / property access rather than `JSON.stringify`.

(2) `resolveRef` does `schemas[name]` where `name` is `[^/]+` — arbitrary
attacker-controlled string. For `$ref: "#/components/schemas/__proto__"` when
`schemas` has no own `__proto__`, `schemas["__proto__"]` returns
`Object.prototype`, which `isRecord` accepts. `synthesize` then processes
`Object.prototype` as a schema (benign today — `Object.entries` is empty —
but the same unsafe-lookup pattern).

**Impact.** No global pollution today; serialization is safe. This is
defense-in-depth: the lookup pattern is unsafe and the day a polyfill or
dependency populates a prototype, these become real. The P1 node-budget fix
should use `Object.create(null)` for `out` and
`Object.prototype.hasOwnProperty.call(schemas, name)` for the lookup.

**Fix:**
```ts
const out: Record<string, unknown> = Object.create(null);
// ...
if (Object.prototype.hasOwnProperty.call(schemas, name)) {
  const target = schemas[name];
  return isRecord(target) ? target : schema;
}
return schema;
```

---

### [P3] `generateMockResponse` + `JSON.stringify` unguarded — 1101 internal-error leak

**Location** — `apps/gateway/src/mock.ts:80-89`.

```ts
// apps/gateway/src/mock.ts:80-89
const mock = generateMockResponse(parsed, matched.pathTemplate, matched.method);
if (!mock) {
  return jsonError(404, "route_not_found", "Unknown route", requestId);
}
return new Response(JSON.stringify(mock.body), { ... });
```

**Problem.** Unlike `parseSpec` (wrapped in try/catch at `:61-67`),
`generateMockResponse` and `JSON.stringify(mock.body)` are unwrapped. The P1
breadth-explosion path is the obvious route to a thrown exception here (stack
overflow before the depth cap bites on extreme `N`, or `JSON.stringify` on a
multi-hundred-MB object throwing `RangeError: Invalid string length`), which
propagates to the Worker fetch handler and surfaces as a generic Cloudflare
1101 — an internal-error leak, and a different shape from the curated
`jsonError` envelopes used everywhere else. The pipeline does not have this
problem because its body is a streamed `Response`, not a `JSON.stringify` of
a synthesized object.

**Fix** — defense-in-depth: wrap in try/catch and return
`jsonError(500, "mock_failed", "Mock unavailable", requestId)`:
```ts
let mock;
try {
  mock = generateMockResponse(parsed, matched.pathTemplate, matched.method);
} catch {
  return jsonError(500, "mock_failed", "Mock unavailable", requestId);
}
if (!mock) return jsonError(404, "route_not_found", "Unknown route", requestId);
let bodyJson: string;
try {
  bodyJson = JSON.stringify(mock.body);
} catch {
  return jsonError(500, "mock_failed", "Mock unavailable", requestId);
}
return new Response(bodyJson, { ... });
```

---

### [P3] `x-zevium-cost: "0"` hardcoded despite real cost being available — misleading pricing signal

**Location** — `apps/gateway/src/mock.ts:86` vs.
`apps/gateway/src/pipeline.ts:373` (pipeline uses `String(usedFree ? 0 : cost)`).

```ts
// apps/gateway/src/mock.ts:84-89
return new Response(JSON.stringify(mock.body), {
  status: mock.status,
  headers: {
    "content-type": mock.contentType,
    "x-zevium-mock": "1",
    "x-zevium-cost": "0",           // ← hardcoded; matched.pricing.cost available
    "x-zevium-request-id": requestId,
  },
});
```

**Problem.** `matched` is the `MatchedOperation` returned by
`matchOperation` (`packages/shared/src/openapi.ts:91-114`), which carries
`matched.pricing.cost` (the real per-call cost extracted from
`x-zevium-cost`/`x-zevium-free-tier`). The mock ignores it and always reports
`x-zevium-cost: "0"`. An agent probing via mock sees `cost: 0` and may assume
the real endpoint is free; a dashboard that reads `x-zevium-cost` to display
pricing will show "0 credits" for the mock sample and mislead the user about
the metered cost. The `x-zevium-mock: "1"` header disambiguates for callers
that check it, but callers that read only `x-zevium-cost` are misled.

**Fix** — either echo the real cost with a mock marker:
`"x-zevium-cost": String(matched.pricing.cost)`, keeping `x-zevium-mock: "1"`
to indicate the call itself is free; or omit `x-zevium-cost` on mock responses
entirely so it cannot be misread as the metered price. The current "0" is the
worst of both — it looks authoritative and is wrong.

---

### [P3] `const` and `default` keywords ignored — common fidelity gap

**Location** — `packages/shared/src/mock.ts:86-95` (synthesize checks
`example`/`examples`/`enum`/`type` but not `const`/`default`).

**Problem.** JSON Schema supports `const: "approved"` (single allowed value)
and `default: 42` (default value). `synthesize` checks neither. A schema
with `const: "approved"` and no `enum`/`example` falls through to `inferType`
→ `string` → returns `"string"` instead of `"approved"`. A schema with
`default: 42` and `type: integer` returns `0` instead of `42`. Both are
common in real published specs (status fields, config defaults). The mock
misrepresents the response shape.

**Fix** — add `const` and `default` checks before the `type` switch, after
`explicitExample`:
```ts
if ("const" in schema) return schema.const;
if ("default" in schema) return schema.default;
```

---

### [P3] `explicitExample` returns `example: null` as the body

**Location** — `packages/shared/src/mock.ts:84-85`.

```ts
// packages/shared/src/mock.ts:84-85
if ("example" in schema) return { found: true, value: schema.example };
```

**Problem.** A schema with `"example": null` (valid JSON, valid OpenAPI for
nullable fields) returns `{ found: true, value: null }`, so `synthesize`
returns `null` as the **entire** mock body for that node. If the field is
intentionally nullable and the example is explicitly `null`, this is
arguably correct; if the publisher accidentally set `example: null`, the
mock returns `null` for the whole object, masking the real shape. There is
no distinction between "explicit null example" and "missing example that
happened to be null." Also, `"example" in schema` is true even for
`example: undefined` if the object was constructed in JS with the key present
— but since specs come from `JSON.parse` (which never produces `undefined`),
this is only a theoretical concern for the parsed path.

**Fix** — only treat `example` as found if it's not `undefined`, and decide
explicitly whether `null` is a valid whole-body example (it usually is for
nullable fields, but document the choice):
```ts
if ("example" in schema && schema.example !== undefined) {
  return { found: true, value: schema.example };
}
```

---

### [P3] Array without `items` → `[null]`; `hostname`/`password`/`byte` formats mishandled

**Location** — `packages/shared/src/mock.ts:96-101` (array branch),
`:37-54` (`stringExample`).

```ts
// packages/shared/src/mock.ts:96-101
case "array": {
  const item = synthesize(schema.items, components, depth + 1);
  return [item];
}
```

**Problem (array).** A schema with `type: array` but no `items` (valid JSON
Schema, means "array of anything") calls `synthesize(undefined, ...)` →
`isRecord(undefined)` is false → returns `null` → mock body is `[null]`.
Should be `[]` when `items` is absent.

```ts
// packages/shared/src/mock.ts:46-47
case "uri":
case "url":
case "hostname":
  return "https://example.com";
```

**Problem (formats).** `format: "hostname"` returns `"https://example.com"`,
which is a URL, not a hostname (should be `"example.com"`). `format:
"password"` returns `"string"` — harmless but a mock returning the literal
`"string"` for a password field is a minor fidelity wart. `format: "byte"`
and `format: "binary"` return `"string"` instead of base64 / a binary
placeholder. Minor, but these are real OpenAPI formats.

**Fix** — array: `if (!isRecord(schema.items)) return [];` before
synthesizing. Formats: add `"hostname": "example.com"`, `"password": "********"`,
`"byte": "c3RyaW5n"`, `"binary": "<binary>"`.

---

### [P3] `invalid_spec` returns HTTP 404 — hides server-side data-integrity issues

**Location** — `apps/gateway/src/mock.ts:61-67` (and identically in
`apps/gateway/src/pipeline.ts:81-87`).

```ts
// apps/gateway/src/mock.ts:61-67
} catch {
  return jsonError(404, "invalid_spec", "Published spec unreadable", requestId);
}
```

**Problem.** A published spec that fails `parseSpec` (broken JSON or non-
object root) is a **server-side data-integrity problem** — the control plane
allowed an invalid spec to be published. Returning HTTP 404 conflates "project
not found" with "project's spec is corrupted," hiding the failure from
monitoring/alerting that keys on 5xx rates. This is consistent with the
pipeline's choice (`pipeline.ts:81-87`), so it's a debatable design decision,
not a mock-specific bug — but the mock is the place a fix would land first
since it's the simpler handler.

**Fix** — return 500 (or 503) for `invalid_spec` to surface the integrity
failure, keeping the opaque `message`. Apply consistently to the pipeline
too. (If 404 is intentional to avoid confirming the project exists, document
that and add server-side alerting on the `invalid_spec` code.)

---

### [P3] `parseMockPath` does not validate slug format or length

**Location** — `apps/gateway/src/mock.ts:25-36`.

```ts
// apps/gateway/src/mock.ts:25-36
export function parseMockPath(pathname: string): MockRoute | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "mock") return null;
  if (!parts[1] || !parts[2]) return null;
  const orgSlug = parts[1];
  const projectSlug = parts[2];
  const rest = parts.slice(3);
  const remainderPath = rest.length === 0 ? "/" : `/${rest.join("/")}`;
  return { orgSlug, projectSlug, remainderPath };
}
```

**Problem.** `orgSlug` and `projectSlug` are taken verbatim with no length
cap and no character validation. They flow into
`specSource.getPublishedSpec(orgSlug, projectSlug)` → Convex query
`specs:getPublishedForGateway`. A 100 KB slug is passed to Convex as a query
argument (wasteful), and any string (including `.`, `..`, control
characters, newlines) is accepted. Since the lookup returns null on no match
and the slug is used only as a hash key (not a file path or interpolated into
markup), there's no traversal or injection — but the lack of a length cap is
a minor abuse vector (large query args), and if any logging echoes the slug
verbatim, control characters could be a log-injection vector. The remainder
path is also passed unvalidated to `matchOperation`, which is fine (it only
does segment matching) but worth noting.

**Fix** — cap slug length (e.g. 64 chars) and require a slug regex
(`/^[a-z0-9-]+$/`) consistent with whatever the publish path enforces; reject
early with 404. At minimum, cap length to prevent oversized query args.

---

## Summary

| Sev | Count | Top 3 |
|---|---|---|
| P0 | 0 | — |
| P1 | 2 | Private-spec leak via keyless `/mock` (test enshrines the bug); `O(N^5)` synthesis OOM — threshold `N≈20` |
| P2 | 4 | Mock drops RFC 8594 deprecation/Sunset/Link; mock traffic invisible to analytics; no `Cache-Control` on deterministic 200s; per-request spec re-parse + no rate limit |
| P3 | 14 | Dead `keyVerifier`; only `200`/`application/json`; `allOf`/`oneOf`/`anyOf`/`additionalProperties` → `{}`; `type:null`/multi-type → `{}`; response-level `$ref`; `__proto__` local pollution; unguarded `JSON.stringify` → 1101 leak; misleading `x-zevium-cost:"0"`; `const`/`default` ignored; `example:null` as body; array-without-`items` → `[null]` + format nits; `invalid_spec` → 404; `parseMockPath` slug validation; cache-coupling hazard |

**Highest-impact fix:** add
`if (published.visibility !== "public") return jsonError(404, "project_not_found", "Unknown project", requestId)`
at the top of `handleMockRequest` (P1). The keyless patch's stated intent was
"anonymous try-before-buy surface for the catalogue" — that is only correct
for *public* projects, and the `/gateway` pipeline already encodes the exact
rule the mock should mirror. Second: thread a node budget through `synthesize`
(P1) — without it, any publisher can OOM any Worker isolate anonymously.

**Prior-review verification summary.** All 6 prior findings on the gateway
file and all 8 on the shared file are confirmed. One factual correction: the
prior "100 MB example" claim is impossible (Convex ~1 MB document limit
bounds the stored spec), so the explicit-example amplification is ~1 MB per
request, not 100 MB — still a P2 but for the right reason. The 12 new
findings (deprecation gap, analytics blindness, missing `Cache-Control`,
misleading cost header, `const`/`default`/`example:null` fidelity, `__proto__`
local pollution, `JSON.stringify` leak, slug validation, array/format nits,
`invalid_spec` status, cache-coupling hazard) are net-new and not in the
prior review.
