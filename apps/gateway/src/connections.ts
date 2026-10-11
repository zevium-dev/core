import {
  CONNECTION_CALLBACK_PATH,
  CONNECTION_HEADER,
  getOAuthProvider,
  isConnectionId,
  isProviderApiHost,
  isSafeReturnUrl,
  isSchemeName,
  normalizeConnectionLabel,
  operationConnection,
  type ConnectionTokenFailure,
  type OpenApiOperation,
  type ParsedOpenApiSpec,
} from "@zevium/shared";
import { BoundedCache } from "./cache";
import { jsonError } from "./errors";
import { extractApiKey } from "./key-verifier";
import { SpecSourceUnavailableError, type SpecSource } from "./spec-source";

/**
 * Connected accounts at the edge.
 *
 * - `POST /connections`, `GET /connections[/:id]`, `DELETE /connections/:id`:
 *   API-key management of the caller org's connections.
 * - `GET /connections/callback`: the provider's redirect target.
 * - `ConnectionsBackend.token`: the access token a metered call injects,
 *   cached per isolate for at most 60 s and never past its expiry.
 */

export type ConnectionTokenOutcome =
  | { status: "ok"; connectionId: string; accessToken: string }
  | { status: ConnectionTokenFailure | "unavailable" };

export type ConnectionTokenInput = {
  orgId: string;
  projectId: string;
  scheme: string;
  connectionId?: string;
};

type ControlPath =
  | "/connections-start"
  | "/connections-callback"
  | "/connections-list"
  | "/connections-revoke";

export interface ConnectionsBackend {
  token(input: ConnectionTokenInput): Promise<ConnectionTokenOutcome>;
  /** Control-plane call; `null` when Convex is unavailable. */
  control(path: ControlPath, body: Record<string, unknown>): Promise<unknown>;
}

const TOKEN_CACHE_TTL_MS = 60_000;
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const FAILURES = new Set<string>([
  "connection_required",
  "connection_ambiguous",
  "connection_not_found",
  "connection_reauthorize",
]);

