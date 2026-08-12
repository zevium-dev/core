import {
  extractPricing,
  parseSpec,
  resolveLocalJsonRefChain,
  type HttpMethod,
  type OpenApiOperation,
} from "@zevium/shared";

import { exampleFromSchema, tryItBodyDefaults } from "./try-it";

export type ApiParameterLocation = "path" | "query" | "header";

export type ApiParameter = {
  key: string;
  name: string;
  location: ApiParameterLocation;
  required: boolean;
  description?: string;
  type: string;
  initialValue: string;
};

export type ApiResponse = {
  status: string;
  description?: string;
  contentTypes: string[];
  example?: string;
};

export type ApiEndpoint = {
  id: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  operationId?: string;
  tags: string[];
  cost: number;
  freeTier?: number;
  parameters: ApiParameter[];
  requestContentType: string;
  requestBodyExample: string;
  requestBodyDeclared: boolean;
  requestBodyRequired: boolean;
  responses: ApiResponse[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveComponentRef(
  value: unknown,
  section: "parameters" | "requestBodies" | "responses",
  components?: Record<string, unknown>,
): unknown {
  if (!isRecord(value) || typeof value.$ref !== "string") return value;
  if (!value.$ref.startsWith(`#/components/${section}/`)) return value;
  return resolveLocalJsonRefChain(value, { components });
}

function stringValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

export function parameterKey(
  location: ApiParameterLocation,
  name: string,
): string {
  return `${location}:${name}`;
}

function extractParameters(
  pathParameters: unknown[] | undefined,
  operation: OpenApiOperation,
  path: string,
  components?: Record<string, unknown>,
): ApiParameter[] {
  const parameters = new Map<string, ApiParameter>();
  const raw = [
    ...(pathParameters ?? []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ];

  for (const rawCandidate of raw) {
    const candidate = resolveComponentRef(
      rawCandidate,
      "parameters",
      components,
    );
    if (!isRecord(candidate) || typeof candidate.name !== "string") continue;
    if (
      candidate.in !== "path" &&
      candidate.in !== "query" &&
      candidate.in !== "header"
    ) {
      continue;
    }
    const location = candidate.in;
    const schema = isRecord(candidate.schema) ? candidate.schema : {};
    const key = parameterKey(location, candidate.name);
    // Path Item parameters apply to every operation. An operation-level entry
    // with the same (name, in) replaces it, per OpenAPI 3.1.
    parameters.set(key, {
      key,
      name: candidate.name,
      location,
      required: location === "path" || candidate.required === true,
      description:
        typeof candidate.description === "string"
          ? candidate.description
          : undefined,
      type:
        typeof schema.type === "string"
          ? schema.type
          : typeof schema.format === "string"
            ? schema.format
            : "string",
      initialValue: stringValue(
        candidate.example ?? schema.example ?? schema.default,
      ),
    });
  }

  for (const match of path.matchAll(/\{([^}/]+)\}/g)) {
    const name = match[1]!;
    const key = parameterKey("path", name);
    if (parameters.has(key)) continue;
    parameters.set(key, {
      key,
      name,
      location: "path",
      required: true,
      type: "string",
      initialValue: "",
    });
  }

  return [...parameters.values()];
}

function extractResponses(
  operation: OpenApiOperation,
  components?: Record<string, unknown>,
): ApiResponse[] {
  if (!isRecord(operation.responses)) return [];
  return Object.entries(operation.responses).map(([status, candidate]) => {
    const rawResponse = resolveComponentRef(candidate, "responses", components);
    if (!isRecord(rawResponse)) return { status, contentTypes: [] };
    const content = isRecord(rawResponse.content) ? rawResponse.content : {};
    const contentTypes = Object.keys(content);
    const firstMedia =
      contentTypes.length > 0 ? content[contentTypes[0]!] : null;
    let example: string | undefined;
    if (isRecord(firstMedia)) {
      const generated =
        firstMedia.example ??
        (isRecord(firstMedia.schema)
          ? (firstMedia.schema.example ??
            exampleFromSchema(firstMedia.schema, 0, components))
          : undefined);
      if (generated !== undefined) {
        example = stringValue(generated);
        if (typeof generated === "object" && generated !== null) {
          example = JSON.stringify(generated, null, 2);
        }
      }
    }
    return {
      status,
      description:
        typeof rawResponse.description === "string"
          ? rawResponse.description
          : undefined,
      contentTypes,
      ...(example ? { example } : {}),
    };
  });
}

export function parsePublishedEndpoints(specJson: string): ApiEndpoint[] {
  const spec = parseSpec(specJson);
  const rows: ApiEndpoint[] = [];
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const [method, rawOperation] of Object.entries(pathItem)) {
      if (method === "parameters" || !isRecord(rawOperation)) continue;
      const operation = rawOperation as OpenApiOperation;
      const resolvedRequestBody = resolveComponentRef(
        operation.requestBody,
        "requestBodies",
        spec.components,
      );
      const resolvedOperation: OpenApiOperation = {
        ...operation,
        ...(isRecord(resolvedRequestBody)
          ? { requestBody: resolvedRequestBody }
          : {}),
      };
      const pricing = extractPricing(operation);
      const bodyDefaults = tryItBodyDefaults(
        resolvedOperation,
        spec.components,
      );
      const requestBody = isRecord(resolvedOperation.requestBody)
        ? resolvedOperation.requestBody
        : null;
      rows.push({
        id: `${method}:${path}`,
        method: method as HttpMethod,
        path,
        summary:
          typeof operation.summary === "string" ? operation.summary : undefined,
        description:
          typeof operation.description === "string"
            ? operation.description
            : undefined,
        operationId:
          typeof operation.operationId === "string"
            ? operation.operationId
            : undefined,
        tags: Array.isArray(operation.tags)
          ? operation.tags.filter(
              (tag): tag is string => typeof tag === "string",
            )
          : [],
        cost: pricing.cost,
        freeTier: pricing.freeTier,
        parameters: extractParameters(
          pathItem.parameters,
          operation,
          path,
          spec.components,
        ),
        requestContentType: bodyDefaults.contentType,
        requestBodyExample: bodyDefaults.body,
        requestBodyDeclared: requestBody !== null,
        requestBodyRequired: requestBody?.required === true,
        responses: extractResponses(operation, spec.components),
      });
    }
  }
  rows.sort((left, right) =>
    left.path === right.path
      ? left.method.localeCompare(right.method)
      : left.path.localeCompare(right.path),
  );
  return rows;
}

