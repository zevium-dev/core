import { useState } from "react";
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

export function DraftConflictDialog({
  pending,
  hasClientErrors,
  onReload,
  onOverwrite,
}: {
  pending: boolean;
  hasClientErrors: boolean;
  onReload: () => void;
  onOverwrite: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">Resolve draft conflict</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Draft changed in another session</DialogTitle>
          <DialogDescription>
            Your edits are preserved and autosave is paused. Reload the saved
            draft or explicitly overwrite it with your editor contents.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Keep editing
          </Button>
          <Button variant="outline" onClick={onReload} disabled={pending}>
            Reload saved draft
          </Button>
          <Button onClick={onOverwrite} disabled={pending || hasClientErrors}>
            {pending ? "Saving…" : "Overwrite saved draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
