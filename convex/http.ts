import Stripe from "stripe";
import { httpRouter } from "convex/server";
import { Webhook } from "svix";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { stripeClient } from "./billing";

const http = httpRouter();

type ClerkEmailAddress = { email_address?: string; id?: string };
type ClerkUserEventData = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
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
    let event: ClerkWebhookEvent;
    try {
      event = new Webhook(secret).verify(await request.text(), {
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
      case "organization.deleted":
        await ctx.runMutation(internal.organizations.deleteFromClerk, {
          clerkOrgId: (event.data as ClerkOrgEventData).id,
        });
        break;
      case "user.created":
      case "user.updated": {
        const data = event.data as ClerkUserEventData;
        const primary = data.email_addresses?.find(
          (entry) => entry.id === data.primary_email_address_id,
        );
        const email =
          primary?.email_address ??
          data.email_addresses?.[0]?.email_address ??
          "";
        const name =
          [data.first_name, data.last_name]
            .filter(
              (part): part is string =>
                typeof part === "string" && part.length > 0,
            )
            .join(" ") ||
          data.username ||
          email ||
          "User";
        await ctx.runMutation(internal.users.upsertFromClerk, {
          clerkUserId: data.id,
          name,
          email,
        });
        break;
      }
      case "user.deleted":
        await ctx.runMutation(internal.users.deleteFromClerk, {
          clerkUserId: (event.data as ClerkUserEventData).id,
        });
        break;
      default:
        break;
    }
    return new Response(null, { status: 200 });
  }),
});

export type StripeWebhookVerifier = {
  webhooks: {
    constructEventAsync: (
      payload: string,
      signature: string,
      secret: string,
    ) => Promise<Stripe.Event>;
  };
};

/** Raw-body verification seam: no parsed JSON reaches Stripe verification. */
export async function verifyStripeWebhook(
  rawBody: string,
  signature: string | null,
  secret: string | undefined,
  verifier: StripeWebhookVerifier,
): Promise<Stripe.Event> {
  if (secret === undefined || secret.trim() === "")
    throw new Error("Webhook secret is not configured");
  if (signature === null || signature.trim() === "")
    throw new Error("Stripe signature is missing");
  return await verifier.webhooks.constructEventAsync(
    rawBody,
    signature,
    secret,
  );
}

function stripeWebhookRoute(
  path: string,
  secretName: "STRIPE_WEBHOOK_SECRET" | "STRIPE_CONNECT_WEBHOOK_SECRET",
) {
  http.route({
    path,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const rawBody = await request.text();
      let event: Stripe.Event;
      try {
        event = await verifyStripeWebhook(
          rawBody,
          request.headers.get("stripe-signature"),
          process.env[secretName],
          stripeClient(),
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Invalid Stripe signature";
        console.error("stripe webhook verification failed", { path, message });
        const status =
          message === "Webhook secret is not configured" ? 503 : 400;
        return new Response(
          status === 503 ? message : "Invalid Stripe signature",
          { status },
        );
      }
      if (
        !("id" in event.data.object) ||
        typeof event.data.object.id !== "string"
      ) {
        return new Response("Unsupported Stripe event object", { status: 400 });
      }
      const objectId = event.data.object.id;
      const stripeAccount =
        typeof event.account === "string" ? event.account : "platform";
      const receipt = await ctx.runMutation(
        internal.billing.receiveStripeEvent,
        {
          stripeEventId: event.id,
          stripeAccount,
          eventType: event.type,
          objectId,
        },
      );
      if (receipt.isNew) {
        await ctx.scheduler.runAfter(0, internal.billing.processStripeEvent, {
          stripeEventId: event.id,
          stripeAccount,
          eventType: event.type,
          objectId,
        });
      }
      return new Response(null, { status: 200 });
    }),
  });
}

stripeWebhookRoute("/stripe-webhook", "STRIPE_WEBHOOK_SECRET");
stripeWebhookRoute("/stripe-connect-webhook", "STRIPE_CONNECT_WEBHOOK_SECRET");

