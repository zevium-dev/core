import { useQuery } from "@tanstack/react-query";
import { createLazyFileRoute, useNavigate } from "@tanstack/react-router";
import { AlertCircle, ArrowLeft, Code2, Copy, Download } from "lucide-react";
import { m } from "motion/react";
import * as React from "react";

import { ScalarApiReference } from "~/components/api-viewer/scalar-api-reference";
import { AuthLoadingFallback } from "~/components/auth-loading-fallback";
import { ProtectedRoute } from "~/components/protected-route";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Separator } from "~/components/ui/separator";
import { useCopy } from "~/hooks/use-copy";
import { useTRPCClient } from "~/lib/trpc";

export const Route = createLazyFileRoute("/projects/$slug/view/$version")({
  component: () => (
    <ProtectedRoute>
      <RouteComponent />
    </ProtectedRoute>
  ),
});

interface ApiSpec {
  createdAt: Date;
  endpointCount: number;
  endpoints: Array<{
    createdAt: Date;
    deprecated: boolean;
    id: string;
    method: string;
    operationId: null | string;
    path: string;
    security: Array<unknown>;
    summary: null | string;
    tags: Array<string>;
  }>;
  format: "json" | "yaml";
  hash: string;
  id: string;
  originalRaw?: null | string;
  projectId: string;
  projectName?: string;
  specJson?: Record<string, unknown>;
  status: "active" | "archived" | "deprecated";
  title: null | string;
  updatedAt: Date;
  versionLabel: string;
}

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

// API Specification Viewer Header
function ApiViewerHeader({
  project,
  specs,
  version,
}: {
  project: ProjectData;
  specs: Array<ApiSpec>;
  version: string;
}) {
  const navigate = useNavigate();
  const [isCopied, copyToClipboard] = useCopy();

  const totalEndpoints = specs.reduce((sum, spec) => sum + spec.endpointCount, 0);
  const lastUpdated =
    specs.length > 0 ? new Date(Math.max(...specs.map((spec) => spec.updatedAt.getTime()))) : new Date();

  return (
    <div className="border-b bg-gradient-to-r from-slate-50 to-gray-50 dark:from-slate-900 dark:to-gray-900">
      <div className="container mx-auto px-4 py-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <Button
              onClick={() => navigate({ params: { slug: project.slug }, to: "/projects/$slug" })}
              size="sm"
              variant="ghost"
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Project
            </Button>
            <Separator className="h-6" orientation="vertical" />
            <div>
              <h1 className="text-2xl font-bold">{project.name}</h1>
              <div className="flex items-center space-x-2 text-sm text-gray-600">
                <span className="font-medium">API Version: v{version}</span>
                <span>•</span>
                <span>{totalEndpoints} endpoints</span>
                <span>•</span>
                <span>Updated {lastUpdated.toLocaleDateString()}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <Button onClick={() => copyToClipboard(window.location.href)} size="sm" variant="outline">
              <Copy className="mr-2 h-4 w-4" />
              {isCopied ? "Copied!" : "Share"}
            </Button>
            <Button size="sm" variant="outline">
              <Download className="mr-2 h-4 w-4" />
              Export
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Main Route Component
function RouteComponent() {
  const { slug, version } = Route.useParams();
  const trpcClient = useTRPCClient();

  // Fetch project data
  const {
    data: projectData,
    error: projectError,
    isLoading: projectLoading,
  } = useQuery({
    queryFn: () => trpcClient.project.getBySlug.query({ slug }),
    queryKey: ["project", slug],
  });

  // Fetch API specifications for the specific version
  const {
    data: specsData,
    error: specsError,
    isLoading: specsLoading,
  } = useQuery({
    enabled: Boolean(projectData?.project),
    queryFn: () => {
      if (!projectData?.project) {
        throw new Error("Project data is required");
      }
      return trpcClient.apiSpec.getByProjectAndVersion.query({
        projectId: projectData.project.id,
        versionLabel: version,
      });
    },
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    queryKey: ["apiSpecs", projectData?.project?.id, version] as const,
  });

  if (projectLoading || specsLoading) {
    return <AuthLoadingFallback />;
  }

  if (projectError || !projectData?.project) {
    return (
      <div className="container mx-auto px-4 py-12">
        <Card>
          <CardContent className="py-12 text-center">
            <AlertCircle className="mx-auto h-12 w-12 text-red-500" />
            <h3 className="mt-4 text-lg font-medium">Project not found</h3>
            <p className="text-gray-600">
              The project you're looking for doesn't exist or you don't have access to it.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (specsError || !specsData?.specs || specsData.specs.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <ApiViewerHeader project={projectData.project} specs={[]} version={version} />
        <div className="container mx-auto px-4 py-12">
          <Card>
            <CardContent className="py-12 text-center">
              <Code2 className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-4 text-lg font-medium">No API specifications found</h3>
              <p className="text-gray-600">Version v{version} doesn't have any API specifications yet.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const project = projectData.project;
  const specs = specsData.specs;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <ApiViewerHeader project={project} specs={specs} version={version} />

      <div className="container mx-auto px-4 py-8">
        <m.div animate={{ opacity: 1, y: 0 }} initial={{ opacity: 0, y: 20 }} transition={{ duration: 0.3 }}>
          {/* API Specifications with Scalar Viewer */}
          <div className="space-y-8">
            {specs.map((spec) => (
              <div key={spec.id}>
                {/* Scalar API Reference Component */}
                <ScalarApiReference
                  _projectSlug={project.slug}
                  _specTitle={spec.title ?? undefined}
                  specId={spec.id}
                  version={version}
                />
              </div>
            ))}
          </div>
        </m.div>
      </div>
    </div>
  );
}
