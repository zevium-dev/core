import { v, ConvexError } from "convex/values";
import { z } from "zod";
import type Stripe from "stripe";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireActiveOrg, requireOrgAdmin } from "./lib/auth";
import { verifiedStripe, stripeConfig, appOrigin } from "./lib/stripe";
import { fingerprint } from "../contracts/transport";
import { openCase, caseEvidence } from "./money/reconciliationCases";
export const ACCOUNT_REPLAY_MS = 29 * 86400000;
export const accountProjection = z.object({
  id: z.string(),
  livemode: z.literal(false),
  closed: z.boolean(),
  organizationId: z.string(),
  operationId: z.string(),
  fingerprint: z.string(),
  country: z.string(),
  status: z.enum(["pending", "active", "restricted", "closed"]),
  requirements: z.array(z.string().max(1000)).max(100),
});
export function verifiedAccount(account: Stripe.V2.Core.Account) {
  const responsibility = account.defaults?.responsibilities;
  if (
    account.object !== "v2.core.account" ||
    account.livemode ||
    account.dashboard !== "express" ||
    account.applied_configurations.length !== 1 ||
    account.applied_configurations[0] !== "recipient" ||
    responsibility?.fees_collector !== "application" ||
    responsibility.losses_collector !== "application" ||
    responsibility.requirements_collector !== "stripe" ||
    account.configuration?.recipient?.applied !== true
  )
    throw new Error("Connected account identity mismatch");
  const active =
    account.configuration.recipient.capabilities?.stripe_balance
      ?.stripe_transfers?.status === "active";
  return accountProjection.parse({
    id: account.id,
    livemode: account.livemode,
    closed: account.closed ?? false,
    organizationId: account.metadata?.organizationId,
    operationId: account.metadata?.operationId,
    fingerprint: account.metadata?.requestFingerprint,
    country: account.identity?.country?.toUpperCase(),
    status: account.closed ? "closed" : active ? "active" : "pending",
    requirements: (account.requirements?.entries ?? [])
      .filter((e) => e.awaiting_action_from === "user")
      .map((e) => e.description),
  });
}
export const prepare = internalMutation({
  args: { country: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const { org, claims } = await requireActiveOrg(ctx);
    requireOrgAdmin(claims);
    if (org.connect) return org;
    if (org.connectOperation) return org; // Unknown operations retain identity and PII until resolved.
    const country = (a.country ?? "US").toUpperCase(),
      email = claims.email;
    if (!/^[A-Z]{2}$/.test(country) || !email || email.length > 254)
      throw new ConvexError("Publisher country and email are required");
    const operation = {
      id: crypto.randomUUID(),
      kind: "account" as const,
      country,
      contactEmail: email,
      displayName: org.name.slice(0, 250),
      platformAccountId: stripeConfig().account,
      startedAt: Date.now(),
      state: "pending" as const,
      nextAttemptAt: Date.now(),
    };
    await ctx.db.patch(org._id, {
      connectOperation: {
        ...operation,
        requestFingerprint: await fingerprint({
          organizationId: org._id,
          country,
          email,
          displayName: operation.displayName,
          platformAccountId: operation.platformAccountId,
        }),
      },
    });
    return (await ctx.db.get(org._id))!;
  },
});
export const claim = internalMutation({
  args: { id: v.id("organizations") },
  handler: async (ctx, a) => {
    const org = await ctx.db.get(a.id),
      op = org?.connectOperation;
    if (
      !org ||
      !op ||
      org.connect ||
      op.state === "needs_review" ||
      op.state === "complete" ||
      (op.leaseUntil ?? 0) > Date.now()
    )
      return null;
    const next = {
      ...op,
      state: "processing" as const,
      leaseToken: crypto.randomUUID(),
      leaseUntil: Date.now() + 300000,
      nextAttemptAt: Date.now() + 300000,
    };
    await ctx.db.patch(org._id, { connectOperation: next });
    return { ...org, connectOperation: next };
  },
});
export async function commitAccount(
  ctx: MutationCtx,
  org: Doc<"organizations">,
  a: z.infer<typeof accountProjection>,
  token?: string,
  expectedRevision?: number,
) {
  const op = org.connectOperation;
  if (org.connect && expectedRevision !== (org.connect.revision ?? 0))
    throw new ConvexError("Account changed; refetch canonical facts");
  if (
    a.organizationId !== org._id ||
    !op ||
    a.operationId !== op.id ||
    a.fingerprint !== op.requestFingerprint ||
    a.country !== op.country ||
    (token && (op.leaseToken !== token || (op.leaseUntil ?? 0) < Date.now())) ||
    (org.connect && org.connect.accountId !== a.id) ||
    op.platformAccountId !== stripeConfig().account
  )
    throw new ConvexError("Connected account evidence mismatch");
  const claimed = await ctx.db
    .query("organizations")
    .withIndex("by_connect", (q) => q.eq("connect.accountId", a.id))
    .unique();
  if (claimed && claimed._id !== org._id)
    throw new ConvexError(
      "Connected account already belongs to an organization",
    );
  await ctx.db.patch(org._id, {
    connect: {
      accountId: a.id,
      revision: (org.connect?.revision ?? 0) + 1,
      platformAccountId: op.platformAccountId,
      livemode: false,
      status: a.status,
      requirements: a.requirements,
      updatedAt: Date.now(),
    },
    connectOperation: {
      ...op,
      state: "complete",
      contactEmail: undefined,
      displayName: undefined,
      piiExpiresAt: undefined,
      leaseToken: undefined,
      leaseUntil: undefined,
      nextAttemptAt: undefined,
    },
  });
}
export const commit = internalMutation({
  args: {
    id: v.id("organizations"),
    token: v.optional(v.string()),
    expectedRevision: v.optional(v.number()),
    json: v.string(),
  },
  handler: async (ctx, a) => {
    const org = await ctx.db.get(a.id);
    if (!org) throw new ConvexError("Organization not found");
    await commitAccount(
      ctx,
      org,
      accountProjection.parse(JSON.parse(a.json)),
      a.token,
      a.expectedRevision,
    );
  },
});
export const recordPage = internalMutation({
  args: {
    id: v.id("organizations"),
    token: v.string(),
    cursor: v.optional(v.string()),
    candidates: v.array(v.string()),
    done: v.boolean(),
  },
  handler: async (ctx, a) => {
    const org = await ctx.db.get(a.id),
      op = org?.connectOperation;
    if (!org || !op || op.leaseToken !== a.token) return;
    const caseId = await openCase(ctx, {
      kind: "account_create",
      operationId: op.id,
      organizationId: org._id,
      reason: "Account creation outcome requires reconciliation",
    });
    for (const candidate of a.candidates)
      await caseEvidence(ctx, caseId, "candidate", candidate);
    await ctx.db.patch(caseId, {
      providerCursor: a.cursor,
      updatedAt: Date.now(),
    });
    await ctx.db.patch(org._id, {
      connectOperation: {
        ...op,
        state: a.done ? "needs_review" : "retry",
        providerCursor: a.cursor,
        leaseToken: undefined,
        leaseUntil: undefined,
        nextAttemptAt: a.done ? undefined : Date.now(),
      },
    });
  },
});
export const failed = internalMutation({
  args: { id: v.id("organizations"), token: v.string() },
  handler: async (ctx, a) => {
    const org = await ctx.db.get(a.id),
      op = org?.connectOperation;
    if (!org || !op || op.leaseToken !== a.token) return;
    await ctx.db.patch(org._id, {
      connectOperation: {
        ...op,
        state: "retry",
        leaseToken: undefined,
        leaseUntil: undefined,
        nextAttemptAt: Date.now() + 60000,
      },
    });
  },
});
export async function accountPage(
  stripe: Stripe,
  cursor?: string,
): Promise<{ ids: string[]; next?: string }> {
  if (!cursor) {
    const page = await stripe.v2.core.accounts.list({
      limit: 100,
      applied_configurations: ["recipient"],
    });
    return {
      ids: page.data.map((a) => a.id),
      next: page.next_page_url ?? undefined,
    };
  }
  // Provider cursors are URLs; pin origin/path before passing their path to the SDK.
  const url = new URL(cursor, "https://api.stripe.com");
  if (
    url.origin !== "https://api.stripe.com" ||
    url.pathname !== "/v2/core/accounts"
  )
    throw new Error("Invalid account cursor");
  const raw: unknown = await stripe.rawRequest(
    "GET",
    url.pathname + url.search,
  );
  const page = z
    .object({
      data: z.array(z.object({ id: z.string() })).max(100),
      next_page_url: z.string().nullable(),
    })
    .parse(raw);
  return {
    ids: page.data.map((a) => a.id),
    next: page.next_page_url ?? undefined,
  };
}
export const resume = internalAction({
  args: { id: v.id("organizations") },
  handler: async (ctx, a) => {
    const org = await ctx.runMutation(internal.connect.claim, a);
    if (!org) return;
    const op = org.connectOperation!;
    try {
      const stripe = await verifiedStripe();
      if (op.platformAccountId !== stripeConfig().account)
        throw new Error("Account environment mismatch");
      if (Date.now() - (op.startedAt ?? 0) >= ACCOUNT_REPLAY_MS) {
        const page = await accountPage(stripe, op.providerCursor);
        const candidates: string[] = [];
        for (const id of page.ids) {
          const account = await stripe.v2.core.accounts.retrieve(id, {
            include: [
              "configuration.recipient",
              "defaults",
              "identity",
              "requirements",
            ],
          });
          if (account.metadata?.operationId === op.id) candidates.push(id);
        }
        // Exhaust the full scan before operator adoption; never infer absence from a bounded prefix.
        await ctx.runMutation(internal.connect.recordPage, {
          id: org._id,
          token: op.leaseToken!,
          cursor: page.next,
          candidates,
          done: !page.next,
        });
        return;
      }
      const account = await stripe.v2.core.accounts.create(
        {
          dashboard: "express",
          defaults: {
            responsibilities: {
              fees_collector: "application",
              losses_collector: "application",
            },
          },
          configuration: {
            recipient: {
              capabilities: {
                stripe_balance: { stripe_transfers: { requested: true } },
              },
            },
          },
          contact_email: op.contactEmail,
          display_name: op.displayName,
          identity: { country: op.country!.toLowerCase() },
          include: [
            "configuration.recipient",
            "defaults",
            "identity",
            "requirements",
          ],
          metadata: {
            organizationId: org._id,
            operationId: op.id,
            requestFingerprint: op.requestFingerprint,
          },
        },
        { idempotencyKey: `next:account:${op.id}` },
      );
      await ctx.runMutation(internal.connect.commit, {
        id: org._id,
        token: op.leaseToken!,
        json: JSON.stringify(verifiedAccount(account)),
      });
    } catch {
      await ctx.runMutation(internal.connect.failed, {
        id: org._id,
        token: op.leaseToken!,
      });
    }
  },
});
export const byAccount = internalQuery({
  args: { accountId: v.string() },
  handler: (ctx, a) =>
    ctx.db
      .query("organizations")
      .withIndex("by_connect", (q) => q.eq("connect.accountId", a.accountId))
      .unique(),
});
export const refresh = internalAction({
  args: { accountId: v.string() },
  handler: async (ctx, a) => {
    const org = await ctx.runQuery(internal.connect.byAccount, a);
    if (!org) return false;
    const stripe = await verifiedStripe();
    const account = await stripe.v2.core.accounts.retrieve(a.accountId, {
      include: [
        "configuration.recipient",
        "defaults",
        "identity",
        "requirements",
      ],
    });
    await ctx.runMutation(internal.connect.commit, {
      id: org._id,
      expectedRevision: org.connect?.revision ?? 0,
      json: JSON.stringify(verifiedAccount(account)),
    });
    return true;
  },
});
export const recover = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const state of ["pending", "retry", "processing"] as const) {
      const rows = await ctx.db
        .query("organizations")
        .withIndex("by_connect_due", (q) =>
          q
            .eq("connectOperation.state", state)
            .lte("connectOperation.nextAttemptAt", Date.now()),
        )
        .take(25);
      for (const org of rows) {
        await ctx.db.patch(org._id, {
          connectOperation: {
            ...org.connectOperation!,
            nextAttemptAt: Date.now() + 60000,
          },
        });
        await ctx.scheduler.runAfter(0, internal.connect.resume, {
          id: org._id,
        });
      }
    }
  },
});
export async function onboarding(
  ctx: ActionCtx,
  country?: string,
): Promise<{ url: string }> {
  let org = await ctx.runMutation(internal.connect.prepare, { country });
  if (!org.connect) {
    await ctx.runAction(internal.connect.resume, { id: org._id });
    org = await ctx.runMutation(internal.connect.prepare, { country });
  }
  if (!org.connect)
    throw new ConvexError(
      "Publisher setup is pending reconciliation. Please try again later.",
    );
  const prepared = await ctx.runMutation(internal.connect.prepareLink, {});
  const stripe = await verifiedStripe();
  const link = await stripe.v2.core.accountLinks.create(
    {
      account: prepared.accountId,
      use_case: {
        type: "account_onboarding",
        account_onboarding: {
          // Dahlia still requires recipient scope; Endive removes this field.
          // @ts-expect-error Required by our pinned 2026-06-24.dahlia API.
          configurations: ["recipient"],
          refresh_url: `${prepared.link.origin}/app/earnings`,
          return_url: `${prepared.link.origin}/app/earnings`,
        },
      },
    },
    { idempotencyKey: `next:link:${org._id}:${prepared.link.id}` },
  );
  const url = new URL(link.url);
  if (
    link.account !== prepared.accountId ||
    link.livemode ||
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".stripe.com")
  )
    throw new ConvexError("Publisher setup unavailable");
  await ctx.runMutation(internal.connect.completeLink, {
    id: prepared.link.id,
    fingerprint: prepared.link.requestFingerprint,
  });
  return { url: link.url };
}

