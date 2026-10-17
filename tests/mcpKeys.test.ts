import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sha256Hex,
  signRegistryVerifiedKeyProjection,
  type RegistryVerifiedKeyProjection,
} from "@zevium/shared";
import { harness, seed, identity, keySecret, type Harness } from "./helpers";
import { SECRET } from "./fixtures";
import { api, internal } from "../convex/_generated/api";

const clerk = vi.hoisted(() => ({
  created: 0,
  role: "org:member" as string | null,
  apiKeys: {
    create: vi.fn(),
    revoke: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({ revoked: false }),
  },
  organizations: { getOrganizationMembershipList: vi.fn() },
}));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({
    apiKeys: clerk.apiKeys,
    organizations: clerk.organizations,
  }),
}));

const who = { userId: "user_one", orgId: "org_one" };
const identityRequest = (t: Harness) =>
  t
    .fetch("/mcp-identity", {
      method: "POST",
      headers: {
        "x-internal-secret": SECRET,
        "content-type": "application/json",
      },
      body: JSON.stringify(who),
    })
    .then((res) => res.json() as Promise<unknown>);
const settle = (t: Harness) =>
  t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimersAsync());
const keys = (t: Harness) =>
  t.run(async (ctx) =>
    (await ctx.db.query("apiKeys").collect()).filter((r) => r.kind === "key"),
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubEnv("GATEWAY_INTERNAL_SECRET", SECRET);
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test_fixture");
  vi.stubEnv("REGISTRY_KEY_PROJECTION_HMAC_SECRET", keySecret);
  clerk.created = 0;
  clerk.role = "org:member";
  clerk.apiKeys.create.mockImplementation(
    async (params: { name: string; subject: string }) => {
      clerk.created += 1;
      return {
        id: `ak_mcp_${clerk.created}`,
        name: params.name,
        secret: `ak_secret_${clerk.created}_${"x".repeat(24)}`,
      };
    },
  );
  clerk.organizations.getOrganizationMembershipList.mockImplementation(
    async () => ({
      data: clerk.role
        ? [{ role: clerk.role, publicUserData: { userId: who.userId } }]
        : [],
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("MCP key auto-creation on first OAuth connect", () => {
  it("creates one hash-only member key and resolves it on the next refresh", async () => {
    const t = harness();
    await seed(t);
    expect(await identityRequest(t)).toEqual({
      orgId: "org_one",
      keyId: null,
      provisioning: true,
    });
    // Concurrent connects before the action runs share the one claim.
    expect(await identityRequest(t)).toMatchObject({ provisioning: true });
    expect(await t.mutation(internal.mcpKeys.request, who)).toBe(true);
    await settle(t);
    expect(clerk.apiKeys.create).toHaveBeenCalledTimes(1);
    expect(clerk.apiKeys.create).toHaveBeenCalledWith({
      name: "MCP (auto-created)",
      subject: "user_one",
      createdBy: "user_one",
      claims: { org_id: "org_one" },
    });
    expect(clerk.apiKeys.revoke).not.toHaveBeenCalled();
    const [key, ...rest] = await keys(t);
    expect(rest).toEqual([]);
    expect(key).toMatchObject({
      keyId: "ak_mcp_1",
      keyName: "MCP (auto-created)",
      ownerUserId: "user_one",
      lifecycle: "active",
      scopes: ["gateway:execute"],
      secretSha256: await sha256Hex(`ak_secret_1_${"x".repeat(24)}`),
    });
    expect(key).not.toHaveProperty("monthlyCapCredits");
    expect(JSON.stringify(key)).not.toContain("ak_secret_1");
    expect(await identityRequest(t)).toEqual({
      orgId: "org_one",
      keyId: "ak_mcp_1",
    });
    // Visible and manageable on the keys page like any member key.
    const member = t.withIdentity(identity("one", "user_one", "org:member"));
    expect(await member.query(api.keySettings.listKeys, {})).toEqual([
      expect.objectContaining({ id: "ak_mcp_1", name: "MCP (auto-created)" }),
    ]);
  });

  it("never recreates a key the member revoked or disabled", async () => {
    const t = harness();
    await seed(t);
    await identityRequest(t);
    await settle(t);
    const member = t.withIdentity(identity("one", "user_one", "org:member"));
    await member.mutation(api.keySettings.setDisabled, {
      keyId: "ak_mcp_1",
      disabled: true,
    });
    expect(await identityRequest(t)).toEqual({
      orgId: "org_one",
      keyId: null,
      provisioning: false,
    });
    await member.mutation(api.keySettings.revokePrevious, {
      keyId: "ak_mcp_1",
    });
    vi.advanceTimersByTime(7_200_000);
    expect(await identityRequest(t)).toMatchObject({ provisioning: false });
    await settle(t);
    expect(clerk.apiKeys.create).toHaveBeenCalledTimes(1);
  });

  it("does not auto-create beside an existing key, even a disabled one", async () => {
    const t = harness();
    await seed(t);
    const user = t.withIdentity(identity());
    const projection: RegistryVerifiedKeyProjection = {
      schemaVersion: 1,
      verifiedAt: Date.now(),
      provision: {
        clerkKeyId: "key_manual",
        clerkOrgId: "org_one",
        ownerUserId: "user_one",
        subjectUserId: "user_one",
        secretSha256: "a".repeat(64),
        budgetId: "budget_manual",
        budgetRevision: 1,
        lifecycle: "active",
        monthlyCapCredits: null,
        graceUntil: null,
        expiresAt: null,
        scopes: ["gateway:execute"],
      },
    };
    await user.mutation(api.keySettings.registerVerified, {
      projection,
      signature: await signRegistryVerifiedKeyProjection(keySecret, projection),
    });
    await user.mutation(api.keySettings.setDisabled, {
      keyId: "key_manual",
      disabled: true,
    });
    expect(await identityRequest(t)).toEqual({
      orgId: "org_one",
      keyId: null,
      provisioning: false,
    });
    await settle(t);
    expect(clerk.apiKeys.create).not.toHaveBeenCalled();
  });

  it("falls back to keyless when Clerk denies membership, then backs off", async () => {
    const t = harness();
    await seed(t);
    clerk.role = null;
    expect(await identityRequest(t)).toMatchObject({ provisioning: true });
    await settle(t);
    expect(clerk.apiKeys.create).not.toHaveBeenCalled();
    expect(await identityRequest(t)).toMatchObject({
      keyId: null,
      provisioning: false,
    });
    clerk.role = "org:admin";
    vi.advanceTimersByTime(61_000);
    expect(await identityRequest(t)).toMatchObject({ provisioning: true });
    await settle(t);
    expect(await identityRequest(t)).toMatchObject({ keyId: "ak_mcp_1" });
  });

  it("revokes the provider key when the member's slot filled during creation", async () => {
    const t = harness();
    await seed(t);
    expect(await t.mutation(internal.mcpKeys.request, who)).toBe(true);
    clerk.apiKeys.create.mockImplementationOnce(async () => {
      // A web-created key lands between the claim and registration.
      await t.run(async (ctx) => {
        const org = (await ctx.db.query("organizations").first())!;
        await ctx.db.insert("apiKeys", {
          kind: "key",
          organizationId: org._id,
          clerkOrgId: "org_one",
          keyId: "key_web",
          keyName: "Web",
          ownerUserId: "user_one",
          subjectUserId: "user_one",
          secretSha256: "b".repeat(64),
          verifiedProjectionHash: "c".repeat(64),
          verifiedAt: Date.now(),
          keyFamilyId: "key_web",
          budgetId: "budget_web",
          budgetRevision: 1,
          scopes: ["gateway:execute"],
          lifecycle: "active",
          edgeRevision: 1,
          updatedAt: Date.now(),
        });
      });
      return {
        id: "ak_mcp_lost",
        name: "MCP (auto-created)",
        secret: "s".repeat(32),
      };
    });
    await settle(t);
    expect(clerk.apiKeys.revoke).toHaveBeenCalledWith({
      apiKeyId: "ak_mcp_lost",
      revocationReason: "Zevium MCP key auto-creation failed",
    });
    expect((await keys(t)).map((k) => k.keyId)).toEqual(["key_web"]);
    expect(await identityRequest(t)).toEqual({
      orgId: "org_one",
      keyId: "key_web",
    });
  });

  it("ignores unknown or inactive organizations", async () => {
    const t = harness();
    await seed(t);
    expect(
      await t.mutation(internal.mcpKeys.request, {
        userId: "user_one",
        orgId: "org_missing",
      }),
    ).toBe(false);
    await settle(t);
    expect(
      clerk.organizations.getOrganizationMembershipList,
    ).not.toHaveBeenCalled();
  });
});
