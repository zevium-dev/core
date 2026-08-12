import { auth } from "@clerk/tanstack-react-start/server";
import { isPublicIp, validateOpenApiSpec } from "@zevium/shared";
import { ConvexHttpClient } from "convex/browser";
import { isIP } from "node:net";
import { resolve4, resolve6 } from "node:dns/promises";
import { api } from "#/lib/convex-api";
import { convertSpecInputToJson } from "./spec-yaml";
import { MAX_SPEC_IMPORT_BYTES, type ImportSpecUrlInput } from "./spec-import";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const GENERIC_FETCH_ERROR = "Failed to fetch spec";
const SIZE_ERROR = "Spec is larger than 2MB";
const EMPTY_ERROR = "URL returned empty body";
const MIME_ERROR = "URL did not return supported JSON or YAML";
const INVALID_SPEC_ERROR = "URL did not return a valid OpenAPI 3 document";
const SESSION_ERROR = "Could not verify your session. Refresh and try again.";
const SIGN_IN_ERROR = "Sign in before importing a spec";
const ACTIVE_ORG_ERROR = "Select an organization before importing a spec";

const SUPPORTED_MEDIA_TYPES = new Set([
  "application/json",
  "application/yaml",
  "application/x-yaml",
  "application/vnd.oai.openapi+json",
  "application/vnd.oai.openapi+yaml",
  "text/yaml",
  "text/x-yaml",
]);

type ResolvedAddress = { address: string; family: number };

type SpecImportSession = {
  isAuthenticated: boolean;
  userId: string | null | undefined;
  orgId: string | null | undefined;
  convexToken?: string | null;
  convexUrl?: string;
};

export type SpecImportRuntime = {
  authenticate: () => Promise<SpecImportSession>;
  resolveHostname: (hostname: string) => Promise<ResolvedAddress[]>;
  fetch: (url: URL, init: RequestInit) => Promise<Response>;
  acquirePermit: (session: SpecImportSession) => Promise<() => Promise<void>>;
};

async function releaseWithRetry(
  convex: ConvexHttpClient,
  leaseId: string,
): Promise<void> {
  try {
    await convex.mutation(api.specImportLimits.release, { leaseId });
  } catch {
    // One immediate retry handles a transient failed response. Lease expiry is
    // final compensation if both attempts fail; release itself is idempotent.
    await convex.mutation(api.specImportLimits.release, { leaseId });
  }
}

const productionRuntime: SpecImportRuntime = {
  authenticate: async () => {
    const session = await auth();
    const convexToken =
      session.userId && session.orgId
        ? await session.getToken({ template: "convex" })
        : null;
    return {
      isAuthenticated: session.isAuthenticated,
      userId: session.userId,
      orgId: session.orgId,
      convexToken,
      convexUrl: import.meta.env.VITE_CONVEX_URL,
    };
  },
  resolveHostname: async (hostname) => {
    // Worker node:dns uses DoH. `global_fetch_strictly_public` remains enabled
    // as connect-time backstop against DNS rebinding.
    const [ipv4, ipv6] = await Promise.allSettled([
      resolve4(hostname),
      resolve6(hostname),
    ]);
    const addresses: ResolvedAddress[] = [];
    if (ipv4.status === "fulfilled") {
      addresses.push(...ipv4.value.map((address) => ({ address, family: 4 })));
    }
    if (ipv6.status === "fulfilled") {
      addresses.push(...ipv6.value.map((address) => ({ address, family: 6 })));
    }
    return addresses;
  },
  fetch: async (url, init) => await globalThis.fetch(url, init),
  acquirePermit: async (session) => {
    if (!session.convexUrl || !session.convexToken)
      throw new Error(SESSION_ERROR);
    const convex = new ConvexHttpClient(session.convexUrl);
    convex.setAuth(session.convexToken);
    const leaseId = crypto.randomUUID();
    await convex.mutation(api.specImportLimits.acquire, { leaseId });
    return async () => await releaseWithRetry(convex, leaseId);
  },
};

async function waitForAbortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new Error(GENERIC_FETCH_ERROR);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new Error(GENERIC_FETCH_ERROR));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function cancelResponseBody(
  response: Response,
  signal: AbortSignal,
): Promise<void> {
  if (!response.body) return;
  try {
    await waitForAbortable(response.body.cancel(), signal);
  } catch {
    // Request signal still bounds underlying work.
  }
}

async function assertSafeUrl(
  url: URL,
  runtime: SpecImportRuntime,
  signal: AbortSignal,
): Promise<void> {
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(GENERIC_FETCH_ERROR);
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (!isPublicIp(hostname)) throw new Error(GENERIC_FETCH_ERROR);
    return;
  }

  let resolved: ResolvedAddress[];
  try {
    resolved = await waitForAbortable(
      runtime.resolveHostname(hostname),
      signal,
    );
  } catch {
    throw new Error(GENERIC_FETCH_ERROR);
  }
  if (
    resolved.length === 0 ||
    resolved.some(
      ({ address, family }) =>
        (family !== 4 && family !== 6) ||
        isIP(address) !== family ||
        !isPublicIp(address),
    )
  ) {
    throw new Error(GENERIC_FETCH_ERROR);
  }
}

