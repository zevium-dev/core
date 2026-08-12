/**
 * Minimal OpenAPI helpers for the gateway hot path.
 * Spec is source of truth for upstream URL, routes, and x-zevium-* pricing.
 */

import { MAX_ENDPOINT_COST_CREDITS, type EndpointPricing } from "./pricing.js";

export const MAX_OPENAPI_SPEC_BYTES = 393_216;

export type HttpMethod =
  "get" | "post" | "put" | "patch" | "delete" | "options" | "head" | "trace";

const HTTP_METHODS: Record<string, true> = {
  get: true,
  post: true,
  put: true,
  patch: true,
  delete: true,
  options: true,
  head: true,
  trace: true,
};

export type OpenApiServer = {
  url: string;
};

export type OpenApiOperation = {
  operationId?: string;
  summary?: string;
  /** Raw vendor extensions + standard fields we care about. */
  "x-zevium-cost"?: number;
  "x-zevium-free-tier"?: number;
  [key: string]: unknown;
  /** Explicit opt-in for one credential-free, side-effect-free health probe. */
  "x-zevium-health-check"?: boolean;
};

export type OpenApiPathItem = Partial<Record<HttpMethod, OpenApiOperation>> & {
  /** Parameters inherited by every operation in this Path Item. */
  parameters?: unknown[];
};

export type ParsedOpenApiSpec = {
  openapi?: string;
  info?: { title?: string; version?: string };
  servers: OpenApiServer[];
  paths: Record<string, OpenApiPathItem>;
  /**
   * Raw `components` map (preserved verbatim). Used by mock-response generation
   * to resolve `$ref: "#/components/schemas/..."` one level. Optional / sparse.
   */
  components?: Record<string, unknown>;
};

