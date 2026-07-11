import type { SpecIssue } from "@zevium/shared";
import type { ReactNode } from "react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import type { SpecEndpointRow } from "#/lib/spec-endpoints";

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
};

export function SpecRailEndpoints({
  endpoints,
  stale,
}: SpecRailEndpointsProps) {
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
        {endpoints.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No endpoints yet. Add paths with methods.
          </p>
        ) : (
          <ul className="max-h-64 space-y-2 overflow-y-auto">
            {endpoints.map((ep) => (
              <li
                key={`${ep.method}:${ep.path}`}
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
                <div className="shrink-0 text-right text-xs text-muted-foreground">
                  <div>{ep.cost} cr</div>
                  {ep.freeTier !== undefined ? (
                    <div>{ep.freeTier} free/day</div>
                  ) : null}
                </div>
              </li>
            ))}
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
};

export function SpecRailVersions({
  versions,
  publishSlot,
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
          <ul className="space-y-2">
            {versions.map((v) => (
              <li
                key={v._id}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span className="font-mono">v{v.version}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(v.publishedAt).toLocaleDateString()}
                </span>
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
