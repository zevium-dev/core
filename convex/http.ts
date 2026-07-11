import { httpRouter } from "convex/server";
import {
  validateEvent,
  WebhookVerificationError,
} from "@polar-sh/sdk/webhooks";
import { Webhook } from "svix";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { resolveOrderClerkOrgId, resolveOrderCredits } from "./billing";

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
          if (
            primaryId !== undefined &&
            primaryId !== null &&
            entry.id === primaryId
          ) {
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
            : (data.username ?? (email || "User"));

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

const MAX_INGEST_EVENTS = 500;

type IngestUsageEvent = {
  organizationId: string;
  projectId: string;
  endpoint: string;
  method: string;
  credits: number;
  status: number;
  latencyMs: number;
  keyId: string;
  at: number;
  settleRefId: string;
};

/**
 * Validate gateway → Convex usage flush body.
 * Exported for unit tests; http action is the production boundary.
 */
export function parseIngestUsageBody(
  body: unknown,
):
  | { ok: true; events: IngestUsageEvent[] }
  | { ok: false; status: number; error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "invalid body" };
  }
  if (!("events" in body) || !Array.isArray(body.events)) {
    return { ok: false, status: 400, error: "events array required" };
  }
  if (body.events.length > MAX_INGEST_EVENTS) {
    return { ok: false, status: 400, error: "too many events" };
  }

  const events: IngestUsageEvent[] = [];
  for (const raw of body.events) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, status: 400, error: "invalid event" };
    }
    const e = raw as Record<string, unknown>;
    const organizationId = e.organizationId;
    const projectId = e.projectId;
    const endpoint = e.endpoint;
    const method = e.method;
    const credits = e.credits;
    const status = e.status;
    const latencyMs = e.latencyMs;
    const keyId = e.keyId;
    const at = e.at;
    const settleRefId = e.settleRefId;

    if (typeof organizationId !== "string" || organizationId.length === 0) {
      return { ok: false, status: 400, error: "invalid event" };
    }
    if (typeof projectId !== "string" || projectId.length === 0) {
      return { ok: false, status: 400, error: "invalid event" };
    }
    if (typeof endpoint !== "string") {
      return { ok: false, status: 400, error: "invalid event" };
    }
    if (typeof method !== "string") {
      return { ok: false, status: 400, error: "invalid event" };
    }
    if (typeof credits !== "number" || !Number.isFinite(credits)) {
      return { ok: false, status: 400, error: "invalid event" };
    }
    if (typeof status !== "number" || !Number.isFinite(status)) {
      return { ok: false, status: 400, error: "invalid event" };
    }
    if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs)) {
      return { ok: false, status: 400, error: "invalid event" };
    }
    if (typeof keyId !== "string") {
      return { ok: false, status: 400, error: "invalid event" };
    }
    if (typeof at !== "number" || !Number.isFinite(at)) {
      return { ok: false, status: 400, error: "invalid event" };
    }
    if (typeof settleRefId !== "string" || settleRefId.trim() === "") {
      return { ok: false, status: 400, error: "invalid event" };
    }

    events.push({
      organizationId,
      projectId,
      endpoint,
      method,
      credits,
      status,
      latencyMs,
      keyId,
      at,
      settleRefId,
    });
  }

  return { ok: true, events };
}

http.route({
  path: "/ingest-usage",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.GATEWAY_INTERNAL_SECRET;
    if (secret === undefined || secret.length === 0) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const provided = request.headers.get("x-internal-secret");
    if (provided === null || provided !== secret) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const parsed = parseIngestUsageBody(json);
    if (!parsed.ok) {
      return new Response(JSON.stringify({ error: parsed.error }), {
        status: parsed.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const result = await ctx.runMutation(internal.wallets.recordUsage, {
        events: parsed.events.map((e) => ({
          organizationId: e.organizationId as Id<"organizations">,
          projectId: e.projectId as Id<"projects">,
          endpoint: e.endpoint,
          method: e.method,
          credits: e.credits,
          status: e.status,
          latencyMs: e.latencyMs,
          keyId: e.keyId,
          at: e.at,
          settleRefId: e.settleRefId,
        })),
      });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "ingest failed";
      console.error("ingest-usage: recordUsage failed", { message });
      return new Response(JSON.stringify({ error: "ingest failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

/**
 * Gateway pull: grant-kind ledger entries for an org, bounded to newest 500.
 * Shared-secret gated (x-internal-secret === GATEWAY_INTERNAL_SECRET).
 * The wallet DO syncGrants op consumes this to mirror control-plane grants
 * into the edge balance without per-request Clerk/Convex coupling.
 */
http.route({
  path: "/wallet-grants",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.GATEWAY_INTERNAL_SECRET;
    if (secret === undefined || secret.length === 0) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const provided = request.headers.get("x-internal-secret");
    if (provided === null || provided !== secret) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const url = new URL(request.url);
    const clerkOrgId = url.searchParams.get("clerkOrgId") ?? "";
    if (clerkOrgId.length === 0) {
      return new Response(JSON.stringify({ error: "clerkOrgId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const result = await ctx.runQuery(internal.wallets.listGrantsForGateway, {
        clerkOrgId,
      });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "wallet-grants failed";
      console.error("wallet-grants: listGrantsForGateway failed", { message });
      return new Response(JSON.stringify({ error: "wallet-grants failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

export default http;
