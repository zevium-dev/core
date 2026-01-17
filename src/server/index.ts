import { lazy } from "@trpc/server";

import { router } from "./trpc";

export const appRouter = router({
  example: lazy(() => import("./rpcs/example").then((v) => v.exampleRouter)),
  openapiSchema: lazy(() => import("./rpcs/openapi-schema").then((v) => v.openapiSchemaRouter)),
  organization: lazy(() => import("./rpcs/organization").then((v) => v.organizationRouter)),
  project: lazy(() => import("./rpcs/project").then((v) => v.projectRouter)),
  projectSecret: lazy(() => import("./rpcs/projectSecret").then((v) => v.projectSecretRouter)),
  tag: lazy(() => import("./rpcs/tag").then((v) => v.tagRouter)),
  userPreference: lazy(() => import("./rpcs/user-preference").then((v) => v.userPreferenceRouter)),
});

export type AppRouter = typeof appRouter;
