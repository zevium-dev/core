import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import z from "zod";

import { ImageUpload } from "~/components/image-upload";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "~/components/ui/form";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { type AssignableOrganizationRole, AssignableOrganizationRoles } from "~/db/default-roles";
import { useUser } from "~/lib/auth";
import { useTRPC } from "~/lib/trpc";

export const Route = createFileRoute("/app/organizations/$organizationSlug/settings")({
  component: RouteComponent,
  loader: ({ context, params }) => {
    void context.queryClient.ensureQueryData(
      context.trpc.organization.get.queryOptions({ organizationSlug: params.organizationSlug }),
    );
  },
});

const FormZod = z.object({
  logo: z.string().nullable().optional(),
  name: z.string().min(1, "Organization name is required").max(100, "Name must be less than 100 characters"),
  slug: z
    .string()
    .min(1, "Slug is required")
    .max(50, "Slug must be less than 50 characters")
    .regex(/^[a-z0-9-]+$/, "Slug can only contain lowercase letters, numbers, and hyphens"),
});

const InviteFormZod = z.object({
  email: z.string().email("Invalid email"),
  role: z.enum(AssignableOrganizationRoles),
});

type FormValues = z.infer<typeof FormZod>;
type InviteFormValues = z.infer<typeof InviteFormZod>;

const memberRoleOptions = AssignableOrganizationRoles.map((role) => ({
  label: role.charAt(0).toUpperCase() + role.slice(1),
  value: role,
}));

