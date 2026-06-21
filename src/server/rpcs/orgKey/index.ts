import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db, orm, schema } from "~/db";
import { authServer } from "~/lib/server/auth";
import { secureProcedure } from "~/server/secure-procedure";
import { router } from "~/server/trpc";

/**
 * Server-side tRPC for managing org-owned API keys.
 *
 * We do NOT expose the client `auth.apiKey.*` for org-owned keys: the
 * client plugin doesn't enforce `organizationId` + `metadata.creatorUserId`
 * server-side, and org ownership comes from the plugin config
 * (`references: "organization"`). All calls go through
 * `auth.api.createApiKey` here, with the session forwarded.
 */
const DEFAULT_KEY_REMAINING = 1000;

const CreateKeyInput = z.object({
  name: z.string().min(1).max(100),
  organizationId: z.string(),
  remaining: z.number().int().min(1).max(1_000_000).optional(),
});

const UpdateKeyInput = z.object({
  enabled: z.boolean().optional(),
  keyId: z.string(),
  name: z.string().min(1).max(100),
  organizationId: z.string(),
});

const DeleteKeyInput = z.object({
  keyId: z.string(),
  organizationId: z.string(),
});

const ListKeysInput = z.object({
  organizationId: z.string(),
});

const apiKeyShape = z.object({
  createdAt: z.date(),
  enabled: z.boolean(),
  expiresAt: z.date().nullable(),
  id: z.string(),
  lastRefillAt: z.date().nullable(),
  lastRequest: z.date().nullable(),
  name: z.string().nullable(),
  permissions: z.record(z.string(), z.array(z.string())).nullable(),
  prefix: z.string().nullable(),
  referenceId: z.string(),
  refillAmount: z.number().nullable(),
  refillInterval: z.number().nullable(),
  remaining: z.number().nullable(),
  requestCount: z.number(),
  start: z.string().nullable(),
  updatedAt: z.date(),
});

const apiKeyWithSecret = apiKeyShape.extend({ key: z.string() });

function assertOrgMatch(ctx: { orgId: string | undefined }, organizationId: string) {
  if (!ctx.orgId || ctx.orgId !== organizationId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Organization ID mismatch" });
  }
}

async function findKeyForOrg(keyId: string, organizationId: string) {
  const row = await db
    .select({ referenceId: schema.apikey.referenceId })
    .from(schema.apikey)
    .where(orm.eq(schema.apikey.id, keyId))
    .limit(1)
    .then((r) => r.at(0));
  if (!row || row.referenceId !== organizationId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "API key not found" });
  }
}

export const orgKeyRouter = router({
  create: secureProcedure
    .meta({
      requiredPermissions: ["apikey.create"],
      route: { path: "/orgKey/create", summary: "Create an org-owned API key" },
    })
    .input(CreateKeyInput)
    .output(apiKeyWithSecret)
    .mutation(async ({ ctx, input }) => {
      assertOrgMatch(ctx, input.organizationId);

      // One-key-per-user guard: prevent user from stacking keys in same org.
      // The DB unique partial index (§3.22) catches races; this count check
      // gives a clean error message for the common case.
      const existingCount = await db
        .select({ count: orm.count() })
        .from(schema.apikey)
        .where(
          sql`${schema.apikey.referenceId} = ${input.organizationId} AND json_extract(${schema.apikey.metadata}, '$.creatorUserId') = ${ctx.user.id}`,
        )
        .then((r) => r.at(0)?.count ?? 0);

      if (existingCount > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "You already have an API key for this organization. Delete the existing key first.",
        });
      }

      const created = await authServer.api.createApiKey({
        body: {
          expiresIn: null,
          metadata: { creatorUserId: ctx.user.id },
          name: input.name,
          organizationId: input.organizationId,
          permissions: { api: ["read"] },
          rateLimitEnabled: true,
          rateLimitMax: 60,
          rateLimitTimeWindow: 60_000,
          remaining: input.remaining ?? DEFAULT_KEY_REMAINING,
        },
        headers: ctx.raw.req.headers,
      });
      if (!created?.key) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create API key" });
      }
      return { ...created, key: created.key };
    }),

  delete: secureProcedure
    .meta({
      requiredPermissions: ["apikey.delete"],
      route: { path: "/orgKey/delete", summary: "Delete an org-owned API key" },
    })
    .input(DeleteKeyInput)
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      assertOrgMatch(ctx, input.organizationId);
      await findKeyForOrg(input.keyId, input.organizationId);
      await authServer.api.deleteApiKey({
        body: { keyId: input.keyId },
        headers: ctx.raw.req.headers,
      });
      return { success: true };
    }),

  list: secureProcedure
    .meta({
      requiredPermissions: ["apikey.read"],
      route: { path: "/orgKey/list", summary: "List org-owned API keys" },
    })
    .input(ListKeysInput)
    .output(z.array(apiKeyShape))
    .query(async ({ ctx, input }) => {
      assertOrgMatch(ctx, input.organizationId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await authServer.api.listApiKeys({
        headers: ctx.raw.req.headers,
        query: { organizationId: input.organizationId },
      });
      // The Better Auth client returns either an array directly or a paged object.
      const list: unknown[] = Array.isArray(result) ? result : (result?.apiKeys ?? []);
      return list as never[];
    }),

  update: secureProcedure
    .meta({
      requiredPermissions: ["apikey.update"],
      route: { path: "/orgKey/update", summary: "Update an org-owned API key" },
    })
    .input(UpdateKeyInput)
    .output(apiKeyShape)
    .mutation(async ({ ctx, input }) => {
      assertOrgMatch(ctx, input.organizationId);
      await findKeyForOrg(input.keyId, input.organizationId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updated: any = await authServer.api.updateApiKey({
        body: {
          enabled: input.enabled,
          keyId: input.keyId,
          name: input.name,
        },
        headers: ctx.raw.req.headers,
      });
      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "API key not found" });
      }
      return updated;
    }),
});
