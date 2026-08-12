"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { probePublicHttps } from "./qualityProbeAction";

export type ConnectionResult = {
  status:
    | "ok"
    | "reachable_unconfirmed"
    | "blocked_target"
    | "timeout"
    | "unreachable"
    | "missing_server";
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
    if (raw?.org_role !== "org:admin") {
      throw new Error(
        "Only organization admins can test upstream reachability",
      );
    }
    const target = await ctx.runQuery(internal.publishReadiness.getTarget, {
      projectId: args.projectId,
      clerkOrgId,
    });
    if (target.url === null || target.draftHash === null) {
      if (target.draftHash !== null) {
        await ctx.runMutation(internal.publishReadiness.clearPassingTest, {
          projectId: args.projectId,
          draftHash: target.draftHash,
        });
      }
      return {
        status: "missing_server",
        message: "Save a valid spec with servers[0].url before testing.",
      };
    }
    const result = await probePublicHttps(target.url);
    const reachable = result.statusCode !== undefined;
    // Credential gates and unsupported HEAD requests commonly return 4xx and
    // still prove reachability. 5xx is unhealthy and must invalidate a prior
    // pass for same draft.
    const gatePassed = reachable && result.statusCode! < 500;
    if (gatePassed) {
      await ctx.runMutation(internal.publishReadiness.recordPassingTest, {
        projectId: args.projectId,
        draftHash: target.draftHash,
        serverOrigin: result.finalOrigin ?? new URL(target.url).origin,
      });
    } else {
      await ctx.runMutation(internal.publishReadiness.clearPassingTest, {
        projectId: args.projectId,
        draftHash: target.draftHash,
      });
    }
    return {
      status: reachable
        ? result.outcome === "success"
          ? "ok"
          : "reachable_unconfirmed"
        : result.outcome === "blocked_target"
          ? "blocked_target"
          : result.outcome === "timeout"
            ? "timeout"
            : "unreachable",
      statusCode: result.statusCode,
      latencyMs: result.latencyMs,
      message: reachable
        ? `${result.message} ${gatePassed ? "Reachability gate passed; scheduled quality checks will report HTTP success separately." : "Publication gate failed; restore upstream service and test again."}`
        : result.message,
    };
  },
});
