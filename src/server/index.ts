import { lazy } from "@trpc/server";

import { router } from "./trpc";

export const appRouter = router({
  apiSpec: lazy(() => import("./rpcs/api-spec").then((v) => v.apiSpecRouter)),
  example: lazy(() => import("./rpcs/example").then((v) => v.exampleRouter)),
  organization: lazy(() => import("./rpcs/organization").then((v) => v.organizationRouter)),
  userPreference: lazy(() => import("./rpcs/user-preference").then((v) => v.userPreferenceRouter)),
  project: lazy(() => import("./rpcs/project").then((v) => v.projectRouter)),
  projectCategory: lazy(() => import("./rpcs/project-category").then((v) => v.projectCategoryRouter)),
});

export type AppRouter = typeof appRouter;
