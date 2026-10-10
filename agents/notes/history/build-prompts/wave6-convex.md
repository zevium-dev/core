Task: expand Convex control plane with usage/billing/earnings query surface + tests.
Write scope: /home/tnfssc/Code/zevium/convex/ ONLY, plus root package.json (test script + devDeps) as specified below. Do NOT touch convex/lib/validate.ts (another lane owns it). Do NOT touch apps/ or packages/.

Read first: /home/tnfssc/Code/zevium/AGENTS.md, TECH.md, FLOW.md sections 2.3/2.4/4.7/4.8, convex/schema.ts, convex/analytics.ts (auth pattern), convex/specs.ts, packages/shared/src/index.ts (CREDITS_PER_DOLLAR, PLATFORM_CUT).

Existing: usageEvents table {organizationId: Id<organizations>, projectId, endpoint, method, credits, status, latencyMs, keyId, at} with by_org, by_project indexes. organizationId on a usage event = CONSUMER org (whose wallet paid). projectId = the published project (owned by PUBLISHER org).

BUILD (exact contracts — wave 7 UI binds to these names):

1. schema.ts: add indexes to usageEvents: by_org_at ["organizationId","at"], by_project_at ["projectId","at"]. Keep existing.

2. convex/usage.ts (new):
   - `listForOrg` query args {orgSlug: v.string(), paginationOpts: paginationOptsValidator, projectId: v.optional(v.id("projects")), keyId: v.optional(v.string()), since: v.optional(v.number()), until: v.optional(v.number())} → paginated usage events for the CONSUMER org, newest first, using by_org_at range (never table scan). Filter projectId/keyId post-index. Auth: caller must be authenticated member of org identified by orgSlug — same pattern as analytics.ts. Return page items with project name+slug joined in.

3. convex/billing.ts: add `cycleBreakdown` query args {orgSlug: v.string()} → current UTC calendar month: {cycleStart, cycleEnd, totalCalls, totalCredits, byKey: [{keyId, calls, credits}], byProject: [{projectId, name, slug, calls, credits}]}. Settled events only (status < 400 or outcome semantics per how gateway records; check recordUsage — count events as recorded). Use by_org_at range.

4. convex/earnings.ts (new): `forOrg` query args {orgSlug: v.string()} → publisher earnings: for each project owned by this org, aggregate usage events via by_project_at: {byProject: [{projectId, name, slug, calls, grossCredits, netCredits}], month: {calls, grossCredits, netCredits}, allTime: {calls, grossCredits, netCredits}}. netCredits = gross * 0.95 — import PLATFORM_CUT math from @zevium/shared if importable, else define const with comment. Month = current UTC month.

5. convex/specs.ts: add `getVersion` query args {versionId: v.id("specVersions")} → {version, spec, publishedAt} — auth: member of the org owning the project. Do not modify existing functions.

TESTS (mandatory):

- Install convex-test + @edge-runtime/vm as ROOT devDependencies (pnpm add -D -w convex-test @edge-runtime/vm vitest). Create convex/vitest.config.ts with environment "edge-runtime" per convex-test docs.
- Root package.json: add script "test:convex": "vitest run --config convex/vitest.config.ts" and change "test" to "turbo test && pnpm test:convex".
- Write convex/usage.test.ts, convex/earnings.test.ts covering: auth rejection for non-member, month-window math, byKey/byProject aggregation, pagination, earnings 95% math, getVersion auth. Use convex-test's t.withIdentity.
- Note: auth pattern reads Clerk identity; mirror rows via existing users/organizations tables — seed them in tests directly with t.run.

VERIFY: `pnpm test:convex` green, `npx convex dev --once` pushes schema clean (env in root .env.local), root `pnpm typecheck` green.

Output: CHANGED file list, VERIFY results, DONE or BLOCKED.
