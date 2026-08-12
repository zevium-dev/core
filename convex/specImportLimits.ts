import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { requireIdentity } from "./lib/auth";

export const SPEC_IMPORT_MAX_CONCURRENCY = 2;
export const SPEC_IMPORT_RATE_WINDOW_MS = 60_000;
export const SPEC_IMPORT_RATE_LIMIT = 10;
export const SPEC_IMPORT_LEASE_MS = 15_000;

function validateLeaseId(value: string): string {
  const leaseId = value.trim();
  if (leaseId.length < 8 || leaseId.length > 128) {
    throw new Error("Spec import request is invalid");
  }
  return leaseId;
}

export const acquire = mutation({
  args: { leaseId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ leaseId: string; expiresAt: number }> => {
    const claims = await requireIdentity(ctx);
    if (!claims.orgId) {
      throw new Error("Select an organization before importing a spec");
    }
    const leaseId = validateLeaseId(args.leaseId);
    const now = Date.now();
    const existing = await ctx.db
      .query("specImportLimits")
      .withIndex("by_scope", (q) =>
        q.eq("clerkOrgId", claims.orgId!).eq("userId", claims.subject),
      )
      .unique();
    const activeLeases = (existing?.leases ?? []).filter(
      (lease) => lease.expiresAt > now,
    );
    const duplicate = activeLeases.find((lease) => lease.id === leaseId);
    if (duplicate) return { leaseId, expiresAt: duplicate.expiresAt };
    if (activeLeases.length >= SPEC_IMPORT_MAX_CONCURRENCY) {
      throw new Error(
        "Too many spec imports are already running. Try again shortly.",
      );
    }

    const sameWindow =
      existing !== null &&
      now - existing.windowStartedAt < SPEC_IMPORT_RATE_WINDOW_MS;
    const requestsInWindow = sameWindow ? existing.requestsInWindow : 0;
    if (requestsInWindow >= SPEC_IMPORT_RATE_LIMIT) {
      throw new Error("Spec import limit reached. Try again in a minute.");
    }
    const expiresAt = now + SPEC_IMPORT_LEASE_MS;
    const value = {
      windowStartedAt: sameWindow ? existing!.windowStartedAt : now,
      requestsInWindow: requestsInWindow + 1,
      leases: [...activeLeases, { id: leaseId, expiresAt }],
      updatedAt: now,
    };
    if (existing === null) {
      await ctx.db.insert("specImportLimits", {
        clerkOrgId: claims.orgId,
        userId: claims.subject,
        ...value,
      });
    } else {
      await ctx.db.patch(existing._id, value);
    }
    return { leaseId, expiresAt };
  },
});

/** Idempotent compensation after fetch/parse completes or fails. */
export const release = mutation({
  args: { leaseId: v.string() },
  handler: async (ctx, args): Promise<{ released: boolean }> => {
    const claims = await requireIdentity(ctx);
    if (!claims.orgId) return { released: false };
    const leaseId = validateLeaseId(args.leaseId);
    const existing = await ctx.db
      .query("specImportLimits")
      .withIndex("by_scope", (q) =>
        q.eq("clerkOrgId", claims.orgId!).eq("userId", claims.subject),
      )
      .unique();
    if (existing === null) return { released: false };
    const leases = existing.leases.filter(
      (lease) => lease.expiresAt > Date.now() && lease.id !== leaseId,
    );
    const released = leases.length < existing.leases.length;
    if (released) {
      await ctx.db.patch(existing._id, { leases, updatedAt: Date.now() });
    }
    return { released };
  },
});