type CachedToken = {
  connectionId: string;
  accessToken: string;
  accessExpiresAt: number | null;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class InternalHttpConnections implements ConnectionsBackend {
  readonly #cache: BoundedCache<CachedToken>;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(
    readonly options: {
      siteUrl: string;
      internalSecret: string;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#cache = new BoundedCache(1024, TOKEN_CACHE_TTL_MS, this.#now);
  }

  async #post(
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Response | null> {
    try {
      return await this.#fetch(`${this.options.siteUrl}${path}`, {
        method: "POST",
        headers: {
          "x-internal-secret": this.options.internalSecret,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch {
      return null;
    }
  }

  async token(input: ConnectionTokenInput): Promise<ConnectionTokenOutcome> {
    const key = `${input.orgId}\u0000${input.projectId}\u0000${input.scheme}\u0000${input.connectionId ?? ""}`;
    const cached = this.#cache.get(key);
    if (
      cached &&
      (cached.accessExpiresAt === null ||
        cached.accessExpiresAt - TOKEN_EXPIRY_SKEW_MS > this.#now())
    ) {
      return {
        status: "ok",
        connectionId: cached.connectionId,
        accessToken: cached.accessToken,
      };
    }
    // Refresh can wait on a provider token endpoint; allow for it.
    const res = await this.#post("/gateway-connection-token", input, 12_000);
    if (!res?.ok) return { status: "unavailable" };
    let value: unknown;
    try {
      value = await res.json();
    } catch {
      return { status: "unavailable" };
    }
    if (!record(value)) return { status: "unavailable" };
    if (typeof value.status === "string" && FAILURES.has(value.status)) {
      // Failures are never cached: a fresh connection must work at once.
      this.#cache.invalidate(key);
      return { status: value.status as ConnectionTokenFailure };
    }
    if (
      value.status !== "ok" ||
      !isConnectionId(value.connectionId) ||
      typeof value.accessToken !== "string" ||
      value.accessToken.length === 0 ||
      /[\r\n]/.test(value.accessToken) ||
      (value.accessExpiresAt !== null &&
        typeof value.accessExpiresAt !== "number")
    ) {
      return { status: "unavailable" };
    }
    this.#cache.set(key, {
      connectionId: value.connectionId,
      accessToken: value.accessToken,
      accessExpiresAt: value.accessExpiresAt as number | null,
    });
    return {
      status: "ok",
      connectionId: value.connectionId,
      accessToken: value.accessToken,
    };
  }

  async control(
    path: ControlPath,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    // Callback exchanges the code with the provider before answering.
    const res = await this.#post(
      path,
      body,
      path === "/connections-callback" ? 15_000 : 5_000,
    );
    if (!res?.ok) return null;
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
}

export type ConnectionCaller =
  | { status: "ok"; orgId: string; keyId: string }
  | { status: "invalid" | "disabled" | "unavailable" };

export type ConnectionsDeps = {
  /** API-key identity from signed key evidence, lifecycle gates applied. */
  authenticate(secret: string): Promise<ConnectionCaller>;
  /** Route as the caller org sees it; private APIs only for their owner. */
  specSource: SpecSource;
  connections?: ConnectionsBackend;
  idGenerator?: () => string;
  now?: () => number;
};

const API_PART_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_START_BODY_BYTES = 8 * 1024;

const START_ERRORS: Record<string, [number, string]> = {
  organization_unavailable: [403, "This organization can't connect accounts"],
  project_not_found: [404, "API not found"],
  no_oauth_scheme: [400, "This API doesn't use connected accounts"],
  scheme_required: [400, "This API has several account types. Pass `scheme`."],
  scheme_not_found: [400, "This API has no account type with that `scheme`"],
  provider_not_configured: [
    503,
    "Account connections for this provider are unavailable right now",
  ],
  publisher_not_allowed: [
    403,
    "This API isn't approved to use connected accounts",
  ],
  too_many_pending: [
    429,
    "Too many unfinished connection links. Finish or wait for some to expire.",
  ],
};

/** Plain, script-free page for people returning from the provider. */
const CALLBACK_PAGES: Record<string, [number, string, string]> = {
  active: [
    200,
    "Account connected",
    "You can close this tab and return to the app.",
  ],
  denied: [200, "Connection declined", "No access was granted."],
  expired: [400, "Link expired", "Ask the app for a new connection link."],
  failed: [
    502,
    "Connection failed",
    "The account couldn't be connected. Ask the app to start a new connection.",
  ],
  invalid: [
    400,
    "Link invalid",
    "This connection link is invalid or was already used.",
  ],
  unavailable: [
    503,
    "Try again",
    "Zevium couldn't finish connecting. Reload this page to retry.",
  ],
};

function callbackPage(outcome: keyof typeof CALLBACK_PAGES): Response {
  const [status, title, detail] = CALLBACK_PAGES[outcome]!;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Zevium</title></head><body><h1>${title}</h1><p>${detail}</p></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

async function handleCallback(
  url: URL,
  backend: ConnectionsBackend,
): Promise<Response> {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (!state || state.length > 512) return callbackPage("invalid");
  const outcome = await backend.control("/connections-callback", {
    state,
    ...(code ? { code: code.slice(0, 4096) } : {}),
    ...(error ? { error: error.slice(0, 128) } : {}),
  });
  if (
    !record(outcome) ||
    typeof outcome.status !== "string" ||
    !(outcome.status in CALLBACK_PAGES)
  ) {
    return callbackPage("unavailable");
  }
  const status = outcome.status;
  if (
    typeof outcome.returnUrl === "string" &&
    isSafeReturnUrl(outcome.returnUrl)
  ) {
    const target = new URL(outcome.returnUrl);
    if (isConnectionId(outcome.connectionId)) {
      target.searchParams.set("zevium_connection", outcome.connectionId);
    }
    target.searchParams.set("zevium_status", status);
    return new Response(null, {
      status: 303,
      headers: { location: target.toString(), "cache-control": "no-store" },
    });
  }
  return callbackPage(status);
}

async function authenticate(
  request: Request,
  deps: ConnectionsDeps,
  requestId: string,
): Promise<{ orgId: string; keyId: string } | Response> {
  const secret = extractApiKey(request);
  if (!secret) {
    return jsonError(
      401,
      "missing_api_key",
      "Connections require a Zevium API key",
      requestId,
    );
  }
  const caller = await deps.authenticate(secret);
  switch (caller.status) {
    case "ok":
      return { orgId: caller.orgId, keyId: caller.keyId };
    case "unavailable":
      return jsonError(
        503,
        "verification_unavailable",
        "API key verification is temporarily unavailable",
        requestId,
      );
    case "disabled":
      return jsonError(403, "key_disabled", "API key is disabled", requestId);
    default:
      return jsonError(401, "invalid_api_key", "Invalid API key", requestId);
  }
}

async function readStartBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const text = await request.text().catch(() => null);
  if (
    text === null ||
    new TextEncoder().encode(text).byteLength > MAX_START_BODY_BYTES
  )
    return null;
  try {
    const value: unknown = JSON.parse(text);
    return record(value) ? value : null;
  } catch {
    return null;
  }
}

async function handleStart(
  request: Request,
  deps: ConnectionsDeps,
  backend: ConnectionsBackend,
  caller: { orgId: string; keyId: string },
  requestId: string,
  started: number,
): Promise<Response> {
  const body = await readStartBody(request);
  const [publisherHandle, projectSlug, extra] =
    typeof body?.api === "string" ? body.api.split("/") : [];
  const label = normalizeConnectionLabel(body?.label);
  if (
    body === null ||
    !publisherHandle ||
    !projectSlug ||
    extra !== undefined ||
    !API_PART_RE.test(publisherHandle) ||
    !API_PART_RE.test(projectSlug) ||
    (body.scheme !== undefined && !isSchemeName(body.scheme)) ||
    label === false ||
    (body.returnUrl !== undefined && !isSafeReturnUrl(body.returnUrl))
  ) {
    return jsonError(
      400,
      "invalid_body",
      'Send JSON {"api":"publisher/project","scheme"?,"label"?,"returnUrl"?}; returnUrl must be https',
      requestId,
    );
  }
  let published;
  try {
    published = await deps.specSource.getPublishedSpec(
      publisherHandle,
      projectSlug,
      caller.orgId,
    );
  } catch (error) {
    if (error instanceof SpecSourceUnavailableError) {
      return jsonError(
        503,
        "gateway_unavailable",
        "Gateway configuration is temporarily unavailable",
        requestId,
      );
    }
    throw error;
  }
  // Same access rules as a metered call: private APIs stay invisible.
  if (
    !published ||
    (published.visibility !== "public" && caller.orgId !== published.clerkOrgId)
  ) {
    return jsonError(404, "project_not_found", "API not found", requestId);
  }
  if (
    published.retiredAt !== undefined ||
    (published.sunsetAt !== undefined && started >= published.sunsetAt)
  ) {
    return jsonError(
      410,
      "sunset_reached",
      "This API has reached its published sunset",
      requestId,
    );
  }
  if (published.admission?.allowed === false) {
    return jsonError(
      403,
      "consumer_not_entitled",
      "This API is deprecated and no longer accepts new consumers",
      requestId,
    );
  }
  const result = await backend.control("/connections-start", {
    orgId: caller.orgId,
    keyId: caller.keyId,
    projectId: published.projectId,
    api: `${publisherHandle}/${projectSlug}`,
    ...(body.scheme === undefined ? {} : { scheme: body.scheme }),
    ...(label === null ? {} : { label }),
    ...(body.returnUrl === undefined ? {} : { returnUrl: body.returnUrl }),
    redirectUri: new URL(CONNECTION_CALLBACK_PATH, request.url).toString(),
  });
  if (!record(result)) {
    return jsonError(
      503,
      "connections_unavailable",
      "Connections are temporarily unavailable",
      requestId,
    );
  }
  if (typeof result.error === "string") {
    const [status, message] = START_ERRORS[result.error] ?? [
      503,
      "Connections are temporarily unavailable",
    ];
    return jsonError(status, result.error, message, requestId);
  }
  return Response.json(
    {
      connection: result.connection,
      authorizationUrl: result.authorizationUrl,
      expiresAt: result.expiresAt,
      next: "Open authorizationUrl in the account owner's browser. Only share it with them; it expires in 10 minutes and works once.",
    },
    {
      status: 201,
      headers: {
        "cache-control": "no-store",
        "x-zevium-request-id": requestId,
      },
    },
  );
}

/** `/connections` router. Returns null for paths it doesn't own. */
export async function handleConnectionsRequest(
  request: Request,
  deps: ConnectionsDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "connections" || parts.length > 2) return null;
  const requestId = deps.idGenerator?.() ?? crypto.randomUUID();
  const backend = deps.connections;
  if (!backend) {
    return jsonError(
      503,
      "connections_unavailable",
      "Connections are temporarily unavailable",
      requestId,
    );
  }
  if (url.pathname === CONNECTION_CALLBACK_PATH) {
    if (request.method !== "GET") {
      return jsonError(405, "method_not_allowed", "GET only", requestId);
    }
    return await handleCallback(url, backend);
  }
  const id = parts[1];
  const allowed = id === undefined ? ["GET", "POST"] : ["GET", "DELETE"];
  if (!allowed.includes(request.method)) {
    const response = jsonError(
      405,
      "method_not_allowed",
      `${allowed.join(" or ")} only`,
      requestId,
    );
    response.headers.set("allow", allowed.join(", "));
    return response;
  }
  if (id !== undefined && !isConnectionId(id)) {
    return jsonError(
      404,
      "connection_not_found",
      "Connection not found",
      requestId,
    );
  }
  const caller = await authenticate(request, deps, requestId);
  if (caller instanceof Response) return caller;

  if (id === undefined && request.method === "POST") {
    return await handleStart(
      request,
      deps,
      backend,
      caller,
      requestId,
      (deps.now ?? Date.now)(),
    );
  }
  const result =
    request.method === "DELETE"
      ? await backend.control("/connections-revoke", {
          orgId: caller.orgId,
          connectionId: id,
        })
      : await backend.control("/connections-list", {
          orgId: caller.orgId,
          ...(id === undefined ? {} : { connectionId: id }),
        });
  if (!record(result)) {
    return jsonError(
      503,
      "connections_unavailable",
      "Connections are temporarily unavailable",
      requestId,
    );
  }
  if (id !== undefined && !record(result.connection)) {
    return jsonError(
      404,
      "connection_not_found",
      "Connection not found",
      requestId,
    );
  }
  return Response.json(result, {
    headers: { "cache-control": "no-store", "x-zevium-request-id": requestId },
  });
}

/** Error for a metered call whose operation needs a connection it can't use. */
export function connectionErrorResponse(
  failure:
    ConnectionTokenFailure | "unavailable" | "invalid" | "upstream_not_allowed",
  context: {
    scheme: string;
    providerName: string;
    api: string;
    origin: string;
    requestId: string;
  },
): Response {
  const { scheme, providerName, api, origin, requestId } = context;
  const connect = {
    method: "POST",
    url: `${origin}/connections`,
    body: { api, scheme },
  };
  switch (failure) {
    case "connection_required":
      return jsonError(
        403,
        failure,
        `This endpoint acts on the caller's own ${providerName} account. Connect one first.`,
        requestId,
        { cost: 0, connect },
      );
    case "connection_reauthorize":
      return jsonError(
        403,
        failure,
        `The connected ${providerName} account needs to be reconnected.`,
        requestId,
        { cost: 0, connect },
      );
    case "connection_ambiguous":
      return jsonError(
        409,
        failure,
        `Several connected ${providerName} accounts match. Choose one with the x-zevium-connection header.`,
        requestId,
        { cost: 0, list: { method: "GET", url: `${origin}/connections` } },
      );
    case "connection_not_found":
      return jsonError(
        404,
        failure,
        "Connection not found for this API",
        requestId,
        { cost: 0 },
      );
    case "invalid":
      return jsonError(
        400,
        "invalid_connection",
        "x-zevium-connection must be a connection id (conn_…)",
        requestId,
        { cost: 0 },
      );
    case "upstream_not_allowed":
      return jsonError(
        422,
        "connection_upstream_not_allowed",
        `This API's upstream can't receive ${providerName} account tokens`,
        requestId,
        { cost: 0 },
      );
    default:
      return jsonError(
        503,
        "connections_unavailable",
        "Connected accounts are temporarily unavailable",
        requestId,
        { cost: 0 },
      );
  }
}

/**
 * Connection for a metered call, resolved before any reservation (cost 0 on
 * every failure). `undefined` = the operation needs none, or an optional one
 * isn't available. A connected token only ever goes to the provider's API.
 */
export async function resolveCallConnection(input: {
  request: Request;
  spec: Pick<ParsedOpenApiSpec, "components" | "security">;
  operation: OpenApiOperation;
  upstreamUrl: URL;
  backend: ConnectionsBackend | undefined;
  orgId: string;
  projectId: string;
  api: string;
  requestId: string;
}): Promise<{ id: string; accessToken: string } | Response | undefined> {
  const requirement = operationConnection(input.spec, input.operation);
  if (!requirement) return undefined;
  const provider = getOAuthProvider(requirement.provider)!;
  const fail = (failure: Parameters<typeof connectionErrorResponse>[0]) =>
    connectionErrorResponse(failure, {
      scheme: requirement.scheme,
      providerName: provider.name,
      api: input.api,
      origin: new URL(input.request.url).origin,
      requestId: input.requestId,
    });
  if (!isProviderApiHost(provider, input.upstreamUrl.hostname)) {
    return fail("upstream_not_allowed");
  }
  const selected = input.request.headers.get(CONNECTION_HEADER);
  if (selected !== null && !isConnectionId(selected)) return fail("invalid");
  const outcome = input.backend
    ? await input.backend.token({
        orgId: input.orgId,
        projectId: input.projectId,
        scheme: requirement.scheme,
        ...(selected === null ? {} : { connectionId: selected }),
      })
    : ({ status: "unavailable" } as const);
  if (outcome.status === "ok") {
    return { id: outcome.connectionId, accessToken: outcome.accessToken };
  }
  return requirement.required || selected !== null
    ? fail(outcome.status)
    : undefined;
}
