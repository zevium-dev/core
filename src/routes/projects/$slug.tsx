import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, useMatches } from "@tanstack/react-router";
import {
  AlertCircle,
  ArrowLeft,
  Book,
  Building2,
  Calendar,
  Code2,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  Eye,
  FileText,
  Globe,
  Lock,
  MoreHorizontal,
  Plus,
  Save,
  Shield,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { m } from "motion/react";
import * as React from "react";
import { toast } from "sonner";

import { AuthLoadingFallback } from "~/components/auth-loading-fallback";
import { EditableCategoryField } from "~/components/projects/editable-category-field";
import { ProtectedRoute } from "~/components/protected-route";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { BadgeStatus } from "~/components/ui/badge-status";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { EasyTooltip } from "~/components/ui/easy-tooltip";
import { FileUpload } from "~/components/ui/file-upload";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";
import { useCopy } from "~/hooks/use-copy";
import { useTRPCClient } from "~/lib/trpc";

export const Route = createFileRoute("/projects/$slug")({
  component: () => (
    <ProtectedRoute>
      <RouteComponent />
    </ProtectedRoute>
  ),
});

interface ProjectData {
  apiSpecCount: number;
  categoryId: null | string;
  categoryName: null | string;
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

// API Specification Upload Dialog
function ApiSpecUploadDialog({
  existingVersions,
  initialVersion,
  isLoading,
  onOpenChange,
  onUpload,
  open,
  project: _project,
}: {
  existingVersions: Array<string>;
  initialVersion?: null | string;
  isLoading: boolean;
  onOpenChange: (open: boolean) => void;
  onUpload: (files: Array<File>, versionLabel: string, isUpdate: boolean) => void;
  open: boolean;
  project: ProjectData;
}) {
  const [selectedFiles, setSelectedFiles] = React.useState<Array<File>>([]);
  const [versionLabel, setVersionLabel] = React.useState("");
  const [isUpdate, setIsUpdate] = React.useState(!!initialVersion);
  const [selectedExistingVersion, setSelectedExistingVersion] = React.useState(initialVersion ?? "");

  // Handle reset when dialog opens/closes
  const prevOpen = React.useRef(open);
  const prevInitialVersion = React.useRef(initialVersion);

  if (open !== prevOpen.current || initialVersion !== prevInitialVersion.current) {
    if (open) {
      if (initialVersion) {
        setIsUpdate(true);
        setSelectedExistingVersion(initialVersion);
      } else if (prevInitialVersion.current !== initialVersion) {
        setIsUpdate(false);
        setSelectedExistingVersion("");
      }
    } else {
      // Reset when closing
      setSelectedFiles([]);
      setVersionLabel("");
      setIsUpdate(!!initialVersion);
      setSelectedExistingVersion(initialVersion ?? "");
    }
    prevOpen.current = open;
    prevInitialVersion.current = initialVersion;
  }

  const handleFileSelect = (files: Array<File>) => {
    setSelectedFiles(files);
  };

  const handleUpload = () => {
    if (selectedFiles.length === 0) {
      toast.error("Please select at least one file to upload");
      return;
    }

    const finalVersionLabel = isUpdate ? selectedExistingVersion : versionLabel;
    if (!finalVersionLabel.trim()) {
      toast.error("Please provide a version label");
      return;
    }

    onUpload(selectedFiles, finalVersionLabel.trim(), isUpdate);
  };

  const canUpload = selectedFiles.length > 0 && (isUpdate ? selectedExistingVersion : versionLabel.trim());

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Upload API Specification
          </DialogTitle>
          <DialogDescription>
            Upload OpenAPI specification files to create a new version or update an existing one.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Upload Mode Selection */}
          <div className="space-y-4">
            <Label className="text-base font-medium">Upload Mode</Label>
            <div className="grid grid-cols-2 gap-4">
              <Card
                className={`cursor-pointer border-2 transition-all ${
                  !isUpdate ? "border-blue-500 bg-blue-50 dark:bg-blue-950/20" : "border-gray-200 hover:border-gray-300"
                }`}
                onClick={() => setIsUpdate(false)}
              >
                <CardContent className="p-4">
                  <div className="flex items-center space-x-3">
                    <div className={`rounded-full p-1 ${!isUpdate ? "bg-blue-500" : "bg-gray-300"}`}>
                      <Plus className={`h-4 w-4 ${!isUpdate ? "text-white" : "text-gray-600"}`} />
                    </div>
                    <div>
                      <h3 className="font-medium">New Version</h3>
                      <p className="text-sm text-gray-600">Create a new API version</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card
                className={`cursor-pointer border-2 transition-all ${
                  isUpdate ? "border-blue-500 bg-blue-50 dark:bg-blue-950/20" : "border-gray-200 hover:border-gray-300"
                } ${existingVersions.length === 0 ? "cursor-not-allowed opacity-50" : ""}`}
                onClick={() => existingVersions.length > 0 && setIsUpdate(true)}
              >
                <CardContent className="p-4">
                  <div className="flex items-center space-x-3">
                    <div className={`rounded-full p-1 ${isUpdate ? "bg-blue-500" : "bg-gray-300"}`}>
                      <Edit3 className={`h-4 w-4 ${isUpdate ? "text-white" : "text-gray-600"}`} />
                    </div>
                    <div>
                      <h3 className="font-medium">Update Existing</h3>
                      <p className="text-sm text-gray-600">Update an existing version</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Version Input */}
          <div className="space-y-2">
            {isUpdate ? (
              <>
                <Label htmlFor="existing-version">Select Version to Update</Label>
                <Select onValueChange={setSelectedExistingVersion} value={selectedExistingVersion}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a version to update" />
                  </SelectTrigger>
                  <SelectContent>
                    {existingVersions.map((version) => (
                      <SelectItem key={version} value={version}>
                        v{version}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            ) : (
              <>
                <Label htmlFor="version-label">New Version Label</Label>
                <Input
                  id="version-label"
                  onChange={(e) => setVersionLabel(e.target.value)}
                  placeholder="e.g., 1.0.0, 2.1.0, v3-beta"
                  value={versionLabel}
                />
                <p className="text-xs text-gray-500">Use semantic versioning (e.g., 1.0.0) or any meaningful label</p>
              </>
            )}
          </div>

          {/* File Upload */}
          <div className="space-y-2">
            <Label>API Specification Files</Label>
            <FileUpload
              accept=".json,.yaml,.yml"
              maxSize={10}
              multiple={true}
              onFileSelect={handleFileSelect}
              placeholder="Upload your OpenAPI specification files"
            />
          </div>
        </div>

        <DialogFooter>
          <Button disabled={isLoading} onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button
            className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700"
            disabled={!canUpload || isLoading}
            onClick={handleUpload}
          >
            {isLoading ? (
              <>
                <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Uploading...
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" />
                {isUpdate ? "Update Version" : "Create Version"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Documentation Section with Split View
function DocumentationSection({ project }: { project: ProjectData }) {
  const [documentation, setDocumentation] = React.useState(
    typeof project.metadata.documentation === "string" ? project.metadata.documentation : "",
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
    <div className="grid h-[600px] grid-cols-1 gap-6 lg:grid-cols-2">
      {/* Editor */}
      <Card className="flex flex-col">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Edit3 className="h-5 w-5" />
            Editor
          </CardTitle>
          <CardDescription>Write your documentation in Markdown format</CardDescription>
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
          <CardDescription>Live preview of your documentation</CardDescription>
        </CardHeader>
        <CardContent className="flex-1">
          <div className="bg-muted/20 h-full overflow-auto rounded-lg border p-4">
            {documentation ? (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                {documentation.split("\n").map((line, index) => {
                  const key = `line-${index}-${line.slice(0, 10)}`;
                  if (line.startsWith("# ")) {
                    return (
                      <h1 className="mt-6 mb-4 text-2xl font-bold" key={key}>
                        {line.slice(2)}
                      </h1>
                    );
                  }
                  if (line.startsWith("## ")) {
                    return (
                      <h2 className="mt-5 mb-3 text-xl font-semibold" key={key}>
                        {line.slice(3)}
                      </h2>
                    );
                  }
                  if (line.startsWith("### ")) {
                    return (
                      <h3 className="mt-4 mb-2 text-lg font-medium" key={key}>
                        {line.slice(4)}
                      </h3>
                    );
                  }
                  if (line.startsWith("**") && line.endsWith("**")) {
                    return (
                      <p className="font-bold" key={key}>
                        {line.slice(2, -2)}
                      </p>
                    );
                  }
                  if (line.startsWith("*") && line.endsWith("*")) {
                    return (
                      <p className="italic" key={key}>
                        {line.slice(1, -1)}
                      </p>
                    );
                  }
                  if (line.trim() === "") {
                    return <br key={key} />;
                  }
                  return (
                    <p className="mb-2" key={key}>
                      {line}
                    </p>
                  );
                })}
              </div>
            ) : (
              <div className="text-muted-foreground flex h-full items-center justify-center">
                <div className="text-center">
                  <Book className="mx-auto mb-4 h-12 w-12 opacity-50" />
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
        <Label className="text-muted-foreground text-sm font-medium">{label}</Label>
        <div
          className={`border-muted-foreground/30 hover:border-muted-foreground/50 hover:bg-muted/50 mt-1 flex items-center gap-2 rounded-md border border-dashed p-3 transition-all ${type === "textarea" ? "min-h-[80px] items-start" : ""}`}
        >
          <span className="flex-1 text-sm">
            {value || <span className="text-muted-foreground italic">{placeholder ?? "Click to edit"}</span>}
          </span>
          <Edit3 className="text-muted-foreground/60 group-hover:text-muted-foreground h-4 w-4 transition-colors" />
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
        <Textarea onChange={(e) => setEditValue(e.target.value)} placeholder={placeholder} value={editValue} />
      ) : (
        <Input onChange={(e) => setEditValue(e.target.value)} placeholder={placeholder} value={editValue} />
      )}
      <div className="flex gap-2">
        <Button disabled={isLoading} onClick={handleSave} size="sm">
          <Save className="mr-2 h-4 w-4" />
          {isLoading ? "Saving..." : "Save"}
        </Button>
        <Button disabled={isLoading} onClick={handleCancel} size="sm" variant="outline">
          <X className="mr-2 h-4 w-4" />
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ProjectHeader({
  onVersionChange,
  onVisibilityChange,
  project,
  selectedVersion,
}: {
  onVersionChange: (version: string) => void;
  onVisibilityChange: () => void;
  project: ProjectData;
  selectedVersion?: string;
}) {
  const [isCopied, copyToClipboard] = useCopy();
  const [uploadDialogOpen, setUploadDialogOpen] = React.useState(false);
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();

  // First fetch to get available versions (this will be cached)
  const { data: allSpecsData } = useQuery({
    queryFn: () => trpcClient.apiSpec.getByProject.query({ projectId: project.id }),
    queryKey: ["apiSpecs", project.id],
    select: (data) => ({
      // Only extract version information for efficiency
      versions: Array.from(new Set(data.specs.map((spec) => spec.versionLabel))).sort((a, b) => b.localeCompare(a)),
    }),
  });

  const uniqueVersions = React.useMemo(() => allSpecsData?.versions ?? [], [allSpecsData?.versions]);

  // Set default version to the latest if none selected
  React.useEffect(() => {
    if (!selectedVersion && uniqueVersions.length > 0) {
      onVersionChange(uniqueVersions[0]);
    }
  }, [uniqueVersions, selectedVersion, onVersionChange]);

  // Upload mutation for API specifications
  const uploadSpecMutation = useMutation({
    mutationFn: async ({
      files,
      isUpdate,
      versionLabel,
    }: {
      files: Array<File>;
      isUpdate?: boolean;
      versionLabel: string;
    }) => {
      // Convert File objects to the format expected by the API
      const fileData = await Promise.all(
        files.map(async (file) => ({
          content: await file.text(),
          name: file.name,
          size: file.size,
          type: file.type,
        })),
      );

      return trpcClient.apiSpec.uploadFiles.mutate({
        files: fileData,
        isUpdate: isUpdate ?? false,
        projectId: project.id,
        versionLabel,
      });
    },
    onError: (error) => {
      console.error("Failed to upload specification:", error);
      toast.error("Failed to upload API specification again ding ding");
    },
    onSuccess: (data) => {
      toast.success(data.message);
      setUploadDialogOpen(false);
      // Invalidate queries to refresh data
      void queryClient.invalidateQueries({ queryKey: ["apiSpecs", project.id] });
      void queryClient.invalidateQueries({ queryKey: ["project", project.slug] });
    },
  });

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
      <nav className="text-muted-foreground flex items-center space-x-2 text-sm">
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
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 text-lg font-semibold text-white">
              {project.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1">
              <div className="flex items-end space-x-4">
                <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
                <div className="flex items-end space-x-2">
                  <EasyTooltip label="Click to change visibility">
                    <Badge
                      className={`${getVisibilityColor(project.visibility)} cursor-pointer border-0 transition-opacity hover:opacity-80`}
                      onClick={onVisibilityChange}
                      variant="secondary"
                    >
                      {getVisibilityIcon(project.visibility)}
                      <span className="ml-1 capitalize">{project.visibility}</span>
                      <Edit3 className="ml-1 h-3 w-3 opacity-60" />
                    </Badge>
                  </EasyTooltip>
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
                      <Copy className="mr-1 h-3 w-3" />
                      {project.slug}
                    </Button>
                  </EasyTooltip>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          {/* Upload New Version Button */}
          <Button
            className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700"
            onClick={() => setUploadDialogOpen(true)}
            size="sm"
          >
            <Upload className="mr-2 h-4 w-4" />
            Upload Spec
          </Button>

          {/* Current Version Info */}
          {uniqueVersions.length > 0 && selectedVersion && (
            <Badge className="border-blue-200 bg-blue-50 text-blue-700" variant="outline">
              Current: v{selectedVersion}
            </Badge>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onVisibilityChange}>
                <Shield className="mr-2 h-4 w-4" />
                Change Visibility
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem>
                <Users className="mr-2 h-4 w-4" />
                Manage Access
              </DropdownMenuItem>
              <DropdownMenuItem>
                <ExternalLink className="mr-2 h-4 w-4" />
                View API Docs
              </DropdownMenuItem>
              <DropdownMenuItem>
                <FileText className="mr-2 h-4 w-4" />
                Export Project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Upload Dialog */}
          <ApiSpecUploadDialog
            existingVersions={uniqueVersions}
            isLoading={uploadSpecMutation.isPending}
            onOpenChange={setUploadDialogOpen}
            onUpload={(files, versionLabel, isUpdate) => {
              uploadSpecMutation.mutate({ files, isUpdate, versionLabel });
            }}
            open={uploadDialogOpen}
            project={project}
          />
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
      projectCategoryId?: null | string;
      status?: "active" | "archived" | "beta" | "deprecated" | "inactive";
      visibility?: "internal" | "private" | "public";
    },
    { previousProject: unknown }
  >({
    mutationFn: (data: {
      description?: string;
      name?: string;
      projectCategoryId?: null | string;
      status?: "active" | "archived" | "beta" | "deprecated" | "inactive";
      visibility?: "internal" | "private" | "public";
    }) =>
      trpcClient.project.update.mutate({
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

  const handleUpdateCategory = (categoryId: null | string) => {
    updateProjectMutation.mutate({ projectCategoryId: categoryId });
  };

  return (
    <div className="space-y-6">
      {/* Editable Project Information */}
      <Card>
        <CardHeader>
          <CardTitle>Project Information</CardTitle>
          <CardDescription>Manage your project's basic information and settings</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {updateProjectMutation.error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20">
              Failed to update project: {updateProjectMutation.error.message}
            </div>
          )}
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            <div>
              <Label className="text-muted-foreground text-sm font-medium">Creator</Label>
              <div className="mt-1 flex items-center gap-2 p-2">
                <Users className="text-muted-foreground h-4 w-4" />
                <span>{project.creatorName}</span>
              </div>
            </div>

            <div>
              <Label className="text-muted-foreground text-sm font-medium">Created</Label>
              <div className="mt-1 flex items-center gap-2 p-2">
                <Calendar className="text-muted-foreground h-4 w-4" />
                <span>{new Date(project.createdAt).toLocaleDateString()}</span>
              </div>
            </div>

            <div>
              <Label className="text-muted-foreground text-sm font-medium">Last Updated</Label>
              <div className="mt-1 flex items-center gap-2 p-2">
                <Calendar className="text-muted-foreground h-4 w-4" />
                <span>{new Date(project.updatedAt).toLocaleDateString()}</span>
              </div>
            </div>

            <div>
              <Label className="text-muted-foreground text-sm font-medium">Organization</Label>
              <div className="mt-1 flex items-center gap-2 p-2">
                <Building2 className="text-muted-foreground h-4 w-4" />
                <span>{project.organizationName}</span>
              </div>
            </div>
            <div className="col-span-1 md:col-span-2 lg:col-span-2">
              <EditableCategoryField
                isLoading={updateProjectMutation.isPending}
                onSave={handleUpdateCategory}
                value={{
                  categoryId: project.categoryId,
                  categoryName: project.categoryName,
                }}
              />
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
          className="hover:bg-muted/50 min-h-[200px] cursor-pointer rounded-lg border p-4 transition-colors"
          onClick={() => setIsEditing(true)}
        >
          {value ? (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              {value.split("\n").map((line) => (
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
              <Save className="mr-2 h-4 w-4" />
              Save
            </Button>
            <Button onClick={handleCancel} size="sm" variant="outline">
              <X className="mr-2 h-4 w-4" />
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
  const matches = useMatches();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();
  const [visibilityDialogOpen, setVisibilityDialogOpen] = React.useState(false);

  // Check if we're on a child route (like /projects/$slug/view/$version)
  const isChildRoute = matches.some((match) => match.routeId === "/projects/$slug/view/$version");

  const {
    data: projectData,
    error: projectError,
    isLoading: projectLoading,
  } = useQuery({
    queryFn: () => trpcClient.project.getBySlug.query({ slug }),
    queryKey: ["project", slug],
  });

  const handleVersionChange = React.useCallback((_version: string) => {
    // No longer needed since we removed version selection
  }, []);

  // Visibility change mutation
  const updateVisibilityMutation = useMutation<unknown, Error, { visibility: string }, { previousProject: unknown }>({
    mutationFn: (data: { visibility: string }) => {
      if (!projectData?.project) {
        throw new Error("Project not found");
      }
      return trpcClient.project.update.mutate({
        projectId: projectData.project.id,
        visibility: data.visibility as "internal" | "private" | "public",
      });
    },
    onError: (error, _variables, context) => {
      console.error("Failed to update visibility:", error);
      toast.error("Failed to update visibility");
      // Revert optimistic update on error
      if (context?.previousProject) {
        queryClient.setQueryData(["project", slug], context.previousProject);
      }
    },
    onMutate: async (variables) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ["project", slug] });

      // Snapshot the previous value
      const previousProject = queryClient.getQueryData(["project", slug]);

      // Optimistically update the cache
      queryClient.setQueryData(["project", slug], (old: { project: ProjectData } | undefined) => {
        if (!old) return old;
        return {
          ...old,
          project: {
            ...old.project,
            updatedAt: new Date(),
            visibility: variables.visibility as "internal" | "private" | "public",
          },
        };
      });

      return { previousProject };
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["project", slug] });
    },
    onSuccess: () => {
      toast.success("Project visibility updated successfully");
      setVisibilityDialogOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["project", slug] });
    },
  });

  const handleVisibilityChange = (visibility: string) => {
    updateVisibilityMutation.mutate({ visibility });
  };

  if (projectLoading) {
    return <AuthLoadingFallback />;
  }

  if (projectError || !projectData?.project) {
    return (
      <div className="flex min-h-[400px] flex-col items-center justify-center text-center">
        <AlertCircle className="text-muted-foreground mb-4 h-12 w-12" />
        <h2 className="mb-2 text-xl font-semibold">Project Not Found</h2>
        <p className="text-muted-foreground mb-4">
          The project you're looking for doesn't exist or you don't have access to it.
        </p>
        <Link to="/projects">
          <Button>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Projects
          </Button>
        </Link>
      </div>
    );
  }

  const project = projectData.project;

  // If we're on a child route, render the Outlet instead of the main project content
  if (isChildRoute) {
    return <Outlet />;
  }

  return (
    <m.div
      animate={{ opacity: 1, y: 0 }}
      className="container mx-auto space-y-8 px-4 py-6"
      initial={{ opacity: 0, y: 20 }}
      transition={{ duration: 0.3 }}
    >
      <ProjectHeader
        onVersionChange={handleVersionChange}
        onVisibilityChange={() => setVisibilityDialogOpen(true)}
        project={project}
        selectedVersion={undefined}
      />

      <VisibilityChangeDialog
        currentVisibility={project.visibility}
        isLoading={updateVisibilityMutation.isPending}
        onOpenChange={setVisibilityDialogOpen}
        onSave={handleVisibilityChange}
        open={visibilityDialogOpen}
      />

      <Tabs className="space-y-6" defaultValue="overview">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="documentation">Documentation</TabsTrigger>
          <TabsTrigger value="versions">API Versions</TabsTrigger>
          <TabsTrigger value="team">Team</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <ProjectOverview project={project} />
        </TabsContent>

        <TabsContent value="documentation">
          <DocumentationSection project={project} />
        </TabsContent>

        <TabsContent value="versions">
          <VersionManagement project={project} />
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

  const { data: membersData, isLoading: membersLoading } = useQuery({
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
            <CardDescription>Manage team members and their access to this project</CardDescription>
          </div>
          <Button size="sm">
            <Plus className="mr-2 h-4 w-4" />
            Invite Member
          </Button>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {Array.from({ length: 3 }).map((_) => (
              <div className="flex items-center space-x-4" key={crypto.randomUUID()}>
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="flex-1 space-y-2">
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
          <CardDescription>Manage team members and their access to this project</CardDescription>
        </div>
        <Button size="sm">
          <Plus className="mr-2 h-4 w-4" />
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
                        {member.userName
                          .split(" ")
                          .map((n: string) => n[0])
                          .join("")}
                      </AvatarFallback>
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
                <TableCell>{new Date(member.joinedAt).toLocaleDateString()}</TableCell>
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
                        <Trash2 className="mr-2 h-4 w-4" />
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

// Version Management Section - replaces ApiSpecsSection for better version handling
function VersionManagement({ project }: { project: ProjectData }) {
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();
  const [uploadDialogOpen, setUploadDialogOpen] = React.useState(false);
  const [selectedVersionForEdit, setSelectedVersionForEdit] = React.useState<null | string>(null);

  // Fetch all API specs grouped by version
  const {
    data: specsData,
    error,
    isLoading,
  } = useQuery({
    queryFn: () => trpcClient.apiSpec.getByProject.query({ projectId: project.id }),
    queryKey: ["apiSpecs", project.id],
  });

  // Group specs by version and sort
  const versionGroups = React.useMemo(() => {
    const specs = specsData?.specs ?? [];
    const groups = new Map<string, Array<(typeof specs)[0]>>();

    specs.forEach((spec) => {
      const version = spec.versionLabel;
      if (!groups.has(version)) {
        groups.set(version, []);
      }
      const arr = groups.get(version);
      if (arr) arr.push(spec);
    });

    // Convert to array and sort by version (newest first)
    return Array.from(groups.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([version, versionSpecs]) => ({
        lastUpdated: new Date(Math.max(...versionSpecs.map((spec) => spec.updatedAt.getTime()))),
        specs: versionSpecs.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
        totalEndpoints: versionSpecs.reduce((sum, spec) => sum + spec.endpointCount, 0),
        version,
      }));
  }, [specsData?.specs]);

  // Upload mutation
  const uploadSpecMutation = useMutation({
    mutationFn: async ({
      files,
      isUpdate,
      versionLabel,
    }: {
      files: Array<File>;
      isUpdate?: boolean;
      versionLabel: string;
    }) => {
      // Convert File objects to the format expected by the API
      const fileData = await Promise.all(
        files.map(async (file) => ({
          content: await file.text(),
          name: file.name,
          size: file.size,
          type: file.type,
        })),
      );

      return trpcClient.apiSpec.uploadFiles.mutate({
        files: fileData,
        isUpdate: isUpdate ?? false,
        projectId: project.id,
        versionLabel,
      });
    },
    onError: (error) => {
      console.error("Failed to upload specification:", error);
      toast.error("Failed to upload API specification");
    },
    onSuccess: (data) => {
      toast.success(data.message);
      setUploadDialogOpen(false);
      setSelectedVersionForEdit(null);
      void queryClient.invalidateQueries({ queryKey: ["apiSpecs", project.id] });
    },
  });

  // Download function for API specifications
  const handleDownload = async (spec: { format: "json" | "yaml"; id: string; title: null | string }) => {
    try {
      const response = await trpcClient.apiSpec.getById.query({ specId: spec.id });
      // The server returns the raw uploaded content as `originalRaw` and parsed JSON as `specJson`.
      // Use `originalRaw` when available, otherwise fallback to serializing `specJson`.
      const content = response.spec.originalRaw ?? JSON.stringify(response.spec.specJson, null, 2);
      if (!content) {
        toast.error("No content found for this API specification");
        return;
      }
      const blob = new Blob([content], { type: `application/${spec.format}` });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${spec.title ?? "api-spec"}.${spec.format}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      toast.success("API specification downloaded successfully");
    } catch (error) {
      console.error("Download failed:", error);
      toast.error("Failed to download API specification");
    }
  };

  const handleEditVersion = (version: string) => {
    setSelectedVersionForEdit(version);
    setUploadDialogOpen(true);
  };

  const existingVersions = versionGroups.map((group) => group.version);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>API Versions</CardTitle>
          <CardDescription>Manage your API specification versions</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {Array.from({ length: 3 }).map(() => (
              <div className="animate-pulse" key={crypto.randomUUID()}>
                <div className="flex items-center justify-between rounded-lg border p-4">
                  <div className="space-y-2">
                    <div className="h-4 w-20 rounded bg-gray-200" />
                    <div className="h-3 w-32 rounded bg-gray-200" />
                  </div>
                  <div className="h-8 w-20 rounded bg-gray-200" />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>API Versions</CardTitle>
          <CardDescription>Manage your API specification versions</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <AlertCircle className="mb-4 h-12 w-12 text-red-500" />
            <h3 className="mb-2 text-lg font-medium">Failed to load versions</h3>
            <p className="mb-4 text-gray-600">There was an error loading your API specifications.</p>
            <Button onClick={() => window.location.reload()} variant="outline">
              Try Again
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>API Versions</CardTitle>
              <CardDescription>Manage your API specification versions</CardDescription>
            </div>
            <Button
              className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700"
              onClick={() => {
                setSelectedVersionForEdit(null);
                setUploadDialogOpen(true);
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              New Version
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {versionGroups.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Code2 className="mb-4 h-12 w-12 text-gray-400" />
              <h3 className="mb-2 text-lg font-medium">No API versions yet</h3>
              <p className="mb-4 text-gray-600">Upload your first OpenAPI specification to get started.</p>
              <Button
                className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700"
                onClick={() => setUploadDialogOpen(true)}
              >
                <Upload className="mr-2 h-4 w-4" />
                Upload First Spec
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {versionGroups.map((group) => (
                <Link
                  key={group.version}
                  params={{ slug: project.slug, version: group.version }}
                  to="/projects/$slug/view/$version"
                >
                  <Card className="group cursor-pointer border border-gray-200 transition-all hover:border-blue-300 hover:shadow-md">
                    <CardContent className="p-6">
                      <div className="flex items-center justify-between">
                        <div className="flex-1">
                          <div className="mb-2 flex items-center space-x-3">
                            <h3 className="text-lg font-semibold transition-colors group-hover:text-blue-600">
                              v{group.version}
                            </h3>
                            <Badge className="bg-blue-100 text-blue-800">
                              {group.specs.length} spec{group.specs.length !== 1 ? "s" : ""}
                            </Badge>
                            <Badge className="bg-green-100 text-green-800">
                              {group.totalEndpoints} endpoint{group.totalEndpoints !== 1 ? "s" : ""}
                            </Badge>
                            <Badge className="bg-purple-100 text-purple-800 opacity-0 transition-opacity group-hover:opacity-100">
                              <Eye className="mr-1 h-3 w-3" />
                              View
                            </Badge>
                          </div>
                          <p className="text-sm text-gray-600">
                            Last updated {group.lastUpdated.toLocaleDateString()} at{" "}
                            {group.lastUpdated.toLocaleTimeString()}
                          </p>

                          {/* Spec Files List */}
                          <div className="mt-4 space-y-2">
                            {group.specs.map((spec) => (
                              <div
                                className="flex items-center justify-between rounded-md border border-gray-100 bg-gray-50 p-3"
                                key={spec.id}
                              >
                                <div className="flex items-center space-x-3">
                                  <FileText className="h-4 w-4 text-blue-500" />
                                  <div>
                                    <p className="text-sm font-medium">
                                      {spec.title ?? `API Spec ${spec.id.slice(0, 8)}`}
                                    </p>
                                    <p className="text-xs text-gray-500">
                                      {spec.format.toUpperCase()} • {spec.endpointCount} endpoints
                                    </p>
                                  </div>
                                </div>
                                <Button
                                  onClick={(e) => {
                                    e.stopPropagation(); // Prevent card click when downloading
                                    void handleDownload(spec);
                                  }}
                                  size="sm"
                                  variant="ghost"
                                >
                                  <Download className="h-4 w-4" />
                                </Button>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="ml-6 flex items-center space-x-2">
                          <Button
                            onClick={(e) => {
                              e.stopPropagation(); // Prevent card click when updating
                              handleEditVersion(group.version);
                            }}
                            size="sm"
                            variant="outline"
                          >
                            <Edit3 className="mr-2 h-4 w-4" />
                            Update
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Upload Dialog */}
      <ApiSpecUploadDialog
        existingVersions={existingVersions}
        initialVersion={selectedVersionForEdit}
        isLoading={uploadSpecMutation.isPending}
        onOpenChange={(open) => {
          setUploadDialogOpen(open);
          if (!open) setSelectedVersionForEdit(null);
        }}
        onUpload={(files, versionLabel, isUpdate) => {
          uploadSpecMutation.mutate({ files, isUpdate, versionLabel });
        }}
        open={uploadDialogOpen}
        project={project}
      />
    </>
  );
}

// Visibility Change Dialog Component
function VisibilityChangeDialog({
  currentVisibility,
  isLoading = false,
  onOpenChange,
  onSave,
  open,
}: {
  currentVisibility: string;
  isLoading?: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (visibility: string) => void;
  open: boolean;
}) {
  const [selectedVisibility, setSelectedVisibility] = React.useState(currentVisibility);

  // Reset selection when dialog opens with new current visibility
  const previousCurrentVisibility = React.useRef(currentVisibility);
  if (previousCurrentVisibility.current !== currentVisibility && open) {
    setSelectedVisibility(currentVisibility);
    previousCurrentVisibility.current = currentVisibility;
  }

  const visibilityOptions = [
    {
      bgColor: "bg-gray-50 dark:bg-gray-900/20",
      color: "text-gray-600",
      description: "Only project members can view and access this project",
      features: ["Team members only", "Secure access", "Internal collaboration"],
      icon: <Lock className="h-5 w-5" />,
      label: "Private",
      value: "private",
    },
    {
      bgColor: "bg-blue-50 dark:bg-blue-900/20",
      color: "text-blue-600",
      description: "All organization members can discover and view this project",
      features: ["Organization wide", "Internal discovery", "Company collaboration"],
      icon: <Building2 className="h-5 w-5" />,
      label: "Internal",
      value: "internal",
    },
    {
      bgColor: "bg-green-50 dark:bg-green-900/20",
      color: "text-green-600",
      description: "Anyone can view this project and its documentation",
      features: ["Public documentation", "Open collaboration", "Community access"],
      icon: <Globe className="h-5 w-5" />,
      label: "Public",
      value: "public",
    },
  ];

  const getVisibilityChangeWarning = (from: string, to: string): string => {
    if (from === "private" && to === "public") {
      return "Making this project public will allow anyone to view its documentation and API specifications.";
    }
    if (from === "public" && to === "private") {
      return "Making this project private will restrict access to team members only. Public documentation will no longer be accessible.";
    }
    if (to === "internal") {
      return "Internal visibility allows all organization members to discover and view this project.";
    }
    return "This change will affect who can view and access this project.";
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Change Project Visibility
          </DialogTitle>
          <DialogDescription>
            Choose who can view and access this project. This affects documentation visibility and collaboration
            settings.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {visibilityOptions.map((option) => (
            <div
              className={`relative cursor-pointer rounded-lg border-2 p-4 transition-all ${
                selectedVisibility === option.value
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50 hover:bg-muted/50"
              } `}
              key={option.value}
              onClick={() => setSelectedVisibility(option.value)}
            >
              <div className="flex items-start gap-4">
                <div className={`rounded-lg p-2 ${option.bgColor}`}>
                  <div className={option.color}>{option.icon}</div>
                </div>
                <div className="flex-1">
                  <div className="mb-2 flex items-center gap-2">
                    <h3 className="font-semibold">{option.label}</h3>
                    {selectedVisibility === option.value && (
                      <Badge className="text-xs" variant="default">
                        Selected
                      </Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground mb-3 text-sm">{option.description}</p>
                  <div className="flex flex-wrap gap-2">
                    {option.features.map((feature) => (
                      <Badge className="text-xs" key={feature} variant="outline">
                        {feature}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="flex items-center">
                  <div
                    className={`h-4 w-4 rounded-full border-2 transition-all ${
                      selectedVisibility === option.value ? "border-primary bg-primary" : "border-muted-foreground"
                    } `}
                  >
                    {selectedVisibility === option.value && (
                      <div className="h-full w-full scale-50 rounded-full bg-white" />
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {selectedVisibility !== currentVisibility && (
          <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 dark:border-yellow-800 dark:bg-yellow-900/20">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-5 w-5 text-yellow-600 dark:text-yellow-400" />
              <div>
                <h4 className="font-medium text-yellow-800 dark:text-yellow-200">Visibility Change Impact</h4>
                <p className="mt-1 text-sm text-yellow-700 dark:text-yellow-300">
                  {getVisibilityChangeWarning(currentVisibility, selectedVisibility)}
                </p>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button disabled={isLoading} onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={selectedVisibility === currentVisibility || isLoading}
            onClick={() => onSave(selectedVisibility)}
          >
            {isLoading ? "Updating..." : "Update Visibility"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
