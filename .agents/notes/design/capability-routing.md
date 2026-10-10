# Capability routing: taxonomy and normalized contracts

> Status: proposed (awaiting user), not implemented · Updated: 2026-10-10
> Design: [#327](https://github.com/zevium-dev/core/issues/327) · Implementation: [#328](https://github.com/zevium-dev/core/issues/328)
> Feature owner: [capability-routing](../features/capability-routing.md) · Decision: [capability taxonomy](../decisions/2026-10-10-capability-taxonomy.md)

This file owns the proposed wire contracts, mapping language, selection policy, and edge projection. The feature note owns product scope. All limits and weights below are proposed launch values, not measurements or accepted policy.

## Scope and evidence

Start with `web.search`: return ranked web links and optional excerpts for a query. The [router research](../research/agent-api-marketplace-landscape/routers_and_agent_data_apis.md#q3-what-made-routers-win) identifies search as a category with substitutable suppliers; Exa, Tavily, Brave, Parallel, and SERP suppliers are candidates for conformance work, not confirmed integrations. Search does not promise identical rankings, factual correctness, an answer, page contents, or an exhaustive index. A successful empty result is still a successful search.

The [marketplace research](../research/agent-api-marketplace-landscape.md) motivates a narrow common schema. The [treg comparison](../research/treg-comparison.md) motivates pinning, fallback, and a cost cap. This proposal does not adopt fallback on empty results or arbitrary errors. House supply remains subject to the [accepted sourcing gates](../decisions/2026-10-10-house-supply-via-aggregators.md).

Code baseline at `91c1a2c`, checked 2026-10-10:

- `packages/shared/src/openapi.ts` preserves operation extensions but has no capability parser. `extractPricing` still defaults missing cost to 1. The [accepted unpriced-operation decision](../decisions/2026-10-10-unpriced-operations-hidden.md) overrides that behavior for the implementation.
- `apps/gateway/src/pipeline.ts` authenticates, loads the published spec, matches the operation, authorizes free usage or reserves credits, proxies, settles/refunds by HTTP status, and emits usage asynchronously. It settles a 2xx before consuming its body. Normalized execution must validate the body before settlement.
- `convex/quality.ts` produces project/version quality snapshots; capability selection needs operation/version/mapping-specific evidence. Existing project statistics must not masquerade as operation statistics.
- `apps/gateway/src/index.ts` wires Clerk verification and cached Convex-backed spec/catalogue sources. [Registry v2](../architecture/registry-v2.md) has a producer contract but no deployed receiver in this checkout. An in-memory TTL cache is insufficient for the no-Convex-per-request requirement.

## 1. Registry and names

Zevium maintains a reviewed, versioned registry in the repo, proposed location `packages/shared/src/capabilities/`. Each entry owns `id`, exact contract `version`, request/response schemas, behavioral semantics, retry safety, limits, and conformance fixtures. It contains no supplier membership, credentials, or prices. Membership and prices are derived from immutable published OpenAPI operations.

- IDs use lowercase `domain.action`, optionally a narrower domain: `web.search`, `web.scrape`, `email.find`, `company.people.search`. Grammar: `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$`, maximum 64 ASCII characters. No vendor names, aliases, or version suffixes in IDs.
- Only `web.search` is proposed for initial registration. Other names illustrate the grammar and do not authorize routing those jobs.
- `version` is exact semver, starting at `1.0.0`; no ranges or implicit latest. Published contracts remain immutable. Any schema or semantic change gets a new version; breaking meaning, validation, or defaults requires a major version. Gateway selection uses exact `(id, version)` equality, even across minor versions. Publishers opt into a new contract through a new spec version.
- Zevium reviews new capabilities and contract revisions through PRs. Publishers can propose entries and independently tag conforming operations with existing entries. Unknown IDs/versions are rejected by capability validation, not treated as new registry entries.
- Registry review establishes semantics; automated publish-time validation checks mappings and fixtures. Self-declared tags alone cannot prove live supplier behavior, so runtime validation and measured quality remain required.

Curation prevents two publishers from using the same name for incompatible jobs. A repo registry provides review history and identical contracts for the control plane and Worker. Publisher-defined namespaces would grow supply faster, but would not establish substitutability. Add those only as non-routed discovery tags in a separate proposal.

## 2. Operation extension and mapping

One operation declares at most one capability. The exact v1 extension has four required properties: `id`, `version`, `mappingVersion`, and `map`; unknown properties are invalid. `mappingVersion` is the integer `1`. `map` has exactly `request` and `response`. The operation's method, path, upstream, credentials, and price retain their existing OpenAPI owners.

Illustrative native provider fixture, not a claim about a named vendor's current API. Its `POST /search` accepts `{q, max_hits}` and returns `{items: [{link, name, summary?}]}`:

```yaml
paths:
  /search:
    post:
      operationId: searchWeb
      x-zevium-cost: 30
      x-zevium-capability:
        id: web.search
        version: 1.0.0
        mappingVersion: 1
        map:
          request:
            body:
              object:
                q: { from: /query }
                max_hits: { from: /limit }
          response:
            object:
              results:
                each:
                  from: /items
                  value:
                    object:
                      url: { from: /link }
                      title: { from: /name }
                      snippet: { from: /summary, missing: omit }
```

The surrounding spec must also declare the native request and success-response schemas. The example omits those standard fields to isolate the extension. `x-zevium-cost` is illustrative credits per call, not vendor pricing.

### Mapping grammar

Recommend a small declarative interpreter, compiled and validated at publish time. An expression has exactly one of these shapes:

- `{ "from": "<JSON Pointer>", "missing"?: "omit" }`: read a value, with no type coercion. Missing paths fail unless `missing: omit` is set on a direct object-field expression; then omit that field. Explicit `null` remains null and must pass the target schema.
- `{ "literal": <JSON value> }`: emit a constant; no secrets.
- `{ "object": { "<field>": <expression>, ... } }`: construct an object.
- `{ "each": { "from": "<JSON Pointer>", "value": <expression> } }`: project an array; `value` pointers resolve relative to each element. Missing/non-array sources fail. All other pointers resolve against the normalized input (request) or native JSON body (response).

`map.request` is an object with optional `query` and `body` expressions, at least one required. `query` must yield an object of scalar strings, booleans, or numbers, serialized using percent-encoded query names/values; arrays, objects, and null values are rejected. `body` yields the native JSON body and sets `Content-Type: application/json`; it is forbidden for GET/HEAD. v1 supports parameter-free GET/POST paths only. No mapped headers, paths, upstream hosts, authentication, caller controls, or raw request passthrough.

`map.response` must yield exactly `{results: [...]}`. Gateway truncates the mapped array to the requested `limit`, validates it, and adds `nextCursor` and `meta` itself. Optional result fields can be omitted; required failures invalidate the whole attempt. Array truncation is the only implicit transformation; do not stringify null, invent titles, fetch links, concatenate snippets, run regexes, or convert dates. Suppliers needing those operations should adapt before this boundary.

Pointers use RFC 6901 escaping (`~0`, `~1`) and own-property reads only. Empty pointer selects the current root. Reject prototype-related segments/keys (`__proto__`, `prototype`, `constructor`). Proposed limits: mapping JSON ≤16 KiB, depth ≤16, ≤128 expression nodes, ≤10,000 runtime visits, and ≤100 native array elements per `each`; exceed any limit and fail the attempt. No JavaScript, JSONata, remote references, arbitrary functions, or network access in mapping. The grammar uses plain JSON and bounded traversal so a Go implementation can reproduce it without a JS runtime.

### Validation and eligibility

Publish-time capability validation must:

1. Resolve an exact supported registry and mapping version; require a unique, nonempty `operationId` within the spec. Reject capability declarations at root/path level and duplicate or malformed extension fields.
2. Require an explicit valid `x-zevium-cost` for routing: integer credits from 0 through `MAX_ENDPOINT_COST_CREDITS` (currently 1,000,000). Missing price excludes the operation from capability discovery and execution; never invoke the legacy default of 1. Explicit zero remains authenticated and requires positive wallet balance. A free-tier extension does not make an unpriced operation routable.
3. Check mapping targets against the native operation's JSON schema and declared query parameters, including required native fields. Resolve bounded local refs only. Unresolvable or unsupported schema constructs fail capability admission with a specific publisher lint; do not claim arbitrary JSON Schema compatibility is statically provable.
4. Check mandatory normalized fields and supported ranges against registry fixtures. For v1 every provider must support query length and limit range below at the listed fixed price, with no hidden paid modes. Optional response fields may be absent. Reject suppliers that require caller input absent from the common contract unless a documented constant supplies it.
5. Run positive and negative fixture mappings and validate both native requests and normalized responses. Repeat output validation at runtime; sample fixtures alone cannot establish conformance.
6. Apply existing publication, upstream-safety, lifecycle, and credentials gates. Capability validation adds no bypass to those gates.

Recommendation: malformed capability declarations block publishing until fixed or removed. An unpriced operation can remain in the saved spec with a lint but is omitted from all callable surfaces, consistent with the accepted visibility decision. Existing direct operations without capability tags need no normalized mapping. Changes to membership or maps require a new immutable published spec version, not a mutable routing table.

### Adapter tradeoff

Declarative mappings cover renaming, projection, simple constants, and nested arrays without another network hop. Their limits are deliberate: no complex date parsing, multiple supplier calls, HTML processing, or computed authentication.

A publisher-hosted adapter may expose a conforming single-call JSON operation and declare an identity/projection map in its OpenAPI spec. It is the listed upstream, uses publisher credentials, passes the same gates, and receives the same fixed-price metered call. It costs the publisher another service and latency, and Zevium cannot verify its internal calls. It is an escape hatch for complex suppliers, not the default; Zevium must not insert an unlisted adapter hop or execute publisher code in the Worker.

## 3. `web.search@1.0.0` schemas

Use JSON Schema 2020-12. The request schema below describes `input`, not the routing envelope. Defaults are applied by the gateway before mapping; a schema `default` annotation alone does not change data. Reject unknown input keys. Whitespace-only queries fail the additional semantic check; preserve other query characters rather than rewriting the query.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:zevium:capability:web.search:1.0.0:request",
  "type": "object",
  "additionalProperties": false,
  "required": ["query"],
  "properties": {
    "query": { "type": "string", "minLength": 1, "maxLength": 2048 },
    "limit": { "type": "integer", "minimum": 1, "maximum": 10, "default": 5 }
  }
}
```

`query` is free text, not a portable vendor query language. `limit` is a maximum, not a promised result count. Do not silently forward native options for locale, date filters, domain filters, deep search, answers, images, or page extraction. Those need a reviewed contract revision and supplier support checks.

Pagination: v1 returns one bounded first page. There is no `page`, `offset`, or input `cursor`; they fail validation. `nextCursor` is always null and means continuation is unavailable, not that the provider has no more results. This avoids pretending that two ranked indexes share offsets. A later contract can add opaque signed cursors bound to provider, operation/spec version, query, caller, and expiry; continuation would pin that provider and prohibit cross-provider fallback. No cursor implementation belongs in #328.

Successful response schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:zevium:capability:web.search:1.0.0:response",
  "type": "object",
  "additionalProperties": false,
  "required": ["results", "nextCursor", "meta"],
  "properties": {
    "results": {
      "type": "array",
      "maxItems": 10,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["url", "title"],
        "properties": {
          "url": {
            "type": "string",
            "format": "uri",
            "pattern": "^https?://",
            "maxLength": 8192
          },
          "title": { "type": "string", "minLength": 1, "maxLength": 1024 },
          "snippet": { "type": "string", "maxLength": 8192 },
          "publishedAt": { "type": "string", "format": "date-time" }
        }
      }
    },
    "nextCursor": { "type": "null" },
    "meta": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "requestId",
        "capability",
        "version",
        "providerId",
        "specVersionId",
        "costCredits",
        "attempts",
        "attemptedCostCredits"
      ],
      "properties": {
        "requestId": { "type": "string", "minLength": 1, "maxLength": 128 },
        "capability": { "const": "web.search" },
        "version": { "const": "1.0.0" },
        "providerId": { "type": "string", "minLength": 1, "maxLength": 512 },
        "specVersionId": { "type": "string", "minLength": 1, "maxLength": 128 },
        "costCredits": { "type": "integer", "minimum": 0, "maximum": 1000000 },
        "attempts": { "type": "integer", "minimum": 1, "maximum": 2 },
        "attemptedCostCredits": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1000000
        }
      }
    }
  }
}
```

Enforce URI and date-time formats, not annotation-only validation. URLs must parse as HTTP(S), have a host, and contain no userinfo. Returned URLs are data; gateway never fetches them. `publishedAt` is an optional provider-reported publication time, never replaced with fetch time. Results preserve provider ordering and need no cross-provider scores. Missing excerpts/dates are omitted, not fabricated. `results: []` is valid and billable. Router-owned `meta` is never taken from provider content. `results.length <= input.limit` is an additional cross-field check.

Both the incoming capability request and decoded upstream response are capped at 1 MiB, measured while reading, including decompressed response bytes. Mapping and normalized response serialization also stay within 1 MiB. Abort excess bodies and refund without fallback. Reserve room for the MCP envelope when encoding an MCP response so its existing 1 MiB bound is respected. This bounded protocol adapter is separate from direct `/gateway` streaming.

### Error model

Normalized capability failures use this envelope; auth/payment failures retain the existing gateway payment-required envelope and recovery actions. MCP carries the same result/error inside its tool result, with `isError: true` for failures, while preserving JSON-RPC protocol errors for invalid tool invocation.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:zevium:capability:web.search:1.0.0:error",
  "type": "object",
  "additionalProperties": false,
  "required": ["error"],
  "properties": {
    "error": {
      "type": "object",
      "additionalProperties": false,
      "required": ["code", "message", "requestId", "attempts", "costCredits"],
      "properties": {
        "code": {
          "enum": [
            "invalid_request",
            "capability_not_found",
            "no_eligible_provider",
            "route_budget_exhausted",
            "routing_unavailable",
            "provider_rejected",
            "provider_rate_limited",
            "provider_failed",
            "provider_timeout",
            "invalid_provider_response"
          ]
        },
        "message": { "type": "string", "minLength": 1, "maxLength": 256 },
        "requestId": { "type": "string", "minLength": 1, "maxLength": 128 },
        "attempts": { "type": "integer", "minimum": 0, "maximum": 2 },
        "costCredits": { "const": 0 },
        "retryAfterSeconds": { "type": "integer", "minimum": 0 }
      }
    }
  }
}
```

Status mapping: malformed input/control → 400 `invalid_request`; unknown exact capability/version → 404 `capability_not_found`; no matching eligible provider → 503 `no_eligible_provider`; cap prevents any next attempt → 422 `route_budget_exhausted`; missing/expired edge data or uncertain wallet result → 503 `routing_unavailable`; native 400–499 except 429 → 424 `provider_rejected`; exhausted native 429 → 429 `provider_rate_limited`; exhausted native 5xx or transport failure → 502 `provider_failed`; exhausted upstream timeout → 504 `provider_timeout`; native 3xx or invalid 2xx body → 502 `invalid_provider_response`. No redirects are followed. `retryAfterSeconds` is optional and derived from a bounded valid upstream Retry-After or local retry policy.

HTTP status on the normalized response is not the fallback classifier. Retain the native outcome internally: a mapped 424/502 must never turn a native 4xx or schema failure into a retryable 5xx. Messages are static human-readable explanations; never expose upstream error bodies, stack traces, credentials, or hidden-provider existence. Wallet/key denials remain terminal and use current gateway errors. Errors report zero settled charge; an uncertain wallet result must be reconciled before any fallback and must not be described as a confirmed refund.

## 4. Route controls, selection, and accounting

Proposed HTTP entry: `POST /c/web.search/1.0.0`, authenticated through the same edge credential contract as gateway calls. Initial implementation supports API keys; the planned verified wallet-session rail can use the same router once available. Require JSON content type and reject unknown envelope/control keys.

```json
{
  "input": { "query": "Convex transaction isolation", "limit": 5 },
  "routing": {
    "maxCostCredits": 100,
    "allowFallbacks": true,
    "excludeProviders": []
  }
}
```

Require `input`, `routing`, and `routing.maxCostCredits`. The cap is an integer from 0 through 1,000,000 credits. Making it mandatory for capability calls is a proposal that narrows the feature note's optional-cap sketch. Direct API calls keep their current contract. Optional controls: `allowFallbacks` boolean (default true), `pinProvider` opaque provider ID, and `excludeProviders` unique array of at most 32 provider IDs (default empty). No caller-supplied price, score weights, upstream URL, timeout, attempt count, or spec override.

Provider identity is one listed operation, derived as `projectId + ':' + operationId`; public discovery supplies it as an opaque string. Each component is validated at publish time (operation IDs cannot contain `:`), and callers do not construct it. A spec revision changes its bound `specVersionId`, not the provider ID. Pinning is strict: it yields at most that operation, one attempt, no fallback elsewhere. Exclusion wins; pin plus exclusion of the same ID is invalid input. Unknown/excluded/private/suspended pins yield the same generic eligibility error. Pinning cannot bypass auth, price, health, lifecycle, or conformance checks. IDs may represent house or third-party listings; neither gets a ranking preference.

### Candidate set and deterministic score

1. Validate input and controls, authenticate, and check the caller's active org/key and positive wallet balance. Load one complete edge capability snapshot and hold its revision for this request. Never enumerate Convex during routing.
2. Select exact capability/version declarations from current published, public, active, conforming operations with explicit fixed prices. Apply pin/exclude, key scopes/allowlists, lifecycle and terminal edge deny state, approved upstream/credential availability, and any local transient cooldown. v1 excludes private listings, connected-account requirements, variable/per-token/outcome prices, and capabilities with side effects.
3. Drop candidates whose listed price exceeds the remaining route cap. A free-tier allowance may reduce the actual charge later; selection never assumes it remains available. Frozen spec identity binds the quote and mapping for the attempt. Recheck edge revocation/admission state immediately before every attempt; never silently substitute a newer spec or price.
4. Rank remaining candidates by descending score below. Tie-break by lower listed cost, then lexical provider ID. One attempt per provider, at most two providers total, no concurrent racing. Refilter before fallback without rescoring against a new snapshot.

For candidate `i`, proposed score components in [0,1]:

```text
P = 1 / (1 + listedCostCredits / 100)
S = (successfulSamples + 1) / (eligibleSamples + 2)
L = 1 / (1 + p50LatencyMs / 1000)
F = max(0, 1 - (nowMs - lastMeasuredAtMs) / 1800000)
score = 0.30*P + 0.45*S + 0.15*L + 0.10*F
```

Clamp negative ages to zero. Use the last 100 eligible routed outcomes within 24 hours for the same operation/spec/contract/map digest; p50 is the nearest-rank median of completed successful normalized calls. Count normalized 2xx (including empty results) as success; native 429/5xx, timeouts, transport failures, and invalid responses as failure. Exclude caller cancellations, admission/budget denials, and native non-429 4xx from this reliability denominator; retain separate counts for diagnosis. Measure latency through full normalized response validation, not just headers. Samples contain no request/response bodies.

Below 20 eligible samples, or when last measurement is over 30 minutes old, use `S = 0.5`, `L = 0.5` as ranking priors and label public metrics insufficient/stale. Also use `L = 0.5` when no successful latency sample exists. Never publish those priors as measured success or latency. `F = 0` if no measurement exists; a valid timestamp otherwise uses the formula even below the sample floor. Health-probe reachability may gate eligibility but cannot replace operation success data. Freshness means measurement recency, not recency of web content. Cold-start providers remain eligible after normal publish gates; fixed priors and price ties make initial behavior reproducible, with no exploration quota in v1.

Transient failures can place that operation on a local 30-second cooldown, or a valid Retry-After clamped to 1–30 seconds for 429. Local cooldown is an optimization, not a global outage promise. Do not wait inside a request for a cooldown to expire. Provider-provided latency/success claims never feed this score.

### One cap across attempts

Use the conservative **sum of listed attempt prices** as the route budget. Let `B` be the caller's cap and `A` start at zero. Before dispatch of each admitted attempt with immutable price `p`, require `A + p <= B`, then increment `A` once. Failed/refunded attempts do not replenish this budget. A free-tier discount reduces the charge but does not reduce `A`; `maxCostCredits: 0` can therefore select only explicitly zero-priced operations. This definition caps attempted work and ensures total net consumer charges cannot exceed `B`.

Example: with cap 100, a 30-credit attempt fails and is refunded; a 60-credit fallback succeeds. Attempted price is 90 and consumer pays 60. An 80-credit failure followed by a 50-credit candidate is blocked before the second dispatch even though the first attempt was refunded. Increasing the cap is the caller's explicit choice, not an automatic retry.

Do not reserve the entire route cap. Each attempt authorizes its actual free-tier/zero-price case or reserves its listed price from the consumer's wallet DO, with current key cap and positive-balance enforcement. Refund the failed attempt durably before authorizing the next. The wallet's atomic reservations still prevent parallel routed requests from overspending; the request's monotonic `A` bounds its sequential attempts. An attempt blocked before dispatch does not consume `A` or trigger another provider. Fail closed on uncertain admission/refund/settlement results.

Each logical request gets a router request ID; each attempt gets a distinct stable reservation ID derived from that request ID and attempt index. Do not reuse one reservation across providers. Wallet method retries reuse that attempt ID and may not repeat upstream dispatch. Usage records bind request/attempt ID, capability/version, provider/project, immutable spec, operation, map digest, native outcome, attempted price, actual charge, and refund status. The failed provider earns zero; the successful provider receives the normal 95% share of the settled amount. Free-tier failure restores its quota against the original admission-day bucket; zero-price execution still produces usage. Convex ledger projection remains asynchronous through the existing durable usage path.

### Fallback and idempotency limits

Fallback occurs only after a native upstream 429, native 5xx, or an upstream deadline timeout. 429 is the sole exception to the no-4xx rule. Never fallback on other native 4xx (including 401/402/403/404), redirects, empty successful results, invalid JSON/schema/mapping, oversized responses, DNS/TLS/connection errors without an upstream timeout, caller cancellation, or auth/wallet/cap denials. Those failures refund any reservation and stop. This is intentionally narrower than classifying every gateway-generated 502 as retryable.

Use a total 8-second upstream work deadline across both attempts, with at most 3 seconds per attempt including body read, leaving room inside the existing MCP 10-second execution timeout for edge admission and finalization. Do not start another attempt after cancellation or when less than 1 second of the upstream budget remains. Admission/refund must complete before dispatch; if its delay consumes the deadline, stop. Cleanup and durable reconciliation may outlive caller delivery, but cannot dispatch new work after the deadline. Abort upstream fetch and body reads on expiry. A timeout can leave a supplier working; Zevium refunds the consumer and the publisher bears that external cost.

Registry semantics, not the HTTP verb, determine retry safety. Search may be POST but reads information; sending email, starting paid jobs, and mutating accounts are ineligible. Generic idempotent writes also wait for an explicit cross-provider effects model: HTTP idempotency at provider A does not establish idempotency at B.

The existing upstream `Idempotency-Key` namespace is consumer/project/method/URL-specific. Preserve it per provider. It neither deduplicates across providers nor implements gateway response replay. Repeating a capability request, even with the same client label, can create a new billable search and a new cap budget. Exactly-once billing, durable response replay, and cross-provider write retries are outside v1; describe this limit in call docs.

### Finalization, headers, and MCP

Reuse the authenticated credit gate and attempt accounting from the pipeline, but introduce a bounded normalized-response finalizer before success settlement. Do not call today's `handleGatewayRequest` and validate its already-settled result afterward. Complete body read, mapping, schema validation, size check, and response serialization first; then settle once. Any failure before settlement refunds. A delivery disconnect after durable success settlement cannot guarantee a refund or delivery replay. Direct proxy responses keep streaming.

Stamp router-owned headers after filtering provider headers and expose them through capability-route CORS:

- `X-Zevium-Request-Id`: logical route request ID.
- `X-Zevium-Capability`: `web.search@1.0.0`.
- `X-Zevium-Provider`: successful opaque provider ID; omitted on error.
- `X-Zevium-Spec-Version-Id`: successful immutable spec identity; omitted on error.
- `X-Zevium-Cost`: actual total settled credits, zero for a confirmed failed/refunded route.
- `X-Zevium-Attempts`: dispatched attempt count.
- `X-Zevium-Attempted-Cost`: sum of listed prices consumed from the route cap, including refunded attempts.

On an uncertain settlement result, omit cost metadata rather than claim a confirmed zero; return `routing_unavailable` using the existing generic gateway error shape until reconciliation. The normalized error schema's constant zero applies only when no success was settled and refund/no-charge is known. Success metadata mirrors these facts in the body, because MCP callers cannot depend on HTTP response headers. Provider error bodies and full attempt traces stay out of public results; itemized usage retains per-attempt charges/refunds.

MCP changes keep search-then-load:

- `search_apis` adds typed capability entries (`kind: capability`, ID, exact version, description, provider count, listed price range, available quality evidence, `requiresMaxCost: true`) beside existing listing results. Derive them from the edge snapshot; only eligible explicitly priced public operations count. No per-provider tool explosion.
- `get_api_docs` accepts either the existing listing selector or an exact capability/version selector. Capability docs return normalized schemas, routing controls, cost-cap semantics, pagination limits, and provider IDs for pin/exclude. Registry text is trusted; publisher text stays under `publisherData`.
- `call_api` accepts either its existing direct target or `{capability, version, input, routing}`. Reject mixed selectors. The capability branch invokes the same internal router as HTTP and returns normalized results with routing metadata. Existing key transport remains; derive wallet identity from verified auth. Mark capability docs as read-only and describe repeated-call billing. Do not mark the whole mixed direct/capability tool read-only when direct operations may mutate state.

## 5. Edge snapshot and delivery

The gateway needs a derived snapshot per exact capability/version, plus edge admission state. No independent price or membership edits are permitted. A proposed snapshot includes:

- Envelope: format version, capability/version, registry schema digest, mapping interpreter version, monotonic snapshot revision, generated time, hard expiry (proposed 5 minutes), and content digest.
- Providers: opaque ID, project/publisher and consumer-visible listing identity, immutable spec ID/version/digest, operation ID/method/path, parsed mapping and digest, explicit listed cost and free-tier limit, route generation/revision, lifecycle/visibility/quality admission state, and credential-reference revision. The referenced immutable edge route artifact contains upstream and encrypted credential material. No credential values enter public discovery or telemetry.
- Quality per operation/spec/map: eligible/successful sample counts, p50, last measurement/success, evidence-window bounds, insufficient/stale markers. Mutable quality updates may change ranking, never the immutable quote.

Production flow: publish/lifecycle/credential changes create durable control-plane outbox work; quality aggregation creates bounded coalesced refresh work. Build the snapshot from immutable published specs plus derived measurements. Push signed, revisioned data to edge storage, validate bytes/digests/registry compatibility, and ACK only after durable storage. Build membership indexes during ingestion, not by scanning all specs per request. A cold Worker reads the edge registry DO/storage; an isolate cache is only an optimization. Missing or expired data returns 503 and schedules background repair, without a synchronous Convex/Clerk fallback.

Reuse registry delivery infrastructure after receiver cutover. The current frozen v2 event contract does **not** contain `capability.snapshot`; do not add an event name silently. #328 must choose an explicit versioned contract extension for quality/capability snapshots, with paired producer/receiver deployment, or derive membership locally from existing route events and add a separately versioned quality feed. Recommendation: a versioned capability projection payload with signed delivery and declared dependencies on its route revisions; split batches below existing 524,288-byte limits, store chunks by digest, and atomically activate only complete snapshots. Stale/out-of-order/replayed updates cannot roll back revisions; bootstrap must restore revision and terminal deny state together.

Before admission, join snapshot membership against authoritative edge org/key/route deny state. Archive, key revocation, suspension, sunset, credential retirement, or visibility reduction overrides a cached capability entry. If an artifact/revision or required join is missing, skip that candidate or fail closed; never fetch missing pieces from Convex in the request. Refresh before the hard expiry, with durable retry and repair on delivery gaps. There is a bounded propagation delay from control-plane mutation to edge application; do not claim instantaneous revocation. Unknown freshness after a gap prevents new admission. An already-admitted attempt must settle against its captured identity even if a later policy update prevents fallback.

No-request-Convex acceptance covers key verification, route/spec and credentials, wallet admission/sync, capability discovery, and scoring, not only the new selector. Current legacy cold paths must be replaced or the capability route must remain disabled. Edge DO calls and the upstream request are allowed. Usage/quality events flow back asynchronously without query/result bodies.

## 6. Smallest shippable #328 slice

After owner approval, ship one vertical slice behind an edge readiness flag:

1. Add only `web.search@1.0.0`, mapping grammar v1, publish validation, and generated shared contracts. Include two fixture-backed public search operations with different native JSON shapes and explicit fixed prices. Real house listings require their separate sourcing approval; the fixture prices above grant none.
2. Provide the signed edge projection and its receiver dependencies, with operation quality priors when evidence is absent. Enable only when auth, wallet admission, route lookup, and snapshot reads cannot fall back to Convex/Clerk. If the parallel registry cutover is not ready, keep this PR disabled in production rather than relax the hot-path rule.
3. Add `POST /c/web.search/1.0.0` with required cap, strict pin/exclude, deterministic score, at most two sequential attempts, and the normalized finalizer before settlement. Share credit checks and durable refund/usage handling with direct execution.
4. Extend MCP search/docs/call selectors and propagate provider/cost metadata. Keep the first-page schema; defer catalogue pages, additional capabilities, custom score knobs, cursors, response replay, and variable-priced LLM routing. The [LLM pricing direction](../decisions/2026-10-10-llm-per-token-pricing.md) remains a separate hold/settle contract.

Required implementation evidence: end-to-end fixture calls with (a) cheaper provider 429 then fallback success and exactly one net charge, (b) native 400/401/404 with no second call, (c) timeout refund and bounded fallback, (d) cap exhausted by refunded work, (e) zero balance blocking free/zero-price calls, (f) malformed 2xx refunded before any charge, (g) pin/exclude and missing-price behavior, (h) stale snapshot/revocation stopping admission, (i) overlapping requests respecting wallet/key limits, and (j) identical HTTP/MCP results. A cold-start integration test should deny all Clerk/Convex request-path network access, exercise a missing snapshot, and still permit queued asynchronous usage delivery. Also test crash/retry reconciliation without re-dispatching an admitted attempt.

This slice addresses #328's acceptance once the edge prerequisites and two production-eligible providers exist. It does not require building a general mapping engine or every supplier listed in the research. Track #327 with `Refs`, not `Closes`: owner approval accepts the design.

## Open questions for the owner

- Approve Zevium-curated exact-version contracts and the first-page-only `web.search` schema, including omission of domain/date/locale controls for v1?
- Approve mandatory `maxCostCredits` and the conservative sum-of-listed-attempt-prices meaning? Refunds and free-tier discounts do not replenish that budget; a net-charge-only interpretation would permit more fallback work but is a different promise.
- Approve bounded declarative maps as the default and publisher-hosted adapters as the escape hatch? New mapping operations would require separate review.
- Confirm initial supplier pair and resale permission under the existing house-supply decision; the research lists candidates, not approvals.
- Approve proposed score weights, 20-sample floor, 30-minute quality freshness, 5-minute snapshot expiry, and two-attempt deadline limits as launch defaults? Cold-start priors and deterministic ranking can concentrate traffic; exploration is deferred.

Implementation coordination for #328: assign the registry contract/receiver change and normalized-before-settlement work before enabling routing. These are dependencies, not grounds to weaken the cap or admit through stale/unverified edge state.
