/// <reference types="vite/client" />
import {
  sha256Hex,
  signRegistryVerifiedKeyProjection,
  type RegistryVerifiedKeyProjection,
} from "@zevium/shared";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
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
