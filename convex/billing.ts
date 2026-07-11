import { Polar } from "@polar-sh/sdk";
import { v } from "convex/values";
import {
  action,
  internalAction,
  query,
  type ActionCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireOrgMemberBySlug } from "./lib/auth";
import { POLAR_SYNC_COOLDOWN_MS } from "./wallets";

/** Stable pack ids used by the web Buy Credits UI. */
export type CreditPackId = "pack_10" | "pack_50" | "pack_100";

export type CreditPackDefinition = {
  packId: CreditPackId;
  /** Product name in Polar (also used for lookup). */
  name: string;
  description: string;
  /** USD price in cents. */
  priceCents: number;
  /** Credits granted on purchase (base + bonus). */
  credits: number;
  /** Display-only base credits before bonus. */
  baseCredits: number;
  /** Display-only bonus credits. */
  bonusCredits: number;
};

/** $1 = 10,000 credits. Packs store credits in Polar product metadata. */
export const CREDIT_PACKS: readonly CreditPackDefinition[] = [
  {
    packId: "pack_10",
    name: "Zevium Credits — $10",
    description: "100,000 credits",
    priceCents: 1000,
    credits: 100_000,
    baseCredits: 100_000,
    bonusCredits: 0,
  },
  {
    packId: "pack_50",
    name: "Zevium Credits — $50",
    description: "500,000 credits + 25,000 bonus",
    priceCents: 5000,
    credits: 525_000,
    baseCredits: 500_000,
    bonusCredits: 25_000,
  },
  {
    packId: "pack_100",
    name: "Zevium Credits — $100",
    description: "1,000,000 credits + 100,000 bonus",
    priceCents: 10_000,
    credits: 1_100_000,
    baseCredits: 1_000_000,
    bonusCredits: 100_000,
  },
] as const;

export type PublicCreditPack = {
  packId: CreditPackId;
  name: string;
  description: string;
  priceCents: number;
  credits: number;
  baseCredits: number;
  bonusCredits: number;
  /** Polar product id once ensured; may be empty before ensureProducts. */
  productId: string | null;
};

export type CreateCheckoutResult = {
  url: string;
  checkoutId: string;
};

export type EnsureProductsResult = {
  packs: Array<{
    packId: CreditPackId;
    productId: string;
    credits: number;
    created: boolean;
  }>;
};

type PolarProductRow = {
  id: string;
  name: string;
  metadata: Record<string, unknown>;
};

function polarClient(): Polar {
  const accessToken = process.env.POLAR_ACCESS_TOKEN;
  if (accessToken === undefined || accessToken.length === 0) {
    throw new Error("POLAR_ACCESS_TOKEN is not configured");
  }
  const serverRaw = process.env.POLAR_SERVER;
  const server =
    serverRaw === "production" || serverRaw === "sandbox"
      ? serverRaw
      : "sandbox";
  return new Polar({ accessToken, server });
}

