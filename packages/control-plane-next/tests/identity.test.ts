import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { harness, seed, identity, webhook, webhookSecret } from "./helpers";
import { api } from "../convex/_generated/api";
const created = (id: string, extra = {}) => ({
  id,
  name: id,
  slug: "same-slug",
  created_by: "user_one",
  updated_at: 1000,
  ...extra,
});
beforeEach(() => {
  vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", webhookSecret);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe("signed Clerk identity boundary", () => {
  it("rejects unsigned and malformed payloads without identity writes", async () => {
    const t = harness();
    expect(
      (await t.fetch("/clerk-webhook", { method: "POST", body: "{}" })).status,
    ).toBe(400);
    expect(
      (await webhook(t, "bad", "organization.created", { id: 1 })).status,
    ).toBe(400);
    expect(
      await t.run((ctx) => ctx.db.query("organizations").collect()),
    ).toEqual([]);
  });
  it("claims the first processed signed creation once, independent of ensure or update ordering", async () => {
    const t = harness();
    const admin = t.withIdentity(identity());
    const ensured = await admin.mutation(api.organizations.ensureOrganization, {
      clerkOrgId: "org_one",
    });
    await admin.mutation(api.users.ensureUser, {});
    expect(
      (
        await webhook(
          t,
          "newer",
          "organization.updated",
          created("org_one", { updated_at: 2000, name: "Newest" }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await webhook(t, "later", "organization.updated", created("org_later")))
        .status,
    ).toBe(200);
    expect(
      await t.run((ctx) => ctx.db.query("users").first()),
    ).not.toHaveProperty("signupPersonalOrganizationId");
    const event = created("org_one", { created_at: 2000 });
    expect(
      (await webhook(t, "proof", "organization.created", event)).status,
    ).toBe(200);
    expect(
      (await webhook(t, "proof", "organization.created", event)).status,
    ).toBe(200);
    const state = await t.run(async (ctx) => ({
      user: await ctx.db.query("users").first(),
      org: await ctx.db.get(ensured._id),
      wallets: await ctx.db.query("wallets").collect(),
    }));
    expect(state.user?.signupPersonalOrganizationId).toBe(ensured._id);
    expect(state.org?.name).toBe("Newest");
    expect(state.org?.personalForClerkUserId).toBe("user_one");
    expect(state.wallets).toEqual([]); // Money side belongs to PR 3, never an ad-hoc balance write.
    expect(
      (
        await webhook(
          t,
          "conflict",
          "organization.created",
          created("org_later", { created_at: 1000 }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await t.run((ctx) => ctx.db.query("users").first()))
        ?.signupPersonalOrganizationId,
    ).toBe(ensured._id);
  });
  it("never accepts metadata, organization updates or membership joins as creator claims", async () => {
    const t = harness();
    for (const [i, fields] of [
      { public_metadata: { creator: "user_one" } },
      {
        private_metadata: {
          zevium_signup: {
            version: 1,
            purpose: "signup_personal_org",
            userId: "user_one",
            organizationId: "org_1",
          },
        },
      },
      { unsafe_metadata: { creator: "user_one" } },
    ].entries())
      expect(
        (
          await webhook(
            t,
            `msg${i}`,
            "organization.created",
            created(`org_${i}`, { created_by: null, ...fields }),
          )
        ).status,
      ).toBe(200);
    expect(
      (
        await webhook(
          t,
          "update",
          "organization.updated",
          created("org_update"),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await webhook(t, "join", "organizationMembership.created", {
          id: "membership",
          organization: { id: "org_0" },
          public_user_data: { user_id: "user_one" },
        })
      ).status,
    ).toBe(200);
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toEqual([]);
  });
  it("keeps user claim through deletion and never resurrects deleted profiles", async () => {
    const t = harness();
    await webhook(
      t,
      "org",
      "organization.created",
      created("org_one", { created_at: 2000 }),
    );
    await t.run(async (ctx) => {
      const u = (await ctx.db.query("users").first())!;
      await ctx.db.patch(u._id, {
        name: "Personal",
        email: "person@example.com",
        signupGrant: {
          organizationId: u.signupPersonalOrganizationId!,
          refId: "signup:user_one",
          grantedAt: 1000,
        },
      });
    });
    await webhook(t, "delete", "user.deleted", {
      id: "user_one",
      deleted_at: 3000,
    });
    await webhook(t, "late", "user.updated", {
      id: "user_one",
      updated_at: 4000,
      first_name: "Restore",
    });
    const user = await t.run((ctx) => ctx.db.query("users").first());
    expect(user?.signupGrant?.refId).toBe("signup:user_one");
    expect(user?.deletedAt).toBeDefined();
    expect(user?.email).toBeUndefined();
    expect(user?.name).toBeUndefined();
    await expect(
      t.withIdentity(identity()).mutation(api.users.ensureUser, {}),
    ).rejects.toThrow("Not authenticated");
    await expect(
      t
        .withIdentity(identity())
        .query(api.organizations.activeCapabilities, {}),
    ).rejects.toThrow("Not authenticated");
  });
  it("orders user updates and preserves delete-before-create tombstones", async () => {
    const t = harness();
    await webhook(t, "new", "user.updated", {
      id: "user_one",
      updated_at: 2000,
      first_name: "New",
    });
    await webhook(t, "old", "user.created", {
      id: "user_one",
      updated_at: 1000,
      first_name: "Old",
    });
    expect((await t.run((ctx) => ctx.db.query("users").first()))?.name).toBe(
      "New",
    );
    await webhook(t, "delete", "organization.deleted", {
      id: "org_dead",
      deleted_at: 1500,
    });
    await webhook(
      t,
      "late",
      "organization.created",
      created("org_dead", { updated_at: 3000 }),
    );
    expect(
      await t.run((ctx) => ctx.db.query("organizations").collect()),
    ).toEqual([]);
    await expect(
      t
        .withIdentity(identity("dead"))
        .mutation(api.organizations.ensureOrganization, {
          clerkOrgId: "org_dead",
        }),
    ).rejects.toThrow("archived");
  });
  it("reserves archived handles, tolerates Clerk slug collisions, and fences archived auth", async () => {
    const t = harness();
    await webhook(t, "a", "organization.created", created("org_one"));
    await webhook(t, "b", "organization.created", created("org_two"));
    const orgs = await t.run((ctx) => ctx.db.query("organizations").collect());
    expect(new Set(orgs.map((o) => o.publicHandle)).size).toBe(2);
    await webhook(t, "delete", "organization.deleted", {
      id: "org_one",
      deleted_at: 2000,
    });
    await webhook(
      t,
      "update",
      "organization.updated",
      created("org_one", { updated_at: 3000 }),
    );
    await expect(
      t.withIdentity(identity()).query(api.projects.list, { orgSlug: "one" }),
    ).rejects.toThrow("Organization not found");
    expect(
      (
        await t
          .withIdentity(identity("two"))
          .query(api.organizations.checkPublicHandleAvailability, {
            handle: "same-slug",
          })
      ).available,
    ).toBe(false);
  });
  it("rejects changed-content replay and derives tenant from signed claims", async () => {
    const t = harness();
    await seed(t);
    await expect(
      t
        .withIdentity(identity())
        .mutation(api.organizations.ensureOrganization, {
          clerkOrgId: "org_two",
        }),
    ).rejects.toThrow("identity");
    expect(
      (
        await webhook(t, "same", "user.created", {
          id: "user_one",
          updated_at: 1000,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await webhook(t, "same", "user.created", {
          id: "user_other",
          updated_at: 1000,
        })
      ).status,
    ).toBe(503);
  });
});

it("exposes a PR 3 grant candidate only for an unclaimed active signup binding", async () => {
  const { signupGrantCandidate } = await import("../convex/lib/identity");
  const t = harness();
  expect(
    await t.run((ctx) => signupGrantCandidate(ctx, "user_one")),
  ).toBeNull();
  await webhook(
    t,
    "proof",
    "organization.created",
    created("org_one", { created_at: 2000 }),
  );
  const candidate = await t.run((ctx) => signupGrantCandidate(ctx, "user_one"));
  expect(candidate).toMatchObject({
    credits: 10_000,
    refId: "signup:user_one",
    clerkUserId: "user_one",
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(candidate!.userId, {
      signupGrant: {
        organizationId: candidate!.organizationId,
        refId: candidate!.refId,
        grantedAt: Date.now(),
      },
    });
  });
  expect(
    await t.run((ctx) => signupGrantCandidate(ctx, "user_one")),
  ).toBeNull();
});

it("archives access immediately while retaining wallet and immutable publication history", async () => {
  const t = harness();
  const ids = await seed(t);
  const walletId = await t.run((ctx) =>
    ctx.db.insert("wallets", {
      owner: { kind: "org", organizationId: ids.one, clerkOrgId: "org_one" },
      ownerKey: "org:org_one",
      balance: 10,
      sequence: 1,
      promoCredits: 0,
      epoch: 1,
      gateState: "open",
      gateRevision: 1,
      settledThroughEdgeSequence: 0,
    }),
  );
  expect(
    (
      await webhook(t, "archive", "organization.deleted", {
        id: "org_one",
        deleted_at: Date.now(),
      })
    ).status,
  ).toBe(200);
  expect((await t.run((ctx) => ctx.db.get(walletId)))?.balance).toBe(10);
  expect(
    (await t.run((ctx) => ctx.db.query("orgTombstones").first()))
      ?.organizationId,
  ).toBe(ids.one);
  expect(
    await t.query(api.organizations.getByPublicHandle, { handle: "one" }),
  ).toBeNull();
});
