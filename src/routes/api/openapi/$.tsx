import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/openapi/$")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { openApiHandler } = await import("~/server/orpc");
        return openApiHandler(request);
      },
      POST: async ({ request }) => {
        const { openApiHandler } = await import("~/server/orpc");
        return openApiHandler(request);
      },
    },
  },
});
