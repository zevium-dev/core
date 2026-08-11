import { SignUp } from "@clerk/tanstack-react-start";
import { shadcn } from "@clerk/ui/themes";
import { createFileRoute } from "@tanstack/react-router";

import { AuthCardSkeleton } from "#/components/auth-card-skeleton";
import { AuthenticatedProviders } from "#/components/authenticated-providers";
import { safeReturnPath } from "#/lib/return-path";

export const Route = createFileRoute("/sign-up/$")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: safeReturnPath(search.redirect, "/app"),
  }),
  component: Page,
  head: () => ({
    meta: [{ title: "Create account · Zevium" }],
  }),
});

function Page() {
  const { convexQueryClient } = Route.useRouteContext();
  const { redirect } = Route.useSearch();

  return (
    <AuthenticatedProviders client={convexQueryClient.convexClient}>
      <div className="flex min-h-svh items-center justify-center p-4">
        <div className="auth-card-shell grid w-full max-w-sm place-items-center [&>*]:[grid-area:1/1]">
          <div className="auth-card-pending w-full">
            <AuthCardSkeleton label="Loading account creation" />
          </div>
          <SignUp
            appearance={{ theme: shadcn }}
            fallbackRedirectUrl={redirect}
          />
        </div>
      </div>
    </AuthenticatedProviders>
  );
}
