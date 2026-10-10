Task: wire the missing gateway→Convex usage-event pipe. Write scope: convex/http.ts (+ convex tests), apps/gateway/src/usage.ts, apps/gateway/src/wallet.ts, apps/gateway/test/ (or wherever gateway tests live), apps/gateway/src/index.ts (env type only).

Read first: AGENTS.md (gateway rules: emit usage async, never block response), TECH.md, apps/gateway/src/usage.ts, apps/gateway/src/wallet.ts (#buildUsageClient, alarm, flushToConvex), convex/http.ts (existing /polar-webhook pattern), convex/wallets.ts recordUsage (internalMutation).

BUG (diagnosed): wallet DO alarm flush calls wallets:recordUsage via public ConvexHttpClient when CONVEX_DEPLOY_KEY is absent — recordUsage is an internalMutation, so the call fails forever and usageEvents stays empty. Deploy keys are a bad dependency for dev + prod.

FIX (exact design):

1. convex/http.ts: add POST /ingest-usage http action. Auth: header "x-internal-secret" must equal process.env.GATEWAY_INTERNAL_SECRET (fail closed 401 if env unset or mismatch). Body: {events: ConvexUsageRecord[]} — validate shape (organizationId, projectId, endpoint, method, credits, status, latencyMs, keyId, at, settleRefId; reject >500 events). Run internal.wallets.recordUsage via ctx.runMutation. Return its {applied, skipped, balances} JSON. Never leak internals in error bodies.
2. apps/gateway/src/usage.ts: extend ConvexUsageClientOptions with {ingestUrl?: string, internalSecret?: string}. When both set, recordUsage() POSTs {events} to ingestUrl with x-internal-secret header (use this.#fetch, wrap fetch like key-verifier does — workerd Illegal invocation trap). Keep mutationFn/adminKey paths for tests.
3. apps/gateway/src/wallet.ts #buildUsageClient: prefer ingest path when env.GATEWAY_INTERNAL_SECRET set — ingestUrl = (env.CONVEX_SITE_URL ?? env.CONVEX_URL.replace(".convex.cloud", ".convex.site")) + "/ingest-usage". Fallback order: ingest → adminKey → public client.
4. apps/gateway/src/index.ts Env type: add CONVEX_SITE_URL?: string.
5. Run: npx convex env set GATEWAY_INTERNAL_SECRET dev-internal-secret-1 (root .env.local has deployment creds). Then npx convex dev --once to deploy http action.

TESTS (mandatory):

- Gateway (vitest workerd, existing setup): ConvexUsageClient ingest path — posts correct body+header, parses result, throws on 401/500 (mock fetch). DO alarm flush retry-on-failure behavior must stay covered (existing tests keep passing).
- Convex: http action auth reject (no/wrong secret), happy path applies events idempotently (settleRefId dedupe — recordUsage already handles; assert applied/skipped). convex-test t.fetch for http actions if supported in installed version; if not, test the validation helper as a pure function and state so.

VERIFY: pnpm typecheck && pnpm test green at root; npx convex dev --once clean.
Output: CHANGED list, VERIFY results, DONE or BLOCKED.