export type MatchedOperation = {
  operation: OpenApiOperation;
  method: HttpMethod;
  /** Spec path template, e.g. `/users/{id}` */
  pathTemplate: string;
  /** Captured path params from the request path. */
  params: Record<string, string>;
  pricing: EndpointPricing;
  /** Upstream base from `servers[0].url`. Empty string if missing. */
  upstreamBaseUrl: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse an OpenAPI 3.x document from a JSON string into a minimal typed shape.
 * Throws on invalid JSON or non-object root.
 */
export type HealthCheckTarget = {
  url: string;
  method: "GET" | "HEAD";
  path: string;
};

export function parseSpec(json: string): ParsedOpenApiSpec {
  if (new TextEncoder().encode(json).byteLength > MAX_OPENAPI_SPEC_BYTES) {
    throw new Error("OpenAPI spec exceeds 393216 UTF-8 bytes");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid OpenAPI JSON: ${message}`);
  }
  if (!isRecord(raw)) {
    throw new Error("invalid OpenAPI document: root must be an object");
  }

  const servers: OpenApiServer[] = [];
  if (Array.isArray(raw.servers)) {
    for (const s of raw.servers) {
      if (isRecord(s) && typeof s.url === "string" && s.url.length > 0) {
        servers.push({ url: s.url });
      }
    }
  }

  const paths: Record<string, OpenApiPathItem> = {};
  if (isRecord(raw.paths)) {
    for (const [pathKey, pathVal] of Object.entries(raw.paths)) {
      if (!isRecord(pathVal)) continue;
      const item: OpenApiPathItem = {};
      for (const [method, opVal] of Object.entries(pathVal)) {
        const lower = method.toLowerCase();
        if (lower === "parameters" && Array.isArray(opVal)) {
          item.parameters = opVal;
          continue;
        }
        if (!(lower in HTTP_METHODS)) continue;
        if (!isRecord(opVal)) continue;
        // Operation objects are free-form OpenAPI maps; we only read known keys later.
        item[lower as HttpMethod] = opVal;
      }
      paths[pathKey] = item;
    }
  }

  const info = isRecord(raw.info)
    ? {
        title: typeof raw.info.title === "string" ? raw.info.title : undefined,
        version:
          typeof raw.info.version === "string" ? raw.info.version : undefined,
      }
    : undefined;

  const components = isRecord(raw.components)
    ? (raw.components as Record<string, unknown>)
    : undefined;

  return {
    openapi: typeof raw.openapi === "string" ? raw.openapi : undefined,
    info,
    servers,
    paths,
    components,
  };
}

/**
 * Match a request method+path against OpenAPI path templates.
 * Templates use `{param}` segments (OpenAPI style). OpenAPI requires concrete
 * paths to win over templated paths. Remaining ambiguous template matches use a
 * stable specificity/lexical order so pricing never depends on JSON key order.
 */
export function matchOperation(
  spec: ParsedOpenApiSpec,
  method: string,
  path: string,
): MatchedOperation | null {
  const lower = method.toLowerCase();
  if (!(lower in HTTP_METHODS)) return null;
  const m = lower as HttpMethod;

  const requestPath = normalizePath(path);
  const upstreamBaseUrl = spec.servers[0]?.url ?? "";

  let selected:
    | {
        operation: OpenApiOperation;
        template: string;
        params: Record<string, string>;
        parameterCount: number;
      }
    | undefined;

  for (const [template, pathItem] of Object.entries(spec.paths)) {
    if (!pathItem) continue;
    const op = pathItem[m];
    if (!op) continue;

    const params = matchPathTemplate(template, requestPath);
    if (!params) continue;

    const parameterCount = pathParameterCount(template);
    if (
      selected === undefined ||
      parameterCount < selected.parameterCount ||
      (parameterCount === selected.parameterCount &&
        normalizePath(template) < normalizePath(selected.template))
    ) {
      selected = { operation: op, template, params, parameterCount };
    }
  }

  if (selected === undefined) return null;
  return {
    operation: selected.operation,
    method: m,
    pathTemplate: selected.template,
    params: selected.params,
    pricing: extractPricing(selected.operation),
    upstreamBaseUrl,
  };
}

function pathParameterCount(template: string): number {
  const normalized = normalizePath(template);
  if (normalized === "/") return 0;
  let count = 0;
  for (const segment of normalized.slice(1).split("/")) {
    if (
      segment.startsWith("{") &&
      segment.endsWith("}") &&
      segment.length > 2
    ) {
      count++;
    }
  }
  return count;
}

export function parseCreditExtension(
  value: unknown,
  field: "x-zevium-cost" | "x-zevium-free-tier",
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_ENDPOINT_COST_CREDITS
  ) {
    throw new Error(
      `${field} must be a non-negative safe integer at most ${MAX_ENDPOINT_COST_CREDITS}`,
    );
  }
  return value;
}

export function extractPricing(op: OpenApiOperation): EndpointPricing {
  const costValue = op["x-zevium-cost"];
  let cost: number;
  if (costValue === undefined) {
    // Unspecified → default credit cost. 0 is NOT defaulted — it is a valid
    // free-tier cost (free endpoint, publisher-funded free tier aside).
    cost = 1;
  } else {
    cost = parseCreditExtension(costValue, "x-zevium-cost");
  }

  const freeValue = op["x-zevium-free-tier"];
  let freeTier: number | undefined;
  if (freeValue !== undefined) {
    const freeRaw = parseCreditExtension(freeValue, "x-zevium-free-tier");
    // 0 free calls == no free tier; normalize to undefined.
    freeTier = freeRaw > 0 ? freeRaw : undefined;
  }

  return freeTier !== undefined ? { cost, freeTier } : { cost };
}

/** Remove trailing slashes in linear time, including for untrusted input. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return end === value.length ? value : value.slice(0, end);
}

/** Collapse empty / trailing-slash edge cases; keep leading slash. */
export function normalizePath(path: string): string {
  if (!path || path === "") return "/";
  let p = path.startsWith("/") ? path : `/${path}`;
  // Strip trailing slashes except root
  if (p.length > 1 && p.endsWith("/")) {
    p = trimTrailingSlashes(p);
  }
  return p || "/";
}

/**
 * Match `/users/{id}` against `/users/42` → `{ id: "42" }`.
 * Returns null on no match. `{param}` matches one segment (no `/`).
 */
export function matchPathTemplate(
  template: string,
  path: string,
): Record<string, string> | null {
  const t = normalizePath(template);
  const p = normalizePath(path);

  const tSegs = t === "/" ? [] : t.slice(1).split("/");
  const pSegs = p === "/" ? [] : p.slice(1).split("/");

  if (tSegs.length !== pSegs.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < tSegs.length; i++) {
    const ts = tSegs[i]!;
    const ps = pSegs[i]!;
    if (ts.startsWith("{") && ts.endsWith("}") && ts.length > 2) {
      const name = ts.slice(1, -1);
      if (!name) return null;
      // Path segments are already decoded by URL.pathname in most runtimes;
      // keep raw segment value.
      params[name] = ps;
      continue;
    }
    if (ts !== ps) return null;
  }
  return params;
}

/**
 * Join upstream base URL with a request path (absolute path on the gateway).
 * Does not rewrite query strings — caller appends search.
 */
export function joinUpstreamUrl(baseUrl: string, requestPath: string): string {
  const base = trimTrailingSlashes(baseUrl);
  const path = normalizePath(requestPath);
  if (!base) return path;
  // Absolute base may already include a path prefix (e.g. https://api.example.com/v1)
  try {
    const u = new URL(base.includes("://") ? base : `https://${base}`);
    const prefix = trimTrailingSlashes(u.pathname);
    // If request path already starts with prefix we still append full path —
    // gateway remainder is the full upstream path relative to servers[0].url root.
    u.pathname = `${prefix}${path === "/" ? "" : path}` || "/";
    return u
      .toString()
      .replace(/\/$/, path === "/" && prefix === "" ? "/" : "");
  } catch {
    return `${base}${path === "/" ? "" : path}`;
  }
}

export function extractHealthCheckTarget(
  spec: ParsedOpenApiSpec,
): HealthCheckTarget | null {
  const base = spec.servers[0]?.url;
  if (base === undefined) return null;

  const matches: Array<{ path: string; method: "GET" | "HEAD" }> = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of ["get", "head"] as const) {
      if (item[method]?.["x-zevium-health-check"] === true) {
        matches.push({ path, method: method.toUpperCase() as "GET" | "HEAD" });
      }
    }
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error("exactly one x-zevium-health-check operation is allowed");
  }

  const match = matches[0]!;
  if (
    !match.path.startsWith("/") ||
    match.path.includes("{") ||
    match.path.includes("}") ||
    match.path.includes("?") ||
    match.path.includes("#")
  ) {
    throw new Error(
      "x-zevium-health-check must use a parameter-free absolute path",
    );
  }
  return {
    url: joinUpstreamUrl(base, match.path),
    method: match.method,
    path: match.path,
  };
}
