import { createServerFileRoute } from "@tanstack/react-start/server";

const handler = async (req: Request) => {
  const { appRouter } = await import("~/server");
  const { createServerContext } = await import("~/server/context");
  const { fetchRequestHandler } = await import("@trpc/server/adapters/fetch");
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
