import { createServerFileRoute } from "@tanstack/react-start/server";

export const ServerRoute = createServerFileRoute("/api/auth/$").methods({
  GET: async ({ request }) => {
    const { authServer } = await import("~/lib/server/auth");
    return authServer.handler(request);
  },
  POST: async ({ request }) => {
    const { authServer } = await import("~/lib/server/auth");
    return authServer.handler(request);
  },
});
