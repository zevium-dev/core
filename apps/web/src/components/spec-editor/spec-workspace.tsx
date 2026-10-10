import { useBlocker } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { SpecRailEndpoints } from "./rail-endpoints";
import { SpecRailVersions } from "./rail-versions";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import type { Id } from "#/lib/convex-data-model";
import { listSpecEndpoints } from "#/lib/spec-endpoints";
import { formatPricingSummary, summarizeEndpoints } from "#/lib/spec-pricing";

import { EditorToolbar } from "./editor-toolbar";
import { JsonCodeEditor } from "./json-code-editor";
import { SpecRailValidation } from "./spec-rail";
import { OPENAPI_TEMPLATE } from "./template";
import { VersionDialog } from "./version-dialog";

import { DraftConflictDialog } from "./draft-conflict-dialog";
import { DraftDialogs } from "./draft-dialogs";
import { PublishPanel } from "./publish-panel";
import { SaveStatusLabel } from "./save-status-label";
import { useSpecDraft } from "./use-spec-draft";
import { useYamlEditorChange } from "./use-yaml-editor-change";
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
    deprecatedAt?: number;
    sunsetAt?: number;
    deprecationMessage?: string;
  }>;
};

export function SpecWorkspace(props: SpecWorkspaceProps) {
  const { versions, canAdminister, savedDraft } = props;
  const draft = useSpecDraft(props);
  const {
    text,
    dirty,
    savePending,
    hasClientErrors,
    confirmedDraft,
    confirmedDraftHash,
    lastSavedAt,
    autosaveTripped,
    conflict,
    issues,
    edit,
    save,
    reload,
    overwrite,
    setServerIssues,
  } = draft;
  const [pendingReplacement, setPendingReplacement] = useState<string | null>(
    null,
  );
  const [versionDialogId, setVersionDialogId] =
    useState<Id<"specVersions"> | null>(null);
  const endpoints = useMemo(() => listSpecEndpoints(text), [text]);
  const [lastEndpoints, setLastEndpoints] = useState(endpoints ?? []);
  if (endpoints !== null && endpoints !== lastEndpoints)
    setLastEndpoints(endpoints);
  const goodEndpoints = endpoints ?? lastEndpoints;
  const pricing = useMemo(
    () => (endpoints === null ? null : summarizeEndpoints(endpoints)),
    [endpoints],
  );
  const { onChange: onEditorChange, cancel: cancelYaml } =
    useYamlEditorChange(edit);
  function commitEditorReplacement(replacement: string) {
    onEditorChange(replacement);
    setPendingReplacement(null);
  }
  function requestEditorReplacement(replacement: string) {
    if (dirty) setPendingReplacement(replacement);
    else commitEditorReplacement(replacement);
  }
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: dirty,
    withResolver: true,
  });
  async function saveThenLeave() {
    if (blocker.status !== "blocked") return;
    const proceed = blocker.proceed;
    const saved = await draft.saveAsync();
    if (saved) proceed();
  }
  const publishSlot = canAdminister ? (
    <PublishPanel
      {...props}
      text={text}
      dirty={dirty || conflict !== null}
      savePending={savePending}
      hasClientErrors={hasClientErrors}
      confirmedDraft={confirmedDraft}
      confirmedDraftHash={confirmedDraftHash}
      pricing={pricing}
      endpointCount={goodEndpoints.length}
      onIssues={setServerIssues}
    />
  ) : (
    <p className="text-sm text-muted-foreground">
      You can edit and save this draft. An organization admin must test the
      upstream, publish versions, and change listing visibility.
    </p>
  );
  return (
    <>
      {conflict !== null ? (
        <DraftConflictDialog
          key={conflict.hash ?? "missing"}
          pending={savePending}
          hasClientErrors={hasClientErrors}
          onReload={() => {
            cancelYaml();
            reload();
          }}
          onOverwrite={overwrite}
        />
      ) : null}
      {autosaveTripped && conflict === null ? (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span>
            Autosave paused after repeated save failures. Edit the spec to
            resume, or retry manually.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              save();
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
              <SaveStatusLabel
                dirty={dirty}
                saving={savePending}
                hasClientErrors={hasClientErrors}
                lastSavedAt={lastSavedAt}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                disabled={
                  !dirty ||
                  conflict !== null ||
                  savePending ||
                  (hasClientErrors && text.trim() !== "")
                }
                onClick={() => save()}
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
            stale={endpoints === null}
            disabled={endpoints === null}
            onPricingChange={(change) => {
              cancelYaml();
              draft.applyPricingChange(change);
            }}
          />
          <SpecRailValidation issues={issues} />
          <SpecRailVersions
            versions={versions}
            publishSlot={publishSlot}
            canAdminister={canAdminister}
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
          onEditorChange(spec);
        }}
        onOpenChange={(open) => {
          if (!open) setVersionDialogId(null);
        }}
      />
      <DraftDialogs
        pendingReplacement={pendingReplacement}
        setPendingReplacement={setPendingReplacement}
        commitEditorReplacement={commitEditorReplacement}
        blocker={blocker}
        hasClientErrors={hasClientErrors}
        text={text}
        savePending={savePending}
        conflict={conflict !== null}
        saveThenLeave={() => void saveThenLeave()}
      />
    </>
  );
}
