import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import QRCode from "react-qr-code";

import { Redirect } from "~/components/redirect";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "~/components/ui/input-otp";
import { Label } from "~/components/ui/label";
import { Progress } from "~/components/ui/progress";
import { ScreenCenter } from "~/components/ui/screen-center";
import { auth, useSession } from "~/lib/auth";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/auth/two-factor-auth")({
  component: RouteComponent,
});

function RouteComponent() {
  const queryClient = useQueryClient();
  const user = useSession().user;

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [password, setPassword] = useState("");
  const [enabling, setEnabling] = useState(false);
  const [totpUri, setTotpUri] = useState<null | string>(null);
  const [otp, setOtp] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<null | string>(null);
  const [backupCodes, setBackupCodes] = useState<Array<string> | null>(null);

  if (!user) {
    return <Redirect to="/" />;
  }

  const progress = step === 1 ? 25 : step === 2 ? 50 : step === 3 ? 75 : 100;

  const startEnable = async () => {
    setError(null);
    if (!password) {
      setError("Please enter your password.");
      return;
    }
    setEnabling(true);
    try {
      const { data, error: authError } = await auth.twoFactor.enable({ password });
      if (authError) throw new Error(authError.message);
      const uri = data.totpURI;
      if (!uri) throw new Error("TOTP URI not received");
      setTotpUri(uri);
      if (Array.isArray(data.backupCodes) && data.backupCodes.length > 0) {
        setBackupCodes(data.backupCodes);
      }
      setStep(2);
    } catch (e) {
      setError((e as Error).message || "Failed to start 2FA");
    } finally {
      setEnabling(false);
    }
  };

  const verifyOtp = async () => {
    setError(null);
    if (otp.length !== 6) {
      setError("Enter the 6-digit code.");
      return;
    }
    setVerifying(true);
    try {
      const { error: authError } = await auth.twoFactor.verifyTotp({ code: otp, trustDevice: true });
      if (authError) throw new Error(authError.message);
      await queryClient.invalidateQueries({ queryKey: ["session"] }).catch(() => null);
      setStep(3);
    } catch (e) {
      setError((e as Error).message || "Verification failed");
    } finally {
      setVerifying(false);
    }
  };

  return (
    <ScreenCenter>
      <div className={cn("flex max-w-sm min-w-sm flex-col gap-6")}>
        <Card>
          <CardHeader className="space-y-2 text-center">
            <CardTitle className="text-xl">Two-Factor Authentication</CardTitle>
            <Progress value={progress} />
          </CardHeader>
          <CardContent>
            {step === 1 && (
              <div className="grid gap-6">
                <div className="grid gap-2 text-center">
                  <div className="flex justify-center">
                    <Avatar className="size-14">
                      <AvatarImage alt={user.name} src={user.image ?? undefined} />
                      <AvatarFallback>
                        {(user.name.trim().split(/\s+/).at(0)?.at(0) ?? user.email.at(0) ?? "U").toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                  </div>
                  <div className="text-sm text-muted-foreground">Signed in as</div>
                  <div className="font-medium">{user.email}</div>
                </div>
                <div className="grid gap-1">
                  <Label className="mb-2" htmlFor="password">
                    Enter password to begin
                  </Label>
                  <Input
                    aria-describedby={error ? "password-error" : undefined}
                    aria-invalid={!!error}
                    autoComplete="current-password"
                    disabled={enabling}
                    id="password"
                    onChange={(e) => setPassword(e.target.value)}
                    type="password"
                    value={password}
                  />
                  <p
                    className={cn(
                      "text-end text-xs text-destructive",
                      !error &&
                        `
                    invisible
                  `,
                    )}
                    id="password-error"
                  >
                    {error ?? "No error"}
                  </p>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="grid gap-6">
                {totpUri && (
                  <div className="flex flex-col items-center gap-2">
                    <QRCode className="rounded-sm bg-white p-3" value={totpUri} />
                    <p
                      className={`
                      text-center text-xs break-all text-muted-foreground
                    `}
                    >
                      Can't scan? Use this key/URL: {totpUri}
                    </p>
                  </div>
                )}
                <div className="grid gap-1">
                  <Label className="mb-2">Enter 6-digit code</Label>
                  <InputOTP
                    aria-describedby={error ? "otp-error" : undefined}
                    aria-invalid={!!error}
                    containerClassName="justify-center"
                    inputMode="numeric"
                    maxLength={6}
                    onChange={(val) => setOtp(val.replace(/[^0-9]/g, ""))}
                    value={otp}
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
                  <p
                    className={cn(
                      "text-end text-xs text-destructive",
                      !error &&
                        `
                    invisible
                  `,
                    )}
                    id="otp-error"
                  >
                    {error ?? "No error"}
                  </p>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="grid gap-4">
                <div className="space-y-1 text-center">
                  <p className="text-lg font-semibold">Recovery codes</p>
                  <p className="text-sm text-muted-foreground">Save these codes in a safe place.</p>
                </div>
                {Array.isArray(backupCodes) && backupCodes.length > 0 ? (
                  <>
                    <div
                      className={`
                      grid grid-cols-2 gap-2
                      md:grid-cols-3
                    `}
                    >
                      {backupCodes.map((code) => (
                        <code
                          className={`
                          rounded-sm bg-muted px-2 py-1 text-center font-mono
                          text-xs
                        `}
                          key={code}
                        >
                          {code}
                        </code>
                      ))}
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        onClick={() => {
                          const file = new Blob([backupCodes.join("\n")], { type: "text/plain;charset=utf-8" });
                          const url = URL.createObjectURL(file);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = "zevium-backup-codes.txt";
                          document.body.appendChild(a);
                          a.click();
                          a.remove();
                          URL.revokeObjectURL(url);
                        }}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Download codes
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">No recovery codes available.</p>
                )}
              </div>
            )}

            {step === 4 && (
              <div className="grid place-items-center gap-4 py-4 text-center">
                <img alt="Zevium" className="size-12" src="/icon.png" />
                <div className="space-y-1">
                  <p className="text-lg font-semibold">You're all set!</p>
                  <p className="text-sm text-muted-foreground">
                    You have successfully enabled two-factor authentication for Zevium.
                  </p>
                </div>
              </div>
            )}
          </CardContent>
          <CardFooter className="flex justify-end gap-2">
            {step === 1 && (
              <Button className="w-full" loading={enabling} onClick={() => void startEnable()}>
                Continue
              </Button>
            )}
            {step === 2 && (
              <Button
                className="w-full"
                disabled={otp.length !== 6}
                loading={verifying}
                onClick={() => void verifyOtp()}
              >
                Verify & Enable
              </Button>
            )}
            {step === 3 && (
              <Button className="w-full" onClick={() => setStep(4)}>
                Continue
              </Button>
            )}
            {step === 4 && (
              <Button className="w-full" onClick={() => history.back()}>
                Close
              </Button>
            )}
          </CardFooter>
        </Card>
      </div>
    </ScreenCenter>
  );
}
