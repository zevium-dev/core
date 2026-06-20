import { createFileRoute } from "@tanstack/react-router";

import { render } from "react-email";

export const Route = createFileRoute("/$internal/email-templates-preview")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const template = url.searchParams.get("template");

        if (!template) {
          const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Email Templates Preview</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background: #0b0d10; color: #e8eef6; }
      a { color: inherit; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .wrap { display: grid; grid-template-rows: auto 1fr; min-height: 100vh; }
      .top { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 18px; border-bottom: 1px solid rgba(232, 238, 246, 0.12); }
      .title { display: grid; gap: 2px; }
      .title h1 { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: 0.2px; }
      .title p { margin: 0; font-size: 12px; opacity: 0.72; }
      .links { display: flex; flex-wrap: wrap; gap: 10px; }
      .pill { display: inline-flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 999px; border: 1px solid rgba(232, 238, 246, 0.16); background: rgba(255, 255, 255, 0.04); font-size: 13px; }
      .pill span { opacity: 0.7; font-size: 12px; }
      .main { padding: 18px; }
      iframe { width: 100%; height: calc(100vh - 96px); border: 1px solid rgba(232, 238, 246, 0.16); border-radius: 14px; background: #fff; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="top">
        <div class="title">
          <h1>Email Templates Preview</h1>
          <p>Click a template to load it into the iframe</p>
        </div>
        <nav class="links">
          <a class="pill" href="?template=organization-invitation" target="preview">Organization invitation <span>new</span></a>
          <a class="pill" href="?template=reset-password" target="preview">Reset password</a>
          <a class="pill" href="?template=email-verify" target="preview">Email verification</a>
        </nav>
      </div>
      <div class="main">
        <iframe name="preview" src="?template=organization-invitation" title="Email preview" loading="eager"></iframe>
      </div>
    </div>
  </body>
</html>`;

          return new Response(html, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
            },
          });
        }

        if (template === "reset-password") {
          const { ResetPasswordEmail } = await import("~/lib/email/templates/reset-password");
          const html = await render(
            <ResetPasswordEmail fullUrl="https://www.zevium.dev/auth/reset-password?token=example" name="John Doe" />,
          );
          return new Response(`<!doctype html>${html}`, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
            },
          });
        }

        if (template === "email-verify") {
          const { EmailVerify } = await import("~/lib/email/templates/email-verify");
          const html = await render(
            <EmailVerify fullUrl="https://www.zevium.dev/auth/verify-email?token=example" name="John Doe" />,
          );
          return new Response(`<!doctype html>${html}`, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
            },
          });
        }

        if (template === "organization-invitation") {
          const { OrganizationInvitationEmail } = await import("~/lib/email/templates/organization-invitation");
          const html = await render(
            <OrganizationInvitationEmail
              invitedByEmail="john.doe@zevium.dev"
              invitedByName="John Doe"
              inviteLink="https://www.zevium.dev/auth/sign-in?redirectTo=%2Fapp%2Finvitations"
              organizationName="Acme, Inc."
            />,
          );
          return new Response(`<!doctype html>${html}`, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
            },
          });
        }

        return new Response("Unknown template", {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
          status: 400,
        });
      },
    },
  },
});
