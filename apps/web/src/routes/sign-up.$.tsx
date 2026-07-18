import { SignUp } from "@clerk/tanstack-react-start";
import { shadcn } from "@clerk/ui/themes";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/sign-up/$")({
  component: Page,
  head: () => ({
    meta: [{ title: "Create account · Zevium" }],
  }),
});

function Page() {
  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <SignUp appearance={{ theme: shadcn }} />
    </div>
  );
}
