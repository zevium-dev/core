import { router } from "./trpc";

export const appRouter = router({
  // add routes here
});

export type AppRouter = typeof appRouter;
