/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type Seeded = {
  orgId: Id<"organizations">;
  strangerOrgId: Id<"organizations">;
};

async function seedWorld(t: ReturnType<typeof convexTest>): Promise<Seeded> {
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

function asMember(
  t: ReturnType<typeof convexTest>,
  clerkOrgId = "org_acme",
  slug = "acme",
  subject = "user_member",
) {
  return t.withIdentity({
    subject,
    org_id: clerkOrgId,
    org_slug: slug,
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
    org_id: "org_other",
    org_slug: "other",
    org_role: "org:member",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

function asNoOrg(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "user_noorg",
  } as {
    subject: string;
    org_id?: string;
    org_slug?: string;
    org_role?: string;
  });
}

const KEY_A = "key_live_AAAA";
const KEY_B = "key_live_BBBB";

describe("keySettings.getForOrg — auth", () => {
  it("rejects unauthenticated", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    await expect(t.query(api.keySettings.getForOrg, {})).rejects.toThrow(
      /Not authenticated/,
    );
  });

  it("rejects when no active org claim", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    await expect(
      asNoOrg(t).query(api.keySettings.getForOrg, {}),
    ).rejects.toThrow(/Select an organization/);
  });

  it("returns only the active org's rows", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("keySettings", {
        clerkOrgId: "org_acme",
        keyId: KEY_A,
        disabled: false,
        updatedAt: 1,
      });
      await ctx.db.insert("keySettings", {
        clerkOrgId: "org_other",
        keyId: KEY_B,
        disabled: true,
        updatedAt: 2,
      });
    });
    expect(seed.strangerOrgId).toBeDefined();

    const rows = await asMember(t).query(api.keySettings.getForOrg, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.keyId).toBe(KEY_A);
  });
});

describe("keySettings.setCap — upsert + validation", () => {
  it("creates a row with the cap when none exists", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);

    const view = await asMember(t).mutation(api.keySettings.setCap, {
      keyId: KEY_A,
      monthlyCapCredits: 500,
    });
    expect(view.monthlyCapCredits).toBe(500);
    expect(view.disabled).toBe(false);
    expect(view.keyId).toBe(KEY_A);

    const rows = await asMember(t).query(api.keySettings.getForOrg, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.monthlyCapCredits).toBe(500);
  });

  it("updates the cap on an existing row (upsert, same _id)", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const as = asMember(t);

    const v1 = await as.mutation(api.keySettings.setCap, {
      keyId: KEY_A,
      monthlyCapCredits: 100,
    });
    const v2 = await as.mutation(api.keySettings.setCap, {
      keyId: KEY_A,
      monthlyCapCredits: 200,
    });
    expect(v2._id).toBe(v1._id);
    expect(v2.monthlyCapCredits).toBe(200);
  });

  it("clears the cap with null (field removed → unlimited)", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const as = asMember(t);

    await as.mutation(api.keySettings.setCap, {
      keyId: KEY_A,
      monthlyCapCredits: 300,
    });
    const cleared = await as.mutation(api.keySettings.setCap, {
      keyId: KEY_A,
      monthlyCapCredits: null,
    });
    expect(cleared.monthlyCapCredits).toBeUndefined();

    const rows = await as.query(api.keySettings.getForOrg, {});
    expect(rows[0]!.monthlyCapCredits).toBeUndefined();
  });

  it("rejects non-positive and fractional caps", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const as = asMember(t);

    await expect(
      as.mutation(api.keySettings.setCap, {
        keyId: KEY_A,
        monthlyCapCredits: 0,
      }),
    ).rejects.toThrow(/positive whole number/);
    await expect(
      as.mutation(api.keySettings.setCap, {
        keyId: KEY_A,
        monthlyCapCredits: -5,
      }),
    ).rejects.toThrow(/positive whole number/);
    await expect(
      as.mutation(api.keySettings.setCap, {
        keyId: KEY_A,
        monthlyCapCredits: 1.5,
      }),
    ).rejects.toThrow(/positive whole number/);
  });

  it("rejects cross-org mutation of an existing row", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    await asMember(t).mutation(api.keySettings.setCap, {
      keyId: KEY_A,
      monthlyCapCredits: 10,
    });
    // Stranger shares KEY_A id but is in a different org.
    await expect(
      asStranger(t).mutation(api.keySettings.setCap, {
        keyId: KEY_A,
        monthlyCapCredits: 999,
      }),
    ).rejects.toThrow(/Key not found/);
  });
});

