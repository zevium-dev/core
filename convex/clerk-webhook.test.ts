/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const secret = "whsec_dGVzdC13ZWJob29rLXNlY3JldA==";

describe("Clerk webhook user lifecycle", () => {
  const previousSecret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;

  beforeEach(() => {
    process.env.CLERK_WEBHOOK_SIGNING_SECRET = secret;
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("archives a deleted organization and preserves financial, audit, and project history", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_deleted",
        name: "Deleted Org",
        slug: "deleted-org",
        publicHandle: "deleted-org",
      });
      const walletId = await ctx.db.insert("wallets", {
        organizationId,
        balance: 80,
        sequence: 1,
      });
      await ctx.db.insert("walletEntries", {
        walletId,
        kind: "admin_adjustment",
        amount: 80,
        refId: "audit:grant",
        sequence: 1,
        createdAt: 1,
      });
      const projectId = await ctx.db.insert("projects", {
        organizationId,
        name: "Historical API",
        slug: "historical-api",
        status: "published",
        visibility: "public",
        tags: [],
      });
      await ctx.db.insert("usageEvents", {
        organizationId,
        projectId,
        endpoint: "/history",
        method: "GET",
        credits: 20,
        status: 200,
        latencyMs: 10,
        keyId: "key_deleted",
        at: 2,
      });
      await ctx.db.insert("keySettings", {
        clerkOrgId: "org_deleted",
        keyId: "key_deleted",
        disabled: false,
        updatedAt: 1,
      });
      return { organizationId, walletId, projectId };
    });

    const body = JSON.stringify({
      type: "organization.deleted",
      data: { id: "org_deleted", deleted: true },
    });
    const messageId = "msg_org_deleted";
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
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    const state = await t.run(async (ctx) => ({
      org: await ctx.db.get(seeded.organizationId),
      wallet: await ctx.db.get(seeded.walletId),
      project: await ctx.db.get(seeded.projectId),
      ledger: await ctx.db.query("walletEntries").collect(),
      usage: await ctx.db.query("usageEvents").collect(),
      key: await ctx.db
        .query("keySettings")
        .withIndex("by_key", (q) => q.eq("keyId", "key_deleted"))
        .unique(),
    }));
    expect(state.org?.archivedAt).toEqual(expect.any(Number));
    expect(state.wallet?.balance).toBe(80);
    expect(state.project?._id).toBe(seeded.projectId);
    expect(state.ledger).toHaveLength(1);
    expect(state.usage).toHaveLength(1);
    expect(state.key?.disabled).toBe(true);

    const staleSession = t.withIdentity({
      subject: "user_stale",
      org_id: "org_deleted",
      org_slug: "deleted-org",
      org_role: "org:admin",
    } as {
      subject: string;
      org_id: string;
      org_slug: string;
      org_role: string;
    });
    await expect(
      staleSession.query(api.projects.list, { orgSlug: "deleted-org" }),
    ).rejects.toThrow(/Organization not found|archived/);
    await expect(
      staleSession.mutation(api.organizations.ensureOrganization, {
        clerkOrgId: "org_deleted",
      }),
    ).rejects.toThrow(/archived/);
    await expect(
      t.query(api.catalogue.getPublicDetail, {
        publisherHandle: "deleted-org",
        projectSlug: "historical-api",
      }),
    ).resolves.toBeNull();
  });

  it("keeps webhook profile fields authoritative against browser overwrite attempts", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("organizations", {
        clerkOrgId: "org_authoritative",
        name: "Clerk Name",
        slug: "clerk-slug",
        publicHandle: "public-handle",
        imageUrl: "https://img.example/clerk.png",
      });
    });
    const browser = t.withIdentity({
      subject: "user_member",
      org_id: "org_authoritative",
      org_slug: "attacker-slug",
      org_role: "org:admin",
    } as {
      subject: string;
      org_id: string;
      org_slug: string;
      org_role: string;
    });

    await browser.mutation(api.organizations.ensureOrganization, {
      clerkOrgId: "org_authoritative",
    });
    const org = await t.run(async (ctx) =>
      ctx.db
        .query("organizations")
        .withIndex("by_clerk_org", (q) =>
          q.eq("clerkOrgId", "org_authoritative"),
        )
        .unique(),
    );
    expect(org).toMatchObject({
      name: "Clerk Name",
      slug: "clerk-slug",
      publicHandle: "public-handle",
      imageUrl: "https://img.example/clerk.png",
    });
  });

  it("returns minimal public organization DTOs without internal ids", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("organizations", {
        clerkOrgId: "org_public",
        name: "Public Org",
        slug: "clerk-private-slug",
        publicHandle: "publisher",
      });
    });
    const result = await t.query(api.organizations.getByPublicHandle, {
      handle: "publisher",
    });
    expect(result).toEqual({
      name: "Public Org",
      publisherHandle: "publisher",
      imageUrl: undefined,
    });
    expect(result).not.toHaveProperty("_id");
    expect(result).not.toHaveProperty("clerkOrgId");
    expect(result).not.toHaveProperty("slug");
  });

  it("deduplicates Svix ids and rejects stale organization profile events", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.organizations.applyOrganizationWebhook, {
        svixId: "msg_create_ordered",
        eventTimestamp: 100,
        eventType: "organization.created",
        clerkOrgId: "org_ordered",
        name: "Original",
        slug: "original",
      }),
    ).resolves.toEqual({ status: "processed" });
    await expect(
      t.mutation(internal.organizations.applyOrganizationWebhook, {
        svixId: "msg_update_new",
        eventTimestamp: 300,
        eventType: "organization.updated",
        clerkOrgId: "org_ordered",
        name: "Newest",
        slug: "newest-slug",
      }),
    ).resolves.toEqual({ status: "processed" });
    await expect(
      t.mutation(internal.organizations.applyOrganizationWebhook, {
        svixId: "msg_update_stale",
        eventTimestamp: 200,
        eventType: "organization.updated",
        clerkOrgId: "org_ordered",
        name: "Stale",
        slug: "stale-slug",
      }),
    ).resolves.toEqual({ status: "ignored_stale" });
    await expect(
      t.mutation(internal.organizations.applyOrganizationWebhook, {
        svixId: "msg_update_new",
        eventTimestamp: 999,
        eventType: "organization.updated",
        clerkOrgId: "org_ordered",
        name: "Replay attack",
        slug: "replay-attack",
      }),
    ).resolves.toEqual({ status: "duplicate" });

    const state = await t.run(async (ctx) => ({
      org: await ctx.db
        .query("organizations")
        .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", "org_ordered"))
        .unique(),
      receipts: await ctx.db.query("clerkWebhookReceipts").collect(),
    }));
    expect(state.org).toMatchObject({
      name: "Newest",
      slug: "newest-slug",
      publicHandle: "original",
      lastClerkEventAt: 300,
    });
    expect(state.receipts).toHaveLength(3);
    expect(
      state.receipts.find((receipt) => receipt.svixId === "msg_update_stale"),
    ).toMatchObject({ status: "ignored_stale" });
  });
});
