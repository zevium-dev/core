# Tiger Review — `apps/gateway/src/mock.ts` (+ `packages/shared/src/mock.ts`)

## Verdict

**Incorrect — ship blocker.** The keyless mock route leaks **private** project
specs to anonymous callers (the keyless patch removed the org-mismatch gate and
never replaced it with a `visibility` check), and the depth cap in `synthesize`
does not bound branching factor, so a crafted self-referential schema with
`N>1` recursive properties blows up to `N^MAX_DEPTH` work — a publisher-driven,
anonymously-amplified DoS. Plus dead code, missing size caps, and a 2xx-coverage
gap. Six findings (P1×2, P2×2, P3×2).

## File Stats

| File | Lines | Role |
|---|---|---|
| `apps/gateway/src/mock.ts` | 98 | Gateway `/mock/:org/:project/*` route handler (keyless, anonymous, 0 credits) |
| `packages/shared/src/mock.ts` | 180 | Spec-driven mock body synthesizer (`generateMockResponse` + `synthesize`) |

Dispatch (verified, `apps/gateway/src/index.ts:198-219`): `/mock/*` is routed
*after* `parseGatewayPath` (which only matches `parts[0]==="gateway"`), so mock
traffic does **not** leak into the metered `/gateway` pipeline. The auth-bypass-
into-metered-path concern is clear. The bugs below are on the mock surface
itself.

## Findings

### [P1] Private project specs leaked to anonymous callers via `/mock`

**Location** — `apps/gateway/src/mock.ts:55-88` (`handleMockRequest`).

`handleMockRequest` calls `deps.specSource.getPublishedSpec(orgSlug, projectSlug)`
and immediately uses `published.spec` to synthesize a mock body. It **never reads
`published.visibility`**. `ConvexSpecSource` backs onto `specs:getPublishedForGateway`
(`convex/specs.ts:261-318`), which returns *any* project with
`status === "published"` — including `visibility: "private"` — and surfaces the
`visibility` field specifically so the data plane can gate on it.

The `/gateway` metered path enforces exactly this:
```ts
// apps/gateway/src/pipeline.ts:88-95
// Private projects only accept keys whose org owns the project — foreign
// keys get 404 (never leak that a private project exists) not 401/403.
if (
  published.visibility !== "public" &&
  verified.orgId !== published.clerkOrgId
) {
  return jsonError(404, "project_not_found", "Unknown project", requestId);
}
```

