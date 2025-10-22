import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Mail, Users } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Typography } from "~/components/ui/typography";
import { useTRPC } from "~/lib/trpc";
import { formatDate } from "~/lib/utils";

export const Route = createFileRoute("/app/organizations/$organizationSlug/")({
  component: RouteComponent,
  loader: ({ context, params }) => {
    void context.queryClient.ensureQueryData(context.trpc.organization.get.queryOptions(params));
  },
});

function RouteComponent() {
  const { organizationSlug } = Route.useParams();
  const trpc = useTRPC();
  const orgDetailsQuery = useSuspenseQuery(trpc.organization.get.queryOptions({ organizationSlug }));
  const org = orgDetailsQuery.data;

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n.at(0) ?? "")
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <>
      <div className="space-y-6 p-6">
        {/* Organization Header Card */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <CardTitle className="text-2xl">{org.name}</CardTitle>
                <CardDescription className="mt-2 text-base">
                  <span className="bg-muted rounded px-2 py-1 font-mono text-xs">{org.slug}</span>
                </CardDescription>
              </div>
              {org.logo && (
                <div className="ml-4">
                  <img alt={org.name} className="h-16 w-16 rounded-lg object-cover" src={org.logo} />
                </div>
              )}
            </div>
            <div className="mt-4 flex flex-wrap gap-6 border-t pt-4">
              <div className="flex gap-2">
                <Typography className="text-muted-foreground font-medium" variant="small">
                  Created:
                </Typography>
                <Typography variant="small">{formatDate(org.createdAt)}</Typography>
              </div>
              <div className="flex gap-2">
                <Typography className="text-muted-foreground font-medium" variant="small">
                  Organization ID:
                </Typography>
                <Typography className="font-mono text-xs" variant="small">
                  {org.id}
                </Typography>
              </div>
            </div>
          </CardHeader>
        </Card>

        {/* Members Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Members ({org.members.length})
            </CardTitle>
            <CardDescription>Team members and their roles</CardDescription>
          </CardHeader>
          <CardContent>
            {org.members.length > 0 ? (
              <div className="space-y-4">
                {org.members.map((member) => (
                  <div className="flex items-center justify-between rounded-lg border p-3" key={member.id}>
                    <div className="flex flex-1 items-center gap-3">
                      <Avatar className="h-10 w-10">
                        {member.user.image && <AvatarImage src={member.user.image} />}
                        <AvatarFallback>{getInitials(member.user.name)}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <Typography className="font-medium" variant="small">
                          {member.user.name}
                        </Typography>
                        <Typography className="text-muted-foreground flex items-center gap-1 truncate" variant="small">
                          <Mail className="h-3 w-3" />
                          {member.user.email}
                        </Typography>
                      </div>
                    </div>
                    <Badge className="capitalize" variant="secondary">
                      {member.role}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <Typography className="text-muted-foreground py-4 text-center" variant="small">
                No members yet
              </Typography>
            )}
          </CardContent>
        </Card>

        {/* Invitations Section */}
        {org.invitations.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Mail className="h-5 w-5" />
                Pending Invitations ({org.invitations.length})
              </CardTitle>
              <CardDescription>Invites awaiting acceptance</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {org.invitations.map((invitation) => (
                  <div className="flex items-center justify-between rounded-lg border p-3" key={invitation.id}>
                    <div className="flex-1">
                      <Typography className="font-medium" variant="small">
                        {invitation.email}
                      </Typography>
                      <Typography className="text-muted-foreground text-xs" variant="small">
                        Expires: {formatDate(invitation.expiresAt)}
                      </Typography>
                    </div>
                    <Badge className="capitalize" variant="outline">
                      {invitation.status}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
