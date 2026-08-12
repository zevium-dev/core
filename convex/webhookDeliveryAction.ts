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
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, args): Promise<void> => {
    const info = await ctx.runQuery(internal.webhooks.getDeliveryForAction, {
      deliveryId: args.deliveryId,
    });
    if (info === null) return;

    if (!info.active) {
      await ctx.runMutation(internal.webhooks.recordDeliveryAttempt, {
        deliveryId: args.deliveryId,
        ok: false,
        error: "Endpoint inactive",
        retryable: false,
      });
      return;
    }

    let signingSecret: string;
    try {
      signingSecret = await decryptSecret(
        requireEncryptedSecret(info.encryptedSecret),
        webhookBinding(info.projectId),
      );
    } catch {
      await ctx.runMutation(internal.webhooks.recordDeliveryAttempt, {
        deliveryId: args.deliveryId,
        ok: false,
        error: "Signing secret unavailable",
        retryable: false,
      });
      return;
    }

    const parsed = JSON.parse(info.payload) as {
      event: string;
      data: unknown;
      timestamp: number;
    };

    const result = await postWebhook(
      {
        url: info.url,
        secret: signingSecret,
        event: parsed.event,
        data: parsed.data,
        timestamp: parsed.timestamp,
        deliveryId: args.deliveryId,
        currentStatus: info.status,
      },
      deliverPinnedHttps,
    );

    if (result.skipped) return;

    await ctx.runMutation(internal.webhooks.recordDeliveryAttempt, {
      deliveryId: args.deliveryId,
      ok: result.ok,
      error: result.error,
      retryable: result.retryable,
    });
  },
});
