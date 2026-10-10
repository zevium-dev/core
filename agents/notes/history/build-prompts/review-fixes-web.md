Task: product-review polish, web lane. Write scope: apps/web/src/** EXCEPT routes/app.tsx and components/notification-bell.tsx? NO — notification-bell IS yours; routes/app.tsx is NOT (other lane). Also yours: convex/catalogue.ts (count only). NOT yours: convex/schema.ts, convex/payouts.ts, convex/notifications.ts, e2e/, apps/gateway.

Read first: AGENTS.md, DESIGN.md, the files below before editing them.

FIXES (all):

1. Landing "APIs listed" stat truth (apps/web/src/routes/index.tsx + convex/catalogue.ts): listPublic result gains `total` (count of public+published projects — bounded .take(1000) then length; note cap in comment). Hero stat uses total, not teaser slice length. Keep card shape compatible (additive field).
2. Grammar: "1 credits" → singular-aware everywhere user-visible. catalogue detail header ("· N credit(s)"), any "N credits" template where N can be 1 — add tiny pluralize helper in apps/web/src/lib (creditsLabel(n)) + test, use it in catalogue detail header + endpoint "1 endpoint(s)" card badges if same problem (catalogue index badge "1 endpoint").
3. Try-it "Get a key →" (routes/catalogue/$orgSlug.$projectSlug.tsx): under the API key input, muted helper row: signed-in (Clerk <Show when="signed-in">) → Link to /app/settings/keys "Manage keys →"; signed-out → Link /sign-up/$ "Create a free key →". Import Show from @clerk/tanstack-react-start (see public-header.tsx pattern).
4. Docs reachable in-app: add "Docs" item to apps/web/src/components/app-sidebar.tsx nav (BookText or LifeBuoy lucide icon, to /docs). Place after Settings or in a footer group — match existing structure.
5. Notification click-through (components/notification-bell.tsx): kind→destination map: low_balance→/app/billing, spec_published→/app/projects, version_deprecated→/app/projects, webhook_failed→/app/projects, visibility_changed→/app/projects, payout_requested→/app/earnings, payout_resolved→/app/earnings (last two kinds may not exist in the union yet — another lane adds them; write the map to tolerate unknown kinds with a safe default of no-link). Clicking a notification: mark read (existing) AND navigate (TanStack useNavigate; close popover). Rows get hover affordance.
6. Publish-quality nudge: in the spec editor publish flow (components/spec-editor/spec-rail.tsx publish card or its dialog), when project has no description: inline muted warning "No description — catalogue card will look empty. Add one in Settings." with Link to project settings tab (/app/projects/$slug ?tab=settings or however tabs work — check $projectSlug.tsx tab state; if tabs are local state, link to project root; do what works). Soft nudge only, never blocks publish.
7. Docs copy: routes/docs/agents.tsx + consuming.tsx — mock mode is LIVE and KEYLESS now (route /mock/{org}/{project}/{path}, x-zevium-mock:1, 0 credits, no auth). Fix any "coming"/"key-authenticated" stale copy; add a short mock section to consuming.tsx if absent.

TESTS: creditsLabel + any new pure helpers get vitest. Existing tests stay green.
VERIFY: pnpm --filter web typecheck && pnpm --filter web test && pnpm --filter web build; npx tsc -p convex/tsconfig.json (catalogue change). Report each.
Output: CHANGED list, VERIFY results, DONE or BLOCKED.
