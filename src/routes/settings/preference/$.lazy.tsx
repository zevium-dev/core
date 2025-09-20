import { createLazyFileRoute } from "@tanstack/react-router";
import { Calendar, Camera, Mail, MapPin, Phone, Shield, Trash2, User, Copy } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import { auth } from "~/lib/auth";
import { toast } from "sonner";

export const Route = createLazyFileRoute("/settings/preference/$")({
  component: AccountPreferenceComponent,
});

export function AccountPreferenceComponent() {
  const { data: session, isPending } = auth.useSession();
  const user = session?.user;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  // Placeholder local-only fields (not yet persisted): phone, location, timezone
  const [phone, setPhone] = useState("");
  const [location, setLocation] = useState("");
  const [timezone, setTimezone] = useState("PST");
  const [isSaving, setIsSaving] = useState(false);

  // Initialize from session
  useEffect(() => {
    if (user) {
      setName(user.name ?? "");
      setEmail(user.email ?? "");
    }
  }, [user]);

  const handleSave = useCallback(async () => {
    if (!user) return;
    setIsSaving(true);
    try {
      // Only updating name for now (email change & other fields not yet supported)
      const { error } = await auth.updateUser({ name: name.trim() });
      if (error) throw new Error(error.message);
      toast.success("Profile updated");
    } catch (e) {
      toast.error((e as Error).message || "Update failed");
    } finally {
      setIsSaving(false);
    }
  }, [name, user]);

  return (
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
                  src={user?.image || "/placeholder-avatar.jpg"}
                  onError={(e) => {
                    // Replace broken image with fallback
                    const target = e.currentTarget as HTMLImageElement;
                    target.style.display = "none"; // let fallback show
                  }}
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
              <Button disabled size="sm" variant="outline" title="Avatar upload coming soon">
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
                    size="icon"
                    type="button"
                    variant="ghost"
                    className="shrink-0"
                    aria-label="Copy email"
                    onClick={() => {
                      void navigator.clipboard.writeText(email);
                      toast.success("Email copied");
                    }}
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
            <Select onValueChange={setTimezone} value={timezone}>
              <SelectTrigger>
                <SelectValue placeholder="Select timezone" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PST">Pacific Standard Time (PST)</SelectItem>
                <SelectItem value="MST">Mountain Standard Time (MST)</SelectItem>
                <SelectItem value="CST">Central Standard Time (CST)</SelectItem>
                <SelectItem value="EST">Eastern Standard Time (EST)</SelectItem>
                <SelectItem value="UTC">Coordinated Universal Time (UTC)</SelectItem>
              </SelectContent>
            </Select>
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
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <p className="font-medium">Password</p>
              <p className="text-muted-foreground text-sm">Last changed 3 months ago</p>
            </div>
            <Button variant="outline">Change Password</Button>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <p className="font-medium">Two-Factor Authentication</p>
              <p className="text-muted-foreground text-sm">Add an extra layer of security</p>
            </div>
            <Button variant="outline">Configure</Button>
          </div>
          <Separator />
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
          disabled={isSaving || !user || name.trim() === (user?.name ?? "")}
          onClick={() => void handleSave()}
        >
          {isSaving ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
