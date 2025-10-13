import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Building2, Calendar, Plus, Search, Users } from "lucide-react";
import { m } from "motion/react";
import * as React from "react";

import { AuthLoadingFallback } from "~/components/auth-loading-fallback";
// Avatar components removed — not used in this file
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { useTRPCClient } from "~/lib/trpc";

// Interface definition for organization from database
interface Organization {
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
  website: null | string;
}

export const Route = createFileRoute("/app/organizations/")({
  component: RouteComponent,
});

function CreateOrganizationModal({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const [organizationName, setOrganizationName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [website, setWebsite] = React.useState("");
  const [_isLoading, setIsLoading] = React.useState(false);

  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!organizationName.trim()) {
      alert("Please enter an organization name");
      return;
    }

    setIsLoading(true);

    try {
      await trpcClient.organization.create.mutate({
        description: description.trim() || undefined,
        name: organizationName.trim(),
        website: website.trim() || undefined,
      });

      // Invalidate organizations query to refetch the list
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });

      // Reset form and close modal
      setOrganizationName("");
      setDescription("");
      setWebsite("");
      setOpen(false);
    } catch (error) {
      console.error("Error creating organization:", error);
      alert(`Error creating organization: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Create New Organization</DialogTitle>
          <DialogDescription>Set up a new organization to manage your projects and team members.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Organization Name</Label>
              <Input
                id="name"
                onChange={(e) => setOrganizationName(e.target.value)}
                placeholder="Enter organization name..."
                required
                value={organizationName}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="description">Description (Optional)</Label>
              <Textarea
                id="description"
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe your organization..."
                rows={3}
                value={description}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setOpen(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button className="gap-2" type="submit">
              <Plus className="h-4 w-4" />
              Create Organization
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OrganizationCard({ index, organization }: { index: number; organization: Organization }) {
  const navigate = useNavigate();

  const handleCardClick = () => {
    void navigate({ to: `/organizations/${organization.slug}` });
  };

  return (
    <m.div
      animate={{ opacity: 1, y: 0 }}
      className="group"
      initial={{ opacity: 0, y: 20 }}
      transition={{ delay: index * 0.1, duration: 0.5 }}
      whileHover={{ y: -4 }}
    >
      <Card
        className="group-hover:border-primary/20 h-full cursor-pointer transition-all duration-300 ease-out group-hover:shadow-lg"
        onClick={handleCardClick}
      >
        <CardHeader className="">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="bg-primary/10 group-hover:bg-primary/20 rounded-full p-3 transition-colors duration-300">
                <Building2 className="text-primary h-6 w-6" />
              </div>
              <div>
                <h3 className="text-lg font-semibold tracking-tight">{organization.name}</h3>
              </div>
            </div>
            <Button
              className="opacity-0 transition-opacity duration-300 group-hover:opacity-100"
              size="sm"
              variant="ghost"
            >
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>

        <CardContent className="pt-0">
          <div className="space-y-4">
            {/* Organization Stats */}
            <div className="grid grid-cols-2 gap-4">
              <div className="flex items-center gap-2">
                <div className="rounded-full bg-blue-100 p-1.5 dark:bg-blue-900/50">
                  <Building2 className="h-3 w-3 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Projects</p>
                  <p className="text-sm font-semibold">{organization.projectCount}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="rounded-full bg-green-100 p-1.5 dark:bg-green-900/50">
                  <Users className="h-3 w-3 text-green-600 dark:text-green-400" />
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Members</p>
                  <p className="text-sm font-semibold">{organization.memberCount}</p>
                </div>
              </div>
            </div>

            {/* Status Badge */}
            <div className="flex items-center justify-between">
              <Badge className="text-xs" variant="secondary">
                Active
              </Badge>
              <div className="text-muted-foreground flex items-center gap-1 text-xs">
                <Calendar className="h-3 w-3" />
                Est. 2024
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </m.div>
  );
}

function RouteComponent() {
  const [searchQuery, setSearchQuery] = React.useState("");
  const trpcClient = useTRPCClient();

  // Fetch organizations using React Query with TRPC
  const {
    data: organizationsData,
    error,
    isLoading,
  } = useQuery({
    queryFn: () => trpcClient.organization.list.query(),
    queryKey: ["organizations"],
  });

  const filteredOrganizations = React.useMemo(() => {
    const organizations: Array<Organization> = organizationsData?.organizations ?? [];
    return organizations.filter((org) => org.name.toLowerCase().includes(searchQuery.toLowerCase()));
  }, [organizationsData?.organizations, searchQuery]);

  if (isLoading) {
    return (
      <div className="container mx-auto space-y-8 px-8 py-8">
        <div className="flex items-center justify-center py-12">
          <div className="text-muted-foreground">Loading organizations...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto space-y-8 px-8 py-8">
        <div className="flex items-center justify-center py-12">
          <div className="text-red-600">
            Error loading organizations: {error instanceof Error ? error.message : "Unknown error"}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto space-y-8 px-8 py-8">
      {/* Header */}
      <m.div animate={{ opacity: 1, y: 0 }} initial={{ opacity: 0, y: -20 }} transition={{ duration: 0.5 }}>
        <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tight">Organizations</h1>
            <p className="text-muted-foreground">Manage your organizations and collaborate with your teams</p>
          </div>

          <div className="flex items-center gap-4">
            <div className="relative min-w-[300px]">
              <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 transform" />
              <Input
                className="pl-10"
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search organizations..."
                value={searchQuery}
              />
            </div>
            <CreateOrganizationModal>
              <Button className="gap-2">
                <Plus className="h-4 w-4" />
                New Organization
              </Button>
            </CreateOrganizationModal>
          </div>
        </div>
      </m.div>

      {/* Organizations Grid */}
      <m.div animate={{ opacity: 1 }} initial={{ opacity: 0 }} transition={{ delay: 0.2, duration: 0.5 }}>
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {filteredOrganizations.map((organization, index) => (
            <OrganizationCard index={index} key={organization.id} organization={organization} />
          ))}
        </div>

        {/* Empty State */}
        {filteredOrganizations.length === 0 && (
          <m.div
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center justify-center py-12 text-center"
            initial={{ opacity: 0, scale: 0.95 }}
            transition={{ delay: 0.3, duration: 0.5 }}
          >
            <div className="bg-muted/50 mb-4 rounded-full p-6">
              <Building2 className="text-muted-foreground h-8 w-8" />
            </div>
            <h3 className="mb-2 text-lg font-semibold">No organizations found</h3>
            <p className="text-muted-foreground mb-4 max-w-md text-sm">
              {searchQuery
                ? "No organizations match your search criteria. Try adjusting your search terms."
                : "You haven't created any organizations yet. Get started by creating your first organization."}
            </p>
            {!searchQuery && (
              <CreateOrganizationModal>
                <Button className="gap-2">
                  <Plus className="h-4 w-4" />
                  Create Organization
                </Button>
              </CreateOrganizationModal>
            )}
          </m.div>
        )}
      </m.div>
    </div>
  );
}
