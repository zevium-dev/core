import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createLazyFileRoute, Link } from "@tanstack/react-router";
import {
  AlertCircle,
  ArrowLeft,
  Book,
  Building2,
  Calendar,
  Code2,
  Copy,
  Edit3,
  ExternalLink,
  Eye,
  FileText,
  Globe,
  Lock,
  MoreHorizontal,
  Plus,
  Save,
  Settings,
  Shield,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { m } from "motion/react";
import * as React from "react";
import { toast } from "sonner";

import { AuthLoadingFallback } from "~/components/auth-loading-fallback";
import { ProtectedRoute } from "~/components/protected-route";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { BadgeStatus } from "~/components/ui/badge-status";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { EasyTooltip } from "~/components/ui/easy-tooltip";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";
import { useCopy } from "~/hooks/use-copy";
import { useTRPCClient } from "~/lib/trpc";

export const Route = createLazyFileRoute("/projects/$slug")({
  component: () => (
    <ProtectedRoute>
      <RouteComponent />
    </ProtectedRoute>
  ),
});

interface ProjectData {
  apiSpecCount: number;
  createdAt: Date;
  createdBy: string;
  creatorName: string;
  description: null | string;
  id: string;
  memberCount: number;
  metadata: Record<string, unknown>;
  name: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  settings: Record<string, unknown>;
  slug: string;
  status: "active" | "archived" | "beta" | "deprecated" | "inactive";
  updatedAt: Date;
  visibility: "internal" | "private" | "public";
}

function ApiSpecsSection({ projectId }: { projectId: string }) {
  const trpcClient = useTRPCClient();

  const {
    data: specsData,
    error: specsError,
    isLoading: specsLoading,
  } = useQuery({
    queryFn: () => trpcClient.apiSpec.getByProject.query({ projectId }),
    queryKey: ["apiSpecs", projectId],
  });

  if (specsLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>API Specifications</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {Array.from({ length: 3 }).map((_) => (
              <div className="flex items-center space-x-4" key={crypto.randomUUID()}>
                <Skeleton className="h-10 w-10 rounded" />
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-4 w-[200px]" />
                  <Skeleton className="h-3 w-[100px]" />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (specsError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>API Specifications</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <AlertCircle className="h-5 w-5 mr-2" />
            Failed to load API specifications
          </div>
        </CardContent>
      </Card>
    );
  }

  const specs = specsData?.specs ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>API Specifications</CardTitle>
          <CardDescription>
            OpenAPI specifications and documentation for this project
          </CardDescription>
        </div>
        <Button size="sm" variant="outline">
          <FileText className="h-4 w-4 mr-2" />
          Upload Spec
        </Button>
      </CardHeader>
      <CardContent>
        {specs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Book className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No API Specifications</h3>
            <p className="text-muted-foreground mb-4 max-w-md">
              Upload your first OpenAPI specification to start documenting your APIs and enable powerful features.
            </p>
            <Button>
              <FileText className="h-4 w-4 mr-2" />
              Upload OpenAPI Spec
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {specs.map((spec) => (
              <div
                className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors"
                key={spec.id}
              >
                <div className="flex items-center space-x-4">
                  <div className="h-10 w-10 rounded bg-blue-100 dark:bg-blue-900/20 flex items-center justify-center">
                    <FileText className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                  </div>
                  <div>
                    <div className="flex items-center space-x-2">
                      <h4 className="font-medium">{spec.title ?? "Untitled API"}</h4>
                      <Badge className="text-xs" variant="outline">
                        v{spec.versionLabel}
                      </Badge>
                      <BadgeStatus status={spec.status} />
                    </div>
                    <div className="flex items-center space-x-4 mt-1 text-sm text-muted-foreground">
                      <span>{spec.endpointCount} endpoints</span>
                      <span>•</span>
                      <span className="capitalize">{spec.format}</span>
                      <span>•</span>
                      <span>Updated {new Date(spec.updatedAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  <Button size="sm" variant="ghost">
                    <ExternalLink className="h-4 w-4 mr-2" />
                    View Docs
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="ghost">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem>Edit Specification</DropdownMenuItem>
                      <DropdownMenuItem>Download</DropdownMenuItem>
                      <DropdownMenuItem>Duplicate</DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive">
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Documentation Section with Split View
function DocumentationSection({ project }: { project: ProjectData }) {
  const [documentation, setDocumentation] = React.useState(
    typeof project.metadata.documentation === "string" ? project.metadata.documentation : ""
  );
  
  // Update local state when project data changes (from optimistic updates)
  const previousDocumentation = React.useRef(project.metadata.documentation);
  const currentProjectDoc = typeof project.metadata.documentation === "string" ? project.metadata.documentation : "";
  if (previousDocumentation.current !== project.metadata.documentation) {
    setDocumentation(currentProjectDoc);
    previousDocumentation.current = project.metadata.documentation;
  }
  
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();

  const updateProjectMutation = useMutation<
    unknown,
    Error,
    { documentation: string },
    { previousDocumentation: string }
  >({
    mutationFn: (data: { documentation: string }) =>
      trpcClient.project.update.mutate({
        metadata: {
          ...project.metadata,
          documentation: data.documentation,
        },
        projectId: project.id,
      }),
    onError: (error, _variables, context) => {
      console.error("Failed to save documentation:", error);
      toast.error("Failed to save documentation");
      // Revert to previous documentation on error
      if (context?.previousDocumentation !== undefined) {
        setDocumentation(context.previousDocumentation);
      }
      void queryClient.invalidateQueries({ queryKey: ["project", project.slug] });
    },
    onMutate: async (variables) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ["project", project.slug] });

      // Snapshot the previous value
      const previousDocumentation = documentation;

      // Optimistically update local state immediately
      setDocumentation(variables.documentation);

      // Also update the query cache
      queryClient.setQueryData(["project", project.slug], (old: { project: ProjectData } | undefined) => {
        if (!old) return old;
        return {
          ...old,
          project: {
            ...old.project,
            metadata: {
              ...old.project.metadata,
              documentation: variables.documentation,
            },
            updatedAt: new Date(),
          },
        };
      });

      return { previousDocumentation };
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["project", project.slug] });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project", project.slug] });
    },
  });

  const handleSaveDocumentation = (value: string) => {
    // The optimistic update will happen in onMutate
    updateProjectMutation.mutate({ documentation: value });
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 h-[600px]">
      {/* Editor */}
      <Card className="flex flex-col">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Edit3 className="h-5 w-5" />
            Editor
          </CardTitle>
          <CardDescription>
            Write your documentation in Markdown format
          </CardDescription>
        </CardHeader>
        <CardContent className="flex-1">
          <RichTextEditor
            onChange={handleSaveDocumentation}
            placeholder="Write your project documentation here..."
            value={documentation}
          />
        </CardContent>
      </Card>

      {/* Preview */}
      <Card className="flex flex-col">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Eye className="h-5 w-5" />
            Preview
          </CardTitle>
          <CardDescription>
            Live preview of your documentation
          </CardDescription>
        </CardHeader>
        <CardContent className="flex-1">
          <div className="h-full border rounded-lg p-4 overflow-auto bg-muted/20">
            {documentation ? (
              <div className="prose prose-sm max-w-none dark:prose-invert">
                {documentation.split('\n').map((line, index) => {
                  const key = `line-${index}-${line.slice(0, 10)}`;
                  if (line.startsWith('# ')) {
                    return <h1 className="text-2xl font-bold mt-6 mb-4" key={key}>{line.slice(2)}</h1>;
                  }
                  if (line.startsWith('## ')) {
                    return <h2 className="text-xl font-semibold mt-5 mb-3" key={key}>{line.slice(3)}</h2>;
                  }
                  if (line.startsWith('### ')) {
                    return <h3 className="text-lg font-medium mt-4 mb-2" key={key}>{line.slice(4)}</h3>;
                  }
                  if (line.startsWith('**') && line.endsWith('**')) {
                    return <p className="font-bold" key={key}>{line.slice(2, -2)}</p>;
                  }
                  if (line.startsWith('*') && line.endsWith('*')) {
                    return <p className="italic" key={key}>{line.slice(1, -1)}</p>;
                  }
                  if (line.trim() === '') {
                    return <br key={key} />;
                  }
                  return <p className="mb-2" key={key}>{line}</p>;
                })}
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-muted-foreground">
                <div className="text-center">
                  <Book className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>Start writing to see the preview</p>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// Editable Field Component
function EditableField({
  isLoading = false,
  label,
  onSave,
  options,
  placeholder,
  type = "text",
  value,
}: {
  isLoading?: boolean;
  label: string;
  onSave: (value: string) => void;
  options?: Array<{ label: string; value: string }>;
  placeholder?: string;
  type?: "select" | "text" | "textarea";
  value: string;
}) {
  const [isEditing, setIsEditing] = React.useState(false);
  const [editValue, setEditValue] = React.useState(value);

  // Update editValue when external value changes and we're not editing
  const previousValue = React.useRef(value);
  if (previousValue.current !== value && !isEditing) {
    setEditValue(value);
    previousValue.current = value;
  }

  const handleSave = () => {
    onSave(editValue);
    setIsEditing(false); // Close edit mode immediately for better UX
    toast.success("Changes saved successfully");
  };

  const handleCancel = () => {
    setEditValue(value);
    setIsEditing(false);
  };

  if (!isEditing) {
    return (
      <div className="group cursor-pointer" onClick={() => setIsEditing(true)}>
        <Label className="text-sm font-medium text-muted-foreground">{label}</Label>
        <div className={`flex items-center gap-2 mt-1 p-3 rounded-md border border-dashed border-muted-foreground/30 hover:border-muted-foreground/50 hover:bg-muted/50 transition-all ${type === 'textarea' ? 'min-h-[80px] items-start' : ''}`}>
          <span className="flex-1 text-sm">
            {value || <span className="text-muted-foreground italic">{placeholder ?? "Click to edit"}</span>}
          </span>
          <Edit3 className="h-4 w-4 text-muted-foreground/60 group-hover:text-muted-foreground transition-colors" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">{label}</Label>
      {type === "select" ? (
        <Select onValueChange={setEditValue} value={editValue}>
          <SelectTrigger>
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent>
            {options?.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : type === "textarea" ? (
        <Textarea
          onChange={(e) => setEditValue(e.target.value)}
          placeholder={placeholder}
          value={editValue}
        />
      ) : (
        <Input
          onChange={(e) => setEditValue(e.target.value)}
          placeholder={placeholder}
          value={editValue}
        />
      )}
      <div className="flex gap-2">
        <Button disabled={isLoading} onClick={handleSave} size="sm">
          <Save className="h-4 w-4 mr-2" />
          {isLoading ? "Saving..." : "Save"}
        </Button>
        <Button disabled={isLoading} onClick={handleCancel} size="sm" variant="outline">
          <X className="h-4 w-4 mr-2" />
          Cancel
        </Button>
      </div>
    </div>
  );
}

// Endpoints Section
function EndpointsSection({ project }: { project: ProjectData }) {
  const trpcClient = useTRPCClient();

  const {
    data: specsData,
    isLoading: specsLoading,
  } = useQuery({
    queryFn: () => trpcClient.apiSpec.getByProject.query({ projectId: project.id }),
    queryKey: ["apiSpecs", project.id],
  });

  const specs = specsData?.specs ?? [];

  // Fetch endpoints for each spec
  const specEndpointsQueries = useQuery({
    enabled: specs.length > 0,
    queryFn: async () => {
      const endpointsPromises = specs.map(async (spec) => {
        try {
          const result = await trpcClient.apiSpec.getById.query({ specId: spec.id });
          return { endpoints: result.spec.endpoints, specId: spec.id };
        } catch (error) {
          console.error(`Failed to fetch endpoints for spec ${spec.id}:`, error);
          return { endpoints: [], specId: spec.id };
        }
      });
      const results = await Promise.all(endpointsPromises);
      return results.reduce<Record<string, Array<{
        deprecated: boolean;
        id: string;
        method: string;
        path: string;
        summary: null | string;
        tags: Array<string>;
      }>>>((acc, result) => {
        acc[result.specId] = result.endpoints;
        return acc;
      }, {});
    },
    queryKey: ["specEndpoints", specs.map(s => s.id)],
  });

  const endpointsBySpec = specEndpointsQueries.data ?? {};

  const getMethodColor = (method: string) => {
    switch (method.toUpperCase()) {
      case "DELETE":
        return "text-red-600 border-red-600";
      case "GET":
        return "text-green-600 border-green-600";
      case "PATCH":
        return "text-orange-600 border-orange-600";
      case "POST":
        return "text-blue-600 border-blue-600";
      case "PUT":
        return "text-yellow-600 border-yellow-600";
      default:
        return "text-gray-600 border-gray-600";
    }
  };

  if (specsLoading || specEndpointsQueries.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>API Endpoints</CardTitle>
          <CardDescription>
            Detailed view of all endpoints in your API specifications
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {Array.from({ length: 5 }).map((_) => (
              <div className="flex items-center space-x-4" key={crypto.randomUUID()}>
                <Skeleton className="h-6 w-16" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (specs.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>API Endpoints</CardTitle>
          <CardDescription>
            Detailed view of all endpoints in your API specifications
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Code2 className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Endpoints Found</h3>
            <p className="text-muted-foreground">
              Upload an OpenAPI specification to see your endpoints here.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>API Endpoints</CardTitle>
        <CardDescription>
          All endpoints across your API specifications
        </CardDescription>
      </CardHeader>
      {/* Insert API Specifications list here to keep specs and endpoints together */}
      <CardContent>
        <ApiSpecsSection projectId={project.id} />
      </CardContent>
      <CardContent>
        <div className="space-y-4">
          {specs.map((spec) => {
            const endpoints = endpointsBySpec[spec.id] ?? [];
            return (
              <div className="space-y-2" key={spec.id}>
                <div className="flex items-center gap-2 pb-2 border-b">
                  <FileText className="h-4 w-4" />
                  <span className="font-medium">{spec.title ?? "Untitled API"}</span>
                  <Badge className="text-xs" variant="outline">v{spec.versionLabel}</Badge>
                  <Badge className="text-xs" variant="secondary">{endpoints.length} endpoints</Badge>
                </div>
                <div className="pl-6 space-y-2">
                  {endpoints.length === 0 ? (
                    <div className="py-4 text-center text-muted-foreground text-sm">
                      No endpoints found in this specification
                    </div>
                  ) : (
                    endpoints.map((endpoint) => (
                      <div 
                        className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/50"
                        key={endpoint.id}
                      >
                        <div className="flex items-center gap-3">
                          <Badge 
                            className={getMethodColor(endpoint.method)} 
                            variant="outline"
                          >
                            {endpoint.method.toUpperCase()}
                          </Badge>
                          <span className="font-mono text-sm">{endpoint.path}</span>
                          <span className="text-sm text-muted-foreground">
                            {endpoint.summary ?? "No description"}
                          </span>
                          {endpoint.deprecated && (
                            <Badge className="text-xs" variant="destructive">
                              Deprecated
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {endpoint.tags.map((tag) => (
                            <Badge className="text-xs" key={tag} variant="secondary">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function ProjectHeader({ project }: { project: ProjectData }) {
  const [isCopied, copyToClipboard] = useCopy();
  const trpcClient = useTRPCClient();

  // Fetch available versions from API specs
  const {
    data: specsData,
  } = useQuery({
    queryFn: () => trpcClient.apiSpec.getByProject.query({ projectId: project.id }),
    queryKey: ["apiSpecs", project.id],
  });

  const specs = specsData?.specs ?? [];
  const uniqueVersions = Array.from(new Set(specs.map(spec => spec.versionLabel)))
    .sort((a, b) => b.localeCompare(a)); // Sort versions descending

  const getVisibilityIcon = (visibility: string) => {
    switch (visibility) {
      case "internal":
        return <Building2 className="h-4 w-4" />;
      case "public":
        return <Globe className="h-4 w-4" />;
      default:
        return <Lock className="h-4 w-4" />;
    }
  };

  const getVisibilityColor = (visibility: string) => {
    switch (visibility) {
      case "internal":
        return "bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400";
      case "public":
        return "bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400";
      default:
        return "bg-gray-100 text-gray-800 dark:bg-gray-900/20 dark:text-gray-400";
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case "active":
        return "Active";
      case "archived":
        return "Archived";
      case "beta":
        return "Beta";
      case "deprecated":
        return "Deprecated";
      default:
        return "Inactive";
    }
  };

  return (
    <div className="space-y-6">
      {/* Breadcrumb Navigation */}
      <nav className="flex items-center space-x-2 text-sm text-muted-foreground">
        <Link className="hover:text-foreground transition-colors" to="/projects">
          Projects
        </Link>
        <span>/</span>
        <span className="text-foreground font-medium">{project.name}</span>
      </nav>

      {/* Project Header */}
      <div className="flex items-start justify-between">
        <div className="flex-1 space-y-4">
          <div className="flex items-center space-x-4">
            <div className="h-12 w-12 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-semibold text-lg">
              {project.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1">
              <div className="flex items-end space-x-4">
                <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
                <div className="flex items-end space-x-2">
                  <Badge
                    className={`${getVisibilityColor(project.visibility)} border-0`}
                    variant="secondary"
                  >
                    {getVisibilityIcon(project.visibility)}
                    <span className="ml-1 capitalize">{project.visibility}</span>
                  </Badge>
                  <EasyTooltip label={getStatusLabel(project.status)}>
                    <div>
                      <BadgeStatus status={project.status} />
                    </div>
                  </EasyTooltip>
                  <EasyTooltip label={isCopied ? "Copied!" : "Copy project slug"}>
                    <Button
                      className="h-6 px-2 text-xs"
                      onClick={() => copyToClipboard(project.slug)}
                      size="sm"
                      variant="ghost"
                    >
                      <Copy className="h-3 w-3 mr-1" />
                      {project.slug}
                    </Button>
                  </EasyTooltip>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          {/* Version Selector */}
          {uniqueVersions.length > 0 ? (
            <Select defaultValue={uniqueVersions[0]}>
              <SelectTrigger className="w-32">
                <SelectValue placeholder="Version" />
              </SelectTrigger>
              <SelectContent>
                {uniqueVersions.map((version) => (
                  <SelectItem key={version} value={version}>
                    v{version}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Button disabled size="sm" variant="outline">
              No Versions
            </Button>
          )}
          
          <Button size="sm" variant="outline">
            <Settings className="h-4 w-4 mr-2" />
            Settings
          </Button>
          
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem>
                <Users className="h-4 w-4 mr-2" />
                Manage Access
              </DropdownMenuItem>
              <DropdownMenuItem>
                <ExternalLink className="h-4 w-4 mr-2" />
                View API Docs
              </DropdownMenuItem>
              <DropdownMenuItem>
                <FileText className="h-4 w-4 mr-2" />
                Export Project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

// Project Overview with Editable Components
function ProjectOverview({ project }: { project: ProjectData }) {
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();

  const updateProjectMutation = useMutation<
    unknown,
    Error,
    {
      description?: string;
      name?: string;
      status?: "active" | "archived" | "beta" | "deprecated" | "inactive";
      visibility?: "internal" | "private" | "public";
    },
    { previousProject: unknown }
  >({
    mutationFn: (data: {
      description?: string;
      name?: string;
      status?: "active" | "archived" | "beta" | "deprecated" | "inactive";
      visibility?: "internal" | "private" | "public";
    }) => trpcClient.project.update.mutate({
      projectId: project.id,
      ...data,
    }),
    onError: (error) => {
      console.error("Failed to update project:", error);
      toast.error("Failed to save changes");
      // Revert optimistic update on error
      void queryClient.invalidateQueries({ queryKey: ["project", project.slug] });
    },
    onMutate: async (variables) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ["project", project.slug] });

      // Snapshot the previous value
      const previousProject = queryClient.getQueryData(["project", project.slug]);

      // Optimistically update the cache
      queryClient.setQueryData(["project", project.slug], (old: { project: ProjectData } | undefined) => {
        if (!old) return old;
        return {
          ...old,
          project: {
            ...old.project,
            ...variables,
            updatedAt: new Date(),
          },
        };
      });

      return { previousProject };
    },
    onSettled: () => {
      // Always refetch after error or success to ensure we have the latest data
      void queryClient.invalidateQueries({ queryKey: ["project", project.slug] });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project", project.slug] });
    },
  });

  const handleUpdateField = (field: string, value: string) => {
    updateProjectMutation.mutate({ [field]: value });
  };

  return (
    <div className="space-y-6">
      {/* Editable Project Information */}
      <Card>
        <CardHeader>
          <CardTitle>Project Information</CardTitle>
          <CardDescription>
            Manage your project's basic information and settings
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {updateProjectMutation.error && (
            <div className="p-3 text-sm text-red-600 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md">
              Failed to update project: {updateProjectMutation.error.message}
            </div>
          )}
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Creator</Label>
              <div className="flex items-center gap-2 mt-1 p-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                <span>{project.creatorName}</span>
              </div>
            </div>

            <div>
              <Label className="text-sm font-medium text-muted-foreground">Created</Label>
              <div className="flex items-center gap-2 mt-1 p-2">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span>{new Date(project.createdAt).toLocaleDateString()}</span>
              </div>
            </div>

            <div>
              <Label className="text-sm font-medium text-muted-foreground">Last Updated</Label>
              <div className="flex items-center gap-2 mt-1 p-2">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span>{new Date(project.updatedAt).toLocaleDateString()}</span>
              </div>
            </div>

            <div>
              <Label className="text-sm font-medium text-muted-foreground">Organization</Label>
              <div className="flex items-center gap-2 mt-1 p-2">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                <span>{project.organizationName}</span>
              </div>
            </div>
          </div>
          
          <EditableField
            isLoading={updateProjectMutation.isPending}
            label="Description"
            onSave={(value) => handleUpdateField("description", value)}
            placeholder="Add a description for your project..."
            type="textarea"
            value={project.description ?? ""}
          />
        </CardContent>
      </Card>

  {/* API Specifications are shown in the Endpoints tab */}
    </div>
  );
}

// Rich Text Editor Component
function RichTextEditor({ 
  onChange,
  placeholder = "Start writing...",
  value, 
}: { 
  onChange: (value: string) => void; 
  placeholder?: string;
  value: string; 
}) {
  const [isEditing, setIsEditing] = React.useState(false);
  const [editorValue, setEditorValue] = React.useState(value);

  const handleSave = () => {
    onChange(editorValue);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditorValue(value);
    setIsEditing(false);
  };

  return (
    <div className="space-y-4">
      {!isEditing ? (
        <div 
          className="min-h-[200px] p-4 border rounded-lg cursor-pointer hover:bg-muted/50 transition-colors"
          onClick={() => setIsEditing(true)}
        >
          {value ? (
            <div className="prose prose-sm max-w-none dark:prose-invert">
              {value.split('\n').map((line) => (
                <p key={line + crypto.randomUUID()}>{line}</p>
              ))}
            </div>
          ) : (
            <div className="text-muted-foreground flex items-center gap-2">
              <Edit3 className="h-4 w-4" />
              {placeholder}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <Textarea
            className="min-h-[200px] resize-y"
            onChange={(e) => setEditorValue(e.target.value)}
            placeholder={placeholder}
            value={editorValue}
          />
          <div className="flex gap-2">
            <Button onClick={handleSave} size="sm">
              <Save className="h-4 w-4 mr-2" />
              Save
            </Button>
            <Button onClick={handleCancel} size="sm" variant="outline">
              <X className="h-4 w-4 mr-2" />
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function RouteComponent() {
  const { slug } = Route.useParams();
  const trpcClient = useTRPCClient();

  const {
    data: projectData,
    error: projectError,
    isLoading: projectLoading,
  } = useQuery({
    queryFn: () => trpcClient.project.getBySlug.query({ slug }),
    queryKey: ["project", slug],
  });

  if (projectLoading) {
    return <AuthLoadingFallback />;
  }

  if (projectError || !projectData?.project) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-center">
        <AlertCircle className="h-12 w-12 text-muted-foreground mb-4" />
        <h2 className="text-xl font-semibold mb-2">Project Not Found</h2>
        <p className="text-muted-foreground mb-4">
          The project you're looking for doesn't exist or you don't have access to it.
        </p>
        <Link to="/projects">
          <Button>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Projects
          </Button>
        </Link>
      </div>
    );
  }

  const project = projectData.project;

  return (
    <m.div
      animate={{ opacity: 1, y: 0 }}
      className="container mx-auto px-4 py-6 space-y-8"
      initial={{ opacity: 0, y: 20 }}
      transition={{ duration: 0.3 }}
    >
      <ProjectHeader project={project} />

      <Tabs className="space-y-6" defaultValue="overview">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="documentation">Documentation</TabsTrigger>
          <TabsTrigger value="endpoints">Endpoints</TabsTrigger>
          <TabsTrigger value="team">Team</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <ProjectOverview project={project} />
        </TabsContent>

        <TabsContent value="documentation">
          <DocumentationSection project={project} />
        </TabsContent>

        <TabsContent value="endpoints">
          <EndpointsSection project={project} />
        </TabsContent>

        <TabsContent value="team">
          <TeamManagementSection project={project} />
        </TabsContent>
      </Tabs>
    </m.div>
  );
}

// Team Management Section  
function TeamManagementSection({ project }: { project: ProjectData }) {
  const trpcClient = useTRPCClient();

  const {
    data: membersData,
    isLoading: membersLoading,
  } = useQuery({
    queryFn: () => trpcClient.project.getMembers.query({ projectId: project.id }),
    queryKey: ["projectMembers", project.id],
  });

  const members = membersData?.members ?? [];

  const getRoleBadgeVariant = (role: string) => {
    switch (role) {
      case "admin":
        return "destructive";
      case "editor":
        return "default";
      default:
        return "secondary";
    }
  };

  const getRoleIcon = (role: string) => {
    switch (role) {
      case "admin":
        return <Shield className="h-3 w-3" />;
      case "editor":
        return <Edit3 className="h-3 w-3" />;
      default:
        return <Eye className="h-3 w-3" />;
    }
  };

  if (membersLoading) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Team Members</CardTitle>
            <CardDescription>
              Manage team members and their access to this project
            </CardDescription>
          </div>
          <Button size="sm">
            <Plus className="h-4 w-4 mr-2" />
            Invite Member
          </Button>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {Array.from({ length: 3 }).map((_) => (
              <div className="flex items-center space-x-4" key={crypto.randomUUID()}>
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-4 w-[150px]" />
                  <Skeleton className="h-3 w-[100px]" />
                </div>
                <Skeleton className="h-6 w-16" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Team Members</CardTitle>
          <CardDescription>
            Manage team members and their access to this project
          </CardDescription>
        </div>
        <Button size="sm">
          <Plus className="h-4 w-4 mr-2" />
          Invite Member
        </Button>
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
                      <AvatarFallback>
                        {member.userName.split(' ').map((n: string) => n[0]).join('')}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <div className="font-medium">{member.userName}</div>
                      <div className="text-sm text-muted-foreground">{member.userEmail}</div>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge className="gap-1" variant={getRoleBadgeVariant(member.role)}>
                    {getRoleIcon(member.role)}
                    {member.role.charAt(0).toUpperCase() + member.role.slice(1)}
                  </Badge>
                </TableCell>
                <TableCell>
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
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive">
                        <Trash2 className="h-4 w-4 mr-2" />
                        Remove Member
                      </DropdownMenuItem>
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
