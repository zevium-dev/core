/// <reference types="vite/client" />
import {
  sha256Hex,
  signRegistryVerifiedKeyProjection,
  signRegistryVerifiedKeyRotationProjection,
  type RegistryVerifiedKeyRotationProjection,
  type RegistryVerifiedKeyProjection,
} from "@zevium/shared";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const projectionSecret = "projection-secret-012345678901234567890123";
process.env.REGISTRY_KEY_PROJECTION_HMAC_SECRET = projectionSecret;

function identity(orgId = "org_keys", userId = "user_keys") {
  return convexTest(schema, modules).withIdentity({
    subject: userId,
    org_id: orgId,
    org_slug: "keys",
    org_role: "org:admin",
  } as { subject: string; org_id: string; org_slug: string; org_role: string });
}

async function projection(): Promise<RegistryVerifiedKeyProjection> {
  return {
    schemaVersion: 1,
    verifiedAt: Date.now(),
    provision: {
      secretSha256: await sha256Hex("raw-secret-never-persisted"),
      clerkKeyId: "ck_keys",
      clerkOrgId: "org_keys",
      ownerUserId: "user_keys",
      subjectUserId: "user_keys",
      budgetId: "budget_keys",
      budgetRevision: 1,
      lifecycle: "active",
      monthlyCapCredits: null,
      graceUntil: null,
      expiresAt: null,
      scopes: ["gateway:execute"],
    },
  };
}

describe("canonical key projection producers", () => {
  it("persists verified owner, subject, budget, and hash only", async () => {
    const t = identity();
    await t.mutation(api.organizations.ensureOrganization, {
      clerkOrgId: "org_keys",
    });
    const value = await projection();
    const result = await t.mutation(api.keySettings.registerVerified, {
      projection: value,
      signature: await signRegistryVerifiedKeyProjection(
        projectionSecret,
        value,
      ),
    });
    expect(result).toMatchObject({ keyId: "ck_keys", budgetId: "budget_keys" });
    const rows = await t.run(async (ctx) => ({
      keys: await ctx.db.query("keySettings").collect(),
      events: await ctx.db.query("registryOutbox").collect(),
    }));
    expect(rows.keys[0]).toMatchObject({
      secretSha256: value.provision.secretSha256,
      subjectUserId: "user_keys",
      budgetId: "budget_keys",
    });
    expect(JSON.stringify(rows)).not.toContain("raw-secret-never-persisted");
    expect(
      rows.events.find((event) => event.operation === "key.put")?.operation,
    ).toBe("key.put");
  });

  it("rejects forged projection identity and budget substitution", async () => {
    const t = identity();
    await t.mutation(api.organizations.ensureOrganization, {
      clerkOrgId: "org_keys",
    });
    const value = await projection();
    const forgedOwner = {
      ...value,
      provision: { ...value.provision, ownerUserId: "user_attacker" },
    };
    await expect(
      signRegistryVerifiedKeyProjection(projectionSecret, forgedOwner),
    ).rejects.toThrow("ownership");
    const forgedBudget = {
      ...value,
      provision: { ...value.provision, budgetId: "org_keys" },
    };
    await expect(
      signRegistryVerifiedKeyProjection(projectionSecret, forgedBudget),
    ).rejects.toThrow("budget");
  });
});

function asMember(
  t: ReturnType<typeof convexTest>,
  userId = "user_keys",
  orgId = "org_keys",
  role = "org:member",
) {
  return t.withIdentity({ subject: userId, org_id: orgId, org_role: role });
}

async function register(
  t: ReturnType<typeof convexTest>,
  keyId = "ck_keys",
  owner = "user_keys",
) {
  const value = await projection();
  value.provision.clerkKeyId = keyId;
  value.provision.secretSha256 = await sha256Hex(`secret_${keyId}`);
  value.provision.ownerUserId = owner;
  value.provision.subjectUserId = owner;
  value.provision.budgetId = `budget_${keyId}`;
  const args = {
    projection: value,
    keyName: "Member key",
    signature: await signRegistryVerifiedKeyProjection(projectionSecret, value),
  };
  return {
    value,
    args,
    result: await asMember(t, owner).mutation(
      api.keySettings.registerVerified,
      args,
    ),
  };
}

async function setup() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("organizations", {
      clerkOrgId: "org_keys",
      name: "Keys",
      slug: "keys",
    });
    await ctx.db.insert("organizations", {
      clerkOrgId: "org_other",
      name: "Other",
      slug: "other",
    });
  });
  return t;
}

