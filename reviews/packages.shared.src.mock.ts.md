# Tiger Review — `packages/shared/src/mock.ts`

## Verdict

**Incorrect.** The depth cap (`MAX_DEPTH = 5`) prevents infinite recursion on
self-referential `$ref` schemas but does **not** bound total work: a tiny
malicious spec with N recursive `$ref` properties fans out to N^5 synthesize
calls and a N^5-node output object, OOM/CPU-exhausting the Worker on the
keyless `/mock` endpoint. Additional fidelity gaps (unhandled composition
keywords, multi-type/null types, response-level `$ref`) and a slab of admitted
dead code round out the issues.

## File Stats

- File: `packages/shared/src/mock.ts`
- Lines reviewed: full file (1–184) plus cross-file context:
  `packages/shared/src/openapi.ts`, `apps/gateway/src/mock.ts`,
  `apps/gateway/src/index.ts`, `apps/gateway/src/errors.ts`,
  `packages/shared/src/mock.test.ts`.
- Callers of `generateMockResponse`: `apps/gateway/src/mock.ts` (sole consumer,
  in `handleMockRequest`).
- Callers of `handleMockRequest`/`parseMockPath`: `apps/gateway/src/index.ts`
  (routes `/mock/:orgSlug/:projectSlug/*`).

## Findings

### [P1] Breadth explosion via recursive `$ref` defeats the depth cap (Worker DoS)

**Location:** `packages/shared/src/mock.ts:80-104` (`synthesize`, object/array
recursion) + `packages/shared/src/mock.ts:25-34` (`resolveRef`).

