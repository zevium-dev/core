import { exampleRouter } from "./rpcs/example";
import { router } from "./trpc";

export const appRouter = router({
  example: exampleRouter,
});

export type AppRouter = typeof appRouter;
