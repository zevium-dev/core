Task: platform /admin screens. Write scope: apps/web/src/routes/admin/ (new dir), apps/web/src/components/ (admin-only components), apps/web/src/lib/ helpers+tests. Do NOT touch /app routes, sidebar, header, other lanes' files.

Read first: AGENTS.md, DESIGN.md, FLOW.md section 6, convex/admin.ts (bind EXACT names: isAdmin, platformStats, listOrgs, listProjects, recentUsage, setProjectVisibility), apps/web/src/routes/app.tsx (auth gate pattern), router context.

BUILD:

1. /admin layout route: beforeLoad client gate — signed-in required; component checks admin.isAdmin query → non-admin sees plain "Not authorized" (no data fetch). Minimal header (no app sidebar): "Zevium Admin" + link back to /app.
2. /admin/ index: platformStats cards (orgs, projects by status, month calls/credits) + recentUsage table (100 rows).
3. /admin/orgs: paginated org table (name, slug, wallet balance) with Load more.
4. /admin/projects: paginated table (name, org, status, visibility) + filter selects + kill switch: visibility toggle via setProjectVisibility with confirm dialog (destructive styling).
   RULES: stock shadcn, semantic tokens, skeletons, isPending. Admin is desktop-first; tables overflow-x-auto.
   TESTS: pure helpers tested; if none, state so.
   VERIFY: pnpm --filter web typecheck && test && build green.
   Output: CHANGED list, VERIFY results, DONE or BLOCKED.
