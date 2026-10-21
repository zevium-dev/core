import { v, ConvexError } from "convex/values";
import { z } from "zod";
import type Stripe from "stripe";
import {
  internalMutation,
  internalQuery,
  internalAction,
  httpAction,
} from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { sha256Hex } from "@zevium/shared";
import {
  stripeClient,
  stripeConfig,
  verifiedStripe,
  providerId,
  paidFact,
  type PaidFact,
  id,
  cents,
} from "./lib/stripe";
import { projectPaid } from "./billing";
import { projectAdjustment } from "./money/adjustments";
import { openCase } from "./money/reconciliationCases";
import { transferFact } from "./payouts";
import { projectTransfer } from "./money/transfers";
import { add } from "./money/walletLedger";
// 84 exponential attempts (1-hour cap) span more than three days.
export const RECEIPT_MAX_ATTEMPTS = 84;
const receiptInput = z.object({
  eventId: id,
  eventType: id,
  objectId: id,
  account: id,
  sourceTimestamp: cents,
  payloadHash: z.string(),
  bodyHash: z.string().optional(),
  destination: z.enum(["platform", "connect", "v2"]),
  foreign: z.boolean(),
});
const projection = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("paid"), paid: paidFact }),
  z.object({
    kind: z.literal("adjustment"),
    paid: paidFact.optional(),
    chargeId: id,
    expectedRevision: cents,
    sourceRef: id,
    amountCents: cents,
    type: z.enum(["refund", "dispute"]),
    fundsWithdrawn: z.boolean().optional(),
    fundsReinstated: z.boolean().optional(),
    status: z.enum([
      "pending",
      "requires_action",
      "succeeded",
      "failed",
      "canceled",
      "open",
      "won",
      "lost",
    ]),
  }),
  z.object({
    kind: z.literal("transfer"),
    transferId: id,
    fact: z.object({
      id,
      amount: cents,
      currency: z.string(),
      destination: id,
      livemode: z.boolean(),
      platformAccountId: id,
      nonce: z.string(),
      fingerprint: z.string(),
      reversedCents: cents,
    }),
  }),
  z.object({
    kind: z.literal("payout"),
    expectedRevision: cents,
    id,
    accountId: id,
    amountCents: cents,
    currency: z.string(),
    status: z.enum(["pending", "in_transit", "paid", "failed", "canceled"]),
    arrivalDate: cents.optional(),
    failureCode: z.string().optional(),
  }),
  z.object({
    kind: z.literal("refund_page"),
    paid: paidFact,
    refundIds: z.array(id).max(50),
    cursor: id.optional(),
  }),
  z.object({ kind: z.literal("ignored") }),
  z.object({ kind: z.literal("foreign"), reason: z.string(), objectId: id }),
]);
export const receive = internalMutation({
  args: { json: v.string() },
  handler: async (ctx, args) => {
    const a = receiptInput.parse(JSON.parse(args.json));
    const old = await ctx.db
      .query("webhookReceipts")
      .withIndex("by_event", (q) =>
        q
          .eq("provider", "stripe")
          .eq("account", a.account)
          .eq("eventId", a.eventId),
      )
      .unique();
    if (old) {
      if (
        old.eventType !== a.eventType ||
        old.objectId !== a.objectId ||
        old.sourceTimestamp !== a.sourceTimestamp
      )
        throw new ConvexError("Webhook event identity conflict");
      if (old.bodyHash && a.bodyHash && old.bodyHash !== a.bodyHash)
        console.warn("Stripe redelivery body changed", { receiptId: old._id });
      await ctx.db.patch(old._id, { deliveries: add(old.deliveries, 1) });
      return old._id;
    }
    const receipt = await ctx.db.insert("webhookReceipts", {
      provider: "stripe",
      account: a.account,
      eventId: a.eventId,
      eventType: a.eventType,
      objectId: a.objectId,
      sourceTimestamp: a.sourceTimestamp,
      payloadHash: a.payloadHash,
      bodyHash: a.bodyHash,
      destination: a.destination,
      receivedAt: Date.now(),
      state: a.foreign ? "needs_review" : "pending",
      attempts: 0,
      deliveries: 1,
      nextAttemptAt: a.foreign ? undefined : Date.now(),
    });
    if (a.foreign)
      await openCase(
        ctx,
        {
          kind: "foreign_stripe_event",
          operationId: `stripe:${a.account}:${a.eventId}`,
          reason: "Unexpected Stripe account or mode",
        },
        a.objectId,
      );
    else
      await ctx.scheduler.runAfter(0, internal.stripeEvents.processReceipt, {
        id: receipt,
      });
    return receipt;
  },
});
export const claim = internalMutation({
  args: { id: v.id("webhookReceipts") },
  handler: async (ctx, args) => {
    const r = await ctx.db.get(args.id);
    if (
      !r ||
      r.provider !== "stripe" ||
      r.state === "complete" ||
      r.state === "needs_review" ||
      (r.leaseUntil ?? 0) > Date.now()
    )
      return null;
    const token = crypto.randomUUID();
    await ctx.db.patch(r._id, {
      state: "processing",
      attempts: add(r.attempts, 1),
      leaseToken: token,
      leaseUntil: Date.now() + 300000,
      nextAttemptAt: undefined,
    });
    return { ...r, leaseToken: token };
  },
});
export const complete = internalMutation({
  args: { id: v.id("webhookReceipts"), token: v.string(), json: v.string() },
  handler: async (ctx, args) => {
    const r = await ctx.db.get(args.id);
    if (
      !r ||
      r.state !== "processing" ||
      r.leaseToken !== args.token ||
      (r.leaseUntil ?? 0) < Date.now()
    )
      throw new ConvexError("Stale webhook worker");
    const a = projection.parse(JSON.parse(args.json));
    if (a.kind === "paid") await projectPaid(ctx, a.paid);
    if (a.kind === "adjustment") {
      if (a.paid) await projectPaid(ctx, a.paid);
      const p = await ctx.db
        .query("payments")
        .withIndex("by_charge", (q) => q.eq("stripeChargeId", a.chargeId))
        .unique();
      if (!p || p.providerAccount !== r.account)
        throw new ConvexError("Payment not found");
      if (a.type === "refund") {
        const status = z
          .enum([
            "pending",
            "requires_action",
            "succeeded",
            "failed",
            "canceled",
          ])
          .parse(a.status);
        await projectAdjustment(ctx, p._id, a.expectedRevision, {
          kind: "refund",
          status,
          sourceRef: a.sourceRef,
          amountCents: a.amountCents,
        });
      } else {
        const status = z.enum(["open", "won", "lost"]).parse(a.status);
        await projectAdjustment(ctx, p._id, a.expectedRevision, {
          kind: "dispute",
          status,
          sourceRef: a.sourceRef,
          amountCents: a.amountCents,
          fundsWithdrawn: z.boolean().parse(a.fundsWithdrawn),
          fundsReinstated: z.boolean().parse(a.fundsReinstated),
        });
      }
      const changed = (await ctx.db.get(p._id))!;
      await ctx.scheduler.runAfter(0, internal.billing.reconcile, {
        paymentId: p._id,
        generation: changed.reconciliation.generation,
      });
    }
    if (a.kind === "refund_page") {
      await projectPaid(ctx, a.paid);
      for (const objectId of a.refundIds) {
        const eventId = `${r.eventId}:${objectId}`;
        const prior = await ctx.db
          .query("webhookReceipts")
          .withIndex("by_event", (q) =>
            q
              .eq("provider", "stripe")
              .eq("account", r.account)
              .eq("eventId", eventId),
          )
          .unique();
        if (!prior) {
          const child = await ctx.db.insert("webhookReceipts", {
            provider: "stripe",
            account: r.account,
            eventId,
            eventType: "refund.updated",
            objectId,
            sourceTimestamp: r.sourceTimestamp,
            receivedAt: Date.now(),
            destination: "platform",
            state: "pending",
            attempts: 0,
            deliveries: 1,
            nextAttemptAt: Date.now(),
          });
          await ctx.scheduler.runAfter(
            0,
            internal.stripeEvents.processReceipt,
            { id: child },
          );
        }
      }
      if (a.cursor) {
        await ctx.db.patch(r._id, {
          state: "retry",
          providerCursor: a.cursor,
          leaseToken: undefined,
          leaseUntil: undefined,
          nextAttemptAt: Date.now(),
          attempts: 0,
        });
        await ctx.scheduler.runAfter(0, internal.stripeEvents.processReceipt, {
          id: r._id,
        });
        return;
      }
    }
    if (a.kind === "transfer") {
      const transferId = ctx.db.normalizeId("publisherTransfers", a.transferId);
      if (!transferId) throw new ConvexError("Transfer not found");
      await projectTransfer(ctx, transferId, a.fact);
    }
    if (a.kind === "payout") {
      const org = await ctx.db
        .query("organizations")
        .withIndex("by_connect", (q) => q.eq("connect.accountId", a.accountId))
        .unique();
      if (
        !org ||
        a.accountId !== r.account ||
        org.connect?.livemode ||
        org.connect?.platformAccountId !== stripeConfig().account
      )
        throw new ConvexError("Payout account mismatch");
      const prior = await ctx.db
        .query("connectedPayouts")
        .withIndex("by_provider", (q) => q.eq("providerPayoutId", a.id))
        .unique();
      if ((prior?.revision ?? 0) !== a.expectedRevision)
        throw new ConvexError("Payout changed; refetch canonical facts");
      if (
        prior &&
        (prior.accountId !== a.accountId ||
          prior.amountCents !== a.amountCents ||
          prior.currency !== a.currency)
      )
        throw new ConvexError("Payout identity conflict");
      const value = {
        revision: (prior?.revision ?? 0) + 1,
        accountId: a.accountId,
        providerPayoutId: a.id,
        amountCents: a.amountCents,
        currency: a.currency,
        status: a.status,
        arrivalDate: a.arrivalDate,
        failureCode: a.failureCode,
        updatedAt: Date.now(),
      };
      // Canonical reads use compare-and-swap; paid payouts can later fail without a second ledger debit.
      if (!prior) await ctx.db.insert("connectedPayouts", value);
      else await ctx.db.patch(prior._id, value);
    }
    if (a.kind === "foreign")
      await openCase(
        ctx,
        {
          kind:
            r.destination === "connect"
              ? "foreign_test_payout"
              : "foreign_stripe_event",
          operationId: `stripe:${r.account}:${r.eventId}`,
          reason: a.reason,
        },
        a.objectId,
      );
    await ctx.db.patch(r._id, {
      state: "complete",
      processedAt: Date.now(),
      leaseToken: undefined,
      leaseUntil: undefined,
      nextAttemptAt: undefined,
    });
  },
});
export const fail = internalMutation({
  args: { id: v.id("webhookReceipts"), token: v.string() },
  handler: async (ctx, a) => {
    const r = await ctx.db.get(a.id);
    if (!r || r.leaseToken !== a.token || r.state !== "processing") return;
    const exhausted = r.attempts >= RECEIPT_MAX_ATTEMPTS;
    await ctx.db.patch(r._id, {
      state: exhausted ? "needs_review" : "retry",
      leaseToken: undefined,
      leaseUntil: undefined,
      nextAttemptAt: exhausted
        ? undefined
        : Date.now() + Math.min(3600000, 1000 * 2 ** r.attempts),
      errorCode: "provider_projection_failed",
    });
    if (exhausted)
      await openCase(
        ctx,
        {
          kind: "foreign_stripe_event",
          operationId: `receipt:${r._id}`,
          reason: "Stripe projection exhausted retries",
        },
        r.objectId,
      );
  },
});
export const recover = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const state of ["pending", "retry", "processing"] as const) {
      const rows =
        state === "processing"
          ? await ctx.db
              .query("webhookReceipts")
              .withIndex("by_lease", (q) =>
                q.eq("state", state).lte("leaseUntil", Date.now()),
              )
              .take(25)
          : await ctx.db
              .query("webhookReceipts")
              .withIndex("by_due", (q) =>
                q.eq("state", state).lte("nextAttemptAt", Date.now()),
              )
              .take(25);
      for (const r of rows) {
        if (r.provider !== "stripe") continue;
        await ctx.db.patch(r._id, {
          state: "retry",
          leaseToken: undefined,
          leaseUntil: undefined,
          nextAttemptAt: Date.now() + 60000,
        });
        await ctx.scheduler.runAfter(0, internal.stripeEvents.processReceipt, {
          id: r._id,
        });
      }
    }
  },
});
export async function fetchPaid(
  ctx: ActionCtx,
  stripe: Stripe,
  sessionId: string,
  fetchedSession?: Stripe.Checkout.Session,
): Promise<PaidFact> {
  const session =
    fetchedSession ?? (await stripe.checkout.sessions.retrieve(sessionId));
  const intentId = session.metadata?.checkoutIntentId;
  if (!intentId) throw new Error("Unknown Checkout");
  const intent = await ctx.runQuery(internal.billing.checkoutIntent, {
    id: intentId,
  });
  const piId = providerId(session.payment_intent);
  if (!intent || !piId) throw new Error("Unknown payment");
  const [pi, lines] = await Promise.all([
    stripe.paymentIntents.retrieve(piId),
    stripe.checkout.sessions.listLineItems(session.id, { limit: 3 }),
  ]);
  const chargeId = providerId(pi.latest_charge);
  if (!chargeId) throw new Error("Missing charge");
  const charge = await stripe.charges.retrieve(chargeId, {
    expand: ["balance_transaction"],
  });
  if (
    session.mode !== "payment" ||
    session.payment_status !== "paid" ||
    session.status !== "complete" ||
    session.livemode ||
    pi.livemode ||
    charge.livemode ||
    pi.status !== "succeeded" ||
    !charge.paid ||
    !charge.captured ||
    pi.amount_received !== intent.totalCents ||
    charge.amount !== intent.totalCents ||
    pi.currency !== "usd" ||
    charge.currency !== "usd" ||
    providerId(charge.payment_intent) !== pi.id ||
    providerId(pi.customer) !== intent.stripeCustomerId ||
    providerId(charge.customer) !== intent.stripeCustomerId ||
    pi.metadata.checkoutIntentId !== intentId ||
    lines.has_more
  )
    throw new Error("Unverified paid Checkout");
  const balance = charge.balance_transaction;
  return paidFact.parse({
    intentId,
    sessionId: session.id,
    paymentIntentId: pi.id,
    chargeId,
    customerId: providerId(session.customer),
    currency: session.currency,
    livemode: session.livemode,
    providerAccount: stripeConfig().account,
    amountCents: session.amount_total,
    actualFeeCents:
      balance && typeof balance !== "string" && balance.currency === "usd"
        ? balance.fee
        : undefined,
    lines: lines.data.map((l) => ({
      priceId: providerId(l.price),
      quantity: l.quantity,
      amountCents: l.amount_total,
    })),
  });
}
/** Every canonical dispute carries both historical movements, regardless of which event woke us. */
export function disputeMovements(
  dispute: Pick<Stripe.Dispute, "balance_transactions">,
) {
  return {
    fundsWithdrawn: dispute.balance_transactions.some((t) => t.amount < 0),
    fundsReinstated: dispute.balance_transactions.some((t) => t.amount > 0),
  };
}
export const processReceipt = internalAction({
  args: { id: v.id("webhookReceipts") },
  handler: async (ctx, args) => {
    const r = await ctx.runMutation(internal.stripeEvents.claim, args);
    if (!r) return;
    try {
      const stripe =
        r.destination === "v2" ? undefined : await verifiedStripe();
      let result: z.infer<typeof projection> = { kind: "ignored" };
      if (r.destination === "v2") {
        const found = await ctx.runAction(internal.connect.refresh, {
          accountId: r.objectId,
        });
        if (!found)
          result = {
            kind: "foreign",
            reason: "Unknown connected account",
            objectId: r.objectId,
          };
      } else if (!stripe) {
        throw new Error("Missing verified Stripe client");
      } else if (
        r.destination === "connect" &&
        r.eventType.startsWith("payout.")
      ) {
        const expectedRevision = await ctx.runQuery(
          internal.stripeEvents.payoutRevision,
          { providerPayoutId: r.objectId },
        );
        const payout = await stripe.payouts.retrieve(
          r.objectId,
          {},
          { stripeAccount: r.account },
        );
        if (payout.livemode) throw new Error("Unexpected live payout");
        result = {
          kind: "payout",
          expectedRevision,
          id: payout.id,
          accountId: r.account,
          amountCents: payout.amount,
          currency: payout.currency,
          status: z
            .enum(["pending", "in_transit", "paid", "failed", "canceled"])
            .parse(payout.status),
          arrivalDate: payout.arrival_date * 1000,
          failureCode: payout.failure_code ?? undefined,
        };
      } else if (
        r.eventType === "checkout.session.completed" ||
        r.eventType === "checkout.session.async_payment_succeeded"
      ) {
        const session = await stripe.checkout.sessions.retrieve(r.objectId);
        if (session.payment_status === "paid")
          result = {
            kind: "paid",
            paid: await fetchPaid(ctx, stripe, r.objectId, session),
          };
      } else if (
        ["charge.refunded", "charge.updated", "charge.succeeded"].includes(
          r.eventType,
        )
      ) {
        const charge = await stripe.charges.retrieve(r.objectId),
          pi = providerId(charge.payment_intent);
        if (!pi) throw new Error("Missing payment intent");
        const sessions = await stripe.checkout.sessions.list({
          payment_intent: pi,
          limit: 2,
        });
        if (sessions.data.length !== 1 || sessions.has_more)
          throw new Error("Unknown Checkout payment");
        const paid = await fetchPaid(ctx, stripe, sessions.data[0].id);
        if (r.eventType === "charge.refunded") {
          const page = await stripe.refunds.list({
            charge: charge.id,
            limit: 50,
            ...(r.providerCursor ? { starting_after: r.providerCursor } : {}),
          });
          result = {
            kind: "refund_page",
            paid,
            refundIds: page.data.map((x) => x.id),
            cursor: page.has_more ? page.data.at(-1)?.id : undefined,
          };
        } else result = { kind: "paid", paid };
      } else if (
        r.eventType.startsWith("refund.") ||
        r.eventType.startsWith("charge.dispute.")
      ) {
        const isRefund = r.eventType.startsWith("refund.");
        // Capture revision before canonical reads. Competing projections must refetch on conflict.
        const initial = isRefund
          ? await stripe.refunds.retrieve(r.objectId)
          : await stripe.disputes.retrieve(r.objectId);
        const chargeId = providerId(initial.charge);
        if (!chargeId) throw new Error("Missing adjustment charge");
        const p = await ctx.runQuery(internal.billing.paymentForCharge, {
          chargeId,
        });
        const canonical = isRefund
          ? await stripe.refunds.retrieve(r.objectId)
          : await stripe.disputes.retrieve(r.objectId);
        if (
          providerId(canonical.charge) !== chargeId ||
          canonical.currency !== "usd" ||
          (!isRefund && "livemode" in canonical && canonical.livemode)
        )
          throw new Error("Adjustment identity mismatch");
        let paid: PaidFact | undefined;
        if (!p) {
          const charge = await stripe.charges.retrieve(chargeId);
          const pi = providerId(charge.payment_intent);
          if (!pi) throw new Error("Missing Checkout intent");
          const sessions = await stripe.checkout.sessions.list({
            payment_intent: pi,
            limit: 2,
          });
          if (sessions.data.length !== 1 || sessions.has_more)
            throw new Error("Checkout correlation failed");
          paid = await fetchPaid(ctx, stripe, sessions.data[0].id);
        }
        result = {
          kind: "adjustment",
          paid,
          chargeId,
          expectedRevision: p?.revision ?? 1,
          sourceRef: canonical.id,
          amountCents: canonical.amount,
          type: isRefund ? "refund" : "dispute",
          ...("balance_transactions" in canonical
            ? disputeMovements(canonical)
            : {}),
          status: isRefund
            ? z
                .enum([
                  "pending",
                  "requires_action",
                  "succeeded",
                  "failed",
                  "canceled",
                ])
                .parse(canonical.status)
            : canonical.status === "won"
              ? "won"
              : canonical.status === "lost"
                ? "lost"
                : "open",
        };
      } else if (r.eventType.startsWith("transfer.")) {
        const t = await stripe.transfers.retrieve(r.objectId);
        const owned =
          (await ctx.runQuery(internal.payouts.transferByProvider, {
            providerId: t.id,
          })) ??
          (t.metadata.transferId
            ? await ctx.runQuery(internal.payouts.transferById, {
                id: t.metadata.transferId,
              })
            : null);
        result = owned
          ? { kind: "transfer", transferId: owned._id, fact: transferFact(t) }
          : {
              kind: "foreign",
              reason: "Orphan provider transfer",
              objectId: t.id,
            };
      }
      await ctx.runMutation(internal.stripeEvents.complete, {
        ...args,
        token: r.leaseToken!,
        json: JSON.stringify(result),
      });
    } catch {
      await ctx.runMutation(internal.stripeEvents.fail, {
        ...args,
        token: r.leaseToken!,
      });
    }
  },
});
async function rawBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Empty body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 1048576) {
      await reader.cancel();
      throw new Error("Oversized body");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
export function stripeWebhook(kind: "platform" | "connect" | "v2") {
  return httpAction(async (ctx, request) => {
    const secret =
      process.env[
        kind === "platform"
          ? "NEXT_STRIPE_WEBHOOK_SECRET"
          : kind === "connect"
            ? "NEXT_STRIPE_CONNECT_WEBHOOK_SECRET"
            : "NEXT_STRIPE_V2_WEBHOOK_SECRET"
      ];
    if (!secret) return new Response("Webhook unavailable", { status: 503 });
    let client: Stripe;
    try {
      client = stripeClient();
    } catch {
      return new Response("Webhook unavailable", { status: 503 });
    }
    let data: z.infer<typeof receiptInput>;
    try {
      const raw = await rawBody(request);
      // Both verify exact raw bytes; the SDK refuses thin v2 notifications in constructEventAsync.
      const signature = request.headers.get("stripe-signature") ?? "";
      const event =
        kind === "v2"
          ? await client.parseEventNotificationAsync(
              raw,
              signature,
              secret,
              300,
              StripeCrypto(),
            )
          : await client.webhooks.constructEventAsync(
              raw,
              signature,
              secret,
              300,
              StripeCrypto(),
            );
      const envelope = z
        .object({
          id,
          type: id,
          created: z.union([cents, z.string()]),
          livemode: z.boolean().optional(),
          account: id.optional(),
          related_object: z.object({ id }).optional(),
          data: z
            .object({
              object: z.object({
                id,
                amount: cents.optional(),
                currency: z.string().optional(),
              }),
            })
            .optional(),
        })
        .parse(event);
      const objectId =
        kind === "v2" ? envelope.related_object?.id : envelope.data?.object.id;
      if (!objectId) throw new Error("Missing event object");
      const config = stripeConfig();
      const account = envelope.account ?? config.account;
      const foreign =
        envelope.livemode === true ||
        (kind === "platform" && account !== config.account) ||
        (kind === "connect" && !envelope.account);
      data = receiptInput.parse({
        eventId: envelope.id,
        eventType: envelope.type,
        objectId,
        account,
        sourceTimestamp:
          typeof envelope.created === "number"
            ? envelope.created * 1000
            : Date.parse(envelope.created),
        payloadHash: await sha256Hex(
          JSON.stringify({
            id: envelope.id,
            type: envelope.type,
            created: envelope.created,
            account,
            objectId,
          }),
        ),
        bodyHash: await sha256Hex(raw),
        destination: kind,
        foreign,
      });
    } catch {
      return new Response("Invalid event", { status: 400 });
    }
    try {
      await ctx.runMutation(internal.stripeEvents.receive, {
        json: JSON.stringify(data),
      });
      return new Response(null, { status: 200 });
    } catch {
      return new Response("Webhook unavailable", { status: 503 });
    }
  });
}
// Stripe SDK crypto provider supports the Convex isolate without Node crypto.
import StripeSDK from "stripe";
const StripeCrypto = () => StripeSDK.createSubtleCryptoProvider();

export const payoutRevision = internalQuery({
  args: { providerPayoutId: v.string() },
  handler: async (ctx, a) =>
    (
      await ctx.db
        .query("connectedPayouts")
        .withIndex("by_provider", (q) =>
          q.eq("providerPayoutId", a.providerPayoutId),
        )
        .unique()
    )?.revision ?? 0,
});
