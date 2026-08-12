import Stripe from "stripe";
import {
  MAX_ENDPOINT_COST_CREDITS,
  MAX_USAGE_INGEST_EVENTS,
} from "@zevium/shared";
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
  updated_at?: number;
  deleted_at?: number | null;
};
type ClerkMembershipEventData = {
  organization: { id: string };
  public_user_data: { user_id: string };
};
type ClerkWebhookEvent = {
  type: string;
  data:
    | ClerkUserEventData
    | ClerkOrgEventData
    | ClerkMembershipEventData
    | Record<string, unknown>;
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
    const signedAtSeconds = Number(svixTimestamp);
    if (!Number.isSafeInteger(signedAtSeconds) || signedAtSeconds <= 0) {
      return new Response("Invalid svix timestamp", { status: 400 });
    }
    switch (event.type) {
      case "organization.created":
      case "organization.updated": {
        const data = event.data as ClerkOrgEventData;
        const sourceTimestamp = data.updated_at ?? signedAtSeconds * 1000;
        await ctx.runMutation(internal.organizations.applyOrganizationWebhook, {
          svixId,
          eventTimestamp: sourceTimestamp,
          eventType: event.type,
          clerkOrgId: data.id,
          name: data.name,
          slug: data.slug,
          imageUrl: data.image_url ?? undefined,
        });
        break;
      }
      case "organization.deleted": {
        const data = event.data as ClerkOrgEventData;
        await ctx.runMutation(internal.organizations.applyOrganizationWebhook, {
          svixId,
          eventTimestamp:
            data.deleted_at ?? data.updated_at ?? signedAtSeconds * 1000,
          eventType: "organization.deleted",
          clerkOrgId: data.id,
        });
        break;
      }
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
      case "organizationMembership.deleted": {
        const data = event.data as ClerkMembershipEventData;
        if (
          typeof data.organization?.id !== "string" ||
          typeof data.public_user_data?.user_id !== "string"
        ) {
          return new Response("Invalid membership event", { status: 400 });
        }
        await ctx.runMutation(internal.keySettings.revokeMembershipVerified, {
          clerkOrgId: data.organization.id,
          userId: data.public_user_data.user_id,
          svixId,
        });
        break;
      }
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
        console.error(
          JSON.stringify({
            schema: 1,
            type: "zevium.dependency_failure",
            component: "stripe_webhook_verification",
            code:
              message === "Webhook secret is not configured"
                ? "misconfigured"
                : "invalid_signature",
          }),
        );
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
      await ctx.runMutation(internal.billing.receiveStripeEvent, {
        stripeEventId: event.id,
        stripeAccount,
        eventType: event.type,
        objectId,
      });
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
    await ctx.runMutation(internal.billing.receiveStripeEvent, {
      stripeEventId: event.id,
      stripeAccount: "platform",
      eventType: event.type,
      objectId,
    });
    return new Response(null, { status: 200 });
  }),
});

