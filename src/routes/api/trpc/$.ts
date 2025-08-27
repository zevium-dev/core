import { createServerFileRoute } from "@tanstack/react-start/server";

const handler = async (req: Request) => {
  const [{ appRouter }, { createServerContext }, { fetchRequestHandler }] = await Promise.all([
    import("~/server"),
    import("~/server/context"),
    import("@trpc/server/adapters/fetch"),
  ]);
  return fetchRequestHandler({
    createContext: createServerContext,
    endpoint: "/api/trpc",
    req,
    router: appRouter,
  });
};

export const ServerRoute = createServerFileRoute("/api/trpc/$").methods({
  GET: ({ request }) => {
    return handler(request);
  },
  POST: ({ request }) => {
    return handler(request);
  },
});