function RouteComponent() {
  const { organizationSlug } = Route.useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const currentUser = useUser();
  const orgQuery = useSuspenseQuery(trpc.organization.get.queryOptions({ organizationSlug }));
  const org = orgQuery.data;
  const ownerCount = org.members.filter((member) => member.role === "owner").length;
  const isSingleMember = org.members.length === 1;

  const [logoData, setLogoData] = useState<null | string>(org.logo ?? null);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [roleChangingId, setRoleChangingId] = useState<null | string>(null);
  const [removingId, setRemovingId] = useState<null | string>(null);
  const [cancelingInvitationId, setCancelingInvitationId] = useState<null | string>(null);

  const inviteForm = useForm<InviteFormValues>({
    defaultValues: { email: "", role: "member" },
    mode: "onBlur",
    resolver: zodResolver(InviteFormZod),
  });

  const form = useForm<FormValues>({
    defaultValues: {
      logo: org.logo ?? null,
      name: org.name,
      slug: org.slug,
    },
    mode: "onBlur",
    resolver: zodResolver(FormZod),
  });

  const updateOrgMutation = useMutation(
    trpc.organization.update.mutationOptions({
      onSuccess: async (updatedOrg) => {
        const newSlug = updatedOrg.slug;
        toast.success("Organization updated successfully");
        await Promise.all([
          queryClient.invalidateQueries(trpc.organization.list.queryOptions()),
          queryClient.invalidateQueries(trpc.organization.get.queryOptions({ organizationSlug })),
          newSlug !== organizationSlug
            ? queryClient.invalidateQueries(trpc.organization.get.queryOptions({ organizationSlug: newSlug }))
            : Promise.resolve(),
        ]);

        if (newSlug && newSlug !== organizationSlug) {
          await navigate({
            params: { organizationSlug: newSlug },
            to: "/app/organizations/$organizationSlug/settings",
          });
        }
      },
    }),
  );

  const inviteMemberMutation = useMutation(
    trpc.organization.inviteMember.mutationOptions({
      onSuccess: async () => {
        toast.success("Invitation sent");
        inviteForm.reset({ email: "", role: "member" });
        await queryClient.invalidateQueries(trpc.organization.get.queryOptions({ organizationSlug }));
      },
    }),
  );

  const updateMemberRoleMutation = useMutation(
    trpc.organization.updateMemberRole.mutationOptions({
      onMutate: ({ memberId }) => setRoleChangingId(memberId),
      onSettled: async () => {
        setRoleChangingId(null);
        await queryClient.invalidateQueries(trpc.organization.get.queryOptions({ organizationSlug }));
      },
    }),
  );

  const removeMemberMutation = useMutation(
    trpc.organization.removeMember.mutationOptions({
      onMutate: ({ memberId }) => setRemovingId(memberId),
      onSettled: async () => {
        setRemovingId(null);
        await queryClient.invalidateQueries(trpc.organization.get.queryOptions({ organizationSlug }));
      },
    }),
  );

  const cancelInvitationMutation = useMutation(
    trpc.organization.cancelInvitation.mutationOptions({
      onMutate: ({ invitationId }) => setCancelingInvitationId(invitationId),
      onSettled: async () => {
        setCancelingInvitationId(null);
        await queryClient.invalidateQueries(trpc.organization.get.queryOptions({ organizationSlug }));
      },
    }),
  );

  const deleteOrgMutation = useMutation(
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    trpc.organization.delete.mutationOptions({
      onSuccess: async () => {
        toast.success("Organization deleted");
        await queryClient.invalidateQueries(trpc.organization.list.queryOptions());
        await navigate({ to: "/app/organizations/~" });
      },
    }),
  );

  const slugFromName = (value: string) =>
    value
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

  const onSubmit = (data: FormValues) => {
    updateOrgMutation.mutate({
      logo: data.logo ?? null,
      name: data.name,
      organizationId: org.id,
      slug: data.slug,
    });
  };

  const handleLogoChange = (base64: string) => {
    setLogoData(base64);
    form.setValue("logo", base64, { shouldDirty: true });
  };

  const handleNameChange = (name: string) => {
    if (!slugManuallyEdited) {
      form.setValue("slug", slugFromName(name), { shouldDirty: true });
    }
  };

  const handleSlugChange = (slug: string) => {
    setSlugManuallyEdited(true);
    form.setValue("slug", slugFromName(slug), { shouldDirty: true });
  };

  return (
    <div className="mx-auto flex flex-col gap-4 p-4 sm:gap-6 sm:p-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Organization settings</CardTitle>
          <CardDescription>Update your organization details, including the slug used in URLs.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form className="space-y-6" onSubmit={form.handleSubmit(onSubmit)}>
              <FormField
                control={form.control}
                name="logo"
                render={() => (
                  <FormItem>
                    <FormLabel>Logo</FormLabel>
                    <FormControl>
                      <div className="w-32">
                        <ImageUpload
                          aspectRatio={1}
                          disabled={updateOrgMutation.isPending}
                          maxSizeKb={10_000}
                          onChangeValue={handleLogoChange}
                          placeholder="Upload organization logo"
                          previewUrl={logoData ?? undefined}
                        />
                      </div>
                    </FormControl>
                    <FormDescription>Upload a logo for your organization (1:1 aspect ratio, max 10MB)</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel htmlFor="name">Organization name</FormLabel>
                    <FormControl>
                      <Input
                        disabled={updateOrgMutation.isPending}
                        id="name"
                        placeholder="My awesome organization"
                        {...field}
                        onChange={(e) => {
                          field.onChange(e);
                          handleNameChange(e.target.value);
                        }}
                      />
                    </FormControl>
                    <FormDescription>The name of your organization (1-100 characters)</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="slug"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel htmlFor="slug">Slug</FormLabel>
                    <FormControl>
                      <Input
                        disabled={updateOrgMutation.isPending}
                        id="slug"
                        placeholder="my-organization"
                        {...field}
                        onChange={(e) => handleSlugChange(e.target.value)}
                      />
                    </FormControl>
                    <FormDescription>
                      URL-friendly identifier (lowercase, hyphens only, 1-50 characters). Changing this updates the URL
                      used to access the organization.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex items-center justify-end gap-2">
                <Button
                  disabled={updateOrgMutation.isPending}
                  loading={updateOrgMutation.isPending}
                  type="submit"
                  variant="default"
                >
                  Save changes
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Invite member</CardTitle>
            <CardDescription>Send an invitation to join this organization.</CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...inviteForm}>
              <form
                className="space-y-4"
                onSubmit={inviteForm.handleSubmit((data) => {
                  inviteMemberMutation.mutate({
                    email: data.email,
                    organizationId: org.id,
                    role: data.role,
                  });
                })}
              >
                <FormField
                  control={inviteForm.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input
                          disabled={inviteMemberMutation.isPending}
                          placeholder="member@example.com"
                          type="email"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={inviteForm.control}
                  name="role"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Role</FormLabel>
                      <FormControl>
                        <Select
                          disabled={inviteMemberMutation.isPending}
                          onValueChange={field.onChange}
                          value={field.value}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select role" />
                          </SelectTrigger>
                          <SelectContent>
                            {memberRoleOptions.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value}>
                                {opt.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormControl>
                      <FormDescription>Choose the default role for this invite.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Button
                  disabled={inviteMemberMutation.isPending}
                  loading={inviteMemberMutation.isPending}
                  type="submit"
                >
                  Send invite
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pending invitations</CardTitle>
            <CardDescription>Track invites awaiting acceptance.</CardDescription>
          </CardHeader>
          <CardContent>
            {org.invitations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No pending invitations.</p>
            ) : (
              <div className="space-y-3">
                {org.invitations.map((invitation) => {
                  const isCanceling = cancelingInvitationId === invitation.id && cancelInvitationMutation.isPending;
                  return (
                    <div className="flex items-center justify-between rounded-md border p-3" key={invitation.id}>
                      <div className="flex-1">
                        <p className="text-sm font-medium">{invitation.email}</p>
                        <p className="text-xs text-muted-foreground">
                          Role: <span className="capitalize">{invitation.role}</span> • Expires:{" "}
                          {new Date(invitation.expiresAt).toUTCString()}
                        </p>
                      </div>
                      <Button
                        disabled={isCanceling}
                        loading={isCanceling}
                        onClick={() => {
                          cancelInvitationMutation.mutate({
                            invitationId: invitation.id,
                            organizationId: org.id,
                          });
                        }}
                        size="sm"
                        variant="outline"
                      >
                        Cancel
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>View, change roles, or remove members.</CardDescription>
        </CardHeader>
        <CardContent>
          {org.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members found.</p>
          ) : (
            <div className="space-y-3">
              {org.members.map((member) => {
                const isUpdatingRole = roleChangingId === member.id && updateMemberRoleMutation.isPending;
                const isRemoving = removingId === member.id && removeMemberMutation.isPending;
                const isOnlyOwner = member.role === "owner" && ownerCount === 1;
                const isOnlyMember = isSingleMember;
                const isCurrentUser = member.userId === currentUser.id;
                const disableRoleChange = isUpdatingRole || isRemoving || isOnlyOwner || isOnlyMember || isCurrentUser;
                const disableRemoval = isRemoving || isOnlyOwner || isOnlyMember || isCurrentUser;
                return (
                  <div className="flex items-center justify-between rounded-md border p-3" key={member.id}>
                    <div>
                      <p className="text-sm font-medium">{member.user.name}</p>
                      <p className="text-xs text-muted-foreground">{member.user.email}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <Select
                        disabled={disableRoleChange}
                        onValueChange={(role) => {
                          updateMemberRoleMutation.mutate({
                            memberId: member.id,
                            organizationId: org.id,
                            role: role as AssignableOrganizationRole,
                          });
                        }}
                        value={member.role}
                      >
                        <SelectTrigger className="w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {memberRoleOptions.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        disabled={disableRemoval}
                        loading={isRemoving}
                        onClick={() => {
                          removeMemberMutation.mutate({
                            memberId: member.id,
                            organizationId: org.id,
                          });
                        }}
                        variant="destructive"
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
          <CardDescription>Permanently delete this organization and all associated data.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              This action cannot be undone. All projects and members will lose access.
            </p>
            <Button
              disabled={deleteOrgMutation.isPending}
              loading={deleteOrgMutation.isPending}
              onClick={() => {
                const confirmed = window.confirm("Are you sure you want to delete this organization?");
                if (!confirmed) return;
                deleteOrgMutation.mutate({ organizationId: org.id });
              }}
              variant="destructive"
            >
              Delete organization
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
