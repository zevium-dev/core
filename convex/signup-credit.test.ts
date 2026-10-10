/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const secret = ["whsec", "dGVzdC13ZWJob29rLXNlY3JldA=="].join("_");
const event = {
  svixId: "msg_signup",
  eventTimestamp: 100,
  eventType: "organization.created" as const,
  clerkOrgId: "org_signup",
  creatorClerkUserId: "user_creator",
  name: "Signup",
  slug: "signup",
};

async function state(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ({
    wallets: await ctx.db.query("wallets").collect(),
    entries: await ctx.db.query("walletEntries").collect(),
    lots: await ctx.db.query("walletFundingLots").collect(),
    claims: await ctx.db.query("signupCreditGrants").collect(),
  }));
}

afterEach(() => vi.unstubAllEnvs());

describe("signup promotional credit", () => {
  it("grants through a signed Clerk webhook once and exposes the funded edge checkpoint", async () => {
    vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", secret);
    vi.stubEnv("GATEWAY_INTERNAL_SECRET", "test-gateway-secret");
    const t = convexTest(schema, modules);
    const body = JSON.stringify({
      type: event.eventType,
      data: {
        id: event.clerkOrgId,
        name: event.name,
        slug: event.slug,
        created_by: event.creatorClerkUserId,
      },
    });
    const timestamp = new Date();
    const headers = {
      "svix-id": event.svixId,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": new Webhook(secret).sign(event.svixId, timestamp, body),
    };
    // Signature rejection must not mint credit.
    expect(
      (
        await t.fetch("/clerk-webhook", {
          method: "POST",
          body,
          headers: { ...headers, "svix-signature": "invalid" },
        })
      ).status,
    ).toBe(400);
    expect((await state(t)).entries).toHaveLength(0);
    for (let replay = 0; replay < 2; replay++) {
      expect(
        (await t.fetch("/clerk-webhook", { method: "POST", body, headers }))
          .status,
      ).toBe(200);
    }
    const result = await state(t);
    expect(result.wallets).toHaveLength(1);
    expect(result.wallets[0]).toMatchObject({ balance: 10_000, sequence: 1 });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      kind: "admin_adjustment",
      amount: 10_000,
      refId: "promo:signup:org_signup",
    });
    expect(result.claims).toHaveLength(1);
    expect(result.lots).toHaveLength(1);
    expect(result.lots[0]).toMatchObject({
      sourceKind: "promotion",
      refundable: false,
      availableCredits: 10_000,
    });
    expect(result.lots[0]?.paymentId).toBeUndefined();
    const checkpoint = await t.fetch("/wallet-grants?clerkOrgId=org_signup", {
      headers: { "x-internal-secret": "test-gateway-secret" },
    });
    expect(checkpoint.status).toBe(200);
    expect(await checkpoint.json()).toMatchObject({
      wallet: { balance: 10_000, sequence: 1 },
    });
  });

  it("deduplicates new webhook ids and trusted mirror retries, then denies a second org by the creator", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.organizations.applyOrganizationWebhook, event);
    await t.mutation(internal.organizations.applyOrganizationWebhook, {
      ...event,
      svixId: "msg_replay",
    });
    await t.mutation(internal.organizations.upsertFromClerk, {
      clerkOrgId: event.clerkOrgId,
      creatorClerkUserId: event.creatorClerkUserId,
      name: event.name,
      slug: event.slug,
    });
    // Removing the user mirror must not reset the anti-farming claim.
    await t.mutation(internal.users.upsertFromClerk, {
      clerkUserId: event.creatorClerkUserId,
      name: "Creator",
      email: "creator@example.com",
    });
    await t.mutation(internal.users.deleteFromClerk, {
      clerkUserId: event.creatorClerkUserId,
    });
    await t.mutation(internal.organizations.applyOrganizationWebhook, {
      ...event,
      svixId: "msg_second",
      clerkOrgId: "org_second",
      slug: "second",
    });
    const result = await state(t);
    expect(result.entries).toHaveLength(1);
    expect(result.claims).toHaveLength(1);
    expect(
      result.wallets.map((wallet) => wallet.balance).sort((a, b) => a - b),
    ).toEqual([0, 10_000]);
    await t.mutation(internal.organizations.applyOrganizationWebhook, {
      ...event,
      svixId: "msg_other",
      clerkOrgId: "org_other",
      slug: "other",
      creatorClerkUserId: "user_other",
    });
    expect((await state(t)).entries).toHaveLength(2);
  });

  it("funds a browser-created mirror when creator proof arrives, including out-of-order delivery", async () => {
    const t = convexTest(schema, modules);
    const browser = t.withIdentity({
      subject: "invited_member",
      org_id: event.clerkOrgId,
      org_slug: event.slug,
    });
    await browser.mutation(api.organizations.ensureOrganization, {
      clerkOrgId: event.clerkOrgId,
    });
    expect((await state(t)).entries).toHaveLength(0);
    await t.mutation(internal.organizations.applyOrganizationWebhook, {
      ...event,
      svixId: "msg_update_first",
      eventType: "organization.updated",
      eventTimestamp: 200,
      creatorClerkUserId: undefined,
    });
    await t.mutation(internal.organizations.applyOrganizationWebhook, event);
    await browser.mutation(api.organizations.ensureOrganization, {
      clerkOrgId: event.clerkOrgId,
    });
    const result = await state(t);
    expect(result.wallets[0]?.balance).toBe(10_000);
    expect(result.claims[0]?.creatorClerkUserId).toBe("user_creator");
    expect(result.entries).toHaveLength(1);
  });

  it("does not grant without a creator or resurrect a deleted organization", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.organizations.applyOrganizationWebhook, {
      ...event,
      creatorClerkUserId: undefined,
    });
    expect((await state(t)).entries).toHaveLength(0);
    await t.mutation(internal.organizations.applyOrganizationWebhook, {
      ...event,
      svixId: "msg_deleted",
      eventTimestamp: 200,
      eventType: "organization.deleted",
    });
    await t.mutation(internal.organizations.applyOrganizationWebhook, {
      ...event,
      svixId: "msg_late_create",
    });
    expect((await state(t)).entries).toHaveLength(0);
    expect((await state(t)).claims).toHaveLength(0);
  });
});
