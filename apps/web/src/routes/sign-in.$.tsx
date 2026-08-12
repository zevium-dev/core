import { SignIn } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

import { clerkShadcnTheme } from "#/lib/clerk-theme";

export const Route = createFileRoute("/sign-in/$")({
  component: Page,
  head: () => ({
    meta: [{ title: "Sign in · Zevium" }],
  }),
});

function Page() {
  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <SignIn appearance={{ theme: clerkShadcnTheme }} />
    </div>
  );
}
