/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ADMIN_SUBJECT = "admin_user";
const REGULAR_SUBJECT = "regular_user";

type Seeded = {
  orgId: Id<"organizations">;
  projectId: Id<"projects">;
};

async function seedWorld(t: ReturnType<typeof convexTest>): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_a",
      name: "Org A",
      slug: "org-a",
    });
    await ctx.db.insert("wallets", {
      organizationId: orgId,
      balance: 50_000,
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Proj A",
      slug: "proj-a",
      status: "published",
      visibility: "public",
      tags: [],
    });
    await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Proj B",
      slug: "proj-b",
      status: "draft",
      visibility: "private",
      tags: [],
    });
    // Usage event this month
    await ctx.db.insert("usageEvents", {
      organizationId: orgId,
      projectId,
      endpoint: "/x",
      method: "GET",
      credits: 5,
      status: 200,
      latencyMs: 12,
      keyId: "k1",
      at: Date.now(),
    });
    return { orgId, projectId };
  });
}

function asAdmin(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({ subject: ADMIN_SUBJECT } as { subject: string });
}

function asRegular(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({ subject: REGULAR_SUBJECT } as { subject: string });
}

describe("admin gate", () => {
  const prevEnv = process.env.ADMIN_USER_IDS;

  beforeEach(() => {
    process.env.ADMIN_USER_IDS = ADMIN_SUBJECT;
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.ADMIN_USER_IDS;
    } else {
      process.env.ADMIN_USER_IDS = prevEnv;
    }
  });

  it("rejects non-admin user", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    await expect(
      asRegular(t).query(api.admin.platformStats, {}),
    ).rejects.toThrow(/Not authorized as admin/);
  });

  it("rejects unauthenticated", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    await expect(t.query(api.admin.platformStats, {})).rejects.toThrow(
      /Not authenticated/,
    );
  });

  it("rejects when env unset (fail closed)", async () => {
    delete process.env.ADMIN_USER_IDS;
    const t = convexTest(schema, modules);
    await seedWorld(t);
    await expect(asAdmin(t).query(api.admin.platformStats, {})).rejects.toThrow(
      /Admin access not configured/,
    );
  });
});

describe("admin.isAdminQuery", () => {
  const prevEnv = process.env.ADMIN_USER_IDS;

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.ADMIN_USER_IDS;
    } else {
      process.env.ADMIN_USER_IDS = prevEnv;
    }
  });

  it("returns true for admin user", async () => {
    process.env.ADMIN_USER_IDS = ADMIN_SUBJECT;
    const t = convexTest(schema, modules);
    const result = await asAdmin(t).query(api.admin.isAdminQuery, {});
    expect(result).toBe(true);
  });

  it("returns false for non-admin user", async () => {
    process.env.ADMIN_USER_IDS = ADMIN_SUBJECT;
    const t = convexTest(schema, modules);
    const result = await asRegular(t).query(api.admin.isAdminQuery, {});
    expect(result).toBe(false);
  });

  it("returns false when env unset", async () => {
    delete process.env.ADMIN_USER_IDS;
    const t = convexTest(schema, modules);
    const result = await asAdmin(t).query(api.admin.isAdminQuery, {});
    expect(result).toBe(false);
  });

  it("returns false when unauthenticated", async () => {
    process.env.ADMIN_USER_IDS = ADMIN_SUBJECT;
    const t = convexTest(schema, modules);
    const result = await t.query(api.admin.isAdminQuery, {});
    expect(result).toBe(false);
  });
});

describe("admin.platformStats", () => {
  const prevEnv = process.env.ADMIN_USER_IDS;

  beforeEach(() => {
    process.env.ADMIN_USER_IDS = ADMIN_SUBJECT;
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.ADMIN_USER_IDS;
    } else {
      process.env.ADMIN_USER_IDS = prevEnv;
    }
  });

  it("returns correct shape", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);

    const stats = await asAdmin(t).query(api.admin.platformStats, {});

    expect(stats.orgs).toBe(1);
    expect(stats.projects).toEqual({ draft: 1, published: 1 });
    expect(stats.projectsTotal).toBe(2);
    expect(stats.usageThisMonth).toBe(1);
    expect(stats.usageCapped).toBe(false);
    expect(stats.usageCap).toBeGreaterThan(0);
  });
});

describe("admin.listOrgs", () => {
  const prevEnv = process.env.ADMIN_USER_IDS;

  beforeEach(() => {
    process.env.ADMIN_USER_IDS = ADMIN_SUBJECT;
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.ADMIN_USER_IDS;
    } else {
      process.env.ADMIN_USER_IDS = prevEnv;
    }
  });

  it("returns orgs with wallet balance", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);

    const result = await asAdmin(t).query(api.admin.listOrgs, {
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(result.page).toHaveLength(1);
    expect(result.page[0]!.name).toBe("Org A");
    expect(result.page[0]!.balance).toBe(50_000);
    expect(result.page[0]!.clerkOrgId).toBe("org_a");
  });
});

describe("admin.listProjects", () => {
  const prevEnv = process.env.ADMIN_USER_IDS;

  beforeEach(() => {
    process.env.ADMIN_USER_IDS = ADMIN_SUBJECT;
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.ADMIN_USER_IDS;
    } else {
      process.env.ADMIN_USER_IDS = prevEnv;
    }
  });

  it("paginates all projects", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);

    const result = await asAdmin(t).query(api.admin.listProjects, {
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(result.page).toHaveLength(2);
  });

  it("filters by status", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);

    const result = await asAdmin(t).query(api.admin.listProjects, {
      paginationOpts: { numItems: 50, cursor: null },
      status: "published",
    });
    expect(result.page).toHaveLength(1);
    expect(result.page[0]!.status).toBe("published");
  });

  it("filters by visibility + status via index", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);

    const result = await asAdmin(t).query(api.admin.listProjects, {
      paginationOpts: { numItems: 50, cursor: null },
      status: "draft",
      visibility: "private",
    });
    expect(result.page).toHaveLength(1);
    expect(result.page[0]!.slug).toBe("proj-b");
  });
});

