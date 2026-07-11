/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { MIN_PAYOUT_CREDITS } from "./payouts";
import { createNotification } from "./lib/notifications";

const modules = import.meta.glob("./**/*.ts");

type Seeded = {
  orgId: Id<"organizations">;
  projectId: Id<"projects">;
};

/** Org A earns 200,000 gross credits -> 190,000 net (95%) all-time. */
async function seedEarningOrg(
  t: ReturnType<typeof convexTest>,
): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_pub",
      name: "Publisher Co",
      slug: "publisher-co",
    });
    await ctx.db.insert("organizations", {
      clerkOrgId: "org_stranger",
      name: "Stranger Co",
      slug: "stranger-co",
    });
    const consumerOrgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_consumer",
      name: "Consumer Co",
      slug: "consumer-co",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Alpha API",
      slug: "alpha",
      status: "published",
      visibility: "public",
      tags: [],
    });
    await ctx.db.insert("usageEvents", {
      organizationId: consumerOrgId,
      projectId,
      endpoint: "/a",
      method: "GET",
      credits: 200_000,
      status: 200,
      latencyMs: 10,
      keyId: "k1",
      at: Date.now(),
    });
    return { orgId, projectId };
  });
}

function asPublisher(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "user_pub",
    org_id: "org_pub",
    org_slug: "publisher-co",
    org_role: "org:admin",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

function asStranger(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "user_stranger",
    org_id: "org_stranger",
    org_slug: "stranger-co",
    org_role: "org:member",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

describe("payouts.redeemableCredits", () => {
  it("rejects non-member", async () => {
    const t = convexTest(schema, modules);
    await seedEarningOrg(t);
    await expect(
      asStranger(t).query(api.payouts.redeemableCredits, {
        orgSlug: "publisher-co",
      }),
    ).rejects.toThrow(/Not a member/);
  });

  it("rejects unauthenticated", async () => {
    const t = convexTest(schema, modules);
    await seedEarningOrg(t);
    await expect(
      t.query(api.payouts.redeemableCredits, { orgSlug: "publisher-co" }),
    ).rejects.toThrow(/Not authenticated/);
  });

  it("computes redeemable = all-time net minus pending", async () => {
    const t = convexTest(schema, modules);
    await seedEarningOrg(t);
    const asPub = asPublisher(t);

    // 200,000 gross * 0.95 = 190,000 net all-time.
    const before = await asPub.query(api.payouts.redeemableCredits, {
      orgSlug: "publisher-co",
    });
    expect(before.netAllTime).toBe(190_000);
    expect(before.requested).toBe(0);
    expect(before.redeemable).toBe(190_000);
    expect(before.minPayout).toBe(MIN_PAYOUT_CREDITS);

    await asPub.mutation(api.payouts.requestPayout, {
      orgSlug: "publisher-co",
      credits: 100_000,
      destination: "bank: 1234",
    });

    const after = await asPub.query(api.payouts.redeemableCredits, {
      orgSlug: "publisher-co",
    });
    expect(after.requested).toBe(100_000);
    expect(after.redeemable).toBe(90_000);
  });

  it("excludes rejected requests from the requested total", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedEarningOrg(t);
    const requestId = await t.run(async (ctx) => {
      return await ctx.db.insert("payoutRequests", {
        clerkOrgId: "org_pub",
        credits: 100_000,
        destination: "bank: 1234",
        status: "pending",
        createdAt: Date.now(),
      });
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(requestId, {
        status: "rejected",
        resolvedAt: Date.now(),
      });
    });

    const asPub = asPublisher(t);
    const view = await asPub.query(api.payouts.redeemableCredits, {
      orgSlug: "publisher-co",
    });
    expect(view.requested).toBe(0);
    expect(view.redeemable).toBe(190_000);
    void seed;
  });

  it("includes paid requests in the requested total", async () => {
    const t = convexTest(schema, modules);
    await seedEarningOrg(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("payoutRequests", {
        clerkOrgId: "org_pub",
        credits: 100_000,
        destination: "bank: 1234",
        status: "paid",
        createdAt: Date.now(),
        resolvedAt: Date.now(),
      });
    });

    const asPub = asPublisher(t);
    const view = await asPub.query(api.payouts.redeemableCredits, {
      orgSlug: "publisher-co",
    });
    expect(view.requested).toBe(100_000);
    expect(view.redeemable).toBe(90_000);
  });
});