The keyless patch (`32d5c17`) deleted the mock's old `verified.orgId !==
published.clerkOrgId → 401 org_mismatch` gate (verified via `git show
32d5c17^:apps/gateway/src/mock.ts:77-80`) and replaced it with nothing. Result:
any anonymous caller who knows (or guesses) an org+project slug can enumerate
the full response schema of a **private** API — endpoint paths, field names,
enum values, `example` payloads — by hitting `/mock/:org/:project/*` and reading
the synthesized body + the matched `pathTemplate`. This is a direct regression
of the "never leak that a private project exists" product rule and a clean
information-disclosure / auth-bypass on the mock surface.

The existing test `apps/gateway/test/mock.test.ts:67` even fixtures a
`visibility: "private"` project and the mock happily serves it — the test
*asserts* the broken behavior.

**Fix** — gate mock on visibility before parsing, mirroring the pipeline's
"fail closed, never confirm existence" stance:
```ts
if (published.visibility !== "public") {
  return jsonError(404, "project_not_found", "Unknown project", requestId);
}
```

---

### [P1] `synthesize` depth cap does not bound branching — `O(N^MAX_DEPTH)` DoS

**Location** — `packages/shared/src/mock.ts:79-128` (`synthesize`).

`MAX_DEPTH = 5` bounds recursion *depth* but the object branch iterates **every**
entry of `schema.properties` and recurses into each at `depth + 1`:
```ts
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
A self-referential schema whose `properties` has `N` recursive `$ref` fields
expands as `1 + N + N² + N³ + N⁴ + N⁵ ≈ N⁵` `synthesize` calls before the depth
cap fires at depth 5. Concretely, `N=50` → ~312M calls (each allocating an
object/array), `N=100` → 10^10. The worker CPU/memory budget is exhausted on a
single request. `resolveRef` is one-hop, so a single `Node` schema in
`components.schemas` with 50 `child1..child50` properties each `{ $ref:
"#/components/schemas/Node" }` is sufficient — no chained refs needed.

The doc comment is false advertising:
```ts
/** Fallback value once recursion hits MAX_DEPTH — stops runaway/self-referential schemas. */
```
and the only test (`packages/shared/src/mock.test.ts:240-289`) uses `N=1` (a
single `child` property), which terminates in 6 calls — it cannot detect the
explosion. The test even claims to assert "no stack overflow / unbounded
growth from the cycle" while only exercising the one-property case.

This is publisher-controlled (anyone who can publish a spec can plant it) and
anonymously amplified (a single `/mock` request triggers the synthesis with no
auth, no rate limit, no per-request node budget).

**Fix** — pass a mutable node-visit budget through `synthesize` and bail (return
`depthCapValue`) when it hits zero; cap `properties` iteration width; or memoize
per-`$ref`-target within a single synthesis. A width cap alone is the cheapest:
```ts
const MAX_PROPS = 64;
// inside the object branch, before iterating:
const entries = Object.entries(schema.properties).slice(0, MAX_PROPS);
for (const [key, propSchema] of entries) {
  out[key] = synthesize(propSchema, components, depth + 1);
}
```
A global node budget is still needed in addition, because the explosion is
multiplicative across depth.

---

### [P2] No size cap on `example` / `enum[0]` — publisher can ship arbitrarily large mock body

**Location** — `packages/shared/src/mock.ts:84-104` (`explicitExample`,
`synthesize:89-91`).

`explicitExample` returns `schema.example` / `schema.examples[0]` /
`Object.values(schema.examples)[0].value` **verbatim**, and `synthesize` returns
it before the `depth >= MAX_DEPTH` check:
```ts
const explicit = explicitExample(schema);
if (explicit.found) return explicit.value;
...
if (Array.isArray(schema.enum) && schema.enum.length > 0) {
  return schema.enum[0];            // also unbounded
}
...
if (depth >= MAX_DEPTH) return depthCapValue(type);
```
So `MAX_DEPTH` does not apply to explicit examples or enum values. A published
spec whose response schema carries `example: <100MB nested object>` (or a single
100MB enum string) is `JSON.stringify`d in full on **every** anonymous `/mock`
request (`apps/gateway/src/mock.ts:89`), burning worker memory and CPU. The
synthesized body is never cached, so the cost is paid per request. Anonymous +
unauthenticated + unrate-limited = a free DoS amplifier for any publisher (incl.
free-tier) who can plant a pathological example in a published spec.

**Fix** — cap serialized body length (reject/truncate above e.g. 256KB), and
cache the synthesized body keyed by `(specVersion, pathTemplate, method)` since
published spec versions are immutable.

---

### [P2] Spec re-parsed on every anonymous request — CPU amplification, no rate limit

**Location** — `apps/gateway/src/mock.ts:57-67`.

`CachedSpecSource` (`apps/gateway/src/spec-source.ts:55-90`) caches the **raw
spec string** for 30s, but `handleMockRequest` calls `parseSpec(published.spec)`
(JSON.parse + full structural shaping of `paths`/`components`) on every request,
then `matchOperation` + `synthesize` + `JSON.stringify`. For a large spec the
per-request CPU is dominated by `JSON.parse`, and there is no rate limiting on
the `/mock` route (the only `rate_limited` code in the gateway is the wallet
grant-sync path in `wallet.ts:894`, unrelated to mock). An anonymous attacker can
hammer `/mock/:org/:project/*` for any large-spec public project to burn worker
CPU time. The 30s raw-string cache does nothing to help — it just saves the
Convex round-trip.

**Fix** — cache the `ParsedOpenApiSpec` (and ideally the synthesized body) in
`CachedSpecSource` alongside the raw string, or add edge `cache-control:
public, max-age=60` on mock 200s (responses are deterministic functions of the
immutable published version).

---

### [P3] Dead code — `MockDeps.keyVerifier` is unused but still plumbed

**Location** — `apps/gateway/src/mock.ts:18-23`, `apps/gateway/src/index.ts:118-122`.

The keyless patch left `keyVerifier?: KeyVerifier` on `MockDeps` with the comment
"Unused since mock went keyless; kept so test deps stay uniform.", and
`mockDeps()` still passes `keyVerifier: deps.keyVerifier`. Nothing in
`handleMockRequest` reads `deps.keyVerifier`. This is dead code that actively
misleads readers (and reviewers) into thinking the mock does any auth at all —
which is exactly the wrong signal next to a route that just lost its auth gate.
It also forces every test fixture to construct a `FixtureKeyVerifier` even when
testing the keyless path (see `apps/gateway/test/mock.test.ts:51-58`).

**Fix** — drop `keyVerifier` from `MockDeps` and from `mockDeps()`. If test-deps
uniformity genuinely matters, factor a shared `WorkerDeps` subset instead of
carrying a dead field on the mock's public type.

---

### [P3] Only `responses["200"]` is synthesized — POST endpoints with `201`/`202` return 404

**Location** — `packages/shared/src/mock.ts:147-158` (`extractResponseSchema`).

```ts
const ok = responses["200"];
if (!isRecord(ok)) return undefined;
```
Operations that declare only `201 Created` / `202 Accepted` / `default` (standard
for POST/PUT) yield `schema === undefined` → `generateMockResponse` returns the
`{ body: {} }` fallback only if the operation itself was found; if the operation
has *no* `200`, the mock body is `{}` rather than a synthesized `201` body. The
caller (`apps/gateway/src/mock.ts:80-87`) then returns 200 with an empty object,
which is a poor try-before-buy experience for create endpoints. (Note:
`generateMockResponse` returns `null` only when the *operation* is unknown, not
when the response is missing — so this is a silent quality gap, not a crash.)

**Fix** — scan `2xx` then `default`:
```ts
const ok = responses["200"] ?? responses["201"] ?? responses["202"] ?? responses["default"];
```

## Summary

| Sev | Count | Top 3 |
|---|---|---|
| P0 | 0 | — |
| P1 | 2 | Private-spec leak via keyless `/mock`; `O(N^5)` synthesis DoS |
| P2 | 2 | Uncapped `example`/`enum` size; per-request spec re-parse CPU amplification |
| P3 | 2 | Dead `keyVerifier` on `MockDeps`; only `200` synthesized |

**Highest-impact fix:** add `if (published.visibility !== "public") return
jsonError(404, "project_not_found", ...)` at the top of `handleMockRequest`.
The keyless patch's stated intent was "anonymous try-before-buy surface for the
catalogue" — that is only correct for *public* projects, and the `/gateway`
pipeline already encodes the rule the mock should mirror.
