Task: gateway mock mode + x402 stub. Write scope: apps/gateway/src/** + gateway tests, apps/web/src/routes/catalogue/$orgSlug.$projectSlug.tsx (try-it mock toggle), apps/web/src/lib helpers/tests, packages/shared (example-generation helper + tests). Do NOT touch convex/, billing, keys screens.

Read first: AGENTS.md gateway rules, apps/gateway/src/pipeline.ts + index.ts + spec-source.ts, packages/shared/src/openapi.ts, catalogue detail try-it panel.

BUILD:

1. packages/shared: generateMockResponse(spec, pathTemplate, method) — build example JSON from the operation's response schema (responses["200"] content application/json schema: use schema "example"/"examples" if present, else synthesize from types: string→"string"/format-aware, number→0, boolean→true, enum→first, array→[one item], object→recurse, $ref within components resolved one level, depth cap 5). Return {status: 200, body, contentType}. Tests: examples preferred, synth fallback, refs, depth cap.
2. Gateway route /mock/{orgSlug}/{projectSlug}/{path}: key-authenticated like /gateway (same verify; product rule: no unauthenticated execution) but COSTS 0 credits (no reserve/settle) — resolves published spec, matches operation, serves generateMockResponse with headers x-zevium-mock: 1, x-zevium-cost: 0. Unknown op → 404. Never touches upstream.
3. x402 stub: unauthenticated/invalid-key requests to /gateway/* and /mock/* respond 402 (not 401) with JSON body {error: "payment_required", detail, actions: {createKey: "https://zevium.dev/app/settings/keys", topUp: "https://zevium.dev/app/billing", docs: "https://zevium.dev/docs/consuming"}} and header WWW-Authenticate: Bearer realm="zevium". Zero-balance stays 402 (check current behavior — align shape). Machine-readable, never leak internals.
4. Try-it panel: "Mock" toggle — when on, calls /mock/... instead of /gateway/..., badge "mock response · 0 credits". Keep real path default.
   TESTS: gateway — mock 200 with generated body + zero wallet delta, 402 shape on bad key, 404 unknown op; shared generator suite; web helper if any.
   VERIFY: pnpm typecheck && pnpm test green at root.
   Output: CHANGED list, VERIFY results, DONE or BLOCKED.
