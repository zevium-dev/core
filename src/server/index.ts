import { lazy } from "@trpc/server";

import { router } from "./trpc";

export const appRouter = router({
  credits: lazy(() => import("./rpcs/credits").then((v) => v.creditsRouter)),
  example: lazy(() => import("./rpcs/example").then((v) => v.exampleRouter)),
  organization: lazy(() => import("./rpcs/organization").then((v) => v.organizationRouter)),
  project: lazy(() => import("./rpcs/project").then((v) => v.projectRouter)),
  userPreference: lazy(() => import("./rpcs/user-preference").then((v) => v.userPreferenceRouter)),
});

export type AppRouter = typeof appRouter;
