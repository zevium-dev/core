# Mock sandbox

> Status: spec-generated Try it form implemented and review-hardened (#427); root cutover owner activation pending · Updated: 2026-10-17
> Code: `apps/gateway/src/mock.ts`, `apps/gateway/src/next/pipeline.ts`, `apps/web/src/components/catalogue-detail.tsx`, `apps/gateway/test/mock.test.ts`, `packages/shared/src/request-form{,.test}.ts`, `apps/web/src/components/schema-form{,.test}.tsx`, `apps/web/src/lib/openapi-reference.ts`, `apps/web/src/routes/catalogue/-playground.test.tsx`
> Related: [gateway](gateway.md), [catalogue-search](catalogue-search.md), [pricing](pricing.md), [agent-surface](agent-surface.md), [listing-lifecycle](listing-lifecycle.md)

Free, anonymous, spec-generated responses for any published API: exercise the API shape before spending credits or getting a key. Never executes the upstream, so it is the one deliberate exception to "every call is key-authenticated and credit-gated".

## Product

- **Playground**: in-docs test console. A playground call is a normal metered call — free when it costs nothing (mock mode generated from the spec, or the publisher's free tier covers it), charged like any other call when it hits a paid upstream. No special playground billing
- P1 #14 — Mock/sandbox mode: free spec-generated mock endpoints — try the API shape before spending credits. [roadmap](../product/roadmap.md)
- Carve-out rule (`AGENTS.md` product rules), verbatim:

  > No unmetered execution paths — every gateway/agent call is key-authenticated and credit-gated. **Stated carve-out**: `/mock/:org/:project/*` is deliberately keyless and anonymous — it never executes the upstream, only synthesizes a response from the published spec's schema at 0 credits, so the metering rule doesn't apply to it by design

## Flow

### API detail page — `/catalogue/{org}/{api}` (public)

- **Try it** panel: choose a published operation, fill its parameter and body fields, preview curl or MCP arguments, and send in-page. Paste a key for live calls; it stays in browser tab session storage. Mock and live prices remain explicit.
- Nested objects, arrays with add/remove, and variant selection use generated controls. Form/raw switching preserves body edits. Unsupported schemas explain why raw input is needed. Invalid supported fields block Send, focus the first bad control and list readable errors (`limit (query): Must be at most 5.`, `Request body › title: This value is required.`). MCP arguments describe the equivalent live call; MCP has no mock mode.
- **Mock mode**: free, anonymous spec-generated responses — exercise the API shape without spending credits or executing the upstream
- Consumer golden path: Catalogue → API detail → Try it (mock mode or free tier) → create key → top up → first real call.

### Machine surface — `/mock/{org}/{project}/{path}`

- Keyless `/mock` has no authentication or payment failure path; missing, unsafe, or unreadable projects/specs/routes return generic `404` responses (FLOW 3.4)

## Tech

Keyless mocks read credential-free public signed route projections, synthesize from priced-operation response schemas and charge zero without contacting upstream or wallet admission. Private, retired, malformed, token and unpriced operations fail closed. The browser playground uses the paired gateway origin.

### Generated request form (#427)

- `packages/shared/src/request-form.ts` is a pure, dependency-free projection, validator and parameter serializer. It resolves local JSON Pointers with cycle/hop guards; schema `$ref` assertion siblings intersect through `allOf` rather than overwrite referenced assertions (raw projection); annotation-only siblings retain typed controls; operation parameters override inherited path-item parameters by `(in, name)`. No separate playground contract or pricing table.
- Parameters: path/query/header, required flags, scalar enum/const selects, boolean switches, numeric inputs with bounds, descriptions, defaults and examples. Omission differs from `false`, `0`, empty string and `null`. Flat arrays/objects serialize using OpenAPI form/simple/label/matrix/spaceDelimited/pipeDelimited/deepObject styles. Unsupported content/style/allowReserved and nested parameter serialization block Send with an explicit error. Empty/dot path values cannot redirect the selected operation.
- JSON bodies: objects/nested objects, arrays, `oneOf`/`anyOf` pickers. Optional containers can be included/omitted. Read-only fields are not generated. Raw/form modes share JSON text; extra properties survive edits. Media-level examples (including named/local-ref examples) precede schema defaults/examples.
- Raw fallback: recursive/unresolved refs, untyped/free-form/nullable/complex-enum schemas, `allOf`/`not`, binary formats, unsupported schema keywords, more than 150 schema fields or 8 levels. Parameter and body values, including examples/defaults introduced by Include/Add/variant selection, are checked before recursive rendering and capped at 100 array items / 500 values / 8 levels; larger values remain editable as raw JSON. Non-JSON media types retain a raw body editor.
- The CSP-safe interpreter checks required/type/enum/const, numeric bounds/multiples, string length, array length/uniqueness/items, object required/additional properties/count, and `oneOf`/`anyOf`/`allOf`/`not`, in both modes. All validation traversal shares a 5,000-work-unit / 32-level budget, including reference resolution, schema lists, string lengths, deep enum/const/uniqueness comparisons and diagnostic merging. Diagnostics are capped at 100 including the limit warning; `allOf` merges each branch once; arrays/objects over 500 entries report incomplete validation. Unknown assertions (including publisher regex patterns, which are not executed on the UI thread) and unresolved refs explicitly report incomplete validation; `format` remains an annotation. This is a bounded supported-subset validator, not a complete JSON Schema implementation.
- One serialized path/header/body drives curl preview, MCP arguments (preview names `call_api_read` or `call_api_write` by method) and browser fetch. MCP `path` includes the already serialized query string; JSON strings and null stay serialized text because `call_api_write` passes strings verbatim and treats null as absent; other JSON values are parsed (the gateway re-serializes them), other media types stay exact text. MCP connection authentication stays external to copied arguments. Live curl uses `YOUR_API_KEY`; the pasted credential never enters previews. Reserved authentication headers are controlled by the key field.
- Rebased with #453/#454: form and spec generation already reuse `resolveLocalJsonPointer`. Keep separate schema projections: generation rejects unsupported operations, while the form retains raw editing and a shared validation work budget. `generatedToolArguments` expects generated flags and structured parameter groups; the playground supports additional serialization styles and preserves raw body bytes, so its adapter remains separate. Cross-surface tests cover string/null/boolean/number/object/array body semantics. Follow-up opportunity: extract a byte-preserving body adapter if these surfaces change; do not replace form validation with the generator projection.
- Container validation errors have a programmatically focusable fieldset target, `aria-invalid`, and an `aria-describedby` link to the stock alert error.
- Send uses TanStack Query `useMutation` / `isPending`, without automatic retries. Inputs remain disabled before hydration and while pending; response skeleton size is unchanged. No new navigation or custom animation is introduced, so no additional list/detail morph is needed.
- Coverage: shared mapper/validation/serialization edge cases; component controls, nested arrays/variants, raw switching; playground invalid-call blocking, mock request/preview equality, real-call key gate, SSR secret protection and pending locks. Unpriced/token operations remain absent through the existing published-endpoint filter.

[Activation gates and configuration](../architecture/convex-activation.md). [PR 1–6 design/review evidence](../architecture/convex-rebuild.md).

## Decisions

- 2026-10-11 — BUILT (#427): Real form generated from spec parameters/request schemas; shared generation remains #428. [Decision](../decisions/2026-10-11-openapi-as-contract.md).

- 2026-07-11 — Mock went keyless and anonymous at 0 credits (commit `32d5c17`, "keyless mock"). Supersedes the build-plan wave 9b row that says "key-authed".
- 2026-10-10 — BUILT (#316): operations without `x-zevium-cost` are hidden and not callable; free only when explicitly `0`. Publishing remains allowed with a warning. [decision](../decisions/2026-10-10-unpriced-operations-hidden.md)

## Open questions

- Doc/code conflict: "generic `404`" for every failure. `mock.ts` also returns `410 sunset_reached` (with `Deprecation`/`Sunset`/`Link` headers) for retired/sunset APIs and `422 invalid_spec` when pricing is invalid. Code wins.
- Stale doc: [history/build-plan.md](../history/build-plan.md) wave 9b row (frozen archive) says mock is "key-authed"; code and `AGENTS.md` say keyless.
- Backlog: production acceptance journey must also verify keyless mock against the same listing as a paid call ([roadmap](../product/roadmap.md)).
- Research idea, NOT a decision: claimable spec listings — ingest public OpenAPI specs as unclaimed, mock-only listings served through the keyless `/mock` carve-out; owner claims, sets `x-zevium-cost`, earns 95%. ToS legality unverified. Source: [research](../research/agent-api-marketplace-landscape.md) ("Supply").
