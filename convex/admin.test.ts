/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = "admin_user";

async function seedTransfer(t: TestConvex<typeof schema>): Promise<void> {
  return await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_publisher",
      name: "Publisher",
      slug: "publisher",
    });
    await ctx.db.insert("publisherTransfers", {
      publisherOrganizationId: organizationId,
      stripeConnectedAccountId: "acct_operator_view",
      amount: 950,
      amountAtoms: 950_000_000,
      remainderAtoms: 0,
      currency: "usd",
      idempotencyKey: "publisher-transfer:test",
      status: "failed",
      failureReason: "insufficient platform balance",
      createdAt: 1,
      updatedAt: 2,
    });
  });
}

describe("admin publisher transfer operations", () => {
  const priorAdminIds = process.env.ADMIN_USER_IDS;
  beforeEach(() => {
    process.env.ADMIN_USER_IDS = ADMIN;
  });
  afterEach(() => {
    if (priorAdminIds === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = priorAdminIds;
  });

  it("fails closed for a non-admin", async () => {
    const t = convexTest(schema, modules);
    await seedTransfer(t);
    await expect(
      t
        .withIdentity({ subject: "member" } as { subject: string })
        .query(api.admin.listPublisherTransfers, {
          paginationOpts: { numItems: 10, cursor: null },
        }),
    ).rejects.toThrow("Not authorized as admin");
  });

  it("returns operator-safe Stripe transfer state without a manual destination", async () => {
    const t = convexTest(schema, modules);
    await seedTransfer(t);
    const result = await t
      .withIdentity({ subject: ADMIN } as { subject: string })
      .query(api.admin.listPublisherTransfers, {
        paginationOpts: { numItems: 10, cursor: null },
      });
    expect(result.page).toHaveLength(1);
    expect(result.page[0]).toMatchObject({
      amount: 950,
      currency: "usd",
      status: "failed",
      failureReason: "insufficient platform balance",
      stripeConnectedAccountId: "acct_operator_view",
      publisherOrganizationName: "Publisher",
      publisherOrganizationSlug: "publisher",
    });
    expect(result.page[0]).not.toHaveProperty("destination");
  });
});

describe("admin project pagination", () => {
  const priorAdminIds = process.env.ADMIN_USER_IDS;
  beforeEach(() => {
    process.env.ADMIN_USER_IDS = ADMIN;
  });
  afterEach(() => {
    if (priorAdminIds === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = priorAdminIds;
  });

  it("applies single filters before pagination and clamps page size", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_admin_filter",
        name: "Filter owner",
        slug: "filter-owner",
      });
      await ctx.db.insert("projects", {
        organizationId,
        name: "Buried published project",
        slug: "buried-published",
        status: "published",
        visibility: "public",
        tags: [],
      });
      for (let index = 0; index < 80; index += 1) {
        await ctx.db.insert("projects", {
          organizationId,
          name: `New draft ${index}`,
          slug: `new-draft-${index}`,
          status: "draft",
          visibility: "public",
          tags: [],
        });
      }
    });
    const admin = t.withIdentity({ subject: ADMIN } as { subject: string });

    const published = await admin.query(api.admin.listProjects, {
      status: "published",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(published.page.map((project) => project.slug)).toEqual([
      "buried-published",
    ]);

    const capped = await admin.query(api.admin.listProjects, {
      visibility: "public",
      paginationOpts: { numItems: 10_000, cursor: null },
    });
    expect(capped.page).toHaveLength(50);
    expect(capped.isDone).toBe(false);
    expect(
      capped.page.every((project) => project.visibility === "public"),
    ).toBe(true);
  });
});
