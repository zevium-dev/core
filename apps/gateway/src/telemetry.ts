export type DependencyComponent =
  | "catalogue_source"
  | "public_spec_source"
  | "internal_spec_source"
  | "usage_sink";

/** Explicit allowlist: no raw errors, tenant ids, key ids, or request ids. */
export function logDependencyFailure(
  component: DependencyComponent,
  status?: number,
): void {
  console.error(
    JSON.stringify({
      schema: 1,
      type: "zevium.dependency_failure",
      component,
      ...(status === undefined
        ? {}
        : { statusClass: `${Math.floor(status / 100)}xx` }),
    }),
  );
}

export function latencyBucket(latencyMs: number): string {
  if (latencyMs < 100) return "lt100ms";
  if (latencyMs < 500) return "100-499ms";
  if (latencyMs < 2_000) return "500-1999ms";
  return "gte2000ms";
}

export function costBucket(cost: number): string {
  if (cost <= 0) return "zero";
  if (cost <= 10) return "1-10";
  if (cost <= 100) return "11-100";
  return "gt100";
}
