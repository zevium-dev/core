import { lazy } from "@trpc/server";

import { router } from "./trpc";

export const appRouter = router({
  example: lazy(() => import("./rpcs/example").then((v) => v.exampleRouter)),
  organization: lazy(() => import("./rpcs/organization").then((v) => v.organizationRouter)),
});

export type AppRouter = typeof appRouter;
