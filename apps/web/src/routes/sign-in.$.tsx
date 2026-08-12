import { SignIn } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

import { safeAppReturnPath } from "#/lib/auth-redirect";
import { clerkShadcnTheme } from "#/lib/clerk-theme";

export const Route = createFileRoute("/sign-in/$")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect_url: safeAppReturnPath(search.redirect_url),
  }),
  component: Page,
  head: () => ({
    meta: [{ title: "Sign in · Zevium" }],
  }),
});

function Page() {
  const { redirect_url: fallbackRedirectUrl } = Route.useSearch();

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <SignIn
        appearance={{ theme: clerkShadcnTheme }}
        fallbackRedirectUrl={fallbackRedirectUrl}
        forceRedirectUrl={fallbackRedirectUrl}
      />
    </div>
  );
}