function metaString(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  if (metadata === null || metadata === undefined) return undefined;
  const value = metadata[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function metaNumber(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  if (metadata === null || metadata === undefined) return undefined;
  const value = metadata[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

async function listOneTimeProducts(polar: Polar): Promise<PolarProductRow[]> {
  const collected: PolarProductRow[] = [];

  const page = await polar.products.list({
    isArchived: false,
    isRecurring: false,
    limit: 100,
  });

  for await (const result of page) {
    for (const product of result.result.items) {
      collected.push({
        id: product.id,
        name: product.name,
        metadata: product.metadata as Record<string, unknown>,
      });
    }
  }

  return collected;
}

function findExistingProduct(
  products: PolarProductRow[],
  pack: CreditPackDefinition,
): PolarProductRow | null {
  for (const product of products) {
    const packId = metaString(product.metadata, "packId");
    if (packId === pack.packId) return product;
  }
  for (const product of products) {
    if (product.name === pack.name) return product;
  }
  return null;
}

/**
 * Ensure the three credit-pack products exist in Polar sandbox/prod.
 * Idempotent: matches by metadata.packId then by name.
 * Tokens without products:write skip create; checkout uses ad-hoc prices.
 */
export const ensureProducts = internalAction({
  args: {},
  handler: async (_ctx): Promise<EnsureProductsResult> => {
    const polar = polarClient();
    const existing = await listOneTimeProducts(polar);
    const packs: EnsureProductsResult["packs"] = [];

    for (const pack of CREDIT_PACKS) {
      const found = findExistingProduct(existing, pack);
      if (found !== null) {
        packs.push({
          packId: pack.packId,
          productId: found.id,
          credits: pack.credits,
          created: false,
        });
        continue;
      }

      try {
        const created = await polar.products.create({
          name: pack.name,
          description: pack.description,
          recurringInterval: null,
          prices: [
            {
              amountType: "fixed",
              priceAmount: pack.priceCents,
              priceCurrency: "usd",
            },
          ],
          metadata: {
            packId: pack.packId,
            credits: pack.credits,
            baseCredits: pack.baseCredits,
            bonusCredits: pack.bonusCredits,
          },
        });

        packs.push({
          packId: pack.packId,
          productId: created.id,
          credits: pack.credits,
          created: true,
        });
        existing.push({
          id: created.id,
          name: created.name,
          metadata: created.metadata as Record<string, unknown>,
        });
      } catch (err) {
        console.error("ensureProducts: create failed", {
          packId: pack.packId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { packs };
  },
});

/**
 * Public pack catalogue for the billing UI.
 * Resolves Polar product ids when products already exist; does not create.
 */
export const listPacks = action({
  args: {},
  handler: async (_ctx): Promise<PublicCreditPack[]> => {
    const productByPack: Record<string, string> = {};
    try {
      const polar = polarClient();
      const products = await listOneTimeProducts(polar);
      for (const pack of CREDIT_PACKS) {
        const found = findExistingProduct(products, pack);
        if (found !== null) {
          productByPack[pack.packId] = found.id;
        }
      }
    } catch {
      // Polar unreachable — still return static packs so UI can render.
    }

    return CREDIT_PACKS.map((pack) => ({
      packId: pack.packId,
      name: pack.name,
      description: pack.description,
      priceCents: pack.priceCents,
      credits: pack.credits,
      baseCredits: pack.baseCredits,
      bonusCredits: pack.bonusCredits,
      productId: productByPack[pack.packId] ?? null,
    }));
  },
});

/**
 * Create a Polar hosted checkout for a credit pack.
 * Metadata.clerkOrgId is copied onto the order for the webhook grant.
 *
 * Prefer a dedicated pack product; if products:write is missing, reuse any
 * one-time product with an ad-hoc fixed price for the pack amount.
 */
export const createCheckout = action({
  args: {
    orgSlug: v.string(),
    packId: v.union(
      v.literal("pack_10"),
      v.literal("pack_50"),
      v.literal("pack_100"),
    ),
  },
  handler: async (ctx, args): Promise<CreateCheckoutResult> => {
    const clerkOrgId = await requireOrgMemberInAction(ctx, args.orgSlug);

    const pack = CREDIT_PACKS.find((p) => p.packId === args.packId);
    if (pack === undefined) {
      throw new Error("Unknown credit pack");
    }

    const polar = polarClient();
    const products = await listOneTimeProducts(polar);
    let product = findExistingProduct(products, pack);

    if (product === null) {
      try {
        const created = await polar.products.create({
          name: pack.name,
          description: pack.description,
          recurringInterval: null,
          prices: [
            {
              amountType: "fixed",
              priceAmount: pack.priceCents,
              priceCurrency: "usd",
            },
          ],
          metadata: {
            packId: pack.packId,
            credits: pack.credits,
            baseCredits: pack.baseCredits,
            bonusCredits: pack.bonusCredits,
          },
        });
        product = {
          id: created.id,
          name: created.name,
          metadata: created.metadata as Record<string, unknown>,
        };
      } catch {
        // products:write missing — reuse any one-time product + ad-hoc price.
        product = products[0] ?? null;
      }
    }

    if (product === null) {
      throw new Error(
        "No Polar product available. Create a one-time product or grant products:write on the access token.",
      );
    }

    // Ad-hoc fixed price so pack_50/pack_100 charge correctly even when
    // reusing a single catalog product (token lacks products:write).
    const checkout = await polar.checkouts.create({
      products: [product.id],
      prices: {
        [product.id]: [
          {
            amountType: "fixed",
            priceAmount: pack.priceCents,
            priceCurrency: "usd",
          },
        ],
      },
      successUrl: "http://localhost:3000/app/billing?success=1",
      returnUrl: "http://localhost:3000/app/billing",
      metadata: {
        clerkOrgId,
        packId: pack.packId,
        credits: pack.credits,
      },
      externalCustomerId: clerkOrgId,
    });

    if (typeof checkout.url !== "string" || checkout.url.length === 0) {
      throw new Error("Checkout URL missing from Polar response");
    }

    return {
      url: checkout.url,
      checkoutId: checkout.id,
    };
  },
});

/**
 * Static pack list for SSR / offline UI (no Polar call).
 * Product ids are not included — use listPacks action when needed.
 */
export const listPacksStatic = query({
  args: {},
  handler: async (_ctx): Promise<PublicCreditPack[]> => {
    return CREDIT_PACKS.map((pack) => ({
      packId: pack.packId,
      name: pack.name,
      description: pack.description,
      priceCents: pack.priceCents,
      credits: pack.credits,
      baseCredits: pack.baseCredits,
      bonusCredits: pack.bonusCredits,
      productId: null,
    }));
  },
});

/** Resolve credits for a paid order from metadata / product / price fallback. */
export function resolveOrderCredits(order: {
  metadata?: Record<string, unknown> | null;
  product?: { metadata?: Record<string, unknown> | null } | null;
  totalAmount?: number | null;
  netAmount?: number | null;
}): number | null {
  const fromOrder = metaNumber(order.metadata ?? undefined, "credits");
  if (fromOrder !== undefined && fromOrder > 0) return fromOrder;

  const fromProduct = metaNumber(
    order.product?.metadata ?? undefined,
    "credits",
  );
  if (fromProduct !== undefined && fromProduct > 0) return fromProduct;

  const packId =
    metaString(order.metadata ?? undefined, "packId") ??
    metaString(order.product?.metadata ?? undefined, "packId");
  if (packId !== undefined) {
    const pack = CREDIT_PACKS.find((p) => p.packId === packId);
    if (pack !== undefined) return pack.credits;
  }

  // Last resort: $1 = 10,000 credits from paid amount (cents).
  const cents =
    typeof order.netAmount === "number"
      ? order.netAmount
      : typeof order.totalAmount === "number"
        ? order.totalAmount
        : null;
  if (cents !== null && cents > 0) {
    return Math.floor((cents / 100) * 10_000);
  }

  return null;
}

export function resolveOrderClerkOrgId(order: {
  metadata?: Record<string, unknown> | null;
}): string | null {
  const clerkOrgId = metaString(order.metadata ?? undefined, "clerkOrgId");
  if (clerkOrgId !== undefined) return clerkOrgId;
  const orgId = metaString(order.metadata ?? undefined, "orgId");
  if (orgId !== undefined) return orgId;
  return null;
}

/** Minimal paid-order shape consumed by sync resolution. */
export type PolarOrderInput = {
  id: string;
  status: string;
  paid: boolean;
  metadata: Record<string, unknown> | null;
  product: { metadata: Record<string, unknown> | null } | null;
  totalAmount: number;
  netAmount: number;
};

/**
 * Fetch paid one-time orders for an external customer (clerkOrgId) from Polar.
 * Mirrors the listOneTimeProducts iteration pattern. Exported so tests inject
 * fixtures via planSyncGrants without a live Polar client.
 */
export async function fetchPaidOrders(
  polar: Polar,
  externalCustomerId: string,
): Promise<PolarOrderInput[]> {
  const collected: PolarOrderInput[] = [];
  const page = await polar.orders.list({
    externalCustomerId,
    limit: 100,
  });
  for await (const response of page) {
    for (const order of response.result.items) {
      if (order.status !== "paid") continue;
      collected.push({
        id: order.id,
        status: order.status,
        paid: order.paid,
        metadata: order.metadata as Record<string, unknown>,
        product:
          order.product === null || order.product === undefined
            ? null
            : {
                metadata: order.product.metadata as Record<string, unknown>,
              },
        totalAmount: order.totalAmount,
        netAmount: order.netAmount,
      });
    }
  }
  return collected;
}

/** A grant instruction derived from a paid Polar order. */
export type OrderGrantInput = {
  clerkOrgId: string;
  amount: number;
  grantRefId: string;
  orderId: string;
};

/**
 * Map paid orders → grant instructions for the ledger.
 * - clerkOrgId: order metadata first, then the fallback (checkout owner).
 * - amount: resolveOrderCredits (order → product → packId → price fallback).
 * Orders with no resolvable credits are skipped (counted).
 * Dedupes by orderId so a repeated fetch cannot double-plan.
 */
export function planSyncGrants(
  orders: PolarOrderInput[],
  fallbackClerkOrgId: string,
): {
  toGrant: OrderGrantInput[];
  skipped: number;
  ordersSeen: number;
} {
  const seen = new Set<string>();
  const toGrant: OrderGrantInput[] = [];
  let skipped = 0;

  for (const order of orders) {
    if (seen.has(order.id)) continue;
    seen.add(order.id);

    const credits = resolveOrderCredits({
      metadata: order.metadata,
      product: order.product,
      totalAmount: order.totalAmount,
      netAmount: order.netAmount,
    });
    if (credits === null || credits <= 0) {
      skipped += 1;
      continue;
    }

    const clerkOrgId =
      resolveOrderClerkOrgId({ metadata: order.metadata }) ??
      fallbackClerkOrgId;

    toGrant.push({
      clerkOrgId,
      amount: credits,
      grantRefId: `polar:order:${order.id}`,
      orderId: order.id,
    });
  }

  return { toGrant, skipped, ordersSeen: seen.size };
}

/**
 * Resolve the caller's active Clerk org from the JWT and require it matches
 * orgSlug. Shared by billing actions (createCheckout, syncWithPolar).
 */
export async function requireOrgMemberInAction(
  ctx: ActionCtx,
  orgSlug: string,
): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw new Error("Not authenticated");
  }

  const raw = identity as Record<string, unknown>;
  const claimSlug =
    typeof raw.org_slug === "string"
      ? raw.org_slug
      : typeof raw.orgSlug === "string"
        ? raw.orgSlug
        : undefined;
  const clerkOrgId =
    typeof raw.org_id === "string"
      ? raw.org_id
      : typeof raw.orgId === "string"
        ? raw.orgId
        : undefined;

  if (claimSlug === undefined || claimSlug !== orgSlug) {
    throw new Error("Not a member of this organization");
  }
  if (clerkOrgId === undefined || clerkOrgId.length === 0) {
    throw new Error("Active organization required");
  }
  return clerkOrgId;
}

export type SyncWithPolarOk = {
  ok: true;
  ordersSeen: number;
  granted: number;
  creditsGranted: number;
  balance: number;
};

export type SyncWithPolarCooldown = {
  ok: false;
  retryAfterSeconds: number;
};

export type SyncWithPolarResult = SyncWithPolarOk | SyncWithPolarCooldown;

/**
 * Manual "Sync purchases": reconcile Polar paid orders → credit ledger.
 * Used when the Polar webhook is not yet wired (dev) or as a fallback.
 * Server-side cooldown (lastPolarSyncAt on the wallet) gates Polar calls.
 * Grants are idempotent via grantRefId `polar:order:{id}`.
 */
export const syncWithPolar = action({
  args: { orgSlug: v.string() },
  handler: async (ctx, args): Promise<SyncWithPolarResult> => {
    const clerkOrgId = await requireOrgMemberInAction(ctx, args.orgSlug);

    // Cooldown gate — read before touching Polar.
    const { lastPolarSyncAt } = await ctx.runQuery(
      internal.wallets.getPolarSyncState,
      { clerkOrgId },
    );
    const now = Date.now();
    if (
      lastPolarSyncAt !== null &&
      now - lastPolarSyncAt < POLAR_SYNC_COOLDOWN_MS
    ) {
      return {
        ok: false,
        retryAfterSeconds: Math.ceil(
          (POLAR_SYNC_COOLDOWN_MS - (now - lastPolarSyncAt)) / 1000,
        ),
      };
    }

    const polar = polarClient();
    const orders = await fetchPaidOrders(polar, clerkOrgId);
    const plan = planSyncGrants(orders, clerkOrgId);

    let granted = 0;
    let creditsGranted = 0;
    let balance = 0;
    for (const grant of plan.toGrant) {
      const result = await ctx.runMutation(internal.wallets.grantCredits, {
        clerkOrgId: grant.clerkOrgId,
        amount: grant.amount,
        grantRefId: grant.grantRefId,
      });
      if (result.applied) {
        granted += 1;
        creditsGranted += grant.amount;
      }
      balance = result.balance;
    }

    // Stamp cooldown + fetch canonical balance when nothing was granted.
    if (plan.toGrant.length === 0) {
      const stamped = await ctx.runMutation(internal.wallets.markPolarSync, {
        clerkOrgId,
      });
      balance = stamped.balance;
    } else {
      await ctx.runMutation(internal.wallets.markPolarSync, { clerkOrgId });
    }

    return {
      ok: true,
      ordersSeen: plan.ordersSeen,
      granted,
      creditsGranted,
      balance,
    };
  },
});

function startOfUtcMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function endOfUtcMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export type CycleKeyBreakdown = {
  keyId: string;
  calls: number;
  credits: number;
};

export type CycleProjectBreakdown = {
  projectId: Id<"projects">;
  name: string;
  slug: string;
  calls: number;
  credits: number;
};

export type CycleBreakdown = {
  cycleStart: number;
  cycleEnd: number;
  totalCalls: number;
  totalCredits: number;
  byKey: CycleKeyBreakdown[];
  byProject: CycleProjectBreakdown[];
};

/**
 * Current UTC calendar-month consumer spend breakdown for billing UI.
 * Counts every recorded usage event (gateway always inserts; no status filter).
 * Index range: by_org_at [cycleStart, cycleEnd).
 */
export const cycleBreakdown = query({
  args: { orgSlug: v.string() },
  handler: async (ctx, args): Promise<CycleBreakdown> => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    const now = Date.now();
    const cycleStart = startOfUtcMonth(now);
    const cycleEnd = endOfUtcMonth(now);

    const events = await ctx.db
      .query("usageEvents")
      .withIndex("by_org_at", (q) =>
        q
          .eq("organizationId", org._id)
          .gte("at", cycleStart)
          .lt("at", cycleEnd),
      )
      .collect();

    const keyMap = new Map<string, { calls: number; credits: number }>();
    const projectMap = new Map<
      Id<"projects">,
      { calls: number; credits: number }
    >();

    let totalCalls = 0;
    let totalCredits = 0;

    for (const event of events) {
      totalCalls += 1;
      totalCredits += event.credits;

      const keyRow = keyMap.get(event.keyId) ?? { calls: 0, credits: 0 };
      keyRow.calls += 1;
      keyRow.credits += event.credits;
      keyMap.set(event.keyId, keyRow);

      const projectRow = projectMap.get(event.projectId) ?? {
        calls: 0,
        credits: 0,
      };
      projectRow.calls += 1;
      projectRow.credits += event.credits;
      projectMap.set(event.projectId, projectRow);
    }

    const byKey: CycleKeyBreakdown[] = [...keyMap.entries()]
      .map(([keyId, row]) => ({
        keyId,
        calls: row.calls,
        credits: row.credits,
      }))
      .sort((a, b) => b.credits - a.credits || a.keyId.localeCompare(b.keyId));

    const byProject: CycleProjectBreakdown[] = [];
    for (const [projectId, row] of projectMap) {
      const project = await ctx.db.get(projectId);
      byProject.push({
        projectId,
        name: project?.name ?? "Unknown project",
        slug: project?.slug ?? "unknown",
        calls: row.calls,
        credits: row.credits,
      });
    }
    byProject.sort(
      (a, b) => b.credits - a.credits || a.slug.localeCompare(b.slug),
    );

    return {
      cycleStart,
      cycleEnd,
      totalCalls,
      totalCredits,
      byKey,
      byProject,
    };
  },
});