async function streamBodyUpTo(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(EMPTY_ERROR);
  const cancel = async () => {
    try {
      await waitForAbortable(reader.cancel(), signal);
    } catch {
      // Request signal still bounds underlying work.
    }
  };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await waitForAbortable(reader.read(), signal);
    } catch {
      await cancel();
      throw new Error(GENERIC_FETCH_ERROR);
    }
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maxBytes) {
      await cancel();
      throw new Error(SIZE_ERROR);
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

function mediaType(value: string | null): string | null {
  if (value === null) return null;
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

function isSupportedMediaType(value: string | null): boolean {
  const type = mediaType(value);
  if (type === null) return false;
  return SUPPORTED_MEDIA_TYPES.has(type) || type.endsWith("+json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse JSON/YAML, enforce OpenAPI 3 required shape, return canonical JSON. */
export function normalizeImportedOpenApi(text: string): string {
  const converted = convertSpecInputToJson(text);
  if (!converted.ok) throw new Error(INVALID_SPEC_ERROR);
  let raw: unknown;
  try {
    raw = JSON.parse(converted.json) as unknown;
  } catch {
    throw new Error(INVALID_SPEC_ERROR);
  }
  if (!isRecord(raw) || typeof raw.openapi !== "string") {
    throw new Error(INVALID_SPEC_ERROR);
  }
  if (!/^3\.(?:0|1)\.\d+(?:[-+].+)?$/.test(raw.openapi.trim())) {
    throw new Error(INVALID_SPEC_ERROR);
  }
  if (
    !isRecord(raw.info) ||
    typeof raw.info.title !== "string" ||
    raw.info.title.trim() === "" ||
    typeof raw.info.version !== "string" ||
    raw.info.version.trim() === ""
  ) {
    throw new Error(INVALID_SPEC_ERROR);
  }
  const normalized = `${JSON.stringify(raw, null, 2)}\n`;
  if (validateOpenApiSpec(normalized).errors.length > 0) {
    throw new Error(INVALID_SPEC_ERROR);
  }
  return normalized;
}

async function fetchAuthorizedSpec(
  data: ImportSpecUrlInput,
  runtime: SpecImportRuntime,
  signal: AbortSignal,
): Promise<{ text: string; contentType: string }> {
  let current = new URL(data.url);
  let response: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertSafeUrl(current, runtime, signal);
    let candidate: Response;
    try {
      candidate = await waitForAbortable(
        runtime.fetch(current, {
          method: "GET",
          redirect: "manual",
          signal,
          headers: {
            Accept:
              "application/json, application/yaml, application/x-yaml, text/yaml, text/x-yaml",
          },
        }),
        signal,
      );
    } catch {
      throw new Error(GENERIC_FETCH_ERROR);
    }
    if (candidate.status >= 300 && candidate.status < 400) {
      const location = candidate.headers.get("location");
      await cancelResponseBody(candidate, signal);
      if (!location) throw new Error(GENERIC_FETCH_ERROR);
      try {
        current = new URL(location, current);
      } catch {
        throw new Error(GENERIC_FETCH_ERROR);
      }
      continue;
    }
    response = candidate;
    break;
  }
  if (!response || !response.ok) {
    if (response) await cancelResponseBody(response, signal);
    throw new Error(GENERIC_FETCH_ERROR);
  }

  const contentType = response.headers.get("content-type");
  if (!isSupportedMediaType(contentType)) {
    await cancelResponseBody(response, signal);
    throw new Error(MIME_ERROR);
  }
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > MAX_SPEC_IMPORT_BYTES) {
      await cancelResponseBody(response, signal);
      throw new Error(SIZE_ERROR);
    }
  }
  let text: string;
  try {
    text = await streamBodyUpTo(response, MAX_SPEC_IMPORT_BYTES, signal);
  } catch (error) {
    if (error instanceof TypeError) throw new Error(INVALID_SPEC_ERROR);
    throw error;
  }
  if (text.trim() === "") throw new Error(EMPTY_ERROR);
  return {
    text: normalizeImportedOpenApi(text),
    contentType: "application/json",
  };
}

/** Auth, global per-user/org lease, then bounded public fetch and validation. */
export async function fetchSpecFromUrlForRequest(
  data: ImportSpecUrlInput,
  runtime: SpecImportRuntime = productionRuntime,
): Promise<{ text: string; contentType: string }> {
  let session: SpecImportSession;
  try {
    session = await runtime.authenticate();
  } catch {
    throw new Error(SESSION_ERROR);
  }
  if (session.isAuthenticated !== true || !session.userId) {
    throw new Error(SIGN_IN_ERROR);
  }
  if (!session.orgId) throw new Error(ACTIVE_ORG_ERROR);

  const release = await runtime.acquirePermit(session);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(GENERIC_FETCH_ERROR)),
    FETCH_TIMEOUT_MS,
  );
  try {
    return await fetchAuthorizedSpec(data, runtime, controller.signal);
  } finally {
    clearTimeout(timeout);
    if (!controller.signal.aborted) controller.abort();
    try {
      await release();
    } catch {
      // Expiring server-side lease is recovery; never mask fetch result/error.
    }
  }
}
