import { z } from "zod";

import { authServer } from "~/lib/server/auth";
import { polarClient, getUserCreditedUnits } from "~/lib/server/polar";
import { readConsumedUser } from "~/lib/server/user-pool-gate";
import { secureProcedure } from "~/server/secure-procedure";
import { router } from "~/server/trpc";

const ListInput = z.object({
  page: z.number().int().min(1).max(1000).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});

const ListTopUpOutput = z.object({
  hasNext: z.boolean(),
  items: z.array(
    z.object({
      amountCents: z.number().int(),
      checkoutId: z.string().nullable(),
      createdAt: z.union([z.string(), z.date()]),
      id: z.string(),
    }),
  ),
});

const ListChargesOutput = z.object({
  hasNext: z.boolean(),
  items: z.array(
    z.object({
      costUnits: z.number().int(),
      createdAt: z.union([z.string(), z.date()]),
      host: z.string().nullable(),
      method: z.string().nullable(),
      requestId: z.string().nullable(),
      status: z.number().int().nullable(),
    }),
  ),
});

const KeyRow = z.object({
  createdAt: z.union([z.string(), z.date()]),
  enabled: z.boolean().nullable(),
  id: z.string(),
  lastRequest: z.union([z.string(), z.date()]).nullable(),
  name: z.string().nullable(),
  prefix: z.string().nullable(),
  referenceId: z.string(),
  remaining: z.number().int().nullable(),
  requestCount: z.number().int().nullable(),
});

const ListPerKeyOutput = z.object({
  hasNext: z.boolean(),
  items: z.array(KeyRow),
});

const GetBalanceOutput = z.object({
  available: z.number().int(),
  consumed: z.number().int(),
  creditedUnits: z.number().int(),
  currency: z.literal("credits"),
});

const EMPTY_LIST: { hasNext: boolean; items: never[] } = { hasNext: false, items: [] };

/**
 * User-scoped billing router.
 *
 * Billing unit = authenticated user (Polar customer externalId = userId).
 * Top-ups are created via the `@polar-sh/better-auth` `checkout` plugin
 * endpoint (POST /api/auth/checkout) — there is no `createTopUp` here.
 * This router covers the read surfaces the plugin does not expose:
 * balance, recent top-up orders, recent proxy charges, and per-key quota.
 */
export const creditsRouter = router({
  getBalance: secureProcedure
    .meta({
      requiredPermissions: ["apikey.read"],
      route: { path: "/credits/get-balance", summary: "Get the user's credit balance" },
    })
    .input(z.object({}).optional())
    .output(GetBalanceOutput)
    .query(async ({ ctx }) => {
      const userId = ctx.user.id;
      const [credited, consumed] = await Promise.all([getUserCreditedUnits(userId), readConsumedUser(userId)]);
      return {
        available: Math.max(0, credited - consumed),
        consumed,
        creditedUnits: credited,
        currency: "credits" as const,
      };
    }),

  listCharges: secureProcedure
    .meta({
      requiredPermissions: ["apikey.read"],
      route: { path: "/credits/list-charges", summary: "List recent proxy charge events from Polar" },
    })
    .input(ListInput.optional())
    .output(ListChargesOutput)
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const page = input?.page ?? 1;
      const pageSize = input?.pageSize ?? 20;
      const result = await polarClient.events.list({
        externalCustomerId: userId,
        limit: pageSize,
        name: "proxy_call",
        page,
      });
      const ChargeMetadata = z.object({
        cost_units: z.number().optional(),
        host: z.string().optional(),
        method: z.string().optional(),
        status: z.number().optional(),
      });
      const items = result.result.items.map((e) => {
        const md = ChargeMetadata.parse(e.metadata ?? {});
        return {
          costUnits: md.cost_units ?? 0,
          createdAt: e.timestamp,
          host: md.host ?? null,
          method: md.method ?? null,
          requestId: e.id,
          status: md.status ?? null,
        };
      });
      return { hasNext: page < result.result.pagination.maxPage, items };
    }),
  listPerKeyUsage: secureProcedure
    .meta({
      requiredPermissions: ["apikey.read"],
      route: { path: "/credits/list-per-key-usage", summary: "List the user's API keys with their quota" },
    })
    .input(z.object({}).optional())
    .output(ListPerKeyOutput)
    .query(async ({ ctx }) => {
      // No organizationId: keys are user-owned (referenceId = userId).
      // The plugin returns { apiKeys: ApiKey[], total, limit, offset } but
      // better-auth types it loosely; parse with Zod to validate shape.
      const raw = await authServer.api.listApiKeys({
        headers: ctx.raw.req.headers,
      });
      const parsed = z.object({ apiKeys: KeyRow.array() }).parse(raw);
      return { hasNext: false, items: parsed.apiKeys };
    }),

  listTopUps: secureProcedure
    .meta({
      requiredPermissions: ["apikey.read"],
      route: { path: "/credits/list-top-ups", summary: "List recent top-up orders from Polar" },
    })
    .input(ListInput.optional())
    .output(ListTopUpOutput)
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const page = input?.page ?? 1;
      const pageSize = input?.pageSize ?? 20;
      // Polar customer is addressable by externalId = userId; list orders
      // for that customer. If the customer doesn't exist yet (no top-up
      // performed), Polar returns an empty list.
      const customer = await polarClient.customers.getExternal({ externalId: userId }).catch(() => null);
      if (!customer) return EMPTY_LIST;
      const result = await polarClient.orders.list({
        customerId: customer.id,
        limit: pageSize,
        page,
        sorting: ["-created_at"],
      });
      const items = result.result.items.map((o) => ({
        amountCents: o.subtotalAmount ?? o.totalAmount,
        checkoutId: o.checkoutId,
        createdAt: o.createdAt,
        id: o.id,
      }));
      return { hasNext: page < result.result.pagination.maxPage, items };
    }),
});
