import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  Activity,
  Building2,
  Calendar,
  CreditCard,
  Crown,
  Globe,
  Mail,
  MoreHorizontal,
  Plus,
  Settings,
  Shield,
  Users,
  Zap,
} from "lucide-react";
import { m } from "motion/react";
import * as React from "react";

import { AuthLoadingFallback } from "~/components/auth-loading-fallback";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Separator } from "~/components/ui/separator";
import { Skeleton } from "~/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { useTRPCClient } from "~/lib/trpc";

export const Route = createFileRoute("/app/organizations/$slug")({
  component: RouteComponent,
});

interface OrganizationData {
  createdAt: Date;
  description: null | string;
  id: string;
  logo: null | string;
  memberCount: number;
  name: string;
  ownerId: string;
  projectCount: number;
  settings: Record<string, unknown>;
  slug: string;
  updatedAt: Date;
  userMembership: {
    id: string;
    joinedAt: Date;
    permissions: Record<string, unknown>;
    role: "admin" | "member" | "owner";
  };
  website: null | string;
}

function ActivityLog() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Activity</CardTitle>
        <CardDescription>Latest activities in your organization</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {Array.from({ length: 5 }).map(() => (
            <div className="flex items-start space-x-3" key={crypto.randomUUID()}>
              <div className="bg-muted flex h-8 w-8 items-center justify-center rounded-full">
                <Activity className="h-4 w-4" />
              </div>
              <div className="flex-1 space-y-1">
                <p className="text-sm">Sample activity - This is a placeholder for actual activity data</p>
                <p className="text-muted-foreground text-xs">2 hours ago</p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function BillingSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Billing & Subscription</CardTitle>
        <CardDescription>Manage your organization's subscription and billing information</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="flex items-center space-x-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/50">
              <Zap className="h-5 w-5 text-green-600 dark:text-green-400" />
            </div>
            <div>
              <h4 className="font-medium">Free Plan</h4>
              <p className="text-muted-foreground text-sm">Up to 5 team members</p>
            </div>
          </div>
          <Badge variant="secondary">Current Plan</Badge>
        </div>

        <div className="space-y-4">
          <Button className="w-full" variant="outline">
            <CreditCard className="mr-2 h-4 w-4" />
            Upgrade to Pro
          </Button>
          <Button className="w-full" variant="ghost">
            View Billing History
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function IntegrationSettings() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Integrations</CardTitle>
        <CardDescription>Connect your organization with external services</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="flex items-center space-x-3">
              <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-full">
                <Mail className="h-5 w-5" />
              </div>
              <div>
                <h4 className="font-medium">Email Notifications</h4>
                <p className="text-muted-foreground text-sm">Send updates via email</p>
              </div>
            </div>
            <Button size="sm" variant="outline">
              Configure
            </Button>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="flex items-center space-x-3">
              <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-full">
                <Zap className="h-5 w-5" />
              </div>
              <div>
                <h4 className="font-medium">Slack Integration</h4>
                <p className="text-muted-foreground text-sm">Connect with your Slack workspace</p>
              </div>
            </div>
            <Button size="sm" variant="outline">
              Connect
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return <label className={className}>{children}</label>;
}

function LoadingSkeleton() {
  return (
    <div className="container mx-auto space-y-8 px-8 py-8">
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>

      <Skeleton className="h-96" />
    </div>
  );
}

function OrganizationOverview({ organization }: { organization: OrganizationData }) {
  return (
    <div className="grid gap-6 md:grid-cols-3">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Total Members</CardTitle>
          <Users className="text-muted-foreground h-4 w-4" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{organization.memberCount}</div>
          <p className="text-muted-foreground text-xs">Active team members</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Active Projects</CardTitle>
          <Building2 className="text-muted-foreground h-4 w-4" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{organization.projectCount}</div>
          <p className="text-muted-foreground text-xs">Projects in development</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Organization Age</CardTitle>
          <Calendar className="text-muted-foreground h-4 w-4" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {Math.ceil((Date.now() - organization.createdAt.getTime()) / (1000 * 60 * 60 * 24))}d
          </div>
          <p className="text-muted-foreground text-xs">Since creation</p>
        </CardContent>
      </Card>
    </div>
  );
}

function OrganizationProfile({ organization }: { organization: OrganizationData }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Organization Profile</CardTitle>
        <CardDescription>Basic information about your organization</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center space-x-4">
          <div className="bg-primary/10 flex h-16 w-16 items-center justify-center rounded-full">
            <Building2 className="text-primary h-8 w-8" />
          </div>
          <div className="space-y-1">
            <h3 className="text-xl font-semibold">{organization.name}</h3>
            <p className="text-muted-foreground">/{organization.slug}</p>
          </div>
        </div>

        <Separator />

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label className="text-sm font-medium">Description</Label>
            <p className="text-muted-foreground text-sm">{organization.description ?? "No description provided"}</p>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">Website</Label>
            <p className="text-muted-foreground text-sm">
              {organization.website ? (
                <a className="hover:underline" href={organization.website} rel="noopener noreferrer" target="_blank">
                  {organization.website}
                </a>
              ) : (
                "No website provided"
              )}
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">Created</Label>
            <p className="text-muted-foreground text-sm">{new Date(organization.createdAt).toLocaleDateString()}</p>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">Last Updated</Label>
            <p className="text-muted-foreground text-sm">{new Date(organization.updatedAt).toLocaleDateString()}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ProjectsList({ organizationId }: { organizationId: string }) {
  const trpcClient = useTRPCClient();

  const { data: projectsData, isLoading: projectsLoading } = useQuery({
    queryFn: () => trpcClient.organization.getProjects.query({ organizationId }),
    queryKey: ["organization-projects", organizationId],
  });

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case "active":
        return "default";
      case "archived":
        return "outline";
      case "beta":
        return "secondary";
      default:
        return "outline";
    }
  };

  const getVisibilityIcon = (visibility: string) => {
    switch (visibility) {
      case "internal":
        return <Building2 className="h-3 w-3" />;
      case "private":
        return <Shield className="h-3 w-3" />;
      case "public":
        return <Globe className="h-3 w-3" />;
      default:
        return <Building2 className="h-3 w-3" />;
    }
  };

  if (projectsLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Projects</CardTitle>
          <CardDescription>Organization projects and their current status</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {Array.from({ length: 3 }).map(() => (
              <div className="flex items-center justify-between rounded-lg border p-4" key={crypto.randomUUID()}>
                <div className="space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-48" />
                </div>
                <Skeleton className="h-6 w-16" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  const projects = projectsData?.projects ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Projects</CardTitle>
            <CardDescription>Organization projects and their current status</CardDescription>
          </div>
          <Button size="sm">
            <Plus className="mr-2 h-4 w-4" />
            New Project
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {projects.map((project) => (
            <div
              className="hover:bg-muted/50 flex items-center justify-between rounded-lg border p-4 transition-colors"
              key={project.id}
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h4 className="font-medium">{project.name}</h4>
                  {getVisibilityIcon(project.visibility)}
                </div>
                <p className="text-muted-foreground text-sm">{project.description ?? "No description available"}</p>
                <div className="text-muted-foreground flex items-center gap-2 text-xs">
                  <span>Created by {project.creatorName}</span>
                  <span>•</span>
                  <span>{new Date(project.updatedAt).toLocaleDateString()}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={getStatusBadgeVariant(project.status)}>
                  {project.status.charAt(0).toUpperCase() + project.status.slice(1)}
                </Badge>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="ghost">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem>View Project</DropdownMenuItem>
                    <DropdownMenuItem>Edit Settings</DropdownMenuItem>
                    <DropdownMenuItem className="text-destructive">Archive Project</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}
          {projects.length === 0 && (
            <div className="py-8 text-center">
              <Building2 className="text-muted-foreground mx-auto h-12 w-12" />
              <h3 className="mt-4 text-lg font-semibold">No projects yet</h3>
              <p className="text-muted-foreground">Get started by creating your first project.</p>
              <Button className="mt-4" size="sm">
                <Plus className="mr-2 h-4 w-4" />
                Create Project
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function RouteComponent() {
  const { slug } = Route.useParams();
  const trpcClient = useTRPCClient();

  const {
    data: organizationData,
    error,
    isLoading,
  } = useQuery({
    queryFn: () => trpcClient.organization.getBySlug.query({ slug }),
    queryKey: ["organization-by-slug", slug],
  });

  if (isLoading) {
    return <LoadingSkeleton />;
  }

  if (error) {
    return (
      <div className="container mx-auto px-8 py-8">
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <Building2 className="text-muted-foreground mx-auto h-12 w-12" />
            <h3 className="mt-4 text-lg font-semibold">Organization not found</h3>
            <p className="text-muted-foreground">
              {error instanceof Error
                ? error.message
                : "The organization you're looking for doesn't exist or you don't have access to it."}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!organizationData?.organization) {
    return (
      <div className="container mx-auto px-8 py-8">
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <Building2 className="text-muted-foreground mx-auto h-12 w-12" />
            <h3 className="mt-4 text-lg font-semibold">Organization not found</h3>
            <p className="text-muted-foreground">
              The organization you're looking for doesn't exist or you don't have access to it.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const organization = organizationData.organization;

  return (
    <div className="container mx-auto space-y-8 px-8 py-8">
      {/* Header */}
      <m.div animate={{ opacity: 1, y: 0 }} initial={{ opacity: 0, y: -20 }} transition={{ duration: 0.5 }}>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tight">{organization.name}</h1>
            <p className="text-muted-foreground">Manage your organization, team members, and projects</p>
          </div>

          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline">
              <Settings className="mr-2 h-4 w-4" />
              Settings
            </Button>
            <Button size="sm">
              <Plus className="mr-2 h-4 w-4" />
              Invite Members
            </Button>
          </div>
        </div>
      </m.div>

      {/* Overview Cards */}
      <m.div animate={{ opacity: 1 }} initial={{ opacity: 0 }} transition={{ delay: 0.1, duration: 0.5 }}>
        <OrganizationOverview organization={organization} />
      </m.div>

      {/* Main Content */}
      <m.div animate={{ opacity: 1 }} initial={{ opacity: 0 }} transition={{ delay: 0.2, duration: 0.5 }}>
        <Tabs className="space-y-6" defaultValue="team">
          <TabsList className="grid w-full grid-cols-6">
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="team">Team</TabsTrigger>
            <TabsTrigger value="projects">Projects</TabsTrigger>
            <TabsTrigger value="billing">Billing</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="integrations">Integrations</TabsTrigger>
          </TabsList>

          <TabsContent className="space-y-6" value="profile">
            <OrganizationProfile organization={organization} />
          </TabsContent>

          <TabsContent className="space-y-6" value="team">
            <TeamManagement organizationId={organization.id} />
          </TabsContent>

          <TabsContent className="space-y-6" value="projects">
            <ProjectsList organizationId={organization.id} />
          </TabsContent>

          <TabsContent className="space-y-6" value="billing">
            <BillingSection />
          </TabsContent>

          <TabsContent className="space-y-6" value="activity">
            <ActivityLog />
          </TabsContent>

          <TabsContent className="space-y-6" value="integrations">
            <IntegrationSettings />
          </TabsContent>
        </Tabs>
      </m.div>
    </div>
  );
}

function TeamManagement({ organizationId }: { organizationId: string }) {
  const trpcClient = useTRPCClient();

  const { data: membersData, isLoading: membersLoading } = useQuery({
    queryFn: () => trpcClient.organization.getMembers.query({ organizationId }),
    queryKey: ["organization-members", organizationId],
  });

  const getRoleBadgeVariant = (role: string) => {
    switch (role) {
      case "admin":
        return "secondary";
      case "owner":
        return "default";
      default:
        return "outline";
    }
  };

  const getRoleIcon = (role: string) => {
    switch (role) {
      case "admin":
        return <Shield className="h-3 w-3" />;
      case "owner":
        return <Crown className="h-3 w-3" />;
      default:
        return <Users className="h-3 w-3" />;
    }
  };

  if (membersLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Team Members</CardTitle>
          <CardDescription>Manage your organization members and their roles</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {Array.from({ length: 3 }).map(() => (
              <div className="flex items-center space-x-4" key={crypto.randomUUID()}>
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="ml-auto h-6 w-16" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  const members = membersData?.members ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Team Members</CardTitle>
            <CardDescription>Manage your organization members and their roles</CardDescription>
          </div>
          <Button size="sm">
            <Plus className="mr-2 h-4 w-4" />
            Invite Member
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="w-16"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <TableRow key={member.id}>
                <TableCell>
                  <div className="flex items-center space-x-3">
                    <Avatar className="h-8 w-8">
                      <AvatarImage alt={member.userName} src={member.userImage ?? undefined} />
                      <AvatarFallback>{member.userName.charAt(0).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <div>
                      <div className="font-medium">{member.userName}</div>
                      <div className="text-muted-foreground text-sm">{member.userEmail}</div>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge className="gap-1" variant={getRoleBadgeVariant(member.role)}>
                    {getRoleIcon(member.role)}
                    {member.role.charAt(0).toUpperCase() + member.role.slice(1)}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(member.joinedAt).toLocaleDateString()}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="ghost">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem>Edit Role</DropdownMenuItem>
                      <DropdownMenuItem>View Profile</DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive">Remove Member</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
