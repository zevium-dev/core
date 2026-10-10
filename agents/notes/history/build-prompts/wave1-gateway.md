WAVE 1 — GATEWAY LANE. Project: /home/tnfssc/Code/zevium (pnpm monorepo). First read AGENTS.md, TECH.md (§Architecture, §credit gate), PRODUCT.md (§What happens on a call), .project/PLAN.md. You may edit ONLY: apps/gateway/ and packages/shared/ (and run pnpm there). apps/gateway already contains the wallet Durable Object (src/wallet.ts) with green tests (test/wallet.test.ts) — extend, do not regress.

GOAL: gateway request pipeline with pluggable edges.

1. packages/shared: add OpenAPI helpers — parseSpec(json string) → typed minimal structure; matchOperation(spec, method, path) → { operation, pricing: { cost (x-zevium-cost default 1), freeTier? } , upstreamBaseUrl (servers[0].url) }; path templating match ({param} segments). Unit tests (vitest, node env fine) in packages/shared.
2. apps/gateway request pipeline in src/: route POST|GET|... /gateway/:orgSlug/:projectSlug/* →
   a. key extraction: Authorization: Bearer zev_... or x-api-key header
   b. KeyVerifier interface { verify(secret) → { orgId, keyId, scopes } | null } — impl ClerkKeyVerifier: POST https://api.clerk.com/v1/api_keys/verify with env CLERK_SECRET_KEY, cache verified result in-memory-per-isolate + Cache API keyed by SHA-256(secret), TTL 60s; unit-testable via injected fetch
   c. SpecSource interface { getPublishedSpec(orgSlug, projectSlug) → { spec: string, projectId, organizationId } | null } — impl ConvexSpecSource stub hitting `${env.CONVEX_URL}` (real function arrives wave 2; keep FixtureSpecSource for tests), plus small TTL cache
   d. pipeline: verify key → load spec → matchOperation → cost → wallet DO reserve (org wallet id from spec source result) → forward request to upstream (stream body both ways, strip hop headers, inject nothing yet) → on upstream response: 2xx settle, non-2xx refund → append x-zevium-request-id + x-zevium-cost headers → async usage event emit via UsageSink interface (console impl now) using ctx.waitUntil
   e. errors: 401 bad key, 402 insufficient (wallet reserve fail), 404 unknown project/route, 429 passthrough
3. Wire wallet DO grant endpoint for tests. workerd tests (vitest-pool-workers) covering: happy path (mock upstream via fetch mock/service binding stub), insufficient credits → 402 and no upstream call, non-2xx upstream → refund, streaming body passthrough integrity.
4. wrangler.jsonc: routes placeholder, DO binding exists, vars documented (CLERK_SECRET_KEY, CONVEX_URL).
5. `pnpm --filter @zevium/gateway test` green; typecheck green. Keep Worker dependency-light (no hono unless already present — prefer tiny hand router).

End final message with `DONE: <summary + files>` or `BLOCKED: <reason>`.