http.route({
  path: "/stripe-connect-v2-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secrets = [
      process.env.STRIPE_CONNECT_V2_WEBHOOK_SECRET,
      process.env.STRIPE_CONNECT_V2_PLATFORM_WEBHOOK_SECRET,
    ].filter(
      (secret): secret is string =>
        secret !== undefined && secret.trim() !== "",
    );
    if (secrets.length === 0) {
      return new Response("Webhook secret is not configured", { status: 503 });
    }
    const signature = request.headers.get("stripe-signature");
    if (signature === null || signature.trim() === "") {
      return new Response("Invalid Stripe signature", { status: 400 });
    }
    const rawBody = await request.text();
    let event: Stripe.V2.Core.EventNotification | null = null;
    for (const secret of secrets) {
      try {
        event = await stripeClient().parseEventNotificationAsync(
          rawBody,
          signature,
          secret,
        );
        break;
      } catch {
        // Try the next configured destination secret.
      }
    }
    if (event === null) {
      return new Response("Invalid Stripe signature", { status: 400 });
    }
    const objectId =
      "related_object" in event ? event.related_object?.id : undefined;
    if (typeof objectId !== "string" || objectId.length === 0) {
      return new Response("Unsupported Stripe event object", { status: 400 });
    }
    const receipt = await ctx.runMutation(internal.billing.receiveStripeEvent, {
      stripeEventId: event.id,
      stripeAccount: "platform",
      eventType: event.type,
      objectId,
    });
    if (receipt.isNew) {
      await ctx.scheduler.runAfter(0, internal.billing.processStripeEvent, {
        stripeEventId: event.id,
        stripeAccount: "platform",
        eventType: event.type,
        objectId,
      });
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
  consumerClerkOrgId: string;
};

/** Parse exactly the one-wallet settlement batch accepted from a Wallet DO. */
export function parseIngestUsageBody(
  body: unknown,
):
  | { ok: true; events: IngestUsageEvent[] }
  | { ok: false; status: number; error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "invalid body" };
  }
  const candidate = body as Record<string, unknown>;
  if (!Array.isArray(candidate.events))
    return { ok: false, status: 400, error: "events array required" };
  if (
    candidate.events.length === 0 ||
    candidate.events.length > MAX_INGEST_EVENTS
  ) {
    return { ok: false, status: 400, error: "invalid event count" };
  }
  const events: IngestUsageEvent[] = [];
  let consumerClerkOrgId: string | null = null;
  for (const raw of candidate.events) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, status: 400, error: "invalid event" };
    }
    const event = raw as Record<string, unknown>;
    const requiredStrings = [
      event.organizationId,
      event.projectId,
      event.endpoint,
      event.method,
      event.keyId,
      event.settleRefId,
      event.consumerClerkOrgId,
    ];
    if (
      requiredStrings.some(
        (value) => typeof value !== "string" || value.trim() === "",
      )
    ) {
      return { ok: false, status: 400, error: "invalid event" };
    }
    if (
      typeof event.credits !== "number" ||
      !Number.isSafeInteger(event.credits) ||
      event.credits < 0 ||
      typeof event.status !== "number" ||
      !Number.isFinite(event.status) ||
      typeof event.latencyMs !== "number" ||
      !Number.isFinite(event.latencyMs) ||
      typeof event.at !== "number" ||
      !Number.isFinite(event.at)
    ) {
      return { ok: false, status: 400, error: "invalid event" };
    }
    const consumer = event.consumerClerkOrgId as string;
    if (consumerClerkOrgId !== null && consumerClerkOrgId !== consumer) {
      return { ok: false, status: 400, error: "mixed consumer organizations" };
    }
    consumerClerkOrgId = consumer;
    events.push({
      organizationId: event.organizationId as string,
      projectId: event.projectId as string,
      endpoint: event.endpoint as string,
      method: event.method as string,
      credits: event.credits,
      status: event.status,
      latencyMs: event.latencyMs,
      keyId: event.keyId as string,
      at: event.at,
      settleRefId: event.settleRefId as string,
      consumerClerkOrgId: consumer,
    });
  }
  return { ok: true, events };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

const RELEASE_REQUEST_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function parseReleaseProbeBody(
  body: unknown,
): { ok: true; requestId: string } | { ok: false } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false };
  }
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    typeof record.requestId !== "string" ||
    !RELEASE_REQUEST_ID_RE.test(record.requestId)
  ) {
    return { ok: false };
  }
  return { ok: true, requestId: record.requestId };
}

