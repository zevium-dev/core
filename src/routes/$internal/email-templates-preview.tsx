import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/$internal/email-templates-preview")({
  server: {
    handlers: {
      GET: async () => {
        const { renderToString } = await import("react-dom/server");
        // const { EmailVerify } = await import("~/lib/email/templates/email-verify");
        const { ResetPasswordEmail } = await import("~/lib/email/templates/reset-password");
        const html = renderToString(<ResetPasswordEmail fullUrl="#" name="John Doe" />);
        return new Response(html, { headers: { "Content-Type": "text/html" } });
      },
    },
  },
});
