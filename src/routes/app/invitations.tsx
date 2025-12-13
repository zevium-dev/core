import type { inferRouterOutputs } from "@trpc/server";

import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";

import type { AppRouter } from "~/server";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { useTRPC } from "~/lib/trpc";

type Invitation = inferRouterOutputs<AppRouter>["organization"]["userInvitations"][number];

interface InvitationRowProps {
  invitation: Invitation;
  isPending: boolean;
  onClick: () => void;
}

function InvitationRow({ invitation, isPending, onClick }: InvitationRowProps) {
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex-1">
        <p className="text-sm font-medium">{invitation.organization.name}</p>
        <p className="text-xs text-muted-foreground">{invitation.organization.slug}</p>
        <p className="text-xs text-muted-foreground">
          Role: <span className="font-medium capitalize">{invitation.role}</span>
        </p>
        <p className="text-xs text-muted-foreground">Expires: {new Date(invitation.expiresAt).toUTCString()}</p>
      </div>
      <div className="flex gap-2">
        <Button disabled={isPending} loading={isPending} onClick={onClick} size="sm" variant="default">
          Accept
        </Button>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/app/invitations")({
  component: RouteComponent,
  loader: ({ context }) => {
    void context.queryClient.ensureQueryData(context.trpc.organization.userInvitations.queryOptions());
  },
});

function RouteComponent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const invitationsQuery = useSuspenseQuery(trpc.organization.userInvitations.queryOptions());
  const invitations = invitationsQuery.data;

  const acceptMutation = useMutation(
    trpc.organization.acceptInvitation.mutationOptions({
      onSuccess: async () => {
        toast.success("Invitation accepted!");
        await Promise.all([
          queryClient.invalidateQueries(trpc.organization.userInvitations.queryOptions()),
          queryClient.invalidateQueries(trpc.organization.list.queryOptions()),
        ]);
      },
    }),
  );

  if (invitations.length === 0) {
    return (
      <div className="mx-auto flex max-w-2xl min-w-sm flex-col gap-4 p-4 sm:gap-6 sm:p-6">
        <Card>
          <CardHeader>
            <CardTitle>Invitations</CardTitle>
            <CardDescription>You have no pending invitations.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl min-w-sm flex-col gap-4 p-4 sm:gap-6 sm:p-6">
      <Card>
        <CardHeader>
          <CardTitle>Pending Invitations</CardTitle>
          <CardDescription>You have {invitations.length} pending invitation(s).</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {invitations.map((invitation) => (
              <InvitationRow
                invitation={invitation}
                isPending={acceptMutation.isPending}
                key={invitation.id}
                onClick={() => {
                  acceptMutation.mutate({ invitationId: invitation.id });
                }}
              />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
