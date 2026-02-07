---
name: trpc-tanstack-react-query
description: Implement and use the tRPC v11 TanStack React Query client in this repo (TanStack Start + TanStack Router). Covers SSR-safe QueryClient/tRPC client creation, loader prefetching via createTRPCOptionsProxy, and component usage via createTRPCContext.
---

# tRPC + TanStack React Query (Repo Patterns)

**Last Updated**: 2026-02-01
**Versions**: @trpc/\*@11.8.x, @tanstack/react-query@5.90.x, @tanstack/react-router@1.150.x

Use the new `@trpc/tanstack-react-query` client (recommended in tRPC v11) to generate type-safe TanStack React Query primitives like QueryOptions, MutationOptions, and QueryKeys.

This repo uses both:

- `createTRPCContext<AppRouter>()` for React components (`TRPCProvider` + `useTRPC()`)
- `createTRPCOptionsProxy<AppRouter>()` for TanStack Router loaders (router `context.trpc`)

## Workflow

1. Follow the repo setup

- QueryClient: `src/lib/query-client/*` (`makeQueryClient()` + SSR-safe `getQueryClient()`)
- tRPC client: `src/lib/trpc/*` (`createTRPCClient()` + SSR-safe `getTrpcClient()`)
- Providers: `src/components/providers.tsx` wires `QueryClientProvider` + `TRPCProvider`
- Router context: `src/router.tsx` wires `{ queryClient, trpc }` and SSR query integration

2. Wire providers (components)

- Wrap the app with `QueryClientProvider` then `TRPCProvider` using the same `queryClient`.

3. Wire router context (loaders)

- Create a `trpc` options proxy with `createTRPCOptionsProxy({ client: trpcClient, queryClient })` and pass it into router `context`.

4. Use in loaders + components

- Loader: `context.queryClient.ensureQueryData(context.trpc.foo.bar.queryOptions(input))`
- Component: `useSuspenseQuery(trpc.foo.bar.queryOptions(input))`

See `references/usage.md` for copy/paste patterns.

## Conventions / gotchas (repo)

- **Router params**: loader `params` contains _all_ slugs; always pass an explicit `{ ... }` object to each procedure (never `queryOptions(params)`).
- **Loading state**: prefer `isPending` (not `isLoading`) for queries and mutations.
- **Errors**: avoid per-mutation `onError` handlers; the QueryClient has a global `mutations.onError` default.
- **Invalidation**: make `onSuccess` async and `await queryClient.invalidateQueries(trpc.someQuery.queryOptions(input))`.
- **Mutations**: use `.mutate()` in click handlers; use `.mutateAsync()` only when you need the promise (forms, sequential flows).

## Rules / gotchas

- Avoid importing runtime server code into the client; prefer `import type { AppRouter } from '...'`.
- In SSR apps, do not share a single `QueryClient` across requests.
- In the browser, keep `QueryClient` stable across initial render/suspense.

## Reference files

- `references/setup.md`: Repo-style setup (TanStack Start + TanStack Router).
- `references/usage.md`: Loader prefetching, suspense queries, mutations, invalidation, optimistic updates, and type inference.
