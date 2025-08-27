import { createServerFileRoute } from "@tanstack/react-start/server";

export const ServerRoute = createServerFileRoute("/api/openapi/$").methods({
  GET: async ({ request }) => {
    const { openApiHandler } = await import("~/server/orpc");
    return openApiHandler(request);
  },
  POST: async ({ request }) => {
    const { openApiHandler } = await import("~/server/orpc");
    return openApiHandler(request);
  },
});
