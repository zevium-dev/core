import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { Redirect } from "~/components/redirect";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "~/components/ui/input-otp";
import { ScreenCenter } from "~/components/ui/screen-center";
import { auth, useUser } from "~/lib/auth";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/auth/two-factor-verify")({
  component: RouteComponent,
});

function RouteComponent() {
  const user = useUser();
  const navigate = Route.useNavigate();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [redirectHome, setRedirectHome] = useState(false);

  const onVerify = async () => {
    setError(null);
    if (code.length !== 6) {
      setError("Enter the 6-digit code.");
      return;
    }
    setLoading(true);
    try {
      // @ts-ignore twoFactor plugin
      const { error: authError } = await auth.twoFactor.verifyTotp({ code, trustDevice: true });
      if (authError) throw new Error(authError.message);
      try {
        // @ts-ignore invalidate session cache
        auth.queryClient?.invalidateQueries({ queryKey: ["session"] });
      } catch { /* noop */ }
      setRedirectHome(true);
    } catch (e) {
      setError((e as Error).message || "Verification failed");
    } finally {
      setLoading(false);
    }
  };

  // If already signed in and 2FA not enabled, redirect home
  if (user && !user.twoFactorEnabled) {
    return <Redirect to="/" />;
  }

  if (redirectHome) {
    return <Redirect to="/" />;
  }

  return (
    <ScreenCenter>
      <div className={cn("flex max-w-sm min-w-sm flex-col gap-6")}> 
        <Card>
          <CardHeader className="space-y-2 text-center">
            <img alt="Zevium" className="mx-auto h-10 w-10" src="/icon.png" />
            <CardTitle className="text-xl">Verify two-factor code</CardTitle>
            <p className="text-muted-foreground text-sm">Enter the code from your two-factor authentication app</p>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3">
              <InputOTP
                maxLength={6}
                value={code}
                onChange={(val) => setCode(val.replace(/[^0-9]/g, ""))}
                containerClassName="justify-center"
                inputMode="numeric"
                aria-invalid={!!error}
                aria-describedby={error ? "otp-error" : undefined}
              >
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
              <p className={cn("text-destructive text-end text-xs", !error && "invisible")} id="otp-error">
                {error ?? "No error"}
              </p>
              <Button className="w-full" disabled={code.length !== 6} loading={loading} onClick={() => void onVerify()}>
                Verify
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </ScreenCenter>
  );
}

