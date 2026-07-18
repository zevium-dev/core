Task: organization surfaces — org home, create, members/invites.
Write scope: apps/web/src/routes/app/org/ (new dir), apps/web/src/components/app-sidebar.tsx (nav entry only), apps/web/src/routes/app/index.tsx FORBIDDEN (another lane owns it). Do NOT touch settings/, billing.tsx, projects/, catalogue/, convex/.

Read first: AGENTS.md, DESIGN.md, FLOW.md 4.1/4.2/5.1/5.2/5.3, apps/web/src/routes/app.tsx (shell), public-header.tsx + sign-in route (Clerk shadcn theme pattern).

DECISION (locked): keep active-org URL model (Clerk-idiomatic) — org screens live under /app/org/_, NOT /app/organizations/{slug}/_. Clerk prebuilt components do the heavy lifting.

BUILD:

1. /app/org — org home: active org name/slug header, member count, <OrganizationProfile> embed (shadcn theme, hash routing) for members/invitations/settings. If no active org: empty state + <OrganizationList> or CreateOrganization CTA.
2. /app/org/create — <CreateOrganization> embed (shadcn theme), afterCreateOrganizationUrl="/app".
3. Sidebar: add "Organization" nav item (icon from lucide, matches existing items) → /app/org.
4. Invitations: Clerk OrganizationProfile handles invites; additionally OrganizationSwitcher already surfaces pending invitations — verify and note; no custom invitations route needed.

RULES: stock shadcn, semantic tokens, motion tokens, skeletons for embed mount, prefers-reduced-motion.

TESTS: pure logic minimal here — if none extracted, state so.

VERIFY: pnpm --filter web typecheck && pnpm --filter web build green.
Output: CHANGED list, VERIFY results, DONE or BLOCKED.
