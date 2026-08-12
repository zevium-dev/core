/// <reference types="vite/client" />
import {
  sha256Hex,
  signRegistryVerifiedKeyProjection,
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

function asOrgMember(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "user_member",
    org_id: "org_member",
    org_slug: "member-co",
    org_role: "org:member",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

describe("keySettings role gates and attribution", () => {
  async function seedMemberOrg(t: ReturnType<typeof convexTest>) {
    await t.run(async (ctx) => {
      await ctx.db.insert("organizations", {
        clerkOrgId: "org_member",
        name: "Member Co",
        slug: "member-co",
      });
    });
  }

  it("rejects cap, status, and rotation control for an ordinary member", async () => {
    const t = convexTest(schema, modules);
    await seedMemberOrg(t);
    const member = asOrgMember(t);
    await expect(
      member.mutation(api.keySettings.setCap, {
        keyId: "key_live_member",
        monthlyCapCredits: 500,
      }),
    ).rejects.toThrow(/Org admin or owner role required/);
    await expect(
      member.mutation(api.keySettings.setDisabled, {
        keyId: "key_live_member",
        disabled: true,
      }),
    ).rejects.toThrow(/Org admin or owner role required/);
    await expect(
      member.mutation(api.keySettings.beginRotation, {
        operationId: "blocked-rotation",
        oldKeyId: "key_live_member",
      }),
    ).rejects.toThrow(/Org admin or owner role required/);
  });

  it("records key name and owner from the authenticated identity", async () => {
    const t = convexTest(schema, modules);
    await seedMemberOrg(t);
    const view = await asOrgMember(t).mutation(
      api.keySettings.registerOwnedKey,
      { keyId: "key_live_member", keyName: "Local dev" },
    );
    expect(view).toMatchObject({
      keyId: "key_live_member",
      keyName: "Local dev",
      ownerUserId: "user_member",
      disabled: false,
    });
  });
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
        migrationStatus: "verified",
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
