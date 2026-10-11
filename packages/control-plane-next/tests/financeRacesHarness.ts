import schema from "../convex/schema";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../convex/_generated/server";
import { financeFixture, drain } from "./financeFixtures";
import { eventFor, assertWallet } from "./moneyFixtures";
import { projectPaid } from "../convex/billing";
import { paidFact } from "../convex/lib/stripe";
import {
  projectAdjustment,
  reconcilePaymentPage,
} from "../convex/money/adjustments";
import { settleOne } from "../convex/money/settle";
import { releaseEarning } from "../convex/money/publisherLedger";
import {
  prepareTransfer,
  claimTransfer,
  projectTransfer,
} from "../convex/money/transfers";
import type { Id } from "../convex/_generated/dataModel";
import { measure } from "./measureDb";
export const seed = internalMutation({
  args: { run: v.string() },
  handler: async (ctx, a) => {
    const f = await financeFixture(ctx, a.run, 100000, 0);
    const first = (await ctx.db.get(
      ctx.db.normalizeId("checkoutIntents", f.paid.intentId)!,
    ))!;
    const { _id, _creationTime, ...value } = first;
    const intent = await ctx.db.insert("checkoutIntents", {
      ...value,
      sessionId: undefined,
      paymentIntentId: undefined,
      status: "open",
    });
    return {
      ...f,
      unpaid: {
        ...f.paid,
        intentId: intent,
        sessionId: `cs_second_${a.run}`,
        paymentIntentId: `pi_second_${a.run}`,
        chargeId: `ch_second_${a.run}`,
      },
    };
  },
});
export const paid = internalMutation({
  args: { json: v.string() },
  handler: (ctx, a) => projectPaid(ctx, paidFact.parse(JSON.parse(a.json))),
});
export const consume = internalMutation({
  args: { fixture: v.string(), sequence: v.number() },
  handler: async (ctx, a) => {
    const f = JSON.parse(a.fixture) as Awaited<
      ReturnType<typeof financeFixture>
    >;
    return settleOne(ctx, await eventFor(ctx, f, a.sequence));
  },
});
export const reverse = internalMutation({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, a) => {
    const p = (await ctx.db.get(a.paymentId))!;
    await projectAdjustment(ctx, p._id, p.revision, {
      kind: "refund",
      status: "succeeded",
      sourceRef: `re_${p._id}`,
      amountCents: p.amountPaidCents,
    });
    return (await ctx.db.get(p._id))!.reconciliation.generation;
  },
});
export const ack = internalMutation({
  args: { walletId: v.id("wallets") },
  handler: (ctx, a) => drain(ctx, a.walletId),
});
export const page = internalMutation({
  args: { paymentId: v.id("payments"), generation: v.number() },
  handler: (ctx, a) =>
    measure(ctx, (c) => reconcilePaymentPage(c, a.paymentId, a.generation)),
});
export const release = internalMutation({
  args: { publisherId: v.id("organizations") },
  handler: async (ctx, a) => {
    const e = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_publisher_day", (q) =>
        q.eq("publisherOrganizationId", a.publisherId),
      )
      .first();
    if (!e) throw new Error("Missing earning");
    await ctx.db.patch(e._id, { availableAt: 0 });
    return releaseEarning(ctx, e._id);
  },
});
export const allocate = internalMutation({
  args: { publisherId: v.id("organizations") },
  handler: async (ctx, a) =>
    prepareTransfer(ctx, (await ctx.db.get(a.publisherId))!),
});
export const dispatch = internalMutation({
  args: { id: v.id("publisherTransfers") },
  handler: (ctx, a) => claimTransfer(ctx, a.id),
});
export const pay = internalMutation({
  args: { id: v.id("publisherTransfers") },
  handler: async (ctx, a) => {
    const t = (await ctx.db.get(a.id))!;
    return projectTransfer(ctx, t._id, {
      id: `tr_${t._id}`,
      amount: t.amountCents,
      currency: t.currency,
      destination: t.destination,
      livemode: false,
      platformAccountId: t.platformAccountId,
      nonce: t.operationNonce,
      fingerprint: t.requestFingerprint,
      reversedCents: 0,
    });
  },
});
export const audit = internalQuery({
  args: { walletId: v.id("wallets"), publisherId: v.id("organizations") },
  handler: async (ctx, a) => {
    const wallet = await assertWallet(ctx, a.walletId);
    const b = await ctx.db
      .query("publisherBalances")
      .withIndex("by_publisher", (q) =>
        q.eq("publisherOrganizationId", a.publisherId),
      )
      .unique();
    return { wallet, balance: b };
  },
});
export const races = internalAction({
  args: {},
  handler: async (ctx) => {
    const seedRef = makeFunctionReference<
      "mutation",
      { run: string },
      Awaited<ReturnType<typeof financeFixture>> & {
        unpaid: ReturnType<typeof paidFact.parse>;
      }
    >("financeRaces:seed");
    const paidRef = makeFunctionReference<
      "mutation",
      { json: string },
      Id<"payments">
    >("financeRaces:paid");
    const consumeRef = makeFunctionReference<
      "mutation",
      { fixture: string; sequence: number }
    >("financeRaces:consume");
    const reverseRef = makeFunctionReference<
      "mutation",
      { paymentId: Id<"payments"> },
      number
    >("financeRaces:reverse");
    const ackRef = makeFunctionReference<
      "mutation",
      { walletId: Id<"wallets"> }
    >("financeRaces:ack");
    const pageRef = makeFunctionReference<
      "mutation",
      { paymentId: Id<"payments">; generation: number },
      {
        result: string;
        writes: number;
        argumentBytes: number;
        readBytes: number;
        documentWriteBytes: number;
      }
    >("financeRaces:page");
    const releaseRef = makeFunctionReference<
      "mutation",
      { publisherId: Id<"organizations"> },
      boolean
    >("financeRaces:release");
    const allocateRef = makeFunctionReference<
      "mutation",
      { publisherId: Id<"organizations"> },
      Id<"publisherTransfers">
    >("financeRaces:allocate");
    const dispatchRef = makeFunctionReference<
      "mutation",
      { id: Id<"publisherTransfers"> },
      unknown
    >("financeRaces:dispatch");
    const payRef = makeFunctionReference<
      "mutation",
      { id: Id<"publisherTransfers"> }
    >("financeRaces:pay");
    const auditRef = makeFunctionReference<
      "query",
      { walletId: Id<"wallets">; publisherId: Id<"organizations"> },
      {
        wallet: { balance: number };
        balance: {
          availableAtoms: number;
          allocatedAtoms: number;
          paidAtoms: number;
        } | null;
      }
    >("financeRaces:audit");
    let conflictRetries = 0;
    const eight = async <T>(work: () => Promise<T>): Promise<T[]> => {
      const raced = await Promise.allSettled(Array.from({ length: 8 }, work));
      const values: T[] = [];
      for (const result of raced) {
        if (result.status === "fulfilled") values.push(result.value);
        else {
          // Eight advancing workers can exhaust Convex's internal OCC retry limit.
          // Production recovery retries the whole mutation; retry that rejection only.
          if (!String(result.reason).includes("changed while this mutation"))
            throw result.reason;
          conflictRetries++;
          values.push(await work());
        }
      }
      return values;
    };
    const f = await ctx.runMutation(seedRef, { run: crypto.randomUUID() });
    const payments = await eight(() =>
      ctx.runMutation(paidRef, { json: JSON.stringify(f.unpaid) }),
    );
    if (new Set(payments).size !== 1) throw new Error("Payment granted twice");
    await ctx.runMutation(consumeRef, {
      fixture: JSON.stringify(f),
      sequence: 1,
    });
    await ctx.runMutation(consumeRef, {
      fixture: JSON.stringify(f),
      sequence: 2,
    });
    const released = await eight(() =>
      ctx.runMutation(releaseRef, { publisherId: f.publisher }),
    );
    if (released.filter(Boolean).length !== 1)
      throw new Error("Release replay race");
    // Release the other payment bucket too; the first remains an idempotent no-op above.
    // Both calls have different ref shards: allocate requires the first $9.50 plus a real second release.
    const secondRelease = makeFunctionReference<
      "mutation",
      { publisherId: Id<"organizations"> }
    >("financeRaces:releaseAll");
    await ctx.runMutation(secondRelease, { publisherId: f.publisher });
    const transfers = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        ctx.runMutation(allocateRef, { publisherId: f.publisher }),
      ),
    );
    const allocated = transfers.filter(
      (r): r is PromiseFulfilledResult<Id<"publisherTransfers">> =>
        r.status === "fulfilled",
    );
    if (allocated.length !== 1) throw new Error("Allocation race");
    const id = allocated[0].value;
    const claims = await eight(() => ctx.runMutation(dispatchRef, { id }));
    if (claims.filter(Boolean).length !== 1)
      throw new Error("Dispatch lease race");
    await eight(() => ctx.runMutation(payRef, { id }));
    const generations = await eight(() =>
      ctx.runMutation(reverseRef, { paymentId: f.paymentId }),
    );
    if (new Set(generations).size !== 1)
      throw new Error("Adjustment duplicated generation");
    const args = { paymentId: f.paymentId, generation: generations[0] };
    const waiting = await eight(() => ctx.runMutation(pageRef, args));
    if (waiting.some((p) => p.result !== "waiting"))
      throw new Error("Reclaimed before drain");
    await ctx.runMutation(ackRef, { walletId: f.walletId });
    for (let pass = 0; pass < 20; pass++) {
      const pages = await eight(() => ctx.runMutation(pageRef, args));
      for (const p of pages)
        if (
          p.writes > 150 ||
          p.argumentBytes > 200000 ||
          p.readBytes > 1000000 ||
          p.documentWriteBytes > 1000000
        )
          throw new Error("Finance page exceeded measured budget");
      if (pages.every((p) => p.result === "done")) break;
    }
    const audit = await ctx.runQuery(auditRef, {
      walletId: f.walletId,
      publisherId: f.publisher,
    });
    if (
      audit.wallet.balance !== 0 ||
      audit.balance?.availableAtoms !== -950000000 ||
      audit.balance.paidAtoms !== 1900000000
    )
      throw new Error("Finance race conservation");
    console.log(
      "PR4 local OCC: payment grant, release, allocation, dispatch, projection, refund, drain, concurrent page recovery passed",
      { conflictRetries },
    );
  },
});
export const releaseAll = internalMutation({
  args: { publisherId: v.id("organizations") },
  handler: async (ctx, a) => {
    const es = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_publisher_day", (q) =>
        q.eq("publisherOrganizationId", a.publisherId),
      )
      .take(8);
    for (const e of es) {
      await ctx.db.patch(e._id, { availableAt: 0 });
      await releaseEarning(ctx, e._id);
    }
  },
});

