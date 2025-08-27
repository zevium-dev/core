import z from "zod";

import { publicProcedure, router } from "~/server/trpc";

export const exampleRouter = router({
  hello: publicProcedure
    .meta({ route: { path: "/example/hello", summary: "hello world" } })
    .input(z.object({ name: z.string().optional() }))
    .output(z.object({ greeting: z.string() }))
    .query(({ input }) => {
      return {
        greeting: `hello ${input.name ?? "world"}`,
      };
    }),
});
