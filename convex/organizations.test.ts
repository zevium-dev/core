/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function asAdmin(t: ReturnType<typeof convexTest>, orgId = "org_pub") {
  return t.withIdentity({
    subject: "user_admin",
    org_id: orgId,
    org_slug: "new-clerk-slug",
    org_role: "org:admin",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("stable public handles", () => {
  it("allows draft-stage setup but freezes the handle after first publish", async () => {
    const t = convexTest(schema, modules);
    const { orgId, projectId } = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_pub",
        name: "Publisher",
        slug: "stale-clerk-slug",
        publicHandle: "old-handle",
      });
      const projectId = await ctx.db.insert("projects", {
        organizationId: orgId,
        name: "API",
        slug: "api",
        status: "draft",
        visibility: "private",
        tags: [],
      });
      return { orgId, projectId };
    });

    const actor = asAdmin(t);
    const renamed = await actor.mutation(api.organizations.setPublicHandle, {
      handle: "launch-handle",
    });
    expect(renamed.publicHandle).toBe("launch-handle");

    await t.run(async (ctx) => {
      await ctx.db.patch(projectId, { status: "published" });
    });
    await expect(
      actor.mutation(api.organizations.setPublicHandle, {
        handle: "broken-links",
      }),
    ).rejects.toThrow(/permanent after first publication/);
    expect(
      await t.run(async (ctx) => (await ctx.db.get(orgId))?.publicHandle),
    ).toBe("launch-handle");

    const mine = await actor.query(api.organizations.listMine, {});
    expect(mine[0]).toMatchObject({
      publisherHandle: "launch-handle",
      publicHandleLocked: true,
    });
  });
});

