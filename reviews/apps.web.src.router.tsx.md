# Tiger Review — `apps/web/src/router.tsx` + `__root.tsx` + `catalogue.tsx` + `admin.tsx`

## Verdict

Incorrect — the SSR auth wiring contains a genuine cross-user data-leak class bug. `convexQueryClient` (and therefore its `serverHttpClient`) and the TanStack `queryClient` are module-scoped singletons mutated per-request inside the root `beforeLoad`. Under concurrent SSR (the Cloudflare worker isolate serves overlapping requests off one module graph), request A's `setAuth(tokenA)` races with request B's `setAuth(tokenB)` on the same `ConvexHttpClient`, and the shared `QueryClient` cache serves another user's `isAdminQuery` result as stale-while-revalidate. The author's own comment proves they reasoned about the singleton ("Module-scoped HttpClient is long-lived across SSR requests") but only fixed query-timestamp consistency — auth identity was missed. `admin.tsx` additionally mishandles a query error as "Not authorized" and uses a raw `<a>` that bypasses the router. `catalogue.tsx` is clean.

## File Stats

- Files: `apps/web/src/router.tsx` (90 ln), `apps/web/src/routes/__root.tsx` (158 ln), `apps/web/src/routes/catalogue.tsx` (10 ln), `apps/web/src/routes/admin.tsx` (109 ln)
- Surface: root `beforeLoad` SSR auth bootstrap, router `defaultViewTransition`, `Wrap` (LazyMotion), `/admin` auth gate + admin-query render gate, `/catalogue` passthrough layout
- Consumers: every SSR/loader path under `/app/*`, `/admin/*` reads `context.{userId,token,orgId,orgSlug}` produced here; `serverHttpClient` is touched by every SSR Convex query via `convexQueryClient.queryFn()` (`@convex-dev/react-query` `index.js:225` → `this.serverHttpClient.query`)
- Confirmed deps: `convex@1.42.1` `ConvexHttpClient` stores `this.auth` as mutable instance state (`http_client.js:70,102-126`); `@convex-dev/react-query@0.1.0` constructs `serverHttpClient = new ConvexHttpClient(url)` once in the `ConvexQueryClient` constructor (`index.js:65-67`); `@tanstack/react-router-ssr-query` clears the shared `queryClient` only in per-request `teardown` (`onServerSsrAttach` → `serverSsr.onCleanup`)

## Findings

### [P0] SSR `setAuth(token)` mutates a module-scoped singleton — cross-user identity leak under concurrent requests

`router.tsx` constructs `convexQueryClient` at module scope (one instance per worker isolate):

```ts
// router.tsx:30-33
export const convexQueryClient = new ConvexQueryClient(convexUrl, {
  // Module-scoped HttpClient is long-lived across SSR requests. …
  dangerouslyUseInconsistentQueriesDuringSSR: true,
});
```

`ConvexQueryClient`'s constructor builds a single `serverHttpClient = new ConvexHttpClient(url)` (`@convex-dev/react-query` `index.js:65-67`). `ConvexHttpClient` keeps the bearer on the instance (`convex/.../http_client.js:70,102-126`):

```js
setAuth(value) { this.clearAuth(); this.auth = value; }
clearAuth()     { this.auth = void 0; }
// at query time:
} else if (this.auth) { headers["Authorization"] = `Bearer ${this.auth}`; }
```

`__root.tsx` then writes the per-request Clerk JWT onto that shared instance inside `beforeLoad`:

```ts
// __root.tsx:73-79
if (token) {
  convexQueryClient.serverHttpClient?.setAuth(token);
} else {
  convexQueryClient.serverHttpClient?.clearAuth();
}
```

Trigger: two SSR requests in flight in the same Cloudflare worker isolate (the SSR env is `viteEnvironment: { name: "ssr" }` per `vite.config.ts`). `beforeLoad` yields on `await auth()` and `await session.getToken(...)`, so the event loop interleaves:

1. Req A (user A) → `fetchConvexAuth` → `setAuth(tokenA)`
2. Req B (user B) → `fetchConvexAuth` → `setAuth(tokenB)`  ← overwrites A on the shared client
3. Req A's child loaders run → `convexQueryClient.queryFn()` → `serverHttpClient.query(func, args)` (`index.js:225`) → reads `this.auth === tokenB` → **returns user B's data to user A's SSR HTML**

`isAdminQuery` is the canonical amplifier: `args: {}`, result keyed solely on caller identity (`convex/admin.ts:23-28` → `isAdmin(ctx)`). The same shared client runs it for everyone.

Impact: universal under concurrency — no input assumption required, only two simultaneous SSR requests for different users in one isolate. A non-admin can be served `true` (admin chrome rendered into their SSR HTML) or an admin served `false` (false denial). Any authed Convex query in any loader is affected: `/app/projects`, `/admin`, earnings, keys, etc. This is a data-corruption / authz-bypass class defect. The `dangerouslyUseInconsistentQueriesDuringSSR: true` flag and its comment show the singleton concern was on the author's radar; the auth dimension was not.

Fix: do not reuse a mutable `HttpClient` across requests. Either (a) construct a per-request `ConvexHttpClient` inside `beforeLoad` and thread it through `context` so loaders use a request-scoped client, or (b) drive Convex auth through `AsyncLocalStorage` so the existing shared client resolves the token per async-context instead of via a mutating `setAuth`. At minimum, until one of those lands, `serverHttpClient.setAuth` must not be called from `beforeLoad`.

```suggestion
// router.tsx — give each SSR request its own client instead of a module singleton
export function createServerConvexClient(token: string | null) {
  const client = new ConvexHttpClient(convexUrl);
  if (token) client.setAuth(token);
  return client;
}
```

