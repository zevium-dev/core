Task: fix sluggish client-side navigation in apps/web. You may edit files under /home/tnfssc/Code/zevium/apps/web/src ONLY.

Read /home/tnfssc/Code/zevium/AGENTS.md, DESIGN.md (loading rules) first.

PROBLEM (already diagnosed — do not re-diagnose): every client-side navigation in the TanStack Start app performs serialized server round-trips before render:

1. __root.tsx beforeLoad → fetchConvexAuth() server fn → Clerk auth() + session.getToken({template:"convex"})
2. routes/app.tsx beforeLoad → requireAuth() server fn
3. loaders in routes/app/projects/index.tsx, $projectSlug.tsx, $projectSlug/spec.tsx each await getAuthOrg() server fn + ensureMirrorOnServer() (index only) + queryClient.ensureQueryData(convexQuery(...))

Server fns are HTTP round-trips on the client. Result: URL changes instantly, UI stalls ~1s.

DESIGN (implement exactly this):
A. Root beforeLoad (apps/web/src/routes/__root.tsx): run fetchConvexAuth ONLY on server (typeof window === "undefined"). On client, return cached values without any network: read fresh Clerk state synchronously from window.Clerk (userId: window.Clerk?.user?.id ?? context-cached value; token stays null on client — browser Convex auth is handled by ConvexProviderWithClerk, token is only for SSR serverHttpClient). Keep SSR behavior byte-identical.
B. Extend RouterContext (apps/web/src/router.tsx) with orgSlug: string | null and orgId: string | null. Root beforeLoad supplies them: on server from Clerk auth() session (fetchConvexAuth should return them too), on client from window.Clerk?.organization?.slug / .id (fresh — handles org switching without round-trip).
C. routes/app.tsx beforeLoad: on server keep requireAuth() as-is. On client: no server fn — if no userId (from window.Clerk?.user or context) throw redirect({ to: "/sign-in/$" }).
D. The three loaders: replace `await getAuthOrg()` with context.orgSlug (from B). On server keep awaiting ensureQueryData (SSR completeness) and keep ensureMirrorOnServer in projects/index.tsx server path. On client: do NOT await — `void queryClient.prefetchQuery(convexQuery(...))` and return immediately; screens already have skeletons via useQuery/isPending. ensureMirrorOnServer must NOT run on client navs (useEnsureMirror hook in app.tsx already covers client).
E. Type a small helper in apps/web/src/lib/ for reading client Clerk state (typed access to window.Clerk — declare minimal interface, no `any` without comment). Clerk global: window.Clerk with .user?.id, .organization?.{id,slug}, .session. Guard for undefined during hydration: if window.Clerk not yet loaded on client nav (rare), fall back to context values.
F. Check ALL other routes under apps/web/src/routes/ for the same pattern (beforeLoad/loader awaiting server fns on client path) — apply same treatment. billing.tsx, settings.tsx, index.tsx under /app, catalogue routes.

RULES: TypeScript strict. No behavior change to SSR output. Do not touch apps/gateway or convex/. Follow existing code style.

VERIFY: run `pnpm --filter web typecheck` and `pnpm --filter web build` (or `pnpm typecheck`/`pnpm build` at repo root if filters unavailable) — must be green.

Output contract — end with:
CHANGED: <file list with one-line what>
VERIFY: <typecheck/build results>
DONE or BLOCKED: <reason>
