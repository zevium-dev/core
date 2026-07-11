Task: complete project management surfaces: settings tab, overview editing, earnings tab, danger zone.
Write scope: apps/web/src/routes/app/projects/ and apps/web/src/components/ (new project components) ONLY. Do NOT touch settings/, billing, catalogue, convex/, spec-editor components.

Read first: AGENTS.md, DESIGN.md, FLOW.md 4.5/4.7/4.8, apps/web/src/routes/app/projects/$projectSlug.tsx (tabs: Overview | Spec | Analytics | Settings — Settings currently dead toast).
Convex API deployed: api.earnings.forOrg ({orgSlug}) → {byProject:[{projectId,name,slug,calls,grossCredits,netCredits}], month:{...}, allTime:{...}}; api.projects.update ({projectId, patch:{name?, description?|null, visibility?, tags?}}); api.projects.remove ({projectId}); api.specs.getVersion ({versionId}).

BUILD:

1. Settings tab (replace dead toast with real panel on same route, matching Overview/Analytics local-tab pattern):
   - Edit form: name, description, tags (comma/chip input) → projects.update, optimistic, toast success/error
   - Visibility control (move/duplicate the Make Public/Private dialog here; keep header button)
   - Danger zone: delete project → AlertDialog confirm typing slug → projects.remove → navigate to /app/projects with toast. Destructive styling via semantic tokens (variant="destructive").
2. Earnings tab (new tab in same shell): org-level earnings from api.earnings.forOrg filtered to this project + month/all-time cards (calls, gross, net credits + $ equivalents at 10,000 credits = $1). State clearly "you keep 95%".
3. Overview tab: add inline "Edit" affordance linking to Settings tab.
4. Versions: in spec versions rail (do NOT edit spec-editor components) — SKIP; version viewing ships in wave 8. Do not build.

RULES: stock shadcn, semantic tokens, motion tokens, isPending, layout-stable skeletons, .mutate in handlers, view-transition wiring untouched.

TESTS: pure helpers (credits→$ formatting, tag parsing) into apps/web/src/lib/ with vitest tests.

VERIFY: pnpm --filter web typecheck && pnpm --filter web test && pnpm --filter web build green.
Output: CHANGED list, VERIFY results, DONE or BLOCKED.
