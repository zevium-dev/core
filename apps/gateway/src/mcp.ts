/**
 * Minimal MCP Streamable HTTP endpoint for workerd.
 *
 * Implements JSON-RPC 2.0 methods agents need:
 *   initialize, tools/list, tools/call, ping, notifications/initialized
 *
 * Tools:
 *   search_apis  — catalogue search with compact pricing
 *   get_api_docs — endpoint list + pricing + usage notes
 *   call_api     — metered execute via the SAME pipeline (no side door)
 *
 * call_api REQUIRES a consumer API key from the MCP request Authorization /
 * x-api-key header, or a `key` tool argument. It reuses handleGatewayRequest.
 */

import { parseSpec } from "@zevium/shared";
import type { CatalogueSource } from "./catalogue-source";
import { endpointsFromSpec, type DiscoveryEndpoint } from "./discovery";
import { extractApiKey } from "./key-verifier";
import {
  handleGatewayRequest,
  type GatewayRoute,
  type PipelineDeps,
  type PipelineEnv,
} from "./pipeline";
import type { SpecSource } from "./spec-source";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "zevium-gateway", version: "0.1.0" } as const;

export type McpDeps = {
  catalogueSource: CatalogueSource;
  specSource: SpecSource;
  pipeline: PipelineDeps;
  pipelineEnv: PipelineEnv;
  gatewayOrigin: string;
};

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
};

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const TOOLS: ToolDef[] = [
  {
    name: "search_apis",
    description:
      "Search the Zevium public API catalogue. Returns compact matches with per-endpoint pricing so agents can evaluate cost before calling.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (name, slug, description, tags)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_api_docs",
    description:
      "Load endpoint list, pricing, and usage notes for one published API. Use after search_apis to load only the tools you need.",
    inputSchema: {
      type: "object",
      properties: {
        org: {
          type: "string",
          description: "Publisher organization slug",
        },
        project: {
          type: "string",
          description: "API / project slug",
        },
      },
      required: ["org", "project"],
    },
  },
  {
    name: "call_api",
    description:
      "Execute a metered API call through the Zevium gateway. Requires a consumer API key (Authorization: Bearer ak_…/zev_… on the MCP request, or key argument). Credits are reserved and settled like any gateway call — zero balance blocks.",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", description: "Publisher org slug" },
        project: { type: "string", description: "API / project slug" },
        method: {
          type: "string",
          description: "HTTP method (GET, POST, …)",
        },
        path: {
          type: "string",
          description: "Endpoint path, e.g. /v1/chat/completions",
        },
        body: {
          description: "Optional request body (string or JSON-serializable)",
        },
        headers: {
          type: "object",
          description: "Optional extra headers to forward upstream",
          additionalProperties: { type: "string" },
        },
        key: {
          type: "string",
          description:
            "Optional API key override (ak_… or zev_…). Prefer Authorization on the MCP request.",
        },
      },
      required: ["org", "project", "method", "path"],
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseJsonRpcRequest(raw: unknown): JsonRpcRequest | null {
  if (!isRecord(raw)) return null;
  if (raw.jsonrpc !== "2.0") return null;
  if (typeof raw.method !== "string" || raw.method.length === 0) return null;

  let id: JsonRpcId | undefined;
  if ("id" in raw) {
    const rid = raw.id;
    if (rid === null || typeof rid === "string" || typeof rid === "number") {
      id = rid;
    } else {
      return null;
    }
  }

  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    method: raw.method,
  };
  if (id !== undefined) req.id = id;
  if ("params" in raw) req.params = raw.params;
  return req;
}

function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function failure(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  const err: JsonRpcFailure["error"] = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", id, error: err };
}

function textContent(text: string): {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text", text }] };
}

