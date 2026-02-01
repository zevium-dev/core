---
name: trpc-tanstack-react-query
description: Implement and use the tRPC v11 TanStack React Query client in React apps. Use when wiring @trpc/tanstack-react-query with @tanstack/react-query (QueryClient + TRPCProvider), choosing SSR-friendly context setup vs CSR singleton setup, generating type-safe queryOptions/mutationOptions/queryKey helpers, and doing cache invalidation/prefetch with TanStack Query.
---

# tRPC + TanStack React Query (v11)

Use the new `@trpc/tanstack-react-query` client (recommended in tRPC v11) to generate type-safe TanStack React Query primitives like QueryOptions, MutationOptions, and QueryKeys.

## Workflow

1) Choose a setup style

- Use `createTRPCContext` when you need React context (SSR, full-stack frameworks, or you want `useTRPC()` / `useTRPCClient()`).
- Use `createTRPCOptionsProxy` when building a client-only SPA and you prefer singletons.

2) Install dependencies

- Install `@trpc/client`, `@trpc/tanstack-react-query`, `@tanstack/react-query`.
- Install `@trpc/server` if you need helper types like `inferRouterInputs` / `inferRouterOutputs`.

3) Create `utils/trpc.ts`

- Follow the context-provider or singleton template in `references/setup.md`.
- Import `AppRouter` using `import type`.

4) Wire providers

- Context-provider pattern: wrap the app with `QueryClientProvider`, then `TRPCProvider` (same `QueryClient` instance).
- Singleton pattern: wrap the app with `QueryClientProvider` only.

5) Call procedures via TanStack Query

- Pass `trpc.someProcedure.queryOptions(input, tanstackOptions)` into `useQuery` / `useSuspenseQuery` / `useInfiniteQuery`.
- Pass `trpc.someProcedure.mutationOptions(tanstackOptions)` into `useMutation`.
- Use `trpc.someProcedure.queryKey()` with `useQueryClient()` for type-safe invalidation.

See `references/usage.md` for copy/paste patterns.

## Rules / gotchas

- Avoid importing runtime server code into the client; prefer `import type { AppRouter } from '...'`.
- In SSR apps, do not share a single `QueryClient` across requests.
- In the browser, keep `QueryClient` stable across initial render/suspense.

## Reference files

- `references/setup.md`: Setup templates (context provider + singleton).
- `references/usage.md`: Query/mutation patterns, invalidation, `skipToken`, key prefixing, and type inference.
