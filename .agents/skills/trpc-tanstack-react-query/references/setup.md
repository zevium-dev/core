# Setup templates (TanStack Start + TanStack Router)

These snippets mirror how this repo wires tRPC v11 + TanStack Query v5.

Canonical sources in this repo:

- `src/lib/query-client/query-client.client.tsx`
- `src/lib/query-client/query-client.server.ts`
- `src/lib/query-client/query-client.ts`
- `src/lib/trpc/trpc.client.ts`
- `src/lib/trpc/headers.server.ts`
- `src/lib/trpc/trpc.server.ts`
- `src/lib/trpc/trpc.ts`
- `src/lib/trpc/index.ts`
- `src/components/providers.tsx`
- `src/router.tsx`

## 1) QueryClient (SSR-safe)

Client config (defaults + global mutation error handler):

```ts
// src/lib/query-client/query-client.client.tsx
import { QueryClient } from "@tanstack/react-query";

export const makeQueryClient = () => {
  return new QueryClient({
    defaultOptions: {
      queries: {
        networkMode: "offlineFirst",
        retry: 2,
        staleTime: 1000 * 60,
      },
      mutations: {
        // Centralized toast/logging; avoid per-mutation onError unless needed.
        onError: (cause) => {
          console.error(cause);
        },
      },
    },
  });
};
```

Server-side cache wrapper:

```ts
// src/lib/query-client/query-client.server.ts
import { cache } from "react";

import { makeQueryClient } from "./query-client.client";

export const cachedMakeQueryClient = cache(makeQueryClient);
```

SSR/client safe accessor (new per request, singleton in browser):

```ts
// src/lib/query-client/query-client.ts
import type { QueryClient } from "@tanstack/react-query";

import { makeQueryClient } from "./query-client.client";
import { cachedMakeQueryClient } from "./query-client.server";

let _queryClientSingleton: null | QueryClient = null;

export const getQueryClient = () => {
  if (!import.meta.env.SSR || typeof window !== "undefined") {
    if (_queryClientSingleton) return _queryClientSingleton;
    _queryClientSingleton = makeQueryClient();
    return _queryClientSingleton;
  }

  return cachedMakeQueryClient();
};
```

## 2) tRPC client (SSR-safe + header forwarding)

Client factory (SuperJSON + batch stream link):

```ts
// src/lib/trpc/trpc.client.ts
import {
  createTRPCClient as createTRPCClientOriginal,
  httpBatchStreamLink,
  httpLink,
  isNonJsonSerializable,
  loggerLink,
  splitLink,
} from "@trpc/client";
import SuperJSON from "superjson";

import type { AppRouter } from "~/server";

export const createTRPCClient = (
  baseUrl = "",
  getHeaders?: () => Promise<Record<string, string>>,
) => {
  return createTRPCClientOriginal<AppRouter>({
    links: [
      loggerLink({
        enabled: (opts) =>
          (process.env.NODE_ENV === "development" &&
            typeof window !== "undefined") ||
          (opts.direction === "down" && opts.result instanceof Error),
      }),
      splitLink({
        condition: (op) => isNonJsonSerializable(op.input),
        false: httpBatchStreamLink({
          headers: getHeaders,
          transformer: SuperJSON,
          url: `${baseUrl}/api/trpc`,
        }),
        true: httpLink({
          headers: getHeaders,
          transformer: {
            deserialize: SuperJSON.deserialize,
            serialize: (d) => d as unknown,
          },
          url: `${baseUrl}/api/trpc`,
        }),
      }),
    ],
  });
};
```

Forward request headers on the server:

```ts
// src/lib/trpc/headers.server.ts
import { getRequestHeaders } from "@tanstack/react-start/server";

export function getServerHeaders() {
  return getRequestHeaders();
}
```

Server-side client cache wrapper:

```ts
// src/lib/trpc/trpc.server.ts
import { cache } from "react";

import { createTRPCClient } from "./trpc.client";

function getBaseUrl() {
  if (typeof window !== "undefined") return "";
  return `http://localhost:${process.env.PORT ?? 5173}`;
}

async function getHeaders() {
  if (typeof window !== "undefined") return {};
  if (!import.meta.env.SSR) return {};

  const { getServerHeaders } = await import("./headers.server");
  return getServerHeaders();
}

export const cachedCreateTRPCClient = cache(() =>
  createTRPCClient(getBaseUrl(), getHeaders),
);
```

SSR/client safe accessor (new per request, singleton in browser):

```ts
// src/lib/trpc/trpc.ts
import { createTRPCClient } from "./trpc.client";
import { cachedCreateTRPCClient } from "./trpc.server";

let _trpcClientSingleTon: null | ReturnType<typeof createTRPCClient> = null;

export const getTrpcClient = () => {
  if (!import.meta.env.SSR || typeof window !== "undefined") {
    if (_trpcClientSingleTon) return _trpcClientSingleTon;
    _trpcClientSingleTon = createTRPCClient();
    return _trpcClientSingleTon;
  }

  return cachedCreateTRPCClient();
};
```

## 3) TRPCProvider + useTRPC() (components)

```ts
// src/lib/trpc/index.ts
import { createTRPCContext } from "@trpc/tanstack-react-query";

import type { AppRouter } from "~/server";

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();
```

## 4) Wire providers (components)

```tsx
// src/components/providers.tsx
import { QueryClientProvider } from "@tanstack/react-query";

import { getQueryClient } from "~/lib/query-client";
import { TRPCProvider } from "~/lib/trpc";
import { getTrpcClient } from "~/lib/trpc/trpc";

export function Providers({ children }: { children: React.ReactNode }) {
  const queryClient = getQueryClient();
  const trpcClient = getTrpcClient();

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider queryClient={queryClient} trpcClient={trpcClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
```

## 5) Wire router context (loaders)

TanStack Router loaders need access to `queryClient` and a `trpc` options proxy.

```ts
// src/router.tsx (snippet)
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";

import { getQueryClient } from "~/lib/query-client";
import { getTrpcClient } from "~/lib/trpc/trpc";

function getTrpcOptionsProxy() {
  const queryClient = getQueryClient();
  const trpcClient = getTrpcClient();
  const trpc = createTRPCOptionsProxy({ client: trpcClient, queryClient });
  return { queryClient, trpc };
}
```

Then pass `{ queryClient, trpc }` into the router context and enable SSR query integration:

```tsx
// src/router.tsx (snippet)
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";

import { routeTree } from "~/routeTree.gen";

export function getRouter() {
  const { queryClient, trpc } = getTrpcOptionsProxy();

  const router = createTanStackRouter({
    context: { queryClient, trpc },
    routeTree,
  });

  setupRouterSsrQueryIntegration({ queryClient, router });

  return router;
}
```

Tip: if route files need router-context types, keep them in a separate file to avoid circular deps during Vite SSR HMR (see `src/router-types.ts`).