```suggestion
// __root.tsx — don't mutate the shared module-scoped client
-    if (token) {
-      convexQueryClient.serverHttpClient?.setAuth(token);
-    } else {
-      convexQueryClient.serverHttpClient?.clearAuth();
-    }
+    // Auth identity is per-request; pass token through context and let
+    // loaders use a request-scoped ConvexHttpClient (see createServerConvexClient).
```

### [P1] Shared module-scoped `QueryClient` cache collides across users during concurrent SSR

Same root cause, distinct mechanism. `queryClient` is module-scoped (`router.tsx:38-46`) and passed to `setupRouterSsrQueryIntegration({ router, queryClient })` (`router.tsx:83`). The ssr-query integration subscribes to this shared cache and only `queryClient.clear()`s it in per-request `teardown` (`@tanstack/react-router-ssr-query` core: `teardown` → `queryClient.clear()`), so during request *overlap* the cache is live and shared.

`isAdminQuery` (`convex/admin.ts:23`) has `args: {}`, so its query hash is `convexQuery|api.admin.isAdminQuery|{}` for **every** caller — admin and non-admin share one cache entry. With the default `staleTime` (0 — `defaultOptions.queries` sets only `queryKeyHashFn` and `queryFn`, no `staleTime`), a concurrent request B for a non-admin hits admin A's just-cached `true` and serves it stale-while-revalidate into B's initial SSR HTML before B's own `serverHttpClient.query` refetch resolves.

Impact: same cross-user leak vector as the P0 (false admin grant / false denial flash in dehydrated HTML), gated on request overlap. The TanStack Start SSR convention is a fresh `QueryClient` per request; the module-scoped instance here is the deviation.

Fix: create the `QueryClient` per SSR request (inside `getRouter`, which TanStack Start calls per request) and keep the module-scoped instance for the browser only, OR set `staleTime: 0` + `gcTime: 0` is insufficient (still serves stale) — the real fix is per-request isolation.

### [P2] `admin.tsx` renders `<NotAuthorized />` on a transient `isAdminQuery` error — false denial, no retry path

`AdminLayout` only distinguishes pending vs. `data !== true`:

```ts
// admin.tsx:48-53
const { isLoading: convexAuthLoading, isAuthenticated } = useConvexAuth();
const adminQuery = useQuery(convexQuery(api.admin.isAdminQuery, {}));

if (convexAuthLoading || !isAuthenticated || adminQuery.isPending) {
  return <AdminShellSkeleton />;
}

if (adminQuery.data !== true) {
  return <NotAuthorized />;
}
```

Trigger: any `isAdminQuery` failure — Convex 5xx, network blip, expired Clerk→Convex JWT that makes the query throw — leaves `adminQuery.data === undefined` with `adminQuery.isError === true`. The branch `data !== true` fires and the user sees a hard "Not authorized — Platform admin access is required" page instead of an error/retry UI. Symmetrically, if `isAuthenticated` stays `false` (Convex auth never resolves, e.g. misconfigured `convex` JWT template), the skeleton is permanent with no surfaced error.

Impact: a real admin is told they are not authorized during any transient backend hiccup; an operator gets no error signal. This is the "leaked errors" / mishandled-error class — the failure mode is silently relabeled as an authz decision.

Fix: branch on `isError` explicitly and surface a retryable error state; treat `!isAuthenticated` after `useConvexAuth` settles as an error, not a permanent skeleton.

```suggestion
  if (convexAuthLoading || adminQuery.isPending) {
    return <AdminShellSkeleton />;
  }

  if (adminQuery.isError) {
    return <AdminQueryError onRetry={() => adminQuery.refetch()} />;
  }

  if (!isAuthenticated || adminQuery.data !== true) {
    return <NotAuthorized />;
  }
```

### [P3] "Back to app" uses a raw `<a href="/app">`, bypassing TanStack Router and forcing a full reload

```ts
// admin.tsx:81-83
<Button asChild variant="outline" size="sm">
  <a href="/app">Back to app</a>
</Button>
```

Every other nav surface in the app uses TanStack Router `<Link>` (and the router ships `defaultViewTransition` globally). This `<a>` triggers a full document reload, skips the VT, and re-runs SSR. Minor, but inconsistent with the rest of the shell and the view-transition contract.

Fix: use `<Link to="/app">`.

```suggestion
<Button asChild variant="outline" size="sm">
  <Link to="/app">Back to app</Link>
</Button>
```

## Summary

- Counts: **1 P0**, **1 P1**, **1 P2**, **1 P3** (4 findings)
- Top 3:
  1. **[P0]** `serverHttpClient.setAuth(token)` mutates a module-scoped `ConvexHttpClient` in root `beforeLoad`; concurrent SSR requests in one worker isolate race on `this.auth` → cross-user data / authz leak across every authed Convex loader.
  2. **[P1]** Module-scoped `queryClient` shares its cache across concurrent SSR requests; `isAdminQuery` (`args: {}`) collides on one hash, serving another user's result stale-while-revalidate into the dehydrated HTML.
  3. **[P2]** `AdminLayout` treats `isAdminQuery` error / unresolved Convex auth as `data !== true` → false "Not authorized" with no retry, mislabeling a backend failure as an authz decision.
- Clean: `catalogue.tsx` (passthrough layout, no gate/loader/VT concerns — inherits global `defaultViewTransition`). `__root.tsx` theme-init script and `<html suppressHydrationWarning>` are consistent with `next-themes` (`storageKey="zevium-theme"`); `__TSR_index` is a real TanStack Router internal (`useCanGoBack.js:7-8`), so the VT direction logic is live, not dead. No raw Tailwind colors, no hardcoded motion durations (vt.ts `600` matches `--dur-slow`; `defaultPendingMs`/`defaultPreloadStaleTime` are router timing, not animation tokens).