describe("key ownership and lifecycle authorization", () => {
  it("binds attribution to verified JWT owner and active org without creating unknown rows", async () => {
    const t = await setup();
    await register(t);
    const owner = asMember(t);
    expect(
      await owner.mutation(api.keySettings.registerOwnedKey, {
        keyId: "ck_keys",
        keyName: "Renamed",
      }),
    ).toMatchObject({ ownerUserId: "user_keys", keyName: "Renamed" });
    for (const caller of [
      asMember(t, "user_attacker"),
      asMember(t, "user_keys", "org_other"),
      asMember(t, "user_admin", "org_keys", "org:admin"),
    ]) {
      await expect(
        caller.mutation(api.keySettings.registerOwnedKey, {
          keyId: "ck_keys",
          keyName: "Stolen",
        }),
      ).rejects.toThrow("Verified key not found");
    }
    await expect(
      owner.mutation(api.keySettings.registerOwnedKey, {
        keyId: "unknown",
        keyName: "Forged",
      }),
    ).rejects.toThrow("Verified key not found");
    const rows = await t.run((ctx) => ctx.db.query("keySettings").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerUserId: "user_keys",
      keyName: "Renamed",
    });
  });

  it("rejects signed registration for a different JWT owner or organization", async () => {
    const t = await setup();
    const value = await projection();
    const args = {
      projection: value,
      signature: await signRegistryVerifiedKeyProjection(
        projectionSecret,
        value,
      ),
    };
    for (const caller of [
      asMember(t, "user_attacker"),
      asMember(t, "user_keys", "org_other"),
    ]) {
      await expect(
        caller.mutation(api.keySettings.registerVerified, args),
      ).rejects.toThrow("does not match identity");
    }
    expect(await t.run((ctx) => ctx.db.query("keySettings").collect())).toEqual(
      [],
    );
  });

  it("keeps failed rotation IDs terminal and expires grace into a durable revoke", async () => {
    const t = await setup();
    await register(t);
    const member = asMember(t);
    const args = { oldKeyId: "ck_keys", operationId: "failed-operation" };
    await member.mutation(api.keySettings.beginRotation, args);
    const failed = await member.mutation(api.keySettings.failRotation, {
      operationId: args.operationId,
      message: "Provider unavailable",
    });
    expect(
      await member.mutation(api.keySettings.failRotation, {
        operationId: args.operationId,
        message: "Repeated failure",
      }),
    ).toEqual(failed);
    expect(await member.mutation(api.keySettings.beginRotation, args)).toEqual(
      failed,
    );
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("keySettings")
        .withIndex("by_key", (q) => q.eq("keyId", "ck_keys"))
        .unique();
      await ctx.db.patch(row!._id, {
        lifecycle: "grace",
        graceUntil: Date.now() - 1,
      });
    });
    await t.mutation(internal.keySettings.expireGrace, { keyId: "ck_keys" });
    await t.mutation(internal.keySettings.expireGrace, { keyId: "ck_keys" });
    const rows = await t.run((ctx) => ctx.db.query("keySettings").collect());
    expect(rows[0]).toMatchObject({ lifecycle: "revoked", disabled: true });
  });

  it("allows member self-disable and self-revoke, preserves terminal revocation and admin-only caps", async () => {
    const t = await setup();
    await register(t);
    const member = asMember(t);
    expect(
      await member.mutation(api.keySettings.setDisabled, {
        keyId: "ck_keys",
        disabled: true,
      }),
    ).toMatchObject({ disabled: true });
    expect(
      await member.mutation(api.keySettings.setDisabled, {
        keyId: "ck_keys",
        disabled: false,
      }),
    ).toMatchObject({ disabled: false });
    await expect(
      member.mutation(api.keySettings.setCap, {
        keyId: "ck_keys",
        monthlyCapCredits: 50,
      }),
    ).rejects.toThrow("Org admin or owner role required");
    await member.mutation(api.keySettings.revokePrevious, { keyId: "ck_keys" });
    await member.mutation(api.keySettings.revokePrevious, { keyId: "ck_keys" });
    await expect(
      member.mutation(api.keySettings.setDisabled, {
        keyId: "ck_keys",
        disabled: false,
      }),
    ).rejects.toThrow("This key is no longer active");
    const events = await t.run((ctx) =>
      ctx.db.query("registryOutbox").collect(),
    );
    expect(events.filter((e) => e.operation === "key.revoke")).toHaveLength(1);
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled.some((job) => job.name.includes("revokeWithRetry"))).toBe(
      true,
    );
  });

  it.each(["org:admin", "org:owner"])(
    "lets %s manage another member's key",
    async (role) => {
      const t = await setup();
      await register(t);
      const admin = asMember(t, "user_admin", "org_keys", role);
      await admin.mutation(api.keySettings.setCap, {
        keyId: "ck_keys",
        monthlyCapCredits: 100,
      });
      await admin.mutation(api.keySettings.setDisabled, {
        keyId: "ck_keys",
        disabled: true,
      });
      expect(
        await admin.mutation(api.keySettings.revokePrevious, {
          keyId: "ck_keys",
        }),
      ).toMatchObject({ ownerUserId: "user_keys", lifecycle: "revoked" });
    },
  );

  it("rejects peer and cross-org controls without emitting revoke events", async () => {
    const t = await setup();
    await register(t);
    for (const caller of [
      asMember(t, "user_peer"),
      asMember(t, "user_keys", "org_other", "org:owner"),
    ]) {
      await expect(
        caller.mutation(api.keySettings.revokePrevious, { keyId: "ck_keys" }),
      ).rejects.toThrow("Verified key not found");
      await expect(
        caller.mutation(api.keySettings.setDisabled, {
          keyId: "ck_keys",
          disabled: true,
        }),
      ).rejects.toThrow("Verified key not found");
      await expect(
        caller.mutation(api.keySettings.beginRotation, {
          oldKeyId: "ck_keys",
          operationId: "peer-rotation",
        }),
      ).rejects.toThrow("Verified key not found");
    }
    const events = await t.run((ctx) =>
      ctx.db.query("registryOutbox").collect(),
    );
    expect(events.filter((e) => e.operation === "key.revoke")).toHaveLength(0);
  });

  it("lists only own metadata for members, all org keys for admins, and no raw secrets/hashes", async () => {
    const t = await setup();
    await register(t);
    await register(t, "ck_peer", "user_peer");
    const own = await asMember(t).query(api.keySettings.listKeys, {});
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({
      id: "ck_keys",
      name: "Member key",
      ownerUserId: "user_keys",
    });
    expect(JSON.stringify(own)).not.toContain("secretSha256");
    for (const role of ["org:admin", "org:owner"]) {
      expect(
        await asMember(t, "user_admin", "org_keys", role).query(
          api.keySettings.listKeys,
          {},
        ),
      ).toHaveLength(2);
    }
    expect(
      await asMember(t, "user_keys", "org_other").query(
        api.keySettings.listKeys,
        {},
      ),
    ).toEqual([]);
    expect(await asMember(t).query(api.keySettings.getForOrg, {})).toHaveLength(
      1,
    );
  });

  it("atomically admits one concurrent registration and allows idempotent replay", async () => {
    const t = await setup();
    const outcomes = await Promise.allSettled([
      register(t, "ck_first"),
      register(t, "ck_second"),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
    const winner = outcomes.find((r) => r.status === "fulfilled");
    if (winner?.status !== "fulfilled")
      throw new Error("Expected one registered key");
    await asMember(t).mutation(
      api.keySettings.registerVerified,
      winner.value.args,
    );
    await asMember(t).mutation(api.keySettings.setDisabled, {
      keyId: winner.value.result.keyId,
      disabled: true,
    });
    await expect(register(t, "ck_third")).rejects.toThrow(
      "You already have a key",
    );
    expect(
      await t.run((ctx) => ctx.db.query("keySettings").collect()),
    ).toHaveLength(1);
    await asMember(t).mutation(api.keySettings.revokePrevious, {
      keyId: winner.value.result.keyId,
    });
    expect((await register(t, "ck_after_revoke")).result.keyId).toBe(
      "ck_after_revoke",
    );
  });

  it.each(["org:member", "org:admin", "org:owner"])(
    "preserves rotation identity, idempotency and 24h grace for %s",
    async (role) => {
      const t = await setup();
      const original = await register(t);
      const caller = asMember(
        t,
        role === "org:member" ? "user_keys" : "user_admin",
        "org_keys",
        role,
      );
      const begin = { oldKeyId: "ck_keys", operationId: "rotation-operation" };
      const first = await caller.mutation(api.keySettings.beginRotation, begin);
      expect(
        await caller.mutation(api.keySettings.beginRotation, begin),
      ).toEqual(first);
      const verifiedAt = Date.now();
      const value: RegistryVerifiedKeyRotationProjection = {
        schemaVersion: 1,
        verifiedAt,
        operationId: begin.operationId,
        oldKeyId: begin.oldKeyId,
        graceUntil: verifiedAt + 24 * 60 * 60 * 1000,
        newProvision: {
          ...original.value.provision,
          clerkKeyId: "ck_rotated",
          secretSha256: await sha256Hex("replacement-secret"),
          budgetRevision: 2,
        },
      };
      const args = {
        projection: value,
        keyName: "Replacement",
        signature: await signRegistryVerifiedKeyRotationProjection(
          projectionSecret,
          value,
        ),
      };
      const completed = await caller.mutation(
        api.keySettings.completeRotation,
        args,
      );
      expect(
        await caller.mutation(api.keySettings.completeRotation, args),
      ).toEqual(completed);
      expect(
        await caller.mutation(api.keySettings.failRotation, {
          operationId: begin.operationId,
          message: "late failure",
        }),
      ).toEqual(completed);
      const rows = await asMember(t).query(api.keySettings.listKeys, {});
      expect(rows.find((r) => r.id === "ck_keys")).toMatchObject({
        lifecycle: "grace",
        graceUntil: value.graceUntil,
        current: false,
      });
      expect(rows.find((r) => r.id === "ck_rotated")).toMatchObject({
        ownerUserId: "user_keys",
        keyFamilyId: "ck_keys",
        current: true,
      });
      await expect(register(t, "ck_extra")).rejects.toThrow(
        "You already have a key",
      );
    },
  );
});

