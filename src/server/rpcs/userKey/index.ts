import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { authServer } from "~/lib/server/auth";
import { secureProcedure } from "~/server/secure-procedure";
import { router } from "~/server/trpc";

/**
 * Server-side tRPC for managing user-owned API keys.
 *
 * Keys are user-scoped via the `@better-auth/api-key` plugin config
 * (`references: "user"`); `referenceId = userId`. We do not expose the
 * client `auth.apiKey.*` for create/update/delete because we want a
 * tRPC-shaped API and server-side validation (one-key-per-user guard).
 * All calls go through `auth.api.createApiKey`/`listApiKeys`/
 * `updateApiKey`/`deleteApiKey` here, with the session forwarded.
 */
const DEFAULT_KEY_REMAINING = 1000;

const CreateKeyInput = z.object({
  name: z.string().min(1).max(100),
  remaining: z.number().int().min(1).max(1_000_000).optional(),
});

const UpdateKeyInput = z.object({
  enabled: z.boolean().optional(),
  keyId: z.string(),
  name: z.string().min(1).max(100),
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

export const userKeyRouter = router({
  create: secureProcedure
    .meta({
      requiredPermissions: ["apikey.create"],
      route: { path: "/userKey/create", summary: "Create a user-owned API key" },
    })
    .input(CreateKeyInput)
    .output(apiKeyWithSecret)
    .mutation(async ({ ctx, input }) => {
      // One-key-per-user guard. The DB unique partial index
      // (`apikey_one_per_user`) catches races; this count check gives a
      // clean error message for the common case.
      const existing = await authServer.api.listApiKeys({
        headers: ctx.raw.req.headers,
      });
      const parsed = z.object({ apiKeys: apiKeyShape.array() }).parse(existing);
      if (parsed.apiKeys.length > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "You already have an API key. Delete the existing key first.",
        });
      }

      const created = await authServer.api.createApiKey({
        body: {
          expiresIn: null,
          name: input.name,
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
      route: { path: "/userKey/delete", summary: "Delete a user-owned API key" },
    })
    .input(z.object({ keyId: z.string() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await authServer.api.deleteApiKey({
        body: { keyId: input.keyId },
        headers: ctx.raw.req.headers,
      });
      return { success: true };
    }),

  list: secureProcedure
    .meta({
      requiredPermissions: ["apikey.read"],
      route: { path: "/userKey/list", summary: "List user-owned API keys" },
    })
    .input(z.object({}).optional())
    .output(z.array(apiKeyShape))
    .query(async ({ ctx }) => {
      const result = await authServer.api.listApiKeys({
        headers: ctx.raw.req.headers,
      });
      const parsed = z.object({ apiKeys: apiKeyShape.array() }).parse(result);
      return parsed.apiKeys;
    }),

  update: secureProcedure
    .meta({
      requiredPermissions: ["apikey.update"],
      route: { path: "/userKey/update", summary: "Update a user-owned API key" },
    })
    .input(UpdateKeyInput)
    .output(apiKeyShape)
    .mutation(async ({ ctx, input }) => {
      const updated = await authServer.api.updateApiKey({
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
