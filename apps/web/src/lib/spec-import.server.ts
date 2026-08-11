import { auth } from "@clerk/tanstack-react-start/server";
import { resolve4, resolve6 } from "node:dns/promises";
import { MAX_SPEC_IMPORT_BYTES, type ImportSpecUrlInput } from "./spec-import";

/**
 * Hard limit on the total wall-clock time for a spec fetch (DNS resolution,
 * request, redirects, and body streaming). Aborts via AbortController.
 */
const FETCH_TIMEOUT_MS = 10_000;

/** Maximum redirect hops followed (each re-validated against the SSRF guard). */
const MAX_REDIRECTS = 5;

/**
 * Generic message for every failure that could reveal upstream topology
 * (network errors, non-2xx/3xx responses, DNS resolution failures, private-IP
 * blocks, redirect exhaustion). Upstream status codes MUST NOT be surfaced.
 */
const GENERIC_FETCH_ERROR = "Failed to fetch spec";
const SIZE_ERROR = "Spec is larger than 2MB";
const EMPTY_ERROR = "URL returned empty body";
const SESSION_ERROR = "Could not verify your session. Refresh and try again.";
const SIGN_IN_ERROR = "Sign in before importing a spec";
const ACTIVE_ORG_ERROR = "Select an organization before importing a spec";

// ---------------------------------------------------------------------------
// SSRF guards
// ---------------------------------------------------------------------------

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  return nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    ? null
    : nums;
}

function ipv4Number(ip: string): number | null {
  const parts = parseIPv4(ip);
  if (!parts) return null;
  return (
    (((parts[0] << 24) >>> 0) |
      (parts[1] << 16) |
      (parts[2] << 8) |
      parts[3]) >>>
    0
  );
}

function isInIPv4Cidr(ip: number, base: string, prefix: number): boolean {
  const baseNumber = ipv4Number(base);
  if (baseNumber === null) return true;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) >>> 0 === (baseNumber & mask) >>> 0;
}

/**
 * Reject every special-use IPv4 range. Cloudflare's
 * `global_fetch_strictly_public` flag is the runtime backstop; this preflight
 * also fails before a request is created and covers Node-based tests/tools.
 */
function isNonPublicIPv4(ip: string): boolean {
  const value = ipv4Number(ip);
  if (value === null) return true;
  const nonPublicCidrs = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const;
  return nonPublicCidrs.some(([base, prefix]) =>
    isInIPv4Cidr(value, base, prefix),
  );
}

function ipv4ToTwoGroups(ip: string): [number, number] | null {
  const parts = parseIPv4(ip);
  if (!parts) return null;
  return [(parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3]];
}

/**
 * Expand an IPv6 textual form (incl. `::` compression and IPv4-mapped suffixes
 * like `::ffff:1.2.3.4`) into 8 16-bit groups, or `null` if unparseable.
 */
