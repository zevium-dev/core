import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Separator } from "~/components/ui/separator";
import { auth } from "~/lib/auth";
import { toast } from "sonner";
import QRCode from "react-qr-code";
import { Loader2, RefreshCcw, X, Lock } from "lucide-react";

/**
 * TwoFactorManager
 * Encapsulates enabling, verifying, regenerating backup codes and disabling TOTP-based 2FA using Better Auth client plugin.
 * Assumes `user.twoFactorEnabled` is present on the session user object.
 */
export function TwoFactorManager({ user }: { user: { twoFactorEnabled?: boolean | null } | undefined | null }) {
  const twoFactorEnabled = user?.twoFactorEnabled;
  const [showPanel, setShowPanel] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [password, setPassword] = useState("");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

  const reset = () => {
    setPassword("");
    setTotpUri(null);
    setTotpCode("");
    setBackupCodes(null);
    setEnabling(false);
    setDisabling(false);
    setVerifying(false);
    setRegenerating(false);
  };

  const refetchSession = async () => {
    try {
      // @ts-ignore access query client to invalidate
      auth.queryClient?.invalidateQueries({ queryKey: ["session"] });
    } catch { /* noop */ }
  };

  const startEnable = async () => {
    if (!password) {
      toast.error("Enter your password to enable 2FA");
      return;
    }
    setEnabling(true);
    try {
      // @ts-ignore
      const { data, error } = await auth.twoFactor.enable({ password });
      if (error) throw new Error(error.message);
      setTotpUri(data?.totpURI || null);
      if (data?.backupCodes) setBackupCodes(data.backupCodes);
      toast.success("2FA partially enabled. Verify code to finish.");
    } catch (e) {
      toast.error((e as Error).message || "Failed to start 2FA");
    } finally {
      setEnabling(false);
    }
  };

  const verify = async () => {
    if (!totpCode) {
      toast.error("Enter the 6-digit code");
      return;
    }
    setVerifying(true);
    try {
      // @ts-ignore
      const { error } = await auth.twoFactor.verifyTotp({ code: totpCode, trustDevice: true });
      if (error) throw new Error(error.message);
      toast.success("Two-factor authentication enabled");
      await refetchSession();
      reset();
      setShowPanel(false);
    } catch (e) {
      toast.error((e as Error).message || "Verification failed");
    } finally {
      setVerifying(false);
    }
  };

  const disable = async () => {
    if (!password) {
      toast.error("Enter your password to disable 2FA");
      return;
    }
    setDisabling(true);
    try {
      // @ts-ignore
      const { error } = await auth.twoFactor.disable({ password });
      if (error) throw new Error(error.message);
      toast.success("Two-factor authentication disabled");
      await refetchSession();
      reset();
      setShowPanel(false);
    } catch (e) {
      toast.error((e as Error).message || "Failed to disable 2FA");
    } finally {
      setDisabling(false);
    }
  };

  const regenerate = async () => {
    if (!password) {
      toast.error("Enter password to regenerate codes");
      return;
    }
    setRegenerating(true);
    try {
      // @ts-ignore
      const { data, error } = await auth.twoFactor.generateBackupCodes({ password });
      if (error) throw new Error(error.message);
      if (data?.backupCodes) setBackupCodes(data.backupCodes);
      toast.success("New backup codes generated");
    } catch (e) {
      toast.error((e as Error).message || "Could not regenerate codes");
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <p className="font-medium">Two-Factor Authentication</p>
          <p className="text-muted-foreground text-sm">
            {twoFactorEnabled ? "Enabled on this account" : "Add an extra layer of security"}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { setShowPanel(p => !p); reset(); }}
        >
          {showPanel ? "Close" : twoFactorEnabled ? "Manage" : "Configure"}
        </Button>
      </div>
      {showPanel && (
        <div className="mt-2 space-y-4 rounded-md border border-border/60 p-4">
          {!twoFactorEnabled && !totpUri && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Enable Time-based One-Time Password (TOTP) 2FA. You'll scan a QR code and enter a 6-digit code.
              </p>
              <div className="space-y-2">
                <Label htmlFor="password2fa">Account Password</Label>
                <Input
                  id="password2fa"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button size="sm" onClick={() => void startEnable()} disabled={enabling || !password}>
                  {enabling ? <Loader2 className="h-4 w-4 animate-spin" /> : "Start Enabling"}
                </Button>
              </div>
            </div>
          )}
          {!twoFactorEnabled && totpUri && (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-2">
                <QRCode value={totpUri} className="bg-white p-3 rounded" />
                <p className="text-xs text-muted-foreground break-all max-w-full">If you can't scan: {totpUri}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="totp">Enter 6-digit code</Label>
                <Input
                  id="totp"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="123456"
                />
              </div>
              {backupCodes && (
                <div className="space-y-2">
                  <p className="text-sm font-medium flex items-center gap-1"><Lock className="h-4 w-4" /> Backup Codes</p>
                  <p className="text-xs text-muted-foreground">Store these safely. Each can be used once.</p>
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                    {backupCodes.map(code => (
                      <code key={code} className="rounded bg-muted px-2 py-1 text-xs font-mono">{code}</code>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => { void navigator.clipboard.writeText(backupCodes.join("\n")); toast.success("Backup codes copied"); }}
                    >
                      Copy Codes
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const printable = backupCodes.join("\n");
                        const w = window.open("", "_blank");
                        if (w) { w.document.write(`<pre>${printable}</pre>`); w.document.close(); }
                      }}
                    >
                      Print
                    </Button>
                  </div>
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => { reset(); setShowPanel(false); }}>Cancel</Button>
                <Button size="sm" onClick={() => void verify()} disabled={verifying || totpCode.length !== 6}>
                  {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify & Enable"}
                </Button>
              </div>
            </div>
          )}
          {twoFactorEnabled && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">2FA is currently enabled. Regenerate backup codes or disable it.</p>
              <div className="space-y-2">
                <Label htmlFor="password2faDisable">Account Password</Label>
                <Input
                  id="password2faDisable"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                />
              </div>
              {backupCodes && backupCodes.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium flex items-center gap-1"><Lock className="h-4 w-4" /> Backup Codes</p>
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                    {backupCodes.map(code => (
                      <code key={code} className="rounded bg-muted px-2 py-1 text-xs font-mono">{code}</code>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={regenerating || !password}
                  onClick={() => void regenerate()}
                >
                  {regenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4 mr-1" />} Regenerate Codes
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={disabling || !password}
                  onClick={() => void disable()}
                >
                  {disabling ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4 mr-1" />} Disable 2FA
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      <Separator />
    </div>
  );
}
