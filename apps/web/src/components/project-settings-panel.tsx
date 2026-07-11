import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, Copy, Eye, EyeOff, Webhook } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "#/components/ui/dialog";
import { Switch } from "#/components/ui/switch";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { api } from "#/lib/convex-api";
import type { Doc } from "#/lib/convex-data-model";
import { humanError } from "#/lib/human-error";
import { parseTagsInput } from "#/lib/project-helpers";
import { deliveryStatusView, truncateError } from "#/lib/webhook-delivery";
import { maskSecret } from "#/lib/webhook-secret";
import { formatRelativeTime } from "#/lib/relative-time";

export function ProjectSettingsPanel({
  project,
  orgSlug,
}: {
  project: Doc<"projects">;
  orgSlug: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const updateProject = useConvexMutation(api.projects.update);
  const removeProject = useConvexMutation(api.projects.remove);

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [tagsText, setTagsText] = useState(project.tags.join(", "));
  const [visibilityOpen, setVisibilityOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  // Keep local form in sync when realtime project doc changes (e.g. header visibility).
  useEffect(() => {
    setName(project.name);
    setDescription(project.description ?? "");
    setTagsText(project.tags.join(", "));
  }, [project.name, project.description, project.tags, project._id]);

  async function invalidateProjectQueries() {
    await queryClient.invalidateQueries({
      queryKey: convexQuery(api.projects.get, {
        orgSlug,
        projectSlug: project.slug,
      }).queryKey,
    });
    await queryClient.invalidateQueries({
      queryKey: convexQuery(api.projects.list, { orgSlug }).queryKey,
    });
  }

  const { mutate: saveDetails, isPending: savePending } = useMutation({
    mutationFn: (patch: {
      name: string;
      description: string | null;
      tags: string[];
    }) =>
      updateProject({
        projectId: project._id,
        patch,
      }),
    onMutate: async (patch) => {
      const queryOpts = convexQuery(api.projects.get, {
        orgSlug,
        projectSlug: project.slug,
      });
      await queryClient.cancelQueries({ queryKey: queryOpts.queryKey });
      const previous = queryClient.getQueryData<Doc<"projects"> | null>(
        queryOpts.queryKey,
      );
      if (previous) {
        queryClient.setQueryData<Doc<"projects">>(queryOpts.queryKey, {
          ...previous,
          name: patch.name,
          description: patch.description ?? undefined,
          tags: patch.tags,
        });
      }
      return { previous, queryKey: queryOpts.queryKey };
    },
    onSuccess: async () => {
      toast.success("Project updated");
      await invalidateProjectQueries();
    },
    onError: (err: unknown, _patch, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
      toast.error(humanError(err, "Could not update project"));
    },
  });

  const { mutate: setVisibility, isPending: visibilityPending } = useMutation({
    mutationFn: (visibility: "public" | "private") =>
      updateProject({
        projectId: project._id,
        patch: { visibility },
      }),
    onSuccess: async (updated) => {
      toast.success(
        updated.visibility === "public"
          ? "Project is now public"
          : "Project is now private",
      );
      setVisibilityOpen(false);
      await invalidateProjectQueries();
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not update visibility"));
    },
  });

  const { mutate: deleteProject, isPending: deletePending } = useMutation({
    mutationFn: () => removeProject({ projectId: project._id }),
    onSuccess: async () => {
      toast.success("Project deleted");
      setDeleteOpen(false);
      await queryClient.invalidateQueries({
        queryKey: convexQuery(api.projects.list, { orgSlug }).queryKey,
      });
      void navigate({ to: "/app/projects" });
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not delete project"));
    },
  });

  const nextVisibility = project.visibility === "public" ? "private" : "public";
  const tagsPreview = parseTagsInput(tagsText);
  const canDelete = deleteConfirm.trim() === project.slug;

  function onSaveDetails(e: FormEvent) {
    e.preventDefault();
    if (savePending) return;

    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      toast.error("Name is required");
      return;
    }
    if (tagsPreview.length > 32) {
      toast.error("At most 32 tags");
      return;
    }

    const trimmedDescription = description.trim();
    saveDetails({
      name: trimmedName,
      description: trimmedDescription === "" ? null : trimmedDescription,
      tags: tagsPreview,
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <form onSubmit={onSaveDetails}>
          <CardHeader>
            <CardTitle>Project details</CardTitle>
            <CardDescription>
              Name, description, and catalogue tags. Slug is permanent.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="settings-name">Name</Label>
              <Input
                id="settings-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                disabled={savePending}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="settings-slug">Slug</Label>
              <Input
                id="settings-slug"
                value={project.slug}
                disabled
                readOnly
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Slug cannot be changed after creation.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="settings-description">Description</Label>
              <textarea
                id="settings-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
                disabled={savePending}
                rows={4}
                className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="settings-tags">Tags</Label>
              <Input
                id="settings-tags"
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
                placeholder="ai, llm, tools"
                disabled={savePending}
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated. Lowercased and de-duplicated on save (max 32).
              </p>
              {tagsPreview.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {tagsPreview.map((tag) => (
                    <Badge key={tag} variant="outline">
                      {tag}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>
          </CardContent>
          <CardFooter className="justify-end border-t pt-6">
            <Button type="submit" disabled={savePending}>
              {savePending ? "Saving…" : "Save changes"}
            </Button>
          </CardFooter>
        </form>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Visibility</CardTitle>
          <CardDescription>
            Public projects appear in the catalogue when published. Private
            projects stay hidden.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1 text-sm">
            <p>
              Current:{" "}
              <span className="font-medium capitalize">
                {project.visibility}
              </span>
            </p>
            <p className="text-muted-foreground">
              Status:{" "}
              <span className="font-medium capitalize">{project.status}</span>
            </p>
          </div>
          <Dialog open={visibilityOpen} onOpenChange={setVisibilityOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">
                Make {nextVisibility === "public" ? "Public" : "Private"}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Make project {nextVisibility}?</DialogTitle>
                <DialogDescription>
                  {nextVisibility === "public"
                    ? "Public projects appear in the catalogue when published. Only published specs are listed."
                    : "Private projects stay hidden from the public catalogue."}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => setVisibilityOpen(false)}
                  disabled={visibilityPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => setVisibility(nextVisibility)}
                  disabled={visibilityPending}
                >
                  {visibilityPending ? "Updating…" : `Make ${nextVisibility}`}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>

      <WebhooksCard project={project} />

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
          <CardDescription>
            Delete this project and its draft/spec versions permanently. Usage
            history is retained for analytics integrity.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Dialog
            open={deleteOpen}
            onOpenChange={(open) => {
              if (deletePending) return;
              setDeleteOpen(open);
              if (!open) setDeleteConfirm("");
            }}
          >
            <DialogTrigger asChild>
              <Button variant="destructive">Delete project</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete project?</DialogTitle>
                <DialogDescription>
                  This cannot be undone. Type{" "}
                  <span className="font-mono text-foreground">
                    {project.slug}
                  </span>{" "}
                  to confirm.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="delete-confirm">Project slug</Label>
                <Input
                  id="delete-confirm"
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  placeholder={project.slug}
                  className="font-mono text-sm"
                  disabled={deletePending}
                  autoComplete="off"
                />
              </div>
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDeleteOpen(false);
                    setDeleteConfirm("");
                  }}
                  disabled={deletePending}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={deletePending || !canDelete}
                  onClick={() => deleteProject()}
                >
                  {deletePending ? "Deleting…" : "Delete project"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Webhooks — endpoint config + recent deliveries.
// The signing secret is generated server-side by webhooks.upsertEndpoint and
// returned in the endpoint doc; we surface it here (masked by default) with a
// copy + reveal toggle. Deliveries come from webhooks.listDeliveries.
// ---------------------------------------------------------------------------
function WebhooksCard({ project }: { project: Doc<"projects"> }) {
  const endpointQuery = useQuery(
    convexQuery(api.webhooks.getEndpoint, { projectId: project._id }),
  );
  const deliveriesQuery = useQuery(
    convexQuery(api.webhooks.listDeliveries, {
      projectId: project._id,
      paginationOpts: { numItems: 10, cursor: null },
    }),
  );

  const endpoint = endpointQuery.data ?? null;
  const deliveries = deliveriesQuery.data?.page ?? [];

  const [url, setUrl] = useState("");
  const [active, setActive] = useState(true);
  const [revealSecret, setRevealSecret] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);

  // Sync local form from the realtime endpoint doc once it loads.
  useEffect(() => {
    if (endpoint !== null) {
      setUrl(endpoint.url);
      setActive(endpoint.active);
    }
  }, [endpoint?._id, endpoint?.url, endpoint?.active]);

  const upsertMut = useConvexMutation(api.webhooks.upsertEndpoint);

  const { mutate: saveEndpoint, isPending: saving } = useMutation({
    mutationFn: (input: { url: string; active: boolean }) =>
      upsertMut({
        projectId: project._id,
        url: input.url,
        active: input.active,
      }),
    onSuccess: () => toast.success("Webhook endpoint saved"),
    onError: (err: unknown) =>
      toast.error(humanError(err, "Could not save webhook endpoint")),
  });

  const trimmedUrl = url.trim();
  const urlValid = isValidWebhookUrl(trimmedUrl);
  const dirty =
    endpoint === null
      ? trimmedUrl.length > 0
      : trimmedUrl !== endpoint.url || active !== endpoint.active;

  function onSave(e: FormEvent) {
    e.preventDefault();
    if (saving || !urlValid) return;
    saveEndpoint({ url: trimmedUrl, active });
  }

  async function copySecret() {
    if (!endpoint?.secret) return;
    try {
      await navigator.clipboard.writeText(endpoint.secret);
      setCopiedSecret(true);
      setTimeout(() => setCopiedSecret(false), 1500);
    } catch {
      toast.error("Could not copy secret");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Webhook className="size-4 text-muted-foreground" />
          Webhooks
        </CardTitle>
        <CardDescription>
          Receive spec lifecycle events (publish, deprecate) at your endpoint.
          One endpoint per project.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <form onSubmit={onSave} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="webhook-url">Endpoint URL</Label>
            <Input
              id="webhook-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/hooks/zevium"
              className="font-mono text-sm"
              disabled={saving}
              spellCheck={false}
              autoComplete="url"
            />
            {trimmedUrl.length > 0 && !urlValid ? (
              <p className="text-xs text-destructive">
                URL must be https (http://localhost allowed for dev).
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="webhook-secret">Signing secret</Label>
            {endpoint?.secret ? (
              <div className="flex items-center gap-2">
                <Input
                  id="webhook-secret"
                  readOnly
                  value={
                    revealSecret ? endpoint.secret : maskSecret(endpoint.secret)
                  }
                  className="font-mono text-sm"
                  aria-label="Webhook signing secret"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setRevealSecret((v) => !v)}
                  aria-label={revealSecret ? "Hide secret" : "Reveal secret"}
                >
                  {revealSecret ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={copySecret}
                  aria-label="Copy secret"
                >
                  {copiedSecret ? (
                    <Check className="size-4 text-success-foreground" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Save an endpoint to generate a signing secret.
              </p>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="webhook-active" className="text-sm">
                Active
              </Label>
              <p className="text-xs text-muted-foreground">
                Inactive endpoints skip delivery entirely.
              </p>
            </div>
            <Switch
              id="webhook-active"
              checked={active}
              onCheckedChange={setActive}
              disabled={saving}
            />
          </div>

          <div className="flex justify-end">
            <Button type="submit" disabled={saving || !urlValid || !dirty}>
              {saving
                ? "Saving…"
                : endpoint === null
                  ? "Create endpoint"
                  : "Save changes"}
            </Button>
          </div>
        </form>

        <div className="space-y-2 border-t pt-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">Recent deliveries</h4>
            {endpoint === null ? null : (
              <Badge variant="outline">{deliveries.length}</Badge>
            )}
          </div>
          {endpoint === null ? (
            <p className="text-xs text-muted-foreground">
              Create an endpoint to start receiving deliveries.
            </p>
          ) : deliveries.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No deliveries yet. Events appear here after a publish or
              deprecate.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {deliveries.map((d) => {
                const view = deliveryStatusView(d.status);
                const err = truncateError(d.lastError);
                return (
                  <li
                    key={d._id}
                    className="flex items-start justify-between gap-2 rounded-md border border-border px-2.5 py-2 text-sm"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{d.event}</span>
                        <Badge
                          variant={view.badgeVariant}
                          className={view.className}
                        >
                          {view.dotClassName.length > 0 ? (
                            <span
                              className={`size-1.5 rounded-full ${view.dotClassName}`}
                            />
                          ) : null}
                          {view.label}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {d.attempts} attempt{d.attempts === 1 ? "" : "s"}
                        {err.length > 0 ? ` · ${err}` : ""}
                      </p>
                    </div>
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                      {formatRelativeTime(d.createdAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Mirrors convex/webhooks.ts validateWebhookUrl (https or http://localhost). */
function isValidWebhookUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:" && parsed.hostname === "localhost") {
    return true;
  }
  return false;
}
