WAVE 2 — WEB LANE. Project: /home/tnfssc/Code/zevium. Read AGENTS.md, FLOW.md §4 (publisher screens), DESIGN.md (motion + UI rules — semantic tokens only, motion values only from src/lib/motion.ts), and existing apps/web code + convex/_generated/api. Edit ONLY apps/web/.

GOAL: publisher flow screens per FLOW.md.

1. /app/projects — org's project list: cards (name, slug, status badge, visibility badge), New Project button, empty state with CTA. Data: convex projects.list via @convex-dev/react-query useSuspenseQuery + route loader ensureQueryData.
2. /app/projects/create — form (TanStack Form or simple controlled): name, slug auto-derived until user edits slug, description. mutation → navigate to project page. Use .mutate + isPending per AGENTS.md.
3. /app/projects/$projectSlug — project page per FLOW.md 4.5: header (name, status/visibility badges, Make Public/Private dialog using shadcn dialog), tabs (Overview | Spec | Settings placeholder). view-transition-name project-title-{slug} on the title (morph from list card title — add matching name on card).
4. /app/projects/$projectSlug/spec — spec editor per FLOW.md 4.6: textarea-based code editor is fine for now (monospace, min-h large) OR CodeMirror if quick (pnpm add @uiw/react-codemirror @codemirror/lang-json) — JSON only. Save draft button (disabled while clean/pending), Issues panel showing validation issues from convex specs.saveDraft response, Publish dialog (semver input default bump) calling specs.publish. Pricing summary chip ("N endpoints, X–Y credits") parsed client-side from draft.
5. All lists→detail navigations: view transition morphs per DESIGN.md. All loading: skeletons matching layout. Toasts (sonner) human messages on mutation success/error.
6. `pnpm --filter web build` + typecheck green. Do not run dev server, do not touch convex/ or apps/gateway.

End with `DONE:` or `BLOCKED:`.
