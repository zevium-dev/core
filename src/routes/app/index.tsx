import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/app/")({
  component: RouteComponent,
  loader: async ({ context }) => {
    const organizations = await context.queryClient.ensureQueryData(context.trpc.organization.list.queryOptions());

    if (organizations.length === 0) {
      throw redirect({ to: "/app/organizations/create" });
    }

    if (organizations.length > 1) {
      throw redirect({ to: "/app/organizations/~" });
    }

    const organization = organizations.at(0);

    if (!organization) {
      throw redirect({ to: "/app/organizations/~" });
    }

    const projects = await context.queryClient.ensureQueryData(
      context.trpc.project.list.queryOptions({ organizationSlug: organization.slug }),
    );

    if (projects.length === 0) {
      throw redirect({
        params: { organizationSlug: organization.slug },
        to: "/app/organizations/$organizationSlug/projects/~",
      });
    }

    const firstProject = projects.at(0);

    if (!firstProject) {
      throw redirect({
        params: { organizationSlug: organization.slug },
        to: "/app/organizations/$organizationSlug/projects/~",
      });
    }

    throw redirect({
      params: { organizationSlug: organization.slug, projectSlug: firstProject.slug },
      to: "/app/organizations/$organizationSlug/projects/$projectSlug",
    });
  },
});

function RouteComponent() {
  return null;
}
