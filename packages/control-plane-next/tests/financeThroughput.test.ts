import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import rateLimiterSchema from "../node_modules/@convex-dev/rate-limiter/dist/component/schema.js";
import { harness } from "./helpers";
import { financeFixture, drain, PLATFORM } from "./financeFixtures";
import { eventFor } from "./moneyFixtures";
import { settleOne } from "../convex/money/settle";
import { projectAdjustment } from "../convex/money/adjustments";
import { internal } from "../convex/_generated/api";
import * as throughput from "../convex/money/throughput";
import { NOW, SECRET } from "./fixtures";

const rateLimiterModules = import.meta.glob(
  "../node_modules/@convex-dev/rate-limiter/dist/component/**/*.js",
);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXT_STRIPE_SECRET_KEY", ["sk", "test", "fixture"].join("_"));
  vi.stubEnv("NEXT_STRIPE_PLATFORM_ACCOUNT_ID", PLATFORM);
  vi.stubEnv("NEXT_ADMISSION_SECRET", SECRET);
  vi.stubEnv("NEXT_DEPLOYMENT_ID", "next-fixture");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
async function setup() {
  const t = harness();
  // Register the shipped component without its test helper's unpublished dev type dependencies.
  t.registerComponent("rateLimiter", rateLimiterSchema, rateLimiterModules);
  const f = await t.run((ctx) => financeFixture(ctx));
  const earningId = await t.run(async (ctx) => {
    await settleOne(ctx, await eventFor(ctx, f, 1));
    const e = (await ctx.db.query("publisherEarnings").first())!;
    await ctx.db.patch(e._id, { availableAt: 0 });
    return e._id;
  });
  const generation = await t.run(async (ctx) => {
    const p = (await ctx.db.get(f.paymentId))!;
    await projectAdjustment(ctx, f.paymentId, p.revision, {
      kind: "refund",
      status: "pending",
      sourceRef: "re_throughput",
      amountCents: 1020,
    });
    await drain(ctx, f.walletId);
    return (await ctx.db.get(f.paymentId))!.reconciliation.generation;
  });
  return { t, f, earningId, args: { paymentId: f.paymentId, generation } };
}
describe("finance deployment throughput", () => {
  it("shares one slot across payments and releases and preserves denied cursors", async () => {
    const { t, f, earningId, args } = await setup();
    expect(await t.mutation(internal.billing.reconcilePage, args)).toBe("more");
    const before = await t.run((ctx) => ctx.db.get(f.paymentId));
    expect(await t.mutation(internal.billing.reconcilePage, args)).toBe(
      "throttled",
    );
    expect(
      await t.mutation(internal.payouts.releaseOne, { id: earningId }),
    ).toBe("throttled");
    expect(await t.run((ctx) => ctx.db.get(f.paymentId))).toEqual(before);
    vi.setSystemTime(NOW + throughput.FINANCE_PAGE_INTERVAL_MS);
    expect(await t.mutation(internal.billing.reconcilePage, args)).toBe("more");
  });
  it("rolls back a page that exceeds the full-document byte budget", async () => {
    const { t, f } = await setup();
    const before = await t.run((ctx) => ctx.db.get(f.consumer));
    await expect(
      t.run((ctx) =>
        throughput.financePage(ctx, (bounded) =>
          bounded.db.patch(f.consumer, {
            name: "x".repeat(throughput.FINANCE_PAGE_WRITE_BYTES),
          }),
        ),
      ),
    ).rejects.toThrow("Finance page exceeds its write budget");
    expect(await t.run((ctx) => ctx.db.get(f.consumer))).toEqual(before);
    const rollup = (await t.run((ctx) =>
      ctx.db
        .query("usageRollups")
        .withIndex("by_daily", (q) => q.eq("kind", "daily"))
        .first(),
    ))!;
    // Two valid-sized arrays total ~32 KiB in JSON but ~144 KiB as Convex float64s.
    await expect(
      t.run((ctx) =>
        throughput.financePage(ctx, async (bounded) => {
          for (let i = 0; i < 2; i++)
            await bounded.db.patch(rollup._id, {
              latencyHistogram: Array<number>(8000).fill(0),
            });
        }),
      ),
    ).rejects.toThrow("Finance page exceeds its write budget");
    expect(await t.run((ctx) => ctx.db.get(rollup._id))).toEqual(rollup);
  });
  it("spaces scheduled page continuations", async () => {
    const { t, args } = await setup();
    await t.action(internal.billing.reconcile, args);
    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].scheduledTime).toBe(
      NOW + throughput.FINANCE_PAGE_INTERVAL_MS,
    );
  });
  it("backs off denied workers and spaces release discovery", async () => {
    const { t, earningId, args } = await setup();
    await t.mutation(internal.billing.reconcilePage, args);
    await t.action(internal.billing.reconcile, args);
    await t.action(internal.payouts.releaseSafely, { id: earningId });
    let jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(jobs).toHaveLength(2);
    expect(
      jobs.every(
        (job) =>
          job.scheduledTime === NOW + throughput.FINANCE_THROTTLE_RETRY_MS,
      ),
    ).toBe(true);
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...base } = (await ctx.db.get(earningId))!;
      for (let i = 0; i < 25; i++)
        await ctx.db.insert("publisherEarnings", {
          ...base,
          releaseAfter: NOW,
        });
    });
    await t.mutation(internal.payouts.releaseDue, {});
    jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const added = jobs.slice(2);
    expect(added).toHaveLength(26);
    expect(added.map((job) => job.scheduledTime).sort((a, b) => a - b)).toEqual(
      Array.from(
        { length: 26 },
        (_, i) => NOW + i * throughput.FINANCE_PAGE_INTERVAL_MS,
      ),
    );
  });
  it("retries deployment throughput errors without terminal payment or release cases", async () => {
    const { t, f, earningId, args } = await setup();
    vi.spyOn(throughput, "financePage").mockRejectedValue(
      new Error(
        "Too many writes per second. Your deployment is limited to 4 MiB bytes written per second.",
      ),
    );
    for (let i = 0; i < 10; i++) {
      await t.action(internal.billing.reconcile, args);
      await t.action(internal.payouts.releaseSafely, { id: earningId });
    }
    const p = (await t.run((ctx) => ctx.db.get(f.paymentId)))!;
    expect(p.reconciliation.attempts).toBe(0);
    expect(p.reconciliation.state).not.toBe("needs_review");
    expect(
      await t.run((ctx) =>
        ctx.db.query("financeReconciliationCases").collect(),
      ),
    ).toEqual([]);
    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(jobs).toHaveLength(20);
    expect(
      jobs.every(
        (job) =>
          job.scheduledTime === NOW + throughput.FINANCE_TRANSIENT_RETRY_MS,
      ),
    ).toBe(true);
    vi.restoreAllMocks();
    // The unchanged durable cursor can progress when the backend recovers.
    for (let i = 0; i < 20; i++) {
      vi.setSystemTime(NOW + i * throughput.FINANCE_PAGE_INTERVAL_MS);
      if ((await t.mutation(internal.billing.reconcilePage, args)) === "done")
        break;
    }
    expect(
      (await t.run((ctx) => ctx.db.get(f.paymentId)))!.reconciliation.state,
    ).toBe("complete");
  });
});
