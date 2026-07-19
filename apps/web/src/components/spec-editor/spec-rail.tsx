import type { SpecIssue } from "@zevium/shared";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, MoreHorizontal, RotateCcw } from "lucide-react";
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
import { Input } from "#/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Label } from "#/components/ui/label";
import { api } from "#/lib/convex-api";
import type { Id } from "#/lib/convex-data-model";
import { humanError } from "#/lib/human-error";
import type { SpecEndpointRow } from "#/lib/spec-endpoints";
import type { PricingEdit } from "#/lib/spec-pricing-edit";

const METHOD_VARIANT: Record<
  string,
  "default" | "secondary" | "outline" | "destructive"
> = {
  get: "secondary",
  post: "default",
  put: "outline",
  patch: "outline",
  delete: "destructive",
};

export type SpecRailEndpointsProps = {
  endpoints: SpecEndpointRow[];
  stale: boolean;
  /** Disable pricing inputs (e.g. editor text is invalid JSON). */
  disabled?: boolean;
  /** Debounced write-back into the editor text. */
  onPricingChange?: (edit: PricingEdit) => void;
};

type EndpointInputValue = { cost: string; freeTier: string };

const PRICING_DEBOUNCE_MS = 300;

function endpointKey(method: string, path: string): string {
  return `${method}:${path}`;
}

function valueFromEndpoint(ep: SpecEndpointRow): EndpointInputValue {
  return {
    cost: String(ep.cost),
    freeTier: ep.freeTier === undefined ? "" : String(ep.freeTier),
  };
}

