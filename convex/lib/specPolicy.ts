import {
  collectOpenApiSpecIssues,
  parseSpec,
  extractPricing,
  type SpecIssue,
} from "@zevium/shared";
const methods = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
] as const;
export function specIssues(text: string): SpecIssue[] {
  const issues = collectOpenApiSpecIssues(text);
  if (issues.some((i) => i.level === "error")) return issues;
  const parsed = parseSpec(text);
  if (parsed.servers.length !== 1)
    issues.push({
      level: "error",
      path: "servers",
      message: "A listing must have exactly one upstream server",
    });
  const raw = JSON.parse(text) as {
    paths?: Record<string, { servers?: unknown }>;
  };
  for (const [path, item] of Object.entries(raw.paths ?? {}))
    if (item.servers !== undefined)
      issues.push({
        level: "error",
        path: `paths.${path}.servers`,
        message: "Paths must use the listing upstream",
      });
  let count = 0;
  for (const [path, item] of Object.entries(parsed.paths))
    for (const method of methods) {
      const op = item[method];
      if (!op) continue;
      count++;
      if (
        op["x-zevium-cost"] !== undefined &&
        typeof op["x-zevium-cost"] !== "number"
      )
        issues.push({
          level: "error",
          path: `paths.${path}.${method}`,
          message: "Only scalar per-call pricing is supported",
        });
      if (op.servers !== undefined)
        issues.push({
          level: "error",
          path: `paths.${path}.${method}.servers`,
          message: "Operations must use the listing upstream",
        });
    }
  if (count > 256)
    issues.push({
      level: "error",
      path: "paths",
      message: "At most 256 operations per listing",
    });
  return issues;
}
export function pricingSummary(text: string) {
  const spec = parseSpec(text),
    costs: number[] = [];
  let hasFreeTier = false;
  for (const item of Object.values(spec.paths))
    for (const method of methods) {
      const op = item[method];
      if (!op) continue;
      const pricing = extractPricing(op);
      if (!pricing || pricing.token) continue;
      costs.push(pricing.cost);
      hasFreeTier ||= !!pricing.freeTier;
    }
  return {
    minCost: costs.length ? Math.min(...costs) : undefined,
    maxCost: costs.length ? Math.max(...costs) : undefined,
    endpointCount: costs.length,
    hasFreeTier,
  };
}

/** Public docs omit unpriced operations, while preserving explicitly free calls. */
export function publicSpec(text: string): string {
  const spec = parseSpec(text);
  const raw = JSON.parse(text) as {
    paths: Record<string, Record<string, unknown>>;
  };
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of methods)
      if (item[method] && !extractPricing(item[method]!))
        delete raw.paths[path][method];
    if (!methods.some((method) => raw.paths[path][method]))
      delete raw.paths[path];
  }
  return JSON.stringify(raw);
}
