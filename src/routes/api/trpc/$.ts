import { createServerFileRoute } from "@tanstack/react-start/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { appRouter } from "~/server";
import { createContext } from "~/server/context";

const handler = (req: Request) =>
  fetchRequestHandler({
    createContext,
    endpoint: "/api/trpc",
    req,
    router: appRouter,
  });

export const ServerRoute = createServerFileRoute("/api/trpc/$").methods({
  GET: ({ request }) => {
    return handler(request);
  },
  POST: ({ request }) => {
    return handler(request);
  },
});
