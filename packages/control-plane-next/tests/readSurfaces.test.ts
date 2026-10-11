import { measure } from "./measureDb";
import { browse } from "../convex/catalogue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import rateSchema from "../node_modules/@convex-dev/rate-limiter/dist/component/schema.js";
import { api, internal } from "../convex/_generated/api";
import { harness, seed, identity, draftProject, pass, spec } from "./helpers";
import { NOW, projectFields } from "./fixtures";
import { sha256Hex } from "@zevium/shared";
import { publicListingRead, searchRead } from "../contracts/read";
import { createNotification } from "../convex/lib/notifications";
import { fireWebhookEvent } from "../convex/webhooks";
import { syncCatalogue } from "../convex/lib/catalogue";
import { utcDay } from "../convex/money/rollups";
const rateModules = import.meta.glob(
  "../node_modules/@convex-dev/rate-limiter/dist/component/**/*.js",
);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("ADMIN_USER_IDS", "staff");
  vi.stubEnv("NEXT_DEPLOYMENT_ID", "next-fixture");
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv(
    "UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS",
    JSON.stringify({ current: "test", keys: { test: btoa("a".repeat(32)) } }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
async function fixture() {
  const t = harness();
  t.registerComponent("rateLimiter", rateSchema, rateModules);
  const orgs = await seed(t),
    admin = t.withIdentity(identity()),
    member = t.withIdentity(identity("one", "member", "org:member")),
    consumer = t.withIdentity(identity("two", "consumer", "org:member")),
    staff = t.withIdentity({ subject: "staff" });
  const project = await draftProject(t);
  await pass(t, project._id);
  await admin.mutation(api.specs.publish, {
    projectId: project._id,
    version: "1.0.0",
    draftHash: await sha256Hex(spec),
  });
  return { t, admin, member, consumer, staff, project, ...orgs };
}
describe("replacement read surfaces", () => {
  it("publishes scalar priced listings, facets, hides stale vectors and archived publishers", async () => {
    const f = await fixture(),
      result = await f.t.query(api.catalogue.listPublic, {});
    expect(result.items).toHaveLength(1);
    expect(publicListingRead.parse(result.items[0]).pricing.endpointCount).toBe(
      2,
    );
    expect(result.total).toBe(1);
    await f.admin.mutation(api.projects.update, {
      projectId: f.project._id,
      patch: { tags: ["echo"], name: "Renamed" },
    });
    expect(await f.t.query(api.catalogue.publicFacets, {})).toEqual([
      { name: "echo", count: 1 },
    ]);
    await f.staff.mutation(api.admin.setProjectVisibility, {
      organizationHandle: "one",
      projectSlug: "echo",
      visibility: "private",
    });
    expect((await f.t.query(api.catalogue.listPublic, {})).items).toEqual([]);
    expect(await f.t.query(api.catalogue.publicFacets, {})).toEqual([]);
    await f.staff.mutation(api.admin.setProjectVisibility, {
      organizationHandle: "one",
      projectSlug: "echo",
      visibility: "public",
    });
    await f.t.run((ctx) => ctx.db.patch(f.one, { archivedAt: NOW }));
    expect((await f.t.query(api.catalogue.listPublic, {})).items).toEqual([]);
  });
  it("denies anonymous paid embedding, fences cache leases, and stores hashes instead of raw searches", async () => {
    const f = await fixture();
    expect(
      searchRead.parse(
        await f.t.action(api.search.searchCatalogue, { query: "secret query" }),
      ),
    ).toEqual({ items: [], degraded: true });
    const first = await f.admin.mutation(
      internal.search.prepareQueryEmbedding,
      { query: "  Secret  Query " },
    );
    expect(first.status).toBe("admitted");
    if (first.status !== "admitted") throw new Error("Expected claim");
    const cached = await f.admin.mutation(
      internal.search.prepareQueryEmbedding,
      { query: "secret query" },
    );
    expect(cached.status).toBe("pending");
    await f.t.mutation(internal.search.finishQueryEmbedding, {
      id: first.id,
      leaseToken: "stale",
      embedding: Array(768).fill(0.1),
    });
    expect(
      (
        await f.admin.mutation(internal.search.prepareQueryEmbedding, {
          query: "secret query",
        })
      ).status,
    ).toBe("pending");
    await f.t.mutation(internal.search.finishQueryEmbedding, {
      id: first.id,
      leaseToken: first.leaseToken,
      embedding: Array(768).fill(0.1),
    });
    expect(
      (
        await f.admin.mutation(internal.search.prepareQueryEmbedding, {
          query: "secret query",
        })
      ).status,
    ).toBe("cached");
    expect(
      JSON.stringify(
        await f.t.run((ctx) => ctx.db.query("specEmbeddings").collect()),
      ),
    ).not.toContain("Secret");
  });
  it("requires admin for analytics and webhook history while permitting free successful callers to review", async () => {
    const f = await fixture();
    await expect(
      f.member.query(api.analytics.projectAnalytics, {
        orgSlug: "one",
        projectSlug: "echo",
      }),
    ).rejects.toThrow("Org admin");
    await expect(
      f.member.query(api.webhooks.listDeliveries, {
        projectId: f.project._id,
        paginationOpts: { cursor: null, numItems: 10 },
      }),
    ).rejects.toThrow("Org admin");
    await expect(
      f.consumer.mutation(api.reviews.upsert, {
        projectId: f.project._id,
        rating: 5,
      }),
    ).rejects.toThrow("successful");
    await f.t.run((ctx) =>
      ctx.db.insert("usageRollups", {
        kind: "lifetime_consumer_project",
        consumerOrganizationId: f.two,
        projectId: f.project._id,
        firstSuccessAt: NOW,
        lastSuccessAt: NOW,
        successfulCalls: 1,
        noticeRevision: 0,
        updatedAt: NOW,
      }),
    );
    const review = await f.consumer.mutation(api.reviews.upsert, {
      projectId: f.project._id,
      rating: 5,
      body: "Free endpoint worked",
    });
    expect(
      (await f.t.query(api.reviews.getAggregate, { projectId: f.project._id }))
        .averageRating,
    ).toBe(5);
    await expect(
      f.admin.mutation(api.reviews.upsert, {
        projectId: f.project._id,
        rating: 5,
      }),
    ).rejects.toThrow("Publisher organizations");
    await f.staff.mutation(api.reviews.moderate, {
      reviewId: review._id,
      action: "hidden",
      reason: "Evidence checked",
      expectedContentRevision: 1,
      expectedModerationGeneration: 1,
    });
    await f.consumer.mutation(api.reviews.upsert, {
      projectId: f.project._id,
      rating: 1,
      body: "Edited later",
    });
    const history = await f.staff.query(api.reviews.listModerationQueue, {
      mode: "history",
    });
    expect(history.page[0].item?.body).toBe("Free endpoint worked");
    expect(history.page[0].item?.rating).toBe(5);
    expect(
      (await f.t.query(api.reviews.getAggregate, { projectId: f.project._id }))
        .count,
    ).toBe(0);
    await expect(
      f.staff.mutation(api.reviews.moderate, {
        reviewId: review._id,
        action: "restored",
        reason: "Stale decision",
        expectedContentRevision: 1,
        expectedModerationGeneration: 2,
      }),
    ).rejects.toThrow("stale");
  });
  it("keeps email dormant and notification ownership scoped while preserving canonical unread updates", async () => {
    const f = await fixture(),
      id = await f.t.run(
        async (ctx) =>
          (
            await createNotification(ctx, {
              organizationId: f.one,
              kind: "low_balance",
              title: "Low balance",
              body: "Top up",
              refId: "balance-one",
            })
          ).id!,
      );
    expect((await f.t.run((ctx) => ctx.db.get(id)))?.emailState).toBe(
      "skipped",
    );
    await expect(
      f.consumer.mutation(api.notifications.markRead, { notificationId: id }),
    ).rejects.toThrow("Not a member");
    await f.member.mutation(api.notifications.markRead, { notificationId: id });
    expect(
      (
        await f.member.query(api.notifications.unreadForOrg, {
          orgSlug: "forged",
        })
      ).unreadCount,
    ).toBe(1);
    await f.member.mutation(api.notifications.markAllRead, { orgSlug: "one" });
    expect(
      (await f.member.query(api.notifications.unreadForOrg, { orgSlug: "one" }))
        .unreadCount,
    ).toBe(0);
  });
  it("leases probes, suspends after three failures, and restores only after three fresh passes", async () => {
    const f = await fixture();
    async function probe(outcome: "healthy" | "timeout") {
      await f.t.mutation(internal.quality.runDueProbes, {});
      const p = await f.t.run((ctx) => ctx.db.get(f.project._id));
      const executionId = p!.quality.leaseId!;
      await f.t.mutation(internal.quality.recordProbeResult, {
        targetId: f.project._id,
        executionId,
        outcome,
      });
      expect(
        (
          await f.t.mutation(internal.quality.recordProbeResult, {
            targetId: f.project._id,
            executionId,
            outcome,
          })
        ).applied,
      ).toBe(false);
      vi.advanceTimersByTime(300001);
    }
    await probe("timeout");
    await probe("timeout");
    await probe("timeout");
    expect((await f.t.query(api.catalogue.listPublic, {})).items).toEqual([]);
    await probe("healthy");
    await probe("healthy");
    expect((await f.t.query(api.catalogue.listPublic, {})).items).toEqual([]);
    await probe("healthy");
    expect((await f.t.query(api.catalogue.listPublic, {})).items).toHaveLength(
      1,
    );
    const incidents = await f.t.query(api.quality.listPublicIncidents, {
      projectId: f.project._id,
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(incidents.page[0].status).toBe("resolved");
  });
  it("preserves a delivery's signing generation during grace and rejects stale completion", async () => {
    const f = await fixture();
    await f.admin.mutation(api.webhooks.upsertEndpoint, {
      projectId: f.project._id,
      url: "https://hooks.example.com/events",
    });
    const secret = await f.admin.mutation(api.webhooks.revealSecret, {
      projectId: f.project._id,
    });
    expect(secret?.secret).toBeTruthy();
    expect(
      await f.admin.mutation(api.webhooks.revealSecret, {
        projectId: f.project._id,
      }),
    ).toBeNull();
    await f.t.run((ctx) =>
      fireWebhookEvent(ctx, f.project._id, "spec.published", {}),
    );
    const delivery = (await f.t.run((ctx) =>
      ctx.db.query("webhookDeliveries").first(),
    ))!;
    await f.admin.mutation(api.webhooks.rotateSecret, {
      projectId: f.project._id,
      graceSeconds: 60,
    });
    expect(
      await f.t.mutation(internal.webhooks.claimDelivery, {
        deliveryId: delivery._id,
        leaseToken: "owner",
      }),
    ).toMatchObject({ secretVersion: delivery.secretVersion });
    await f.t.mutation(internal.webhooks.recordDeliveryAttempt, {
      deliveryId: delivery._id,
      leaseToken: "stale",
      ok: true,
    });
    expect((await f.t.run((ctx) => ctx.db.get(delivery._id)))?.state).toBe(
      "processing",
    );
    vi.advanceTimersByTime(60001);
    expect(
      await f.t.mutation(internal.webhooks.claimDelivery, {
        deliveryId: delivery._id,
        leaseToken: "retry",
      }),
    ).toBeNull();
    expect((await f.t.run((ctx) => ctx.db.get(delivery._id)))?.state).toBe(
      "needs_review",
    );
  });
  it("returns bounded pages across 10,001 listings and exact rollup totals independent of traffic rows", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      for (let i = 0; i < 10000; i++) {
        const id = await ctx.db.insert("projects", {
          ...projectFields,
          organizationId: f.one,
          name: `Item ${i}`,
          slug: `item-${i}`,
          sortName: `item-${i}`,
          status: "published",
          visibility: "public",
          discoverable: true,
          endpointCount: 1,
          minCost: 0,
          maxCost: 0,
        });
        await syncCatalogue(ctx, null, (await ctx.db.get(id))!);
      }
      await ctx.db.insert("usageRollups", {
        kind: "daily",
        scope: "publisher",
        scopeId: f.one,
        dimension: "project",
        dimensionKey: f.project._id,
        shard: 0,
        day: utcDay(NOW),
        calls: 20000,
        grossCredits: 120000,
        netAtoms: 1140000000,
        pendingRiskAtoms: 0,
        reversedAtoms: 0,
        failedAtoms: 0,
        success: 19000,
        errors4xx: 900,
        errors5xx: 100,
        latencyHistogram: [0, 20000, 0, 0, 0, 0, 0, 0],
        updatedAt: NOW,
      });
    });
    const measured = await f.t.run((ctx) =>
      measure(ctx, (c) =>
        browse(c, {
          paginationOpts: { cursor: null, numItems: 500 },
        }),
      ),
    );
    const page = measured.result;
    expect(measured.readBytes).toBeLessThan(200000);
    expect(measured.readRowsByIndex.by_discoverable_newest).toBe(50);
    expect(page.page).toHaveLength(50);
    expect(page.isDone).toBe(false);
    expect(page.total).toBe(10001);
    const stats = await f.admin.query(api.analytics.projectAnalytics, {
      orgSlug: "one",
      projectSlug: "echo",
    });
    expect(stats).toMatchObject({
      calls: 20000,
      credits: 120000,
      truncated: false,
      latencyPrecision: "histogram",
    });
  }, 60000);
});

it("guards operator actions and records exception disposition without money effects", async () => {
  const f = await fixture();
  const id = await f.t.run((ctx) =>
    ctx.db.insert("financeReconciliationCases", {
      rowKind: "case",
      kind: "settlement_exception",
      status: "open",
      reason: "Source disappeared",
      operationId: "exception:test",
      candidateCount: 0,
      attempts: 0,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
  await expect(
    f.member.query(api.operators.payments, {
      paginationOpts: { cursor: null, numItems: 25 },
    }),
  ).rejects.toThrow("Staff");
  await expect(
    f.member.action(api.operators.resolveException, {
      caseId: id,
      disposition: "void",
      resolution: "Reviewed source evidence",
    }),
  ).rejects.toThrow("Staff");
  await f.staff.action(api.operators.resolveException, {
    caseId: id,
    disposition: "void",
    resolution: "Reviewed source evidence",
  });
  await f.staff.action(api.operators.resolveException, {
    caseId: id,
    disposition: "void",
    resolution: "Reviewed source evidence",
  });
  const effects = await f.t.run(async (ctx) => ({
    case: await ctx.db.get(id),
    wallet: await ctx.db.query("walletEntries").collect(),
    publisher: await ctx.db.query("publisherLedgerEntries").collect(),
  }));
  expect(effects.case).toMatchObject({
    status: "resolved",
    resolution: "void: staff: Reviewed source evidence",
  });
  expect(effects.wallet).toEqual([]);
  expect(effects.publisher).toEqual([]);
  await expect(
    f.staff.action(api.operators.resolveException, {
      caseId: id,
      disposition: "resolved",
      resolution: "Different disposition",
    }),
  ).rejects.toThrow("facts changed");
});
it("scopes import leases to verified principals and releases idempotently", async () => {
  const f = await fixture();
  const first = await f.member.mutation(api.specImportLimits.acquire, {
    leaseId: "request-one",
  });
  expect(
    await f.member.mutation(api.specImportLimits.acquire, {
      leaseId: "request-one",
    }),
  ).toEqual(first);
  await f.member.mutation(api.specImportLimits.acquire, {
    leaseId: "request-two",
  });
  await expect(
    f.member.mutation(api.specImportLimits.acquire, {
      leaseId: "request-three",
    }),
  ).rejects.toThrow("already running");
  expect(
    await f.consumer.mutation(api.specImportLimits.release, {
      leaseId: "request-one",
    }),
  ).toEqual({ released: false });
  await f.member.mutation(api.specImportLimits.release, {
    leaseId: "request-one",
  });
  expect(
    await f.member.mutation(api.specImportLimits.release, {
      leaseId: "request-one",
    }),
  ).toEqual({ released: false });
});

it("abandons only drained admin closes and preserves wallet ledger balance", async () => {
  const { moneyFixture } = await import("./moneyFixtures"),
    { acknowledgeDrain } = await import("../convex/money/barrier");
  const t = harness(),
    f = await t.run((ctx) => moneyFixture(ctx, "operator-close", [100])),
    staff = t.withIdentity({ subject: "staff" });
  const begin = await t.mutation(internal.wallets.beginDecrease, {
    walletId: f.walletId,
    credits: 101,
    operationId: "operator-decrease",
  });
  const args = {
    walletId: f.walletId,
    closeId: begin.closeId!,
    reason: "Reviewed drain and canceled adjustment",
  };
  await expect(
    staff.mutation(api.operators.abandonAdminClose, args),
  ).rejects.toThrow("drained");
  await t.run(async (ctx) => {
    const w = (await ctx.db.get(f.walletId))!,
      c = w.close!;
    await acknowledgeDrain(ctx, {
      protocolVersion: 2,
      deploymentId: "next-fixture",
      walletId: w._id,
      ownerKey: w.ownerKey,
      epoch: w.epoch,
      gateRevision: w.gateRevision,
      closeId: c.id,
      requestedAt: c.requestedAt,
      reason: c.reason,
      edgeFinalSequence: 0,
      settledThroughEdgeSequence: 0,
      sealedAt: NOW,
    });
  });
  expect(await staff.mutation(api.operators.abandonAdminClose, args)).toEqual({
    state: "open",
  });
  expect(await staff.mutation(api.operators.abandonAdminClose, args)).toEqual({
    state: "open",
  });
  const state = await t.run(async (ctx) => ({
    wallet: await ctx.db.get(f.walletId),
    entries: await ctx.db
      .query("walletEntries")
      .withIndex("by_wallet_sequence", (q) => q.eq("walletId", f.walletId))
      .collect(),
  }));
  expect(state.wallet?.balance).toBe(100);
  expect(state.entries.every((e) => e.kind === "grant")).toBe(true);
});
