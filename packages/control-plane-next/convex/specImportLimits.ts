import { v, ConvexError } from "convex/values";
import { RateLimiter, MINUTE } from "@convex-dev/rate-limiter";
import { mutation, internalMutation } from "./_generated/server";
import { components } from "./_generated/api";
import { requireActiveOrg } from "./lib/auth";
const limiter = new RateLimiter(components.rateLimiter, {
  principal: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 10 },
  global: {
    kind: "token bucket",
    rate: 200,
    period: MINUTE,
    capacity: 200,
    shards: 8,
  },
});
const leaseKey = (org: string, user: string, id: string) => {
  if (id.trim().length < 8 || id.length > 128)
    throw new ConvexError("Spec import request is invalid");
  return JSON.stringify([org, user, id]);
};
export const acquire = mutation({
  args: { leaseId: v.string() },
  handler: async (ctx, args) => {
    const { org, claims } = await requireActiveOrg(ctx),
      key = leaseKey(org._id, claims.subject, args.leaseId),
      now = Date.now();
    const old = await ctx.db
      .query("specImportLeases")
      .withIndex("by_lease", (q) => q.eq("leaseId", key))
      .unique();
    if (old && old.expiresAt > now)
      return { leaseId: args.leaseId, expiresAt: old.expiresAt };
    const active = await ctx.db
      .query("specImportLeases")
      .withIndex("by_principal", (q) =>
        q
          .eq("organizationId", org._id)
          .eq("userId", claims.subject)
          .gt("expiresAt", now),
      )
      .take(2);
    if (active.length >= 2)
      throw new ConvexError(
        "Too many spec imports are already running. Try again shortly.",
      );
    const global = await ctx.db
      .query("specImportLeases")
      .withIndex("by_expiry", (q) => q.gt("expiresAt", now))
      .take(40);
    if (
      global.length >= 40 ||
      !(await limiter.limit(ctx, "global")).ok ||
      !(
        await limiter.limit(ctx, "principal", {
          key: JSON.stringify([org._id, claims.subject]),
        })
      ).ok
    )
      throw new ConvexError("Spec import service is busy. Try again shortly.");
    const expiresAt = now + 30000;
    if (old) await ctx.db.patch(old._id, { expiresAt });
    else
      await ctx.db.insert("specImportLeases", {
        organizationId: org._id,
        userId: claims.subject,
        leaseId: key,
        expiresAt,
        createdAt: now,
      });
    return { leaseId: args.leaseId, expiresAt };
  },
});
export const renew = mutation({
  args: { leaseId: v.string() },
  handler: async (ctx, args) => {
    const { org, claims } = await requireActiveOrg(ctx),
      key = leaseKey(org._id, claims.subject, args.leaseId),
      row = await ctx.db
        .query("specImportLeases")
        .withIndex("by_lease", (q) => q.eq("leaseId", key))
        .unique();
    if (!row || row.expiresAt <= Date.now())
      throw new ConvexError("Spec import lease expired");
    const expiresAt = Date.now() + 30000;
    await ctx.db.patch(row._id, { expiresAt });
    return { leaseId: args.leaseId, expiresAt };
  },
});
export const release = mutation({
  args: { leaseId: v.string() },
  handler: async (ctx, args) => {
    const { org, claims } = await requireActiveOrg(ctx),
      key = leaseKey(org._id, claims.subject, args.leaseId),
      row = await ctx.db
        .query("specImportLeases")
        .withIndex("by_lease", (q) => q.eq("leaseId", key))
        .unique();
    if (row) await ctx.db.delete(row._id);
    return { released: !!row };
  },
});
export const cleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("specImportLeases")
      .withIndex("by_expiry", (q) => q.lte("expiresAt", Date.now()))
      .take(100);
    for (const row of rows) await ctx.db.delete(row._id);
  },
});
