Task: complete settings, activity, billing, and dashboard onboarding surfaces.
Write scope: apps/web/src/routes/app/settings/, apps/web/src/routes/app/billing.tsx, apps/web/src/routes/app/index.tsx, apps/web/src/components/ (new settings/billing components). Do NOT touch projects/, catalogue/, convex/, gateway.

Read first: AGENTS.md, DESIGN.md, FLOW.md 1.4/2.2/2.3/2.4/2.5, current files in scope. Convex API already deployed (see convex/usage.ts, convex/billing.ts): api.usage.listForOrg (paginated {orgSlug, paginationOpts, projectId?, keyId?, since?, until?}), api.billing.cycleBreakdown ({orgSlug}).

DECIDED: Clerk prebuilt embeds for account/org management, custom UI only for app-specific things. Clerk theme: @clerk/ui/themes shadcn (see sign-in route + public-header for pattern).

BUILD:

1. /app/settings (settings/index.tsx): replace read-only shell with Clerk <UserProfile> embed (routing="hash", shadcn theme, full width card). Keep page header. Delete the old static profile card.
2. /app/settings/activity: real call log — api.usage.listForOrg with useQuery + "Load more" pagination (paginationOpts cursor), filters: project select (from api.projects.list), time range (24h/7d/30d/all). Table: time, project, method+endpoint, credits, status badge, latency. Layout-stable skeletons, isPending. Empty state with catalogue link stays.
3. /app/billing: replace "Coming soon" usage card with cycleBreakdown: total calls+credits this UTC month, per-project rows, per-key rows (truncate keyId, monospace). Keep wallet/packs/ledger as-is.
4. /app/index.tsx onboarding "Top up" step: done when wallet balance > 0 (wallet query already used on billing — reuse convexQuery api.wallets.* pattern found in billing.tsx). Remove hard done:false.
5. Sidebar/settings nav: ensure activity reachable (check existing settings layout tabs).

RULES: stock shadcn, semantic tokens, motion tokens, isPending, .mutate in handlers, no raw colors, human-readable errors via lib/human-error.ts pattern.

TESTS (mandatory): extract pure logic (cycle formatting, filter window calc, onboarding done derivation) into apps/web/src/lib/ modules with vitest tests.

VERIFY: pnpm --filter web typecheck && pnpm --filter web test && pnpm --filter web build green.
Output: CHANGED list, VERIFY results, DONE or BLOCKED.
