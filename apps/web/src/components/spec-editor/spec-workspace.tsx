import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker } from "@tanstack/react-router";
import { collectOpenApiSpecIssues, type SpecIssue } from "@zevium/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { api } from "#/lib/convex-api";
import type { Id } from "#/lib/convex-data-model";
import { humanError } from "#/lib/human-error";
import { listSpecEndpoints } from "#/lib/spec-endpoints";
import { applyPricingEdit, type PricingEdit } from "#/lib/spec-pricing-edit";
import {
  formatPricingSummary,
  summarizeDraftPricing,
} from "#/lib/spec-pricing";
import { deriveSaveStatus } from "#/lib/spec-save-status";
import { convertSpecInputToJson } from "#/lib/spec-yaml";

import { EditorToolbar } from "./editor-toolbar";
import { JsonCodeEditor } from "./json-code-editor";
import {
  SpecRailEndpoints,
  SpecRailValidation,
  SpecRailVersions,
  SpecRailVisibilityNudge,
} from "./spec-rail";
import { OPENAPI_TEMPLATE } from "./template";
import { VersionDialog } from "./version-dialog";

const AUTOSAVE_MS = 2000;
const STATUS_TICK_MS = 1000;

export type SpecWorkspaceProps = {
  projectId: Id<"projects">;
  orgSlug: string;
  projectSlug: string;
  visibility: "public" | "private";
  /** Nudges the publish flow to remind publishers to fill this in. */
  description: string | undefined;
  savedDraft: string;
  lastSavedAt: number | null;
  versions: Array<{
    _id: string;
    version: string;
    publishedAt: number;
    deprecatedAt: number | undefined;
    sunsetAt: number | undefined;
    deprecationMessage: string | undefined;
  }>;
};

function defaultNextVersion(existing: string[]): string {
  if (existing.length === 0) return "0.1.0";
  let best: [number, number, number] | null = null;
  for (const v of existing) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
    if (!m) continue;
    const triple: [number, number, number] = [
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
    ];
    if (
      best === null ||
      triple[0] > best[0] ||
      (triple[0] === best[0] && triple[1] > best[1]) ||
      (triple[0] === best[0] && triple[1] === best[1] && triple[2] > best[2])
    ) {
      best = triple;
    }
  }
  if (best === null) return "0.1.0";
  return `${best[0]}.${best[1]}.${best[2] + 1}`;
}

function mergeIssues(client: SpecIssue[], server: SpecIssue[]): SpecIssue[] {
  const key = (i: SpecIssue) => `${i.level}|${i.path}|${i.message}`;
  const seen = new Set(client.map(key));
  const out = [...client];
  for (const issue of server) {
    const k = key(issue);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(issue);
  }
  return out;
}

