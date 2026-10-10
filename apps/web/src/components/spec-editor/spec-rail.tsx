import type { SpecIssue } from "@zevium/shared";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";

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
          Fix errors before publishing. Review warnings for possible issues.
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