```ts
const MAX_DEPTH = 5;
// ...
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

`MAX_DEPTH` caps recursion **depth**, but each level iterates **every** entry
of `properties` and recurses with `depth + 1` — there is no bound on **breadth**
or **total node count**. `$ref` resolution is one hop per `synthesize` call, so
a self-referential schema with N recursive `$ref` properties expands to a full
N-ary tree of depth 5:

```
Node: { type: object, properties: {
  a: { $ref: "#/components/schemas/Node" },
  b: { $ref: "#/components/schemas/Node" },
  ... 50 keys
}}
```

Synthesis call count: `Σ N^d for d in 0..5` = ~`N^5` leaf calls. For N=50 →
~3.9 × 10^8 calls; for N=100 → ~10^10. The output object tree has the same
node count (each leaf `depthCapValue("object")` → `{}`), so `JSON.stringify`
(`apps/gateway/src/mock.ts:89`) then attempts to serialize hundreds of millions
of nodes. The source spec is ~2 KB — well under any Convex document limit — so
the size guardrail on the spec does **not** contain this.

**Impact:** The `/mock/:org/:project/*` route is deliberately keyless and
anonymous (`apps/gateway/src/mock.ts:1-8`). Any consumer can trigger this
against any published spec that a publisher planted with a pathological
recursive-breadth schema; a publisher can also self-trigger. Each request
exhausts the Worker's CPU budget (and 128 MB memory) on a single
`generateMockResponse` call, returning a generic Cloudflare 1101 exception
(internal-error leak) and burning platform Worker CPU billing. The depth-cap
comment ("stops runaway/self-referential schemas") is false for breadth.

**Trigger:** publish a spec whose `responses["200"]` schema is `{$ref:
"#/components/schemas/Node"}` with `Node` as above, then `GET /mock/<org>/<proj>/tree`.

**Fix:** impose a global synthesis budget — e.g. a mutable call counter or
output-node cap checked at each recursion, returning `depthCapValue(type)`
when exceeded; also cap `Object.keys(properties).length` per object (e.g.
`maxProperties = 64`).

```ts
const MAX_NODES = 1024;

function synthesize(
  rawSchema: unknown,
  components: Record<string, unknown> | undefined,
  depth: number,
  budget: { count: number },
): unknown {
  if (budget.count++ > MAX_NODES) return null;
  if (!isRecord(rawSchema)) return null;
  // ... existing logic, threading `budget` into recursive calls
}
```

### [P2] No total output-size / call-count guardrail on synthesis

**Location:** `packages/shared/src/mock.ts:74-115` (`synthesize`).

Even ignoring `$ref` recursion, `synthesize` has no global cap on the number of
nodes it will produce. A spec with a broad-but-shallow object (e.g. thousands
of properties, each a small nested object) is bounded only by the spec size —
which for a Convex document can be ~1 MB, enough to encode tens of thousands
of properties and produce multi-MB mock responses per request. Combined with
the keyless route and no rate limiting in the Worker, this is a cost/memory
amplification surface. The existing depth cap is a depth guard only; it is
not the "size/depth limits" the review brief asks for.

**Fix:** in addition to the per-call budget suggested above, cap the
serialized response size in `handleMockRequest` and short-circuit to a 404
(`payload_too_large`) when exceeded.

### [P3] `$ref` name lookup via `schemas[name]` without own-property check

**Location:** `packages/shared/src/mock.ts:28-31`.

```ts
const name = match[1]!;
const schemas = isRecord(components) ? components.schemas : undefined;
const target = isRecord(schemas) ? schemas[name] : undefined;
return isRecord(target) ? target : schema;
```

`name` is `[^/]+` from the ref regex — arbitrary attacker-controlled string
(the publisher controls the spec). For `$ref: "#/components/schemas/__proto__"`
when `schemas` has no own `__proto__` key, `schemas["__proto__"]` returns
`Object.prototype`, which `isRecord` accepts (`typeof === "object"`, non-null,
non-array). `synthesize` then processes `Object.prototype` as a schema.
In a clean runtime `Object.entries(Object.prototype)` is empty, so the output
collapses to `{}` — benign today, but it is an unsafe lookup pattern that
becomes a real prototype-pollution sink the day any prototype is non-empty
(e.g. a polluted polyfill or a future dependency). Use
`Object.prototype.hasOwnProperty.call(schemas, name)` and `Object.create(null)`
for `out` in the object branch.

### [P3] `type: "null"` and multi-type arrays (`type: ["string","null"]`) synthesize as `{}`

**Location:** `packages/shared/src/mock.ts:67-72` (`inferType`) + `:95-114`.

```ts
function inferType(schema: Record<string, unknown>): string {
  if (typeof schema.type === "string") return schema.type;
  if (isRecord(schema.properties)) return "object";
  if (schema.items !== undefined) return "array";
  return "object";
}
```

JSON Schema / OpenAPI 3.1 permits `type` to be an array
(`{ type: ["string", "null"] }`). `typeof schema.type === "string"` is `false`
for arrays, so these fall through to `"object"` and synthesize to `{}`. A
declared `type: "null"` returns `"null"` from `inferType` but the switch has no
`case "null"` → default `object` branch → `{}` instead of `null`. Fidelity bug
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

### [P3] `allOf` / `oneOf` / `anyOf` / `additionalProperties` silently produce `{}`

**Location:** `packages/shared/src/mock.ts:95-114` (object branch).

The object branch only consults `schema.properties`. Schemas expressed via
`allOf`/`oneOf`/`anyOf` (extremely common in real OpenAPI specs —
`PaginatedResponse: allOf: [BaseResponse, { properties: { items: ... } }]`)
have no `properties` at top level and synthesize to `{}`, even when every
member has rich properties. Likewise `additionalProperties: {schema}` with no
`properties` yields `{}`. The mock silently returns an empty object for the
most common composition style in published specs, defeating the
try-before-buy purpose of the endpoint.

**Fix:** for `allOf`, merge member `properties` (respecting the budget from P1);
for `oneOf`/`anyOf`, synthesize the first member; for `additionalProperties`,
emit one sample key.

### [P3] Response-level and media-type `$ref` not resolved

**Location:** `packages/shared/src/mock.ts:151-163` (`extractResponseSchema`).

```ts
const ok = responses["200"];
if (!isRecord(ok)) return undefined;
const content = ok.content;
```

`responses["200"]` may itself be `{$ref: "#/components/responses/Foo"}` —
`isRecord` is true but `ok.content` is undefined → returns undefined → body
falls back to `{}`. Same for `content["application/json"]: {$ref: ...}`.
One-hop `$ref` resolution only happens inside `synthesize`, not at the
response/media-type layer, so any spec that factors its 200 response through
`components.responses` gets an empty mock. The `resolveRef` helper exists but
is not reused here.

### [P3] Only exact status `200` and exact `application/json` content type are honored

**Location:** `packages/shared/src/mock.ts:155-161`.

```ts
const ok = responses["200"];
// ...
const media = content["application/json"];
```

Operations whose success response is `201`/`202`/`2XX`/`default`, or whose
media type is `application/json; charset=utf-8` or
`application/vnd.foo+json`, get an empty `{}` body. For `201`-only create
endpoints (extremely common for POST), the mock returns `{}` regardless of
what the spec declares. Fidelity, not security.

### [P3] Admitted dead code: `MockDeps.keyVerifier`

**Location:** `apps/gateway/src/mock.ts:18-22` and `apps/gateway/src/index.ts:118-123`.

```ts
export type MockDeps = {
  /** Unused since mock went keyless; kept so test deps stay uniform. */
  keyVerifier?: KeyVerifier;
  specSource: SpecSource;
  idGenerator?: () => string;
};
```

The comment concedes `keyVerifier` is dead — mock went keyless. `mockDeps()` in
`index.ts` still constructs and passes it on every mock request. This is the
"remove obsolete code — no leftover comments, aliases, or re-exports" case:
either delete the field (and the `KeyVerifier` import if now unused) or
document why a future key path will need it. Keeping dead optional fields
invites a future change to silently re-introduce key-gating on the keyless
endpoint (a real product-rule violation: "no unmetered execution paths").

### [P3] `generateMockResponse` call in `handleMockRequest` is unguarded

**Location:** `apps/gateway/src/mock.ts:80-89`.

```ts
const mock = generateMockResponse(parsed, matched.pathTemplate, matched.method);
if (!mock) {
  return jsonError(404, "route_not_found", "Unknown route", requestId);
}
return new Response(JSON.stringify(mock.body), { ... });
```

Unlike `parseSpec` (wrapped in try/catch at `:61-67`), `generateMockResponse`
and `JSON.stringify(mock.body)` are unwrapped. The P1 breadth path is the
obvious route to a thrown exception here (stack overflow before the depth cap
bites, or `JSON.stringify` on a multi-hundred-MB object throwing a range
error), which propagates to the Worker fetch handler and surfaces as a
generic Cloudflare 1101 — an internal-error leak, and a different shape from
the curated `jsonError` envelopes used everywhere else. Defense-in-depth:
wrap in try/catch and return `jsonError(500, "mock_failed", "Mock unavailable", requestId)`.

## Summary

- Findings: 8 (P0=0, P1=1, P2=1, P3=6)
- Top 3:
  1. **[P1]** Recursive-`$ref` breadth explosion defeats `MAX_DEPTH` → Worker
     CPU/OOM DoS on the keyless `/mock` endpoint.
  2. **[P2]** No total node/call/output-size budget on synthesis — only depth
     is bounded.
  3. **[P3]** `allOf`/`oneOf`/`anyOf`/`additionalProperties`, multi-type /
     `null` types, and response-level `$ref` all silently collapse to `{}`,
     undermining the try-before-buy purpose of the mock.
