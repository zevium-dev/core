import { UserProfile } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

import { clerkShadcnTheme } from "#/lib/clerk-theme";

export const Route = createFileRoute("/app/settings/")({
  component: SettingsPage,
  head: () => ({
    meta: [{ title: "Settings · Zevium" }],
  }),
});

function SettingsPage() {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Account</h2>
        <p className="text-sm text-muted-foreground">
          Profile, security, and connected accounts via Clerk.
        </p>
      </div>

      <div className="min-h-[28rem] w-full overflow-hidden rounded-xl">
        <UserProfile
          routing="hash"
          appearance={{
            theme: clerkShadcnTheme,
            elements: {
              rootBox: "w-full!",
              cardBox: "w-full! max-w-none!",
              card: "w-full! max-w-none!",
              navbar: "border-border",
              scrollBox: "w-full!",
            },
          }}
        />
      </div>
    </section>
  );
}
