import { auth } from "@clerk/tanstack-react-start/server";
import { getRequest } from "@tanstack/react-start/server";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { resolve4, resolve6 } from "node:dns/promises";
import { MAX_SPEC_IMPORT_BYTES, parseImportSpecUrl } from "./spec-import";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const GENERIC_FETCH_ERROR = "Failed to fetch spec";
const SIZE_ERROR = "Spec is larger than 2MB";
const EMPTY_ERROR = "URL returned empty body";
const SCHEME_ERROR = "URL must be https";
const MIME_ERROR = "URL must return JSON or YAML";
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

async function assertSafeUrl(url: URL, signal: AbortSignal): Promise<void> {
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
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(EMPTY_ERROR);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch {
      throw new Error(GENERIC_FETCH_ERROR);
    }
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(SIZE_ERROR);
    }
    chunks.push(result.value);
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(buffer);
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
      await assertSafeUrl(current, controller.signal);
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

    const text = await streamBodyUpTo(response, MAX_SPEC_IMPORT_BYTES);
    if (text.trim() === "") throw new Error(EMPTY_ERROR);
    return { text, contentType };
  } finally {
    clearTimeout(timeout);
  }
}
