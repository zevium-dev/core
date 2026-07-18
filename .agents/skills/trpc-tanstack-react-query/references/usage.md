# Usage patterns (repo)

These snippets match how Zevium uses TanStack Query v5 + tRPC v11.

## Loader prefetch (TanStack Router)

In route loaders, use the router context `context.queryClient` + `context.trpc` (options proxy) to prefetch.

Important: the loader `params` object includes _all_ route slugs; always pass an explicit parameter object to each procedure.

```tsx
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute(
  "/app/organizations/$organizationSlug/projects/$projectSlug",
)({
  loader: ({ context, params }) => {
    const routeParams = {
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
    } as const;

    void context.queryClient.ensureQueryData(
      context.trpc.project.get.queryOptions(routeParams),
    );
    void context.queryClient.ensureQueryData(
      context.trpc.projectSecret.list.queryOptions(routeParams),
    );
  },
  component: RouteComponent,
});
```

## Suspense query (route component)

When the loader prefetches, prefer `useSuspenseQuery()` in the component.

```tsx
import { useSuspenseQuery } from "@tanstack/react-query";

import { useTRPC } from "~/lib/trpc";

export function RouteComponent() {
  const { organizationSlug, projectSlug } = Route.useParams();
  const trpc = useTRPC();

  const projectQuery = useSuspenseQuery(
    trpc.project.get.queryOptions({ organizationSlug, projectSlug }),
  );

  return <div>{projectQuery.data.name}</div>;
}
```

## Mutation + invalidation

Prefer invalidation via `queryOptions()` (no manual queryKey arrays).

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "~/lib/trpc";

export function RenameProject({
  organizationSlug,
  projectSlug,
}: {
  organizationSlug: string;
  projectSlug: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const updateProject = useMutation(
    trpc.project.update.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries(
          trpc.project.get.queryOptions({ organizationSlug, projectSlug }),
        );
      },
    }),
  );

  return (
    <button
      disabled={updateProject.isPending}
      onClick={() => {
        updateProject.mutate({
          organizationSlug,
          projectSlug,
          name: "New name",
        });
      }}
    >
      {updateProject.isPending ? "Saving..." : "Save"}
    </button>
  );
}
```

## Optimistic updates (setQueryData)

Use `queryKey(input)` for type-safe cache updates, then invalidate on settle.

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "~/lib/trpc";

export function useProjectVisibilityMutation(
  organizationSlug: string,
  projectSlug: string,
) {
  const trpc = useTRPC();
  const qc = useQueryClient();

  return useMutation(
    trpc.project.update.mutationOptions({
      onMutate(variables) {
        qc.setQueryData(
          trpc.project.get.queryKey({ organizationSlug, projectSlug }),
          (old) => (old ? { ...old, visibility: variables.visibility } : old),
        );
      },
      async onSettled() {
        await qc.invalidateQueries(
          trpc.project.get.queryOptions({ organizationSlug, projectSlug }),
        );
      },
    }),
  );
}
```

## Conditional queries

Prefer `enabled` for non-suspense queries:

```tsx
import { useQuery } from "@tanstack/react-query";

import { useSession } from "~/lib/auth";
import { useTRPC } from "~/lib/trpc";

export function useUserPreferencesQuery() {
  const user = useSession().user;
  const trpc = useTRPC();

  return useQuery(
    trpc.userPreference.get.queryOptions(undefined, {
      enabled: Boolean(user?.id),
    }),
  );
}
```

If you need to skip a query via input, `skipToken` also works:

```tsx
import { skipToken, useQuery } from "@tanstack/react-query";

import { useTRPC } from "~/lib/trpc";

export function MaybeUser({ userId }: { userId?: string }) {
  const trpc = useTRPC();
  return useQuery(
    trpc.user.get.queryOptions(userId ? { id: userId } : skipToken),
  );
}
```

## Infer input/output types

Infer types for a whole router:

```ts
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

import type { AppRouter } from "~/server";

export type Inputs = inferRouterInputs<AppRouter>;
export type Outputs = inferRouterOutputs<AppRouter>;
```

Infer types for a single procedure (via `useTRPC()`):

```ts
import type { inferInput, inferOutput } from "@trpc/tanstack-react-query";

import { useTRPC } from "~/lib/trpc";

export function TypesExample() {
  const trpc = useTRPC();
  type Input = inferInput<typeof trpc.project.get>;
  type Output = inferOutput<typeof trpc.project.get>;
  return null;
}
```
