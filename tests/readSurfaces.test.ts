const clerkMocks = vi.hoisted(() => ({
  memberships: vi.fn<
    () => Promise<{
      data: { organization: { id: string } }[];
      totalCount: number;
    }>
  >(async () => ({ data: [], totalCount: 0 })),
}));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({
    users: { getOrganizationMembershipList: clerkMocks.memberships },
  }),
}));
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
const rateModules = import.meta.glob(
  "../node_modules/@convex-dev/rate-limiter/dist/component/**/*.js",
);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("ADMIN_USER_IDS", "staff");
  vi.stubEnv("CLERK_SECRET_KEY", "fixture");
  clerkMocks.memberships.mockResolvedValue({ data: [], totalCount: 0 });
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
  it("publishes scalar priced listings and facets and excludes archived publishers", async () => {
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
    const rows = await f.t.run((ctx) =>
      ctx.db.query("searchQueryEmbeddings").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.queryHash).toBe(await sha256Hex("secret query"));
    expect(JSON.stringify(rows).toLowerCase()).not.toContain("secret");
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
      f.member.query(api.earnings.forOrg, { orgSlug: "one" }),
    ).rejects.toThrow("Org admin");
    await expect(
      f.member.query(api.webhooks.listDeliveries, {
        projectId: f.project._id,
        paginationOpts: { cursor: null, numItems: 10 },
      }),
    ).rejects.toThrow("Org admin");
    await expect(
      f.consumer.action(api.reviews.upsert, {
        projectId: f.project._id,
        rating: 5,
      }),
    ).rejects.toThrow("successful");
    await usage(f);
    const review = await f.consumer.action(api.reviews.upsert, {
      projectId: f.project._id,
      rating: 5,
      body: "Free endpoint worked",
    });
    expect(
      (await f.t.query(api.reviews.getAggregate, { projectId: f.project._id }))
        .averageRating,
    ).toBe(5);
    await expect(
      f.admin.action(api.reviews.upsert, {
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
    await f.consumer.action(api.reviews.upsert, {
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
    expect(
      await f.t.run((ctx) =>
        ctx.db
          .query("notifications")
          .withIndex("by_ref", (q) =>
            q.eq("refId", `webhook_failed:${delivery._id}`),
          )
          .unique(),
      ),
    ).toMatchObject({ kind: "webhook_failed", adminOnly: true });
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
    });
    await usage(f);
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
      calls: 1,
      credits: 0,
      truncated: false,
      latencyPrecision: "histogram",
    });
    expect(stats?.endpoints).toHaveLength(1);
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

async function usage(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<
    import("../convex/_generated/dataModel").Doc<"usageEvents">
  > = {},
) {
  const { recordRollups } = await import("../convex/money/rollups");
  const { ensureWallet } = await import("../convex/money/walletLedger");
  return f.t.run(async (ctx) => {
    const p = (await ctx.db.get(f.project._id))!;
    const wallet = await ensureWallet(ctx, (await ctx.db.get(f.two))!);
    const ref = crypto.randomUUID();
    const id = await ctx.db.insert("usageEvents", {
      publicId: ref,
      walletId: wallet._id,
      consumerOrganizationId: f.two,
      publisherOrganizationId: f.one,
      projectId: p._id,
      specVersionId: p.latestVersionId!,
      ownerUserId: "consumer",
      operationId: "health",
      method: "GET",
      endpoint: "/health",
      projectName: p.name,
      projectSlug: p.slug,
      at: NOW,
      status: 200,
      latencyMs: 25,
      settleRefId: ref,
      reservationId: ref,
      epoch: 1,
      edgeSequence: 1,
      admissionFingerprint: ref,
      immutableFingerprint: ref,
      pricingDecision: "zero_price",
      listedCostCredits: 0,
      heldCredits: 0,
      credits: 0,
      billingOutcome: "free",
      qualityOutcome: "success",
      ambiguous: false,
      fundingSlices: [],
      ...overrides,
    });
    await recordRollups(ctx, (await ctx.db.get(id))!, NOW);
    return id;
  });
}
it("maintains real vectors across visibility changes and rejects stale embed completion", async () => {
  const f = await fixture();
  vi.stubEnv("GEMINI_API_KEY", "fake");
  const provider = vi.fn(async () =>
    Response.json({ embedding: { values: Array(768).fill(0.1) } }),
  );
  vi.stubGlobal("fetch", provider);
  try {
    await f.t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimersAsync());
    const vector = (await f.t.run((ctx) =>
      ctx.db.query("specEmbeddings").first(),
    ))!;
    expect(
      await f.t.query(internal.search.fetchSearchListings, {
        ids: [vector._id],
        scores: [1],
      }),
    ).toHaveLength(1);
    const stale = (await f.t.query(internal.search.getProjectForEmbed, {
      projectId: f.project._id,
    }))!;
    await f.staff.mutation(api.admin.setProjectVisibility, {
      organizationHandle: "one",
      projectSlug: "echo",
      visibility: "private",
    });
    expect(
      await f.t.run((ctx) => ctx.db.query("specEmbeddings").collect()),
    ).toEqual([]);
    await f.t.mutation(internal.search.upsertEmbedding, {
      projectId: f.project._id,
      specVersionId: stale.specVersionId,
      revision: stale.revision,
      text: "stale",
      embedding: Array(768).fill(0.1),
    });
    expect(
      await f.t.run((ctx) => ctx.db.query("specEmbeddings").collect()),
    ).toEqual([]);
    await f.staff.mutation(api.admin.setProjectVisibility, {
      organizationHandle: "one",
      projectSlug: "echo",
      visibility: "public",
    });
    await f.t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimersAsync());
    const fresh = (await f.t.run((ctx) =>
      ctx.db.query("specEmbeddings").first(),
    ))!;
    expect(
      await f.t.query(internal.search.fetchSearchListings, {
        ids: [fresh._id],
        scores: [1],
      }),
    ).toHaveLength(1);
    expect(provider).toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
it("exercises web and gateway HTTP secrets, attribution, cache-hit budgets and caller limits", async () => {
  const f = await fixture();
  vi.stubEnv("NEXT_WEB_SEARCH_SECRET", "web-secret-at-least-thirty-two-bytes");
  vi.stubEnv(
    "GATEWAY_INTERNAL_SECRET",
    "gateway-secret-at-least-thirty-two-bytes",
  );
  vi.stubEnv("GEMINI_API_KEY", "fake");
  const provider = vi.fn(async () =>
    Response.json({ embedding: { values: Array(768).fill(0.1) } }),
  );
  vi.stubGlobal("fetch", provider);
  const request = (
    path: string,
    body: unknown,
    secret = path === "/web-search"
      ? process.env.NEXT_WEB_SEARCH_SECRET!
      : process.env.GATEWAY_INTERNAL_SECRET!,
  ) =>
    f.t.fetch(path, {
      method: "POST",
      headers: {
        "x-internal-secret": secret,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    for (const path of ["/web-search", "/gateway-search"])
      expect((await request(path, { query: "query" }, "wrong")).status).toBe(
        401,
      );
    expect((await request("/web-search", { query: "query" })).status).toBe(400);
    expect(
      (
        await request("/web-search", {
          query: "query",
          anonymousKey: "a".repeat(64),
          caller: { orgId: "forged", keyId: "forged" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/gateway-search", {
          query: "query",
          anonymousKey: "a".repeat(64),
        })
      ).status,
    ).toBe(400);
    expect(
      await (await request("/gateway-search", { query: "query" })).json(),
    ).toMatchObject({ degraded: true });
    for (let i = 0; i < 180; i++) {
      const result = await request("/web-search", {
        query: "cached",
        anonymousKey: i.toString(16).padStart(64, "0"),
      });
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({ degraded: false });
    }
    expect(provider).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++)
      expect(
        await (
          await request("/gateway-search", {
            query: "cached",
            caller: { orgId: "same-org", keyId: `key-${i}` },
          })
        ).json(),
      ).toMatchObject({ degraded: false });
    expect(
      await (
        await request("/gateway-search", {
          query: "cached",
          caller: { orgId: "same-org", keyId: "rotated" },
        })
      ).json(),
    ).toMatchObject({ degraded: true });
    for (let i = 0; i < 30; i++)
      await request("/web-search", {
        query: "cached",
        anonymousKey: "f".repeat(64),
      });
    expect(
      await (
        await request("/web-search", {
          query: "cached",
          anonymousKey: "f".repeat(64),
        })
      ).json(),
    ).toMatchObject({ degraded: true });
    // Distinct trusted callers cannot evade the provider-wide cache-miss budget.
    for (let i = 0; i < 160; i++)
      await request("/web-search", {
        query: `miss-${i}`,
        anonymousKey: (i + 1000).toString(16).padStart(64, "0"),
      });
    expect(provider.mock.calls.length).toBeLessThanOrEqual(120);
    expect(
      await (
        await request("/web-search", {
          query: "cached",
          anonymousKey: "e".repeat(64),
        })
      ).json(),
    ).toMatchObject({ degraded: false });
  } finally {
    vi.unstubAllGlobals();
  }
});
it("uses rollup writer for eligibility negatives, per-user ownership, DTO privacy and dismissal", async () => {
  const f = await fixture();
  await usage(f, {
    status: 500,
    qualityOutcome: "server_error",
    billingOutcome: "refunded",
  });
  await usage(f, {
    status: 200,
    qualityOutcome: "success",
    billingOutcome: "refunded",
  });
  await expect(usage(f, { billingOutcome: "mock" as never })).rejects.toThrow(
    "Validator",
  );
  await expect(
    f.consumer.action(api.reviews.upsert, {
      projectId: f.project._id,
      rating: 4,
    }),
  ).rejects.toThrow("successful");
  await usage(f);
  const first = await f.consumer.action(api.reviews.upsert, {
    projectId: f.project._id,
    rating: 4,
  });
  const another = f.t.withIdentity(identity("two", "another", "org:member"));
  const second = await another.action(api.reviews.upsert, {
    projectId: f.project._id,
    rating: 3,
  });
  expect(first._id).not.toBe(second._id);
  await f.admin.mutation(api.reviews.respondAsPublisher, {
    reviewId: first._id,
    body: "Publisher response",
  });
  await expect(
    f.member.mutation(api.reviews.respondAsPublisher, {
      reviewId: first._id,
      body: "Unauthorized response",
    }),
  ).rejects.toThrow("Org admin");
  await f.t.run((ctx) =>
    ctx.db.patch(first._id, {
      latestReportReason: "Private report",
      hasOpenReports: true,
      openReportCount: 1,
      queueSortKey: "queue",
    }),
  );
  const viewer = await f.consumer.query(api.reviews.getViewerState, {
    projectId: f.project._id,
  });
  expect(JSON.stringify(viewer)).not.toContain("user_one");
  expect(JSON.stringify(viewer)).not.toContain("Private report");
  const reportId = await f.t.run((ctx) =>
    ctx.db.insert("reviewEvents", {
      kind: "report",
      reviewId: first._id,
      actorUserId: "reporter",
      at: NOW,
      sortKey: "report",
      contentRevision: 2,
      moderationGeneration: 1,
      reason: "Private report",
      status: "open",
    }),
  );
  await f.staff.mutation(api.reviews.moderate, {
    reviewId: first._id,
    action: "dismissed",
    reason: "No violation found",
    expectedContentRevision: 2,
    expectedModerationGeneration: 1,
  });
  await f.t.mutation(internal.reviews.resolveReportsPage, {
    reviewId: first._id,
    moderationGeneration: 1,
  });
  expect(await f.t.run((ctx) => ctx.db.get(reportId))).toMatchObject({
    status: "resolved",
  });
  expect(await f.t.run((ctx) => ctx.db.get(first._id))).toMatchObject({
    hidden: false,
    moderationGeneration: 2,
    openReportCount: 0,
  });
  clerkMocks.memberships.mockResolvedValueOnce({
    data: [{ organization: { id: "org_one" } }],
    totalCount: 1,
  });
  await expect(
    another.action(api.reviews.upsert, { projectId: f.project._id, rating: 5 }),
  ).rejects.toThrow("Publisher organizations");
  const detail = await f.t.query(api.catalogue.getPublicDetail, {
    publisherHandle: "one",
    projectSlug: "echo",
  });
  expect(
    JSON.parse(detail!.latestVersion!.spec).paths["/hidden"],
  ).toBeUndefined();
  expect(
    JSON.parse(detail!.latestVersion!.spec).paths["/health"].get[
      "x-zevium-cost"
    ],
  ).toBe(0);
});
it("excludes publisher self-traffic from measured quality", async () => {
  const f = await fixture();
  for (let i = 0; i < 22; i++)
    await usage(f, { consumerOrganizationId: f.one });
  const p = (await f.t.run((ctx) => ctx.db.get(f.project._id)))!;
  await f.t.mutation(internal.quality.recomputeGatewayQuality, {
    projectId: p._id,
    specVersionId: p.latestVersionId!,
  });
  expect(
    (await f.t.run((ctx) => ctx.db.get(p._id)))!.quality.snapshot,
  ).toMatchObject({ apiSampleSize: 0, insufficientApiData: true });
});
it("continues due probe work in paced pages beyond the first 20 projects", async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    for (let i = 0; i < 65; i++)
      await ctx.db.insert("projects", {
        ...projectFields,
        organizationId: f.one,
        slug: `probe-${i}`,
        quality: {
          snapshot: null,
          recoveryPasses: 0,
          nextProbeAt: NOW,
          probeTarget: { url: "https://example.com/health", method: "GET" },
        },
      });
  });
  await f.t.mutation(internal.quality.runDueProbes, {});
  const continuations = await f.t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  expect(
    continuations.some(
      (job) =>
        job.name === "quality:runDueProbes" && job.scheduledTime >= NOW + 1000,
    ),
  ).toBe(true);
  for (let i = 0; i < 3; i++)
    await f.t.mutation(internal.quality.runDueProbes, { cutoff: NOW });
  const projects = await f.t.run((ctx) => ctx.db.query("projects").collect());
  expect(projects.filter((p) => p.quality.leaseId)).toHaveLength(66);
});
it("re-arms low-balance notices after topping above threshold and never repeats while below", async () => {
  const { moneyFixture, eventFor } = await import("./moneyFixtures");
  const { settleOne } = await import("../convex/money/settle");
  const { grantLot } = await import("../convex/money/lots");
  const t = harness();
  vi.stubEnv(
    "NEXT_ADMISSION_KEYS",
    JSON.stringify({
      current: "k1",
      keys: { k1: "test-only-secret-never-use-in-production" },
    }),
  );
  await t.run(async (ctx) => {
    const f = await moneyFixture(ctx, "low-balance-crossing", [1000], 100);
    await settleOne(ctx, await eventFor(ctx, f, 1));
    await settleOne(ctx, await eventFor(ctx, f, 2));
    expect(
      (await ctx.db.query("notifications").collect()).filter(
        (n) => n.kind === "low_balance",
      ),
    ).toHaveLength(1);
    await grantLot(ctx, {
      walletId: f.walletId,
      sourceKind: "admin",
      sourceRef: "top-up",
      credits: 1000,
    });
    const wallet = (await ctx.db.get(f.walletId))!;
    // Actual settled calls drive the ledger below the threshold again.
    let sequence = 3;
    for (let remaining = wallet.balance; remaining >= 1000; remaining -= f.cost)
      await settleOne(ctx, await eventFor(ctx, f, sequence++));
    expect(
      (await ctx.db.query("notifications").collect()).filter(
        (n) => n.kind === "low_balance",
      ),
    ).toHaveLength(2);
  });
});

it("rate limits connection-test admission before upstream work", async () => {
  const f = await fixture();
  for (let i = 0; i < 5; i++)
    await f.admin.mutation(internal.publishReadiness.authorizeTest, {
      projectId: f.project._id,
    });
  await expect(
    f.admin.mutation(internal.publishReadiness.authorizeTest, {
      projectId: f.project._id,
    }),
  ).rejects.toThrow("Connection test limit reached");
});
