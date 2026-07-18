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
