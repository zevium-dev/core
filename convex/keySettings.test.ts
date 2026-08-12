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

function asAdmin(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "user_admin",
    org_id: "org_acme",
    org_role: "org:admin",
  } as { subject: string });
}

async function register(
  t: ReturnType<typeof convexTest>,
  keyId = KEY_A,
  userId = "user_owner",
) {
  return await t.run(async (ctx) => {
    const id = await ctx.db.insert("keySettings", {
      clerkOrgId: "org_acme",
      ownerUserId: userId,
      keyId,
      managed: true,
      familyId: keyId,
      disabled: false,
      updatedAt: Date.now(),
    });
    return await ctx.db.get(id);
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

  it("gives exact org admins opaque attribution and policy controls", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    await register(t, KEY_A, "user_owner");
    await register(t, KEY_B, "user_sibling");

    const policies = await asAdmin(t).query(api.keySettings.listOrgPolicy, {});
    expect(policies).toHaveLength(2);
    expect(policies.every((policy) => /^[0-9a-f]{32}$/.test(policy.policyId))).toBe(
      true,
    );
    expect(policies.every((policy) => /^[0-9a-f]{32}$/.test(policy.ownerRef))).toBe(
      true,
    );
    expect(JSON.stringify(policies)).not.toContain(KEY_A);
    expect(JSON.stringify(policies)).not.toContain(KEY_B);
    expect(policies.every((policy) => !Reflect.has(policy, "_id"))).toBe(true);

    const selected = policies.find((policy) => policy.keyLabel === "••••AAAA");
    if (selected === undefined) throw new Error("Missing key policy");
    const updated = await asAdmin(t).mutation(api.keySettings.setOrgPolicy, {
      policyId: selected.policyId,
      monthlyCapCredits: 250,
      disabled: true,
    });
    expect(updated).toMatchObject({
      policyId: selected.policyId,
      monthlyCapCredits: 250,
      disabled: true,
      lifecycle: "disabled",
    });
    await expect(
      asUser(t).mutation(api.keySettings.setOrgPolicy, {
        policyId: selected.policyId,
        disabled: false,
      }),
    ).rejects.toThrow("Org admin role required");
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
  it("stays fail-closed after an ambiguous external revoke failure", async () => {
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
    ).toBe(true);
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
      requestedName: "replacement",
      membershipVerifiedAt: Date.now(),
      leaseToken: "rotation-lease-race",
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

  it("binds create completion to exact immutable key and lease", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const scope = {
      clerkOrgId: "org_acme",
      userId: "user_owner",
      operationId: "create-binding-operation",
      requestedName: "Bound",
      membershipVerifiedAt: Date.now(),
      leaseToken: "create-binding-lease",
    };
    await t.mutation(internal.keySettings.beginCreateVerified, scope);
    await t.mutation(internal.keySettings.completeCreateVerified, {
      clerkOrgId: scope.clerkOrgId,
      userId: scope.userId,
      operationId: scope.operationId,
      leaseToken: scope.leaseToken,
      keyId: KEY_A,
    });
    await expect(
      t.mutation(internal.keySettings.completeCreateVerified, {
        clerkOrgId: scope.clerkOrgId,
        userId: scope.userId,
        operationId: scope.operationId,
        leaseToken: scope.leaseToken,
        keyId: KEY_B,
      }),
    ).rejects.toThrow("binding does not match");
    await expect(
      t.mutation(internal.keySettings.beginCreateVerified, {
        ...scope,
        requestedName: "Different",
      }),
    ).rejects.toThrow("binding does not match");
  });

  it("derives rotation grace and rejects forged completion bindings", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    await register(t);
    await t.mutation(internal.keySettings.setCapVerified, {
      clerkOrgId: "org_acme",
      userId: "user_owner",
      keyId: KEY_A,
      monthlyCapCredits: 42,
    });
    const scope = {
      clerkOrgId: "org_acme",
      userId: "user_owner",
      operationId: "rotation-binding-operation",
      oldKeyId: KEY_A,
      requestedName: "Replacement",
      membershipVerifiedAt: Date.now(),
      leaseToken: "rotation-binding-lease",
    };
    await t.mutation(internal.keySettings.beginRotationVerified, scope);
    await expect(
      t.mutation(internal.keySettings.completeRotationVerified, {
        clerkOrgId: scope.clerkOrgId,
        userId: scope.userId,
        operationId: scope.operationId,
        oldKeyId: KEY_A,
        newKeyId: KEY_A,
        leaseToken: scope.leaseToken,
      }),
    ).rejects.toThrow("must differ");
    const before = Date.now();
    const completed = await t.mutation(
      internal.keySettings.completeRotationVerified,
      {
        clerkOrgId: scope.clerkOrgId,
        userId: scope.userId,
        operationId: scope.operationId,
        oldKeyId: KEY_A,
        newKeyId: KEY_B,
        leaseToken: scope.leaseToken,
      },
    );
    expect(completed?.graceUntil).toBeGreaterThanOrEqual(
      before + 24 * 60 * 60_000,
    );
    await expect(
      t.mutation(internal.keySettings.completeRotationVerified, {
        clerkOrgId: scope.clerkOrgId,
        userId: scope.userId,
        operationId: scope.operationId,
        oldKeyId: KEY_A,
        newKeyId: "key_forged_CCCC",
        leaseToken: scope.leaseToken,
      }),
    ).rejects.toThrow("binding does not match");
    const rows = await asUser(t).query(api.keySettings.getForOrg, {});
    expect(rows.every((row) => row.familyId === KEY_A)).toBe(true);
    expect(rows.every((row) => row.monthlyCapCredits === 42)).toBe(true);
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

  it("projects legacy-unmanaged and retiring-org keys disabled", async () => {
    const t = convexTest(schema, modules);
    const orgId = await seedWorld(t);
    await register(t, KEY_A);
    await t.run(async (ctx) => {
      await ctx.db.insert("keySettings", {
        clerkOrgId: "org_acme",
        ownerUserId: "user_owner",
        keyId: "key_legacy_unknown",
        disabled: false,
        updatedAt: Date.now(),
      });
    });
    const initial = await t.query(internal.wallets.getGatewayWallet, {
      clerkOrgId: "org_acme",
    });
    expect(
      initial.keySettings.find((row) => row.keyId === "key_legacy_unknown"),
    ).toMatchObject({ disabled: true });
    expect(
      initial.keySettings.find((row) => row.keyId === KEY_A),
    ).toMatchObject({ disabled: false });

    await t.run(async (ctx) => {
      await ctx.db.patch(orgId, { retiringAt: Date.now() });
    });
    const retired = await t.query(internal.wallets.getGatewayWallet, {
      clerkOrgId: "org_acme",
    });
    expect(retired.keySettings.every((row) => row.disabled)).toBe(true);
  });
});
