import { SignIn } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

import { clerkShadcnTheme } from "#/lib/clerk-theme";
import { AuthCardSkeleton } from "#/components/auth-card-skeleton";
import { AuthenticatedProviders } from "#/components/authenticated-providers";
import { safeReturnPath } from "#/lib/return-path";

export const Route = createFileRoute("/sign-in/$")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: safeReturnPath(search.redirect, "/app"),
  }),
  component: Page,
  head: () => ({
    meta: [{ title: "Sign in · Zevium" }],
  }),
});

function Page() {
  const { convexQueryClient, principalCache } = Route.useRouteContext();
  const { redirect } = Route.useSearch();

  return (
    <AuthenticatedProviders
      client={convexQueryClient.convexClient}
      principalCache={principalCache}
    >
      <div className="flex min-h-svh items-center justify-center p-4">
        <div className="auth-card-shell grid w-full max-w-sm place-items-center [&>*]:[grid-area:1/1]">
          <div className="auth-card-pending w-full">
            <AuthCardSkeleton label="Loading sign in" />
          </div>
          <SignIn
            appearance={{ theme: clerkShadcnTheme }}
            fallbackRedirectUrl={redirect}
          />
        </div>
      </div>
    </AuthenticatedProviders>
  );
}
