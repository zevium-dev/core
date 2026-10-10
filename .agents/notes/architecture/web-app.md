# Web app internals

> Updated: 2026-10-10 (moved from former root `TECH.md` "Repo shape" bullets)
> Code: `apps/web/src/`
> Related: [design system](../design/design-system.md), [app shell](../design/app-shell.md), [catalogue-search](../features/catalogue-search.md), [accounts-orgs](../features/accounts-orgs.md)

Cross-cutting TanStack Start + Clerk + Convex wiring. Feature-specific web notes live in the feature files.

## Cache isolation

- **Frontend cache isolation**: each SSR request and browser router owns its QueryClient. Query hashes include the Clerk user and active organization. Router dehydration carries those two identifiers, and hydration restores their namespace before hydrating queries; changing principal cancels queries and clears query and mutation caches. Tokens are not part of this cache snapshot.

## Navigation and providers

Catalogue route adapters and the navigation-provider rules (public vs authenticated Convex providers, list→detail morph seeding, Clerk CSS layer) are owned by [catalogue-search](../features/catalogue-search.md) Tech. Authentication loading (Clerk mount, CSP origin derivation) is owned by [accounts-orgs](../features/accounts-orgs.md) Tech.

## Local assets and CSP

- **Local web assets**: the web dev server runs on port 3000. Worker-first routing forwards Vite client modules, styles, and HMR entry points through the asset binding in development; production only forwards built and allowlisted public assets. CSP uses the same gateway origin resolution as the playground, including the local port 8787 fallback.

## Known pitfalls

- `@uiw/react-codemirror` defaults to its own LIGHT theme — pass `theme="none"` or CSS-var themes get overridden.
- Spec editor parser/highlighter must share one `@lezer/common` instance — see [publishing-specs](../features/publishing-specs.md).