type IngestUsageEvent = {
  organizationId: string;
  projectId: string;
  specVersionId: string;
  specVersion: string;
  operationId: string;
  endpoint: string;
  method: string;
  listedCostCredits: number;
  freeTierLimit?: number;
  freeTierUsedBefore?: number;
  pricingDecision: "listed_price" | "free_tier" | "zero_price";
  credits: number;
  status: number;
  latencyMs: number;
  keyId: string;
  keyFamilyId: string;
  monthlyCapCredits?: number;
  budgetPeriod: string;
  budgetUsedBefore: number;
  budgetReservedBefore: number;
  budgetReservationCredits: number;
  at: number;
  reservationId: string;
  settleRefId: string;
  consumerClerkOrgId: string;
  billingOutcome: "settled" | "refunded" | "free";
  qualityOutcome: "success" | "client_error" | "server_error" | "network_error";
  ambiguous?: boolean;
  publisherIdempotencyKey?: string;
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
    candidate.events.length > MAX_USAGE_INGEST_EVENTS
  ) {
    return { ok: false, status: 400, error: "invalid event count" };
  }
  const events: IngestUsageEvent[] = [];
  const seenSettleRefs = new Set<string>();
  let consumerClerkOrgId: string | null = null;
  for (const raw of candidate.events) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, status: 400, error: "invalid event" };
    }
    const event = raw as Record<string, unknown>;
    const requiredStrings = [
      event.organizationId,
      event.projectId,
      event.specVersionId,
      event.specVersion,
      event.operationId,
      event.endpoint,
      event.method,
      event.keyId,
      event.keyFamilyId,
      event.budgetPeriod,
      event.reservationId,
      event.settleRefId,
      event.consumerClerkOrgId,
    ];
    if (
      requiredStrings.some(
        (value) => typeof value !== "string" || value.trim() === "",
      ) ||
      (event.endpoint as string).length > 2_048 ||
      (event.method as string).length > 16 ||
      (event.keyId as string).length > 256 ||
      (event.keyFamilyId as string).length > 256 ||
      (event.operationId as string).length > 512 ||
      (event.specVersion as string).length > 128 ||
      !/^\d{4}-\d{2}$/.test(event.budgetPeriod as string) ||
      (event.settleRefId as string).length > 200 ||
      (event.consumerClerkOrgId as string).length > 256 ||
      (typeof event.publisherIdempotencyKey === "string" &&
        event.publisherIdempotencyKey.length > 256)
    ) {
      return { ok: false, status: 400, error: "invalid event" };
    }
    if (
      typeof event.credits !== "number" ||
      !Number.isSafeInteger(event.credits) ||
      event.credits < 0 ||
      event.credits > MAX_ENDPOINT_COST_CREDITS ||
      typeof event.listedCostCredits !== "number" ||
      !Number.isSafeInteger(event.listedCostCredits) ||
      event.listedCostCredits < 0 ||
      event.listedCostCredits > MAX_ENDPOINT_COST_CREDITS ||
      (event.freeTierLimit !== undefined &&
        (typeof event.freeTierLimit !== "number" ||
          !Number.isSafeInteger(event.freeTierLimit) ||
          event.freeTierLimit <= 0)) ||
      (event.freeTierUsedBefore !== undefined &&
        (typeof event.freeTierUsedBefore !== "number" ||
          !Number.isSafeInteger(event.freeTierUsedBefore) ||
          event.freeTierUsedBefore < 0)) ||
      (event.pricingDecision !== "listed_price" &&
        event.pricingDecision !== "free_tier" &&
        event.pricingDecision !== "zero_price") ||
      (event.monthlyCapCredits !== undefined &&
        (typeof event.monthlyCapCredits !== "number" ||
          !Number.isSafeInteger(event.monthlyCapCredits) ||
          event.monthlyCapCredits <= 0)) ||
      typeof event.budgetUsedBefore !== "number" ||
      !Number.isSafeInteger(event.budgetUsedBefore) ||
      event.budgetUsedBefore < 0 ||
      typeof event.budgetReservedBefore !== "number" ||
      !Number.isSafeInteger(event.budgetReservedBefore) ||
      event.budgetReservedBefore < 0 ||
      typeof event.budgetReservationCredits !== "number" ||
      !Number.isSafeInteger(event.budgetReservationCredits) ||
      event.budgetReservationCredits < 0 ||
      typeof event.status !== "number" ||
      !Number.isSafeInteger(event.status) ||
      event.status < 100 ||
      event.status > 599 ||
      typeof event.latencyMs !== "number" ||
      !Number.isSafeInteger(event.latencyMs) ||
      event.latencyMs < 0 ||
      event.latencyMs > 86_400_000 ||
      typeof event.at !== "number" ||
      !Number.isSafeInteger(event.at) ||
      event.at <= 0 ||
      (event.ambiguous !== undefined && typeof event.ambiguous !== "boolean") ||
      (event.publisherIdempotencyKey !== undefined &&
        (typeof event.publisherIdempotencyKey !== "string" ||
          event.publisherIdempotencyKey.trim() === "")) ||
      event.reservationProof !== undefined
    ) {
      return { ok: false, status: 400, error: "invalid event" };
    }
    if (
      (event.billingOutcome !== "settled" &&
        event.billingOutcome !== "refunded" &&
        event.billingOutcome !== "free") ||
      (event.qualityOutcome !== "success" &&
        event.qualityOutcome !== "client_error" &&
        event.qualityOutcome !== "server_error" &&
        event.qualityOutcome !== "network_error")
    ) {
      return { ok: false, status: 400, error: "invalid event" };
    }
    const consumer = event.consumerClerkOrgId as string;
    if (consumerClerkOrgId !== null && consumerClerkOrgId !== consumer) {
      return { ok: false, status: 400, error: "mixed consumer organizations" };
    }
    const settleRefId = event.settleRefId as string;
    if (seenSettleRefs.has(settleRefId)) {
      return {
        ok: false,
        status: 400,
        error: "duplicate settlement reference",
      };
    }
    seenSettleRefs.add(settleRefId);
    consumerClerkOrgId = consumer;
    events.push({
      organizationId: event.organizationId as string,
      projectId: event.projectId as string,
      specVersionId: event.specVersionId as string,
      specVersion: event.specVersion as string,
      operationId: event.operationId as string,
      billingOutcome:
        event.billingOutcome as IngestUsageEvent["billingOutcome"],
      qualityOutcome:
        event.qualityOutcome as IngestUsageEvent["qualityOutcome"],
      endpoint: event.endpoint as string,
      method: event.method as string,
      listedCostCredits: event.listedCostCredits,
      ...(event.freeTierLimit === undefined
        ? {}
        : { freeTierLimit: event.freeTierLimit }),
      ...(event.freeTierUsedBefore === undefined
        ? {}
        : { freeTierUsedBefore: event.freeTierUsedBefore }),
      pricingDecision: event.pricingDecision,
      credits: event.credits,
      status: event.status,
      latencyMs: event.latencyMs,
      keyId: event.keyId as string,
      keyFamilyId: event.keyFamilyId as string,
      ...(event.monthlyCapCredits === undefined
        ? {}
        : { monthlyCapCredits: event.monthlyCapCredits }),
      budgetPeriod: event.budgetPeriod as string,
      budgetUsedBefore: event.budgetUsedBefore,
      budgetReservedBefore: event.budgetReservedBefore,
      budgetReservationCredits: event.budgetReservationCredits,
      at: event.at,
      reservationId: event.reservationId as string,
      settleRefId: event.settleRefId as string,
      consumerClerkOrgId: consumer,
      ...(event.ambiguous === undefined
        ? {}
        : { ambiguous: event.ambiguous as boolean }),
      ...(event.publisherIdempotencyKey === undefined
        ? {}
        : {
            publisherIdempotencyKey: event.publisherIdempotencyKey as string,
          }),
    });
  }
  return { ok: true, events };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
          specVersionId: event.specVersionId as Id<"specVersions">,
        })),
      });
      return json(result, 200);
    } catch {
      console.error(
        JSON.stringify({
          schema: 1,
          type: "zevium.dependency_failure",
          component: "usage_ingest",
          code: "mutation_failed",
        }),
      );
      return json({ error: "ingest failed" }, 500);
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
    } catch {
      console.error(
        JSON.stringify({
          schema: 1,
          type: "zevium.dependency_failure",
          component: "wallet_checkpoint",
          code: "query_failed",
        }),
      );
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
    } catch {
      console.error(
        JSON.stringify({
          schema: 1,
          type: "zevium.dependency_failure",
          component: "gateway_spec",
          code: "query_failed",
        }),
      );
      return json({ error: "gateway spec failed" }, 500);
    }
  }),
});

export default http;