describe("keySettings.setDisabled — upsert", () => {
  it("disables a key, preserving an existing cap", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const as = asMember(t);

    await as.mutation(api.keySettings.setCap, {
      keyId: KEY_A,
      monthlyCapCredits: 100,
    });
    const disabled = await as.mutation(api.keySettings.setDisabled, {
      keyId: KEY_A,
      disabled: true,
    });
    expect(disabled.disabled).toBe(true);
    expect(disabled.monthlyCapCredits).toBe(100);
    expect(disabled._id).toBe(
      (await as.query(api.keySettings.getForOrg, {}))[0]!._id,
    );
  });

  it("re-enables a key", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const as = asMember(t);

    await as.mutation(api.keySettings.setDisabled, {
      keyId: KEY_A,
      disabled: true,
    });
    const enabled = await as.mutation(api.keySettings.setDisabled, {
      keyId: KEY_A,
      disabled: false,
    });
    expect(enabled.disabled).toBe(false);
  });
});

describe("keySettings.recordRotation", () => {
  it("stamps graceUntil on old key and lineage on new key", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const as = asMember(t);

    const graceUntil = Date.now() + 24 * 60 * 60 * 1000;
    const result = await as.mutation(api.keySettings.recordRotation, {
      oldKeyId: KEY_A,
      newKeyId: KEY_B,
      graceUntil,
    });
    expect(result.oldKey.graceUntil).toBe(graceUntil);
    expect(result.newKey.rotatedFromKeyId).toBe(KEY_A);

    const rows = await as.query(api.keySettings.getForOrg, {});
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.keyId, r]));
    expect(byId.get(KEY_A)!.graceUntil).toBe(graceUntil);
    expect(byId.get(KEY_B)!.rotatedFromKeyId).toBe(KEY_A);
  });

  it("rejects past graceUntil", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const as = asMember(t);

    await expect(
      as.mutation(api.keySettings.recordRotation, {
        oldKeyId: KEY_A,
        newKeyId: KEY_B,
        graceUntil: Date.now() - 1000,
      }),
    ).rejects.toThrow(/future timestamp/);
  });

  it("rejects identical old/new key ids", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const as = asMember(t);

    await expect(
      as.mutation(api.keySettings.recordRotation, {
        oldKeyId: KEY_A,
        newKeyId: KEY_A,
        graceUntil: Date.now() + 60_000,
      }),
    ).rejects.toThrow(/must differ/);
  });

  it("rejects cross-org", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    // Member pre-creates a row for KEY_A in org_acme.
    await asMember(t).mutation(api.keySettings.setDisabled, {
      keyId: KEY_A,
      disabled: false,
    });
    await expect(
      asStranger(t).mutation(api.keySettings.recordRotation, {
        oldKeyId: KEY_A,
        newKeyId: KEY_B,
        graceUntil: Date.now() + 60_000,
      }),
    ).rejects.toThrow(/Key not found/);
  });
});

describe("wallets.listGrantsForGateway — includes keySettings", () => {
  it("returns keySettings rows alongside grants", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);

    // Wallet + grant + two key settings.
    await t.run(async (ctx) => {
      const walletId = await ctx.db.insert("wallets", {
        organizationId: seed.orgId,
        balance: 1000,
      });
      await ctx.db.insert("walletEntries", {
        walletId,
        kind: "grant",
        amount: 1000,
        refId: "grant-1",
        createdAt: 1,
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

    const view = await t.query(internal.wallets.listGrantsForGateway, {
      clerkOrgId: "org_acme",
    });
    expect(view.balance).toBe(1000);
    expect(view.grants).toHaveLength(1);
    expect(view.grants[0]!.refId).toBe("grant-1");
    expect(view.keySettings).toHaveLength(2);
    const byId = new Map(view.keySettings.map((r) => [r.keyId, r]));
    expect(byId.get(KEY_A)!.disabled).toBe(true);
    expect(byId.get(KEY_A)!.monthlyCapCredits).toBe(250);
    expect(byId.get(KEY_B)!.disabled).toBe(false);
    expect(byId.get(KEY_B)!.monthlyCapCredits).toBeUndefined();
  });

  it("returns empty keySettings when wallet missing", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);

    const view = await t.query(internal.wallets.listGrantsForGateway, {
      clerkOrgId: "org_acme",
    });
    expect(view.grants).toEqual([]);
    expect(view.keySettings).toEqual([]);
    expect(view.balance).toBe(0);
  });
});