function expandIPv6(ip: string): number[] | null {
  // Replace a trailing embedded IPv4 with two hex groups.
  const colon = ip.lastIndexOf(":");
  if (colon !== -1 && ip.slice(colon + 1).includes(".")) {
    const v4 = ipv4ToTwoGroups(ip.slice(colon + 1));
    if (!v4) return null;
    ip = `${ip.slice(0, colon + 1)}${v4[0].toString(16)}:${v4[1].toString(16)}`;
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

  const out: number[] = [];
  for (const g of groups) {
    const n = Number.parseInt(g, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    out.push(n);
  }
  return out;
}

/**
 * Private / internal IPv6 ranges that MUST NOT be reachable:
 *   ::1            loopback
 *   fc00::/7       unique-local (fc00::–fdff::)
 *   fe80::/10      link-local
 *   ::ffff:0:0/96  IPv4-mapped — defer to the IPv4 blocklist
 */
function isNonPublicIPv6(ip: string): boolean {
  const groups = expandIPv6(ip);
  // Fail closed: if we cannot parse the address, treat it as blocked.
  if (!groups) return true;
  const g0 = groups[0];

  if (groups.every((g) => g === 0)) return true; // :: unspecified
  if (groups.every((g, i) => (i === 7 ? g === 1 : g === 0))) return true; // ::1
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && groups[1] === 0x0db8) return true; // docs only

  // IPv4-compatible and IPv4-mapped forms — apply the IPv4 blocklist.
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    (groups[5] === 0 || groups[5] === 0xffff)
  ) {
    const ipv4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${
      groups[7] & 0xff
    }`;
    if (isNonPublicIPv4(ipv4)) return true;
  }
  return false;
}

function isIPv4Literal(s: string): boolean {
  return parseIPv4(s) !== null;
}

type ResolvedAddress = { address: string; family: number };

type SpecImportSession = {
  isAuthenticated: boolean;
  userId: string | null | undefined;
  orgId: string | null | undefined;
};

export type SpecImportRuntime = {
  authenticate: () => Promise<SpecImportSession>;
  resolveHostname: (hostname: string) => Promise<ResolvedAddress[]>;
  fetch: (url: URL, init: RequestInit) => Promise<Response>;
};

const productionRuntime: SpecImportRuntime = {
  authenticate: async () => {
    const session = await auth();
    return {
      isAuthenticated: session.isAuthenticated,
      userId: session.userId,
      orgId: session.orgId,
    };
  },
  resolveHostname: async (hostname) => {
    // Cloudflare Workers implements DNS-over-HTTPS resolve4/resolve6. Node's
    // lookup() exists as a compatibility stub but throws at runtime.
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
    // Best effort. The request signal still bounds underlying work.
  }
}

/**
 * Validate every initial URL and redirect target before fetch. DNS rejection
 * catches mixed public/private answers. The Worker compatibility flag
 * `global_fetch_strictly_public` closes the DNS-to-connect rebinding window by
 * forcing global fetch through the public Internet path.
 */
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

  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  if (isIPv4Literal(hostname)) {
    if (isNonPublicIPv4(hostname)) throw new Error(GENERIC_FETCH_ERROR);
    return;
  }
  if (hostname.includes(":")) {
    if (isNonPublicIPv6(hostname)) throw new Error(GENERIC_FETCH_ERROR);
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
  if (resolved.length === 0) throw new Error(GENERIC_FETCH_ERROR);
  for (const address of resolved) {
    if (
      (address.family === 4 && isNonPublicIPv4(address.address)) ||
      (address.family === 6 && isNonPublicIPv6(address.address)) ||
      (address.family !== 4 && address.family !== 6)
    ) {
      throw new Error(GENERIC_FETCH_ERROR);
    }
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
      // Best effort. The request signal still bounds underlying work.
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
  return new TextDecoder("utf-8").decode(body);
}

async function fetchAuthorizedSpec(
  data: ImportSpecUrlInput,
  runtime: SpecImportRuntime,
  signal: AbortSignal,
): Promise<{ text: string; contentType: string | null }> {
  let current = new URL(data.url);
  let response: Response | null = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
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
              "application/json, application/yaml, text/yaml, text/plain, */*",
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

  if (!response) throw new Error(GENERIC_FETCH_ERROR);
  if (!response.ok) {
    await cancelResponseBody(response, signal);
    throw new Error(GENERIC_FETCH_ERROR);
  }

  const contentType = response.headers.get("content-type");
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > MAX_SPEC_IMPORT_BYTES) {
      await cancelResponseBody(response, signal);
      throw new Error(SIZE_ERROR);
    }
  }

  const text = await streamBodyUpTo(response, MAX_SPEC_IMPORT_BYTES, signal);
  if (text.trim() === "") throw new Error(EMPTY_ERROR);
  return { text, contentType };
}

/**
 * Authenticated request boundary and test seam. Authentication completes before
 * URL parsing, DNS resolution, or fetch, so rejected callers cause zero network
 * activity. One AbortController bounds DNS, redirects, fetch, and body reads.
 */
export async function fetchSpecFromUrlForRequest(
  data: ImportSpecUrlInput,
  runtime: SpecImportRuntime = productionRuntime,
): Promise<{ text: string; contentType: string | null }> {
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
  }
}
