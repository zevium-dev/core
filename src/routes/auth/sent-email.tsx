import { createFileRoute, Link } from "@tanstack/react-router";
import { type } from "arktype";

import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { ScreenCenter } from "~/components/ui/screen-center";
import { cn } from "~/lib/utils";

export const FormValuesArk = type({ email: "string.email" });

export const Route = createFileRoute("/auth/sent-email")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <ScreenCenter>
      <div className={cn("flex max-w-sm min-w-sm flex-col gap-6")}>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Verify your email</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              <p className="text-center text-sm text-muted-foreground">
                Didn&apos;t receive the email? You can{" "}
                <Link className="text-accent-foreground hover:underline" to="/auth/verify-email">
                  try resending
                </Link>{" "}
                the verification email.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </ScreenCenter>
  );
}
