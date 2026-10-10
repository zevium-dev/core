import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type SpecIssue } from "@zevium/shared";
import { useAction } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { PublishVersionDialog } from "./publish-version-dialog";

import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { api } from "#/lib/convex-api";
import { humanError } from "#/lib/human-error";
import { formatPricingSummary } from "#/lib/spec-pricing";
import { canTestSavedDraft } from "#/lib/spec-readiness";

import { SpecRailVisibilityNudge } from "./spec-rail";

import type { PricingSummary } from "#/lib/spec-pricing";
import type { SpecWorkspaceProps } from "./spec-workspace";
type PublishPanelProps = Pick<
  SpecWorkspaceProps,
  "projectId" | "projectSlug" | "visibility" | "description" | "versions"
> & {
  text: string;
  dirty: boolean;
  savePending: boolean;
  hasClientErrors: boolean;
  confirmedDraft: string;
  confirmedDraftHash: string | null;
  pricing: PricingSummary | null;
  endpointCount: number;
  onIssues: (issues: SpecIssue[]) => void;
};
export function PublishPanel({
  projectId,
  projectSlug,
  visibility,
  description,
  versions,
  text,
  dirty,
  savePending,
  hasClientErrors,
  confirmedDraft,
  confirmedDraftHash,
  pricing,
  endpointCount,
  onIssues,
}: PublishPanelProps) {
  const [makePublicOpen, setMakePublicOpen] = useState(false);
  const updateProject = useConvexMutation(api.projects.update);
  const testConnection = useAction(api.publishReadinessAction.testConnection);
  const persistedReadiness = useQuery(
    convexQuery(api.publishReadiness.getCurrent, { projectId }),
  );
  const readinessCurrent = !dirty && persistedReadiness.data?.current === true;
  const savedFingerprintMatchesEditor = canTestSavedDraft(
    text,
    { text: confirmedDraft, hash: confirmedDraftHash },
    savePending,
    hasClientErrors,
  );

  const { mutate: makePublic, isPending: visibilityPending } = useMutation({
    mutationFn: () =>
      updateProject({
        projectId,
        patch: { visibility: "public" },
      }),
    onSuccess: () => {
      setMakePublicOpen(false);
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not update visibility"));
    },
  });

  const connectionMutation = useMutation({
    mutationFn: (draft: string) =>
      testConnection({ projectId }).then((result) => ({ ...result, draft })),
    onSuccess: (result) => {
      if (result.status === "ready") {
        toast.success(
          result.latencyMs === undefined
            ? "Declared health endpoint is ready"
            : `Declared health endpoint is ready in ${result.latencyMs} ms`,
        );
      }
    },
    onError: (err: unknown) => {
      const message = humanError(err, "Could not test the upstream connection");
      toast.error(message);
    },
  });

  const connectionPending = connectionMutation.isPending;
  const verifyConnection = () => connectionMutation.mutate(text);
  const connectionResult =
    connectionMutation.data?.draft === text &&
    !dirty &&
    (connectionMutation.data.status !== "ready" || readinessCurrent)
      ? connectionMutation.data
      : null;
  const hasDescription = description !== undefined && description.trim() !== "";
  const checklist = [
    {
      label: "Valid saved spec",
      complete: !dirty && !hasClientErrors && text.trim() !== "",
      detail: dirty
        ? "Save the current draft before publishing."
        : hasClientErrors
          ? "Fix the errors in the Validation panel."
          : "A valid OpenAPI draft is saved.",
    },
    {
      label: "Health endpoint",
      complete: readinessCurrent,
      detail:
        connectionResult?.message ??
        (readinessCurrent
          ? "A passing health check is saved for this draft and credential configuration."
          : persistedReadiness.data?.reason === "expired"
            ? "Saved passing test expired. Run it again."
            : persistedReadiness.data?.reason === "draft_changed"
              ? "Saved draft changed after the passing test. Run it again."
              : persistedReadiness.data?.reason === "credentials_changed"
                ? "Credentials changed after the passing test. Run it again."
                : persistedReadiness.data?.readiness
                  ? "Saved test is no longer valid. Run it again."
                  : "Opt in one safe GET or HEAD operation with x-zevium-health-check, then test its reachability."),
    },
    {
      label: "Health check safety",
      complete:
        connectionResult === null || connectionResult.status === "ready",
      detail:
        "The health check runs without credentials. Declare a safe GET or HEAD operation with no parameters.",
    },
    {
      label: "Pricing",
      complete: pricing !== null && endpointCount > 0,
      detail:
        pricing === null
          ? "Fix the pricing fields in the spec."
          : endpointCount === 0
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
      complete: endpointCount > 0 && !hasClientErrors,
      detail:
        endpointCount > 0 && !hasClientErrors
          ? "A mock response will be available after publication."
          : "Fix the spec and add an operation to enable the mock preview.",
    },
  ];

  return (
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
            {connectionPending ? "Testing…" : "Test health endpoint"}
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
          Add a description so consumers know what this API does.{" "}
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
      <PublishVersionDialog
        projectId={projectId}
        versions={versions}
        canPublish={
          !dirty && !savePending && !hasClientErrors && readinessCurrent
        }
        readinessCurrent={readinessCurrent}
        onIssues={onIssues}
      />
      {dirty ? (
        <p className="text-xs text-muted-foreground">
          Save draft before publishing.
        </p>
      ) : null}
    </div>
  );
}