async function seedWorld(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_acme",
      name: "Acme",
      slug: "acme",
    });
    const strangerOrgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_other",
      name: "Other",
      slug: "other",
    });
    return { orgId, strangerOrgId };
  });
}

const KEY_A = "key_live_AAAA";
const KEY_B = "key_live_BBBB";

describe("wallets.getGatewayWallet — checkpoint and keySettings", () => {
  it("returns the wallet checkpoint alongside keySettings", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);

    // Wallet + grant + two key settings.
    await t.run(async (ctx) => {
      const walletId = await ctx.db.insert("wallets", {
        organizationId: seed.orgId,
        balance: 1000,
        sequence: 1,
      });
      await ctx.db.insert("walletEntries", {
        walletId,
        kind: "payment_grant",
        amount: 1000,
        refId: "grant-1",
        sequence: 1,
        createdAt: 1,
      });
      await ctx.db.insert("walletFundingStates", {
        walletId,
        organizationId: seed.orgId,
        nonrefundableAvailableCredits: 1_000,
        refundableAvailableCredits: 0,
        allocatedCredits: 0,
        reversedCredits: 0,
        sequence: 1,
        migrationWatermarkSequence: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("keySettings", {
        clerkOrgId: "org_acme",
        keyId: KEY_A,
        disabled: true,
        monthlyCapCredits: 250,
        updatedAt: 3,
      });
      await ctx.db.insert("keySettings", {
        clerkOrgId: "org_acme",
        keyId: KEY_B,
        disabled: false,
        updatedAt: 4,
      });
    });

    const view = await t.query(internal.wallets.getGatewayWallet, {
      clerkOrgId: "org_acme",
    });
    expect(view.wallet).toEqual({
      clerkOrgId: "org_acme",
      balance: 1000,
      sequence: 1,
    });
    expect(view.keySettings).toHaveLength(2);
    const byId = new Map(view.keySettings.map((r) => [r.keyId, r]));
    expect(byId.get(KEY_A)!.disabled).toBe(true);
    expect(byId.get(KEY_A)!.monthlyCapCredits).toBe(250);
    expect(byId.get(KEY_B)!.disabled).toBe(false);
    expect(byId.get(KEY_B)!.monthlyCapCredits).toBeUndefined();
  });

  it("returns a zero checkpoint when wallet is missing", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);

    const view = await t.query(internal.wallets.getGatewayWallet, {
      clerkOrgId: "org_acme",
    });
    expect(view.keySettings).toEqual([]);
    expect(view.wallet).toEqual({
      clerkOrgId: "org_acme",
      balance: 0,
      sequence: 0,
    });
  });
});
