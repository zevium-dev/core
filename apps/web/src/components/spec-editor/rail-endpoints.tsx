import { useState } from "react";

import { Badge } from "#/components/ui/badge";
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
  /** Immediate write-back into the editor text. */
  onPricingChange?: (edit: PricingEdit) => void;
};

export function SpecRailEndpoints({
  endpoints,
  stale,
  disabled = false,
  onPricingChange,
}: SpecRailEndpointsProps) {
  const editable = onPricingChange !== undefined && !disabled;

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
              const key = `${ep.method}:${ep.path}`;
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
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span className="tabular-nums">cr</span>
                      <PricingInput
                        value={ep.cost}
                        onValueChange={(value) =>
                          onPricingChange?.({
                            path: ep.path,
                            method: ep.method,
                            cost: value,
                          })
                        }
                        disabled={!editable}
                        inputMode="decimal"
                        aria-label={`Cost for ${ep.method.toUpperCase()} ${ep.path}`}
                        className="h-7 w-16 text-right font-mono text-xs"
                      />
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span className="tabular-nums">free/day</span>
                      <PricingInput
                        value={ep.freeTier}
                        onValueChange={(value) =>
                          onPricingChange?.({
                            path: ep.path,
                            method: ep.method,
                            freeTier: value,
                          })
                        }
                        disabled={!editable}
                        inputMode="decimal"
                        placeholder="0"
                        aria-label={`Free tier for ${ep.method.toUpperCase()} ${ep.path}`}
                        className="h-7 w-16 text-right font-mono text-xs"
                      />
                    </div>
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

function PricingInput({
  value,
  onValueChange,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "value" | "onChange"> & {
  value: number | undefined;
  onValueChange: (value: number | null) => void;
}) {
  const [raw, setRaw] = useState<string | null>(null);
  const invalid =
    raw !== null &&
    raw.trim() !== "" &&
    (!Number.isFinite(Number(raw)) || Number(raw) < 0);
  return (
    <Input
      {...props}
      value={raw ?? (value === undefined ? "" : String(value))}
      aria-invalid={invalid}
      onChange={(event) => {
        const next = event.target.value;
        setRaw(next);
        if (next.trim() === "") onValueChange(null);
        else if (Number.isFinite(Number(next)) && Number(next) >= 0)
          onValueChange(Number(next));
      }}
      onBlur={() => setRaw(null)}
    />
  );
}
