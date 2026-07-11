import { httpRouter } from "convex/server";
import {
  validateEvent,
  WebhookVerificationError,
} from "@polar-sh/sdk/webhooks";
import { Webhook } from "svix";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import {
  resolveOrderClerkOrgId,
  resolveOrderCredits,
} from "./billing";

const http = httpRouter();

type ClerkEmailAddress = {
  email_address?: string;
  id?: string;
};

type ClerkUserEventData = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  image_url?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: ClerkEmailAddress[];
};

type ClerkOrgEventData = {
  id: string;
  name: string;
  slug: string;
  image_url?: string | null;
};

type ClerkWebhookEvent = {
  type: string;
  data: ClerkUserEventData | ClerkOrgEventData | Record<string, unknown>;
};

http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
    if (secret === undefined || secret.length === 0) {
      // Dev fallback: web app calls ensureOrganization / ensureUser instead.
      return new Response("CLERK_WEBHOOK_SIGNING_SECRET not configured", {
        status: 503,
      });
    }

    const svixId = request.headers.get("svix-id");
    const svixTimestamp = request.headers.get("svix-timestamp");
    const svixSignature = request.headers.get("svix-signature");
    if (svixId === null || svixTimestamp === null || svixSignature === null) {
      return new Response("Missing svix headers", { status: 400 });
    }

    const payload = await request.text();
    const wh = new Webhook(secret);

    let event: ClerkWebhookEvent;
    try {
      event = wh.verify(payload, {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSignature,
      }) as ClerkWebhookEvent;
    } catch {
      return new Response("Invalid signature", { status: 400 });
    }

    switch (event.type) {
      case "organization.created":
      case "organization.updated": {
        const data = event.data as ClerkOrgEventData;
        await ctx.runMutation(internal.organizations.upsertFromClerk, {
          clerkOrgId: data.id,
          name: data.name,
          slug: data.slug,
          imageUrl: data.image_url ?? undefined,
        });
        break;
      }
      case "organization.deleted": {
        const data = event.data as ClerkOrgEventData;
        await ctx.runMutation(internal.organizations.deleteFromClerk, {
          clerkOrgId: data.id,
        });
        break;
      }
      case "user.created":
      case "user.updated": {
        const data = event.data as ClerkUserEventData;
        const primaryId = data.primary_email_address_id;
        const emails = data.email_addresses ?? [];
        let email = "";
        for (const entry of emails) {
          if (primaryId !== undefined && primaryId !== null && entry.id === primaryId) {
            email = entry.email_address ?? "";
            break;
          }
        }
        if (email.length === 0 && emails.length > 0) {
          email = emails[0]?.email_address ?? "";
        }
        const nameParts = [data.first_name, data.last_name].filter(
          (part): part is string => typeof part === "string" && part.length > 0,
        );
        const name =
          nameParts.length > 0
            ? nameParts.join(" ")
            : data.username ?? (email || "User");

        await ctx.runMutation(internal.users.upsertFromClerk, {
          clerkUserId: data.id,
          name,
          email,
        });
        break;
      }
      default:
        // Ignore unhandled event types — ack so Svix does not retry forever.
        break;
    }

    return new Response(null, { status: 200 });
  }),
});

http.route({
  path: "/polar-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.POLAR_WEBHOOK_SECRET;
    if (secret === undefined || secret.length === 0) {
      return new Response("POLAR_WEBHOOK_SECRET not configured", {
        status: 503,
      });
    }

    const payload = await request.text();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    let eventType: string;
    let orderData: {
      id: string;
      metadata: Record<string, unknown>;
      product: { metadata: Record<string, unknown> } | null;
      totalAmount: number;
      netAmount: number;
    } | null = null;

    try {
      const event = validateEvent(payload, headers, secret);
      eventType = event.type;
      if (event.type === "order.paid") {
        const order = event.data;
        orderData = {
          id: order.id,
          metadata: order.metadata as Record<string, unknown>,
          product:
            order.product === null || order.product === undefined
              ? null
              : {
                  metadata: order.product.metadata as Record<string, unknown>,
                },
          totalAmount: order.totalAmount,
          netAmount: order.netAmount,
        };
      }
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        return new Response("Invalid signature", { status: 403 });
      }
      return new Response("Webhook verification failed", { status: 400 });
    }

    if (eventType === "order.paid" && orderData !== null) {
      const clerkOrgId = resolveOrderClerkOrgId({
        metadata: orderData.metadata,
      });
      if (clerkOrgId === null) {
        // Not our checkout (missing metadata) — ack, skip grant.
        return new Response(null, { status: 200 });
      }

      const credits = resolveOrderCredits({
        metadata: orderData.metadata,
        product: orderData.product,
        totalAmount: orderData.totalAmount,
        netAmount: orderData.netAmount,
      });

      if (credits === null || credits <= 0) {
        console.error("polar-webhook: could not resolve credits for order", {
          orderId: orderData.id,
        });
        // Ack to avoid infinite retry; ops can re-grant manually.
        return new Response(null, { status: 200 });
      }

      try {
        await ctx.runMutation(internal.wallets.grantCredits, {
          clerkOrgId,
          amount: credits,
          grantRefId: `polar:order:${orderData.id}`,
        });
      } catch (err) {
        // Org not mirrored yet — fail so Polar retries after ensureOrganization.
        const message = err instanceof Error ? err.message : "grant failed";
        console.error("polar-webhook: grantCredits failed", {
          orderId: orderData.id,
          clerkOrgId,
          message,
        });
        return new Response(message, { status: 500 });
      }
    }

    return new Response(null, { status: 200 });
  }),
});

export default http;
