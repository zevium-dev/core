import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker } from "@tanstack/react-router";
import {
  collectOpenApiSpecIssues,
  isValidSemver,
  type SpecIssue,
} from "@zevium/shared";
import { useAction } from "convex/react";
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
import { canTestSavedDraft } from "#/lib/spec-readiness";
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
  /** Admin-only lifecycle controls; members may still edit and save drafts. */
  canAdminister: boolean;
  savedDraft: string;
  savedDraftHash: string | null;
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
  canAdminister,
  savedDraft,
  savedDraftHash,
  lastSavedAt: initialLastSavedAt,
  versions,
}: SpecWorkspaceProps) {
  const queryClient = useQueryClient();
  // A new project owns an empty persisted draft. Make the first editor state a
  // real, dirty OpenAPI document instead of rendering the template as a
  // misleading textarea placeholder: the endpoint rail, validation, and
  // readiness checklist now all describe the same draft the user can save.
  const initialText = savedDraft.trim() === "" ? OPENAPI_TEMPLATE : savedDraft;
  const [text, setText] = useState(initialText);
  const [confirmedDraft, setConfirmedDraft] = useState(savedDraft);
  const [confirmedDraftHash, setConfirmedDraftHash] = useState(savedDraftHash);
  const [serverIssues, setServerIssues] = useState<SpecIssue[]>([]);
  const [publishOpen, setPublishOpen] = useState(false);
  const [versionTouched, setVersionTouched] = useState(false);
  const [pendingReplacement, setPendingReplacement] = useState<string | null>(
    null,
  );
  const [makePublicOpen, setMakePublicOpen] = useState(false);
  const [connectionResult, setConnectionResult] = useState<{
    message: string;
  } | null>(null);
  const [versionDialogId, setVersionDialogId] =
    useState<Id<"specVersions"> | null>(null);
  const [version, setVersion] = useState(() =>
    defaultNextVersion(versions.map((v) => v.version)),
  );
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(
    initialLastSavedAt,
  );
  const versionInputRef = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [goodEndpoints, setGoodEndpoints] = useState(
    () => listSpecEndpoints(initialText) ?? [],
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
    setConfirmedDraft(savedDraft);
    setConfirmedDraftHash(savedDraftHash);
    lastSavedTextRef.current = savedDraft;
  }, [savedDraft, savedDraftHash, initialLastSavedAt]);

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

  const dirty = text !== confirmedDraft;
  const hasClientErrors = clientErrors.length > 0;
  const shouldBlockNavigation = useCallback(() => dirty, [dirty]);

  const saveDraftFn = useConvexMutation(api.specs.saveDraft);
  const publishFn = useConvexMutation(api.specs.publish);
  const updateProject = useConvexMutation(api.projects.update);
  const testConnection = useAction(api.publishReadinessAction.testConnection);
  const persistedReadiness = useQuery(
    convexQuery(api.publishReadiness.getCurrent, { projectId }),
  );
  const readinessCurrent = persistedReadiness.data?.current === true;

  const {
    mutate: saveDraft,
    mutateAsync: saveDraftAsync,
    isPending: savePending,
  } = useMutation({
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
      setConfirmedDraft(spec);
      setConfirmedDraftHash(result.draftHash ?? null);
      setLastSavedAt(result.lastSavedAt);
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
  const savedFingerprintMatchesEditor = canTestSavedDraft(
    text,
    { text: confirmedDraft, hash: confirmedDraftHash },
    savePending,
    hasClientErrors,
  );

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
      setMakePublicOpen(false);
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

  const { mutate: verifyConnection, isPending: connectionPending } =
    useMutation({
      mutationFn: () => testConnection({ projectId }),
      onSuccess: (result) => {
        setConnectionResult(result);
        void queryClient.invalidateQueries({
          queryKey: convexQuery(api.publishReadiness.getCurrent, {
            projectId,
          }).queryKey,
        });
      },
      onError: (err: unknown) => {
        const message = humanError(
          err,
          "Could not test the upstream connection",
        );
        setConnectionResult({ message });
        toast.error(message);
      },
    });

  // Autosave: 2s after last keystroke; never with client errors.
  useEffect(() => {
    if (!dirty || hasClientErrors || savePending || autosaveTripped) return;
    const handle = setTimeout(() => {
      const current = textRef.current;
      if (current === confirmedDraft) return;
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
    confirmedDraft,
    saveDraft,
  ]);

  // Keep the guard active during a save too: transport failure must never turn
  // an in-flight draft into permission to discard edits.
  const blocker = useBlocker({
    shouldBlockFn: shouldBlockNavigation,
    enableBeforeUnload: dirty,
    withResolver: true,
  });

  useEffect(() => {
    if (!dirty && blocker.status === "blocked") {
      blocker.proceed();
    }
  }, [dirty, blocker]);

  const status = deriveSaveStatus({
    dirty,
    saving: savePending,
    hasClientErrors,
    lastSavedAt,
    now,
  });

  function commitEditorReplacement(replacement: string) {
    resetAutosaveCircuit();
    setText(replacement);
    setPendingReplacement(null);
  }

  function requestEditorReplacement(replacement: string) {
    if (dirty) {
      setPendingReplacement(replacement);
      return;
    }
    commitEditorReplacement(replacement);
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
  const normalizedVersion = version.trim();
  const versionError =
    normalizedVersion === ""
      ? "Enter a version."
      : !isValidSemver(normalizedVersion)
        ? "Use semantic versioning, for example 1.2.0 or 1.2.0-beta.1."
        : versions.some((item) => item.version === normalizedVersion)
          ? `Version ${normalizedVersion} is already published.`
          : null;
  const checklist = [
    {
      label: "Valid saved spec",
      complete: !dirty && !hasClientErrors && text.trim() !== "",
      detail: dirty
        ? "Save the current draft before publishing."
        : hasClientErrors
          ? "Fix the errors in the validation rail."
          : "A valid OpenAPI draft is saved.",
    },
    {
      label: "Server URL and reachability",
      complete: readinessCurrent,
      detail:
        connectionResult?.message ??
        (readinessCurrent
          ? "Saved credential-free reachability test is current."
          : persistedReadiness.data?.reason === "expired"
            ? "Saved passing test expired. Run it again."
            : persistedReadiness.data?.reason === "draft_changed"
              ? "Saved draft changed after the passing test. Run it again."
              : persistedReadiness.data?.readiness
                ? "Saved test is no longer valid. Run it again."
                : "Run a credential-free reachability test against servers[0].url. Saved publisher credentials are never sent."),
    },
    {
      label: "Pricing",
      complete: pricing !== null && goodEndpoints.length > 0,
      detail:
        pricing === null
          ? "Fix the pricing fields in the spec."
          : goodEndpoints.length === 0
            ? "Add at least one operation before publishing."
            : formatPricingSummary(pricing),
    },
    {
      label: "Listing metadata",
      complete: hasDescription,
      detail: hasDescription
        ? "Description is ready for the catalogue."
        : "Add a description so consumers understand the listing.",
    },
    {
      label: "Mock preview",
      complete: goodEndpoints.length > 0 && !hasClientErrors,
      detail:
        goodEndpoints.length > 0 && !hasClientErrors
          ? "A mock response will be available after publication."
          : "Fix the spec and add an operation to enable the mock preview.",
    },
  ];

  async function saveThenLeave() {
    if (blocker.status !== "blocked") return;
    const proceed = blocker.proceed;
    try {
      const result = await saveDraftAsync(textRef.current);
      if (result.ok) proceed();
    } catch {
      // Mutation-level onError owns the human-readable message.
    }
  }

  const publishSlot = canAdminister ? (
    <div className="space-y-3">
      <SpecRailVisibilityNudge
        visibility={visibility}
        onRequestMakePublic={() => setMakePublicOpen(true)}
        pending={visibilityPending}
      />
      <Dialog open={makePublicOpen} onOpenChange={setMakePublicOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Make project public?</DialogTitle>
            <DialogDescription>
              Published versions will become discoverable in the public
              catalogue. Drafts remain private until they are published.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setMakePublicOpen(false)}
              disabled={visibilityPending}
            >
              Cancel
            </Button>
            <Button onClick={() => makePublic()} disabled={visibilityPending}>
              {visibilityPending ? "Making public…" : "Make public"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <section
        aria-labelledby="publish-readiness-title"
        className="rounded-md border p-3 text-sm"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 id="publish-readiness-title" className="font-medium">
              Publish readiness
            </h2>
            <p className="text-muted-foreground">
              Check these before making this version public.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => verifyConnection()}
            disabled={
              connectionPending ||
              savePending ||
              dirty ||
              !savedFingerprintMatchesEditor ||
              hasClientErrors
            }
          >
            {connectionPending ? "Testing…" : "Test reachability"}
          </Button>
        </div>
        <ul className="mt-3 flex flex-col gap-2">
          {checklist.map((item) => (
            <li key={item.label} className="flex gap-2">
              <span aria-hidden="true">{item.complete ? "✓" : "•"}</span>
              <div>
                <p className="font-medium">{item.label}</p>
                <p className="text-muted-foreground">{item.detail}</p>
              </div>
            </li>
          ))}
        </ul>
        {!hasDescription ? (
          <Button asChild variant="link" size="sm" className="mt-2 px-0">
            <Link to="/app/projects/$projectSlug" params={{ projectSlug }}>
              Add listing metadata
            </Link>
          </Button>
        ) : null}
      </section>
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
      <Dialog
        open={publishOpen}
        onOpenChange={(open) => {
          setPublishOpen(open);
          if (!open) setVersionTouched(false);
        }}
      >
        <DialogTrigger asChild>
          <Button
            className="w-full"
            disabled={
              dirty || savePending || hasClientErrors || !readinessCurrent
            }
          >
            {readinessCurrent ? "Publish" : "Test reachability to publish"}
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
              ref={versionInputRef}
              id="semver"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              onBlur={() => setVersionTouched(true)}
              placeholder="0.1.0"
              className="font-mono"
              disabled={publishPending}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={versionTouched && versionError !== null}
              aria-describedby={
                versionTouched && versionError ? "semver-error" : undefined
              }
            />
            {versionTouched && versionError ? (
              <p id="semver-error" className="text-sm text-destructive">
                {versionError}
              </p>
            ) : null}
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
              onClick={() => {
                setVersionTouched(true);
                if (versionError) {
                  versionInputRef.current?.focus();
                  return;
                }
                publish();
              }}
              disabled={publishPending}
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
  ) : (
    <div className="rounded-md border bg-muted/30 p-3 text-sm">
      <p className="font-medium">Admin access required to publish</p>
      <p className="mt-1 text-muted-foreground">
        You can edit and save this draft. An organization admin must test the
        upstream, publish versions, and change listing visibility.
      </p>
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
                onApplyText={requestEditorReplacement}
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
            canAdminister={canAdminister}
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
      <Dialog
        open={pendingReplacement !== null}
        onOpenChange={(open) => {
          if (!open) setPendingReplacement(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace unsaved editor changes?</DialogTitle>
            <DialogDescription>
              Imported content replaces the editor. Your saved draft stays
              unchanged until the replacement is saved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPendingReplacement(null)}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (pendingReplacement) {
                  commitEditorReplacement(pendingReplacement);
                }
              }}
            >
              Replace editor
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open && blocker.status === "blocked") blocker.reset();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Leave with unsaved changes?</DialogTitle>
            <DialogDescription>
              {blocker.status === "blocked" ? (
                <>
                  Draft differs from saved version. Navigation to{" "}
                  <span className="font-mono">{blocker.next.pathname}</span> is
                  paused.
                </>
              ) : (
                "Draft differs from the saved version."
              )}
            </DialogDescription>
          </DialogHeader>
          {hasClientErrors && text.trim() !== "" ? (
            <p className="text-sm text-destructive">
              Draft has validation errors and cannot be saved yet.
            </p>
          ) : null}
          <DialogFooter className="sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                if (blocker.status === "blocked") blocker.reset();
              }}
            >
              Keep editing
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  if (blocker.status === "blocked") blocker.proceed();
                }}
              >
                Discard and leave
              </Button>
              <Button
                type="button"
                onClick={() => void saveThenLeave()}
                disabled={
                  savePending || (hasClientErrors && text.trim() !== "")
                }
              >
                {savePending ? "Saving…" : "Save and leave"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
