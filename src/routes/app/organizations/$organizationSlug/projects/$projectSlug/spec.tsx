import { createId } from "@paralleldrive/cuid2";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Download, FileUp, Key, Plus, RefreshCw, Save, Trash2, Wand2, X } from "lucide-react";
import { type ChangeEvent, useMemo, useRef, useState } from "react";
import semver from "semver";
import { toast } from "sonner";

import { OpenApiEditor } from "~/components/api/openapi-editor";
import { PageHeaderContent } from "~/components/sidebar";
import { Button } from "~/components/ui/button";
import { ButtonGroup, ButtonGroupSeparator } from "~/components/ui/button-group";
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
import { Typography } from "~/components/ui/typography";
import { useDebounce } from "~/hooks/use-debounce";
import {
  OpenApiValidationError,
  validateOpenApiDraft,
  validationErrorsToDiagnostics,
} from "~/lib/client/openapi-validator";
import { useTRPC } from "~/lib/trpc";
import { formatDate } from "~/lib/utils";

export const Route = createFileRoute("/app/organizations/$organizationSlug/projects/$projectSlug/spec")({
  component: RouteComponent,
  loader: ({ context, params }) => {
    const routeParams = { organizationSlug: params.organizationSlug, projectSlug: params.projectSlug };
    void context.queryClient.ensureQueryData(context.trpc.openapiSchema.getDraft.queryOptions(routeParams));
    void context.queryClient.ensureQueryData(context.trpc.openapiSchema.listVersions.queryOptions(routeParams));
    void context.queryClient.ensureQueryData(context.trpc.project.get.queryOptions(routeParams));
    void context.queryClient.ensureQueryData(context.trpc.projectSecret.list.queryOptions(routeParams));
  },
});

