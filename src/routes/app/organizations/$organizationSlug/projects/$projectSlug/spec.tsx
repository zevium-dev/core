import { createId } from "@paralleldrive/cuid2";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, Save, Upload, X } from "lucide-react";
import { useMemo, useState } from "react";
import semver from "semver";
import { toast } from "sonner";
import YAML from "yaml";

import { PageHeaderContent } from "~/components/sidebar";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
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
import { Typography } from "~/components/ui/typography";
import { useTRPC } from "~/lib/trpc";
import { formatDate } from "~/lib/utils";

export const Route = createFileRoute("/app/organizations/$organizationSlug/projects/$projectSlug/spec")({
  component: RouteComponent,
});

interface ProjectVariable {
  name: string;
  value: string;
}

interface Variable extends ProjectVariable {
  clientId: string;
}

const createVariable = (variable?: ProjectVariable): Variable => ({
  clientId: createId(),
  name: variable?.name ?? "",
  value: variable?.value ?? "",
});

const cloneVariables = (vars: Array<ProjectVariable>) => vars.map((variable) => createVariable(variable));

function RouteComponent() {
  const params = Route.useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [specContentOverride, setSpecContentOverride] = useState<null | string>(null);
  const [version, setVersion] = useState("");
  const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false);
  const [variablesState, setVariablesState] = useState<Array<Variable>>([]);

  const draftQuery = useSuspenseQuery(trpc.openapiSchema.getDraft.queryOptions(params));
  const versionsQuery = useSuspenseQuery(trpc.openapiSchema.listVersions.queryOptions(params));
  const projectQuery = useSuspenseQuery(trpc.project.get.queryOptions(params));

  const projectVariables = useMemo(
    () => (projectQuery.data.variables ?? []) as Array<ProjectVariable>,
    [projectQuery.data.variables],
  );

  const projectVariablesWithIds = useMemo(() => cloneVariables(projectVariables), [projectVariables]);

  const variables = variablesState.length > 0 ? variablesState : projectVariablesWithIds;

  const updateVariables = (updater: (current: Array<Variable>) => Array<Variable>) => {
    setVariablesState((previous) => {
      const base = previous.length > 0 ? previous : projectVariablesWithIds;
      return updater(base);
    });
  };

  const latestDraftContent = useMemo(() => {
    const draft = draftQuery.data.draft;
    if (!draft) return "";
    try {
      const jsonObj = JSON.parse(draft);
      return YAML.stringify(jsonObj);
    } catch {
      return draft;
    }
  }, [draftQuery.data.draft]);

  const editorValue = specContentOverride ?? latestDraftContent;

  const saveDraftMutation = useMutation(
    trpc.openapiSchema.saveDraft.mutationOptions({
      onError: (error) => {
        toast.error(error.message);
      },
      onSuccess: async () => {
        toast.success("Draft saved successfully");
        setSpecContentOverride(null);
        await queryClient.invalidateQueries(trpc.openapiSchema.getDraft.queryOptions(params));
      },
    }),
  );

  const handleSaveDraft = () => {
    let jsonContent = "";
    try {
      const parsed = YAML.parse(editorValue) as unknown;
      jsonContent = JSON.stringify(parsed);
    } catch {
      toast.error("Invalid YAML content");
      return;
    }
    saveDraftMutation.mutate({ draft: jsonContent, ...params });
  };

  const publishMutation = useMutation(
    trpc.openapiSchema.publish.mutationOptions({
      onError: (error) => {
        toast.error(error.message);
      },
      onSuccess: async () => {
        toast.success("Version published successfully");
        setIsPublishDialogOpen(false);
        setVersion("");
        setSpecContentOverride(null);
        await Promise.all([
          queryClient.invalidateQueries(trpc.openapiSchema.listVersions.queryOptions(params)),
          queryClient.invalidateQueries(trpc.openapiSchema.getDraft.queryOptions(params)),
        ]);
      },
    }),
  );

  const handlePublish = () => {
    let jsonContent = "";
    try {
      const parsed = YAML.parse(editorValue) as unknown;
      jsonContent = JSON.stringify(parsed);
    } catch {
      toast.error("Invalid YAML content");
      return;
    }
    publishMutation.mutate({ draft: jsonContent, version, ...params });
  };

  const handleViewVersion = (versionId: string) => {
    const versionRecord = versionsQuery.data.find((v) => v.id === versionId);
    if (!versionRecord) return;
    try {
      const jsonObj = JSON.parse(versionRecord.schema);
      setSpecContentOverride(YAML.stringify(jsonObj));
    } catch {
      setSpecContentOverride(versionRecord.schema);
    }
  };

  const handleOpenPublishDialog = () => {
    const latestVersion = versionsQuery.data.at(0)?.version;
    if (latestVersion && semver.valid(latestVersion)) {
      setVersion(semver.inc(latestVersion, "patch") ?? "");
    } else {
      setVersion("0.0.1");
    }
    setIsPublishDialogOpen(true);
  };

  const saveVariablesMutation = useMutation(
    trpc.project.update.mutationOptions({
      onError: (error) => {
        toast.error(error.message);
      },
      onSuccess: async (updatedProject) => {
        toast.success("Variables saved successfully");
        const nextVariables = cloneVariables((updatedProject.variables ?? []) as Array<ProjectVariable>);
        setVariablesState(nextVariables);
        await queryClient.invalidateQueries(trpc.project.get.queryOptions(params));
      },
    }),
  );

  const handleSaveVariables = () => {
    const normalizedVariables = variables
      .map((variable) => ({
        name: variable.name.trim(),
        value: variable.value,
      }))
      .filter((variable) => variable.name.length > 0);

    saveVariablesMutation.mutate({
      description: projectQuery.data.description,
      documentation: projectQuery.data.documentation,
      id: projectQuery.data.id,
      name: projectQuery.data.name,
      organizationSlug: params.organizationSlug,
      status: projectQuery.data.status,
      tagNames: projectQuery.data.project_tags.map((tag) => tag.tagName),
      variables: normalizedVariables,
      visibility: projectQuery.data.visibility,
    });
  };

  const handleAddVariable = () => {
    updateVariables((current) => [...current, createVariable()]);
  };

  const handleRemoveVariable = (clientId: string) => {
    updateVariables((current) => current.filter((variable) => variable.clientId !== clientId));
  };

  const handleVariableNameChange = (clientId: string, newName: string) => {
    updateVariables((current) =>
      current.map((variable) => (variable.clientId === clientId ? { ...variable, name: newName } : variable)),
    );
  };

  const handleVariableValueChange = (clientId: string, newValue: string) => {
    updateVariables((current) =>
      current.map((variable) => (variable.clientId === clientId ? { ...variable, value: newValue } : variable)),
    );
  };

  return (
    <div className="flex h-full flex-col space-y-6 p-6">
      <PageHeaderContent>
        <Typography variant="large">{projectQuery.data.name} &gt; OpenAPI Spec</Typography>
      </PageHeaderContent>

      <div className="grid flex-1 gap-6 md:grid-cols-3">
        <div className="flex flex-col space-y-6 md:col-span-2">
          <Card className="flex flex-1 flex-col">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div className="space-y-1">
                <CardTitle>Spec Editor</CardTitle>
                <CardDescription>
                  Edit your OpenAPI specification (YAML or JSON).
                  {draftQuery.data.updatedAt && (
                    <span className="ml-2">Last saved: {formatDate(draftQuery.data.updatedAt)}</span>
                  )}
                </CardDescription>
              </div>
              <div className="flex gap-2">
                <Button
                  disabled={saveDraftMutation.isPending || !!specContentOverride}
                  onClick={handleSaveDraft}
                  variant="outline"
                >
                  <Save className="mr-2 h-4 w-4" />
                  {saveDraftMutation.isPending ? "Saving..." : "Save Draft"}
                </Button>
                <Dialog onOpenChange={setIsPublishDialogOpen} open={isPublishDialogOpen}>
                  <DialogTrigger asChild>
                    <Button onClick={handleOpenPublishDialog}>
                      <Upload className="mr-2 h-4 w-4" />
                      Publish
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Publish Version</DialogTitle>
                      <DialogDescription>Create a new immutable version of your API specification.</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                      <div className="grid grid-cols-4 items-center gap-4">
                        <Label className="text-right" htmlFor="version">
                          Version
                        </Label>
                        <Input
                          className="col-span-3"
                          id="version"
                          onChange={(e) => setVersion(e.target.value)}
                          placeholder="e.g. 1.0.0"
                          value={version}
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button disabled={publishMutation.isPending || !version} onClick={handlePublish}>
                        {publishMutation.isPending ? "Publishing..." : "Publish"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent className="flex-1 p-0">
              <Textarea
                className="h-full w-full resize-none rounded-none border-0 p-4 font-mono focus-visible:ring-0"
                onChange={(e) => setSpecContentOverride(e.target.value)}
                placeholder="Paste your OpenAPI spec here (YAML or JSON)..."
                spellCheck={false}
                value={editorValue}
              />
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Version History</CardTitle>
              <CardDescription>Previously published versions.</CardDescription>
            </CardHeader>
            <CardContent>
              {versionsQuery.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">No versions published yet.</p>
              ) : (
                <div className="space-y-4">
                  {versionsQuery.data.map((v) => (
                    <div className="flex items-center justify-between border-b pb-2 last:border-0 last:pb-0" key={v.id}>
                      <div>
                        <p className="font-medium">{v.version}</p>
                        <p className="text-xs text-muted-foreground">{formatDate(v.createdAt)}</p>
                      </div>
                      <Button onClick={() => handleViewVersion(v.id)} size="sm" variant="ghost">
                        View
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Variables</CardTitle>
              <CardDescription>Define variables to use in your spec, like {"{{BASE_URL}}"} etc.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {variables.map((variable) => (
                  <div className="flex items-center gap-2" key={variable.clientId}>
                    <Input
                      onChange={(e) => handleVariableNameChange(variable.clientId, e.target.value)}
                      placeholder="Name"
                      value={variable.name}
                    />
                    <Input
                      onChange={(e) => handleVariableValueChange(variable.clientId, e.target.value)}
                      placeholder="Value"
                      value={variable.value}
                    />
                    <Button onClick={() => handleRemoveVariable(variable.clientId)} size="icon" variant="ghost">
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button className="w-full" onClick={handleAddVariable} variant="outline">
                  <Plus className="mr-2 h-4 w-4" /> Add Variable
                </Button>
              </div>
            </CardContent>
            <DialogFooter>
              <Button
                className="m-6 mt-0"
                disabled={saveVariablesMutation.isPending}
                onClick={handleSaveVariables}
                size="sm"
              >
                <Save className="mr-2 h-4 w-4" />
                {saveVariablesMutation.isPending ? "Saving..." : "Save Variables"}
              </Button>
            </DialogFooter>
          </Card>
        </div>
      </div>
    </div>
  );
}
