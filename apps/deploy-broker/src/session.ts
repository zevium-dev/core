import { DurableObject } from "cloudflare:workers";
import {
  authorizeApiRoute,
  syntheticScriptsResponse,
  validateAssetInitBody,
  validateDeploymentBody,
  validateSecretBody,
  validateSubdomainBody,
  type ApiRoute,
  type TargetScriptState,
  type ValidatedAssetManifest,
} from "./api-policy";
import { audit } from "./audit";
import { sha256Hex, timingSafeEqual } from "./crypto";
import type { BrokerEnv } from "./env";
import { validateEnvironment } from "./env";
import { BrokerError, errorResponse, invariant, jsonResponse } from "./errors";
import { bearerToken, verifyGitHubOidc } from "./jwt";
import {
  AUDIENCE_PREFIX,
  canonicalJson,
  manifestDigest,
  parseManifest,
  type DeploymentManifest,
  type TargetManifest,
} from "./manifest";
import { inspectMultipart, validateSingleAssetLength } from "./multipart";
import { validateIdentityClaims } from "./provenance";
import {
  exactKeys,
  isRecord,
  parseStrictJson,
  readBodyBounded,
  readJsonBounded,
} from "./strict-json";

const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com";
const SESSION_STORAGE_KEY = "session";
const ASSET_STORAGE_PREFIX = "assets:";
const MUTATION_STORAGE_PREFIX = "mutation:";
const SESSION_REQUEST_LIMIT = 2_100;
const SESSION_REQUESTS_PER_MINUTE = 1_800;
const MAX_CONTROL_RESPONSE_BYTES = 512 * 1024;
const SESSION_ID_PATTERN = /^[0-9a-f]{64}$/;
const CLOUDFLARE_ASSET_JWT_PATTERN =
  /^[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,4096}$/;

interface SessionRecord {
  createdAt: number;
  digest: string;
  expiresAt: number;
  jtiHash: string;
  manifest: DeploymentManifest;
  requestCount: number;
  sessionId: string;
  version: 1;
  windowCount: number;
  windowStartedAt: number;
}

interface RegistrationBody {
  digest: string;
  expiresAt: number;
  jtiHash: string;
  manifest: DeploymentManifest;
  sessionId: string;
}

interface AssetState extends ValidatedAssetManifest {
  completionJwtHashes: string[];
  initialJwtHash?: string;
  uploadSizes: Record<string, number>;
}

interface CloudflareEnvelope {
  result: Record<string, unknown>;
  success: true;
}

