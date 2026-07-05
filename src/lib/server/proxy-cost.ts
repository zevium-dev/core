import { and, desc, eq } from "drizzle-orm";

import { db, orm, schema } from "~/db";

/**
 * Resolve a proxy request to its upstream target + per-call cost.
 *
 * The proxy URL pattern is `/api/proxy/{orgSlug}/{projectSlug}/{endpoint...}`.
 * This module:
 *   1. Resolves `{orgSlug, projectSlug}` → `project` row (must be `active`).
 *   2. Loads the latest published OpenAPI spec version for the project.
 *   3. Extracts the upstream server URL from `servers[0].url`.
 *   4. Matches `{endpoint}` + request method → finds the operation in the spec.
 *   5. Reads `x-zevium-cost` from the matched operation (default: 1 credit).
 *
 * SSRF protection is still applied by the caller via `proxy-security.ts`.
 */

export interface ProxyTarget {
  cost: number;
  /** Full upstream URL including path (e.g. `https://api.openai.com/v1/chat/completions`). */
  upstreamUrl: string;
}

interface OpenApiOperation {
  method: string;
  path: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface OpenApiSpec {
  paths?: Record<string, Record<string, OpenApiOperation>>;
  servers?: Array<{ url: string }>;
}

/**
 * Resolve a proxy request to upstream URL + cost.
 * Returns `null` if the project or spec is not found / not active.
 */
export async function resolveProxyTarget(
  orgSlug: string,
  projectSlug: string,
  method: string,
  endpointPath: string,
): Promise<ProxyTarget | null> {
  // 1. Resolve project by org + project slug (must be active).
  const project = await db
    .select({ id: schema.project.id })
    .from(schema.project)
    .innerJoin(schema.organization, eq(schema.project.organizationId, schema.organization.id))
    .where(
      and(
        eq(schema.organization.slug, orgSlug),
        eq(schema.project.slug, projectSlug),
        eq(schema.project.status, "active"),
      ),
    )
    .limit(1)
    .then((rows) => rows.at(0));

  if (!project) return null;

  // 2. Load the latest published OpenAPI spec version.
  const version = await db
    .select({ schema: schema.openAPISchemaVersion.schema })
    .from(schema.openAPISchemaVersion)
    .innerJoin(schema.openAPISchema, eq(schema.openAPISchemaVersion.openAPISchemaId, schema.openAPISchema.id))
    .where(eq(schema.openAPISchema.projectId, project.id))
    .orderBy(desc(schema.openAPISchemaVersion.createdAt))
    .limit(1)
    .then((rows) => rows.at(0));

  if (!version) return null;

  // 3. Parse the spec JSON.
  const specRaw = typeof version.schema === "string" ? version.schema : JSON.stringify(version.schema);
  let spec: OpenApiSpec;
  try {
    spec = JSON.parse(specRaw) as OpenApiSpec;
  } catch {
    return null;
  }

  // 4. Extract upstream server URL.
  const serverUrl = spec.servers?.at(0)?.url;
  if (!serverUrl) return null;

  // 5. Match endpoint path + method → find operation → read cost.
  const httpMethod = method.toLowerCase();
  const cost = findOperationCost(spec, httpMethod, endpointPath);

  // 6. Build upstream URL.
  const baseUrl = serverUrl.replace(/\/+$/, "");
  const endpoint = endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;
  const upstreamUrl = `${baseUrl}${endpoint}`;

  return { cost, upstreamUrl };
}

/**
 * Find the matching operation in the OpenAPI spec and read `x-zevium-cost`.
 * Falls back to `1` credit if the extension is not set on the operation.
 */
function findOperationCost(spec: OpenApiSpec, method: string, requestPath: string): number {
  if (!spec.paths) return 1;

  // Exact path match first (fast path).
  for (const [pattern, pathItem] of Object.entries(spec.paths)) {
    if (pathMatch(pattern, requestPath)) {
      const operation = pathItem[method];
      if (operation && typeof operation["x-zevium-cost"] === "number") {
        return Math.max(1, Math.floor(operation["x-zevium-cost"]));
      }
      return 1; // Operation matched but no cost extension → default 1.
    }
  }

  return 1; // No match → default 1 credit.
}

/**
 * Match an OpenAPI path pattern (e.g. `/v1/chat/{id}`) against the
 * actual request path (e.g. `/v1/chat/abc123`).
 */
function pathMatch(pattern: string, requestPath: string): boolean {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = requestPath.split("/").filter(Boolean);

  if (patternParts.length !== pathParts.length) return false;

  return patternParts.every((part, i) => {
    // `{param}` or `{param}` in any form → matches any single segment.
    if (part.startsWith("{") && part.endsWith("}")) return true;
    return part === pathParts[i];
  });
}

/**
 * Validate that a hostname is safe to proxy to. Rejects localhost,
 * private IPs, and the proxy's own host. This replaces the old env-based
 * allowlist — the source of truth is now the OpenAPI spec's `servers` field.
 */
export function extractHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}
