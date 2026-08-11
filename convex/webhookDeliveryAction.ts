"use node";

import { lookup } from "node:dns/promises";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { postWebhook } from "./lib/webhookDelivery";

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

    const parsed = JSON.parse(info.payload) as {
      event: string;
      data: unknown;
      timestamp: number;
    };

    const result = await postWebhook(
      {
        url: info.url,
        secret: info.secret,
        event: parsed.event,
        data: parsed.data,
        timestamp: parsed.timestamp,
      },
      fetch,
      async (hostname) =>
        (await lookup(hostname, { all: true })).map(({ address }) => address),
    );

    await ctx.runMutation(internal.webhooks.recordDeliveryAttempt, {
      deliveryId: args.deliveryId,
      ok: result.ok,
      error: result.error,
    });
  },
});
