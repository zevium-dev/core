import { createId } from "@paralleldrive/cuid2";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Download, FileUp, MoreHorizontal, Plus, RefreshCw, Save, Trash2, Wand2, X } from "lucide-react";
import { type ChangeEvent, useMemo, useRef, useState } from "react";
import semver from "semver";
import { toast } from "sonner";

import { OpenApiEditor } from "~/components/api/openapi-editor";
import { PageHeaderContent } from "~/components/sidebar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "~/components/ui/command";
import {
  Dialog,
  DialogClose,
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
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "~/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Typography } from "~/components/ui/typography";
import { useConfirm } from "~/hooks/use-confirm";
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

const prettyJsonIfPossible = (raw: string) => {
  try {
    const jsonObj = JSON.parse(raw);
    return JSON.stringify(jsonObj, null, 2);
  } catch {
    return raw;
  }
};

function RouteComponent() {
  const { organizationSlug, projectSlug } = Route.useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const [editorValue, setEditorValue] = useState("");
  const [version, setVersion] = useState("");
  const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [isInsertTokenOpen, setIsInsertTokenOpen] = useState(false);
  const [isIssuesDialogOpen, setIsIssuesDialogOpen] = useState(false);
  const [previewVersionId, setPreviewVersionId] = useState<null | string>(null);
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

  const variableRowCount = useMemo(
    () => variables.filter((variable) => variable.name.trim().length > 0).length,
    [variables],
  );

  const variableTokens = useMemo(() => {
    const seen = new Set<string>();
    return variables
      .map((variable) => variable.name.trim())
      .filter((name) => {
        if (!name) return false;
        const key = name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.localeCompare(b));
  }, [variables]);

  const updateVariables = (updater: (current: Array<Variable>) => Array<Variable>) => {
    setVariablesState((previous) => {
      const base = previous.length > 0 ? previous : projectVariablesWithIds;
      return updater(base);
    });
  };

  const latestDraftContent = useMemo(() => {
    const draft = draftQuery.data.draft;
    if (!draft) return "";
    return prettyJsonIfPossible(draft);
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
        return validationErrorsToDiagnostics(error.errors, debouncedEditorValue);
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

  const previewVersion = useMemo(() => {
    if (!previewVersionId) return null;
    return versionsQuery.data.find((v) => v.id === previewVersionId) ?? null;
  }, [previewVersionId, versionsQuery.data]);

  const previewVersionContent = useMemo(() => {
    if (!previewVersion) return "";
    return prettyJsonIfPossible(previewVersion.schema);
  }, [previewVersion]);

  const handleLoadVersionIntoEditor = async (versionId: string) => {
    const versionRecord = versionsQuery.data.find((v) => v.id === versionId);
    if (!versionRecord) return;

    if (isDirty) {
      const ok = await confirm({
        cancelText: "Keep editing",
        confirmText: "Load version",
        description: (
          <span>
            Loading version <span className="font-mono">{versionRecord.version}</span> will replace your current editor
            contents.
          </span>
        ),
        destructive: true,
        title: "Overwrite unsaved changes?",
      });
      if (!ok) return;
    }

    setEditorValue(prettyJsonIfPossible(versionRecord.schema));
    setIsDirty(true);
    setPreviewVersionId(null);
    toast.success(`Loaded version ${versionRecord.version} into editor`);
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

  const handleJumpToIssue = (line: number, column: number) => {
    const handle = editorHandleRef.current;
    if (!handle) return;

    const { editor, monaco } = handle;
    const model = editor.getModel();
    if (!model) return;

    const lineNumber = Math.min(Math.max(line, 1), model.getLineCount());
    const columnNumber = Math.min(Math.max(column, 1), model.getLineMaxColumn(lineNumber));
    const position = new monaco.Position(lineNumber, columnNumber);

    editor.setPosition(position);
    editor.revealPositionInCenter(position);
    editor.focus();
  };

  const saveVariablesMutation = useMutation(
    trpc.project.update.mutationOptions({
      onSuccess: async (updatedProject) => {
        toast.success("Variables saved successfully");
        const nextVariables = cloneVariables(updatedProject.variables ?? []);
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
      value: newSecretValue.trim(),
    });
  };

  const handleDeleteSecret = (secretId: string) => {
    deleteSecretMutation.mutate({
      organizationSlug,
      projectSlug,
      secretId,
    });
  };

  const hasValidationIssues = validationErrors.length > 0;
  const secretCount = secretsQuery.data.length;
  const versionCount = versionsQuery.data.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 p-4 sm:p-6">
      <PageHeaderContent>
        <div className="flex w-full items-center justify-between gap-4">
          <Typography variant="large">{projectQuery.data.name} &gt; OpenAPI Spec</Typography>
          <Sheet onOpenChange={setIsConfigOpen} open={isConfigOpen}>
            <SheetTrigger asChild>
              <Button size="sm" variant="outline">
                Project config
              </Button>
            </SheetTrigger>
            <SheetContent className="p-0 sm:max-w-lg">
              <SheetHeader className="border-b">
                <SheetTitle>Project config</SheetTitle>
                <SheetDescription>Variables, secrets, and published versions.</SheetDescription>
              </SheetHeader>
              <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
                <Tabs className="flex min-h-0 flex-1 flex-col" defaultValue="variables">
                  <TabsList className="w-full">
                    <TabsTrigger className="flex-1 justify-center" value="variables">
                      Variables
                      {variableRowCount > 0 && <Badge variant="secondary">{variableRowCount}</Badge>}
                    </TabsTrigger>
                    <TabsTrigger className="flex-1 justify-center" value="secrets">
                      Secrets
                      {secretCount > 0 && <Badge variant="secondary">{secretCount}</Badge>}
                    </TabsTrigger>
                    <TabsTrigger className="flex-1 justify-center" value="history">
                      History
                      {versionCount > 0 && <Badge variant="secondary">{versionCount}</Badge>}
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent className="min-h-0 flex-1" value="variables">
                    <div className="flex min-h-0 flex-col gap-4">
                      <p className="text-sm text-muted-foreground">
                        Use tokens like <span className="font-mono">%BASE_URL%</span> in your spec.
                      </p>
                      <div className="min-h-0 space-y-3 overflow-auto pr-1">
                        {variables.length === 0 ? (
                          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                            No variables yet.
                          </div>
                        ) : (
                          variables.map((variable) => (
                            <div className="space-y-2 rounded-lg border p-3" key={variable.clientId}>
                              <div className="grid gap-2 sm:grid-cols-2">
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
                              <div className="flex justify-end">
                                <Button
                                  onClick={() => handleRemoveVariable(variable.clientId)}
                                  size="sm"
                                  variant="ghost"
                                >
                                  <X className="mr-2 size-4" />
                                  Remove
                                </Button>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                        <Button onClick={handleAddVariable} size="sm" variant="outline">
                          <Plus className="mr-2 size-4" />
                          Add variable
                        </Button>
                        <Button loading={saveVariablesMutation.isPending} onClick={handleSaveVariables} size="sm">
                          <Save className="mr-2 size-4" />
                          {saveVariablesMutation.isPending ? "Saving..." : "Save"}
                        </Button>
                      </div>
                    </div>
                  </TabsContent>

                  <TabsContent className="min-h-0 flex-1" value="secrets">
                    <div className="flex min-h-0 flex-col gap-4">
                      <p className="text-sm text-muted-foreground">
                        Encrypted values are never shown again after saving.
                      </p>
                      <div className="min-h-0 space-y-3 overflow-auto pr-1">
                        {secretCount === 0 ? (
                          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                            No secrets yet.
                          </div>
                        ) : (
                          secretsQuery.data.map((secret) => {
                            const isDeletingThisSecret =
                              deleteSecretMutation.isPending && deleteSecretMutation.variables.secretId === secret.id;

                            return (
                              <div className="flex items-center justify-between rounded-lg border p-3" key={secret.id}>
                                <div className="min-w-0 flex-1">
                                  <p className="truncate font-mono text-sm font-medium">{secret.name}</p>
                                  <p className="text-xs text-muted-foreground">
                                    Updated {formatDate(secret.updatedAt, { smart: true })}
                                  </p>
                                </div>
                                <Button
                                  loading={isDeletingThisSecret}
                                  onClick={() => handleDeleteSecret(secret.id)}
                                  size="icon"
                                  variant="ghost"
                                >
                                  <Trash2 className="size-4 text-destructive" />
                                </Button>
                              </div>
                            );
                          })
                        )}
                      </div>
                      <div className="space-y-2 rounded-lg border p-3">
                        <Input
                          autoComplete="off"
                          maxLength={256}
                          onChange={(e) => setNewSecretName(e.target.value)}
                          placeholder="SECRET_NAME"
                          value={newSecretName}
                        />
                        <Input
                          autoComplete="off"
                          onChange={(e) => setNewSecretValue(e.target.value)}
                          placeholder="Secret value (will be encrypted)"
                          type="password"
                          value={newSecretValue}
                        />
                        <Button
                          className="w-full"
                          disabled={!newSecretName.trim() || !newSecretValue.trim()}
                          loading={createSecretMutation.isPending}
                          onClick={handleSaveSecret}
                        >
                          <Plus className="mr-2 size-4" />
                          {createSecretMutation.isPending ? "Saving..." : "Add secret"}
                        </Button>
                      </div>
                    </div>
                  </TabsContent>

                  <TabsContent className="min-h-0 flex-1" value="history">
                    <div className="flex min-h-0 flex-col gap-4">
                      <p className="text-sm text-muted-foreground">Published versions are immutable snapshots.</p>
                      {versionCount === 0 ? (
                        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                          No versions published yet.
                        </div>
                      ) : (
                        <div className="min-h-0 space-y-2 overflow-auto pr-1">
                          {versionsQuery.data.map((v) => (
                            <div className="flex items-center justify-between rounded-lg border p-3" key={v.id}>
                              <div className="min-w-0 flex-1">
                                <p className="font-medium">{v.version}</p>
                                <p className="text-xs text-muted-foreground">
                                  {formatDate(v.createdAt, { smart: true })}
                                </p>
                              </div>
                              <div className="flex items-center gap-2">
                                <Button onClick={() => setPreviewVersionId(v.id)} size="sm" variant="ghost">
                                  Preview
                                </Button>
                                <Button
                                  onClick={() => {
                                    void handleLoadVersionIntoEditor(v.id);
                                  }}
                                  size="sm"
                                  variant="outline"
                                >
                                  Load
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </TabsContent>
                </Tabs>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </PageHeaderContent>

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-lg font-semibold">Draft spec</CardTitle>
            <CardDescription>
              {draftQuery.data.updatedAt ? (
                <span>Last saved: {formatDate(draftQuery.data.updatedAt, { smart: true })}</span>
              ) : (
                <span>Not saved yet.</span>
              )}
              {isDirty && (
                <span className="ml-2 inline-flex align-middle">
                  <Badge variant="outline">Unsaved changes</Badge>
                </span>
              )}
            </CardDescription>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {variableTokens.length > 0 && (
              <Popover onOpenChange={setIsInsertTokenOpen} open={isInsertTokenOpen}>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="outline">
                    Insert token
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="p-0">
                  <Command>
                    <CommandInput placeholder="Search variables..." />
                    <CommandList>
                      <CommandEmpty>No variables found.</CommandEmpty>
                      <CommandGroup heading="Variables">
                        {variableTokens.map((name) => (
                          <CommandItem
                            key={name}
                            onSelect={() => {
                              handleInsertVariable(name);
                              setIsInsertTokenOpen(false);
                            }}
                            value={name}
                          >
                            <span className="font-mono text-xs">{`%${name}%`}</span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            )}

            {hasValidationIssues && (
              <Button
                className="border-destructive/30 text-destructive"
                onClick={() => setIsIssuesDialogOpen(true)}
                size="sm"
                variant="outline"
              >
                Issues ({validationErrors.length})
              </Button>
            )}

            <Button
              disabled={hasValidationIssues || !isDirty}
              loading={saveDraftMutation.isPending}
              onClick={handleSaveDraft}
              size="sm"
              variant="outline"
            >
              <Save className="mr-2 size-4" />
              {saveDraftMutation.isPending ? "Saving..." : "Save draft"}
            </Button>
            <Button disabled={hasValidationIssues} onClick={handleOpenPublishDialog} size="sm">
              <RefreshCw className="mr-2 size-4" />
              Publish
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button aria-label="More actions" className="px-2" size="sm" variant="outline">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={handleFormat}>
                  <Wand2 className="size-4" />
                  Format
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
                  <FileUp className="size-4" />
                  Upload
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleDownload}>
                  <Download className="size-4" />
                  Download
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setIsConfigOpen(true)}>Project config</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardHeader>

        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          <input
            aria-label="Upload OpenAPI specification file"
            className="hidden"
            onChange={handleFileInputChange}
            ref={fileInputRef}
            type="file"
          />
          <div className="flex min-h-0 flex-1">
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
        </CardContent>
      </Card>

      <Dialog onOpenChange={setIsPublishDialogOpen} open={isPublishDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish version</DialogTitle>
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
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button disabled={!version} loading={publishMutation.isPending} onClick={handlePublish}>
              {publishMutation.isPending ? "Publishing..." : "Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={setIsIssuesDialogOpen} open={isIssuesDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Validation issues</DialogTitle>
            <DialogDescription>Fix these before saving or publishing.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto">
            <ul className="space-y-2 text-sm">
              {validationErrors.map((error, index) => (
                // eslint-disable-next-line @eslint-react/no-array-index-key
                <li className="rounded-lg border p-3" key={`${error.message}-${index}`}>
                  <button
                    className="w-full text-left"
                    onClick={() => {
                      handleJumpToIssue(error.line, error.column);
                      setIsIssuesDialogOpen(false);
                    }}
                    type="button"
                  >
                    <div className="font-medium">{error.message}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Line {error.line}, Column {error.column}
                      {error.path ? ` • ${error.path}` : ""}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Close</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (open) return;
          setPreviewVersionId(null);
        }}
        open={previewVersionId !== null}
      >
        <DialogContent className="sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{previewVersion ? `Version ${previewVersion.version}` : "Version preview"}</DialogTitle>
            <DialogDescription>
              {previewVersion
                ? formatDate(previewVersion.createdAt, { smart: true })
                : "The selected version could not be found."}
            </DialogDescription>
          </DialogHeader>
          <div className="h-[60vh] overflow-hidden rounded-lg border">
            <OpenApiEditor
              language="json"
              onChange={() => {
                // no-op
              }}
              readOnly
              value={previewVersionContent}
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Close</Button>
            </DialogClose>
            <Button
              disabled={!previewVersion}
              onClick={() => {
                if (!previewVersion) return;
                void handleLoadVersionIntoEditor(previewVersion.id);
              }}
              variant="outline"
            >
              Load into editor
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