export function SpecWorkspace({
  projectId,
  orgSlug,
  projectSlug,
  visibility,
  description,
  savedDraft,
  lastSavedAt: initialLastSavedAt,
  versions,
}: SpecWorkspaceProps) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(savedDraft);
  const [serverIssues, setServerIssues] = useState<SpecIssue[]>([]);
  const [publishOpen, setPublishOpen] = useState(false);
  const [versionDialogId, setVersionDialogId] =
    useState<Id<"specVersions"> | null>(null);
  const [version, setVersion] = useState(() =>
    defaultNextVersion(versions.map((v) => v.version)),
  );
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(
    initialLastSavedAt,
  );
  const [now, setNow] = useState(() => Date.now());
  const [goodEndpoints, setGoodEndpoints] = useState(
    () => listSpecEndpoints(savedDraft) ?? [],
  );
  const [endpointsStale, setEndpointsStale] = useState(false);

  // Autosave circuit breaker: 3 consecutive save failures (server-rejected
  // draft or transport error) trip the breaker so autosave stops hammering the
  // backend every 2s. Any user edit resets it.
  const [autosaveTripped, setAutosaveTripped] = useState(false);
  const consecutiveFailuresRef = useRef(0);
  const resetAutosaveCircuit = useCallback(() => {
    consecutiveFailuresRef.current = 0;
    setAutosaveTripped(false);
  }, []);

  const textRef = useRef(text);
  textRef.current = text;
  // Last text the server has accepted or pushed. Used to detect whether the
  // user has in-progress edits before adopting a remotely-pushed draft, so a
  // concurrent tab/session save never clobbers unsaved keystrokes.
  const lastSavedTextRef = useRef(savedDraft);

  useEffect(() => {
    // Only adopt the server draft when the user has no in-progress edits
    // (local text still equals the last server-synced text). Otherwise keep
    // the local edits intact and just record the new server baseline.
    if (textRef.current === lastSavedTextRef.current) {
      setText(savedDraft);
      setLastSavedAt(initialLastSavedAt);
    }
    lastSavedTextRef.current = savedDraft;
  }, [savedDraft, initialLastSavedAt]);

  useEffect(() => {
    setVersion(defaultNextVersion(versions.map((v) => v.version)));
  }, [versions]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), STATUS_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const clientIssues = useMemo(() => {
    if (text.trim() === "") return [] as SpecIssue[];
    return collectOpenApiSpecIssues(text);
  }, [text]);

  const clientErrors = useMemo(
    () => clientIssues.filter((i) => i.level === "error"),
    [clientIssues],
  );

  const mergedIssues = useMemo(
    () => mergeIssues(clientIssues, serverIssues),
    [clientIssues, serverIssues],
  );

  const pricing = useMemo(() => summarizeDraftPricing(text), [text]);

  useEffect(() => {
    const rows = listSpecEndpoints(text);
    if (rows === null) {
      setEndpointsStale(true);
      return;
    }
    setGoodEndpoints(rows);
    setEndpointsStale(false);
  }, [text]);

  // Rail pricing write-back: parse current text, mutate the target operation,
  // re-serialize. Functional updater composes multiple edits per debounce flush.
  const handlePricingChange = useCallback(
    (edit: PricingEdit) => {
      resetAutosaveCircuit();
      setText((prev) => {
        const result = applyPricingEdit(prev, edit);
        return result.ok ? result.text : prev;
      });
    },
    [resetAutosaveCircuit],
  );

  const dirty = text !== savedDraft;
  const hasClientErrors = clientErrors.length > 0;

  const saveDraftFn = useConvexMutation(api.specs.saveDraft);
  const publishFn = useConvexMutation(api.specs.publish);
  const updateProject = useConvexMutation(api.projects.update);

  const { mutate: saveDraft, isPending: savePending } = useMutation({
    mutationFn: (spec: string) => saveDraftFn({ projectId, spec }),
    onSuccess: async (result, spec) => {
      setServerIssues(result.issues);
      if (!result.ok) {
        // Server rejected the draft. The client thinks the text is clean, so
        // without a circuit breaker the autosave effect would re-fire every
        // 2s forever (toast spam + backend load). Count it and trip after 3.
        consecutiveFailuresRef.current += 1;
        if (consecutiveFailuresRef.current >= 3) {
          setAutosaveTripped(true);
        }
        toast.error("Draft has errors — fix issues before saving");
        return;
      }
      consecutiveFailuresRef.current = 0;
      setAutosaveTripped(false);
      // Record the server-accepted text so the remote-sync effect knows we are
      // in sync and won't clobber any edits typed during the round-trip.
      lastSavedTextRef.current = spec;
      setLastSavedAt(result.lastSavedAt);
      toast.success("Draft saved");
      await queryClient.invalidateQueries({
        queryKey: convexQuery(api.specs.getDraft, { projectId }).queryKey,
      });
    },
    onError: (err: unknown) => {
      consecutiveFailuresRef.current += 1;
      if (consecutiveFailuresRef.current >= 3) {
        setAutosaveTripped(true);
      }
      toast.error(humanError(err, "Could not save draft"));
    },
  });

  const { mutate: publish, isPending: publishPending } = useMutation({
    mutationFn: () =>
      publishFn({
        projectId,
        version: version.trim(),
      }),
    onSuccess: async (result) => {
      setServerIssues(result.issues);
      if (!result.ok) {
        const first = result.issues.find((i) => i.level === "error");
        toast.error(first?.message ?? "Publish failed — check issues");
        return;
      }
      toast.success(`Published v${result.version?.version ?? version}`);
      setPublishOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: convexQuery(api.specs.listVersions, { projectId }).queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: convexQuery(api.projects.get, { orgSlug, projectSlug })
            .queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: convexQuery(api.projects.list, { orgSlug }).queryKey,
        }),
      ]);
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not publish"));
    },
  });

  const { mutate: makePublic, isPending: visibilityPending } = useMutation({
    mutationFn: () =>
      updateProject({
        projectId,
        patch: { visibility: "public" },
      }),
    onSuccess: async () => {
      toast.success("Project is now public");
      await queryClient.invalidateQueries({
        queryKey: convexQuery(api.projects.get, { orgSlug, projectSlug })
          .queryKey,
      });
      await queryClient.invalidateQueries({
        queryKey: convexQuery(api.projects.list, { orgSlug }).queryKey,
      });
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not update visibility"));
    },
  });

  // Autosave: 2s after last keystroke; never with client errors.
  useEffect(() => {
    if (!dirty || hasClientErrors || savePending || autosaveTripped) return;
    const handle = setTimeout(() => {
      const current = textRef.current;
      if (current === savedDraft) return;
      if (current.trim() !== "") {
        const issues = collectOpenApiSpecIssues(current);
        if (issues.some((i) => i.level === "error")) return;
      }
      saveDraft(current);
    }, AUTOSAVE_MS);
    return () => clearTimeout(handle);
  }, [
    text,
    dirty,
    hasClientErrors,
    savePending,
    autosaveTripped,
    savedDraft,
    saveDraft,
  ]);

  // Guard against data loss on navigate-away / tab close while the user has
  // unsaved edits. `shouldBlockFn` covers in-app route changes (e.g. the
  // embedded "Add one in Settings" link); `enableBeforeUnload` covers tab
  // close and refresh. Suppressed while a save is in flight.
  useBlocker({
    shouldBlockFn: () => dirty && !savePending,
    enableBeforeUnload: () => dirty && !savePending,
  });

  const status = deriveSaveStatus({
    dirty,
    saving: savePending,
    hasClientErrors,
    lastSavedAt,
    now,
  });

  function applyEditorText(next: string) {
    resetAutosaveCircuit();
    const converted = convertSpecInputToJson(next);
    if (!converted.ok) {
      setText(next);
      return;
    }
    if (converted.convertedFromYaml) {
      setText(converted.json);
      toast.success("Converted YAML to JSON");
      return;
    }
    setText(converted.json === next ? next : converted.json);
  }

  function onEditorChange(next: string) {
    resetAutosaveCircuit();
    // Detect YAML paste only when whole doc flipped from JSON-ish to YAML-ish
    // or starts as YAML. Full convert on each keystroke would thrash.
    if (
      next.trim() !== "" &&
      !next.trimStart().startsWith("{") &&
      !next.trimStart().startsWith("[")
    ) {
      const converted = convertSpecInputToJson(next);
      if (converted.ok && converted.convertedFromYaml) {
        setText(converted.json);
        toast.success("Converted YAML to JSON");
        return;
      }
    }
    setText(next);
  }

  const hasDescription = description !== undefined && description.trim() !== "";

  const publishSlot = (
    <div className="space-y-3">
      <SpecRailVisibilityNudge
        visibility={visibility}
        onMakePublic={() => makePublic()}
        pending={visibilityPending}
      />
      {!hasDescription ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          No description — catalogue card will look empty.{" "}
          <Link
            to="/app/projects/$projectSlug"
            params={{ projectSlug }}
            className="underline underline-offset-2 hover:text-foreground"
          >
            Add one in Settings
          </Link>
          .
        </p>
      ) : null}
      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogTrigger asChild>
          <Button
            className="w-full"
            disabled={dirty || savePending || hasClientErrors}
          >
            Publish
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish version</DialogTitle>
            <DialogDescription>
              Published versions are immutable. Use semver (e.g. 0.1.0).
              Snapshots the saved draft.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="semver">Version</Label>
            <Input
              id="semver"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="0.1.0"
              className="font-mono"
              disabled={publishPending}
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPublishOpen(false)}
              disabled={publishPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => publish()}
              disabled={publishPending || version.trim() === ""}
            >
              {publishPending ? "Publishing…" : "Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {dirty ? (
        <p className="text-xs text-muted-foreground">
          Save draft before publishing.
        </p>
      ) : null}
    </div>
  );

  return (
    <>
      {autosaveTripped ? (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span>
            Autosave paused after repeated save failures. Edit the spec to
            resume, or retry manually.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              resetAutosaveCircuit();
              saveDraft(textRef.current);
            }}
          >
            Retry save
          </Button>
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <EditorToolbar
                onApplyText={applyEditorText}
                disabled={savePending}
              />
              {pricing ? (
                <Badge variant="secondary">
                  {formatPricingSummary(pricing)}
                </Badge>
              ) : (
                <Badge variant="outline">Invalid JSON</Badge>
              )}
              <span className="text-xs text-muted-foreground">
                {status.label}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                disabled={
                  !dirty ||
                  savePending ||
                  (hasClientErrors && text.trim() !== "")
                }
                onClick={() => saveDraft(text)}
              >
                {savePending ? "Saving…" : "Save draft"}
              </Button>
            </div>
          </div>

          <JsonCodeEditor
            value={text}
            onChange={onEditorChange}
            placeholder={OPENAPI_TEMPLATE}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <SpecRailEndpoints
            endpoints={goodEndpoints}
            stale={endpointsStale}
            disabled={endpointsStale}
            onPricingChange={handlePricingChange}
          />
          <SpecRailValidation issues={mergedIssues} />
          <SpecRailVersions
            versions={versions}
            publishSlot={publishSlot}
            projectId={projectId}
            onSelectVersion={(id) =>
              setVersionDialogId(id as Id<"specVersions">)
            }
          />
        </div>
      </div>
      <VersionDialog
        versionId={versionDialogId}
        savedDraft={savedDraft}
        dirty={dirty}
        onRestore={(spec) => {
          resetAutosaveCircuit();
          setText(spec);
        }}
        onOpenChange={(open) => {
          if (!open) setVersionDialogId(null);
        }}
      />
    </>
  );
}
