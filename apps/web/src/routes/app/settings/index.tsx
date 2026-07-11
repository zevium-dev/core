import { useUser } from "@clerk/tanstack-react-start";
import { createFileRoute, Link } from "@tanstack/react-router";
import { KeyRound, UserRound } from "lucide-react";

import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { Label } from "#/components/ui/label";
import { Skeleton } from "#/components/ui/skeleton";

export const Route = createFileRoute("/app/settings/")({
  component: SettingsPage,
  head: () => ({
    meta: [{ title: "Settings · Zevium" }],
  }),
});

function SettingsPage() {
  const { user, isLoaded } = useUser();

  const displayName =
    user?.fullName ??
    user?.username ??
    user?.primaryEmailAddress?.emailAddress ??
    "—";
  const email = user?.primaryEmailAddress?.emailAddress ?? "—";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Account, keys, and activity.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserRound className="size-4" />
            Profile
          </CardTitle>
          <CardDescription>Identity from Clerk</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!isLoaded ? (
            <>
              <div className="space-y-2">
                <Label>Display name</Label>
                <Skeleton className="h-9 w-full max-w-sm" />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <Skeleton className="h-9 w-full max-w-sm" />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label>Display name</Label>
                <p className="text-sm">{displayName}</p>
              </div>
              <div className="space-y-1.5">
                <Label>Email</Label>
                <p className="text-sm text-muted-foreground">{email}</p>
              </div>
              <p className="text-xs text-muted-foreground">
                Manage password, 2FA, and connected accounts from the user menu
                (avatar) in the sidebar.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4" />
            API keys
          </CardTitle>
          <CardDescription>
            Machine keys for the gateway. One active key per user.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link to="/app/settings/keys">Manage keys</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
