import { lazy } from "@trpc/server";

import { router } from "./trpc";

export const appRouter = router({
  example: lazy(() => import("./rpcs/example").then((v) => v.exampleRouter)),
});

export type AppRouter = typeof appRouter;
