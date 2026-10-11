import { readBoundedJson } from "@zevium/shared/edge/transport";
import { paginationOptsValidator } from "convex/server";
import { v, ConvexError } from "convex/values";
import { z } from "zod";
import { query, mutation, action, internalMutation } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { requireAdmin } from "./lib/auth";
import { abandonClose } from "./money/barrier";
import { openCase, caseEvidence } from "./money/reconciliationCases";
import { verifiedStripe } from "./lib/stripe";
import { transferFact } from "./payouts";
import { verifiedAccount } from "./connect";
import { recoverRejectedFinal, type Outcome } from "./money/settle";
const note = (value: string) => {
  const n = value.trim();
  if (n.length < 8 || n.length > 1000)
    throw new ConvexError("Enter an audit note of 8–1000 characters");
  return n;
};
export const evidence = query({
  args: {
    caseId: v.id("financeReconciliationCases"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const parent = await ctx.db.get(args.caseId);
    if (parent?.rowKind !== "case") throw new ConvexError("Case not found");
    return ctx.db
      .query("financeReconciliationCases")
      .withIndex("by_case_evidence", (q) => q.eq("caseId", args.caseId))
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(25, Math.max(1, args.paginationOpts.numItems)),
        maximumRowsRead: 26,
      });
  },
});
export const payments = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const rows = await ctx.db
      .query("payments")
      .withIndex("by_reconcile", (q) =>
        q.eq("reconciliation.state", "needs_review"),
      )
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(25, Math.max(1, args.paginationOpts.numItems)),
        maximumRowsRead: 26,
      });
    return {
      ...rows,
      page: rows.page.map((p) => ({
        id: p._id,
        walletId: p.walletId,
        providerPaymentRef: p.providerPaymentRef,
        generation: p.reconciliation.generation,
        credits: p.credits,
        targetCredits: p.reconciliation.targetCredits,
        walletReversedCredits: p.reconciliation.walletReversedCredits,
        attempts: p.reconciliation.attempts ?? 0,
        state: p.reconciliation.state,
      })),
    };
  },
});
export const closes = query({
  args: {
    state: v.union(
      v.literal("closing"),
      v.literal("maintenance"),
      v.literal("closed"),
    ),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const rows = await ctx.db
      .query("wallets")
      .withIndex("by_gate", (q) => q.eq("gateState", args.state))
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(25, Math.max(1, args.paginationOpts.numItems)),
        maximumRowsRead: 26,
      });
    return {
      ...rows,
      page: rows.page.map((w) => ({
        id: w._id,
        clerkOrgId: w.owner.clerkOrgId,
        gateState: w.gateState,
        balance: w.balance,
        epoch: w.epoch,
        watermark: w.settledThroughEdgeSequence,
        close: w.close
          ? {
              id: w.close.id,
              reason: w.close.reason,
              requestedAt: w.close.requestedAt,
              ackAt: w.close.ackAt,
              edgeFinalSequence: w.close.edgeFinalSequence,
              canAbandon:
                w.close.reason === "admin" &&
                w.close.ackAt !== undefined &&
                w.close.edgeFinalSequence === w.settledThroughEdgeSequence &&
                (w.gateState === "closing" || w.gateState === "maintenance"),
            }
          : null,
      })),
    };
  },
});
export const retryPayment = mutation({
  args: {
    paymentId: v.id("payments"),
    generation: v.number(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await requireAdmin(ctx),
      reason = note(args.reason),
      p = await ctx.db.get(args.paymentId);
    if (!p || p.reconciliation.generation !== args.generation)
      throw new ConvexError("Payment changed; review the latest state");
    const id = await openCase(ctx, {
      kind: "payment",
      paymentId: p._id,
      operationId: `payment-reconcile:${p._id}:${args.generation}`,
      reason: "Payment reconciliation requires operator review",
    });
    if (p.reconciliation.state !== "needs_review")
      return { caseId: id, state: p.reconciliation.state };
    await caseEvidence(
      ctx,
      id,
      "provider_request",
      JSON.stringify({
        action: "retry",
        actor: actor.subject,
        reason,
        generation: args.generation,
        at: Date.now(),
      }),
    );
    await ctx.db.patch(p._id, {
      reconciliation: {
        ...p.reconciliation,
        state: "retry",
        attempts: 0,
        nextAttemptAt: Date.now(),
      },
    });
    await ctx.scheduler.runAfter(0, internal.billing.reconcile, {
      paymentId: p._id,
      generation: args.generation,
    });
    return { caseId: id, state: "retry" };
  },
});
export const abandonAdminClose = mutation({
  args: { walletId: v.id("wallets"), closeId: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireAdmin(ctx),
      reason = note(args.reason),
      wallet = await abandonClose(ctx, args.walletId, args.closeId);
    const id = await openCase(ctx, {
      kind: "payment",
      organizationId: wallet.owner.organizationId,
      operationId: `abandon:${args.closeId}`,
      reason: "Drained admin decrease abandoned with no ledger effects",
    });
    await caseEvidence(
      ctx,
      id,
      "provider_request",
      JSON.stringify({ actor: actor.subject, reason, closeId: args.closeId }),
    );
    await ctx.db.patch(id, {
      status: "resolved",
      resolution: "Abandoned without debit",
      updatedAt: Date.now(),
    });
    return { state: wallet.gateState };
  },
});
export const wakeClose = action({
  args: { walletId: v.id("wallets") },
  handler: async (ctx, args): Promise<{ requested: true }> => {
    await requireAdmin(ctx);
    const wallet = await ctx.runQuery(internal.wallets.getCheckpoint, args);
    await ctx.runAction(internal.edgeMaintenance.wakeWallet, {
      clerkOrgId: wallet.clerkOrgId,
    });
    return { requested: true };
  },
});
export const resolveException = action({
  args: {
    caseId: v.id("financeReconciliationCases"),
    disposition: v.union(v.literal("resolved"), v.literal("void")),
    resolution: v.string(),
  },
  handler: async (ctx, args): Promise<{ status: string }> => {
    const actor = await requireAdmin(ctx);
    await ctx.runMutation(internal.wallets.resolveSettlementException, {
      ...args,
      resolution: `${actor.subject}: ${note(args.resolution)}`,
    });
    return { status: "resolved" };
  },
});
export const recoverRejected = mutation({
  args: {
    eventJson: v.string(),
    expectedFingerprint: v.string(),
    expectedWatermark: v.number(),
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<Outcome> => {
    const actor = await requireAdmin(ctx);
    return recoverRejectedFinal(ctx, {
      ...args,
      reason: `${actor.subject}: ${note(args.reason)}`.slice(0, 512),
    });
  },
});
const failure = z.object({
  eventJson: z.string().max(1048576),
  expectedFingerprint: z.string().max(128),
  expectedWatermark: z.number().int().nonnegative(),
  reason: z.string().max(4096),
});
export const exportRejected = action({
  args: { clerkOrgId: v.string(), settleRefId: v.string() },
  handler: async (ctx, args): Promise<z.infer<typeof failure> | null> => {
    await requireAdmin(ctx);
    if (
      !args.clerkOrgId ||
      args.clerkOrgId.length > 256 ||
      !args.settleRefId ||
      args.settleRefId.length > 512
    )
      throw new ConvexError("Invalid failure reference");
    const origin = process.env.NEXT_GATEWAY_URL,
      secret = process.env.GATEWAY_INTERNAL_SECRET,
      deploymentId = process.env.NEXT_DEPLOYMENT_ID;
    if (!origin || !secret || !deploymentId)
      throw new ConvexError("Edge recovery is not configured");
    try {
      const response = await fetch(new URL("/internal/next-failure", origin), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-secret": secret,
        },
        body: JSON.stringify({ ...args, deploymentId }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Unavailable");
      return await readBoundedJson(
        new Request("https://internal.invalid", {
          method: "POST",
          headers: response.headers,
          body: response.body,
          duplex: "half",
        } as RequestInit),
        failure.nullable(),
        1100000,
      );
    } catch {
      throw new ConvexError(
        "Could not load rejected final evidence. Check the edge connection and reference.",
      );
    }
  },
});
export const finishCase = internalMutation({
  args: {
    caseId: v.id("financeReconciliationCases"),
    expectedUpdatedAt: v.number(),
    resolution: v.string(),
    status: v.union(v.literal("adopted"), v.literal("quarantined")),
  },
  handler: async (ctx, args) => {
    const actor = await requireAdmin(ctx),
      row = await ctx.db.get(args.caseId);
    if (row?.rowKind !== "case" || row.updatedAt !== args.expectedUpdatedAt)
      throw new ConvexError("Case changed; review it again");
    await caseEvidence(
      ctx,
      row._id,
      "provider_request",
      JSON.stringify({
        actor: actor.subject,
        resolution: args.resolution,
        status: args.status,
      }),
    );
    await ctx.db.patch(row._id, {
      status: args.status,
      resolution: args.resolution,
      updatedAt: Date.now(),
    });
  },
});
export const resolveProviderCase = action({
  args: {
    caseId: v.id("financeReconciliationCases"),
    expectedUpdatedAt: v.number(),
    resolution: v.union(v.literal("adopt"), v.literal("quarantine")),
    providerId: v.optional(v.string()),
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<{ status: string }> => {
    await requireAdmin(ctx);
    const reason = note(args.reason),
      row = await ctx.runQuery(api.admin.getFinanceReconciliationCase, {
        caseId: args.caseId,
      });
    if (!row || row.updatedAt !== args.expectedUpdatedAt)
      throw new ConvexError("Case changed; review it again");
    if (
      ![
        "transfer",
        "transfer_orphan",
        "account_create",
        "foreign_stripe_event",
        "foreign_test_payout",
      ].includes(row.kind)
    )
      throw new ConvexError(
        "Use the dedicated payment or settlement recovery action",
      );
    if (args.resolution === "adopt") {
      if (!args.providerId || args.providerId.length > 256)
        throw new ConvexError("Select the exact provider object to verify");
      const stripe = await verifiedStripe();
      if (row.kind === "transfer" && row.transferId) {
        const provider = await stripe.transfers.retrieve(args.providerId);
        await ctx.runMutation(internal.payouts.project, {
          id: row.transferId,
          json: JSON.stringify(transferFact(provider)),
        });
      } else if (row.kind === "account_create" && row.organizationId) {
        const provider = await stripe.v2.core.accounts.retrieve(
          args.providerId,
          {
            include: [
              "configuration.recipient",
              "defaults",
              "identity",
              "requirements",
            ],
          },
        );
        await ctx.runMutation(internal.connect.commit, {
          id: row.organizationId,
          json: JSON.stringify(verifiedAccount(provider)),
        });
      } else
        throw new ConvexError(
          "Foreign or orphan facts require quarantine and separate ownership investigation",
        );
    }
    const status = args.resolution === "adopt" ? "adopted" : "quarantined";
    await ctx.runMutation(internal.operators.finishCase, {
      caseId: row._id,
      expectedUpdatedAt: row.updatedAt,
      resolution: reason,
      status,
    });
    return { status };
  },
});
