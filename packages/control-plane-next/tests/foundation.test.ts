import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import tables from "../contracts/tables.json";
import {
  requireActiveOrg,
  requireProjectAdmin,
  requireProjectMember,
} from "../convex/lib/auth";
import {
  publisherEarningSplit,
  creditsToAtoms,
  atomsToUsdCents,
  PUBLISHER_RISK_HOLD_MS,
} from "../convex/accounting";
import { organization, projectFields, NOW } from "./fixtures";
const modules = {
  "../convex/_generated/server.js": () =>
    import("../convex/_generated/server.js"),
};
describe("isolated schema and proven ports", () => {
  it("has exactly 34 app tables with the frozen original-source and ownership indexes", () => {
    expect(Object.keys(schema.tables).sort()).toEqual(
      [...tables.application].sort(),
    );
    expect(tables.application).toHaveLength(34);
    expect(Object.values(tables.components).flat()).toHaveLength(4);
    expect(JSON.stringify(schema.tables.fundingLotSources)).toContain(
      "by_payment",
    );
    expect(JSON.stringify(schema.tables.walletEntries)).toContain(
      "by_move_source",
    );
    expect(JSON.stringify(schema.tables.projects)).toContain("search_public");
    for (const forbidden of [
      "walletSessions",
      "capabilityProviders",
      "tokenUsage",
      "tokenPricing",
      "anonymous",
    ])
      expect(JSON.stringify(schema)).not.toContain(forbidden);
  });
  it("ports exact 95/5 and sub-cent carry without floating-point ledger amounts", () => {
    expect(publisherEarningSplit(1)).toMatchObject({
      platformFeeAtoms: 500,
      publisherNetAtoms: 9500,
    });
    expect(atomsToUsdCents(999999)).toBe(0);
    expect(atomsToUsdCents(1000001)).toBe(1);
    expect(() => creditsToAtoms(Number.MAX_SAFE_INTEGER)).toThrow(Error);
    expect(() => publisherEarningSplit(-1)).toThrow(Error);
    expect(PUBLISHER_RISK_HOLD_MS).toBe(7 * 86400000);
  });
  it("denies archive/tombstone, wrong tenant, unknown role and member publisher edits", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const org = await ctx.db.insert("organizations", organization("a"));
      const project = await ctx.db.insert("projects", {
        ...projectFields,
        organizationId: org,
      });
      return { org, project };
    });
    const member = t.withIdentity({
      subject: "user_a",
      org_id: "org_a",
      org_role: "org:member",
    });
    expect(
      (await member.query((ctx) => requireProjectMember(ctx, ids.project))).org
        ._id,
    ).toBe(ids.org);
    await expect(
      member.query((ctx) => requireProjectAdmin(ctx, ids.project)),
    ).rejects.toThrow("Org admin");
    await expect(
      t
        .withIdentity({
          subject: "other",
          org_id: "org_other",
          org_role: "org:admin",
        })
        .query(requireActiveOrg),
    ).rejects.toThrow("Organization not found");
    await expect(
      t
        .withIdentity({
          subject: "user_a",
          org_id: "org_a",
          org_role: "custom",
        })
        .query(requireActiveOrg),
    ).rejects.toThrow("role is not supported");
    await t.run((ctx) =>
      ctx.db.insert("orgTombstones", {
        clerkOrgId: "org_a",
        sourceTimestamp: NOW,
        archivedAt: NOW,
      }),
    );
    await expect(member.query(requireActiveOrg)).rejects.toThrow(
      "Organization not found",
    );
  });
  it("retains user grant identity after personal data is scrubbed", async () => {
    const t = convexTest(schema, modules);
    const user = await t.run(async (ctx) => {
      const org = await ctx.db.insert("organizations", {
        ...organization("signup"),
        personalForClerkUserId: "user_signup",
      });
      return ctx.db.insert("users", {
        clerkUserId: "user_signup",
        email: "synthetic@fixture.invalid",
        name: "Fixture",
        lastClerkEventAt: NOW,
        signupPersonalOrganizationId: org,
        signupGrant: {
          refId: "signup:user_signup",
          organizationId: org,
          grantedAt: NOW,
        },
      });
    });
    await t.run((ctx) =>
      ctx.db.patch(user, {
        name: undefined,
        email: undefined,
        deletedAt: NOW + 1,
      }),
    );
    const after = await t.run((ctx) => ctx.db.get(user));
    expect(after?.signupGrant?.refId).toBe("signup:user_signup");
    expect(after?.email).toBeUndefined();
  });
});
