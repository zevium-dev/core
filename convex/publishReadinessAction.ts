"use node";

import { lookup } from "node:dns/promises";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export type ConnectionResult = {
  status:
    | "ok"
    | "auth_rejected"
    | "reachable_unconfirmed"
    | "blocked_target"
    | "timeout"
    | "unreachable"
    | "missing_server";
  statusCode?: number;
  latencyMs?: number;
  message: string;
};

export function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

export function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = normalized.match(/^::ffff:(.+)$/);
  if (mapped) {
    const tail = mapped[1]!;
    if (tail.includes(".")) return isPrivateIpv4(tail);
    const value = Number.parseInt(tail.replace(/:/g, ""), 16);
    if (Number.isFinite(value) && value >= 0 && value <= 0xffffffff) {
      return isPrivateIpv4(
        `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`,
      );
    }
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("ff") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.")
  );
}

async function assertSafeUpstreamUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:") {
    throw new Error("Only HTTPS upstream URLs can be tested");
  }
  if (url.username || url.password) {
    throw new Error("Upstream URLs cannot include credentials");
  }
  const hostname = url.hostname;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    if (isPrivateIpv4(hostname)) {
      throw new Error("Private or internal upstream URLs cannot be tested");
    }
    return;
  }
  if (hostname.includes(":")) {
    if (isBlockedIpv6(hostname)) {
      throw new Error("Private or internal upstream URLs cannot be tested");
    }
    return;
  }
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error("Could not resolve the upstream hostname");
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) =>
      family === 4 ? isPrivateIpv4(address) : isBlockedIpv6(address),
    )
  ) {
    throw new Error("Private or internal upstream URLs cannot be tested");
  }
}

export function safeResponseMessage(
  statusCode: number,
  hasCredentials: boolean,
): string {
  if (statusCode >= 200 && statusCode < 400) {
    return hasCredentials
      ? "Server and configured credentials responded successfully."
      : "Server responded successfully.";
  }
  if (statusCode === 401 || statusCode === 403) {
    return hasCredentials
      ? "Server is reachable, but rejected the configured credentials. Replace the credential and try again."
      : "Server is reachable but requires credentials. Add the publisher credential in Settings, then test again.";
  }
  if (statusCode >= 500) {
    return `Server is reachable but returned HTTP ${statusCode}. Check the upstream service before publishing.`;
  }
  return `Server is reachable (HTTP ${statusCode}). Confirm an API operation succeeds before publishing.`;
}

export function classifyConnectionStatus(
  statusCode: number,
): ConnectionResult["status"] {
  if (statusCode >= 200 && statusCode < 300) return "ok";
  if (statusCode === 401 || statusCode === 403) return "auth_rejected";
  return "reachable_unconfirmed";
}

/**
 * Tests the saved draft server directly. It deliberately bypasses the gateway,
 * so it neither creates a usage event nor reserves consumer credits.
 */
export const testConnection = action({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<ConnectionResult> => {
    const identity = await ctx.auth.getUserIdentity();
    const clerkOrgId =
      identity &&
      typeof (identity as Record<string, unknown>).org_id === "string"
        ? (identity as Record<string, string>).org_id
        : undefined;
    if (!clerkOrgId) {
      throw new Error("Choose an organization before testing a connection");
    }
    if ((identity as Record<string, unknown>).org_role !== "org:admin") {
      throw new Error("Only organization admins can test upstream credentials");
    }
    const target = await ctx.runQuery(internal.publishReadiness.getTarget, {
      projectId: args.projectId,
      clerkOrgId,
    });
    if (target.url === null) {
      return {
        status: "missing_server",
        message:
          "Add a valid servers[0].url to the saved draft before testing.",
      };
    }
    let current: URL;
    try {
      current = new URL(target.url);
    } catch {
      return {
        status: "missing_server",
        message:
          "Add a valid HTTPS server URL to the saved draft before testing.",
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
    const started = Date.now();
    try {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        try {
          await assertSafeUpstreamUrl(current);
        } catch (error) {
          return {
            status:
              error instanceof Error &&
              error.message === "Could not resolve the upstream hostname"
                ? "unreachable"
                : "blocked_target",
            message:
              error instanceof Error
                ? error.message
                : "This upstream URL cannot be tested",
          };
        }
        let response: Response;
        try {
          response = await fetch(current, {
            method: "HEAD",
            headers: target.headers,
            redirect: "manual",
            signal: controller.signal,
          });
        } catch {
          return {
            status: controller.signal.aborted ? "timeout" : "unreachable",
            latencyMs: Date.now() - started,
            message:
              "Could not reach the upstream server. Check its URL, TLS certificate, and availability, then try again.",
          };
        }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) {
            return {
              status: "unreachable",
              latencyMs: Date.now() - started,
              message:
                "Upstream redirected without a destination. Use its final HTTPS URL in the spec.",
            };
          }
          try {
            current = new URL(location, current);
          } catch {
            return {
              status: "unreachable",
              latencyMs: Date.now() - started,
              message:
                "Upstream returned an invalid redirect. Use its final HTTPS URL in the spec.",
            };
          }
          continue;
        }
        const latencyMs = Date.now() - started;
        if (
          response.status >= 200 &&
          response.status < 300 &&
          target.draftHash
        ) {
          await ctx.runMutation(internal.publishReadiness.recordPassingTest, {
            projectId: args.projectId,
            draftHash: target.draftHash,
            serverOrigin: current.origin,
            credentialRevision: target.credentialRevision,
          });
        }
        return {
          status: classifyConnectionStatus(response.status),
          statusCode: response.status,
          latencyMs,
          message: safeResponseMessage(
            response.status,
            Object.keys(target.headers).length > 0,
          ),
        };
      }
      return {
        status: "unreachable",
        latencyMs: Date.now() - started,
        message:
          "Upstream redirected too many times. Use its final HTTPS URL in the spec.",
      };
    } finally {
      clearTimeout(timeout);
    }
  },
});
