import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import type { Doc } from "#/lib/convex-data-model";
import { isPrivilegedOrgRole } from "#/lib/org-capabilities";
import { useOrganization } from "@clerk/tanstack-react-start";
import { UpstreamCredentialsCard } from "./project/credentials-card";
import { DangerZone } from "./project/danger-zone";
import { DetailsCard } from "./project/details-card";
import { VisibilityCard } from "./project/visibility-card";
import { WebhooksCard } from "./project/webhooks-card";

export function ProjectSettingsPanel({
  project,
  canAdminister,
}: {
  project: Doc<"projects">;
  orgSlug: string;
  canAdminister: boolean;
}) {
  const { membership } = useOrganization();
  if (!canAdminister || !isPrivilegedOrgRole(membership?.role))
    return (
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Admin access required
          </CardTitle>
          <CardDescription>
            Organization admins manage project metadata, visibility, upstream
            credentials, webhooks, and deletion. Ask an admin to make changes.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  return (
    <div key={project._id} className="flex flex-col gap-4">
      <DetailsCard project={project} />
      <VisibilityCard project={project} />
      <UpstreamCredentialsCard project={project} />
      <WebhooksCard project={project} />
      <DangerZone project={project} />
    </div>
  );
}
