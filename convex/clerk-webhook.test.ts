/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";
import { internal } from "./_generated/api";
import schema from "./schema";

vi.mock("./registrySync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./registrySync")>()),
  enqueueKeyState: vi.fn(async () => undefined),
}));

const modules = import.meta.glob("./**/*.ts");
const secret = "whsec_dGVzdC13ZWJob29rLXNlY3JldA==";

describe("Clerk webhook lifecycle", () => {
  const previousSecret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;

  beforeEach(() => {
    process.env.CLERK_WEBHOOK_SIGNING_SECRET = secret;
  });

  afterEach(() => {
    if (previousSecret === undefined) {
      delete process.env.CLERK_WEBHOOK_SIGNING_SECRET;
    } else {
      process.env.CLERK_WEBHOOK_SIGNING_SECRET = previousSecret;
    }
  });

  it("deletes mirrored personal data when Clerk deletes the user", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        clerkUserId: "user_deleted",
        name: "Deleted User",
        email: "deleted@example.com",
      });
    });

    const body = JSON.stringify({
      type: "user.deleted",
      data: { id: "user_deleted", deleted: true },
    });
    const messageId = "msg_user_deleted";
    const timestamp = new Date();
    const signature = new Webhook(secret).sign(messageId, timestamp, body);
    const response = await t.fetch("/clerk-webhook", {
      method: "POST",
      headers: {
        "svix-id": messageId,
        "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
        "svix-signature": signature,
      },
      body,
    });

    expect(response.status).toBe(200);
    const mirroredUser = await t.run(async (ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", "user_deleted"))
        .unique(),
    );
    expect(mirroredUser).toBeNull();
  });

  it("immediately disables removed-member keys and dedupes signed replay", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const keyId = await ctx.db.insert("keySettings", {
        clerkOrgId: "org_removed",
        ownerUserId: "user_removed",
        keyId: "key_removed_member",
        managed: true,
        familyId: "family_removed_member",
        disabled: false,
        graceUntil: Date.now() + 60_000,
        updatedAt: Date.now(),
      });
      const lifecycleId = await ctx.db.insert("keyLifecycleOperations", {
        clerkOrgId: "org_removed",
        userId: "user_removed",
        operationId: "create-removed-member",
        kind: "create",
        requestedName: "Race",
        leaseToken: "membership-race-lease",
        leaseExpiresAt: Date.now() + 60_000,
        status: "reserved",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const disabledKeyId = await ctx.db.insert("keySettings", {
        clerkOrgId: "org_removed",
        ownerUserId: "user_removed",
        keyId: "key_removed_member_disabled",
        managed: true,
        familyId: "family_removed_member_disabled",
        disabled: true,
        updatedAt: Date.now(),
      });
      return { keyId, disabledKeyId, lifecycleId };
    });
    const body = JSON.stringify({
      type: "organizationMembership.deleted",
      data: {
        organization: { id: "org_removed" },
        public_user_data: { user_id: "user_removed" },
      },
    });
    const messageId = "msg_membership_deleted";
    const timestamp = new Date();
    const headers = {
      "svix-id": messageId,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": new Webhook(secret).sign(messageId, timestamp, body),
    };

    const first = await t.fetch("/clerk-webhook", {
      method: "POST",
      headers,
      body,
    });
    const replay = await t.fetch("/clerk-webhook", {
      method: "POST",
      headers,
      body,
    });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);

    const projected = await t.run(async (ctx) => ({
      key: await ctx.db.get(ids.keyId),
      disabledKey: await ctx.db.get(ids.disabledKeyId),
      lifecycle: await ctx.db.get(ids.lifecycleId),
      receipts: await ctx.db.query("clerkWebhookReceipts").collect(),
    }));
    expect(projected.key).toMatchObject({
      disabled: true,
      membershipRevokedAt: expect.any(Number),
    });
    expect(projected.key?.graceUntil).toBeUndefined();
    expect(projected.disabledKey).toMatchObject({
      disabled: true,
      membershipRevokedAt: expect.any(Number),
    });
    expect(projected.lifecycle).toMatchObject({
      status: "failed",
      failure: "Organization membership deleted",
    });
    expect(projected.receipts).toHaveLength(1);
  });

  it("tombstones an organization before bounded resumable cleanup", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_retire_large",
        name: "Large retiring org",
        slug: "large-retiring-org",
        publicHandle: "large-retiring-org",
      });
      const walletId = await ctx.db.insert("wallets", {
        organizationId,
        balance: 121,
        sequence: 121,
      });
      for (let index = 0; index < 121; index += 1) {
        const userId = `user_retire_${String(index).padStart(3, "0")}`;
        await ctx.db.insert("keySettings", {
          clerkOrgId: "org_retire_large",
          ownerUserId: userId,
          keyId: `key_retire_${String(index).padStart(3, "0")}`,
          managed: true,
          familyId: `family_retire_${String(index).padStart(3, "0")}`,
          disabled: false,
          updatedAt: index + 1,
        });
        await ctx.db.insert("clerkMembershipStates", {
          clerkOrgId: "org_retire_large",
          userId,
          status: "active",
          revision: 0,
          updatedAt: index + 1,
        });
        await ctx.db.insert("walletEntries", {
          walletId,
          kind: "admin_adjustment",
          amount: 1,
          refId: `retire-entry-${index}`,
          sequence: index + 1,
          createdAt: index + 1,
        });
      }
      return { organizationId, walletId };
    });
    const body = JSON.stringify({
      type: "organization.deleted",
      data: { id: "org_retire_large", deleted: true },
    });
    const messageId = "msg_org_retire_large";
    const timestamp = new Date();
    const response = await t.fetch("/clerk-webhook", {
      method: "POST",
      headers: {
        "svix-id": messageId,
        "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
        "svix-signature": new Webhook(secret).sign(messageId, timestamp, body),
      },
      body,
    });
    expect(response.status).toBe(200);

    const jobId = await t.run(async (ctx) => {
      const org = await ctx.db.get(seeded.organizationId);
      expect(org?.retiringAt).toEqual(expect.any(Number));
      const job = await ctx.db
        .query("retirementJobs")
        .withIndex("by_resource", (q) =>
          q.eq("resourceKey", `organization:${seeded.organizationId}`),
        )
        .unique();
      if (job === null) throw new Error("Missing organization retirement job");
      return job._id;
    });
    await t.mutation(internal.retirementJobs.step, { jobId });
    await t.mutation(internal.retirementJobs.step, { jobId });
    const bounded = await t.run(async (ctx) =>
      ctx.db
        .query("keySettings")
        .withIndex("by_org", (q) => q.eq("clerkOrgId", "org_retire_large"))
        .collect(),
    );
    expect(bounded).toHaveLength(96);

    for (let step = 0; step < 25; step += 1) {
      await t.mutation(internal.retirementJobs.step, { jobId });
    }
    const retired = await t.run(async (ctx) => ({
      organization: await ctx.db.get(seeded.organizationId),
      wallet: await ctx.db.get(seeded.walletId),
      keys: await ctx.db
        .query("keySettings")
        .withIndex("by_org", (q) => q.eq("clerkOrgId", "org_retire_large"))
        .collect(),
      memberships: await ctx.db
        .query("clerkMembershipStates")
        .withIndex("by_membership", (q) =>
          q.eq("clerkOrgId", "org_retire_large"),
        )
        .collect(),
      job: await ctx.db.get(jobId),
    }));
    expect(retired).toMatchObject({
      organization: null,
      wallet: null,
      keys: [],
      memberships: [],
      job: { status: "completed" },
    });
  });
});
