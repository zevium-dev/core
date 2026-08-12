"use node";

import { isIP } from "node:net";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { isPublicIp } from "./lib/webhookDelivery";
import {
  probePinnedHttps,
  ReadinessTransportError,
} from "./lib/readinessTransport";

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

/** Compatibility exports now delegate to canonical special-use IP parser. */
export function isPrivateIpv4(address: string): boolean {
  return isIP(address) !== 4 || !isPublicIp(address);
}

export function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  return isIP(normalized) !== 6 || !isPublicIp(normalized);
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
 * Test saved upstream directly. Transport resolves once per hop, validates all
 * answers, pins chosen IP into fresh TLS socket, and rejects credential leaks.
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
    let initialUrl: URL;
    try {
      initialUrl = new URL(target.url);
    } catch {
      return {
        status: "missing_server",
        message:
          "Add a valid HTTPS server URL to the saved draft before testing.",
      };
    }

    const started = Date.now();
    try {
      const result = await probePinnedHttps(initialUrl, target.headers);
      const latencyMs = Date.now() - started;
      if (
        result.statusCode >= 200 &&
        result.statusCode < 300 &&
        target.draftHash
      ) {
        await ctx.runMutation(internal.publishReadiness.recordPassingTest, {
          projectId: args.projectId,
          draftHash: target.draftHash,
          serverOrigin: result.finalUrl.origin,
          credentialRevision: target.credentialRevision,
        });
      }
      return {
        status: classifyConnectionStatus(result.statusCode),
        statusCode: result.statusCode,
        latencyMs,
        message: safeResponseMessage(
          result.statusCode,
          Object.keys(target.headers).length > 0,
        ),
      };
    } catch (error) {
      const transportError =
        error instanceof ReadinessTransportError ? error : null;
      return {
        status: transportError?.kind ?? "unreachable",
        latencyMs: Date.now() - started,
        message:
          transportError?.message ??
          "Could not reach the upstream server. Check its URL, TLS certificate, and availability, then try again.",
      };
    }
  },
});
