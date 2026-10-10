Read-only task — do NOT modify any files.

Project: /home/tnfssc/Code/zevium — pnpm monorepo. Frontend at apps/web: TanStack Start + TanStack Router + React 19 + Convex (convex react client) + Clerk.

BUG: in authenticated /app routes, clicking a sidebar nav link updates the URL instantly but the UI takes noticeably long (feels like 500ms+) before the destination screen renders. Navigation should feel instant.

Diagnose the cause. Investigate:

1. apps/web router setup (router.tsx or similar): is `defaultPreload: 'intent'` set? `defaultPendingMs` / `defaultPendingMinMs`? `defaultPreloadStaleTime`?
2. Every route under apps/web/src/routes/app/ — do route `loader`s await network calls (Convex queries, server functions, Clerk) that block transition? List each route with what its loader awaits.
3. Are Convex queries done via loaders (blocking) vs useQuery in components (non-blocking with skeletons)? FLOW.md/DESIGN.md say loading = layout-stable skeletons.
4. Any beforeLoad doing auth round-trips per navigation (e.g. server-side auth check on every client nav)?
5. Sidebar Link components: are they TanStack Router <Link> with preload, or something causing full reloads?

Output contract — end with a report:
CAUSE: <ranked root causes with file:line evidence>
FIX PLAN: <concrete minimal changes, file-by-file>
End with DONE.
