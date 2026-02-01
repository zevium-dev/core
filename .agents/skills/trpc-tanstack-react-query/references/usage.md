# Usage patterns

These snippets assume you are using TanStack React Query and the tRPC TanStack integration.

## Query

```tsx
import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '../utils/trpc';

export function User() {
  const trpc = useTRPC();
  const userQuery = useQuery(trpc.getUser.queryOptions({ id: 'id_bilbo' }));
  return <div>{userQuery.data?.name}</div>;
}
```

## Mutation + invalidation

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '../utils/trpc';

export function CreateUser() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const createUser = useMutation(
    trpc.createUser.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.getUser.queryKey(),
        });
      },
    }),
  );

  return (
    <button onClick={() => createUser.mutate({ name: 'Frodo' })}>
      Create Frodo
    </button>
  );
}
```

## Conditional queries (skipToken)

```tsx
import { skipToken, useQuery } from '@tanstack/react-query';

import { useTRPC } from '../utils/trpc';

export function MaybeUser({ userId }: { userId?: string }) {
  const trpc = useTRPC();

  const q = useQuery(
    trpc.getUser.queryOptions(userId ? { id: userId } : skipToken),
  );

  return <div>{q.data?.name}</div>;
}
```

## Query/mutation key prefixing (multiple providers)

Enable key prefixing when creating a context:

```tsx
import { createTRPCContext } from '@trpc/tanstack-react-query';

import type { BillingRouter } from '../server/billing';
import type { AccountRouter } from '../server/account';

const billing = createTRPCContext<BillingRouter, { keyPrefix: true }>();
export const BillingProvider = billing.TRPCProvider;
export const useBilling = billing.useTRPC;

const account = createTRPCContext<AccountRouter, { keyPrefix: true }>();
export const AccountProvider = account.TRPCProvider;
export const useAccount = account.useTRPC;
```

Pass a `keyPrefix` to each provider:

```tsx
<BillingProvider trpcClient={billingClient} queryClient={queryClient} keyPrefix="billing">
  <AccountProvider trpcClient={accountClient} queryClient={queryClient} keyPrefix="account">
    {/* ... */}
  </AccountProvider>
</BillingProvider>
```

## Infer input/output types

Infer types for a whole router:

```ts
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../server/router';

export type Inputs = inferRouterInputs<AppRouter>;
export type Outputs = inferRouterOutputs<AppRouter>;
```

Infer types for a single procedure (context pattern):

```ts
import type { inferInput, inferOutput } from '@trpc/tanstack-react-query';
import { useTRPC } from '../utils/trpc';

export function TypesExample() {
  const trpc = useTRPC();
  type Input = inferInput<typeof trpc.getUser>;
  type Output = inferOutput<typeof trpc.getUser>;
  return null;
}
```

## Call the tRPC client directly

Context pattern:

```ts
import { useTRPCClient } from '../utils/trpc';

export function Component() {
  const trpcClient = useTRPCClient();
  // trpcClient.path.to.procedure.query({ ... })
  return null;
}
```

Singleton pattern:

```ts
import { client } from '../utils/trpc';

// client.path.to.procedure.query({ ... })
```
