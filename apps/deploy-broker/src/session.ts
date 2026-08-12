import { DurableObject } from "cloudflare:workers";
import {
  authorizeApiRoute,
  validateAssetInitBody,
  validateDeploymentBody,
  validateDeploymentDetail,
  validateRecoveryVersionDetail,
  validateSubdomainBody,
  validateVersionDetail,
  type ApiRoute,
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
const SEALED_VERSION_STORAGE_PREFIX = "sealed-version:";
const MUTATION_STORAGE_PREFIX = "mutation:";
const SESSION_REQUEST_LIMIT = 2_100;
const SESSION_REQUESTS_PER_MINUTE = 1_800;
const MAX_CONTROL_RESPONSE_BYTES = 512 * 1024;
const VERIFICATION_RETRY_DELAYS_MS = [0, 100, 250, 500, 1_000] as const;
const SESSION_ID_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
  uploadedHashes: string[];
  uploadSizes: Record<string, number>;
}

interface CloudflareEnvelope {
  result: Record<string, unknown>;
  success: true;
}

interface TargetScriptState {
  migrationTag?: string;
  scriptName: string;
}

interface ReservedMutationRecord {
  createdAt: number;
  kind: "reserved";
}

interface VersionMutationRecord {
  createdAt: number;
  id: string;
  kind: "version";
  scriptName: string;
}

interface DeploymentMutationRecord {
  createdAt: number;
  id: string;
  kind: "deployment";
  scriptName: string;
  versionId: string;
}

type MutationRecord =
  DeploymentMutationRecord | ReservedMutationRecord | VersionMutationRecord;

