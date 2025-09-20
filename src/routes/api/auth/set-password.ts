import { createServerFileRoute } from "@tanstack/react-start/server";

// POST /api/auth/set-password
// Body: { newPassword: string }
// Sets an initial password for an OAuth-only user using Better Auth server API.
// Relies on session cookies automatically forwarded with the request.

export const ServerRoute = createServerFileRoute("/api/auth/set-password").methods({
  POST: async ({ request }) => {
    try {
      const { authServer } = await import("~/lib/server/auth");
      const { newPassword } = await request.json();
      if (typeof newPassword !== "string" || newPassword.length < 8) {
        return new Response(JSON.stringify({ error: "Password must be at least 8 characters" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      // @ts-ignore runtime api namespace (Better Auth)
      const { error } = await authServer.api.setPassword({
        body: { newPassword },
        headers: request.headers,
      });
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      console.error("/api/auth/set-password error", e);
      return new Response(JSON.stringify({ error: "Internal Server Error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
});