describe("organization archive ordering and scale", () => {
  it("treats the permanent tombstone as authoritative across public and gateway reads", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_tombstoned",
        name: "Restored-looking org",
        slug: "restored-looking",
        publicHandle: "restored-looking",
      });
      const projectId = await ctx.db.insert("projects", {
        organizationId: orgId,
        name: "Should stay dead",
        slug: "dead-api",
        status: "published",
        visibility: "public",
        tags: [],
      });
      await ctx.db.insert("specVersions", {
        projectId,
        version: "1.0.0",
        spec: JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Dead", version: "1.0.0" },
          servers: [{ url: "https://api.example.com" }],
          paths: {},
        }),
        publishedAt: 1,
      });
      const walletId = await ctx.db.insert("wallets", {
        organizationId: orgId,
        balance: 91,
        sequence: 1,
      });
      await ctx.db.insert("walletEntries", {
        walletId,
        kind: "admin_adjustment",
        amount: 91,
        refId: "seed:tombstone-wallet",
        sequence: 1,
        createdAt: 1,
      });
      await ctx.db.insert("keySettings", {
        clerkOrgId: "org_tombstoned",
        keyId: "key_must_fail_closed",
        disabled: false,
        updatedAt: 1,
      });
      // Hostile state: mutable mirror looks active beside terminal tombstone.
      await ctx.db.insert("organizationTombstones", {
        sourceRevision: 1,
        clerkOrgId: "org_tombstoned",
        archivedAt: 2,
      });
    });

    await expect(
      t.query(api.organizations.getByPublicHandle, {
        handle: "restored-looking",
      }),
    ).resolves.toBeNull();
    await expect(
      t.query(api.catalogue.getPublicDetail, {
        publisherHandle: "restored-looking",
        projectSlug: "dead-api",
      }),
    ).resolves.toBeNull();
    await expect(
      t.query(api.specs.getPublishedForGateway, {
        publisherHandle: "restored-looking",
        projectSlug: "dead-api",
      }),
    ).resolves.toBeNull();
    await expect(
      t.query(internal.specs.getPublishedForGatewayInternal, {
        publisherHandle: "restored-looking",
        projectSlug: "dead-api",
      }),
    ).resolves.toBeNull();
    const checkpoint = await t.query(internal.wallets.getGatewayWallet, {
      clerkOrgId: "org_tombstoned",
    });
    expect(checkpoint.wallet).toMatchObject({ balance: 0, sequence: 0 });
    expect(checkpoint.keySettings).toEqual([
      expect.objectContaining({
        keyId: "key_must_fail_closed",
        disabled: true,
      }),
    ]);
  });

  it("retains a delete-before-create tombstone and never resurrects the org", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);

    await t.mutation(internal.organizations.archiveFromClerk, {
      clerkOrgId: "org_late",
    });
    await t.mutation(internal.organizations.archiveFromClerk, {
      clerkOrgId: "org_late",
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    expect(
      await t.mutation(internal.organizations.upsertFromClerk, {
        clerkOrgId: "org_late",
        name: "Late Org",
        slug: "late-org",
      }),
    ).toBeNull();
    const state = await t.run(async (ctx) => ({
      orgs: await ctx.db.query("organizations").collect(),
      tombstones: await ctx.db.query("organizationTombstones").collect(),
    }));
    expect(state.orgs).toHaveLength(0);
    expect(state.tombstones).toHaveLength(1);

    await expect(
      asAdmin(t, "org_late").mutation(api.organizations.ensureOrganization, {
        clerkOrgId: "org_late",
      }),
    ).rejects.toThrow(/archived/);
  });

  it("commits archive first, then disables more than one key page idempotently", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const orgId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("organizations", {
        clerkOrgId: "org_large",
        name: "Large Org",
        slug: "large-org",
        publicHandle: "large-org",
      });
      for (let index = 0; index < 250; index += 1) {
        await ctx.db.insert("keySettings", {
          clerkOrgId: "org_large",
          keyId: `key_${index}`,
          disabled: false,
          updatedAt: 1,
        });
      }
      return id;
    });

    await t.mutation(internal.organizations.archiveFromClerk, {
      clerkOrgId: "org_large",
    });
    expect(
      await t.run(async (ctx) => (await ctx.db.get(orgId))?.archivedAt),
    ).toEqual(expect.any(Number));

    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    let state = await t.run(async (ctx) => ({
      keys: await ctx.db
        .query("keySettings")
        .withIndex("by_org", (q) => q.eq("clerkOrgId", "org_large"))
        .collect(),
      tombstones: await ctx.db.query("organizationTombstones").collect(),
    }));
    expect(state.keys).toHaveLength(250);
    expect(state.keys.every((key) => key.disabled)).toBe(true);
    expect(state.tombstones).toHaveLength(1);

    await t.mutation(internal.organizations.archiveFromClerk, {
      clerkOrgId: "org_large",
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    state = await t.run(async (ctx) => ({
      keys: await ctx.db.query("keySettings").collect(),
      tombstones: await ctx.db.query("organizationTombstones").collect(),
    }));
    expect(state.keys.every((key) => key.disabled)).toBe(true);
    expect(state.tombstones).toHaveLength(1);
  });
});

describe("Clerk-generated organization slugs", () => {
  it("mirrors signup slugs without using them as invalid public handles", async () => {
    const t = convexTest(schema, modules);
    const slug =
      "internet-assigned-numbers-authority-iana--1791085075284997749";
    const actor = t.withIdentity({
      subject: "user_signup",
      org_id: "org_signup",
      org_slug: slug,
      org_role: "org:admin",
    });
    const mirrored = await actor.mutation(
      api.organizations.ensureOrganization,
      {
        clerkOrgId: "org_signup",
      },
    );
    expect(mirrored.slug).toBe(slug);
    expect(mirrored.publicHandle).toBe("publisher");
    const synced = await t.mutation(internal.organizations.upsertFromClerk, {
      clerkOrgId: "org_signup",
      name: "Internet Assigned Numbers Authority (IANA)",
      slug,
    });
    expect(synced).toBe(mirrored._id);
    expect(
      (await actor.query(api.analytics.orgOverview, { orgSlug: slug }))
        .callsCycle,
    ).toBe(0);
    expect(
      (await actor.query(api.wallets.getMyWallet, { orgSlug: slug }))?.balance,
    ).toBe(0);
  });

  it("assigns distinct public handles to long provider slugs and rejects unsafe claims", async () => {
    const t = convexTest(schema, modules);
    const slug = `${"organization".repeat(8)}--123`;
    await t.mutation(internal.organizations.upsertFromClerk, {
      clerkOrgId: "org_long_one",
      name: "Long name",
      slug,
    });
    const actor = t.withIdentity({
      subject: "user_signup",
      org_id: "org_long_two",
      org_slug: `${slug}4`,
      org_role: "org:admin",
    });
    const mirrored = await actor.mutation(
      api.organizations.ensureOrganization,
      {
        clerkOrgId: "org_long_two",
      },
    );
    expect(mirrored.slug).toBe(`${slug}4`);
    expect(mirrored.publicHandle).not.toBe("publisher");
    for (const invalid of [
      "",
      "org/path",
      "org%2fpath",
      "org?query",
      "x".repeat(257),
    ]) {
      await expect(
        t
          .withIdentity({
            subject: "user_signup",
            org_id: "org_invalid",
            org_slug: invalid,
            org_role: "org:admin",
          })
          .mutation(api.organizations.ensureOrganization, {
            clerkOrgId: "org_invalid",
          }),
      ).rejects.toThrow("Authenticated organization slug is invalid");
    }
  });
});

