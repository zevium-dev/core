import { createFileRoute } from "@tanstack/react-router";

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

export const Route = createFileRoute("/api/trpc/$")({
  server: {
    handlers: {
      GET: ({ request }) => {
        return handler(request);
      },
      POST: ({ request }) => {
        return handler(request);
      },
    },
  },
});