export const largeSeed = internalMutation({
  args: { run: v.string() },
  handler: async (ctx, a) => {
    const f = await financeFixture(ctx, a.run, 10001, 0);
    await settleOne(ctx, await eventFor(ctx, f, 1));
    const e = (await ctx.db
      .query("publisherEarnings")
      .withIndex("by_payment", (q) => q.eq("paymentId", f.paymentId))
      .first())!;
    await ctx.db.delete(e._id);
    for (const dimension of ["total", "project"] as const) {
      const row = await ctx.db
        .query("usageRollups")
        .withIndex("by_daily", (q) =>
          q
            .eq("kind", "daily")
            .eq("scope", "publisher")
            .eq("scopeId", f.publisher)
            .eq("day", e.day)
            .eq("dimension", dimension)
            .eq("dimensionKey", dimension === "total" ? "all" : f.project)
            .eq("shard", dimension === "total" ? e.shard : e.shard % 16),
        )
        .unique();
      if (row) await ctx.db.patch(row._id, { pendingRiskAtoms: 0 });
    }
    return { f, earningJson: JSON.stringify(e) };
  },
});
export const largeSeedPage = internalMutation({
  args: { earningJson: v.string(), offset: v.number() },
  handler: async (ctx, a) => {
    const e = JSON.parse(
      a.earningJson,
    ) as import("../convex/_generated/dataModel").Doc<"publisherEarnings">;
    const { _id, _creationTime, ...base } = e;
    for (let i = a.offset; i < Math.min(10001, a.offset + 100); i++) {
      const day = new Date(Date.UTC(1990, 0, 1) + i * 86400000)
        .toISOString()
        .slice(0, 10);
      await ctx.db.insert("publisherEarnings", {
        ...base,
        day,
        grossCredits: 1,
        netAtoms: 9500,
        platformFeeAtoms: 500,
      });
      for (const dimension of ["total", "project"] as const)
        await ctx.db.insert("usageRollups", {
          kind: "daily",
          scope: "publisher",
          scopeId: e.publisherOrganizationId,
          dimension,
          dimensionKey: dimension === "total" ? "all" : e.projectId,
          shard: dimension === "total" ? e.shard : e.shard % 16,
          day,
          calls: 0,
          grossCredits: 0,
          netAtoms: 0,
          pendingRiskAtoms: 9500,
          reversedAtoms: 0,
          failedAtoms: 0,
          success: 0,
          errors4xx: 0,
          errors5xx: 0,
          latencyHistogram: Array<number>(12).fill(0),
          updatedAt: Date.now(),
        });
    }
  },
});
export const largeAudit = internalQuery({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, a) => {
    const p = (await ctx.db.get(a.paymentId))!;
    if (
      p.reconciliation.state !== "complete" ||
      p.reconciliation.publisherTargetCredits !== 10001 ||
      p.reconciliation.walletReversedCredits !== 89999
    )
      throw new Error("Large reconciliation failed conservation");
    return p.reconciliation;
  },
});
export const largeStart = internalAction({
  args: {},
  handler: async (ctx) => {
    const start = makeFunctionReference<
      "mutation",
      { run: string },
      { f: Awaited<ReturnType<typeof financeFixture>>; earningJson: string }
    >("financeRaces:largeSeed");
    const seedPage = makeFunctionReference<
      "mutation",
      { earningJson: string; offset: number }
    >("financeRaces:largeSeedPage");
    const reverseRef = makeFunctionReference<
      "mutation",
      { paymentId: Id<"payments"> },
      number
    >("financeRaces:reverse");
    const ackRef = makeFunctionReference<
      "mutation",
      { walletId: Id<"wallets"> }
    >("financeRaces:ack");
    const { f, earningJson } = await ctx.runMutation(start, {
      run: crypto.randomUUID(),
    });
    for (let offset = 0; offset < 10001; offset += 100)
      await ctx.runMutation(seedPage, { earningJson, offset });
    const generation = await ctx.runMutation(reverseRef, {
      paymentId: f.paymentId,
    });
    await ctx.runMutation(ackRef, { walletId: f.walletId });
    return {
      paymentId: f.paymentId,
      generation,
      pages: 0,
      done: false,
      peak: {
        writes: 0,
        argumentBytes: 0,
        readBytes: 0,
        documentWriteBytes: 0,
      },
    };
  },
});
export const largeBatch = internalAction({
  args: {
    paymentId: v.id("payments"),
    generation: v.number(),
    pages: v.number(),
    done: v.boolean(),
    peak: v.object({
      writes: v.number(),
      argumentBytes: v.number(),
      readBytes: v.number(),
      documentWriteBytes: v.number(),
    }),
  },
  handler: async (ctx, a) => {
    const pageRef = makeFunctionReference<
      "mutation",
      { paymentId: Id<"payments">; generation: number },
      {
        result: string;
        writes: number;
        argumentBytes: number;
        readBytes: number;
        documentWriteBytes: number;
      }
    >("financeRaces:page");
    const auditRef = makeFunctionReference<
      "query",
      { paymentId: Id<"payments"> }
    >("financeRaces:largeAudit");
    const peak = { ...a.peak };
    let pages = a.pages;
    for (let batch = 0; batch < 200; batch++) {
      const page = await ctx.runMutation(pageRef, {
        paymentId: a.paymentId,
        generation: a.generation,
      });
      pages++;
      for (const key of Object.keys(peak) as (keyof typeof peak)[])
        peak[key] = Math.max(peak[key], page[key]);
      if (
        pages >= 1500 ||
        peak.writes > 150 ||
        peak.argumentBytes > 200000 ||
        peak.readBytes > 1000000 ||
        peak.documentWriteBytes > 1000000
      )
        throw new Error("Large reconciliation budget exceeded");
      if (page.result === "done") {
        if (pages < 1250) throw new Error("Large reconciliation skipped pages");
        await ctx.runQuery(auditRef, { paymentId: a.paymentId });
        return { ...a, pages, peak, done: true };
      }
    }
    return { ...a, pages, peak, done: false };
  },
});

// Test-only cleanup, copied solely into guarded anonymous-loopback scratch deployment.
export const resetPage = internalMutation({
  args: { table: v.string() },
  handler: async (ctx, a) => {
    if (process.env.NEXT_STRIPE_PLATFORM_ACCOUNT_ID !== "acct_fixture")
      throw new Error("Fixture reset only");
    if (!Object.keys(schema.tables).includes(a.table))
      throw new Error("Unknown fixture table");
    const rows = await ctx.db
      .query(a.table as import("../convex/_generated/dataModel").TableNames)
      .take(100);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});
export const reset = internalAction({
  args: {},
  handler: async (ctx) => {
    const page = makeFunctionReference<"mutation", { table: string }, number>(
      "financeRaces:resetPage",
    );
    for (const table of Object.keys(schema.tables)) {
      let count = 100;
      while (count === 100) count = await ctx.runMutation(page, { table });
    }
  },
});
