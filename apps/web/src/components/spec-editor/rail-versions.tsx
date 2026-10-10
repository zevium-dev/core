import { useConvexMutation } from "@convex-dev/react-query";
import { useMutation } from "@tanstack/react-query";
import { Archive, MoreHorizontal, RotateCcw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { api } from "#/lib/convex-api";
import type { Id } from "#/lib/convex-data-model";
import { humanError } from "#/lib/human-error";

import {
  DeprecateDialog,
  UndeprecateDialog,
} from "./version-lifecycle-dialogs";
const VERSION_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
export type SpecVersionRow = {
  _id: string;
  version: string;
  publishedAt: number;
  deprecatedAt?: number;
  sunsetAt?: number;
  deprecationMessage?: string;
};

export type SpecRailVersionsProps = {
  versions: SpecVersionRow[];
  publishSlot: ReactNode;
  canAdminister: boolean;
  onSelectVersion?: (versionId: SpecVersionRow["_id"]) => void;
};

export function SpecRailVersions({
  versions,
  publishSlot,
  canAdminister,
  onSelectVersion,
}: SpecRailVersionsProps) {
  const [deprecateTarget, setDeprecateTarget] = useState<SpecVersionRow | null>(
    null,
  );
  const [undeprecateTarget, setUndeprecateTarget] =
    useState<SpecVersionRow | null>(null);

  const deprecateMut = useConvexMutation(api.specs.deprecateVersion);
  const undeprecateMut = useConvexMutation(api.specs.undeprecateVersion);

  const { mutate: confirmDeprecate, isPending: deprecating } = useMutation({
    mutationFn: (input: {
      versionId: Id<"specVersions">;
      sunsetAt?: number;
      message: string;
    }) => deprecateMut(input),
    onSuccess: () => {
      setDeprecateTarget(null);
    },
    onError: (err: unknown) =>
      toast.error(humanError(err, "Could not deprecate version")),
  });

  const { mutate: confirmUndeprecate, isPending: undeprecating } = useMutation({
    mutationFn: (versionId: Id<"specVersions">) =>
      undeprecateMut({ versionId }),
    onSuccess: () => {
      setUndeprecateTarget(null);
    },
    onError: (err: unknown) =>
      toast.error(humanError(err, "Could not restore version")),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Versions</CardTitle>
        <CardDescription>
          Published versions never change. New edits stay in your draft.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {publishSlot}
        {versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No published versions yet.
          </p>
        ) : (
          <ul className="space-y-1">
            {versions.map((v) => (
              <VersionRow
                key={v._id}
                version={v}
                onSelect={onSelectVersion}
                onDeprecate={setDeprecateTarget}
                onUndeprecate={setUndeprecateTarget}
                canAdminister={canAdminister}
                busy={
                  (deprecating && deprecateTarget?._id === v._id) ||
                  (undeprecating && undeprecateTarget?._id === v._id)
                }
              />
            ))}
          </ul>
        )}
      </CardContent>

      <DeprecateDialog
        key={deprecateTarget?._id ?? "closed"}
        target={canAdminister ? deprecateTarget : null}
        pending={deprecating}
        onConfirm={(input) => confirmDeprecate(input)}
        onOpenChange={(open) => {
          if (!open && !deprecating) setDeprecateTarget(null);
        }}
      />
      <UndeprecateDialog
        target={canAdminister ? undeprecateTarget : null}
        pending={undeprecating}
        onConfirm={() => {
          if (undeprecateTarget !== null) {
            confirmUndeprecate(undeprecateTarget._id as Id<"specVersions">);
          }
        }}
        onOpenChange={(open) => {
          if (!open && !undeprecating) setUndeprecateTarget(null);
        }}
      />
    </Card>
  );
}

function VersionRow({
  version,
  onSelect,
  onDeprecate,
  onUndeprecate,
  canAdminister,
  busy,
}: {
  version: SpecVersionRow;
  onSelect?: (versionId: SpecVersionRow["_id"]) => void;
  onDeprecate: (row: SpecVersionRow) => void;
  onUndeprecate: (row: SpecVersionRow) => void;
  canAdminister: boolean;
  busy: boolean;
}) {
  const deprecated = version.deprecatedAt !== undefined;
  const sunsetReached =
    version.sunsetAt !== undefined && version.sunsetAt <= Date.now();

  return (
    <li>
      <div
        data-dep={deprecated}
        className="group flex items-center gap-1 rounded-md pl-2 pr-1 py-1.5 text-sm transition-[background-color] duration-[var(--dur-instant)] ease-[var(--ease)] hover:bg-accent data-[dep=true]:opacity-70"
      >
        <button
          type="button"
          onClick={() => onSelect?.(version._id)}
          className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-sm"
        >
          <span className="font-mono">{version.version}</span>
          {deprecated ? (
            <Badge
              variant="outline"
              className="border-warning/40 bg-warning/10 text-warning-foreground"
            >
              Deprecated
            </Badge>
          ) : null}
        </button>
        <span className="shrink-0 text-xs text-muted-foreground">
          {VERSION_DATE_FORMATTER.format(version.publishedAt)}
        </span>
        {canAdminister ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"

                className="size-7 shrink-0 transition-opacity duration-[var(--dur-instant)] ease-[var(--ease)] [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                disabled={busy}
                aria-label={`Actions for version ${version.version}`}
              >
                <MoreHorizontal aria-hidden="true" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              {deprecated ? (
                <DropdownMenuItem
                  disabled={sunsetReached}
                  onClick={() => onUndeprecate(version)}
                >
                  <RotateCcw aria-hidden="true" className="size-4" />
                  {sunsetReached ? "Migration date passed" : "Undeprecate"}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => onDeprecate(version)}>
                  <Archive aria-hidden="true" className="size-4" />
                  Deprecate…
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </li>
  );
}
