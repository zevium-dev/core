import { lazy } from "@trpc/server";

import { router } from "./trpc";

export const appRouter = router({
  apiSpec: lazy(() => import("./rpcs/api-spec").then((v) => v.apiSpecRouter)),
  example: lazy(() => import("./rpcs/example").then((v) => v.exampleRouter)),
  organization: lazy(() => import("./rpcs/organization").then((v) => v.organizationRouter)),
  project: lazy(() => import("./rpcs/project").then((v) => v.projectRouter)),
});

export type AppRouter = typeof appRouter;
