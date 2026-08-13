import { auth, clerkClient } from "@clerk/tanstack-react-start/server";
import { getRequest } from "@tanstack/react-start/server";
import { isPublicIp, validateOpenApiSpec } from "@zevium/shared";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { isIP } from "node:net";
import { resolve4, resolve6 } from "node:dns/promises";
import { api } from "#/lib/convex-api";
import { MAX_EXPANDED_SPEC_BYTES } from "./spec-yaml";
import {
  MAX_SPEC_IMPORT_BYTES,
  parseImportSpecUrl,
  type ImportSpecUrlInput,
} from "./spec-import";

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
  acquirePermit: (session: SpecImportSession) => Promise<{
    renew: () => Promise<void>;
    release: () => Promise<void>;
  }>;
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
    if (session.userId && session.orgId) {
      const client = await clerkClient();
      const memberships =
        await client.organizations.getOrganizationMembershipList({
          organizationId: session.orgId,
          userId: [session.userId],
          limit: 1,
        });
      if (
        !memberships.data.some(
          (membership) => membership.publicUserData?.userId === session.userId,
        )
      ) {
        throw new Error(SESSION_ERROR);
      }
    }
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
    return {
      renew: async () => {
        await convex.mutation(api.specImportLimits.renew, { leaseId });
      },
      release: async () => await releaseWithRetry(convex, leaseId),
    };
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

const SCHEME_ERROR = "URL must be https";
const ORIGIN_ERROR = "Request origin is not allowed";

const acquireSpecImportLeaseRef = makeFunctionReference<
  "mutation",
  Record<never, never>,
  { remaining: number; resetsAt: number }
>("specImports:acquireLease");

function isNonPublicIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const numbers = parts.map((part) => Number(part));
  if (
    numbers.some(
      (number) => !Number.isInteger(number) || number < 0 || number > 255,
    )
  ) {
    return false;
  }
  const [first, second] = numbers;
  if (first === 0 || first === 10 || first === 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  if (first === 192 && second === 0) return true;
  if (first === 198 && (second === 18 || second === 19)) return true;
  if (
    (first === 192 && second === 0 && numbers[2] === 2) ||
    (first === 198 && second === 51 && numbers[2] === 100) ||
    (first === 203 && second === 0 && numbers[2] === 113)
  ) {
    return true;
  }
  return first >= 224;
}

function ipv4ToTwoGroups(ip: string): [number, number] | null {
  const parts = ip.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some(
      (number) => !Number.isInteger(number) || number < 0 || number > 255,
    )
  ) {
    return null;
  }
  return [(parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3]];
}

function expandIPv6(ip: string): number[] | null {
  const lastColon = ip.lastIndexOf(":");
  if (lastColon !== -1 && ip.slice(lastColon + 1).includes(".")) {
    const ipv4 = ipv4ToTwoGroups(ip.slice(lastColon + 1));
    if (ipv4 === null) return null;
    ip = `${ip.slice(0, lastColon + 1)}${ipv4[0].toString(16)}:${ipv4[1].toString(16)}`;
  }

  const halves = ip.split("::");
  if (halves.length > 2) return null;
  let groups: string[];
  if (halves.length === 2) {
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves[1] ? halves[1].split(":") : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array.from({ length: fill }, () => "0"), ...tail];
  } else {
    groups = ip.split(":");
  }
  if (groups.length !== 8) return null;

  const parsed: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/iu.test(group)) return null;
    const number = Number.parseInt(group, 16);
    if (!Number.isFinite(number) || number < 0 || number > 0xffff) return null;
    parsed.push(number);
  }
  return parsed;
}

function isNonPublicIPv6(ip: string): boolean {
  const groups = expandIPv6(ip);
  if (groups === null) return true;
  const first = groups[0];
  if (groups.every((group) => group === 0)) return true;
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    return isNonPublicIPv4(
      `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`,
    );
  }
  if ((first & 0xe000) !== 0x2000) return true;
  // Tunnel, benchmarking, documentation, and non-routed special ranges are
  // inappropriate importer destinations even when they are not RFC1918.
  if (first === 0x2002 || first === 0x3ffe || first === 0x3fff) return true;
  if (first !== 0x2001) return false;
  const second = groups[1];
  return (
    second === 0 ||
    second === 2 ||
    (second >= 0x10 && second <= 0x2f) ||
    second === 0x0db8
  );
}

function isIPv4Literal(source: string): boolean {
  const parts = source.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d+$/u.test(part) && Number(part) <= 255)
  );
}

async function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error(GENERIC_FETCH_ERROR);
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error(GENERIC_FETCH_ERROR));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

async function assertSafeUrlBoundary(
  url: URL,
  signal: AbortSignal,
): Promise<void> {
  if (url.username !== "" || url.password !== "") {
    throw new Error(GENERIC_FETCH_ERROR);
  }
  if (url.protocol === "http:") {
    if (process.env.NODE_ENV !== "development") throw new Error(SCHEME_ERROR);
  } else if (url.protocol !== "https:") {
    throw new Error(GENERIC_FETCH_ERROR);
  }

  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (isIPv4Literal(hostname)) {
    if (isNonPublicIPv4(hostname)) throw new Error(GENERIC_FETCH_ERROR);
    return;
  }
  if (hostname.includes(":")) {
    if (isNonPublicIPv6(hostname)) throw new Error(GENERIC_FETCH_ERROR);
    return;
  }

  const answers = await withAbort(
    Promise.allSettled([resolve4(hostname), resolve6(hostname)]),
    signal,
  );
  const resolved = answers.flatMap((answer, familyIndex) =>
    answer.status === "fulfilled"
      ? answer.value.map((address) => ({
          address,
          family: familyIndex === 0 ? 4 : 6,
        }))
      : [],
  );
  if (resolved.length === 0) throw new Error(GENERIC_FETCH_ERROR);
  for (const result of resolved) {
    const blocked =
      result.family === 6
        ? isNonPublicIPv6(result.address)
        : result.family === 4
          ? isNonPublicIPv4(result.address)
          : true;
    if (blocked) throw new Error(GENERIC_FETCH_ERROR);
  }
}

