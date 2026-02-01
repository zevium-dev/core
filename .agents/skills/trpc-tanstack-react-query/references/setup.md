# Setup templates

Use these as starting points; adapt file paths and the API URL to your app.

## A) Setup with React context (SSR-friendly)

Create `utils/trpc.ts`:

```tsx
import { createTRPCContext } from '@trpc/tanstack-react-query';

import type { AppRouter } from '../server/router';

export const { TRPCProvider, useTRPC, useTRPCClient } =
  createTRPCContext<AppRouter>();
```

Create a QueryClient helper that is safe for SSR (new per request, stable in browser):

```ts
import { QueryClient } from '@tanstack/react-query';

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // With SSR, prefer a staleTime > 0 to avoid immediate refetch on hydration.
        staleTime: 60 * 1000,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

export function getQueryClient() {
  if (typeof window === 'undefined') return makeQueryClient();
  if (!browserQueryClient) browserQueryClient = makeQueryClient();
  return browserQueryClient;
}
```

Wrap your app:

```tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { useState } from 'react';

import type { AppRouter } from '../server/router';
import { TRPCProvider } from './utils/trpc';
import { getQueryClient } from './utils/queryClient';

export function App() {
  const queryClient = getQueryClient();

  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: 'http://localhost:2022/trpc',
        }),
      ],
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {/* Your app here */}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
```

If you already have React Query set up, reuse your existing `QueryClient` and `QueryClientProvider`.

## B) Setup without React context (SPA singleton)

Create `utils/trpc.ts`:

```ts
import { QueryClient } from '@tanstack/react-query';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';

import type { AppRouter } from '../server/router';

export const queryClient = new QueryClient();

export const client = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: 'http://localhost:2022/trpc' })],
});

export const trpc = createTRPCOptionsProxy<AppRouter>({
  client,
  queryClient,
});
```

Wrap your app with React Query:

```tsx
import { QueryClientProvider } from '@tanstack/react-query';

import { queryClient } from './utils/trpc';

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* Your app here */}
    </QueryClientProvider>
  );
}
```