describe("admin.recentUsage", () => {
  const prevEnv = process.env.ADMIN_USER_IDS;

  beforeEach(() => {
    process.env.ADMIN_USER_IDS = ADMIN_SUBJECT;
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.ADMIN_USER_IDS;
    } else {
      process.env.ADMIN_USER_IDS = prevEnv;
    }
  });

  it("returns newest usage events", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);

    const events = await asAdmin(t).query(api.admin.recentUsage, {});
    expect(events).toHaveLength(1);
    expect(events[0]!.credits).toBe(5);
    expect(events[0]!.endpoint).toBe("/x");
  });
});

describe("admin.setProjectVisibility", () => {
  const prevEnv = process.env.ADMIN_USER_IDS;

  beforeEach(() => {
    process.env.ADMIN_USER_IDS = ADMIN_SUBJECT;
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.ADMIN_USER_IDS;
    } else {
      process.env.ADMIN_USER_IDS = prevEnv;
    }
  });

  it("changes visibility + notifies org", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);

    const updated = await asAdmin(t).mutation(api.admin.setProjectVisibility, {
      projectId: seed.projectId,
      visibility: "private",
    });

    expect(updated.visibility).toBe("private");

    const notifs = await t.run(async (ctx) => {
      return await ctx.db.query("notifications").collect();
    });
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.kind).toBe("visibility_changed");
    expect(notifs[0]!.body).toContain("Proj A");
  });

  it("rejects non-admin", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    await expect(
      asRegular(t).mutation(api.admin.setProjectVisibility, {
        projectId: seed.projectId,
        visibility: "private",
      }),
    ).rejects.toThrow(/Not authorized as admin/);
  });
});

async function seedPayoutRequest(
  t: ReturnType<typeof convexTest>,
  overrides: Partial<{
    clerkOrgId: string;
    credits: number;
    status: "pending" | "paid" | "rejected";
  }> = {},
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("payoutRequests", {
      clerkOrgId: overrides.clerkOrgId ?? "org_a",
      credits: overrides.credits ?? 100_000,
      destination: "bank: 1234",
      status: overrides.status ?? "pending",
      createdAt: Date.now(),
    });
  });
}

describe("admin.listPayoutRequests", () => {
  const prevEnv = process.env.ADMIN_USER_IDS;

  beforeEach(() => {
    process.env.ADMIN_USER_IDS = ADMIN_SUBJECT;
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.ADMIN_USER_IDS;
    } else {
      process.env.ADMIN_USER_IDS = prevEnv;
    }
  });

  it("rejects non-admin", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    await seedPayoutRequest(t);
    await expect(
      asRegular(t).query(api.admin.listPayoutRequests, {
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow(/Not authorized as admin/);
  });

  it("lists all requests newest-first when unfiltered", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    await seedPayoutRequest(t, { status: "pending" });
    await seedPayoutRequest(t, { status: "paid" });

    const result = await asAdmin(t).query(api.admin.listPayoutRequests, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(result.page).toHaveLength(2);
  });

  it("filters by status via the by_status index", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    await seedPayoutRequest(t, { status: "pending" });
    await seedPayoutRequest(t, { status: "paid" });

    const result = await asAdmin(t).query(api.admin.listPayoutRequests, {
      status: "pending",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(result.page).toHaveLength(1);
    expect(result.page[0]!.status).toBe("pending");
  });
});

describe("admin.resolvePayout", () => {
  const prevEnv = process.env.ADMIN_USER_IDS;

  beforeEach(() => {
    process.env.ADMIN_USER_IDS = ADMIN_SUBJECT;
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.ADMIN_USER_IDS;
    } else {
      process.env.ADMIN_USER_IDS = prevEnv;
    }
  });

  it("rejects non-admin", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const requestId = await seedPayoutRequest(t);
    await expect(
      asRegular(t).mutation(api.admin.resolvePayout, {
        requestId,
        status: "paid",
      }),
    ).rejects.toThrow(/Not authorized as admin/);
  });

  it("marks a pending request paid with a note", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const requestId = await seedPayoutRequest(t);

    const updated = await asAdmin(t).mutation(api.admin.resolvePayout, {
      requestId,
      status: "paid",
      note: "wired 2026-07-11",
    });

    expect(updated.status).toBe("paid");
    expect(updated.note).toBe("wired 2026-07-11");
    expect(updated.resolvedAt).toBeGreaterThan(0);
  });

  it("marks a pending request rejected", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const requestId = await seedPayoutRequest(t);

    const updated = await asAdmin(t).mutation(api.admin.resolvePayout, {
      requestId,
      status: "rejected",
    });

    expect(updated.status).toBe("rejected");
    expect(updated.resolvedAt).toBeGreaterThan(0);
  });

  it("rejects resolving an already-resolved request", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const requestId = await seedPayoutRequest(t, { status: "paid" });

    await expect(
      asAdmin(t).mutation(api.admin.resolvePayout, {
        requestId,
        status: "rejected",
      }),
    ).rejects.toThrow(/Only pending requests can be resolved/);
  });

  it("throws for an unknown request id", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const requestId = await seedPayoutRequest(t);
    await t.run(async (ctx) => {
      await ctx.db.delete(requestId);
    });

    await expect(
      asAdmin(t).mutation(api.admin.resolvePayout, {
        requestId,
        status: "paid",
      }),
    ).rejects.toThrow(/Payout request not found/);
  });
});
