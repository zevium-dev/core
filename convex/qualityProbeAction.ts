"use node";

import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import type { LookupAddress } from "node:dns";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { QualityProbeOutcome } from "@zevium/shared";

export const PROBE_TIMEOUT_MS = 8_000;
export const MAX_PROBE_REDIRECTS = 2;
const MAX_URL_LENGTH = 2_048;

export type Resolver = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

export type PinnedHeadRequester = (
  url: URL,
  pinned: LookupAddress,
  signal: AbortSignal,
) => Promise<{ statusCode: number; location?: string }>;

export type ProbeDependencies = {
  resolver?: Resolver;
  requestHead?: PinnedHeadRequester;
  timeoutMs?: number;
};

export type PinnedLookupResult =
  | { all: true; addresses: LookupAddress[] }
  | { all: false; address: string; family: number };

/** Node 20+ may request all addresses even from a custom lookup callback. */
export function pinnedLookupResult(
  pinned: LookupAddress,
  all: boolean,
): PinnedLookupResult {
  return all
    ? { all: true, addresses: [pinned] }
    : { all: false, address: pinned.address, family: pinned.family };
}

export type SafeProbeResult = {
  outcome: QualityProbeOutcome;
  statusCode?: number;
  latencyMs?: number;
  finalOrigin?: string;
  message: string;
};

function ipv4Number(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const raw of parts) {
    if (!/^\d{1,3}$/.test(raw)) return null;
    const part = Number(raw);
    if (part > 255) return null;
    value = value * 256 + part;
  }
  return value >>> 0;
}

function inIpv4Cidr(value: number, base: string, bits: number): boolean {
  const baseValue = ipv4Number(base);
  if (baseValue === null) return true;
  const blockSize = 2 ** (32 - bits);
  return Math.floor(value / blockSize) === Math.floor(baseValue / blockSize);
}

/** Fail closed: only globally routable unicast addresses may be contacted. */
export function isPublicIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return false;
  const blocked: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return !blocked.some(([base, bits]) => inIpv4Cidr(value, base, bits));
}

