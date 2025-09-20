import { createServerFileRoute } from "@tanstack/react-start/server";

import { EmailVerify } from "~/lib/email/templates/email-verify";

export const ServerRoute = createServerFileRoute("/$internal/email-templates-preview").methods({
  GET: async () => {
    const { renderToString } = await import("react-dom/server");
    const html = renderToString(<EmailVerify fullUrl="#" name="John Doe" />);
    return new Response(html, { headers: { "Content-Type": "text/html" } });
  },
});
