"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import {
  decryptSecret,
  requireEncryptedSecret,
  webhookBinding,
} from "./lib/credentialCrypto";
import { postWebhook } from "./lib/webhookDelivery";
import { deliverPinnedHttps } from "./lib/webhookTransport";

/**
 * Delivery action: resolve and validate every target, POST the webhook, then
 * record the result. DNS checks run immediately before each request and after
 * every redirect.
 */
export const deliverWebhook = internalAction({
  args: {
    deliveryId: v.id("webhookDeliveries"),
    recoveryLeaseToken: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const leaseToken = crypto.randomUUID();
    const info = await ctx.runMutation(internal.webhooks.claimDelivery, {
      deliveryId: args.deliveryId,
      leaseToken,
      expectedExpiredLeaseToken: args.recoveryLeaseToken,
    });
    if (info === null) return;

    if (!info.active) {
      await ctx.runMutation(internal.webhooks.recordDeliveryAttempt, {
        deliveryId: args.deliveryId,
        ok: false,
        error: "Endpoint inactive",
        retryable: false,
        leaseToken,
      });
      return;
    }

    let signingSecret: string;
    try {
      signingSecret = await decryptSecret(
        requireEncryptedSecret(info.encryptedSecret),
        webhookBinding(info.projectId, info.secretVersion),
      );
    } catch {
      await ctx.runMutation(internal.webhooks.recordDeliveryAttempt, {
        deliveryId: args.deliveryId,
        ok: false,
        error: "Signing secret unavailable",
        retryable: false,
        leaseToken,
      });
      return;
    }

    let parsed: { event: string; data: unknown };
    try {
      parsed = JSON.parse(info.payload) as { event: string; data: unknown };
      if (typeof parsed.event !== "string") throw new Error("invalid event");
    } catch {
      await ctx.runMutation(internal.webhooks.recordDeliveryAttempt, {
        deliveryId: args.deliveryId,
        ok: false,
        error: "Delivery payload unavailable",
        retryable: false,
        leaseToken,
      });
      return;
    }

    const result = await postWebhook(
      {
        url: info.url,
        secret: signingSecret,
        event: parsed.event,
        data: parsed.data,
        // Retry bodies get fresh signed attempt time while retaining stable id.
        timestamp: Date.now(),
        deliveryId: String(args.deliveryId),
        secretVersion: info.secretVersion,
      },
      deliverPinnedHttps,
    );

    await ctx.runMutation(internal.webhooks.recordDeliveryAttempt, {
      deliveryId: args.deliveryId,
      ok: result.ok,
      error: result.error,
      retryable: result.retryable,
      leaseToken,
    });
  },
});