function rawPathAndSearch(url: string): { pathname: string; search: string } {
  invariant(
    !url.includes("#"),
    400,
    "path_rejected",
    "URL fragment is not allowed",
  );
  const match = /^https?:\/\/[^/?#]+([^?#]*)(\?[^#]*)?$/.exec(url);
  invariant(match, 400, "path_rejected", "Request URL is invalid");
  return {
    pathname: match[1] || "/",
    search: match[2] ?? "",
  };
}

function proxyPath(
  request: Request,
  sessionId: string,
): { pathname: string; search: string } {
  const raw = rawPathAndSearch(request.url);
  const prefix = `/sessions/${sessionId}/client/v4`;
  invariant(
    raw.pathname.startsWith(`${prefix}/`),
    404,
    "session_route_rejected",
    "Session API route is invalid",
  );
  return {
    pathname: raw.pathname.slice(prefix.length),
    search: raw.search,
  };
}

function sanitizeResponseHeaders(source: Headers): Headers {
  const output = new Headers();
  for (const name of ["content-type", "etag", "retry-after"]) {
    const value = source.get(name);
    if (value !== null) output.set(name, value);
  }
  output.set("cache-control", "no-store");
  output.set("referrer-policy", "no-referrer");
  output.set("x-content-type-options", "nosniff");
  return output;
}

function upstreamHeaders(request: Request, authorization: string): Headers {
  const output = new Headers({ authorization });
  for (const name of [
    "accept",
    "content-length",
    "content-type",
    "user-agent",
  ]) {
    const value = request.headers.get(name);
    if (value !== null) output.set(name, value);
  }
  return output;
}

function ensureNoBody(request: Request): void {
  const contentLength = request.headers.get("content-length");
  invariant(
    request.body === null && (contentLength === null || contentLength === "0"),
    400,
    "body_rejected",
    "Request body is not allowed for this endpoint",
  );
}

function contentLength(request: Request, maximumBytes: number): number | null {
  const raw = request.headers.get("content-length");
  if (raw === null) return null;
  invariant(
    /^(?:0|[1-9][0-9]*)$/.test(raw),
    400,
    "invalid_content_length",
    "Content-Length is invalid",
  );
  const value = Number(raw);
  invariant(
    value <= maximumBytes,
    413,
    "body_too_large",
    "Request body exceeds route limit",
  );
  return value;
}

function exactLengthBody(
  body: ReadableStream<Uint8Array> | null,
  expectedBytes: number,
): ReadableStream<Uint8Array> {
  invariant(body, 400, "body_rejected", "Asset body is required");
  const reader = body.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          invariant(
            total === expectedBytes,
            400,
            "asset_rejected",
            "Asset size does not match declared manifest",
          );
          controller.close();
          return;
        }
        total += result.value.byteLength;
        invariant(
          total <= expectedBytes,
          400,
          "asset_rejected",
          "Asset size exceeds declared manifest",
        );
        controller.enqueue(result.value);
      } catch (error) {
        await reader.cancel("asset validation failed");
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

async function boundedResponseBytes(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    invariant(
      /^(?:0|[1-9][0-9]*)$/.test(declaredLength) &&
        Number(declaredLength) <= maximumBytes,
      502,
      "upstream_response_rejected",
      "Cloudflare control response is too large",
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel("response limit exceeded");
      throw new BrokerError(
        502,
        "upstream_response_rejected",
        "Cloudflare control response is too large",
      );
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseCloudflareEnvelope(bytes: Uint8Array): CloudflareEnvelope {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BrokerError(
      502,
      "upstream_response_rejected",
      "Cloudflare control response is not UTF-8",
    );
  }
  const value = parseStrictJson(source);
  invariant(
    isRecord(value) && value.success === true && isRecord(value.result),
    502,
    "upstream_response_rejected",
    "Cloudflare control response is invalid",
  );
  return { result: value.result, success: true };
}

function responseFromBytes(response: Response, bytes: Uint8Array): Response {
  return new Response(Uint8Array.from(bytes).buffer, {
    headers: sanitizeResponseHeaders(response.headers),
    status: response.status,
    statusText: response.statusText,
  });
}

function assertNoRedirect(response: Response): void {
  invariant(
    response.status < 300 || response.status >= 400,
    502,
    "upstream_redirect_rejected",
    "Cloudflare API redirect was rejected",
  );
}

function validateAssetJwt(value: unknown): string {
  invariant(
    typeof value === "string" &&
      value.length <= 16_384 &&
      CLOUDFLARE_ASSET_JWT_PATTERN.test(value),
    502,
    "asset_session_rejected",
    "Cloudflare asset session token is invalid",
  );
  return value;
}

function validateRegistration(value: unknown): RegistrationBody {
  invariant(
    isRecord(value) &&
      exactKeys(value, [
        "digest",
        "expiresAt",
        "jtiHash",
        "manifest",
        "sessionId",
      ]) &&
      typeof value.digest === "string" &&
      /^[0-9a-f]{64}$/.test(value.digest) &&
      typeof value.jtiHash === "string" &&
      /^[0-9a-f]{64}$/.test(value.jtiHash) &&
      typeof value.sessionId === "string" &&
      SESSION_ID_PATTERN.test(value.sessionId) &&
      typeof value.expiresAt === "number" &&
      Number.isSafeInteger(value.expiresAt),
    400,
    "registration_rejected",
    "Session registration is invalid",
  );
  return {
    digest: value.digest,
    expiresAt: value.expiresAt,
    jtiHash: value.jtiHash,
    manifest: parseManifest(value.manifest),
    sessionId: value.sessionId,
  };
}

export class DeploySessionDO extends DurableObject<BrokerEnv> {
  constructor(
    private readonly state: DurableObjectState,
    env: BrokerEnv,
  ) {
    super(state, env);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (
        url.origin === "https://deploy-session.internal" &&
        url.pathname === "/register"
      ) {
        return await this.register(request);
      }
      return await this.proxy(request);
    } catch (error) {
      const session =
        await this.state.storage.get<SessionRecord>(SESSION_STORAGE_KEY);
      audit(
        {
          code: error instanceof BrokerError ? error.code : "internal_error",
          decision: "deny",
          method: request.method,
          ...(session ? { sessionId: session.sessionId } : {}),
          status: error instanceof BrokerError ? error.status : 500,
        },
        session?.manifest,
      );
      return errorResponse(error);
    }
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }

  private async register(request: Request): Promise<Response> {
    invariant(
      request.method === "POST" &&
        request.headers.get("x-broker-internal") === "1",
      404,
      "session_route_rejected",
      "Session route is unavailable",
    );
    validateEnvironment(this.env, { requireCloudflareToken: false });
    const { value } = await readJsonBounded(request, 64 * 1024);
    const input = validateRegistration(value);
    const now = Date.now();
    invariant(
      input.expiresAt > now && input.expiresAt <= now + 10 * 60 * 1_000,
      400,
      "registration_rejected",
      "Session expiration is invalid",
    );
    invariant(
      (await manifestDigest(input.manifest)) === input.digest,
      400,
      "registration_rejected",
      "Session manifest digest is invalid",
    );

    const existing =
      await this.state.storage.get<SessionRecord>(SESSION_STORAGE_KEY);
    if (existing) {
      invariant(
        existing.sessionId === input.sessionId &&
          existing.digest === input.digest &&
          existing.jtiHash === input.jtiHash &&
          existing.expiresAt === input.expiresAt &&
          canonicalJson(existing.manifest) === canonicalJson(input.manifest),
        409,
        "session_replay_rejected",
        "Session identifier is already bound",
      );
      return jsonResponse(200, { expiresAt: existing.expiresAt, ok: true });
    }

    const session: SessionRecord = {
      createdAt: now,
      digest: input.digest,
      expiresAt: input.expiresAt,
      jtiHash: input.jtiHash,
      manifest: input.manifest,
      requestCount: 0,
      sessionId: input.sessionId,
      version: 1,
      windowCount: 0,
      windowStartedAt: now,
    };
    await this.state.storage.put(SESSION_STORAGE_KEY, session);
    await this.state.storage.setAlarm(input.expiresAt + 60_000);
    return jsonResponse(201, { expiresAt: input.expiresAt, ok: true });
  }

  private async loadSession(): Promise<SessionRecord> {
    const raw =
      await this.state.storage.get<SessionRecord>(SESSION_STORAGE_KEY);
    invariant(
      raw?.version === 1,
      404,
      "session_not_found",
      "Deployment session does not exist",
    );
    const manifest = parseManifest(raw.manifest);
    invariant(
      (await manifestDigest(manifest)) === raw.digest &&
        SESSION_ID_PATTERN.test(raw.sessionId) &&
        /^[0-9a-f]{64}$/.test(raw.jtiHash),
      500,
      "session_corrupt",
      "Deployment session failed integrity validation",
    );
    invariant(
      Date.now() < raw.expiresAt,
      401,
      "session_expired",
      "Deployment session expired",
    );
    return { ...raw, manifest };
  }

  private async consumeRequestBudget(): Promise<void> {
    const now = Date.now();
    await this.state.storage.transaction(async (transaction) => {
      const session = await transaction.get<SessionRecord>(SESSION_STORAGE_KEY);
      invariant(
        session,
        404,
        "session_not_found",
        "Deployment session does not exist",
      );
      if (now - session.windowStartedAt >= 60_000) {
        session.windowStartedAt = now;
        session.windowCount = 0;
      }
      invariant(
        session.requestCount < SESSION_REQUEST_LIMIT &&
          session.windowCount < SESSION_REQUESTS_PER_MINUTE,
        429,
        "session_rate_limited",
        "Deployment session request limit exceeded",
      );
      session.requestCount += 1;
      session.windowCount += 1;
      await transaction.put(SESSION_STORAGE_KEY, session);
    });
  }

  private async reserveMutation(key: string): Promise<void> {
    invariant(
      /^[A-Za-z0-9:._-]{1,256}$/.test(key),
      500,
      "mutation_key_invalid",
      "Mutation key is invalid",
    );
    await this.state.storage.transaction(async (transaction) => {
      const storageKey = `${MUTATION_STORAGE_PREFIX}${key}`;
      const existing = await transaction.get<number>(storageKey);
      invariant(
        existing === undefined,
        409,
        "mutation_replay_rejected",
        "Deployment mutation was already attempted",
      );
      await transaction.put(storageKey, Date.now());
    });
  }

  private async authenticateGitHub(
    request: Request,
    session: SessionRecord,
  ): Promise<void> {
    const claims = await verifyGitHubOidc(
      bearerToken(request),
      `${AUDIENCE_PREFIX}${session.digest}`,
    );
    validateIdentityClaims(session.manifest, claims);
    invariant(
      claims.exp * 1_000 === session.expiresAt &&
        timingSafeEqual(await sha256Hex(claims.jti), session.jtiHash),
      401,
      "session_token_rejected",
      "OIDC token is not bound to this deployment session",
    );
  }

  private assetStorageKey(route: ApiRoute): string {
    invariant(route.target, 500, "route_invalid", "Asset target is missing");
    return `${ASSET_STORAGE_PREFIX}${route.target.scriptName}`;
  }

  private async loadAssetState(route: ApiRoute): Promise<AssetState> {
    const value = await this.state.storage.get<AssetState>(
      this.assetStorageKey(route),
    );
    invariant(
      value &&
        isRecord(value.hashes) &&
        isRecord(value.uploadSizes) &&
        Array.isArray(value.completionJwtHashes),
      409,
      "asset_session_missing",
      "Asset upload session is not initialized",
    );
    return value;
  }

  private async authenticateAsset(
    request: Request,
    route: ApiRoute,
  ): Promise<{ assetState: AssetState; authorization: string }> {
    const authorization = request.headers.get("authorization");
    invariant(
      typeof authorization === "string" && authorization.startsWith("Bearer "),
      401,
      "asset_token_rejected",
      "Cloudflare asset session token is required",
    );
    const token = authorization.slice("Bearer ".length);
    invariant(
      CLOUDFLARE_ASSET_JWT_PATTERN.test(token),
      401,
      "asset_token_rejected",
      "Cloudflare asset session token is invalid",
    );
    const assetState = await this.loadAssetState(route);
    invariant(
      assetState.initialJwtHash !== undefined &&
        timingSafeEqual(await sha256Hex(token), assetState.initialJwtHash),
      401,
      "asset_token_rejected",
      "Cloudflare asset token is not bound to this session",
    );
    return { assetState, authorization };
  }

  private async verifyCompletionJwt(
    route: ApiRoute,
    token: string | undefined,
  ): Promise<void> {
    if (!route.target?.assets) {
      invariant(
        token === undefined,
        400,
        "assets_rejected",
        "Static assets are not declared",
      );
      return;
    }
    invariant(
      token,
      400,
      "assets_rejected",
      "Static asset completion token is missing",
    );
    const assetState = await this.loadAssetState(route);
    const hash = await sha256Hex(token);
    invariant(
      assetState.completionJwtHashes.some((candidate) =>
        timingSafeEqual(candidate, hash),
      ),
      400,
      "assets_rejected",
      "Static asset completion token is not bound to this session",
    );
  }

  private async verifyVersionTag(
    targetScript: string,
    versionId: string,
    expectedTag: string,
  ): Promise<void> {
    validateEnvironment(this.env, { requireCloudflareToken: true });
    const path = `/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${targetScript}/versions/${versionId}`;
    const response = await fetch(`${CLOUDFLARE_API_ORIGIN}${path}`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.env.CLOUDFLARE_BROKER_API_TOKEN}`,
      },
      redirect: "manual",
    });
    assertNoRedirect(response);
    invariant(
      response.status === 200,
      502,
      "version_verification_failed",
      "Cloudflare version could not be verified",
    );
    const envelope = parseCloudflareEnvelope(
      await boundedResponseBytes(response, MAX_CONTROL_RESPONSE_BYTES),
    );
    const annotations = envelope.result.annotations;
    invariant(
      envelope.result.id === versionId &&
        isRecord(annotations) &&
        annotations["workers/tag"] === expectedTag,
      403,
      "version_tag_rejected",
      "Cloudflare version tag does not match signed manifest",
    );
  }

  private async readTargetScriptState(
    target: TargetManifest,
    authorization: string,
  ): Promise<TargetScriptState | null> {
    const path = `/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/services/${target.scriptName}`;
    const response = await fetch(`${CLOUDFLARE_API_ORIGIN}${path}`, {
      headers: { accept: "application/json", authorization },
      redirect: "manual",
    });
    assertNoRedirect(response);
    if (response.status === 404) {
      await response.body?.cancel("target does not exist");
      return null;
    }
    invariant(
      response.status === 200,
      502,
      "target_state_unavailable",
      "Cloudflare target state could not be verified",
    );
    const envelope = parseCloudflareEnvelope(
      await boundedResponseBytes(response, MAX_CONTROL_RESPONSE_BYTES),
    );
    const defaultEnvironment = envelope.result.default_environment;
    const script = isRecord(defaultEnvironment)
      ? defaultEnvironment.script
      : undefined;
    const migrationTag = isRecord(script) ? script.migration_tag : undefined;
    invariant(
      migrationTag === undefined ||
        (typeof migrationTag === "string" &&
          target.migration !== null &&
          migrationTag === target.migration.tag),
      409,
      "migration_state_rejected",
      "Cloudflare Durable Object migration state differs from manifest",
    );
    return {
      ...(typeof migrationTag === "string" ? { migrationTag } : {}),
      scriptName: target.scriptName,
    };
  }

  private async readTargetScriptStates(
    manifest: DeploymentManifest,
    authorization: string,
  ): Promise<TargetScriptState[]> {
    const states: TargetScriptState[] = [];
    for (const target of manifest.targets.filter((candidate) =>
      candidate.operations.includes("script:read"),
    )) {
      const state = await this.readTargetScriptState(target, authorization);
      if (state) states.push(state);
    }
    return states;
  }

  private async verifyMigrationState(
    target: TargetManifest,
    migrationMode: "initial" | "none" | undefined,
    authorization: string,
  ): Promise<void> {
    invariant(
      migrationMode !== undefined,
      500,
      "migration_state_invalid",
      "Worker multipart migration state is missing",
    );
    if (target.migration === null) {
      invariant(
        migrationMode === "none",
        400,
        "migration_rejected",
        "Worker migration is not declared",
      );
      return;
    }
    const current = await this.readTargetScriptState(target, authorization);
    const expected =
      current?.migrationTag === target.migration.tag ? "none" : "initial";
    invariant(
      migrationMode === expected,
      409,
      "migration_state_rejected",
      "Worker migration does not match current signed lifecycle state",
    );
  }

  private async initializeAssetState(
    route: ApiRoute,
    manifest: ValidatedAssetManifest,
  ): Promise<void> {
    const state: AssetState = {
      completionJwtHashes: [],
      hashes: manifest.hashes,
      totalBytes: manifest.totalBytes,
      uploadSizes: Object.create(null) as Record<string, number>,
    };
    await this.state.storage.put(this.assetStorageKey(route), state);
  }

  private async captureAssetInitialization(
    route: ApiRoute,
    response: Response,
  ): Promise<Response> {
    const bytes = await boundedResponseBytes(
      response,
      MAX_CONTROL_RESPONSE_BYTES,
    );
    if (response.status >= 200 && response.status < 300) {
      const envelope = parseCloudflareEnvelope(bytes);
      const jwt = validateAssetJwt(envelope.result.jwt);
      invariant(
        Array.isArray(envelope.result.buckets),
        502,
        "asset_session_rejected",
        "Cloudflare asset buckets are invalid",
      );
      const state = await this.loadAssetState(route);
      const requested = new Set<string>();
      for (const bucket of envelope.result.buckets) {
        invariant(
          Array.isArray(bucket) && bucket.length <= 1_500,
          502,
          "asset_session_rejected",
          "Cloudflare asset bucket is invalid",
        );
        for (const hash of bucket) {
          invariant(
            typeof hash === "string" &&
              state.hashes[hash] !== undefined &&
              !requested.has(hash),
            502,
            "asset_session_rejected",
            "Cloudflare requested an undeclared asset",
          );
          requested.add(hash);
        }
      }
      const jwtHash = await sha256Hex(jwt);
      state.initialJwtHash = jwtHash;
      state.uploadSizes = Object.fromEntries(
        [...requested].map((hash) => [hash, state.hashes[hash] ?? 0]),
      );
      if (requested.size === 0) state.completionJwtHashes = [jwtHash];
      await this.state.storage.put(this.assetStorageKey(route), state);
    }
    return responseFromBytes(response, bytes);
  }

  private async captureAssetCompletion(
    route: ApiRoute,
    response: Response,
  ): Promise<Response> {
    const bytes = await boundedResponseBytes(
      response,
      MAX_CONTROL_RESPONSE_BYTES,
    );
    if (response.status >= 200 && response.status < 300) {
      const envelope = parseCloudflareEnvelope(bytes);
      const jwtHash = await sha256Hex(validateAssetJwt(envelope.result.jwt));
      await this.state.storage.transaction(async (transaction) => {
        const key = this.assetStorageKey(route);
        const state = await transaction.get<AssetState>(key);
        invariant(
          state,
          409,
          "asset_session_missing",
          "Asset upload session is not initialized",
        );
        if (!state.completionJwtHashes.includes(jwtHash)) {
          invariant(
            state.completionJwtHashes.length < 1_500,
            502,
            "asset_session_rejected",
            "Cloudflare returned too many asset completion tokens",
          );
          state.completionJwtHashes.push(jwtHash);
          await transaction.put(key, state);
        }
      });
    }
    return responseFromBytes(response, bytes);
  }

  private async proxy(request: Request): Promise<Response> {
    const session = await this.loadSession();
    await this.consumeRequestBudget();
    const api = proxyPath(request, session.sessionId);
    const route = authorizeApiRoute(
      session.manifest,
      request.method,
      api.pathname,
      api.search,
    );

    let authorization: string;
    let assetState: AssetState | undefined;
    if (
      route.kind === "asset-upload-bulk" ||
      route.kind === "asset-upload-single"
    ) {
      const authenticated = await this.authenticateAsset(request, route);
      authorization = authenticated.authorization;
      assetState = authenticated.assetState;
    } else {
      await this.authenticateGitHub(request, session);
      validateEnvironment(this.env, { requireCloudflareToken: true });
      authorization = `Bearer ${this.env.CLOUDFLARE_BROKER_API_TOKEN}`;
    }

    if (route.kind === "script-list-synthetic") {
      ensureNoBody(request);
      const response = syntheticScriptsResponse(
        await this.readTargetScriptStates(session.manifest, authorization),
      );
      audit(
        {
          decision: "allow",
          method: request.method,
          route: route.kind,
          sessionId: session.sessionId,
          status: response.status,
        },
        session.manifest,
      );
      return response;
    }

    let body: BodyInit | null = null;
    let mutationKey = route.mutationKey;
    if (route.maximumBodyBytes === 0) {
      ensureNoBody(request);
    } else if (
      route.kind === "secret-put" ||
      route.kind === "subdomain-write" ||
      route.kind === "asset-init" ||
      route.kind === "deployment-create"
    ) {
      const parsed = await readJsonBounded(request, route.maximumBodyBytes);
      body = Uint8Array.from(parsed.bytes).buffer;
      invariant(
        route.target,
        500,
        "route_invalid",
        "Mutation target is missing",
      );
      if (route.kind === "secret-put") {
        const secret = validateSecretBody(parsed.value, route.target);
        invariant(
          isRecord(parsed.value) &&
            typeof parsed.value.text === "string" &&
            timingSafeEqual(
              await sha256Hex(parsed.value.text),
              secret.expectedSha256,
            ),
          400,
          "secret_rejected",
          "Secret value does not match signed manifest",
        );
        mutationKey = secret.mutationKey;
      } else if (route.kind === "subdomain-write") {
        validateSubdomainBody(parsed.value, route.target);
      } else if (route.kind === "asset-init") {
        const assetManifest = validateAssetInitBody(parsed.value);
        invariant(
          mutationKey,
          500,
          "route_invalid",
          "Asset initialization mutation key is missing",
        );
        await this.reserveMutation(mutationKey);
        mutationKey = undefined;
        await this.initializeAssetState(route, assetManifest);
      } else {
        const deployment = validateDeploymentBody(parsed.value, route.target);
        invariant(
          route.target.versionTag,
          500,
          "route_invalid",
          "Deployment version tag is missing",
        );
        await this.verifyVersionTag(
          route.target.scriptName,
          deployment.versionId,
          route.target.versionTag,
        );
        mutationKey = `${route.mutationKey}:${deployment.versionId}`;
      }
    } else if (route.kind === "version-upload") {
      invariant(route.target, 500, "route_invalid", "Upload target is missing");
      const inspected = await inspectMultipart(
        request,
        {
          mode: "worker-version",
          target: route.target,
        },
        route.maximumBodyBytes,
      );
      await this.verifyMigrationState(
        route.target,
        inspected.migrationMode,
        authorization,
      );
      await this.verifyCompletionJwt(route, inspected.assetsJwt);
      body = inspected.body;
    } else if (route.kind === "asset-upload-bulk") {
      invariant(
        route.target && assetState,
        500,
        "route_invalid",
        "Asset state is missing",
      );
      const inspected = await inspectMultipart(
        request,
        {
          assetSizes: assetState.uploadSizes,
          mode: "assets",
          target: route.target,
        },
        route.maximumBodyBytes,
      );
      body = inspected.body;
      mutationKey = undefined;
    } else if (route.kind === "asset-upload-single") {
      invariant(
        route.assetHash && assetState,
        500,
        "route_invalid",
        "Asset state is missing",
      );
      const expected = assetState.uploadSizes[route.assetHash];
      invariant(
        expected !== undefined,
        400,
        "asset_rejected",
        "Asset is not declared in session",
      );
      const declaredLength = contentLength(request, route.maximumBodyBytes);
      validateSingleAssetLength(declaredLength, expected);
      body = exactLengthBody(request.body, expected);
      mutationKey = undefined;
    }

    if (mutationKey) await this.reserveMutation(mutationKey);

    const upstreamUrl = `${CLOUDFLARE_API_ORIGIN}/client/v4${api.pathname}${api.search}`;
    const response = await fetch(upstreamUrl, {
      body,
      headers: upstreamHeaders(request, authorization),
      method: request.method,
      redirect: "manual",
    });
    assertNoRedirect(response);

    let output: Response;
    if (route.kind === "asset-init") {
      output = await this.captureAssetInitialization(route, response);
    } else if (
      route.kind === "asset-upload-bulk" ||
      route.kind === "asset-upload-single"
    ) {
      output = await this.captureAssetCompletion(route, response);
    } else {
      output = new Response(response.body, {
        headers: sanitizeResponseHeaders(response.headers),
        status: response.status,
        statusText: response.statusText,
      });
    }
    audit(
      {
        decision: "allow",
        method: request.method,
        route: route.kind,
        sessionId: session.sessionId,
        status: output.status,
        ...(route.target ? { target: route.target.scriptName } : {}),
      },
      session.manifest,
    );
    return output;
  }
}

interface RateWindow {
  count: number;
  startedAt: number;
}

export class AuthRateLimitDO extends DurableObject<BrokerEnv> {
  constructor(
    private readonly state: DurableObjectState,
    env: BrokerEnv,
  ) {
    super(state, env);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      invariant(
        request.method === "POST" &&
          url.origin === "https://auth-rate.internal" &&
          url.pathname === "/consume" &&
          request.headers.get("x-broker-internal") === "1",
        404,
        "rate_route_rejected",
        "Rate-limit route is unavailable",
      );
      const now = Date.now();
      await this.state.storage.transaction(async (transaction) => {
        const current = (await transaction.get<RateWindow>("window")) ?? {
          count: 0,
          startedAt: now,
        };
        if (now - current.startedAt >= 60_000) {
          current.count = 0;
          current.startedAt = now;
        }
        invariant(
          current.count < 6,
          429,
          "registration_rate_limited",
          "Deployment registration rate exceeded",
        );
        current.count += 1;
        await transaction.put("window", current);
      });
      return jsonResponse(200, { ok: true });
    } catch (error) {
      return errorResponse(error);
    }
  }
}
