import { createLazyFileRoute } from "@tanstack/react-router";
import { Calendar, Camera, Mail, MapPin, Phone, Shield, Trash2, User } from "lucide-react";
import { useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";

export const Route = createLazyFileRoute("/settings/preference/$")({
  component: AccountPreferenceComponent,
});

export function AccountPreferenceComponent() {
  const [firstName, setFirstName] = useState("John");
  const [lastName, setLastName] = useState("Doe");
  const [email, setEmail] = useState("john.doe@example.com");
  const [phone, setPhone] = useState("+1 (555) 123-4567");
  const [location, setLocation] = useState("San Francisco, CA");
  const [timezone, setTimezone] = useState("PST");

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
                <AvatarImage alt="Profile" src="/placeholder-avatar.jpg" />
                <AvatarFallback className="text-lg">JD</AvatarFallback>
              </Avatar>
              <Button
                className="border-background absolute -right-1 -bottom-1 h-8 w-8 rounded-full border-2"
                size="icon"
                variant="outline"
              >
                <Camera className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-1">
              <h3 className="text-lg font-medium">
                {firstName} {lastName}
              </h3>
              <p className="text-muted-foreground text-sm">{email}</p>
              <Button size="sm" variant="outline">
                Change Photo
              </Button>
            </div>
          </div>

          <Separator />

          {/* Personal Information */}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="firstName">First Name</Label>
              <Input
                id="firstName"
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="Enter first name"
                value={firstName}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lastName">Last Name</Label>
              <Input
                id="lastName"
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Enter last name"
                value={lastName}
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
            <Input
              id="email"
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter email address"
              type="email"
              value={email}
            />
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
        <Button variant="outline">Cancel</Button>
        <Button>Save Changes</Button>
      </div>
    </div>
  );
}
