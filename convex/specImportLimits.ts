import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { requireIdentity } from "./lib/auth";

export const SPEC_IMPORT_MAX_CONCURRENCY = 2;
export const SPEC_IMPORT_RATE_WINDOW_MS = 60_000;
export const SPEC_IMPORT_RATE_LIMIT = 10;
export const SPEC_IMPORT_LEASE_MS = 30_000;
export const SPEC_IMPORT_GLOBAL_MAX_CONCURRENCY = 40;
export const SPEC_IMPORT_GLOBAL_RATE_LIMIT = 200;

function validateLeaseId(value: string): string {
  const leaseId = value.trim();
  if (leaseId.length < 8 || leaseId.length > 128) {
    throw new Error("Spec import request is invalid");
  }
  return leaseId;
}

function globalLeaseId(orgId: string, userId: string, leaseId: string): string {
  return `${orgId}:${userId}:${leaseId}`;
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
    const scopedGlobalId = globalLeaseId(claims.orgId, claims.subject, leaseId);
    const now = Date.now();
    const [existing, global] = await Promise.all([
      ctx.db
        .query("specImportLimits")
        .withIndex("by_scope", (q) =>
          q.eq("clerkOrgId", claims.orgId!).eq("userId", claims.subject),
        )
        .unique(),
      ctx.db
        .query("specImportGlobalLimits")
        .withIndex("by_singleton", (q) => q.eq("singleton", "global"))
        .unique(),
    ]);
    const activeLeases = (existing?.leases ?? []).filter(
      (lease) => lease.expiresAt > now,
    );
    const activeGlobalLeases = (global?.leases ?? []).filter(
      (lease) => lease.expiresAt > now,
    );
    const duplicate = activeLeases.find((lease) => lease.id === leaseId);
    const globalDuplicate = activeGlobalLeases.find(
      (lease) => lease.id === scopedGlobalId,
    );
    if (duplicate || globalDuplicate) {
      if (
        duplicate === undefined ||
        globalDuplicate === undefined ||
        duplicate.expiresAt !== globalDuplicate.expiresAt
      ) {
        throw new Error("Spec import lease state is inconsistent");
      }
      return { leaseId, expiresAt: duplicate.expiresAt };
    }
    if (activeLeases.length >= SPEC_IMPORT_MAX_CONCURRENCY) {
      throw new Error(
        "Too many spec imports are already running. Try again shortly.",
      );
    }
    if (activeGlobalLeases.length >= SPEC_IMPORT_GLOBAL_MAX_CONCURRENCY) {
      throw new Error("Spec import service is busy. Try again shortly.");
    }

    const sameWindow =
      existing !== null &&
      now - existing.windowStartedAt < SPEC_IMPORT_RATE_WINDOW_MS;
    const requestsInWindow = sameWindow ? existing.requestsInWindow : 0;
    if (requestsInWindow >= SPEC_IMPORT_RATE_LIMIT) {
      throw new Error("Spec import limit reached. Try again in a minute.");
    }
    const sameGlobalWindow =
      global !== null &&
      now - global.windowStartedAt < SPEC_IMPORT_RATE_WINDOW_MS;
    const globalRequests = sameGlobalWindow ? global.requestsInWindow : 0;
    if (globalRequests >= SPEC_IMPORT_GLOBAL_RATE_LIMIT) {
      throw new Error("Spec import service is busy. Try again in a minute.");
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
    const globalValue = {
      singleton: "global" as const,
      windowStartedAt: sameGlobalWindow ? global!.windowStartedAt : now,
      requestsInWindow: globalRequests + 1,
      leases: [...activeGlobalLeases, { id: scopedGlobalId, expiresAt }],
      updatedAt: now,
    };
    if (global === null) {
      await ctx.db.insert("specImportGlobalLimits", globalValue);
    } else {
      await ctx.db.patch(global._id, globalValue);
    }
    return { leaseId, expiresAt };
  },
});

/** Server-derived extension before CPU-bound normalization begins. */
export const renew = mutation({
  args: { leaseId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ leaseId: string; expiresAt: number }> => {
    const claims = await requireIdentity(ctx);
    if (!claims.orgId) throw new Error("Spec import lease is unavailable");
    const leaseId = validateLeaseId(args.leaseId);
    const scopedGlobalId = globalLeaseId(claims.orgId, claims.subject, leaseId);
    const now = Date.now();
    const [existing, global] = await Promise.all([
      ctx.db
        .query("specImportLimits")
        .withIndex("by_scope", (q) =>
          q.eq("clerkOrgId", claims.orgId!).eq("userId", claims.subject),
        )
        .unique(),
      ctx.db
        .query("specImportGlobalLimits")
        .withIndex("by_singleton", (q) => q.eq("singleton", "global"))
        .unique(),
    ]);
    const localLease = existing?.leases.find(
      (lease) => lease.id === leaseId && lease.expiresAt > now,
    );
    const globalLease = global?.leases.find(
      (lease) => lease.id === scopedGlobalId && lease.expiresAt > now,
    );
    if (
      !existing ||
      !global ||
      !localLease ||
      !globalLease ||
      localLease.expiresAt !== globalLease.expiresAt
    ) {
      throw new Error("Spec import lease expired");
    }
    const expiresAt = now + SPEC_IMPORT_LEASE_MS;
    await ctx.db.patch(existing._id, {
      leases: existing.leases.map((lease) =>
        lease.id === leaseId ? { ...lease, expiresAt } : lease,
      ),
      updatedAt: now,
    });
    await ctx.db.patch(global._id, {
      leases: global.leases.map((lease) =>
        lease.id === scopedGlobalId ? { ...lease, expiresAt } : lease,
      ),
      updatedAt: now,
    });
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
    const owned = existing.leases.some((lease) => lease.id === leaseId);
    if (!owned) return { released: false };
    const now = Date.now();
    const leases = existing.leases.filter(
      (lease) => lease.expiresAt > now && lease.id !== leaseId,
    );
    await ctx.db.patch(existing._id, { leases, updatedAt: now });

    const global = await ctx.db
      .query("specImportGlobalLimits")
      .withIndex("by_singleton", (q) => q.eq("singleton", "global"))
      .unique();
    if (global !== null) {
      const scopedGlobalId = globalLeaseId(
        claims.orgId,
        claims.subject,
        leaseId,
      );
      await ctx.db.patch(global._id, {
        leases: global.leases.filter(
          (lease) => lease.expiresAt > now && lease.id !== scopedGlobalId,
        ),
        updatedAt: now,
      });
    }
    return { released: true };
  },
});