describe("archive after refunds", () => {
  it("retains completed refund facts and blocks pending or unapplied exposures", async () => {
    const t = convexTest(schema, modules);
    const { orgId, exposureId, paymentId } = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_refunded",
        name: "Refunded QA",
        slug: "refunded-qa",
        publicHandle: "refunded-qa",
      });
      const checkoutIntentId = await ctx.db.insert("checkoutIntents", {
        organizationId: orgId,
        packId: "pack_10",
        stripePriceId: "price_qa",
        amount: 1000,
        currency: "usd",
        credits: 100000,
        status: "complete",
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      });
      const paymentId = await ctx.db.insert("payments", {
        organizationId: orgId,
        checkoutIntentId,
        stripeCheckoutSessionId: "cs_test_qa",
        amount: 1000,
        currency: "usd",
        grantedCredits: 100000,
        reversedCredits: 100000,
        status: "refunded",
        createdAt: 1,
        updatedAt: 1,
      });
      const exposureId = await ctx.db.insert("paymentExposures", {
        organizationId: orgId,
        paymentId,
        sourceKind: "refund",
        sourceRef: "stripe:refund:re_qa",
        sourceAmount: 1000,
        sourceAmountExact: true,
        sourceStatus: "pending",
        requestedCredits: 100000,
        effectiveCredits: 100000,
        walletCredits: 99999,
        publisherCredits: 1,
        appliedPublisherCredits: 0,
        active: true,
        createdAt: 1,
        updatedAt: 1,
      });
      return { orgId, exposureId, paymentId };
    });
    const archive = () =>
      t.mutation(internal.organizations.deleteFromClerk, {
        clerkOrgId: "org_refunded",
      });
    await expect(archive()).rejects.toThrow("unresolved exposure");
    await t.run((ctx) =>
      ctx.db.patch(exposureId, { sourceStatus: "succeeded" }),
    );
    await expect(archive()).rejects.toThrow("unresolved exposure");
    await t.run((ctx) =>
      ctx.db.patch(exposureId, {
        appliedPublisherCredits: 1,
        walletCredits: 99998,
      }),
    );
    await expect(archive()).rejects.toThrow("unresolved exposure");
    await t.run((ctx) => ctx.db.patch(exposureId, { walletCredits: 99999 }));
    for (const sourceAmountExact of [false, undefined]) {
      await t.run((ctx) => ctx.db.patch(exposureId, { sourceAmountExact }));
      await expect(archive()).rejects.toThrow("unresolved exposure");
    }
    await t.run((ctx) => ctx.db.patch(exposureId, { sourceAmountExact: true }));
    await archive();
    const state = await t.run(async (ctx) => ({
      org: await ctx.db.get(orgId),
      payment: await ctx.db.get(paymentId),
      exposure: await ctx.db.get(exposureId),
    }));
    expect(state.org?.archivedAt).toEqual(expect.any(Number));
    expect(state.payment?.status).toBe("refunded");
    expect(state.exposure).toMatchObject({
      active: true,
      sourceStatus: "succeeded",
      effectiveCredits: 100000,
      appliedPublisherCredits: 1,
    });
  });
});
