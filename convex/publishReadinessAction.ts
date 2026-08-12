"use node";

import { isPrivilegedOrgRole } from "@zevium/shared";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { probePublicHttps } from "./qualityProbeAction";

export type ConnectionResult = {
  status:
    | "ready"
    | "reachable_unhealthy"
    | "blocked_target"
    | "timeout"
    | "unreachable"
    | "missing_health_check";
  statusCode?: number;
  latencyMs?: number;
  message: string;
};

/**
 * Publication reachability gate. It never sends publisher credentials and
 * never enters gateway metering/earnings paths. Any real HTTP response proves
 * reachability; only 2xx/3xx is a successful quality sample.
 */
export const testConnection = action({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<ConnectionResult> => {
    const identity = await ctx.auth.getUserIdentity();
    const raw = identity as Record<string, unknown> | null;
    const clerkOrgId = typeof raw?.org_id === "string" ? raw.org_id : undefined;
    if (!clerkOrgId)
      throw new Error("Choose an organization before testing a connection");
    if (!isPrivilegedOrgRole(typeof raw?.org_role === "string" ? raw.org_role : undefined)) {
      throw new Error(
        "Only organization admins can test upstream reachability",
      );

    }
    const target = await ctx.runQuery(internal.publishReadiness.getTarget, {
      projectId: args.projectId,
      clerkOrgId,
    });
    if (
      target.url === null ||
      target.method === null ||
      target.draftHash === null
    ) {
      if (target.draftHash !== null) {
        await ctx.runMutation(internal.publishReadiness.clearPassingTest, {
          projectId: args.projectId,
          draftHash: target.draftHash,
        });
      }
      return {
        status: "missing_health_check",
        message:
          "Mark one parameter-free GET or HEAD operation with x-zevium-health-check: true, then save the spec.",
      };
    }
    const result = await probePublicHttps(target.url, target.method);
    const reachable = result.statusCode !== undefined;
    const gatePassed = result.outcome === "healthy";
    if (gatePassed) {
      await ctx.runMutation(internal.publishReadiness.recordPassingTest, {
        projectId: args.projectId,
        draftHash: target.draftHash,
        healthCheckUrl: target.url,
        healthCheckMethod: target.method,
      });
    } else {
      await ctx.runMutation(internal.publishReadiness.clearPassingTest, {
        projectId: args.projectId,
        draftHash: target.draftHash,
      });
    }
    return {
      status: reachable
        ? result.outcome === "healthy"
          ? "ready"
          : "reachable_unhealthy"
        : result.outcome === "blocked_target"
          ? "blocked_target"
          : result.outcome === "timeout"
            ? "timeout"
            : "unreachable",
      statusCode: result.statusCode,
      latencyMs: result.latencyMs,
      message: reachable
        ? `${result.message} ${gatePassed ? "Reachability and declared-health readiness gate passed." : "Publication gate failed; make the declared health endpoint return 2xx/3xx and test again."}`
        : result.message,
    };
  },
});