export function buildRequestPath(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{([^}/]+)\}/g, (_, name: string) =>
    encodeURIComponent(values[parameterKey("path", name)] ?? ""),
  );
}

export function appendQueryParameters(
  url: string,
  parameters: ApiParameter[],
  values: Record<string, string>,
): string {
  const query = new URLSearchParams();
  for (const parameter of parameters) {
    if (parameter.location !== "query") continue;
    const value = values[parameter.key]?.trim() ?? "";
    if (value !== "") query.append(parameter.name, value);
  }
  const encoded = query.toString();
  return encoded === "" ? url : `${url}?${encoded}`;
}

export function readableJsonResponse(
  body: string,
  contentType: string | null,
  maxLength = 20_000,
): string | null {
  if (!contentType?.toLowerCase().includes("json") || body.length > maxLength) {
    return null;
  }
  try {
    return JSON.stringify(JSON.parse(body) as unknown, null, 2);
  } catch {
    return null;
  }
}

const SAFE_GATEWAY_ERRORS: Record<string, string> = {
  payment_required: "Payment or valid credits are required.",
  gateway_unavailable: "Gateway configuration is temporarily unavailable.",
  project_not_found: "This API is unavailable.",
  invalid_spec: "Published API configuration is unavailable.",
  route_not_found: "This endpoint is not published.",
  no_upstream: "This API has no configured upstream.",
  unsafe_upstream: "This API's upstream is not permitted.",
  key_disabled: "This API key is disabled.",
  key_cap_exceeded: "This API key reached its monthly cap.",
  reserve_failed: "Credits could not be reserved.",
  upstream_timeout: "The upstream service did not respond in time.",
  upstream_error: "The upstream request failed.",
};

/**
 * Render only Zevium-owned error envelopes. Matching body/header request IDs
 * prevents an arbitrary upstream JSON error from impersonating this shape.
 */
export function sanitizedGatewayErrorResponse(
  body: string,
  contentType: string | null,
  headerRequestId: string | undefined,
  maxLength = 20_000,
): string | null {
  if (
    headerRequestId === undefined ||
    !contentType?.toLowerCase().includes("json") ||
    body.length > maxLength
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (
      !isRecord(parsed) ||
      typeof parsed.error !== "string" ||
      typeof parsed.requestId !== "string" ||
      parsed.requestId !== headerRequestId
    ) {
      return null;
    }
    const message = SAFE_GATEWAY_ERRORS[parsed.error];
    if (message === undefined) return null;
    return JSON.stringify(
      { error: parsed.error, message, requestId: headerRequestId },
      null,
      2,
    );
  } catch {
    return null;
  }
}