export function SpecRailEndpoints({
  endpoints,
  stale,
  disabled = false,
  onPricingChange,
}: SpecRailEndpointsProps) {
  const editable = onPricingChange !== undefined && !disabled;

  const [values, setValues] = useState<Record<string, EndpointInputValue>>(
    () => {
      const init: Record<string, EndpointInputValue> = {};
      for (const ep of endpoints) {
        init[endpointKey(ep.method, ep.path)] = valueFromEndpoint(ep);
      }
      return init;
    },
  );

  // Unflushed local edits, keyed by endpoint. Guards against the rail
  // re-deriving from its own write-back and clobbering in-flight input.
  const pendingEdits = useRef<Map<string, PricingEdit>>(new Map());
  const pendingKeys = useRef<Set<string>>(new Set());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  // Resync inputs from the prop, but never overwrite an unflushed local edit.
  useEffect(() => {
    setValues((prev) => {
      const next: Record<string, EndpointInputValue> = {};
      for (const ep of endpoints) {
        const key = endpointKey(ep.method, ep.path);
        next[key] =
          pendingKeys.current.has(key) && prev[key] !== undefined
            ? prev[key]
            : valueFromEndpoint(ep);
      }
      return next;
    });
  }, [endpoints]);

  useEffect(() => {
    return () => {
      clearTimeout(flushTimer.current);
    };
  }, []);

  function handleField(
    ep: SpecEndpointRow,
    field: "cost" | "freeTier",
    raw: string,
  ): void {
    const key = endpointKey(ep.method, ep.path);
    setValues((prev) => ({
      ...prev,
      [key]: {
        cost: prev[key]?.cost ?? "",
        freeTier: prev[key]?.freeTier ?? "",
        [field]: raw,
      },
    }));

    // Map raw input to a pricing value: empty -> delete, numeric -> set,
    // non-numeric -> display-only (no write-back).
    const trimmed = raw.trim();
    let value: number | null;
    if (trimmed === "") {
      value = null;
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return;
      value = n;
    }

    const base =
      pendingEdits.current.get(key) ??
      ({ path: ep.path, method: ep.method } as PricingEdit);
    const edit: PricingEdit = { ...base, [field]: value };
    pendingEdits.current.set(key, edit);
    pendingKeys.current.add(key);

    clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => {
      flushTimer.current = undefined;
      const edits = [...pendingEdits.current.values()];
      pendingEdits.current.clear();
      pendingKeys.current.clear();
      for (const e of edits) onPricingChange?.(e);
    }, PRICING_DEBOUNCE_MS);
  }

  return (
    <Card className={stale ? "opacity-80" : undefined}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Endpoints</CardTitle>
          {stale ? (
            <Badge variant="outline">stale</Badge>
          ) : (
            <Badge variant="secondary">{endpoints.length}</Badge>
          )}
        </div>
        <CardDescription>
          Endpoints and pricing parsed from your current draft.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {disabled ? (
          <p className="text-xs text-muted-foreground">
            Fix errors to edit pricing.
          </p>
        ) : null}
        {endpoints.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No endpoints yet. Add paths with methods.
          </p>
        ) : (
          <ul className="max-h-80 space-y-2 overflow-y-auto">
            {endpoints.map((ep) => {
              const key = endpointKey(ep.method, ep.path);
              const v = values[key] ?? valueFromEndpoint(ep);
              return (
                <li
                  key={key}
                  className="flex items-start justify-between gap-2 text-sm"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge
                        variant={METHOD_VARIANT[ep.method] ?? "outline"}
                        className="font-mono uppercase"
                      >
                        {ep.method}
                      </Badge>
                      <span className="truncate font-mono text-xs">
                        {ep.path}
                      </span>
                    </div>
                    {ep.summary ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {ep.summary}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span className="tabular-nums">cr</span>
                      <Input
                        value={v.cost}
                        onChange={(e) =>
                          handleField(ep, "cost", e.target.value)
                        }
                        disabled={!editable}
                        inputMode="decimal"
                        aria-label={`Cost for ${ep.method.toUpperCase()} ${ep.path}`}
                        className="h-7 w-16 text-right font-mono text-xs"
                      />
                    </label>
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span className="tabular-nums">free/day</span>
                      <Input
                        value={v.freeTier}
                        onChange={(e) =>
                          handleField(ep, "freeTier", e.target.value)
                        }
                        disabled={!editable}
                        inputMode="decimal"
                        placeholder="0"
                        aria-label={`Free tier for ${ep.method.toUpperCase()} ${ep.path}`}
                        className="h-7 w-16 text-right font-mono text-xs"
                      />
                    </label>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export type SpecRailValidationProps = {
  issues: SpecIssue[];
};

export function SpecRailValidation({ issues }: SpecRailValidationProps) {
  const errorCount = issues.filter((i) => i.level === "error").length;
  const warningCount = issues.filter((i) => i.level === "warning").length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Validation</CardTitle>
          {issues.length > 0 ? (
            <Badge variant={errorCount > 0 ? "destructive" : "secondary"}>
              {errorCount > 0
                ? `${errorCount} error${errorCount === 1 ? "" : "s"}`
                : `${warningCount} warning${warningCount === 1 ? "" : "s"}`}
            </Badge>
          ) : (
            <Badge variant="outline">Clean</Badge>
          )}
        </div>
        <CardDescription>Fix these issues before publishing.</CardDescription>
      </CardHeader>
      <CardContent>
        {issues.length === 0 ? (
          <p className="text-sm text-muted-foreground">No issues.</p>
        ) : (
          <ul className="max-h-64 space-y-3 overflow-y-auto">
            {issues.map((issue, i) => (
              <li key={`${issue.level}-${issue.path}-${i}`} className="text-sm">
                <div className="flex items-start gap-2">
                  <Badge
                    variant={
                      issue.level === "error" ? "destructive" : "secondary"
                    }
                    className="mt-0.5"
                  >
                    {issue.level}
                  </Badge>
                  <div className="min-w-0">
                    <p className="break-words">{issue.message}</p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {issue.path}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export type SpecVersionRow = {
  _id: string;
  version: string;
  publishedAt: number;
  deprecatedAt: number | undefined;
  sunsetAt: number | undefined;
  deprecationMessage: string | undefined;
};

export type SpecRailVersionsProps = {
  versions: SpecVersionRow[];
  publishSlot: ReactNode;
  projectId: Id<"projects">;
  onSelectVersion?: (versionId: SpecVersionRow["_id"]) => void;
};

export function SpecRailVersions({
  versions,
  publishSlot,
  projectId,
  onSelectVersion,
}: SpecRailVersionsProps) {
  const queryClient = useQueryClient();
  const [deprecateTarget, setDeprecateTarget] = useState<SpecVersionRow | null>(
    null,
  );
  const [undeprecateTarget, setUndeprecateTarget] =
    useState<SpecVersionRow | null>(null);

  const deprecateMut = useConvexMutation(api.specs.deprecateVersion);
  const undeprecateMut = useConvexMutation(api.specs.undeprecateVersion);

  async function invalidateVersions() {
    await queryClient.invalidateQueries({
      queryKey: convexQuery(api.specs.listVersions, { projectId }).queryKey,
    });
  }

  const { mutate: confirmDeprecate, isPending: deprecating } = useMutation({
    mutationFn: (input: {
      versionId: Id<"specVersions">;
      sunsetAt?: number;
      message?: string;
    }) => deprecateMut(input),
    onSuccess: async () => {
      toast.success("Version deprecated");
      setDeprecateTarget(null);
      await invalidateVersions();
    },
    onError: (err: unknown) =>
      toast.error(humanError(err, "Could not deprecate version")),
  });

  const { mutate: confirmUndeprecate, isPending: undeprecating } = useMutation({
    mutationFn: (versionId: Id<"specVersions">) =>
      undeprecateMut({ versionId }),
    onSuccess: async () => {
      toast.success("Version restored");
      setUndeprecateTarget(null);
      await invalidateVersions();
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
        target={deprecateTarget}
        pending={deprecating}
        onConfirm={(input) => confirmDeprecate(input)}
        onOpenChange={(open) => {
          if (!open && !deprecating) setDeprecateTarget(null);
        }}
      />
      <UndeprecateDialog
        target={undeprecateTarget}
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
  busy,
}: {
  version: SpecVersionRow;
  onSelect?: (versionId: SpecVersionRow["_id"]) => void;
  onDeprecate: (row: SpecVersionRow) => void;
  onUndeprecate: (row: SpecVersionRow) => void;
  busy: boolean;
}) {
  const deprecated = version.deprecatedAt !== undefined;

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
          {new Date(version.publishedAt).toLocaleDateString()}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 opacity-0 transition-opacity duration-[var(--dur-instant)] ease-[var(--ease)] group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
              disabled={busy}
              aria-label={`Actions for version ${version.version}`}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            {deprecated ? (
              <DropdownMenuItem onClick={() => onUndeprecate(version)}>
                <RotateCcw className="size-4" />
                Undeprecate
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => onDeprecate(version)}>
                <Archive className="size-4" />
                Deprecate…
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

function DeprecateDialog({
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
    message?: string;
  }) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [sunsetDate, setSunsetDate] = useState("");
  const [message, setMessage] = useState("");

  // Reset the form whenever a new target opens.
  useEffect(() => {
    if (target !== null) {
      setSunsetDate("");
      setMessage("");
    }
  }, [target]);

  // Date.parse yields NaN on garbage; coerce to undefined for the mutation.
  const parsedSunset =
    sunsetDate.length > 0 ? Date.parse(`${sunsetDate}T00:00:00Z`) : NaN;
  const sunsetAt: number | undefined = Number.isNaN(parsedSunset)
    ? undefined
    : parsedSunset;
  const sunsetValid = sunsetDate.length === 0 || !Number.isNaN(parsedSunset);

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
            Marks this published version as deprecated. The spec body stays
            immutable; only deprecation metadata changes. Consumers see a
            warning banner.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="deprecate-sunset">Sunset date (optional)</Label>
            <Input
              id="deprecate-sunset"
              type="date"
              value={sunsetDate}
              onChange={(e) => setSunsetDate(e.target.value)}
              disabled={pending}
            />
            {!sunsetValid ? (
              <p className="text-xs text-destructive">Invalid date.</p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="deprecate-message">Message (optional)</Label>
            <textarea
              id="deprecate-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={500}
              rows={3}
              disabled={pending}
              placeholder="Migration guidance or replacement version."
              className="flex min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            />
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
            disabled={pending || !sunsetValid}
            onClick={() => {
              if (target === null) return;
              onConfirm({
                versionId: target._id as Id<"specVersions">,
                sunsetAt,
                message: message.trim().length > 0 ? message.trim() : undefined,
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

function UndeprecateDialog({
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
            Clears deprecation metadata. The version returns to normal in the
            catalogue and consumer banner.
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

export type SpecRailVisibilityProps = {
  visibility: "public" | "private";
  onRequestMakePublic: () => void;
  pending?: boolean;
};

export function SpecRailVisibilityNudge({
  visibility,
  onRequestMakePublic,
  pending,
}: SpecRailVisibilityProps) {
  if (visibility !== "private") return null;
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
      <p className="text-muted-foreground">
        Project is private — publishing won&apos;t list it in the catalogue
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2"
        onClick={onRequestMakePublic}
        disabled={pending}
      >
        {pending ? "Updating…" : "Make public"}
      </Button>
    </div>
  );
}