/** Constant-work comparison for fixed release probe credentials. */
export function releaseProbeSecretMatches(
  expected: string | undefined,
  received: string | null,
): boolean {
  if (expected === undefined || expected.length === 0 || received === null) {
    return false;
  }
  const expectedBytes = new TextEncoder().encode(expected);
  const receivedBytes = new TextEncoder().encode(received);
  const length = Math.max(expectedBytes.length, receivedBytes.length);
  let difference = expectedBytes.length ^ receivedBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (expectedBytes[index] ?? 0) ^ (receivedBytes[index] ?? 0);
  }
  return difference === 0;
}

http.route({
  path: "/ingest-usage",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.GATEWAY_INTERNAL_SECRET;
    if (
      secret === undefined ||
      secret.length === 0 ||
      request.headers.get("x-internal-secret") !== secret
    ) {
      return json({ error: "unauthorized" }, 401);
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid body" }, 400);
    }
    const parsed = parseIngestUsageBody(body);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    try {
      const result = await ctx.runMutation(internal.wallets.recordUsage, {
        events: parsed.events.map((event) => ({
          ...event,
          organizationId: event.organizationId as Id<"organizations">,
          projectId: event.projectId as Id<"projects">,
        })),
      });
      return json(result, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : "ingest failed";
      console.error("ingest-usage failed", { message });
      return json({ error: "ingest failed" }, 500);
    }
  }),
});

/**
 * Read-only, request-scoped release proof. Separate credential prevents release
 * automation from gaining gateway ingest, deploy, or general Convex read power.
 */
http.route({
  path: "/release-probe-accounting",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const configuredSecret = process.env.RELEASE_PROBE_SECRET;
    if (configuredSecret === undefined || configuredSecret.length === 0) {
      return json({ error: "release probe unavailable" }, 503);
    }
    if (
      !releaseProbeSecretMatches(
        configuredSecret,
        request.headers.get("x-release-probe-secret"),
      )
    ) {
      return json({ error: "unauthorized" }, 401);
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid body" }, 400);
    }
    const parsed = parseReleaseProbeBody(body);
    if (!parsed.ok) return json({ error: "invalid body" }, 400);

    try {
      const accounting = await ctx.runQuery(
        internal.wallets.getReleaseProbeAccounting,
        { requestId: parsed.requestId },
      );
      if (accounting === null) return json({ status: "pending" }, 202);
      return json({ status: "settled", accounting }, 200);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "release probe failed";
      console.error("release probe accounting failed", { message });
      return json({ error: "release probe failed" }, 500);
    }
  }),
});

/** Authoritative Wallet DO reconciliation checkpoint; no public access. */
http.route({
  path: "/wallet-grants",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.GATEWAY_INTERNAL_SECRET;
    if (
      secret === undefined ||
      secret.length === 0 ||
      request.headers.get("x-internal-secret") !== secret
    ) {
      return json({ error: "unauthorized" }, 401);
    }
    const clerkOrgId =
      new URL(request.url).searchParams.get("clerkOrgId") ?? "";
    if (clerkOrgId.trim() === "")
      return json({ error: "clerkOrgId required" }, 400);
    try {
      return json(
        await ctx.runQuery(internal.wallets.getGatewayWallet, { clerkOrgId }),
        200,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "wallet checkpoint failed";
      console.error("wallet checkpoint failed", { message });
      return json({ error: "wallet checkpoint failed" }, 500);
    }
  }),
});

/** Published spec plus publisher credentials; gateway-only. */
http.route({
  path: "/gateway-spec",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.GATEWAY_INTERNAL_SECRET;
    if (
      secret === undefined ||
      secret.length === 0 ||
      request.headers.get("x-internal-secret") !== secret
    ) {
      return json({ error: "unauthorized" }, 401);
    }
    const url = new URL(request.url);
    const publisherHandle =
      url.searchParams.get("publisherHandle")?.trim() ?? "";
    const projectSlug = url.searchParams.get("projectSlug")?.trim() ?? "";
    if (publisherHandle === "" || projectSlug === "") {
      return json({ error: "publisherHandle and projectSlug required" }, 400);
    }
    try {
      const payload = await ctx.runQuery(
        internal.specs.getPublishedForGatewayInternal,
        {
          publisherHandle,
          projectSlug,
        },
      );
      return json(payload, 200);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "gateway spec failed";
      console.error("gateway spec failed", { message });
      return json({ error: "gateway spec failed" }, 500);
    }
  }),
});

export default http;