function assertSameOrigin(request: Request): void {
  if (request.method !== "POST") throw new Error(ORIGIN_ERROR);
  const rawOrigin = request.headers.get("origin");
  if (rawOrigin === null || rawOrigin === "null") throw new Error(ORIGIN_ERROR);
  try {
    if (rawOrigin !== new URL(request.url).origin) {
      throw new Error(ORIGIN_ERROR);
    }
  } catch {
    throw new Error(ORIGIN_ERROR);
  }
}

function isAllowedSpecMimeType(raw: string | null): boolean {
  if (raw === null) return false;
  const essence = raw.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    essence === "application/json" ||
    essence === "application/yaml" ||
    essence === "application/x-yaml" ||
    essence === "text/yaml" ||
    essence === "text/x-yaml" ||
    essence === "text/plain" ||
    essence.endsWith("+json") ||
    essence.endsWith("+yaml")
  );
}

async function authorizeSpecImport(): Promise<void> {
  assertSameOrigin(getRequest());
  const session = await auth();
  if (!session.isAuthenticated || !session.userId) {
    throw new Error("Sign in before importing a spec");
  }
  if (!session.orgId || !session.orgRole) {
    throw new Error("Select an organization before importing a spec");
  }

  const convexUrl = import.meta.env.VITE_CONVEX_URL;
  const token = await session.getToken({ template: "convex" });
  if (!convexUrl || !token) {
    throw new Error("Spec import is temporarily unavailable");
  }
  const convex = new ConvexHttpClient(convexUrl);
  convex.setAuth(token);
  try {
    await convex.mutation(acquireSpecImportLeaseRef, {});
  } catch (error) {
    if (error instanceof Error && /rate limit exceeded/iu.test(error.message)) {
      throw new Error("Spec import rate limit exceeded. Try again later.");
    }
    throw new Error("Spec import is temporarily unavailable");
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

/** Parse JSON only. YAML is returned raw for browser worker isolation. */
export function normalizeImportedOpenApi(text: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
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
  if (
    new TextEncoder().encode(normalized).byteLength > MAX_EXPANDED_SPEC_BYTES
  ) {
    throw new Error(INVALID_SPEC_ERROR);
  }
  if (validateOpenApiSpec(normalized).errors.length > 0) {
    throw new Error(INVALID_SPEC_ERROR);
  }
  return normalized;
}

async function fetchAuthorizedSpec(
  data: ImportSpecUrlInput,
  runtime: SpecImportRuntime,
  signal: AbortSignal,
  renewPermit: () => Promise<void>,
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
  await waitForAbortable(renewPermit(), signal);
  if (signal.aborted) throw new Error(GENERIC_FETCH_ERROR);
  return {
    text:
      mediaType(contentType)?.endsWith("json") === true
        ? normalizeImportedOpenApi(text)
        : text,
    contentType: mediaType(contentType) ?? "application/octet-stream",
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

  const permit = await runtime.acquirePermit(session);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(GENERIC_FETCH_ERROR)),
    FETCH_TIMEOUT_MS,
  );
  try {
    return await fetchAuthorizedSpec(
      data,
      runtime,
      controller.signal,
      permit.renew,
    );
  } finally {
    clearTimeout(timeout);
    if (!controller.signal.aborted) controller.abort();
    try {
      await permit.release();
    } catch {
      // Expiring server-side lease is recovery; never mask fetch result/error.
    }
  }
}

/** Authenticated server boundary used by the RPC handler and boundary tests. */
export async function fetchSpecFromUrlServerBoundary(
  input: unknown,
): Promise<{ text: string; contentType: string | null }> {
  const parsedInput = parseImportSpecUrl(input);
  if (!parsedInput.ok) throw new Error(parsedInput.error);

  await authorizeSpecImport();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let current = new URL(parsedInput.data.url);
    let response: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertSafeUrlBoundary(current, controller.signal);
      let candidate: Response;
      try {
        candidate = await fetch(current, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Accept: "application/json, application/yaml, text/yaml, text/plain",
          },
        });
      } catch {
        throw new Error(GENERIC_FETCH_ERROR);
      }

      if (candidate.status >= 300 && candidate.status < 400) {
        const location = candidate.headers.get("location");
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

    if (response === null || !response.ok) throw new Error(GENERIC_FETCH_ERROR);
    const contentType = response.headers.get("content-type");
    if (!isAllowedSpecMimeType(contentType)) throw new Error(MIME_ERROR);

    const rawLength = response.headers.get("content-length");
    if (rawLength !== null) {
      const length = Number(rawLength);
      if (Number.isFinite(length) && length > MAX_SPEC_IMPORT_BYTES) {
        throw new Error(SIZE_ERROR);
      }
    }

    const text = await streamBodyUpTo(
      response,
      MAX_SPEC_IMPORT_BYTES,
      controller.signal,
    );
    if (text.trim() === "") throw new Error(EMPTY_ERROR);
    return { text, contentType };
  } finally {
    clearTimeout(timeout);
  }
}
