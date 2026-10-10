# Web app internals

> Updated: 2026-10-10 (local Convex WebSocket CSP; #387)
> Code: `apps/web/src/`
> Related: [design system](../design/design-system.md), [app shell](../design/app-shell.md), [catalogue-search](../features/catalogue-search.md), [accounts-orgs](../features/accounts-orgs.md)

Cross-cutting TanStack Start + Clerk + Convex wiring. Feature-specific web notes live in the feature files.

## Cache isolation

- **Frontend cache isolation**: each SSR request and browser router owns its QueryClient. Query hashes include the Clerk user and active organization. Router dehydration carries those two identifiers, and hydration restores their namespace before hydrating queries; changing principal cancels queries and clears query and mutation caches. Tokens are not part of this cache snapshot.

## Navigation and providers

Catalogue route adapters and the navigation-provider rules (public vs authenticated Convex providers, list→detail morph seeding, Clerk CSS layer) are owned by [catalogue-search](../features/catalogue-search.md) Tech. Authentication loading (Clerk mount, CSP origin derivation) is owned by [accounts-orgs](../features/accounts-orgs.md) Tech.

The app header passes the same workspace readiness signal as the route outlet to its notification bell; notification queries also wait for confirmed Convex auth. Bell boundary recovery and regression coverage are owned by [webhooks-notifications](../features/webhooks-notifications.md) Tech (#416).

## Local assets and CSP

- **Local web assets**: the web dev server runs on port 3000. Worker-first routing forwards Vite client modules, styles, and HMR entry points through the asset binding in development; production only forwards built and allowlisted public assets. CSP uses the same gateway origin resolution as the playground, including the local port 8787 fallback. `src/lib/security-headers.ts` converts HTTPS Convex origins to WSS in every build; only dev builds add WS for the configured HTTP loopback origin (`localhost`, `127.0.0.1`, or `[::1]`, exact port). Production CSP gains no insecure WebSocket sources. Dev/prod regression coverage lives in `src/lib/security-headers.test.ts`.

- **Public icons**: `apps/web/scripts/build.mjs` preserves the tracked favicon and 192/512 PNGs. `src/server.ts` forwards them through the asset binding; the HTML head links the SVG favicon and `public/manifest.json`, which also declares the raster icons. `t3.json` continues to use `public/logo192.png`.
- **Deployment proof**: `src/server.ts` serves `GET`/`HEAD /.well-known/zevium-deployment.json` as uncached JSON for `e2e/stripe-provider-proof.mjs`. The v1 manifest contains only service, mode, built Git SHA, Cloudflare version ID, and normalized upload timestamp. The runtime version tag must match the built SHA; missing/invalid metadata returns JSON 503, never a static development placeholder. Production workflow verification still reads the HTML release meta tag. Gateway/Convex proof contracts are separate.
- **Route errors**: `components/route-error.tsx` uses a neutral wrapper. App/admin layouts retain ownership of the main landmark and `main-content` skip-link target.

## Known pitfalls

- `@uiw/react-codemirror` defaults to its own LIGHT theme — pass `theme="none"` or CSS-var themes get overridden.
- Spec editor parser/highlighter must share one `@lezer/common` instance — see [publishing-specs](../features/publishing-specs.md).

## Shared presentation and errors

- `lib/format.ts` owns money, integer/fractional credits, and UTC date formatting for catalogue, billing/activity, earnings, analytics, reviews, and admin. Stock `components/ui/table.tsx` comes from the shadcn CLI; `CopyButton`, HTTP `StatusBadge`, and `ListBoundary` are shared compositions.
- `human-error.ts` maps only explicit authorization/finance codes to public copy; unknown Error messages and strings always use the caller's fallback, regardless of length. Mutation toasts never forward arbitrary provider/internal text.
- Paginated lists use Convex's native hook; query failures stay in local list boundaries. The protected/public catalogue route adapters remain because unifying their provider/SSR topology is separate from list correctness.
