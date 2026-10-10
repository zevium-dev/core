import { useBlocker } from "@tanstack/react-router";

import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";

type DraftDialogsProps = {
  pendingReplacement: string | null;
  setPendingReplacement: (value: string | null) => void;
  commitEditorReplacement: (value: string) => void;
  blocker: ReturnType<typeof useBlocker>;
  hasClientErrors: boolean;
  text: string;
  savePending: boolean;
  conflict: boolean;
  saveThenLeave: () => void;
};
export function DraftDialogs({
  pendingReplacement,
  setPendingReplacement,
  commitEditorReplacement,
  blocker,
  hasClientErrors,
  text,
  savePending,
  conflict,
  saveThenLeave,
}: DraftDialogsProps) {
  return (
    <>
      {" "}
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
                onClick={saveThenLeave}
                disabled={
                  conflict ||
                  savePending ||
                  (hasClientErrors && text.trim() !== "")
                }
              >
                {conflict
                  ? "Resolve draft conflict first"
                  : savePending
                    ? "Saving…"
                    : "Save and leave"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
