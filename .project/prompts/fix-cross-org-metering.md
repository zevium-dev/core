Task: fix cross-org marketplace metering — consumers must be able to call OTHER orgs' public APIs, charged to the CONSUMER's wallet. Today pipeline.ts requires `verified.orgId === published.clerkOrgId` (only own-org calls work) and keys the wallet DO by the PUBLISHER's org. Both wrong for a marketplace.

Write scope: apps/gateway/src/**, apps/gateway/test/**, convex/specs.ts (getPublishedForGateway return only), convex/wallets.ts (recordUsage only), convex/http.ts (/ingest-usage validator only), convex tests. Do NOT touch schema.ts, mock.ts (just made keyless — leave as-is), catalogue, web.

Read first: AGENTS.md (product rules: zero balance blocks, no unmetered paths, never trust client identifiers), apps/gateway/src/pipeline.ts, spec-source.ts, wallet.ts (SettlementUsage, pendingToUsageRecord), usage.ts (ConvexUsageRecord), convex/specs.ts getPublishedForGateway, convex/wallets.ts recordUsage, convex/http.ts /ingest-usage, apps/gateway/test/pipeline.test.ts.

DESIGN (exact):
1. convex/specs.ts getPublishedForGateway: add `visibility: project.visibility` to the return payload. Additive.
2. gateway spec-source.ts: PublishedSpec gains `visibility: "public" | "private"`. parsePublishedSpecPayload: parse it; when absent, default "private" (fail closed). Update FixtureSpecSource fixtures/tests to set visibility explicitly.
3. pipeline.ts:
   - Access rule replaces the org-match 401: public project → any valid key may call. Non-public project → only keys whose verified.orgId === published.clerkOrgId; others get 404 project_not_found (404, not 401/403 — never leak private project existence).
   - Wallet DO keyed by the CONSUMER: env.WALLET.idFromName(verified.orgId). Free tier, reserve, settle, refund, key-settings gates all ride the consumer org's DO (they already key off verified.keyId — no change needed beyond the DO id).
   - Usage events: UsageEvent + SettlementUsage + ConvexUsageRecord gain `consumerClerkOrgId: string` (= verified.orgId). Keep existing organizationId field (publisher convex org id) for compatibility, but recordUsage (below) now stores the CONSUMER org on the event.
4. convex/wallets.ts recordUsage: for each incoming event, resolve the consumer org via organizations.by_clerk_org using consumerClerkOrgId; store usageEvents.organizationId = CONSUMER org convex id. Legacy events without consumerClerkOrgId: keep current behavior (use provided organizationId). Events whose consumerClerkOrgId cannot be resolved: skip + count in `skipped` (never throw the whole batch).
5. convex/http.ts /ingest-usage validator: accept the new optional consumerClerkOrgId field.
6. TESTS (mandatory):
   - Gateway pipeline: (a) cross-org happy path — key org_A calls org_B's PUBLIC project → 200, org_A wallet debited by cost, org_B wallet untouched, usage event carries consumerClerkOrgId=org_A; (b) private project, foreign key → 404 project_not_found, no wallet activity; (c) private project, owner key → 200; (d) update the old org_mismatch test to the new semantics.
   - Convex recordUsage: consumer resolution happy path, unresolvable consumer skipped not thrown, legacy event without consumerClerkOrgId still applies.
   - All existing tests must stay green (adjust fixtures for visibility field).

VERIFY: pnpm --filter @zevium/gateway typecheck test; pnpm test:convex; npx tsc -p convex/tsconfig.json; npx convex dev --once. Report each.
Output: CHANGED list, VERIFY results, DONE or BLOCKED.
