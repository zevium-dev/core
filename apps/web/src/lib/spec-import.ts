import { createServerFn } from "@tanstack/react-start";
import { lookup } from "node:dns/promises";
import { z } from "zod";

export const MAX_SPEC_IMPORT_BYTES = 2 * 1024 * 1024;

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
const SCHEME_ERROR = "URL must be https";

export const importSpecUrlSchema = z.object({
  url: z
    .string()
    .trim()
    .url("Enter a valid URL")
    .refine(
      (value) => {
        try {
          const u = new URL(value);
          return u.protocol === "http:" || u.protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "URL must be http(s)" },
    ),
});

export type ImportSpecUrlInput = z.infer<typeof importSpecUrlSchema>;

export function parseImportSpecUrl(
  input: unknown,
): { ok: true; data: ImportSpecUrlInput } | { ok: false; error: string } {
  const parsed = importSpecUrlSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid URL",
    };
  }
  return { ok: true, data: parsed.data };
}

// ---------------------------------------------------------------------------
// SSRF guards
// ---------------------------------------------------------------------------

/**
 * Private / internal IPv4 ranges that MUST NOT be reachable from the fetch:
 *   0.0.0.0/8      unspecified (also a common SSRF bypass for "localhost")
 *   10.0.0.0/8     RFC1918
 *   127.0.0.0/8    loopback
 *   169.254.0.0/16 link-local (incl. cloud metadata services: 169.254.169.254)
 *   172.16.0.0/12  RFC1918
 *   192.168.0.0/16 RFC1918
 *   100.64.0.0/10  CGNAT (RFC6598) — commonly reachable from cloud networks
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function ipv4ToTwoGroups(ip: string): [number, number] | null {
  const parts = ip.split(".").map((p) => Number(p));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return null;
  }
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
function isPrivateIPv6(ip: string): boolean {
  const groups = expandIPv6(ip);
  // Fail closed: if we cannot parse the address, treat it as blocked.
  if (!groups) return true;
  const g0 = groups[0];

  if (groups.every((g, i) => (i === 7 ? g === 1 : g === 0))) return true; // ::1
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10

  // IPv4-mapped (::ffff:a.b.c.d) — apply the IPv4 blocklist.
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const ipv4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${
      groups[7] & 0xff
    }`;
    if (isPrivateIPv4(ipv4)) return true;
  }
  return false;
}

function isIPv4Literal(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d+$/.test(p) && Number(p) <= 255);
}

/**
 * Validate a URL before fetching it:
 *   - Scheme allowlist: `https:` only (allow `http:` when NODE_ENV=development).
 *   - DNS rebinding guard: resolve the hostname and reject if ANY resolved
 *     address falls in a private/internal range. IP-literal hostnames are
 *     checked directly without a DNS round-trip.
 *
 * This narrows (does not eliminate) the TOCTOU window between resolution and
 * the subsequent fetch; in the Workers runtime the fetch cannot be pinned to
 * a specific resolved IP, so we resolve immediately before each hop.
 */
async function assertSafeUrl(url: URL): Promise<void> {
  if (url.protocol === "http:") {
    if (process.env.NODE_ENV !== "development") throw new Error(SCHEME_ERROR);
  } else if (url.protocol !== "https:") {
    throw new Error(GENERIC_FETCH_ERROR);
  }

  const hostname = url.hostname;

  // IP-literal hostname: validate without DNS.
  if (isIPv4Literal(hostname)) {
    if (isPrivateIPv4(hostname)) throw new Error(GENERIC_FETCH_ERROR);
    return;
  }
  if (hostname.includes(":")) {
    if (isPrivateIPv6(hostname)) throw new Error(GENERIC_FETCH_ERROR);
    return;
  }

  // Hostname: resolve and reject if any resolved address is private/internal.
  // Rejecting on ANY private record prevents DNS rebinding via mixed records.
  let resolved: { address: string; family: number }[];
  try {
    resolved = await lookup(hostname, { all: true });
  } catch {
    throw new Error(GENERIC_FETCH_ERROR);
  }
  if (resolved.length === 0) throw new Error(GENERIC_FETCH_ERROR);
  for (const r of resolved) {
    const fam: 4 | 6 = r.family === 6 ? 6 : 4;
    if (fam === 4 ? isPrivateIPv4(r.address) : isPrivateIPv6(r.address)) {
      throw new Error(GENERIC_FETCH_ERROR);
    }
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
    let result;
    try {
      result = await reader.read();
    } catch {
      throw new Error(GENERIC_FETCH_ERROR);
    }
    if (result.done) break;
    const value = result.value;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignore — we are already throwing
      }
      throw new Error(SIZE_ERROR);
    }
    chunks.push(value);
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(buf);
}

/**
 * Fetch OpenAPI text server-side (avoids CORS). Size hard-cap 2MB.
 *
 * SSRF hardening: see `assertSafeUrl`. Redirects are followed manually (max
 * `MAX_REDIRECTS` hops) with each hop re-validated, so a redirect cannot be
 * used to escape the IP blocklist. All upstream/transport failures map to a
 * generic error; HTTP status codes are never surfaced to the caller.
 */
export const fetchSpecFromUrl = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const parsed = parseImportSpecUrl(input);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    return parsed.data;
  })
  .handler(
    async ({ data }): Promise<{ text: string; contentType: string | null }> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        let current = new URL(data.url);
        let response: Response | null = null;

        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          await assertSafeUrl(current);

          let res: Response;
          try {
            res = await fetch(current, {
              method: "GET",
              redirect: "manual",
              signal: controller.signal,
              headers: {
                Accept:
                  "application/json, application/yaml, text/yaml, text/plain, */*",
              },
            });
          } catch {
            throw new Error(GENERIC_FETCH_ERROR);
          }

          if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get("location");
            if (!location) throw new Error(GENERIC_FETCH_ERROR);
            let next: URL;
            try {
              next = new URL(location, current);
            } catch {
              throw new Error(GENERIC_FETCH_ERROR);
            }
            current = next;
            continue;
          }

          response = res;
          break;
        }

        if (!response) throw new Error(GENERIC_FETCH_ERROR); // too many redirects
        if (!response.ok) throw new Error(GENERIC_FETCH_ERROR);

        const contentType = response.headers.get("content-type");

        // Fast-path reject when the server advertises an over-limit length.
        const lengthHeader = response.headers.get("content-length");
        if (lengthHeader !== null) {
          const n = Number(lengthHeader);
          if (Number.isFinite(n) && n > MAX_SPEC_IMPORT_BYTES) {
            throw new Error(SIZE_ERROR);
          }
        }

        const text = await streamBodyUpTo(response, MAX_SPEC_IMPORT_BYTES);
        if (text.trim() === "") throw new Error(EMPTY_ERROR);

        return { text, contentType };
      } finally {
        clearTimeout(timeout);
      }
    },
  );
