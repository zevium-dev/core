import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useOrganization } from "@clerk/tanstack-react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Trash2,
  Webhook,
} from "lucide-react";
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "#/components/ui/field";
import { Textarea } from "#/components/ui/textarea";
import { api } from "#/lib/convex-api";
import type { Doc, Id } from "#/lib/convex-data-model";
import { humanError } from "#/lib/human-error";
import { parseTagsInput } from "#/lib/project-helpers";
import { deliveryStatusView, truncateError } from "#/lib/webhook-delivery";
import { maskSecret } from "#/lib/webhook-secret";
import { formatRelativeTime } from "#/lib/relative-time";

const MIN_RETIREMENT_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;
const RETIREMENT_MESSAGE_MAX = 1_000;

export function ProjectSettingsPanel({
  project,
  orgSlug,
}: {
  project: Doc<"projects">;
  orgSlug: string;
}) {
  const { membership } = useOrganization();
  const isAdmin = membership?.role === "org:admin";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const updateProject = useConvexMutation(api.projects.update);
  const removeProject = useConvexMutation(api.projects.remove);
  const scheduleProjectRetirement = useConvexMutation(
    api.projects.scheduleRetirement,
  );
  const cancelProjectRetirement = useConvexMutation(
    api.projects.cancelRetirement,
  );

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [tagsText, setTagsText] = useState(project.tags.join(", "));
  const [visibilityOpen, setVisibilityOpen] = useState(false);
  const [cancelRetirementOpen, setCancelRetirementOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [sunsetDate, setSunsetDate] = useState("");
  const [retirementMessage, setRetirementMessage] = useState("");

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
      toast.success("Project archived");
      setDeleteOpen(false);
      await queryClient.invalidateQueries({
        queryKey: convexQuery(api.projects.list, { orgSlug }).queryKey,
      });
      void navigate({ to: "/app/projects" });
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not archive project"));
    },
  });

  const { mutate: scheduleRetirement, isPending: retirementPending } =
    useMutation({
      mutationFn: (input: { sunsetAt: number; message: string }) =>
        scheduleProjectRetirement({ projectId: project._id, ...input }),
      onSuccess: async () => {
        toast.success("Project retirement scheduled");
        setVisibilityOpen(false);
        setSunsetDate("");
        setRetirementMessage("");
        await invalidateProjectQueries();
      },
      onError: (err: unknown) =>
        toast.error(humanError(err, "Could not schedule retirement")),
    });

  const { mutate: cancelRetirement, isPending: cancelRetirementPending } =
    useMutation({
      mutationFn: () => cancelProjectRetirement({ projectId: project._id }),
      onSuccess: async () => {
        toast.success("Project retirement canceled");
        setCancelRetirementOpen(false);
        await invalidateProjectQueries();
      },
      onError: (err: unknown) =>
        toast.error(humanError(err, "Could not cancel retirement")),
    });

  const nextVisibility = project.visibility === "public" ? "private" : "public";
  const tagsPreview = parseTagsInput(tagsText);
  const canDelete = deleteConfirm.trim() === project.slug;
  const isPublishedPublic =
    project.status === "published" && project.visibility === "public";
  const retirementScheduled = project.deprecationStartedAt !== undefined;
  const parsedSunset = Date.parse(`${sunsetDate}T23:59:59.999Z`);
  const minimumSunset = Date.now() + MIN_RETIREMENT_NOTICE_MS;
  const retirementMessageLength = retirementMessage.trim().length;
  const sunsetError =
    sunsetDate !== "" &&
    (!Number.isFinite(parsedSunset) || parsedSunset < minimumSunset)
      ? "Choose a sunset at least 7 full days from now."
      : null;
  const retirementMessageError =
    retirementMessage.length > RETIREMENT_MESSAGE_MAX
      ? `Keep the migration notice under ${RETIREMENT_MESSAGE_MAX.toLocaleString()} characters.`
      : null;
  const canScheduleRetirement =
    Number.isFinite(parsedSunset) &&
    parsedSunset >= minimumSunset &&
    retirementMessageLength > 0 &&
    retirementMessageLength <= RETIREMENT_MESSAGE_MAX;
  const canRemoveProject =
    project.status !== "published" ||
    (project.sunsetAt !== undefined && Date.now() >= project.sunsetAt);

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
            projects stay hidden. Published projects require at least 7 days
            notice before retirement.
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
            {retirementScheduled && project.sunsetAt !== undefined ? (
              <p className="text-muted-foreground">
                Sunset: {new Date(project.sunsetAt).toLocaleDateString()}
              </p>
            ) : null}
          </div>
          {retirementScheduled ? (
            isAdmin ? (
              <Dialog
                open={cancelRetirementOpen}
                onOpenChange={(next) => {
                  if (!cancelRetirementPending) setCancelRetirementOpen(next);
                }}
              >
                <DialogTrigger asChild>
                  <Button variant="outline">Cancel retirement</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Cancel scheduled retirement?</DialogTitle>
                    <DialogDescription>
                      Existing consumers keep access either way. Canceling will
                      make this API discoverable to new consumers again.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button
                      variant="ghost"
                      onClick={() => setCancelRetirementOpen(false)}
                      disabled={cancelRetirementPending}
                    >
                      Keep retirement
                    </Button>
                    <Button
                      onClick={() => cancelRetirement()}
                      disabled={cancelRetirementPending}
                    >
                      {cancelRetirementPending
                        ? "Canceling…"
                        : "Cancel retirement"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            ) : (
              <p className="text-sm text-muted-foreground">
                Only an organization admin can cancel retirement.
              </p>
            )
          ) : (
            <Dialog open={visibilityOpen} onOpenChange={setVisibilityOpen}>
              <DialogTrigger asChild>
                <Button
                  variant="outline"
                  disabled={isPublishedPublic && !isAdmin}
                >
                  {isPublishedPublic
                    ? "Schedule retirement"
                    : `Make ${nextVisibility === "public" ? "Public" : "Private"}`}
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>
                    {isPublishedPublic
                      ? "Schedule project retirement?"
                      : `Make project ${nextVisibility}?`}
                  </DialogTitle>
                  <DialogDescription>
                    {isPublishedPublic
                      ? "New discovery freezes immediately. Existing gateway traffic continues through sunset, then stops."
                      : nextVisibility === "public"
                        ? "Public projects appear in the catalogue when published. Only published specs are listed."
                        : "Private projects stay hidden from the public catalogue."}
                  </DialogDescription>
                </DialogHeader>
                {isPublishedPublic ? (
                  <div className="space-y-5">
                    <Field data-invalid={sunsetError !== null}>
                      <FieldLabel htmlFor="project-sunset">
                        Sunset date
                      </FieldLabel>
                      <Input
                        id="project-sunset"
                        type="date"
                        value={sunsetDate}
                        onChange={(event) => setSunsetDate(event.target.value)}
                        min={new Date(Date.now() + 7 * 86_400_000)
                          .toISOString()
                          .slice(0, 10)}
                        aria-invalid={sunsetError !== null}
                        aria-describedby="project-sunset-help"
                      />
                      <FieldDescription id="project-sunset-help">
                        Calls from existing consumers stop at 23:59 UTC on this
                        date. Minimum notice: 7 full days.
                      </FieldDescription>
                      <FieldError>{sunsetError}</FieldError>
                    </Field>
                    <Field data-invalid={retirementMessageError !== null}>
                      <FieldLabel htmlFor="retirement-message">
                        Migration notice
                      </FieldLabel>
                      <Textarea
                        id="retirement-message"
                        value={retirementMessage}
                        onChange={(event) =>
                          setRetirementMessage(event.target.value)
                        }
                        placeholder="Where should consumers migrate?"
                        maxLength={RETIREMENT_MESSAGE_MAX + 1}
                        aria-invalid={retirementMessageError !== null}
                        aria-describedby="retirement-message-help"
                      />
                      <FieldDescription id="retirement-message-help">
                        Sent to existing consumers. {retirementMessage.length}/
                        {RETIREMENT_MESSAGE_MAX.toLocaleString()}
                      </FieldDescription>
                      <FieldError>{retirementMessageError}</FieldError>
                    </Field>
                  </div>
                ) : null}
                <DialogFooter>
                  <Button
                    variant="ghost"
                    onClick={() => setVisibilityOpen(false)}
                    disabled={visibilityPending || retirementPending}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={() => {
                      if (isPublishedPublic) {
                        scheduleRetirement({
                          sunsetAt: parsedSunset,
                          message: retirementMessage.trim(),
                        });
                        return;
                      }
                      setVisibility(nextVisibility);
                    }}
                    disabled={
                      visibilityPending ||
                      retirementPending ||
                      (isPublishedPublic && !canScheduleRetirement)
                    }
                  >
                    {retirementPending
                      ? "Scheduling…"
                      : visibilityPending
                        ? "Updating…"
                        : isPublishedPublic
                          ? "Schedule retirement"
                          : `Make ${nextVisibility}`}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </CardContent>
      </Card>

      <UpstreamCredentialsCard project={project} />

      <WebhooksCard project={project} />

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
          <CardDescription>
            {project.status === "draft"
              ? "Delete this draft and its unpublished spec permanently."
              : "Retire this published project after its sunset. Immutable versions, usage, and financial records remain available for audit integrity."}
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
              <Button
                variant="destructive"
                disabled={!isAdmin || !canRemoveProject}
              >
                {project.status === "draft"
                  ? "Delete project"
                  : "Retire project"}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {project.status === "draft"
                    ? "Delete project?"
                    : "Retire project?"}
                </DialogTitle>
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
                  {deletePending ? "Archiving…" : "Archive project"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          {!isAdmin ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Only an organization admin can remove projects.
            </p>
          ) : !canRemoveProject ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Published projects can be retired only after their scheduled
              sunset.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function UpstreamCredentialsCard({ project }: { project: Doc<"projects"> }) {
  const queryClient = useQueryClient();
  const credentialsQuery = useQuery(
    convexQuery(api.upstreamCredentials.listForProject, {
      projectId: project._id,
    }),
  );
  const upsertCredential = useConvexMutation(api.upstreamCredentials.upsert);
  const removeCredential = useConvexMutation(api.upstreamCredentials.remove);

  const [name, setName] = useState("x-api-key");
  const [secret, setSecret] = useState("");
  const [revealSecret, setRevealSecret] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [credentialToRemove, setCredentialToRemove] = useState<{
    id: Id<"upstreamCredentials">;
    name: string;
  } | null>(null);

  const queryKey = convexQuery(api.upstreamCredentials.listForProject, {
    projectId: project._id,
  }).queryKey;

  const { mutate: saveCredential, isPending: saving } = useMutation({
    mutationFn: (input: { name: string; secret: string }) =>
      upsertCredential({
        projectId: project._id,
        name: input.name,
        secret: input.secret,
      }),
    onSuccess: async () => {
      setSecret("");
      setRevealSecret(false);
      toast.success("Upstream credential saved");
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: unknown) =>
      toast.error(humanError(err, "Could not save upstream credential")),
  });

  const { mutate: deleteCredential, isPending: deleting } = useMutation({
    mutationFn: (credentialId: Id<"upstreamCredentials">) =>
      removeCredential({ credentialId }),
    onSuccess: async () => {
      toast.success("Upstream credential removed");
      setCredentialToRemove(null);
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: unknown) =>
      toast.error(humanError(err, "Could not remove upstream credential")),
  });

  function onSave(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (name.trim() === "" || secret.trim() === "") {
      setCredentialError("Enter both a header name and secret value.");
      document
        .getElementById(
          name.trim() === ""
            ? "upstream-header-name"
            : "upstream-header-secret",
        )
        ?.focus();
      return;
    }
    setCredentialError(null);
    saveCredential({ name: name.trim(), secret });
  }

  const credentials = credentialsQuery.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" />
          Upstream credentials
        </CardTitle>
        <CardDescription>
          Gateway injects these headers after removing consumer credentials.
          Secret values are write-only and never shown again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <form
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={onSave}
        >
          <div className="space-y-2">
            <Label htmlFor="upstream-header-name">Header name</Label>
            <Input
              id="upstream-header-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="x-api-key"
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
              required
              aria-invalid={credentialError !== null && name.trim() === ""}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="upstream-header-secret">Secret value</Label>
            <div className="relative">
              <Input
                id="upstream-header-secret"
                type={revealSecret ? "text" : "password"}
                value={secret}
                aria-invalid={credentialError !== null && secret.trim() === ""}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="Enter new value"
                autoComplete="new-password"
                disabled={saving}
                required
                className="pr-10"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute top-1/2 right-1 -translate-y-1/2"
                onClick={() => setRevealSecret((value) => !value)}
                aria-label={
                  revealSecret ? "Hide secret value" : "Show secret value"
                }
                disabled={saving}
              >
                {revealSecret ? <EyeOff /> : <Eye />}
              </Button>
            </div>
          </div>
          <Button
            type="submit"
            className="self-end"
            disabled={saving || name.trim() === "" || secret === ""}
          >
            {saving ? "Saving…" : "Save credential"}
          </Button>
        </form>

        {credentials.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No upstream credentials configured.
          </p>
        ) : (
          <div className="divide-y rounded-md border">
            {credentials.map((credential) => (
              <div
                key={credential.id}
                className="flex items-center justify-between gap-3 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm">
                    {credential.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Updated {formatRelativeTime(credential.updatedAt)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${credential.name}`}
                  onClick={() =>
                    setCredentialToRemove({
                      id: credential.id,
                      name: credential.name,
                    })
                  }
                  disabled={deleting}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      <Dialog
        open={credentialToRemove !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setCredentialToRemove(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Remove {credentialToRemove?.name ?? "credential"}?
            </DialogTitle>
            <DialogDescription>
              Gateway calls may start failing immediately after the propagation
              window. Replace this credential first if the upstream still
              requires it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setCredentialToRemove(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (credentialToRemove) deleteCredential(credentialToRemove.id);
              }}
              disabled={deleting}
            >
              {deleting ? "Removing…" : "Remove credential"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
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
  }, [endpoint]);

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
