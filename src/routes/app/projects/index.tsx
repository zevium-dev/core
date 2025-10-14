import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Building2, Filter, Grid3X3, List, Plus, Search, Settings } from "lucide-react";
import { m } from "motion/react";
import * as React from "react";

import { AuthLoadingFallback } from "~/components/auth-loading-fallback";
import { ProjectCard } from "~/components/projects/project-card";
import { ProtectedRoute } from "~/components/protected-route";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { OpenApiFileUpload } from "~/components/ui/openapi-file-upload";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { useTRPCClient } from "~/lib/trpc";

export const Route = createFileRoute("/app/projects/")({
  component: RouteComponent,
});

// Enhanced organization interface with metrics
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

interface ValidationResult {
  errors?: Array<{
    code: string;
    message: string;
    path?: string;
  }>;
  isValid: boolean;
  spec?: {
    endpointCount: number;
    format: "json" | "yaml";
    title: string;
    version: string;
  };
}

function CreateProjectDialog({
  organizations,
  selectedOrgId,
}: {
  organizations: Array<Organization>;
  selectedOrgId: null | string;
}) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [isCreating, setIsCreating] = React.useState(false);
  const [formData, setFormData] = React.useState({
    description: "",
    name: "",
    organizationId: selectedOrgId ?? "",
    visibility: "private" as "internal" | "private" | "public",
  });
  const [selectedFile, setSelectedFile] = React.useState<File | undefined>();
  const [validationResult, setValidationResult] = React.useState<undefined | ValidationResult>(undefined);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();

  // Update organization when selectedOrgId changes
  React.useEffect(() => {
    if (selectedOrgId && !formData.organizationId) {
      // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect
      setFormData((prev) => ({ ...prev, organizationId: selectedOrgId }));
    }
  }, [selectedOrgId, formData.organizationId]);

  const validateForm = () => {
    const newErrors: Record<string, string> = {};

    if (!formData.name.trim()) {
      newErrors.name = "Project name is required";
    } else if (formData.name.length < 2) {
      newErrors.name = "Project name must be at least 2 characters";
    }

    if (!formData.organizationId) {
      newErrors.organizationId = "Please select an organization";
    }

    // OpenAPI file validation
    if (selectedFile && validationResult && !validationResult.isValid) {
      newErrors.openapi = "Please fix OpenAPI specification errors or remove the file";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleInputChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    // Clear error when user starts typing
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: "" }));
    }
  };

  const handleFileSelect = (file: File, validation: ValidationResult) => {
    setSelectedFile(file);
    setValidationResult(validation);
    // Clear any existing OpenAPI errors
    if (errors.openapi) {
      setErrors((prev) => ({ ...prev, openapi: "" }));
    }
  };

  const handleFileRemove = () => {
    setSelectedFile(undefined);
    setValidationResult(undefined);
    // Clear any existing OpenAPI errors
    if (errors.openapi) {
      setErrors((prev) => ({ ...prev, openapi: "" }));
    }
  };

  const handleCreateProject = async () => {
    if (!validateForm()) return;

    setIsCreating(true);
    try {
      // Create the project first
      const result = await trpcClient.project.create.mutate({
        description: formData.description || undefined,
        name: formData.name.trim(),
        organizationId: formData.organizationId,
        visibility: formData.visibility,
      });

      if (result.success) {
        // If we have a valid OpenAPI spec, upload it
        if (selectedFile && validationResult?.isValid) {
          try {
            const fileContent = await selectedFile.text();
            await trpcClient.apiSpec.upload.mutate({
              fileContent,
              fileName: selectedFile.name,
              projectId: result.project.id,
              versionLabel: validationResult.spec?.version,
            });
          } catch (specError) {
            // Project created but spec upload failed - show warning but continue
            console.warn("Project created but OpenAPI spec upload failed:", specError);
          }
        }

        // Close dialog and reset form
        setIsOpen(false);
        setFormData({
          description: "",
          name: "",
          organizationId: selectedOrgId ?? "",
          visibility: "private",
        });
        setSelectedFile(undefined);
        setValidationResult(undefined);
        setErrors({});

        // Invalidate and refetch projects
        await queryClient.invalidateQueries({ queryKey: ["projects"] });
      }
    } catch (error) {
      console.error("Failed to create project:", error);
      setErrors({ submit: "Failed to create project. Please try again." });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog onOpenChange={setIsOpen} open={isOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700">
          <Plus className="h-4 w-4" />
          New Project
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-xl">Create New Project</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Set up a new API project with OpenAPI specifications and team management
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Project Name</label>
              <Input
                onChange={(e) => handleInputChange("name", e.target.value)}
                placeholder="Enter project name"
                value={formData.name}
              />
              {errors.name && <p className="text-sm text-red-500">{errors.name}</p>}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Organization</label>
              <Select
                onValueChange={(value) => handleInputChange("organizationId", value)}
                value={formData.organizationId}
              >
                <SelectTrigger className="bg-muted/20 border-border/40 focus:ring-ring border shadow-sm hover:shadow-md focus:ring-2 focus:ring-offset-1">
                  <SelectValue placeholder="Select organization" />
                </SelectTrigger>
                <SelectContent>
                  {organizations.map((org) => (
                    <SelectItem key={org.id} value={org.id}>
                      {org.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.organizationId && <p className="text-sm text-red-500">{errors.organizationId}</p>}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Description</label>
            <Textarea
              onChange={(e) => handleInputChange("description", e.target.value)}
              placeholder="Describe your project and its APIs"
              value={formData.description}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Visibility</label>
            <Select onValueChange={(value) => handleInputChange("visibility", value)} value={formData.visibility}>
              <SelectTrigger className="bg-muted/20 border-border/40 focus:ring-ring border shadow-sm hover:shadow-md focus:ring-2 focus:ring-offset-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">Private - Only team members</SelectItem>
                <SelectItem value="internal">Internal - Organization members</SelectItem>
                <SelectItem value="public">Public - Anyone can view</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">OpenAPI Specification (Optional)</label>
            <OpenApiFileUpload
              disabled={isCreating}
              onFileRemove={handleFileRemove}
              onFileSelect={handleFileSelect}
              selectedFile={selectedFile}
              validationResult={validationResult}
            />
            {errors.openapi && <p className="text-sm text-red-500">{errors.openapi}</p>}
          </div>

          {errors.submit && <div className="rounded-md bg-red-50 p-3 text-sm text-red-500">{errors.submit}</div>}

          <div className="flex justify-end gap-3">
            <Button disabled={isCreating} onClick={() => setIsOpen(false)} variant="outline">
              Cancel
            </Button>
            <Button
              className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700"
              disabled={isCreating}
              onClick={handleCreateProject}
            >
              {isCreating ? "Creating..." : "Create Project"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RouteComponent() {
  const trpcClient = useTRPCClient();

  // State management for filtering and display
  const [selectedOrgId, setSelectedOrgId] = React.useState<null | string>(null);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [viewMode, setViewMode] = React.useState<"grid" | "list">("grid");
  const [statusFilter, setStatusFilter] = React.useState<string>("all");

  // Fetch organizations
  const {
    data: organizationsData,
    error: orgsError,
    isLoading: orgsLoading,
  } = useQuery({
    queryFn: () => trpcClient.organization.list.query(),
    queryKey: ["organizations"],
  });

  // Fetch projects for selected organization
  const {
    data: projectsData,
    error: projectsError,
    isLoading: projectsLoading,
  } = useQuery({
    enabled: Boolean(selectedOrgId),
    queryFn: () => {
      if (!selectedOrgId) throw new Error("No organization selected");
      return trpcClient.organization.getProjects.query({ organizationId: selectedOrgId });
    },
    queryKey: ["projects", selectedOrgId],
  });

  const organizations = React.useMemo(() => organizationsData?.organizations ?? [], [organizationsData]);
  const projects = React.useMemo(() => projectsData?.projects ?? [], [projectsData]);

  // Filter projects based on search and status
  const filteredProjects = React.useMemo(() => {
    let filtered = projects;

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      filtered = filtered.filter(
        (project) =>
          project.name.toLowerCase().includes(query) ||
          (project.description?.toLowerCase().includes(query) ?? false) ||
          project.slug.toLowerCase().includes(query),
      );
    }

    // Apply status filter
    if (statusFilter !== "all") {
      filtered = filtered.filter((project) => project.status === statusFilter);
    }

    return filtered;
  }, [projects, searchQuery, statusFilter]);

  // Auto-select first organization if none selected
  React.useEffect(() => {
    if (!selectedOrgId && organizations.length > 0) {
      const firstOrgId = organizations.at(0)?.id ?? null;
      if (firstOrgId) {
        // Intentionally call the setter here to initialize selection when orgs load.
        // Disable the specific linter rule for this line because we need to set state
        // after async data (organizations) resolves.
        // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect
        setSelectedOrgId(firstOrgId);
      }
    }
  }, [organizations, selectedOrgId]);

  if (orgsLoading) {
    return <AuthLoadingFallback />;
  }

  if (orgsError) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <h2 className="text-destructive text-lg font-semibold">Failed to load organizations</h2>
          <p className="text-muted-foreground mt-1 text-sm">Please try refreshing the page</p>
        </div>
      </div>
    );
  }

  if (organizations.length === 0) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="space-y-4 text-center">
          <Building2 className="text-muted-foreground mx-auto h-12 w-12" />
          <div>
            <h2 className="text-lg font-semibold">No Organizations Found</h2>
            <p className="text-muted-foreground text-sm">
              You need to be a member of an organization to create projects
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ProtectedRoute>
      <div className="bg-background min-h-screen">
        {/* Enhanced Header with better spacing and gradients */}
        <div className="from-background via-background to-secondary-background supports-[backdrop-filter]:bg-background/95 border-b bg-gradient-to-r backdrop-blur">
          <div className="container mx-auto px-4 py-4">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
              {/* Header Content */}
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Building2 className="text-primary h-8 w-8" />
                  <h1 className="from-foreground to-foreground/70 bg-gradient-to-r bg-clip-text text-4xl font-bold tracking-tight text-transparent">
                    Projects
                  </h1>
                </div>
                <p className="text-muted-foreground max-w-2xl text-lg">
                  Manage your API projects, specifications, and team collaboration across your organization
                </p>
              </div>

              {/* Actions */}
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <div className="relative">
                  <Select onValueChange={setSelectedOrgId} value={selectedOrgId ?? ""}>
                    <SelectTrigger className="bg-card border-border/40 w-full shadow-sm transition-shadow hover:shadow-md sm:w-[400px]">
                      <div className="flex items-center gap-2">
                        <Building2 className="text-muted-foreground h-4 w-4" />
                        <SelectValue placeholder="Select organization" />
                      </div>
                    </SelectTrigger>
                    <SelectContent>
                      {organizations.map((org) => (
                        <SelectItem key={org.id} value={org.id}>
                          <div className="flex items-center gap-3">
                            <div className="flex flex-col">
                              <span className="font-medium">{org.name}</span>
                            </div>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <CreateProjectDialog organizations={organizations} selectedOrgId={selectedOrgId} />
              </div>
            </div>
          </div>
        </div>

        <div className="container mx-auto px-4 py-4">
          {selectedOrgId ? (
            <div className="space-y-8">
              {/* Enhanced Filters and Search */}
              <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex flex-1 items-center gap-4">
                  <div className="relative max-w-md flex-1">
                    <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
                    <Input
                      className="bg-card border-border/40 pl-10 shadow-sm transition-shadow focus:shadow-md"
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search projects by name, description, or slug..."
                      value={searchQuery}
                    />
                  </div>

                  <Select onValueChange={setStatusFilter} value={statusFilter}>
                    <SelectTrigger className="bg-card border-border/40 w-[180px] shadow-sm transition-shadow hover:shadow-md">
                      <div className="flex items-center gap-2">
                        <Filter className="h-4 w-4" />
                        <SelectValue />
                      </div>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Status</SelectItem>
                      <SelectItem value="active">
                        <div className="flex items-center gap-2">
                          <Badge className="h-2 w-2 bg-green-500 p-0" variant="default"></Badge>
                          Active
                        </div>
                      </SelectItem>
                      <SelectItem value="beta">
                        <div className="flex items-center gap-2">
                          <Badge className="h-2 w-2 bg-yellow-500 p-0" variant="default"></Badge>
                          Beta
                        </div>
                      </SelectItem>
                      <SelectItem value="deprecated">
                        <div className="flex items-center gap-2">
                          <Badge className="h-2 w-2 bg-orange-500 p-0" variant="default"></Badge>
                          Deprecated
                        </div>
                      </SelectItem>
                      <SelectItem value="archived">
                        <div className="flex items-center gap-2">
                          <Badge className="h-2 w-2 bg-gray-500 p-0" variant="default"></Badge>
                          Archived
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground text-sm">View:</span>
                  <ToggleGroup
                    className="border-border/40 border shadow-sm"
                    onValueChange={(value) => value && setViewMode(value as "grid" | "list")}
                    type="single"
                    value={viewMode}
                  >
                    <ToggleGroupItem
                      aria-label="Grid view"
                      className="data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                      value="grid"
                    >
                      <Grid3X3 className="h-4 w-4" />
                    </ToggleGroupItem>
                    <ToggleGroupItem
                      aria-label="List view"
                      className="data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                      value="list"
                    >
                      <List className="h-4 w-4" />
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
              </div>

              {/* Results Summary */}
              {!projectsLoading && (
                <div className="flex items-center justify-between">
                  <p className="text-muted-foreground text-sm">
                    {filteredProjects.length === projects.length
                      ? `Showing all ${projects.length} project${projects.length !== 1 ? "s" : ""}`
                      : `Showing ${filteredProjects.length} of ${projects.length} project${projects.length !== 1 ? "s" : ""}`}
                  </p>
                  {searchQuery && (
                    <Button className="text-xs" onClick={() => setSearchQuery("")} size="sm" variant="ghost">
                      Clear search
                    </Button>
                  )}
                </div>
              )}

              {/* Projects Grid/List */}
              {projectsLoading ? (
                <div className="flex items-center justify-center py-6">
                  <AuthLoadingFallback />
                </div>
              ) : projectsError ? (
                <Card className="border-border/40">
                  <CardContent className="py-6 text-center">
                    <h3 className="text-destructive text-lg font-semibold">Failed to load projects</h3>
                    <p className="text-muted-foreground mt-1 text-sm">Please try refreshing the page</p>
                  </CardContent>
                </Card>
              ) : filteredProjects.length === 0 ? (
                <Card className="border-border/40">
                  <CardContent className="space-y-4 py-6 text-center">
                    <Settings className="text-muted-foreground mx-auto h-12 w-12" />
                    <div>
                      <h3 className="text-lg font-semibold">
                        {projects.length === 0 ? "No Projects Yet" : "No Matching Projects"}
                      </h3>
                      <p className="text-muted-foreground text-sm">
                        {projects.length === 0
                          ? "Create your first project to get started with API management"
                          : "Try adjusting your search or filter criteria"}
                      </p>
                    </div>
                    {projects.length === 0 && (
                      <CreateProjectDialog organizations={organizations} selectedOrgId={selectedOrgId} />
                    )}
                  </CardContent>
                </Card>
              ) : (
                <div className={viewMode === "grid" ? "grid gap-6 sm:grid-cols-2 lg:grid-cols-3" : "space-y-4"}>
                  {filteredProjects.map((project, index) => (
                    <m.div
                      animate={{ opacity: 1, y: 0 }}
                      initial={{ opacity: 0, y: 20 }}
                      key={project.id}
                      transition={{ delay: index * 0.05, duration: 0.3 }}
                    >
                      <ProjectCard project={project} variant={viewMode === "list" ? "compact" : "default"} />
                    </m.div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <Card className="border-border/40">
              <CardContent className="py-6 text-center">
                <Building2 className="text-muted-foreground mx-auto h-12 w-12" />
                <h3 className="mt-4 text-lg font-semibold">Select an Organization</h3>
                <p className="text-muted-foreground text-sm">Choose an organization to view and manage projects</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </ProtectedRoute>
  );
}