interface EditorHandle {
  editor: import("monaco-editor").editor.IStandaloneCodeEditor;
  monaco: typeof import("monaco-editor");
}

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
  const { organizationSlug, projectSlug } = Route.useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [editorValue, setEditorValue] = useState("");
  const [version, setVersion] = useState("");
  const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false);
  const [variablesState, setVariablesState] = useState<Array<Variable>>([]);
  const [isDirty, setIsDirty] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const editorHandleRef = useRef<EditorHandle | null>(null);

  const routeParams = { organizationSlug, projectSlug } as const;

  const draftQuery = useSuspenseQuery(trpc.openapiSchema.getDraft.queryOptions(routeParams));
  const versionsQuery = useSuspenseQuery(trpc.openapiSchema.listVersions.queryOptions(routeParams));
  const projectQuery = useSuspenseQuery(trpc.project.get.queryOptions(routeParams));
  const secretsQuery = useSuspenseQuery(trpc.projectSecret.list.queryOptions(routeParams));

  // Secrets state
  const [newSecretName, setNewSecretName] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");

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
      return JSON.stringify(jsonObj, null, 2);
    } catch {
      return draft;
    }
  }, [draftQuery.data.draft]);

  const currentContent = isDirty ? editorValue : latestDraftContent;
  const debouncedEditorValue = useDebounce(currentContent, 400);

  const validationErrors = useMemo(() => {
    if (!debouncedEditorValue) {
      return [{ column: 1, line: 1, message: "OpenAPI spec cannot be empty.", path: "" }];
    }

    try {
      validateOpenApiDraft(debouncedEditorValue, "draft.json");
      return [];
    } catch (error) {
      if (error instanceof OpenApiValidationError) {
        return validationErrorsToDiagnostics(error.errors);
      }

      return [{ column: 1, line: 1, message: error instanceof Error ? error.message : "Validation failed", path: "" }];
    }
  }, [debouncedEditorValue]);

  const saveDraftMutation = useMutation(
    trpc.openapiSchema.saveDraft.mutationOptions({
      onSuccess: async () => {
        toast.success("Draft saved successfully");
        setIsDirty(false);
        await queryClient.invalidateQueries(trpc.openapiSchema.getDraft.queryOptions(routeParams));
      },
    }),
  );

  const handleSaveDraft = () => {
    try {
      const parsed = validateOpenApiDraft(currentContent, "draft.json");
      const jsonContent = JSON.stringify(parsed.specJson);
      saveDraftMutation.mutate({ draft: jsonContent, organizationSlug, projectSlug });
    } catch (error) {
      if (error instanceof OpenApiValidationError) {
        toast.error(error.errors.at(0)?.message ?? "Invalid OpenAPI spec");
        return;
      }

      toast.error(error instanceof Error ? error.message : "Invalid OpenAPI spec");
    }
  };

  const publishMutation = useMutation(
    trpc.openapiSchema.publish.mutationOptions({
      onSuccess: async () => {
        toast.success("Version published successfully");
        setIsPublishDialogOpen(false);
        setVersion("");
        setIsDirty(false);
        await Promise.all([
          queryClient.invalidateQueries(trpc.openapiSchema.listVersions.queryOptions(routeParams)),
          queryClient.invalidateQueries(trpc.openapiSchema.getDraft.queryOptions(routeParams)),
        ]);
      },
    }),
  );

  const handlePublish = () => {
    try {
      const parsed = validateOpenApiDraft(currentContent, "draft.json");
      const jsonContent = JSON.stringify(parsed.specJson);
      publishMutation.mutate({ draft: jsonContent, organizationSlug, projectSlug, version });
    } catch (error) {
      if (error instanceof OpenApiValidationError) {
        toast.error(error.errors.at(0)?.message ?? "Invalid OpenAPI spec");
        return;
      }

      toast.error(error instanceof Error ? error.message : "Invalid OpenAPI spec");
    }
  };

  const handleViewVersion = (versionId: string) => {
    const versionRecord = versionsQuery.data.find((v) => v.id === versionId);
    if (!versionRecord) return;
    try {
      const jsonObj = JSON.parse(versionRecord.schema);
      setEditorValue(JSON.stringify(jsonObj, null, 2));
    } catch {
      setEditorValue(versionRecord.schema);
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

  const handleFormat = () => {
    try {
      const result = validateOpenApiDraft(currentContent, "draft.json");
      const formatted = JSON.stringify(result.specJson, null, 2);
      setEditorValue(formatted);
      setIsDirty(true);
    } catch (error) {
      if (error instanceof OpenApiValidationError) {
        toast.error(error.errors.at(0)?.message ?? "Format failed");
        return;
      }

      toast.error(error instanceof Error ? error.message : "Format failed");
    }
  };

  const handleImportFile = async (file: File) => {
    const content = await file.text();
    setEditorValue(content);
    setIsDirty(true);
  };

  const handleFileInputChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.item(0);
    if (!file) return;

    // Validate file type and size
    const validExtensions = [".json", ".yaml", ".yml"];
    const extension = file.name.substring(file.name.lastIndexOf(".")).toLowerCase();
    if (!validExtensions.includes(extension)) {
      toast.error("Invalid file type. Please upload a JSON, YAML, or YML file.");
      event.target.value = "";
      return;
    }

    const maxSizeInMB = 5;
    if (file.size > maxSizeInMB * 1024 * 1024) {
      toast.error(`File size exceeds ${maxSizeInMB}MB limit`);
      event.target.value = "";
      return;
    }

    await handleImportFile(file);
    event.target.value = "";
  };

  const handleDownload = () => {
    const blob = new Blob([currentContent], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "openapi-spec.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
  };

  const handleInsertVariable = (variableName: string) => {
    const name = variableName.trim();
    if (!name) return;

    const handle = editorHandleRef.current;
    if (!handle) return;

    const { editor, monaco } = handle;
    const position = editor.getPosition() ?? editor.getModel()?.getPositionAt(0) ?? new monaco.Position(1, 1);
    const selection = editor.getSelection() ?? monaco.Selection.fromPositions(position);

    editor.executeEdits("insert-variable", [
      {
        forceMoveMarkers: true,
        range: selection,
        text: `%${name}%`,
      },
    ]);

    editor.focus();
  };

  const saveVariablesMutation = useMutation(
    trpc.project.update.mutationOptions({
      onSuccess: async (updatedProject) => {
        toast.success("Variables saved successfully");
        const nextVariables = cloneVariables((updatedProject.variables ?? []) as Array<ProjectVariable>);
        setVariablesState(nextVariables);
        await queryClient.invalidateQueries(trpc.project.get.queryOptions(routeParams));
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
      organizationSlug,
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

  // Secrets mutations
  const createSecretMutation = useMutation(
    trpc.projectSecret.createOrUpdateByName.mutationOptions({
      onSuccess: async () => {
        toast.success("Secret saved successfully");
        setNewSecretName("");
        setNewSecretValue("");
        await queryClient.invalidateQueries(trpc.projectSecret.list.queryOptions(routeParams));
      },
    }),
  );

  const deleteSecretMutation = useMutation(
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    trpc.projectSecret.delete.mutationOptions({
      onSuccess: async () => {
        toast.success("Secret deleted");
        await queryClient.invalidateQueries(trpc.projectSecret.list.queryOptions(routeParams));
      },
    }),
  );

  const handleSaveSecret = () => {
    if (!newSecretName.trim() || !newSecretValue.trim()) {
      toast.error("Secret name and value are required");
      return;
    }
    createSecretMutation.mutate({
      name: newSecretName.trim(),
      organizationSlug,
      projectSlug,
      value: newSecretValue,
    });
  };

  const handleDeleteSecret = (secretId: string) => {
    deleteSecretMutation.mutate({
      organizationSlug,
      projectSlug,
      secretId,
    });
  };

  return (
    <div className="flex max-h-[calc(100dvh-4rem)] flex-col space-y-6 p-4 sm:p-6">
      <PageHeaderContent>
        <Typography variant="large">{projectQuery.data.name} &gt; OpenAPI Spec</Typography>
      </PageHeaderContent>

      <div className="grid gap-4 sm:gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-4 sm:gap-6 lg:col-span-2">
          <Card className="flex flex-col">
            <CardHeader className="space-y-4 pb-4">
              <div className="space-y-1">
                <CardTitle className="text-lg font-semibold">Spec Editor</CardTitle>
                <CardDescription>
                  Edit your OpenAPI specification (JSON).
                  {draftQuery.data.updatedAt && (
                    <span className="ml-2">Last saved: {formatDate(draftQuery.data.updatedAt)}</span>
                  )}
                </CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={handleFormat} size="sm" variant="outline">
                  <Wand2 className="mr-2 size-4" />
                  Format
                </Button>
                <Button
                  aria-haspopup="dialog"
                  aria-label="Upload OpenAPI specification file"
                  onClick={() => fileInputRef.current?.click()}
                  size="sm"
                  variant="outline"
                >
                  <FileUp className="mr-2 size-4" />
                  Upload
                </Button>
                <Button onClick={handleDownload} size="sm" variant="outline">
                  <Download className="mr-2 size-4" />
                  Download
                </Button>
                <Button
                  disabled={saveDraftMutation.isPending || validationErrors.length > 0}
                  onClick={handleSaveDraft}
                  size="sm"
                  variant="outline"
                >
                  <Save className="mr-2 size-4" />
                  {saveDraftMutation.isPending ? "Saving..." : "Save Draft"}
                </Button>
                <Dialog onOpenChange={setIsPublishDialogOpen} open={isPublishDialogOpen}>
                  <DialogTrigger asChild>
                    <Button onClick={handleOpenPublishDialog} size="sm">
                      <RefreshCw className="mr-2 size-4" />
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
            <CardContent className="flex flex-1 flex-col p-0">
              <input
                aria-label="Upload OpenAPI specification file"
                className="hidden"
                onChange={handleFileInputChange}
                ref={fileInputRef}
                type="file"
              />
              <div className="min-h-52 flex-1">
                <OpenApiEditor
                  diagnostics={validationErrors}
                  height="100%"
                  language="json"
                  onChange={(value) => {
                    setEditorValue(value);
                    setIsDirty(true);
                  }}
                  onEditorReady={({ editor, monaco }) => {
                    editorHandleRef.current = { editor, monaco };
                  }}
                  value={currentContent}
                />
              </div>
              {variables.length > 0 && (
                <div className="border-t bg-muted/40 px-4 py-2 text-sm">
                  <p className="text-xs text-muted-foreground">Insert variables into your spec:</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {variables.map((variable) => (
                      <Button
                        disabled={!variable.name.trim()}
                        key={`chip-${variable.clientId}`}
                        onClick={() => handleInsertVariable(variable.name)}
                        size="sm"
                        variant="secondary"
                      >
                        {`%${variable.name || "variable"}%`}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              {validationErrors.length > 0 && (
                <div className="border-t bg-muted/40 px-4 py-3 text-sm text-destructive">
                  <p className="font-semibold">Fix validation errors before saving or publishing:</p>
                  <ul className="mt-2 space-y-1">
                    {validationErrors.map((error, index) => (
                      // eslint-disable-next-line @eslint-react/no-array-index-key
                      <li key={`${error.message}-${index}`}>
                        • {error.message}
                        {error.path ? ` (${error.path})` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-4 sm:gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Variables</CardTitle>
              <CardDescription>Define variables to use in your spec, like %BASE_URL% etc.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {variables.map((variable) => (
                  <div
                    className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:border-0 sm:p-0"
                    key={variable.clientId}
                  >
                    <div className="grid flex-1 gap-2 sm:grid-cols-2">
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
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <Button onClick={() => handleRemoveVariable(variable.clientId)} size="icon" variant="ghost">
                        <X className="size-4" />
                      </Button>
                    </div>
                  </div>
                ))}
                <ButtonGroup className="w-full">
                  <Button className="flex-1" onClick={handleAddVariable} variant="outline">
                    <Plus className="mr-2 size-4" /> Add Variable
                  </Button>
                  <ButtonGroupSeparator />
                  <Button className="flex-1" loading={saveVariablesMutation.isPending} onClick={handleSaveVariables}>
                    <Save className="mr-2 size-4" />
                    {saveVariablesMutation.isPending ? "Saving..." : "Save Variables"}
                  </Button>
                </ButtonGroup>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Key className="size-4" />
                Secrets
              </CardTitle>
              <CardDescription>
                Encrypted secrets for sensitive values. Values are never displayed after saving.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {secretsQuery.data.map((secret) => {
                  const isDeletingThisSecret =
                    deleteSecretMutation.isPending && deleteSecretMutation.variables === secret.id;

                  return (
                    <div className="flex items-center justify-between rounded-lg border p-3" key={secret.id}>
                      <div className="flex-1">
                        <p className="font-mono text-sm font-medium">{secret.name}</p>
                        <p className="text-xs text-muted-foreground">Updated {formatDate(secret.updatedAt)}</p>
                      </div>
                      <Button
                        disabled={isDeletingThisSecret}
                        onClick={() => handleDeleteSecret(secret.id)}
                        size="icon"
                        variant="ghost"
                      >
                        {isDeletingThisSecret ? (
                          <RefreshCw className="size-4 animate-spin text-muted-foreground" />
                        ) : (
                          <Trash2 className="size-4 text-destructive" />
                        )}
                      </Button>
                    </div>
                  );
                })}
                {secretsQuery.data.length === 0 && (
                  <p className="text-sm text-muted-foreground">No secrets defined yet.</p>
                )}
                <div className="space-y-2 rounded-lg border p-3">
                  <Input
                    maxLength={256}
                    onChange={(e) => setNewSecretName(e.target.value)}
                    placeholder="SECRET_NAME"
                    value={newSecretName}
                  />
                  <Input
                    maxLength={256}
                    onChange={(e) => setNewSecretValue(e.target.value)}
                    placeholder="Secret value (will be encrypted)"
                    type="password"
                    value={newSecretValue}
                  />
                  <Button
                    className="w-full"
                    disabled={createSecretMutation.isPending || !newSecretName.trim() || !newSecretValue}
                    onClick={handleSaveSecret}
                  >
                    <Plus className="mr-2 size-4" />
                    {createSecretMutation.isPending ? "Saving..." : "Add Secret"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
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
                      <div className="flex-1">
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
        </div>
      </div>
    </div>
  );
}
