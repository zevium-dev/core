import { SignUp } from "@clerk/tanstack-react-start";
import { shadcn } from "@clerk/ui/themes";
import { createFileRoute } from "@tanstack/react-router";

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
  const { redirect } = Route.useSearch();
  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <SignUp appearance={{ theme: shadcn }} fallbackRedirectUrl={redirect} />
    </div>
  );
}
