import { useConvexMutation } from "@convex-dev/react-query";
import { useMutation } from "@tanstack/react-query";
import { isValidSemver, type SpecIssue } from "@zevium/shared";
import { useRef, useState } from "react";
import { toast } from "sonner";

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
import { humanError } from "#/lib/human-error";

import type { SpecWorkspaceProps } from "./spec-workspace";
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

type PublishVersionDialogProps = Pick<
  SpecWorkspaceProps,
  "projectId" | "versions"
> & {
  canPublish: boolean;
  readinessCurrent: boolean;
  onIssues: (issues: SpecIssue[]) => void;
};
export function PublishVersionDialog({
  projectId,
  versions,
  canPublish,
  readinessCurrent,
  onIssues,
}: PublishVersionDialogProps) {
  const [publishOpen, setPublishOpen] = useState(false);
  const [versionTouched, setVersionTouched] = useState(false);
  const [versionInput, setVersion] = useState<string | undefined>();
  const version =
    versionInput ?? defaultNextVersion(versions.map((v) => v.version));
  const versionInputRef = useRef<HTMLInputElement>(null);
  const publishFn = useConvexMutation(api.specs.publish);
  const { mutate: publish, isPending: publishPending } = useMutation({
    mutationFn: () =>
      publishFn({
        projectId,
        version: version.trim(),
      }),
    onSuccess: (result) => {
      onIssues(result.issues);
      if (!result.ok) {
        const first = result.issues.find((i) => i.level === "error");
        toast.error(first?.message ?? "Publish failed — check issues");
        return;
      }
      setPublishOpen(false);
      setVersion(undefined);
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not publish"));
    },
  });

  const normalizedVersion = version.trim();
  const versionError =
    normalizedVersion === ""
      ? "Enter a version."
      : !isValidSemver(normalizedVersion)
        ? "Use semantic versioning, for example 1.2.0 or 1.2.0-beta.1."
        : versions.some((item) => item.version === normalizedVersion)
          ? `Version ${normalizedVersion} is already published.`
          : null;
  return (
    <Dialog
      open={publishOpen}
      onOpenChange={(open) => {
        setPublishOpen(open);
        if (!open) setVersionTouched(false);
      }}
    >
      <DialogTrigger asChild>
        <Button className="w-full" disabled={!canPublish}>
          {readinessCurrent ? "Publish" : "Test health endpoint to publish"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish version</DialogTitle>
          <DialogDescription>
            Publish the saved draft as a version that cannot be edited. Use
            semantic versioning, such as 0.1.0.
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
            disabled={publishPending || !canPublish}
          >
            {publishPending ? "Publishing…" : "Publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