class RetryableVerificationError extends Error {
  constructor() {
    super("Cloudflare readback is not visible yet");
    this.name = "RetryableVerificationError";
  }
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

function upstreamHeaders(
  request: Request,
  authorization: string,
  contentLengthOverride?: number | null,
): Headers {
  const output = new Headers({ authorization });
  for (const name of ["accept", "content-type", "user-agent"]) {
    const value = request.headers.get(name);
    if (value !== null) output.set(name, value);
  }
  if (contentLengthOverride === undefined) {
    const value = request.headers.get("content-length");
    if (value !== null) output.set("content-length", value);
  } else if (contentLengthOverride !== null) {
    output.set("content-length", String(contentLengthOverride));
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

function responseFromResult(
  response: Response,
  result: Record<string, unknown>,
): Response {
  const headers = sanitizeResponseHeaders(response.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(
    JSON.stringify({ errors: [], messages: [], result, success: true }),
    {
      headers,
      status: response.status,
      statusText: response.statusText,
    },
  );
}

function sanitizedFailure(response: Response): Response {
  const headers = sanitizeResponseHeaders(response.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(
    JSON.stringify({ errors: [], messages: [], result: {}, success: false }),
    {
      headers,
      status: response.status,
      statusText: response.statusText,
    },
  );
}

async function discardAndSanitizeFailure(
  response: Response,
): Promise<Response> {
  await response.body?.cancel("provider failure body is not exposed");
  return sanitizedFailure(response);
}

function assertNoRedirect(response: Response): void {
  invariant(
    response.status < 300 || response.status >= 400,
    502,
    "upstream_redirect_rejected",
    "Cloudflare API redirect was rejected",
  );
}

function transientReadStatus(status: number): boolean {
  return (
    status === 404 ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

async function cloudflareFetch(
  url: string,
  init: RequestInit,
  retryTransient = false,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (retryTransient) throw new RetryableVerificationError();
    throw error;
  }
  assertNoRedirect(response);
  if (retryTransient && transientReadStatus(response.status)) {
    await response.body?.cancel("Cloudflare readback is not visible yet");
    throw new RetryableVerificationError();
  }
  return response;
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

  private mutationStorageKey(key: string): string {
    invariant(
      /^[A-Za-z0-9:._-]{1,256}$/.test(key),
      500,
      "mutation_key_invalid",
      "Mutation key is invalid",
    );
    return `${MUTATION_STORAGE_PREFIX}${key}`;
  }

  private async loadMutation(key: string): Promise<MutationRecord | undefined> {
    const value = await this.state.storage.get<unknown>(
      this.mutationStorageKey(key),
    );
    if (value === undefined) return undefined;
    // Sessions created by the previous broker revision stored the reservation
    // timestamp directly. Preserve fail-safe replay rejection during rollout.
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      return { createdAt: value, kind: "reserved" };
    }
    invariant(
      isRecord(value) &&
        typeof value.createdAt === "number" &&
        Number.isSafeInteger(value.createdAt),
      500,
      "mutation_state_corrupt",
      "Deployment mutation state failed integrity validation",
    );
    if (value.kind === "reserved") {
      invariant(
        exactKeys(value, ["createdAt", "kind"]),
        500,
        "mutation_state_corrupt",
        "Deployment mutation state failed integrity validation",
      );
      return { createdAt: value.createdAt, kind: "reserved" };
    }
    if (value.kind === "version") {
      invariant(
        exactKeys(value, ["createdAt", "id", "kind", "scriptName"]) &&
          typeof value.id === "string" &&
          VERSION_ID_PATTERN.test(value.id) &&
          typeof value.scriptName === "string",
        500,
        "mutation_state_corrupt",
        "Deployment mutation state failed integrity validation",
      );
      return {
        createdAt: value.createdAt,
        id: value.id,
        kind: "version",
        scriptName: value.scriptName,
      };
    }
    invariant(
      value.kind === "deployment" &&
        exactKeys(value, [
          "createdAt",
          "id",
          "kind",
          "scriptName",
          "versionId",
        ]) &&
        typeof value.id === "string" &&
        VERSION_ID_PATTERN.test(value.id) &&
        typeof value.scriptName === "string" &&
        typeof value.versionId === "string" &&
        VERSION_ID_PATTERN.test(value.versionId),
      500,
      "mutation_state_corrupt",
      "Deployment mutation state failed integrity validation",
    );
    return {
      createdAt: value.createdAt,
      id: value.id,
      kind: "deployment",
      scriptName: value.scriptName,
      versionId: value.versionId,
    };
  }

  private async reserveMutation(key: string): Promise<void> {
    const storageKey = this.mutationStorageKey(key);
    await this.state.storage.transaction(async (transaction) => {
      const existing = await transaction.get<unknown>(storageKey);
      invariant(
        existing === undefined,
        409,
        "mutation_replay_rejected",
        "Deployment mutation was already attempted",
      );
      const record: ReservedMutationRecord = {
        createdAt: Date.now(),
        kind: "reserved",
      };
      await transaction.put(storageKey, record);
    });
  }

  private async storeMutationCandidate(
    key: string,
    record: DeploymentMutationRecord | VersionMutationRecord,
  ): Promise<void> {
    const storageKey = this.mutationStorageKey(key);
    await this.state.storage.transaction(async (transaction) => {
      const current = await transaction.get<unknown>(storageKey);
      invariant(
        (typeof current === "number" && Number.isSafeInteger(current)) ||
          (isRecord(current) && current.kind === "reserved"),
        500,
        "mutation_state_corrupt",
        "Deployment mutation reservation was lost",
      );
      await transaction.put(storageKey, record);
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
        isRecord(value.contentTypeByHash) &&
        isRecord(value.hashes) &&
        isRecord(value.sha256ByHash) &&
        isRecord(value.uploadSizes) &&
        Array.isArray(value.uploadedHashes) &&
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

  private async verifyVersionState(
    target: TargetManifest,
    versionId: string,
  ): Promise<void> {
    validateEnvironment(this.env, { requireCloudflareToken: true });
    const path = `/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${target.scriptName}/versions/${versionId}`;
    const response = await cloudflareFetch(
      `${CLOUDFLARE_API_ORIGIN}${path}`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.env.CLOUDFLARE_BROKER_API_TOKEN}`,
        },
        redirect: "manual",
      },
      true,
    );
    invariant(
      response.status === 200,
      502,
      "version_verification_failed",
      "Cloudflare version could not be verified",
    );
    const envelope = parseCloudflareEnvelope(
      await boundedResponseBytes(response, MAX_CONTROL_RESPONSE_BYTES),
    );
    try {
      validateVersionDetail(envelope.result, target, versionId);
    } catch (error) {
      if (
        error instanceof BrokerError &&
        error.code === "version_verification_failed"
      ) {
        throw new RetryableVerificationError();
      }
      throw error;
    }
  }

  private async retryVerification<T>(
    verify: () => Promise<T>,
    failureCode: string,
    failureMessage: string,
  ): Promise<T> {
    for (const delay of VERIFICATION_RETRY_DELAYS_MS) {
      if (delay > 0) await scheduler.wait(delay);
      try {
        return await verify();
      } catch (error) {
        if (!(error instanceof RetryableVerificationError)) throw error;
      }
    }
    throw new BrokerError(503, failureCode, failureMessage);
  }

  private async verifyRecoveryEligibility(
    manifest: DeploymentManifest,
    target: TargetManifest,
  ): Promise<{
    activeDeploymentId: string;
    mode: "already_active" | "redeployed_prior";
    releaseSha: string;
  }> {
    const recovery = manifest.recovery;
    invariant(
      recovery,
      500,
      "recovery_state_invalid",
      "Recovery authorization is missing",
    );
    validateEnvironment(this.env, { requireCloudflareToken: true });
    const authorization = `Bearer ${this.env.CLOUDFLARE_BROKER_API_TOKEN}`;
    const root = `/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${target.scriptName}`;
    const listResponse = await cloudflareFetch(
      `${CLOUDFLARE_API_ORIGIN}${root}/deployments`,
      {
        headers: { accept: "application/json", authorization },
        redirect: "manual",
      },
      true,
    );
    invariant(
      listResponse.status === 200,
      502,
      "recovery_verification_failed",
      "Cloudflare deployment history could not be verified",
    );
    const listEnvelope = parseCloudflareEnvelope(
      await boundedResponseBytes(listResponse, MAX_CONTROL_RESPONSE_BYTES),
    );
    const deployments = listEnvelope.result.deployments;
    invariant(
      Array.isArray(deployments) && deployments.length > 0,
      409,
      "recovery_rejected",
      "Cloudflare deployment history cannot prove the prior release",
    );
    const latest = deployments[0];
    const latestVersion =
      isRecord(latest) && Array.isArray(latest.versions)
        ? latest.versions[0]
        : undefined;
    invariant(
      isRecord(latest) &&
        typeof latest.id === "string" &&
        isRecord(latestVersion) &&
        typeof latestVersion.version_id === "string",
      502,
      "recovery_verification_failed",
      "Cloudflare latest deployment is invalid",
    );

    let mode: "already_active" | "redeployed_prior";
    if (latestVersion.version_id === recovery.priorVersionId) {
      validateDeploymentDetail(latest, latest.id, recovery.priorVersionId);
      mode = "already_active";
    } else {
      if (recovery.failedDeploymentId !== null) {
        invariant(
          latest.id === recovery.failedDeploymentId,
          409,
          "recovery_rejected",
          "Active deployment is not the failed receipt deployment",
        );
      }
      if (recovery.failedVersionId !== null) {
        invariant(
          latestVersion.version_id === recovery.failedVersionId,
          409,
          "recovery_rejected",
          "Active version is not the failed receipt version",
        );
      } else {
        invariant(
          recovery.failedDeploymentId !== null,
          409,
          "recovery_rejected",
          "Receipt cannot identify a superseding failed release",
        );
      }
      const prior = deployments[1];
      validateDeploymentDetail(
        prior,
        recovery.priorDeploymentId,
        recovery.priorVersionId,
      );
      mode = "redeployed_prior";
    }

    const priorDeploymentResponse = await cloudflareFetch(
      `${CLOUDFLARE_API_ORIGIN}${root}/deployments/${recovery.priorDeploymentId}`,
      {
        headers: { accept: "application/json", authorization },
        redirect: "manual",
      },
      true,
    );
    invariant(
      priorDeploymentResponse.status === 200,
      502,
      "recovery_verification_failed",
      "Prior Cloudflare deployment could not be verified",
    );
    const priorDeployment = parseCloudflareEnvelope(
      await boundedResponseBytes(
        priorDeploymentResponse,
        MAX_CONTROL_RESPONSE_BYTES,
      ),
    );
    validateDeploymentDetail(
      priorDeployment.result,
      recovery.priorDeploymentId,
      recovery.priorVersionId,
    );

    const priorVersionResponse = await cloudflareFetch(
      `${CLOUDFLARE_API_ORIGIN}${root}/versions/${recovery.priorVersionId}`,
      {
        headers: { accept: "application/json", authorization },
        redirect: "manual",
      },
      true,
    );
    invariant(
      priorVersionResponse.status === 200,
      502,
      "recovery_verification_failed",
      "Prior Cloudflare version could not be verified",
    );
    const priorVersion = parseCloudflareEnvelope(
      await boundedResponseBytes(
        priorVersionResponse,
        MAX_CONTROL_RESPONSE_BYTES,
      ),
    );
    const releaseSha = validateRecoveryVersionDetail(
      priorVersion.result,
      target,
      recovery.priorVersionId,
    );
    return { activeDeploymentId: latest.id, mode, releaseSha };
  }

  private async sealedVersionId(target: TargetManifest): Promise<string> {
    const versionId = await this.state.storage.get<string>(
      `${SEALED_VERSION_STORAGE_PREFIX}${target.scriptName}`,
    );
    invariant(
      typeof versionId === "string" && VERSION_ID_PATTERN.test(versionId),
      409,
      "version_not_sealed",
      "Exact Worker version has not passed broker post-state verification",
    );
    return versionId;
  }

  private async captureServiceRead(
    route: ApiRoute,
    response: Response,
  ): Promise<Response> {
    invariant(route.target, 500, "route_invalid", "Service target is missing");
    if (response.status !== 200) return discardAndSanitizeFailure(response);
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
          route.target.migrations.some(
            (migration) => migration.tag === migrationTag,
          )),
      409,
      "migration_state_rejected",
      "Cloudflare Durable Object migration state differs from manifest",
    );
    return responseFromResult(response, {
      default_environment: {
        script: {
          ...(typeof migrationTag === "string"
            ? { migration_tag: migrationTag }
            : {}),
        },
      },
    });
  }

  private async captureDeploymentList(
    route: ApiRoute,
    response: Response,
  ): Promise<Response> {
    invariant(
      route.target,
      500,
      "route_invalid",
      "Deployment target is missing",
    );
    if (response.status !== 200) return discardAndSanitizeFailure(response);
    const envelope = parseCloudflareEnvelope(
      await boundedResponseBytes(response, MAX_CONTROL_RESPONSE_BYTES),
    );
    const deployments = envelope.result.deployments;
    invariant(
      Array.isArray(deployments),
      502,
      "deployment_verification_failed",
      "Cloudflare deployment inventory is invalid",
    );
    if (deployments.length === 0) {
      return responseFromResult(response, { deployments: [] });
    }
    const latest = deployments[0];
    const version =
      isRecord(latest) && Array.isArray(latest.versions)
        ? latest.versions[0]
        : undefined;
    invariant(
      isRecord(latest) &&
        typeof latest.id === "string" &&
        VERSION_ID_PATTERN.test(latest.id) &&
        latest.strategy === "percentage" &&
        Array.isArray(latest.versions) &&
        latest.versions.length === 1 &&
        isRecord(version) &&
        typeof version.version_id === "string" &&
        VERSION_ID_PATTERN.test(version.version_id) &&
        version.percentage === 100,
      502,
      "deployment_verification_failed",
      "Cloudflare active deployment is not one immutable version at 100%",
    );
    return responseFromResult(response, {
      deployments: [
        {
          id: latest.id,
          strategy: "percentage",
          versions: [{ percentage: 100, version_id: version.version_id }],
        },
      ],
    });
  }

  private async captureVersionUpload(
    route: ApiRoute,
    response: Response,
    mutationKey: string,
  ): Promise<Response> {
    const bytes = await boundedResponseBytes(
      response,
      MAX_CONTROL_RESPONSE_BYTES,
    );
    if (response.status >= 200 && response.status < 300) {
      invariant(route.target, 500, "route_invalid", "Upload target is missing");
      const envelope = parseCloudflareEnvelope(bytes);
      const versionId = envelope.result.id;
      invariant(
        typeof versionId === "string" && VERSION_ID_PATTERN.test(versionId),
        502,
        "version_verification_failed",
        "Cloudflare upload did not return an immutable version ID",
      );
      await this.storeMutationCandidate(mutationKey, {
        createdAt: Date.now(),
        id: versionId,
        kind: "version",
        scriptName: route.target.scriptName,
      });
      await this.retryVerification(
        () => this.verifyVersionState(route.target!, versionId),
        "version_verification_pending",
        "Cloudflare version verification is pending; retry same request",
      );
      await this.state.storage.put(
        `${SEALED_VERSION_STORAGE_PREFIX}${route.target.scriptName}`,
        versionId,
      );
      return responseFromResult(response, { id: versionId });
    }
    return sanitizedFailure(response);
  }

  private async verifyDeploymentState(
    target: TargetManifest,
    versionId: string,
    deploymentId: string,
  ): Promise<void> {
    const deploymentPath = `/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${target.scriptName}/deployments/${deploymentId}`;
    const deploymentResponse = await cloudflareFetch(
      `${CLOUDFLARE_API_ORIGIN}${deploymentPath}`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.env.CLOUDFLARE_BROKER_API_TOKEN}`,
        },
        redirect: "manual",
      },
      true,
    );
    invariant(
      deploymentResponse.status === 200,
      502,
      "deployment_verification_failed",
      "Cloudflare deployment could not be verified",
    );
    const deploymentEnvelope = parseCloudflareEnvelope(
      await boundedResponseBytes(
        deploymentResponse,
        MAX_CONTROL_RESPONSE_BYTES,
      ),
    );
    try {
      validateDeploymentDetail(
        deploymentEnvelope.result,
        deploymentId,
        versionId,
      );
    } catch (error) {
      if (
        error instanceof BrokerError &&
        error.code === "deployment_verification_failed"
      ) {
        throw new RetryableVerificationError();
      }
      throw error;
    }

    const listPath = `/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${target.scriptName}/deployments`;
    const response = await cloudflareFetch(
      `${CLOUDFLARE_API_ORIGIN}${listPath}`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.env.CLOUDFLARE_BROKER_API_TOKEN}`,
        },
        redirect: "manual",
      },
      true,
    );
    invariant(
      response.status === 200,
      502,
      "deployment_verification_failed",
      "Cloudflare deployment could not be verified",
    );
    const envelope = parseCloudflareEnvelope(
      await boundedResponseBytes(response, MAX_CONTROL_RESPONSE_BYTES),
    );
    const deployments = envelope.result.deployments;
    const latest = Array.isArray(deployments) ? deployments[0] : undefined;
    if (!isRecord(latest) || latest.id !== deploymentId) {
      throw new RetryableVerificationError();
    }
    try {
      validateDeploymentDetail(latest, deploymentId, versionId);
    } catch (error) {
      if (
        error instanceof BrokerError &&
        error.code === "deployment_verification_failed"
      ) {
        throw new RetryableVerificationError();
      }
      throw error;
    }
    const finalMigration = target.migrations.at(-1);
    if (finalMigration) {
      const scriptState = await this.readTargetScriptState(
        target,
        `Bearer ${this.env.CLOUDFLARE_BROKER_API_TOKEN}`,
        true,
      );
      if (scriptState?.migrationTag !== finalMigration.tag) {
        throw new RetryableVerificationError();
      }
    }
  }

  private async captureDeployment(
    route: ApiRoute,
    versionId: string,
    response: Response,
    mutationKey: string,
    recoveryReleaseSha: string | undefined,
  ): Promise<Response> {
    const bytes = await boundedResponseBytes(
      response,
      MAX_CONTROL_RESPONSE_BYTES,
    );
    if (response.status >= 200 && response.status < 300) {
      invariant(
        route.target,
        500,
        "route_invalid",
        "Deployment target is missing",
      );
      const envelope = parseCloudflareEnvelope(bytes);
      const deploymentId = envelope.result.id;
      invariant(
        typeof deploymentId === "string" &&
          VERSION_ID_PATTERN.test(deploymentId),
        502,
        "deployment_verification_failed",
        "Cloudflare deployment did not return an immutable deployment ID",
      );
      validateDeploymentDetail(envelope.result, deploymentId, versionId);
      await this.storeMutationCandidate(mutationKey, {
        createdAt: Date.now(),
        id: deploymentId,
        kind: "deployment",
        scriptName: route.target.scriptName,
        versionId,
      });
      await this.retryVerification(
        () =>
          this.verifyDeploymentState(route.target!, versionId, deploymentId),
        "deployment_verification_pending",
        "Cloudflare deployment verification is pending; retry same request",
      );
      return responseFromResult(response, {
        id: deploymentId,
        ...(recoveryReleaseSha
          ? {
              recovery_mode: "redeployed_prior",
              recovery_release_sha: recoveryReleaseSha,
            }
          : {}),
      });
    }
    return sanitizedFailure(response);
  }

  private async readTargetScriptState(
    target: TargetManifest,
    authorization: string,
    retryTransient = false,
  ): Promise<TargetScriptState | null> {
    const path = `/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/services/${target.scriptName}`;
    const response = await cloudflareFetch(
      `${CLOUDFLARE_API_ORIGIN}${path}`,
      {
        headers: { accept: "application/json", authorization },
        redirect: "manual",
      },
      retryTransient,
    );
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
          target.migrations.some(
            (migration) => migration.tag === migrationTag,
          )),
      409,
      "migration_state_rejected",
      "Cloudflare Durable Object migration state differs from manifest",
    );
    return {
      ...(typeof migrationTag === "string" ? { migrationTag } : {}),
      scriptName: target.scriptName,
    };
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
    const finalMigration = target.migrations.at(-1);
    if (!finalMigration) {
      invariant(
        migrationMode === "none",
        400,
        "migration_rejected",
        "Worker migration is not declared",
      );
      return;
    }
    const current = await this.readTargetScriptState(target, authorization);
    const currentIndex = current?.migrationTag
      ? target.migrations.findIndex(
          (migration) => migration.tag === current.migrationTag,
        )
      : -1;
    invariant(
      current === null || currentIndex >= 0,
      409,
      "migration_state_rejected",
      "Worker migration is outside signed lifecycle state",
    );
    const expected =
      current?.migrationTag === finalMigration.tag ? "none" : "initial";
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
      contentTypeByHash: manifest.contentTypeByHash,
      hashes: manifest.hashes,
      sha256ByHash: manifest.sha256ByHash,
      totalBytes: manifest.totalBytes,
      uploadedHashes: [],
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
    uploadedHashes: string[],
  ): Promise<Response> {
    const bytes = await boundedResponseBytes(
      response,
      MAX_CONTROL_RESPONSE_BYTES,
    );
    if (response.status >= 200 && response.status < 300) {
      const envelope = parseCloudflareEnvelope(bytes);
      const jwtHash =
        envelope.result.jwt === undefined
          ? undefined
          : await sha256Hex(validateAssetJwt(envelope.result.jwt));
      await this.state.storage.transaction(async (transaction) => {
        const key = this.assetStorageKey(route);
        const state = await transaction.get<AssetState>(key);
        invariant(
          state,
          409,
          "asset_session_missing",
          "Asset upload session is not initialized",
        );
        const completed = new Set(state.uploadedHashes);
        for (const hash of uploadedHashes) {
          invariant(
            state.uploadSizes[hash] !== undefined,
            500,
            "artifact_state_invalid",
            "Uploaded asset is absent from provider request state",
          );
          completed.add(hash);
        }
        state.uploadedHashes = [...completed].sort();
        const allUploaded = Object.keys(state.uploadSizes).every((hash) =>
          completed.has(hash),
        );
        if (allUploaded && jwtHash !== undefined) {
          state.completionJwtHashes = [jwtHash];
        }
        await transaction.put(key, state);
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

    let body: BodyInit | null = null;
    let forwardedContentLength: number | null | undefined;
    let mutationKey = route.mutationKey;
    let mutation: MutationRecord | undefined;
    let deploymentVersionId: string | undefined;
    let recoveryMode: "already_active" | "redeployed_prior" | undefined;
    let recoveryActiveDeploymentId: string | undefined;
    let recoveryReleaseSha: string | undefined;
    let uploadedAssetHashes: string[] = [];
    let versionMigrationMode: "initial" | "none" | undefined;
    if (route.maximumBodyBytes === 0) {
      ensureNoBody(request);
    } else if (
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
      if (route.kind === "subdomain-write") {
        validateSubdomainBody(parsed.value, route.target);
      } else if (route.kind === "asset-init") {
        const assetManifest = validateAssetInitBody(parsed.value, route.target);
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
        if (session.manifest.recovery) {
          invariant(
            timingSafeEqual(
              deployment.versionId,
              session.manifest.recovery.priorVersionId,
            ),
            403,
            "recovery_rejected",
            "Recovery version is not the provider-proven prior version",
          );
          const eligibility = await this.retryVerification(
            () =>
              this.verifyRecoveryEligibility(session.manifest, route.target!),
            "recovery_verification_pending",
            "Cloudflare recovery verification is pending; retry same request",
          );
          recoveryMode = eligibility.mode;
          recoveryActiveDeploymentId = eligibility.activeDeploymentId;
          recoveryReleaseSha = eligibility.releaseSha;
        } else {
          const sealedVersionId = await this.sealedVersionId(route.target);
          invariant(
            timingSafeEqual(deployment.versionId, sealedVersionId),
            403,
            "version_not_sealed",
            "Deployment version is not exact broker-sealed candidate",
          );
        }
        deploymentVersionId = deployment.versionId;
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
      await this.verifyCompletionJwt(route, inspected.assetsJwt);
      body = inspected.body;
      forwardedContentLength = inspected.contentLength;
      versionMigrationMode = inspected.migrationMode;
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
          assetDigests: assetState.sha256ByHash,
          assetContentTypes: assetState.contentTypeByHash,
          mode: "assets",
          target: route.target,
        },
        route.maximumBodyBytes,
      );
      body = inspected.body;
      forwardedContentLength = inspected.contentLength;
      uploadedAssetHashes = inspected.assetHashes ?? [];
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
      invariant(
        request.headers.get("content-type") ===
          assetState.contentTypeByHash[route.assetHash],
        415,
        "invalid_content_type",
        "Static asset content type does not match signed manifest",
      );
      const bytes = await readBodyBounded(request, route.maximumBodyBytes);
      invariant(
        bytes.byteLength === expected &&
          timingSafeEqual(
            await sha256Hex(bytes),
            assetState.sha256ByHash[route.assetHash] ?? "",
          ),
        400,
        "artifact_rejected",
        "Static asset does not match signed manifest",
      );
      body = Uint8Array.from(bytes).buffer;
      uploadedAssetHashes = [route.assetHash];
      mutationKey = undefined;
    }

    if (mutationKey) {
      mutation = await this.loadMutation(mutationKey);
      if (
        route.kind === "deployment-create" &&
        recoveryMode === "already_active" &&
        mutation === undefined
      ) {
        const output = responseFromResult(new Response(null, { status: 200 }), {
          id:
            recoveryActiveDeploymentId ??
            session.manifest.recovery!.priorDeploymentId,
          recovery_mode: "already_active",
          recovery_release_sha: recoveryReleaseSha,
        });
        audit(
          {
            decision: "allow",
            method: request.method,
            route: route.kind,
            sessionId: session.sessionId,
            status: output.status,
            target: route.target!.scriptName,
          },
          session.manifest,
        );
        return output;
      }
      if (mutation === undefined) {
        if (route.kind === "version-upload") {
          await this.verifyMigrationState(
            route.target!,
            versionMigrationMode,
            authorization,
          );
        } else if (route.kind === "deployment-create") {
          if (!session.manifest.recovery) {
            await this.retryVerification(
              () =>
                this.verifyVersionState(route.target!, deploymentVersionId!),
              "version_verification_pending",
              "Cloudflare version verification is pending; retry same request",
            );
          }
        }
        await this.reserveMutation(mutationKey);
      } else if (route.kind === "version-upload") {
        invariant(
          mutation.kind === "version" &&
            mutation.scriptName === route.target?.scriptName,
          409,
          "mutation_replay_rejected",
          "Deployment mutation was already attempted",
        );
        const candidate = mutation as VersionMutationRecord;
        await this.retryVerification(
          () => this.verifyVersionState(route.target!, candidate.id),
          "version_verification_pending",
          "Cloudflare version verification is pending; retry same request",
        );
        await this.state.storage.put(
          `${SEALED_VERSION_STORAGE_PREFIX}${route.target.scriptName}`,
          candidate.id,
        );
        const output = responseFromResult(new Response(null, { status: 200 }), {
          id: candidate.id,
        });
        audit(
          {
            decision: "allow",
            method: request.method,
            route: route.kind,
            sessionId: session.sessionId,
            status: output.status,
            target: route.target.scriptName,
          },
          session.manifest,
        );
        return output;
      } else if (route.kind === "deployment-create") {
        invariant(
          mutation.kind === "deployment" &&
            mutation.scriptName === route.target?.scriptName &&
            mutation.versionId === deploymentVersionId,
          409,
          "mutation_replay_rejected",
          "Deployment mutation was already attempted",
        );
        const deployment = mutation as DeploymentMutationRecord;
        await this.retryVerification(
          () =>
            this.verifyDeploymentState(
              route.target!,
              deployment.versionId,
              deployment.id,
            ),
          "deployment_verification_pending",
          "Cloudflare deployment verification is pending; retry same request",
        );
        const output = responseFromResult(new Response(null, { status: 200 }), {
          id: deployment.id,
          ...(session.manifest.recovery
            ? {
                recovery_mode: "redeployed_prior",
                recovery_release_sha: recoveryReleaseSha,
              }
            : {}),
        });
        audit(
          {
            decision: "allow",
            method: request.method,
            route: route.kind,
            sessionId: session.sessionId,
            status: output.status,
            target: route.target.scriptName,
          },
          session.manifest,
        );
        return output;
      } else {
        throw new BrokerError(
          409,
          "mutation_replay_rejected",
          "Deployment mutation was already attempted",
        );
      }
    }

    const upstreamUrl = `${CLOUDFLARE_API_ORIGIN}/client/v4${api.pathname}${api.search}`;
    const response = await fetch(upstreamUrl, {
      body,
      headers: upstreamHeaders(request, authorization, forwardedContentLength),
      method: request.method,
      redirect: "manual",
    });
    assertNoRedirect(response);

    let output: Response;
    if (route.kind === "service-read") {
      output = await this.captureServiceRead(route, response);
    } else if (route.kind === "deployment-list") {
      output = await this.captureDeploymentList(route, response);
    } else if (route.kind === "asset-init") {
      output = await this.captureAssetInitialization(route, response);
    } else if (route.kind === "version-upload") {
      invariant(
        mutationKey,
        500,
        "route_invalid",
        "Version mutation key is missing",
      );
      output = await this.captureVersionUpload(route, response, mutationKey);
    } else if (route.kind === "deployment-create") {
      invariant(
        deploymentVersionId,
        500,
        "route_invalid",
        "Deployment version is missing",
      );
      invariant(
        mutationKey,
        500,
        "route_invalid",
        "Deployment mutation key is missing",
      );
      output = await this.captureDeployment(
        route,
        deploymentVersionId,
        response,
        mutationKey,
        recoveryReleaseSha,
      );
    } else if (
      route.kind === "asset-upload-bulk" ||
      route.kind === "asset-upload-single"
    ) {
      output = await this.captureAssetCompletion(
        route,
        response,
        uploadedAssetHashes,
      );
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
