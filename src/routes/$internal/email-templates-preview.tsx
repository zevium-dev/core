import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/$internal/email-templates-preview")({
  server: {
    handlers: {
      GET: async () => {
        const { renderToString } = await import("react-dom/server");
        const { EmailVerify } = await import("~/lib/email/templates/email-verify");
        const html = renderToString(<EmailVerify fullUrl="#" name="John Doe" />);
        return new Response(html, { headers: { "Content-Type": "text/html" } });
      },
    },
  },
});
