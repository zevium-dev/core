import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { authServer } = await import("~/lib/server/auth");
        return authServer.handler(request);
      },
      POST: async ({ request }) => {
        const { authServer } = await import("~/lib/server/auth");
        return authServer.handler(request);
      },
    },
  },
});
