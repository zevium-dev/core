import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "~/db";
import { serverEnv } from "~/env/server";
import { createCreditsCheckout, ensureOrgCustomer, getOrgCreditedUnits } from "~/lib/server/polar";
import { readConsumed } from "~/lib/server/org-pool-gate";
import { secureProcedure } from "~/server/secure-procedure";
import { router } from "~/server/trpc";

const MIN_TOP_UP_USD = 20;

const CreateTopUpInput = z.object({
  amountUsd: z.number().int().min(MIN_TOP_UP_USD).max(100_000),
  organizationId: z.string(),
  returnUrl: z.string().url().optional(),
});

const ListByOrgInput = z.object({
  organizationId: z.string(),
  page: z.number().int().min(1).max(1000).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});

const ListPerKeyInput = z.object({
  organizationId: z.string(),
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

const ListPerKeyOutput = z.object({
  hasNext: z.boolean(),
  items: z.array(
    z.object({
      createdAt: z.union([z.string(), z.date()]),
      enabled: z.boolean().nullable(),
      id: z.string(),
      lastRequest: z.union([z.string(), z.date()]).nullable(),
      name: z.string().nullable(),
      prefix: z.string().nullable(),
      referenceId: z.string(),
      remaining: z.number().int().nullable(),
      requestCount: z.number().int().nullable(),
    }),
  ),
});

const GetBalanceOutput = z.object({
  available: z.number().int(),
  consumed: z.number().int(),
  creditedUnits: z.number().int(),
  currency: z.literal("credits"),
});

export const creditsRouter = router({
  createTopUp: secureProcedure
    .meta({
      requiredPermissions: ["organization.view"],
      route: { path: "/credits/create-top-up", summary: "Create a Polar checkout for a top-up" },
    })
    .input(CreateTopUpInput)
    .output(z.object({ checkoutId: z.string(), url: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.orgId || ctx.orgId !== input.organizationId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Organization ID mismatch" });
      }
      const org = await db
        .select({
          id: schema.organization.id,
          name: schema.organization.name,
          polarCustomerId: schema.organization.polarCustomerId,
          polarBillingEmail: schema.organization.polarBillingEmail,
        })
        .from(schema.organization)
        .where(eq(schema.organization.id, input.organizationId))
        .limit(1)
        .then((r) => r.at(0));
      if (!org) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Organization not found" });
      }
      const successUrl =
        input.returnUrl ?? `${new URL(ctx.raw.req.url).origin}/app/settings/credits?checkout_id={CHECKOUT_ID}`;
      await ensureOrgCustomer(org);
      return createCreditsCheckout({
        orgId: org.id,
        amountUsd: input.amountUsd,
        successUrl,
      });
    }),

  getBalance: secureProcedure
    .meta({
      requiredPermissions: ["organization.view"],
      route: { path: "/credits/get-balance", summary: "Get the org's credit pool balance" },
    })
    .input(z.object({ organizationId: z.string() }))
    .output(GetBalanceOutput)
    .query(async ({ input }) => {
      const [credited, consumed] = await Promise.all([
        getOrgCreditedUnits(input.organizationId),
        readConsumed(input.organizationId),
      ]);
      const available = Math.max(0, credited - consumed);
      return { available, consumed, creditedUnits: credited, currency: "credits" as const };
    }),

  listCharges: secureProcedure
    .meta({
      requiredPermissions: ["organization.view"],
      route: { path: "/credits/list-charges", summary: "List recent proxy charge events from Polar" },
    })
    .input(ListByOrgInput)
    .output(ListChargesOutput)
    .query(async ({ input }) => {
      const page = input.page ?? 1;
      const pageSize = input.pageSize ?? 20;
      const { polarClient } = await import("~/lib/server/polar");
      const result = await polarClient.events.list({
        externalCustomerId: input.organizationId,
        limit: pageSize,
        name: "proxy_call",
        page,
      });
      const items = result.result.items.map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const md: any = e.metadata ?? {};
          return {
            costUnits: typeof md.cost_units === "number" ? md.cost_units : 0,
            createdAt: e.createdAt,
            host: typeof md.host === "string" ? md.host : null,
            method: typeof md.method === "string" ? md.method : null,
            requestId: e.externalId ?? null,
            status: typeof md.status === "number" ? md.status : null,
          };
        },
      );
      const hasNext = page < result.result.pagination.maxPage;
      return { hasNext, items };
    }),

  listPerKeyUsage: secureProcedure
    .meta({
      requiredPermissions: ["apikey.read"],
      route: { path: "/credits/list-per-key-usage", summary: "List API keys with their quota" },
    })
    .input(ListPerKeyInput)
    .output(ListPerKeyOutput)
    .query(async ({ ctx, input }) => {
      if (!ctx.orgId || ctx.orgId !== input.organizationId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Organization ID mismatch" });
      }
      const { authServer } = await import("~/lib/server/auth");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await authServer.api.listApiKeys({
        headers: ctx.raw.req.headers,
        query: { organizationId: input.organizationId },
      });
      const list = Array.isArray(result) ? result : (result?.apiKeys ?? []);
      const items = list.map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (k: any) => ({
          createdAt: k.createdAt,
          enabled: k.enabled,
          id: k.id,
          lastRequest: k.lastRequest,
          name: k.name,
          prefix: k.prefix,
          referenceId: k.referenceId,
          remaining: k.remaining,
          requestCount: k.requestCount,
        }),
      );
      return { hasNext: false, items };
    }),

  listTopUps: secureProcedure
    .meta({
      requiredPermissions: ["organization.view"],
      route: { path: "/credits/list-top-ups", summary: "List recent top-up orders from Polar" },
    })
    .input(ListByOrgInput)
    .output(ListTopUpOutput)
    .query(async ({ input }) => {
      const page = input.page ?? 1;
      const pageSize = input.pageSize ?? 20;
      const { polarClient } = await import("~/lib/server/polar");
      const org = await db
        .select({ polarCustomerId: schema.organization.polarCustomerId })
        .from(schema.organization)
        .where(eq(schema.organization.id, input.organizationId))
        .limit(1)
        .then((r) => r.at(0));
      if (!org?.polarCustomerId) {
        return { hasNext: false, items: [] };
      }
      const result = await polarClient.orders.list({
        customerId: org.polarCustomerId,
        limit: pageSize,
        page,
        productId: serverEnv.POLAR_PRODUCT_ID_CREDITS,
        sorting: ["-created_at"],
      });
      const items = result.result.items.map((o) => ({
        amountCents: o.subtotalAmount ?? o.totalAmount,
        checkoutId: o.checkoutId,
        createdAt: o.createdAt,
        id: o.id,
      }));
      const hasNext = page < result.result.pagination.maxPage;
      return { hasNext, items };
    }),
});