function toolError(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function handleSearchApis(
  deps: McpDeps,
  args: Record<string, unknown>,
): Promise<unknown> {
  const query = asString(args.query) ?? "";
  const page = await deps.catalogueSource.listPublic({
    search: query.trim() === "" ? undefined : query,
  });

  const matches: Array<{
    name: string;
    publisherHandle: string;
    slug: string;
    description: string | undefined;
    gatewayBaseUrl: string;
    endpoints: DiscoveryEndpoint[];
  }> = [];

  for (const item of page.items) {
    const published = await deps.specSource.getPublishedSpec(
      item.publisherHandle,
      item.slug,
    );
    let endpoints: DiscoveryEndpoint[] = [];
    if (published) {
      try {
        endpoints = endpointsFromSpec(parseSpec(published.spec));
      } catch {
        endpoints = [];
      }
    }
    const origin = deps.gatewayOrigin.replace(/\/+$/, "");
    matches.push({
      name: item.name,
      publisherHandle: item.publisherHandle,
      slug: item.slug,
      description: item.description,
      gatewayBaseUrl: `${origin}/gateway/${item.publisherHandle}/${item.slug}`,
      endpoints,
    });
  }

  return textContent(JSON.stringify({ matches }, null, 2));
}

async function handleGetApiDocs(
  deps: McpDeps,
  args: Record<string, unknown>,
): Promise<unknown> {
  const org = asString(args.org);
  const project = asString(args.project);
  if (!org || !project) {
    return toolError("org and project are required");
  }

  const published = await deps.specSource.getPublishedSpec(org, project);
  if (!published) {
    return toolError(`Unknown public API: ${org}/${project}`);
  }

  let endpoints: DiscoveryEndpoint[] = [];
  let title: string | undefined;
  let version: string | undefined;
  try {
    const parsed = parseSpec(published.spec);
    endpoints = endpointsFromSpec(parsed);
    title = parsed.info?.title;
    version = parsed.info?.version;
  } catch {
    return toolError("Published spec unreadable");
  }

  const origin = deps.gatewayOrigin.replace(/\/+$/, "");
  const docs = {
    org,
    project,
    name: title ?? project,
    version,
    gatewayBaseUrl: `${origin}/gateway/${org}/${project}`,
    usageNotes: [
      "Authenticate every call with Authorization: Bearer <ak_…|zev_…> or x-api-key.",
      "Credits are prepaid on the consumer org wallet; zero balance returns 402.",
      "Non-2xx upstream responses refund the reservation — consumer pays only on success.",
      "Pricing is declared per-operation as x-zevium-cost in the OpenAPI spec.",
      "Prefer search_apis → get_api_docs → call_api; never dump every endpoint into context.",
    ],
    endpoints,
  };

  return textContent(JSON.stringify(docs, null, 2));
}

async function handleCallApi(
  deps: McpDeps,
  args: Record<string, unknown>,
  mcpRequest: Request,
  ctx: ExecutionContext,
): Promise<unknown> {
  const org = asString(args.org);
  const project = asString(args.project);
  const methodRaw = asString(args.method);
  const pathRaw = asString(args.path);

  if (!org || !project || !methodRaw || !pathRaw) {
    return toolError("org, project, method, and path are required");
  }

  // Key from tool arg, else MCP request Authorization / x-api-key.
  let key = asString(args.key);
  if (!key) {
    key = extractApiKey(mcpRequest) ?? undefined;
  }
  if (!key) {
    return toolError(
      "API key required: set Authorization: Bearer ak_…/zev_… on the MCP request, or pass key in tool arguments",
    );
  }
  if (!key.startsWith("ak_") && !key.startsWith("zev_")) {
    return toolError("API key must start with ak_ or zev_");
  }

  const method = methodRaw.toUpperCase();
  const remainderPath = pathRaw.startsWith("/") ? pathRaw : `/${pathRaw}`;
  const route: GatewayRoute = {
    publisherHandle: org,
    projectSlug: project,
    remainderPath,
  };

  const headers = new Headers();
  headers.set("authorization", `Bearer ${key}`);

  if (isRecord(args.headers)) {
    for (const [hk, hv] of Object.entries(args.headers)) {
      if (typeof hv === "string" && hv.length > 0) {
        // Never let tool headers clobber the consumer key.
        const lower = hk.toLowerCase();
        if (lower === "authorization" || lower === "x-api-key") continue;
        headers.set(hk, hv);
      }
    }
  }

  let body: BodyInit | undefined;
  if (args.body !== undefined && args.body !== null) {
    if (typeof args.body === "string") {
      body = args.body;
      if (!headers.has("content-type")) {
        headers.set("content-type", "text/plain; charset=utf-8");
      }
    } else {
      body = JSON.stringify(args.body);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    }
  }

  const origin = deps.gatewayOrigin.replace(/\/+$/, "");
  const url = `${origin}/gateway/${org}/${project}${remainderPath === "/" ? "" : remainderPath}`;

  const init: RequestInit = {
    method,
    headers,
  };
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    init.body = body;
  }

  // INTERNAL pipeline reuse — same verify/reserve/settle path. No side door.
  const gatewayRequest = new Request(url, init);
  const response = await handleGatewayRequest(
    gatewayRequest,
    deps.pipelineEnv,
    deps.pipeline,
    ctx,
    route,
  );

  const responseText = await response.text();
  const cost = response.headers.get("x-zevium-cost");
  const requestId = response.headers.get("x-zevium-request-id");

  const payload = {
    status: response.status,
    requestId,
    cost: cost === null ? undefined : Number(cost),
    headers: Object.fromEntries(response.headers.entries()),
    body: responseText,
  };

  if (response.status >= 400) {
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(payload, null, 2) },
      ],
      isError: true,
    };
  }

  return textContent(JSON.stringify(payload, null, 2));
}

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  deps: McpDeps,
  mcpRequest: Request,
  ctx: ExecutionContext,
): Promise<unknown> {
  switch (name) {
    case "search_apis":
      return handleSearchApis(deps, args);
    case "get_api_docs":
      return handleGetApiDocs(deps, args);
    case "call_api":
      return handleCallApi(deps, args, mcpRequest, ctx);
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

async function handleRpc(
  req: JsonRpcRequest,
  deps: McpDeps,
  mcpRequest: Request,
  ctx: ExecutionContext,
): Promise<JsonRpcResponse | null> {
  const id: JsonRpcId = req.id === undefined ? null : req.id;
  const isNotification = req.id === undefined;

  switch (req.method) {
    case "initialize":
      return success(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case "notifications/initialized":
    case "initialized":
      // Notification — no response body expected for pure notifications,
      // but Streamable HTTP clients often still send id; return empty ok.
      if (isNotification) return null;
      return success(id, {});

    case "ping":
      return success(id, {});

    case "tools/list":
      return success(id, { tools: TOOLS });

    case "tools/call": {
      if (!isRecord(req.params)) {
        return failure(id, -32602, "Invalid params: expected object");
      }
      const name = asString(req.params.name);
      if (!name) {
        return failure(id, -32602, "Invalid params: name required");
      }
      let args: Record<string, unknown> = {};
      if ("arguments" in req.params && isRecord(req.params.arguments)) {
        args = req.params.arguments;
      }
      try {
        const result = await dispatchTool(name, args, deps, mcpRequest, ctx);
        return success(id, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return success(id, toolError(message));
      }
    }

    default:
      if (isNotification) return null;
      return failure(id, -32601, `Method not found: ${req.method}`);
  }
}

/**
 * Streamable HTTP MCP endpoint.
 * Accepts POST application/json (single request or batch).
 * GET returns server info for simple health/discovery.
 */
export async function handleMcpRequest(
  request: Request,
  deps: McpDeps,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method === "GET" || request.method === "HEAD") {
    const body = {
      name: SERVER_INFO.name,
      version: SERVER_INFO.version,
      protocolVersion: PROTOCOL_VERSION,
      transport: "streamable-http",
      tools: TOOLS.map((t) => t.name),
    };
    if (request.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return Response.json(body);
  }

  if (request.method !== "POST") {
    return Response.json(
      { error: "method_not_allowed", message: "POST or GET only" },
      { status: 405 },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json(failure(null, -32700, "Parse error: invalid JSON"), {
      status: 400,
    });
  }

  // Batch
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      return Response.json(
        failure(null, -32600, "Invalid Request: empty batch"),
        { status: 400 },
      );
    }
    const responses: JsonRpcResponse[] = [];
    for (const item of raw) {
      const parsed = parseJsonRpcRequest(item);
      if (!parsed) {
        responses.push(failure(null, -32600, "Invalid Request"));
        continue;
      }
      const res = await handleRpc(parsed, deps, request, ctx);
      if (res) responses.push(res);
    }
    if (responses.length === 0) {
      return new Response(null, { status: 202 });
    }
    return Response.json(responses);
  }

  const parsed = parseJsonRpcRequest(raw);
  if (!parsed) {
    return Response.json(failure(null, -32600, "Invalid Request"), {
      status: 400,
    });
  }

  const res = await handleRpc(parsed, deps, request, ctx);
  if (!res) {
    // Notification accepted
    return new Response(null, { status: 202 });
  }
  return Response.json(res);
}
