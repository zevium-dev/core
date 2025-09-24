import { createLazyFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Calendar, Camera, Copy, Eye, EyeOff, Loader2, Mail, MapPin, Phone, Shield, Trash2, User } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
// 2FA moved to dedicated component
import { toast } from "sonner";

import { ProtectedRoute } from "~/components/protected-route";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import { useUserPreferences } from "~/hooks/use-user-preferences";
import { auth } from "~/lib/auth";

export const Route = createLazyFileRoute("/settings/preference/$")({
  component: AccountPreferenceComponent,
});

export function AccountPreferenceComponent() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: session, isPending } = auth.useSession();
  const user = session?.user;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [location, setLocation] = useState("");
  const [timezone, setTimezone] = useState("");
  const { isLoading: prefsLoading, isUpdating: prefsSaving, preferences, update: updatePreferences } = useUserPreferences();
  const [isSaving, setIsSaving] = useState(false);
  // Password management UI state
  const [showPasswords, setShowPasswords] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [hasPassword, setHasPassword] = useState<boolean | null>(null); // null while detecting
  const [showPasswordEditor, setShowPasswordEditor] = useState(false); // gate showing password forms
  const MIN_PASSWORD_LENGTH = 8;
  const MAX_PASSWORD_LENGTH = 128;
  const passwordTooShort = newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH;
  const passwordTooLong = newPassword.length > MAX_PASSWORD_LENGTH;
  const confirmMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;


  // Initialize from session
  useEffect(() => {
    if (user) {
      setName(user.name ?? "");
      setEmail(user.email ?? "");
    }
  }, [user]);

  // Sync timezone from preferences when loaded (only set if empty locally)
  useEffect(() => {
    if (preferences?.timezone && !timezone) {
      setTimezone(preferences.timezone);
    }
  }, [preferences?.timezone, timezone]);

  // Detect whether user already has a password-based (credential) account.
  // Better Auth exposes listAccounts() on client per docs (listAccounts not yet imported in codebase, so we feature-detect)
  useEffect(() => {
    let ignore = false;
    (async () => {
      if (!auth.listAccounts) {
        // Fallback heuristic: if user signed in via oauth only -> assume no password
        // We cannot be certain without listAccounts; default to no password to show Set Password UI
        if (!ignore) setHasPassword(false);
        return;
      }
      try {
        const result = await auth.listAccounts();
        if (ignore) return;
        const accounts = Array.isArray(result) ? result : (result?.data ?? []);
        const credentialAccount = accounts.find((a: any) => a?.providerId === "credential" || a?.provider === "credential");
        setHasPassword(Boolean(credentialAccount));
      } catch (e) {
        if (!ignore) setHasPassword(false);
      }
    })();
    return () => { ignore = true; };
  }, [session?.user?.id]);

  const resetPasswordFields = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  };

  const handleChangePassword = async () => {
    if (!hasPassword) return; // Should use set password instead
    if (!currentPassword || !newPassword) {
      toast.error("Fill in all password fields");
      return;
    }
    if (passwordTooShort || passwordTooLong) {
      toast.error("Password length invalid");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    setIsChangingPassword(true);
    try {
      if (!auth.changePassword) throw new Error("changePassword not available");
      const { error } = await auth.changePassword({ currentPassword, newPassword, revokeOtherSessions: true });
      if (error) throw new Error(error.message);
      toast.success("Password changed");
      resetPasswordFields();
    } catch (e) {
      toast.error((e as Error).message || "Could not change password");
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleSetPassword = async () => {
    if (hasPassword) return; // Should change instead
    if (!newPassword) {
      toast.error("Enter a password");
      return;
    }
    if (passwordTooShort || passwordTooLong) {
      toast.error("Password length invalid");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    setIsChangingPassword(true);
    try {
      // setPassword requires server action; We'll call a (to be implemented) internal endpoint /api/auth/set-password
      // Placeholder minimal implementation using fetch
      const res = await fetch("/api/auth/set-password", {
        body: JSON.stringify({ newPassword }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed to set password");
      toast.success("Password set successfully");
      setHasPassword(true);
      resetPasswordFields();
    } catch (e) {
      toast.error((e as Error).message || "Could not set password");
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleSave = useCallback(async () => {
    if (!user) return;
    setIsSaving(true);
    try {
      // Persist changed profile + preferences in a single user action
      // 1. Update name only if it actually changed
      if (name.trim() !== (user?.name ?? "")) {
        const { error } = await auth.updateUser({ name: name.trim() });
        if (error) throw new Error(error.message);
      }
      // 2. Update timezone preference only if it changed (was previously saved on each select)
      if (timezone && timezone !== (preferences?.timezone ?? "")) {
        await updatePreferences({ timezone });
      }
      toast.success("Changes saved");
    } catch (e) {
      toast.error((e as Error).message || "Update failed");
    } finally {
      setIsSaving(false);
    }
  }, [name, timezone, user, preferences?.timezone, updatePreferences]);

  // 2FA manage (enabled state) - inline controls
  const [twoFactorOpen, setTwoFactorOpen] = useState(false);
  const [twoFactorPassword, setTwoFactorPassword] = useState("");
  const [twoFactorCodes, setTwoFactorCodes] = useState<Array<string> | null>(null);
  const [regenerating2FA, setRegenerating2FA] = useState(false);
  const [disabling2FA, setDisabling2FA] = useState(false);

  const refetchSession = async () => {
    try {
      await queryClient.invalidateQueries({ queryKey: ["session"] });
    } catch { /* noop */ }
  };

  const handleRegenerateCodes = async () => {
    if (!twoFactorPassword) {
      toast.error("Enter password to regenerate codes");
      return;
    }
    setRegenerating2FA(true);
    try {
      const { data, error } = await auth.twoFactor.generateBackupCodes({ password: twoFactorPassword });
      if (error) throw new Error(error.message);
      if (Array.isArray(data?.backupCodes)) setTwoFactorCodes(data.backupCodes);
      toast.success("New backup codes generated");
    } catch (e) {
      toast.error((e as Error).message || "Could not regenerate codes");
    } finally {
      setRegenerating2FA(false);
    }
  };

  const handleDisable2FA = async () => {
    if (!twoFactorPassword) {
      toast.error("Enter password to disable 2FA");
      return;
    }
    setDisabling2FA(true);
    try {
      const { error } = await auth.twoFactor.disable({ password: twoFactorPassword });
      if (error) throw new Error(error.message);
      toast.success("Two-factor authentication disabled");
      setTwoFactorOpen(false);
      setTwoFactorCodes(null);
      setTwoFactorPassword("");
      await refetchSession();
    } catch (e) {
      toast.error((e as Error).message || "Failed to disable 2FA");
    } finally {
      setDisabling2FA(false);
    }
  };

  return (
    <ProtectedRoute>
      <div className="mx-auto w-full max-w-3xl min-w-0 flex-1 space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <User className="text-muted-foreground h-6 w-6" />
        <h1 className="text-foreground text-2xl font-bold">Account</h1>
      </div>

      {/* Profile Section */}
      <Card className="bg-card/50 border-border/50 w-full backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Profile Information
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Avatar Section */}
          <div className="flex items-center gap-4">
            <div className="relative">
              <Avatar className="h-20 w-20">
                <AvatarImage
                  alt={name || "User avatar"}
                  onError={(e) => {
                    // Replace broken image with fallback
                    const target = e.currentTarget as HTMLImageElement;
                    target.style.display = "none"; // let fallback show
                  }}
                  src={user?.image || "/placeholder-avatar.jpg"}
                />
                <AvatarFallback className="text-lg">
                  {(() => {
                    if (name) {
                      const parts = name.trim().split(/\s+/).slice(0, 2);
                      return parts.map(p => p[0]?.toUpperCase()).join("") || "U";
                    }
                    if (email) return email[0]?.toUpperCase() ?? "U";
                    return "U";
                  })()}
                </AvatarFallback>
              </Avatar>
            </div>
            <div className="space-y-1">
              <h3 className="text-lg font-medium">
                {name || (isPending ? "Loading..." : "Unnamed User")}
              </h3>
              <p className="text-muted-foreground text-sm">{email || (isPending ? "" : "No email")}</p>
              <Button disabled size="sm" title="Avatar upload coming soon" variant="outline">
                Change Photo
              </Button>
            </div>
          </div>

          <Separator />

          {/* Personal Information */}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                onChange={(e) => setName(e.target.value)}
                placeholder="Enter your name"
                value={name}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Contact Information */}
      <Card className="bg-card/50 border-border/50 w-full backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Contact Information
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label className="flex items-center gap-2" htmlFor="email">
              <Mail className="h-4 w-4" />
              Email Address
            </Label>
            <div className="flex items-center gap-2">
              <div
                className="border-input text-foreground/90 flex h-10 w-full items-center justify-between rounded-md border bg-transparent px-3 text-sm"
                id="email"
              >
                <span className="truncate select-text" title={email}>{email || (isPending ? "Loading..." : "No email")}</span>
                {email && (
                  <Button
                    aria-label="Copy email"
                    className="shrink-0"
                    onClick={() => {
                      void navigator.clipboard.writeText(email);
                      toast.success("Email copied");
                    }}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          </div>
          <div className="space-y-2">
            <Label className="flex items-center gap-2" htmlFor="phone">
              <Phone className="h-4 w-4" />
              Phone Number
            </Label>
            <Input
              id="phone"
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Enter phone number"
              type="tel"
              value={phone}
            />
          </div>
        </CardContent>
      </Card>

      {/* Location & Timezone */}
      <Card className="bg-card/50 border-border/50 w-full backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            Location & Timezone
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label className="flex items-center gap-2" htmlFor="location">
              <MapPin className="h-4 w-4" />
              Location
            </Label>
            <Input
              id="location"
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Enter your location"
              value={location}
            />
          </div>
          <div className="space-y-2">
            <Label className="flex items-center gap-2" htmlFor="timezone">
              <Calendar className="h-4 w-4" />
              Timezone
            </Label>
            <Select
              disabled={prefsLoading}
              onValueChange={(val) => {
                // Only update local state; defer persistence until Save is clicked
                setTimezone(val);
              }}
              value={timezone}
            >
              <SelectTrigger>
                <SelectValue placeholder={prefsLoading ? "Loading..." : "Select timezone"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PST">Pacific Standard Time (PST)</SelectItem>
                <SelectItem value="MST">Mountain Standard Time (MST)</SelectItem>
                <SelectItem value="CST">Central Standard Time (CST)</SelectItem>
                <SelectItem value="EST">Eastern Standard Time (EST)</SelectItem>
                <SelectItem value="UTC">Coordinated Universal Time (UTC)</SelectItem>
              </SelectContent>
            </Select>
            {/* Removed unsaved indicator to keep UI minimal */}
          </div>
        </CardContent>
      </Card>

      {/* Security Section */}
      <Card className="bg-card/50 border-border/50 w-full backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Security
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="font-medium">Password</p>
              <p className="text-muted-foreground text-sm">
                {hasPassword === null && "Detecting…"}
                {hasPassword === true && "A password is set for this account"}
                {hasPassword === false && "No password set (OAuth only). You can set one."}
              </p>
            </div>
            {!showPasswordEditor && hasPassword !== null && (
              <Button
                className="self-start"
                disabled={hasPassword === null}
                onClick={() => setShowPasswordEditor(true)}
                size="sm"
                type="button"
                variant="outline"
              >
                {hasPassword ? "Change Password" : "Add Password"}
              </Button>
            )}
          </div>
          {/* Password Forms (gated) */}
          {showPasswordEditor && (
          <div className="space-y-3 rounded-md border border-border/60 p-4">
            {hasPassword === true && (
              <div className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="currentPassword">Current Password</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        id="currentPassword"
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        placeholder="Enter current password"
                        type={showPasswords ? "text" : "password"}
                        value={currentPassword}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="newPassword">New Password</Label>
                    <Input
                      id="newPassword"
                      maxLength={MAX_PASSWORD_LENGTH}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="New password"
                      type={showPasswords ? "text" : "password"}
                      value={newPassword}
                    />
                    {passwordTooShort && <p className="text-destructive text-xs">Minimum {MIN_PASSWORD_LENGTH} characters</p>}
                    {passwordTooLong && <p className="text-destructive text-xs">Maximum {MAX_PASSWORD_LENGTH} characters</p>}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="confirmPassword">Confirm Password</Label>
                    <Input
                      id="confirmPassword"
                      maxLength={MAX_PASSWORD_LENGTH}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Confirm new password"
                      type={showPasswords ? "text" : "password"}
                      value={confirmPassword}
                    />
                    {confirmMismatch && !passwordTooShort && !passwordTooLong && (
                      <p className="text-destructive text-xs">Passwords do not match</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    className="mr-auto"
                    onClick={() => setShowPasswords((p) => !p)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {showPasswords ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                  <Button
                    onClick={() => {
                      setShowPasswordEditor(false);
                      resetPasswordFields();
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Close
                  </Button>
                  <Button
                    disabled={
                      isChangingPassword ||
                      !currentPassword ||
                      !newPassword ||
                      passwordTooShort ||
                      passwordTooLong ||
                      newPassword !== confirmPassword
                    }
                    onClick={() => void handleChangePassword()}
                    size="sm"
                    type="button"
                  >
                    {isChangingPassword ? <Loader2 className="h-4 w-4 animate-spin" /> : "Change Password"}
                  </Button>
                </div>
              </div>
            )}
            {hasPassword === false && (
              <div className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="newPassword">Set Password</Label>
                    <Input
                      id="newPassword"
                      maxLength={MAX_PASSWORD_LENGTH}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="Enter new password"
                      type={showPasswords ? "text" : "password"}
                      value={newPassword}
                    />
                    {passwordTooShort && <p className="text-destructive text-xs">Minimum {MIN_PASSWORD_LENGTH} characters</p>}
                    {passwordTooLong && <p className="text-destructive text-xs">Maximum {MAX_PASSWORD_LENGTH} characters</p>}
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="confirmPassword">Confirm Password</Label>
                    <Input
                      id="confirmPassword"
                      maxLength={MAX_PASSWORD_LENGTH}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Confirm password"
                      type={showPasswords ? "text" : "password"}
                      value={confirmPassword}
                    />
                    {confirmMismatch && !passwordTooShort && !passwordTooLong && (
                      <p className="text-destructive text-xs">Passwords do not match</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    className="mr-auto"
                    onClick={() => setShowPasswords((p) => !p)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {showPasswords ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                  <Button
                    onClick={() => {
                      setShowPasswordEditor(false);
                      resetPasswordFields();
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Close
                  </Button>
                  <Button
                    disabled={
                      isChangingPassword ||
                      !newPassword ||
                      passwordTooShort ||
                      passwordTooLong ||
                      newPassword !== confirmPassword
                    }
                    onClick={() => void handleSetPassword()}
                    size="sm"
                    type="button"
                  >
                    {isChangingPassword ? <Loader2 className="h-4 w-4 animate-spin" /> : "Set Password"}
                  </Button>
                </div>
              </div>
            )}
            {/* Close now integrated with action row above */}
          </div>
          )}
          <Separator />
          {/* Two-Factor Authentication: if not enabled, route to dedicated flow; if enabled, show manager */}
          <>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <p className="font-medium">Two-Factor Authentication</p>
                  <p className="text-muted-foreground text-sm">
                    {user?.twoFactorEnabled ? "Enabled on this account" : "Add an extra layer of security"}
                  </p>
                </div>
                {user?.twoFactorEnabled ? (
                  <div className="flex items-center gap-2">
                    <Button
                      onClick={() => setTwoFactorOpen((p) => !p)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {twoFactorOpen ? "Close" : "Manage"}
                    </Button>
                  </div>
                ) : (
                  <Button
                    onClick={() => navigate({ to: "/auth/two-factor-auth" })}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Configure
                  </Button>
                )}
              </div>
            </div>
            {user?.twoFactorEnabled && twoFactorOpen && (
              <div className="mt-2 space-y-4 rounded-md border border-border/60 p-4">
                <div className="space-y-2">
                  <Label htmlFor="twoFactorPassword">Account Password</Label>
                  <Input
                    id="twoFactorPassword"
                    onChange={(e) => setTwoFactorPassword(e.target.value)}
                    placeholder="Enter your password"
                    type="password"
                    value={twoFactorPassword}
                  />
                </div>
                {Array.isArray(twoFactorCodes) && twoFactorCodes.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Backup Codes</p>
                    <p className="text-muted-foreground text-xs">Store these safely. Each can be used once.</p>
                    <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                      {twoFactorCodes.map((code) => (
                        <code className="rounded bg-muted px-2 py-1 text-center text-xs font-mono" key={code}>
                          {code}
                        </code>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        onClick={() => {
                          void navigator.clipboard.writeText(twoFactorCodes.join("\n"));
                          toast.success("Backup codes copied");
                        }}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Copy Codes
                      </Button>
                      <Button
                        onClick={() => {
                          const file = new Blob([twoFactorCodes.join("\n")], { type: "text/plain;charset=utf-8" });
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
                        variant="ghost"
                      >
                        Download
                      </Button>
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={regenerating2FA || !twoFactorPassword}
                    onClick={() => void handleRegenerateCodes()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {regenerating2FA ? <Loader2 className="h-4 w-4 animate-spin" /> : "Regenerate Codes"}
                  </Button>
                  <Button
                    disabled={disabling2FA || !twoFactorPassword}
                    onClick={() => void handleDisable2FA()}
                    size="sm"
                    type="button"
                    variant="destructive"
                  >
                    {disabling2FA ? <Loader2 className="h-4 w-4 animate-spin" /> : "Disable 2FA"}
                  </Button>
                </div>
              </div>
            )}
          <Separator />
          </>
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <p className="font-medium">Active Sessions</p>
              <p className="text-muted-foreground text-sm">Manage your active sessions</p>
            </div>
            <Button variant="outline">View Sessions</Button>
          </div>
        </CardContent>
      </Card>

      {/* Danger Zone */}
      <Card className="bg-card/50 border-border/50 border-destructive/20 w-full backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="text-destructive flex items-center gap-2">
            <Trash2 className="h-5 w-5" />
            Danger Zone
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <p className="font-medium">Delete Account</p>
              <p className="text-muted-foreground text-sm">Permanently delete your account and all data</p>
            </div>
            <Button size="sm" variant="destructive">
              Delete Account
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Save Button */}
      <div className="flex justify-end gap-3">
        <Button
          disabled={
            isSaving ||
            !user ||
            (name.trim() === (user?.name ?? "") && (timezone === "" || timezone === (preferences?.timezone ?? "")))
          }
          onClick={() => void handleSave()}
        >
          {isSaving ? "Saving..." : "Save Changes"}
        </Button>
      </div>
      </div>
    </ProtectedRoute>
  );
}
