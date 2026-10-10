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
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import type { Id } from "#/lib/convex-data-model";

import type { SpecVersionRow } from "./rail-versions";
const MIN_VERSION_SUNSET_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;
export function DeprecateDialog({
  target,
  pending,
  onConfirm,
  onOpenChange,
}: {
  target: SpecVersionRow | null;
  pending: boolean;
  onConfirm: (input: {
    versionId: Id<"specVersions">;
    sunsetAt?: number;
    message: string;
  }) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [sunsetDate, setSunsetDate] = useState("");
  const [message, setMessage] = useState("");

  // Date.parse yields NaN on garbage; coerce to undefined for the mutation.
  const parsedSunset =
    sunsetDate.length > 0 ? Date.parse(`${sunsetDate}T00:00:00Z`) : NaN;
  const sunsetAt: number | undefined = Number.isNaN(parsedSunset)
    ? undefined
    : parsedSunset;
  const minimumSunset = Date.now() + MIN_VERSION_SUNSET_NOTICE_MS;
  const sunsetValid =
    sunsetDate.length === 0 ||
    (!Number.isNaN(parsedSunset) && parsedSunset >= minimumSunset);
  const messageValue = message.trim();
  const messageValid = messageValue.length > 0 && messageValue.length <= 1000;
  const minSunsetDate = new Date(minimumSunset + 86_400_000)
    .toISOString()
    .slice(0, 10);

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!pending) onOpenChange(open);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deprecate version {target?.version ?? ""}</DialogTitle>
          <DialogDescription>
            Add a migration notice to this version. The published spec stays
            unchanged. To stop live calls, schedule project retirement in
            Settings.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="deprecate-sunset">Migration date (optional)</Label>
            <Input
              id="deprecate-sunset"
              name="sunset-date"
              type="date"
              min={minSunsetDate}
              autoComplete="off"
              value={sunsetDate}
              onChange={(e) => setSunsetDate(e.target.value)}
              disabled={pending}
              aria-describedby="deprecate-sunset-help"
              aria-invalid={sunsetDate.length > 0 && !sunsetValid}
            />
            <p
              id="deprecate-sunset-help"
              role="status"
              aria-live="polite"
              className={
                sunsetValid
                  ? "text-xs text-muted-foreground"
                  : "text-xs text-destructive"
              }
            >
              {!sunsetValid
                ? "Sunset must be at least 7 days away."
                : "Optional target date for migration, at least 7 days away. This date alone does not stop live calls."}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="deprecate-message">Migration message</Label>
            <Textarea
              id="deprecate-message"
              name="deprecation-message"
              autoComplete="off"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={1000}
              rows={3}
              disabled={pending}
              placeholder="e.g. Use /v2/summarize; rename text to input…"
              className="min-h-20"
              aria-describedby="deprecate-message-help"
              aria-invalid={message.length > 0 && !messageValid}
            />
            <p
              id="deprecate-message-help"
              role="status"
              aria-live="polite"
              className={
                !messageValid && message.length > 0
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {!messageValid && message.length > 0
                ? "Enter migration guidance, not whitespace."
                : "Required. Tell consumers where to migrate and what changes they need to make."}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending || !sunsetValid || !messageValid}
            onClick={() => {
              if (target === null) return;
              onConfirm({
                versionId: target._id as Id<"specVersions">,
                sunsetAt,
                message: messageValue,
              });
            }}
          >
            {pending ? "Deprecating…" : "Deprecate version"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UndeprecateDialog({
  target,
  pending,
  onConfirm,
  onOpenChange,
}: {
  target: SpecVersionRow | null;
  pending: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!pending) onOpenChange(open);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore version {target?.version ?? ""}?</DialogTitle>
          <DialogDescription>
            Remove this version’s migration notice and deprecation status.
            Project retirement, if scheduled, is managed separately in Settings.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={pending}>
            {pending ? "Restoring…" : "Restore version"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
