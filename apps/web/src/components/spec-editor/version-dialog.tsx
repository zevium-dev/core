import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

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
import { lineDiff, type DiffLine } from "#/lib/line-diff";
import { cn } from "#/lib/utils";

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
        {versionId !== null ? (
          <VersionDialogBody
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
  const { data, isPending } = useQuery(
    convexQuery(api.specs.getVersion, { versionId }),
  );
  const [confirming, setConfirming] = useState(false);

  const diff = useMemo<DiffLine[] | null>(
    () => (data ? lineDiff(data.spec, savedDraft) : null),
    [data, savedDraft],
  );

  if (isPending || data === undefined || diff === null) {
    return <Skeleton className="h-[32rem] w-full" />;
  }

  function handleRestore() {
    if (dirty && !confirming) {
      setConfirming(true);
      return;
    }
    onRestore(data!.spec);
    onClose();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-mono">v{data.version}</DialogTitle>
        <DialogDescription>
          Published {PUBLISHED_AT_FORMATTER.format(data.publishedAt)}.
        </DialogDescription>
      </DialogHeader>

      <Tabs defaultValue="spec" className="w-full">
        <TabsList>
          <TabsTrigger value="spec">Spec</TabsTrigger>
          <TabsTrigger value="diff">Diff vs draft</TabsTrigger>
        </TabsList>
        <TabsContent value="spec">
          <JsonCodeEditor value={data.spec} readOnly />
        </TabsContent>
        <TabsContent value="diff">
          <DiffView lines={diff} />
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

function DiffView({ lines }: { lines: DiffLine[] }) {
  if (lines.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Identical to the saved draft.
      </p>
    );
  }
  return (
    <div className="max-h-[32rem] overflow-auto rounded-md border border-border bg-background font-mono text-xs">
      {lines.map((line, i) => {
        const isAdd = line.type === "added";
        const isRemove = line.type === "removed";
        return (
          <div
            key={i}
            className={cn(
              "flex gap-2 whitespace-pre px-2 py-px",
              isAdd && "bg-primary/10 text-foreground",
              isRemove && "bg-destructive/10 text-destructive",
              !isAdd && !isRemove && "text-muted-foreground",
            )}
          >
            <span className="w-3 shrink-0 select-none text-center">
              {isAdd ? "+" : isRemove ? "-" : " "}
            </span>
            <span className="whitespace-pre">{line.text}</span>
          </div>
        );
      })}
    </div>
  );
}
