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
  clerkCreatedAt: 100,
  name: "Signup",
  slug: "signup",
};

async function signup(
  t: ReturnType<typeof convexTest>,
  clerkUserId = event.creatorClerkUserId,
  clerkOrgId = event.clerkOrgId,
) {
  await t.mutation(internal.users.recordSignupFromClerk, {
    clerkUserId,
    personalOrganization: { clerkOrgId, createdAt: event.clerkCreatedAt },
  });
}

async function signedEvent(
  t: ReturnType<typeof convexTest>,
  type: string,
  data: unknown,
  id: string,
) {
  vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", secret);
  const body = JSON.stringify({ type, data });
  const timestamp = new Date();
  return await t.fetch("/clerk-webhook", {
    method: "POST",
    body,
    headers: {
      "svix-id": id,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": new Webhook(secret).sign(id, timestamp, body),
    },
  });
}

const signupData = {
  id: event.creatorClerkUserId,
  created_at: 90,
  organization_memberships: [
    {
      organization: {
        id: event.clerkOrgId,
        created_by: event.creatorClerkUserId,
        created_at: event.clerkCreatedAt,
      },
    },
  ],
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
    expect(
      (await signedEvent(t, "user.created", signupData, "msg_user_signup"))
        .status,
    ).toBe(200);
    const body = JSON.stringify({
      type: event.eventType,
      data: {
        id: event.clerkOrgId,
        name: event.name,
        slug: event.slug,
        created_by: event.creatorClerkUserId,
        created_at: event.clerkCreatedAt,
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
    await signup(t);
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
    await signup(t, "user_other", "org_other");
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
    await signup(t);
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
  it("waits for signup proof when organization.created arrives first", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.organizations.applyOrganizationWebhook, event);
    expect((await state(t)).entries).toHaveLength(0);
    await signup(t);
    await signup(t);
    expect((await state(t)).entries).toHaveLength(1);
  });

  it("does not let a later org delivered first steal the signup grant", async () => {
    const t = convexTest(schema, modules);
    await signup(t);
    await t.mutation(internal.organizations.applyOrganizationWebhook, {
      ...event,
      svixId: "msg_later",
      clerkOrgId: "org_later",
      slug: "later",
    });
    expect((await state(t)).entries).toHaveLength(0);
    await t.mutation(internal.organizations.applyOrganizationWebhook, event);
    expect((await state(t)).claims[0]?.clerkOrgId).toBe(event.clerkOrgId);
  });

  it("does not grant to an org the signup user joins", async () => {
    const t = convexTest(schema, modules);
    await signedEvent(
      t,
      "user.created",
      {
        ...signupData,
        organization_memberships: [
          {
            organization: {
              id: event.clerkOrgId,
              created_by: "user_other",
              created_at: 100,
            },
          },
        ],
      },
      "msg_joined",
    );
    await t
      .withIdentity({
        subject: event.creatorClerkUserId,
        org_id: event.clerkOrgId,
        org_slug: event.slug,
      })
      .mutation(api.organizations.ensureOrganization, {
        clerkOrgId: event.clerkOrgId,
      });
    await t.mutation(internal.organizations.applyOrganizationWebhook, {
      ...event,
      creatorClerkUserId: "user_other",
    });
    await signedEvent(
      t,
      "organizationMembership.created",
      {
        organization: { id: event.clerkOrgId },
        public_user_data: { user_id: event.creatorClerkUserId },
      },
      "msg_membership",
    );
    expect((await state(t)).entries).toHaveLength(0);
  });

  it.each([
    undefined,
    null,
    [],
    [
      ...signupData.organization_memberships,
      {
        organization: {
          id: "org_ambiguous",
          created_by: event.creatorClerkUserId,
          created_at: 100,
        },
      },
    ],
  ])(
    "fails closed for absent or ambiguous signup membership proof: %j",
    async (memberships) => {
      const t = convexTest(schema, modules);
      await signedEvent(
        t,
        "user.created",
        {
          ...signupData,
          organization_memberships: memberships,
        },
        "msg_unproven",
      );
      await t.mutation(internal.organizations.applyOrganizationWebhook, event);
      await signedEvent(t, "user.updated", signupData, "msg_update");
      await signedEvent(t, "user.created", signupData, "msg_replay_changed");
      expect((await state(t)).entries).toHaveLength(0);
    },
  );

  it("requires organization.created, not an update or generic trusted mirror", async () => {
    const t = convexTest(schema, modules);
    await signup(t);
    await t.mutation(internal.organizations.upsertFromClerk, {
      clerkOrgId: event.clerkOrgId,
      name: event.name,
      slug: event.slug,
      creatorClerkUserId: event.creatorClerkUserId,
    });
    await t.mutation(internal.organizations.applyOrganizationWebhook, {
      ...event,
      eventType: "organization.updated",
      svixId: "msg_update_only",
    });
    expect((await state(t)).entries).toHaveLength(0);
    await t.mutation(internal.organizations.applyOrganizationWebhook, event);
    expect((await state(t)).entries).toHaveLength(1);
  });

  it("preserves the user claim after org deletion and recreation", async () => {
    const t = convexTest(schema, modules);
    await signup(t);
    await t.mutation(internal.organizations.applyOrganizationWebhook, event);
    await t.mutation(internal.organizations.applyOrganizationWebhook, {
      ...event,
      svixId: "msg_delete",
      eventType: "organization.deleted",
      eventTimestamp: 200,
    });
    await t.mutation(internal.organizations.applyOrganizationWebhook, {
      ...event,
      svixId: "msg_recreate_same",
    });
    await t.mutation(internal.organizations.applyOrganizationWebhook, {
      ...event,
      svixId: "msg_recreate_new",
      clerkOrgId: "org_recreated",
      slug: "recreated",
    });
    await signup(t, event.creatorClerkUserId, "org_recreated");
    const result = await state(t);
    expect(result.entries).toHaveLength(1);
    expect(result.claims).toHaveLength(1);
  });

  it("denies late grants after delete-before-create user or org events", async () => {
    for (const deleted of ["user", "organization"]) {
      const t = convexTest(schema, modules);
      if (deleted === "user") {
        await t.mutation(internal.users.deleteFromClerk, {
          clerkUserId: event.creatorClerkUserId,
        });
      } else {
        await t.mutation(internal.organizations.applyOrganizationWebhook, {
          ...event,
          svixId: "msg_delete_before",
          eventType: "organization.deleted",
        });
      }
      await signup(t);
      await t.mutation(internal.organizations.applyOrganizationWebhook, event);
      expect((await state(t)).entries).toHaveLength(0);
    }
  });

  it("retains legacy per-user grant claims under the stricter policy", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_legacy",
        name: "Legacy",
        slug: "legacy",
      });
      await ctx.db.insert("signupCreditGrants", {
        organizationId,
        clerkOrgId: "org_legacy",
        creatorClerkUserId: event.creatorClerkUserId,
        grantedAt: 1,
      });
    });
    await signup(t);
    await t.mutation(internal.organizations.applyOrganizationWebhook, event);
    expect((await state(t)).entries).toHaveLength(0);
    expect((await state(t)).claims).toHaveLength(1);
  });

  it("cannot fund an anonymous wallet even with matching creation facts", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("organizations", {
        clerkOrgId: event.clerkOrgId,
        name: "Anonymous",
        slug: event.slug,
        walletKind: "anonymous",
        signupCreatorClerkUserId: event.creatorClerkUserId,
        signupClerkCreatedAt: event.clerkCreatedAt,
      });
    });
    await signup(t);
    expect((await state(t)).entries).toHaveLength(0);
  });
  it("serializes concurrent creation deliveries into one ledger append", async () => {
    const t = convexTest(schema, modules);
    await Promise.all([
      signup(t),
      t.mutation(internal.organizations.applyOrganizationWebhook, event),
      t.mutation(internal.organizations.applyOrganizationWebhook, {
        ...event,
        svixId: "msg_concurrent_replay",
      }),
    ]);
    const result = await state(t);
    expect(result.entries).toHaveLength(1);
    expect(result.claims).toHaveLength(1);
    expect(result.wallets[0]).toMatchObject({ balance: 10_000, sequence: 1 });
  });

  it.each([undefined, 99, 101])(
    "rejects mismatched or absent organization creation time: %s",
    async (clerkCreatedAt) => {
      const t = convexTest(schema, modules);
      await signup(t);
      await t.mutation(internal.organizations.applyOrganizationWebhook, {
        ...event,
        clerkCreatedAt,
      });
      expect((await state(t)).entries).toHaveLength(0);
    },
  );

  it("ignores client-controlled metadata suggesting signup eligibility", async () => {
    const t = convexTest(schema, modules);
    await signedEvent(
      t,
      "user.created",
      {
        id: event.creatorClerkUserId,
        created_at: 90,
        unsafe_metadata: {
          personalOrganization: event.clerkOrgId,
          organization_memberships: signupData.organization_memberships,
        },
      },
      "msg_unsafe_metadata",
    );
    await t.mutation(internal.organizations.applyOrganizationWebhook, event);
    expect((await state(t)).entries).toHaveLength(0);
  });
});
