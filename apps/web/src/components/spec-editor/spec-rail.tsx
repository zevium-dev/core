import type { SpecIssue } from "@zevium/shared";
import { useEffect, useRef, useState, type ReactNode } from "react";

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
          Live from editor via OpenAPI paths + x-zevium-*.
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
        <CardDescription>
          Live client lint + server issues after save/publish.
        </CardDescription>
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
};

export type SpecRailVersionsProps = {
  versions: SpecVersionRow[];
  publishSlot: ReactNode;
  onSelectVersion?: (versionId: SpecVersionRow["_id"]) => void;
};

export function SpecRailVersions({
  versions,
  publishSlot,
  onSelectVersion,
}: SpecRailVersionsProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Versions</CardTitle>
        <CardDescription>
          Published snapshots (immutable). Publish freezes the saved draft.
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
              <li key={v._id}>
                <button
                  type="button"
                  onClick={() => onSelectVersion?.(v._id)}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-[background-color] duration-[var(--dur-instant)] ease-[var(--ease)] hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <span className="font-mono">v{v.version}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(v.publishedAt).toLocaleDateString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export type SpecRailVisibilityProps = {
  visibility: "public" | "private";
  onMakePublic: () => void;
  pending?: boolean;
};

export function SpecRailVisibilityNudge({
  visibility,
  onMakePublic,
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
        onClick={onMakePublic}
        disabled={pending}
      >
        {pending ? "Updating…" : "Make public"}
      </Button>
    </div>
  );
}