describe("payouts.requestPayout", () => {
  it("rejects credits below the minimum", async () => {
    const t = convexTest(schema, modules);
    await seedEarningOrg(t);
    const asPub = asPublisher(t);
    await expect(
      asPub.mutation(api.payouts.requestPayout, {
        orgSlug: "publisher-co",
        credits: MIN_PAYOUT_CREDITS - 1,
        destination: "bank: 1234",
      }),
    ).rejects.toThrow(/Minimum payout/);
  });

  it("rejects credits above redeemable balance", async () => {
    const t = convexTest(schema, modules);
    await seedEarningOrg(t);
    const asPub = asPublisher(t);
    await expect(
      asPub.mutation(api.payouts.requestPayout, {
        orgSlug: "publisher-co",
        credits: 999_999_999,
        destination: "bank: 1234",
      }),
    ).rejects.toThrow(/exceed your redeemable balance/);
  });

  it("rejects zero or negative credits", async () => {
    const t = convexTest(schema, modules);
    await seedEarningOrg(t);
    const asPub = asPublisher(t);
    await expect(
      asPub.mutation(api.payouts.requestPayout, {
        orgSlug: "publisher-co",
        credits: 0,
        destination: "bank: 1234",
      }),
    ).rejects.toThrow(/greater than zero/);
  });

  it("rejects a blank destination", async () => {
    const t = convexTest(schema, modules);
    await seedEarningOrg(t);
    const asPub = asPublisher(t);
    await expect(
      asPub.mutation(api.payouts.requestPayout, {
        orgSlug: "publisher-co",
        credits: MIN_PAYOUT_CREDITS,
        destination: "   ",
      }),
    ).rejects.toThrow(/destination is required/);
  });

  it("rejects non-member", async () => {
    const t = convexTest(schema, modules);
    await seedEarningOrg(t);
    await expect(
      asStranger(t).mutation(api.payouts.requestPayout, {
        orgSlug: "publisher-co",
        credits: MIN_PAYOUT_CREDITS,
        destination: "bank: 1234",
      }),
    ).rejects.toThrow(/Not a member/);
  });

  it("inserts a pending request at the minimum threshold", async () => {
    const t = convexTest(schema, modules);
    await seedEarningOrg(t);
    const asPub = asPublisher(t);
    const requestId = await asPub.mutation(api.payouts.requestPayout, {
      orgSlug: "publisher-co",
      credits: MIN_PAYOUT_CREDITS,
      destination: "bank: 1234",
    });

    const request = await t.run(async (ctx) => await ctx.db.get(requestId));
    expect(request?.status).toBe("pending");
    expect(request?.credits).toBe(MIN_PAYOUT_CREDITS);
    expect(request?.clerkOrgId).toBe("org_pub");
  });

  it("notifies the requesting org with a payout_requested notification", async () => {
    const t = convexTest(schema, modules);
    await seedEarningOrg(t);
    const asPub = asPublisher(t);
    const requestId = await asPub.mutation(api.payouts.requestPayout, {
      orgSlug: "publisher-co",
      credits: MIN_PAYOUT_CREDITS,
      destination: "bank: 1234",
    });

    const notif = await t.run(async (ctx) => {
      return await ctx.db
        .query("notifications")
        .withIndex("by_ref", (q) =>
          q.eq("refId", `payout_requested:${requestId}`),
        )
        .unique();
    });
    expect(notif).not.toBeNull();
    expect(notif?.kind).toBe("payout_requested");
    expect(notif?.clerkOrgId).toBe("org_pub");
    expect(notif?.body).toContain("100,000 credits");
    expect(notif?.body).toContain("$10.00");
  });

  it("payout_requested notification is idempotent by refId", async () => {
    const t = convexTest(schema, modules);
    const refId = "payout_requested:idempotency-check";

    const r1 = await t.run(async (ctx) => {
      return await createNotification(ctx, {
        clerkOrgId: "org_pub",
        kind: "payout_requested",
        title: "Payout requested",
        body: "Payout requested for 100,000 credits ($10.00).",
        refId,
      });
    });
    expect(r1.created).toBe(true);

    const r2 = await t.run(async (ctx) => {
      return await createNotification(ctx, {
        clerkOrgId: "org_pub",
        kind: "payout_requested",
        title: "Payout requested",
        body: "Payout requested for 100,000 credits ($10.00).",
        refId,
      });
    });
    expect(r2.created).toBe(false);
    expect(r2.id).toBe(r1.id);

    const rows = await t.run(async (ctx) => {
      return await ctx.db
        .query("notifications")
        .withIndex("by_ref", (q) => q.eq("refId", refId))
        .collect();
    });
    expect(rows).toHaveLength(1);
  });
});

describe("payouts.listMyRequests", () => {
  it("rejects non-member", async () => {
    const t = convexTest(schema, modules);
    await seedEarningOrg(t);
    await expect(
      asStranger(t).query(api.payouts.listMyRequests, {
        orgSlug: "publisher-co",
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow(/Not a member/);
  });

  it("lists only this org's requests, newest first", async () => {
    const t = convexTest(schema, modules);
    await seedEarningOrg(t);
    const asPub = asPublisher(t);

    await asPub.mutation(api.payouts.requestPayout, {
      orgSlug: "publisher-co",
      credits: MIN_PAYOUT_CREDITS,
      destination: "first",
    });

    // Another org's request must not leak in.
    await t.run(async (ctx) => {
      await ctx.db.insert("payoutRequests", {
        clerkOrgId: "org_stranger",
        credits: MIN_PAYOUT_CREDITS,
        destination: "not mine",
        status: "pending",
        createdAt: Date.now(),
      });
    });

    const result = await asPub.query(api.payouts.listMyRequests, {
      orgSlug: "publisher-co",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(result.page).toHaveLength(1);
    expect(result.page[0]!.destination).toBe("first");
  });
});
