import { UserProfile } from "@clerk/tanstack-react-start";
import { shadcn } from "@clerk/ui/themes";
import { createFileRoute } from "@tanstack/react-router";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";

export const Route = createFileRoute("/app/settings/")({
  component: SettingsPage,
  head: () => ({
    meta: [{ title: "Settings · Zevium" }],
  }),
});

function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Account, keys, and activity.
        </p>
      </div>

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>
            Profile, security, and connected accounts via Clerk.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 sm:p-2">
          <div className="w-full overflow-x-auto">
            <UserProfile
              routing="hash"
              appearance={{
                theme: shadcn,
                elements: {
                  rootBox: "w-full mx-auto",
                  cardBox: "w-full shadow-none",
                  card: "w-full shadow-none",
                  navbar: "border-border",
                  scrollBox: "w-full",
                },
              }}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
