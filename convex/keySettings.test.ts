/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const KEY_A = "key_live_AAAA";
const KEY_B = "key_live_BBBB";

async function seedWorld(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"organizations">> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_acme",
      name: "Acme",
      slug: "acme",
    });
    await ctx.db.insert("organizations", {
      clerkOrgId: "org_other",
      name: "Other",
      slug: "other",
    });
    return orgId;
  });
}

function asUser(t: ReturnType<typeof convexTest>, userId = "user_owner") {
  return t.withIdentity({
    subject: userId,
    org_id: "org_acme",
    org_role: "org:member",
  } as { subject: string });
}

async function register(
  t: ReturnType<typeof convexTest>,
  keyId = KEY_A,
  userId = "user_owner",
) {
  return await t.mutation(internal.keySettings.registerVerified, {
    clerkOrgId: "org_acme",
    userId,
    keyId,
  });
}

describe("user-owned key settings", () => {
  it("never exposes sibling or legacy-unclaimed key ids to a member", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    await register(t, KEY_A, "user_owner");
    await register(t, KEY_B, "user_sibling");
    await t.run(async (ctx) => {
      await ctx.db.insert("keySettings", {
        clerkOrgId: "org_acme",
        keyId: "key_legacy_unclaimed",
        disabled: false,
        updatedAt: 1,
      });
    });

    const rows = await asUser(t).query(api.keySettings.getForOrg, {});
    expect(rows.map((row) => row.keyId)).toEqual([KEY_A]);
  });

  it("rejects same-org sibling IDOR for cap and disable writes", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    await register(t, KEY_A, "user_owner");

    await expect(
      t.mutation(internal.keySettings.setCapVerified, {
        clerkOrgId: "org_acme",
        userId: "user_sibling",
        keyId: KEY_A,
        monthlyCapCredits: 1,
      }),
    ).rejects.toThrow("Key unavailable");
    await expect(
      t.mutation(internal.keySettings.setDisabledVerified, {
        clerkOrgId: "org_acme",
        userId: "user_sibling",
        keyId: KEY_A,
        disabled: true,
      }),
    ).rejects.toThrow("Key unavailable");
  });

  it("updates only verified existing ownership and validates caps", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    await register(t);
    const capped = await t.mutation(internal.keySettings.setCapVerified, {
      clerkOrgId: "org_acme",
      userId: "user_owner",
      keyId: KEY_A,
      monthlyCapCredits: 500,
    });
    expect(capped.monthlyCapCredits).toBe(500);
    await expect(
      t.mutation(internal.keySettings.setCapVerified, {
        clerkOrgId: "org_acme",
        userId: "user_owner",
        keyId: KEY_A,
        monthlyCapCredits: 1.5,
      }),
    ).rejects.toThrow("positive whole number");
  });
});

describe("key lifecycle reservations", () => {
  it("disables locally before external revoke and compensates idempotently on failure", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    await register(t);
    const scope = {
      clerkOrgId: "org_acme",
      userId: "user_owner",
      operationId: "revoke-operation-1",
    };
    await t.mutation(internal.keySettings.beginRevokeVerified, {
      ...scope,
      keyId: KEY_A,
    });
    expect(
      (await asUser(t).query(api.keySettings.getForOrg, {}))[0]?.disabled,
    ).toBe(true);

    await t.mutation(internal.keySettings.failRevokeVerified, {
      ...scope,
      message: "Clerk failed",
    });
    await t.mutation(internal.keySettings.failRevokeVerified, {
      ...scope,
      message: "duplicate callback",
    });
    expect(
      (await asUser(t).query(api.keySettings.getForOrg, {}))[0]?.disabled,
    ).toBe(false);
  });

  it("keeps local gate disabled after terminal external revoke", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    await register(t);
    const scope = {
      clerkOrgId: "org_acme",
      userId: "user_owner",
      operationId: "revoke-operation-2",
    };
    await t.mutation(internal.keySettings.beginRevokeVerified, {
      ...scope,
      keyId: KEY_A,
    });
    await t.mutation(internal.keySettings.completeRevokeVerified, scope);
    await t.mutation(internal.keySettings.completeRevokeVerified, scope);
    expect(
      (await asUser(t).query(api.keySettings.getForOrg, {}))[0]?.disabled,
    ).toBe(true);
  });

  it("serializes revokes and blocks re-enable while external revoke is pending", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    await register(t, KEY_A);
    await register(t, KEY_B);
    await t.mutation(internal.keySettings.beginRevokeVerified, {
      clerkOrgId: "org_acme",
      userId: "user_owner",
      operationId: "revoke-operation-race-1",
      keyId: KEY_A,
    });

    await expect(
      t.mutation(internal.keySettings.beginRevokeVerified, {
        clerkOrgId: "org_acme",
        userId: "user_owner",
        operationId: "revoke-operation-race-2",
        keyId: KEY_B,
      }),
    ).rejects.toThrow("already in progress");
    await expect(
      t.mutation(internal.keySettings.setDisabledVerified, {
        clerkOrgId: "org_acme",
        userId: "user_owner",
        keyId: KEY_A,
        disabled: false,
      }),
    ).rejects.toThrow("revocation is in progress");
  });

  it("prevents rotation and revocation from racing on one key", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    await register(t);
    await t.mutation(internal.keySettings.beginRotationVerified, {
      clerkOrgId: "org_acme",
      userId: "user_owner",
      operationId: "rotate-operation-race",
      oldKeyId: KEY_A,
    });

    await expect(
      t.mutation(internal.keySettings.beginRevokeVerified, {
        clerkOrgId: "org_acme",
        userId: "user_owner",
        operationId: "revoke-operation-race",
        keyId: KEY_A,
      }),
    ).rejects.toThrow("rotation is in progress");
  });
});

describe("wallet gateway projection", () => {
  it("retains owner-agnostic enforcement rows for edge sync", async () => {
    const t = convexTest(schema, modules);
    const orgId = await seedWorld(t);
    await register(t, KEY_A, "user_owner");
    await register(t, KEY_B, "user_sibling");
    await t.run(async (ctx) => {
      await ctx.db.insert("wallets", {
        organizationId: orgId,
        balance: 1000,
        sequence: 1,
      });
    });
    await t.mutation(internal.keySettings.setDisabledVerified, {
      clerkOrgId: "org_acme",
      userId: "user_owner",
      keyId: KEY_A,
      disabled: true,
    });
    const view = await t.query(internal.wallets.getGatewayWallet, {
      clerkOrgId: "org_acme",
    });
    expect(new Set(view.keySettings.map((row) => row.keyId))).toEqual(
      new Set([KEY_A, KEY_B]),
    );
  });
});
