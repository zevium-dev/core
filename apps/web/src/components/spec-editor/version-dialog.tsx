import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Skeleton } from "#/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { api } from "#/lib/convex-api";
import type { Id } from "#/lib/convex-data-model";
import { SpecDiff } from "./spec-diff";

import { JsonCodeEditor } from "./json-code-editor";

const PUBLISHED_AT_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

export type VersionDialogProps = {
  versionId: Id<"specVersions"> | null;
  /** Current SAVED draft — diff baseline target. */
  savedDraft: string;
  /** Editor text diverges from saved draft (gates restore confirmation). */
  dirty: boolean;
  onRestore: (spec: string) => void;
  onOpenChange: (open: boolean) => void;
};

export function VersionDialog({
  versionId,
  savedDraft,
  dirty,
  onRestore,
  onOpenChange,
}: VersionDialogProps) {
  return (
    <Dialog open={versionId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Published version</DialogTitle>
          <DialogDescription>
            Review an immutable snapshot or restore it into the current draft.
          </DialogDescription>
        </DialogHeader>
        {versionId !== null ? (
          <VersionDialogBody
            key={versionId}
            versionId={versionId}
            savedDraft={savedDraft}
            dirty={dirty}
            onRestore={onRestore}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type BodyProps = {
  versionId: Id<"specVersions">;
  savedDraft: string;
  dirty: boolean;
  onRestore: (spec: string) => void;
  onClose: () => void;
};

function VersionDialogBody({
  versionId,
  savedDraft,
  dirty,
  onRestore,
  onClose,
}: BodyProps) {
  const { data, isPending, isError, refetch } = useQuery(
    convexQuery(api.specs.getVersion, { versionId }),
  );
  const [confirming, setConfirming] = useState(false);

  if (isPending) {
    return (
      <Skeleton className="h-[28rem] w-full" aria-label="Loading version" />
    );
  }

  if (isError || data === undefined) {
    return (
      <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/10 p-4">
        <p className="font-medium text-destructive">
          Published version could not be loaded
        </p>
        <p className="text-sm text-muted-foreground">
          Check your connection and organization access, then retry.
        </p>
        <Button type="button" variant="outline" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  if (data === null) {
    return (
      <div className="space-y-3 rounded-md border border-dashed p-4">
        <p className="font-medium">Published version not found</p>
        <p className="text-sm text-muted-foreground">
          This version is unavailable in the selected organization. Close this
          dialog and choose another version.
        </p>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    );
  }

  const version = data;

  function handleRestore() {
    if (dirty && !confirming) {
      setConfirming(true);
      return;
    }
    onRestore(version.spec);
    onClose();
  }

  return (
    <>
      <p className="text-sm text-muted-foreground">
        <span className="font-mono font-medium text-foreground">
          v{version.version}
        </span>{" "}
        · Published {PUBLISHED_AT_FORMATTER.format(version.publishedAt)}.
      </p>

      <Tabs defaultValue="spec" className="w-full">
        <TabsList>
          <TabsTrigger value="spec">Spec</TabsTrigger>
          <TabsTrigger value="diff">Diff vs draft</TabsTrigger>
        </TabsList>
        <TabsContent value="spec">
          <JsonCodeEditor value={version.spec} readOnly />
        </TabsContent>
        <TabsContent value="diff">
          <SpecDiff original={version.spec} modified={savedDraft} />
        </TabsContent>
      </Tabs>

      <DialogFooter className="gap-2 sm:gap-2">
        {confirming ? (
          <>
            <span className="mr-auto text-sm text-muted-foreground">
              Replace current unsaved draft changes?
            </span>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button onClick={handleRestore}>Restore</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="outline" onClick={handleRestore}>
              Restore to draft
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}