function expandIpv6(address: string): number[] | null {
  let input = address.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = input.indexOf("%");
  if (zone >= 0) input = input.slice(0, zone);
  const ipv4Tail = input.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Tail) {
    const value = ipv4Number(ipv4Tail[2]!);
    if (value === null) return null;
    input = `${ipv4Tail[1]}${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const sides = input.split("::");
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(":") : [];
  const right = sides.length === 2 && sides[1] ? sides[1].split(":") : [];
  if (sides.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < (sides.length === 2 ? 1 : 0)) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right].map((part) =>
    /^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : -1,
  );
  return groups.length === 8 && groups.every((group) => group >= 0)
    ? groups
    : null;
}

export function isPublicIpv6(address: string): boolean {
  const groups = expandIpv6(address);
  if (groups === null) return false;
  // Restrict to global unicast, then reject special-purpose ranges inside it.
  if ((groups[0]! & 0xe000) !== 0x2000) return false;
  // IETF protocol assignments, benchmarking, ORCHID, and Teredo space.
  if (groups[0] === 0x2001 && groups[1]! <= 0x01ff) return false;
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false;
  // Deprecated 6to4 and current documentation prefix.
  if (groups[0] === 0x2002) return false;
  if (groups[0] === 0x3fff && (groups[1]! & 0xf000) === 0) return false;
  return true;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? isPublicIpv4(address)
    : family === 6
      ? isPublicIpv6(address)
      : false;
}

export async function resolveSafeHttpsUrl(
  raw: string,
  resolver: Resolver = lookup,
): Promise<{ url: URL; addresses: LookupAddress[] }> {
  if (raw.length > MAX_URL_LENGTH) throw new Error("Upstream URL is too long");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Add a valid HTTPS URL in servers[0].url");
  }
  if (url.protocol !== "https:") throw new Error("Upstream must use HTTPS");
  if (url.username || url.password) {
    throw new Error("Upstream URL must not contain credentials");
  }
  if (url.port !== "" && url.port !== "443") {
    throw new Error("Upstream probe only permits HTTPS port 443");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const canonicalHostname = hostname.toLowerCase().replace(/\.+$/, "");
  if (
    canonicalHostname === "" ||
    canonicalHostname === "localhost" ||
    canonicalHostname.endsWith(".localhost") ||
    canonicalHostname.endsWith(".local")
  ) {
    throw new Error("Private or internal upstream targets are blocked");
  }
  if (isIP(hostname) !== 0) {
    if (!isPublicAddress(hostname)) {
      throw new Error("Private or non-public upstream targets are blocked");
    }
    return {
      url,
      addresses: [{ address: hostname, family: isIP(hostname) as 4 | 6 }],
    };
  }
  let addresses: LookupAddress[];
  try {
    addresses = await resolver(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("Upstream hostname could not be resolved");
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new Error("Private, mixed, or non-public DNS targets are blocked");
  }
  return { url, addresses };
}

function requestPinnedHead(
  url: URL,
  pinned: LookupAddress,
  signal: AbortSignal,
): Promise<{ statusCode: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "HEAD",
        headers: {
          accept: "*/*",
          "user-agent": "Zevium-Quality-Probe/1.0",
        },
        signal,
        servername:
          isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0
            ? url.hostname
            : undefined,
        lookup: (_hostname, options, callback) => {
          const result = pinnedLookupResult(pinned, options.all === true);
          if (result.all) {
            callback(null, result.addresses);
          } else {
            callback(null, result.address, result.family);
          }
        },
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        const location = response.headers.location;
        response.resume();
        resolve(
          location === undefined ? { statusCode } : { statusCode, location },
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Probe timed out", "AbortError"));
    };
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function probePublicHttps(
  raw: string,
  dependencies: ProbeDependencies = {},
): Promise<SafeProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timeoutMs = dependencies.timeoutMs ?? PROBE_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const resolver = dependencies.resolver ?? lookup;
  const requestHead = dependencies.requestHead ?? requestPinnedHead;
  let current = raw;
  try {
    for (let redirects = 0; redirects <= MAX_PROBE_REDIRECTS; redirects += 1) {
      let safe;
      try {
        safe = await raceWithAbort(
          resolveSafeHttpsUrl(current, resolver),
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) {
          return {
            outcome: "timeout",
            latencyMs: Date.now() - started,
            message: `Upstream DNS resolution did not finish within ${Math.ceil(timeoutMs / 1_000)} seconds.`,
          };
        }
        const message =
          error instanceof Error ? error.message : "Upstream target is blocked";
        return {
          outcome: message.includes("resolved")
            ? "dns_error"
            : "blocked_target",
          message,
        };
      }
      try {
        // Socket DNS is pinned to a vetted address. No rebinding lookup occurs.
        const response = await requestHead(
          safe.url,
          safe.addresses[0]!,
          controller.signal,
        );
        if (
          !Number.isInteger(response.statusCode) ||
          response.statusCode < 100 ||
          response.statusCode >= 600
        ) {
          return {
            outcome: "network_error",
            latencyMs: Date.now() - started,
            message: "Upstream returned an invalid HTTP response.",
          };
        }
        if (response.statusCode >= 300 && response.statusCode < 400) {
          if (!response.location) {
            return {
              outcome: "network_error",
              message: "Upstream redirect has no destination",
            };
          }
          if (redirects === MAX_PROBE_REDIRECTS) {
            return {
              outcome: "network_error",
              message: "Upstream redirected too many times",
            };
          }
          current = new URL(response.location, safe.url).toString();
          continue;
        }
        const latencyMs = Date.now() - started;
        const success = response.statusCode >= 200 && response.statusCode < 400;
        return {
          outcome: success ? "success" : "http_error",
          statusCode: response.statusCode,
          latencyMs,
          finalOrigin: safe.url.origin,
          message: success
            ? "Upstream responded successfully without credentials."
            : `Upstream is reachable without credentials but returned HTTP ${response.statusCode}.`,
        };
      } catch (error) {
        const code =
          error instanceof Error && "code" in error ? String(error.code) : "";
        if (controller.signal.aborted) {
          return {
            outcome: "timeout",
            latencyMs: Date.now() - started,
            message: `Upstream did not respond within ${Math.ceil(timeoutMs / 1_000)} seconds.`,
          };
        }
        const tls =
          code.startsWith("ERR_TLS") ||
          code.startsWith("ERR_SSL") ||
          code.includes("CERT") ||
          code.includes("SELF_SIGNED") ||
          code.includes("UNABLE_TO_VERIFY");
        return {
          outcome: tls ? "tls_error" : "network_error",
          latencyMs: Date.now() - started,
          message: tls
            ? "Upstream TLS handshake failed. Check certificate and hostname."
            : "Upstream connection failed. Check DNS, TLS, and availability.",
        };
      }
    }
    return {
      outcome: "network_error",
      message: "Upstream redirected too many times",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const runScheduledProbe = internalAction({
  args: {
    targetId: v.id("qualityProbeTargets"),
    executionId: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const target = await ctx.runQuery(internal.quality.getLeasedTarget, args);
    if (target === null) return;
    const result = await probePublicHttps(target.url);
    await ctx.runMutation(internal.quality.recordProbeResult, {
      targetId: args.targetId,
      executionId: args.executionId,
      outcome: result.outcome,
      statusCode: result.statusCode,
      latencyMs: result.latencyMs,
    });
  },
});