export const prepareLink = internalMutation({
  args: {},
  handler: async (ctx) => {
    const { org, claims } = await requireActiveOrg(ctx);
    requireOrgAdmin(claims);
    if (!org.connect || !org.connectOperation)
      throw new ConvexError("Publisher account is not ready");
    const current = org.connectOperation.link;
    if (
      current?.state === "pending" &&
      current.createdAt > Date.now() - 1800000
    )
      return { accountId: org.connect.accountId, link: current };
    const origin = appOrigin();
    const link = {
      id: crypto.randomUUID(),
      state: "pending" as const,
      origin,
      createdAt: Date.now(),
      requestFingerprint: await fingerprint({
        accountId: org.connect.accountId,
        origin,
      }),
    };
    await ctx.db.patch(org._id, {
      connectOperation: { ...org.connectOperation, link },
    });
    return { accountId: org.connect.accountId, link };
  },
});
export const completeLink = internalMutation({
  args: { id: v.string(), fingerprint: v.string() },
  handler: async (ctx, a) => {
    const { org, claims } = await requireActiveOrg(ctx);
    requireOrgAdmin(claims);
    const op = org.connectOperation,
      link = op?.link;
    if (
      !op ||
      !link ||
      link.id !== a.id ||
      link.requestFingerprint !== a.fingerprint
    )
      throw new ConvexError("Publisher setup changed");
    await ctx.db.patch(org._id, {
      connectOperation: { ...op, link: { ...link, state: "complete" } },
    });
  },
});
