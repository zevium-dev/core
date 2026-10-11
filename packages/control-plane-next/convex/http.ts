import { recordUsageBatch } from "./wallets";
import { ingestUsage } from "../contracts/settlement";
import {
  validInternalSecret,
  readBoundedJson,
  BoundaryError,
} from "../contracts/transport";
import { httpRouter } from "convex/server";
import { Webhook } from "svix";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "@zevium/shared";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
const text = z.string().min(1).max(4096);
const timestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const payload = z.object({
  type: text,
  timestamp: timestamp.optional(),
  data: z.object({
    id: text,
    name: text.optional(),
    slug: z.string().nullable().optional(),
    image_url: z.string().nullable().optional(),
    created_by: text.nullable().optional(),
    updated_at: timestamp.optional(),
    deleted_at: timestamp.optional(),
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    username: z.string().nullable().optional(),
    primary_email_address_id: z.string().nullable().optional(),
    email_addresses: z
      .array(z.object({ id: text, email_address: text }))
      .max(100)
      .optional(),
    private_metadata: z.record(z.string(), z.unknown()).optional(),
    organization: z.object({ id: text }).optional(),
    public_user_data: z.object({ user_id: text }).optional(),
  }),
});
const handled = new Set([
  "organization.created",
  "organization.updated",
  "organization.deleted",
  "user.created",
  "user.updated",
  "user.deleted",
  "organizationMembership.deleted",
]);
const router = httpRouter();
router.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
    if (!secret) return new Response("Webhook unavailable", { status: 503 });
    let body: string;
    try {
      const reader = request.body?.getReader();
      if (!reader) return new Response("Invalid event", { status: 400 });
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_048_576) {
          await reader.cancel();
          return new Response("Payload too large", { status: 413 });
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return new Response("Invalid event", { status: 400 });
    }
    let verified: unknown;
    const eventId = request.headers.get("svix-id") ?? "";
    const signedAt = request.headers.get("svix-timestamp") ?? "";
    try {
      verified = new Webhook(secret).verify(body, {
        "svix-id": eventId,
        "svix-timestamp": signedAt,
        "svix-signature": request.headers.get("svix-signature") ?? "",
      });
    } catch {
      return new Response("Invalid signature", { status: 400 });
    }
    const envelope = z.object({ type: text }).safeParse(verified);
    if (!envelope.success)
      return new Response("Invalid event", { status: 400 });
    if (!handled.has(envelope.data.type))
      return new Response(null, { status: 200 });
    const parsed = payload.safeParse(verified);
    if (!parsed.success) return new Response("Invalid event", { status: 400 });
    const { type, data, timestamp: eventAt } = parsed.data;
    const sourceTimestamp = type.endsWith(".deleted")
      ? (eventAt ?? Number(signedAt) * 1000)
      : (data.updated_at ?? eventAt ?? Number(signedAt) * 1000);
    const creatorClerkUserId =
      type === "organization.created"
        ? (data.created_by ?? undefined)
        : undefined;
    if (
      type === "organizationMembership.deleted" &&
      (!data.organization || !data.public_user_data)
    )
      return new Response("Invalid membership event", { status: 400 });
    const primary =
      data.email_addresses?.find((e) => e.id === data.primary_email_address_id)
        ?.email_address ?? data.email_addresses?.[0]?.email_address;
    try {
      await ctx.runMutation(internal.clerkWebhooks.apply, {
        eventId,
        eventType: type,
        objectId:
          type === "organizationMembership.deleted"
            ? `membership:${data.organization!.id}:${data.public_user_data!.user_id}`
            : data.id,
        sourceTimestamp,
        fingerprint: await sha256Hex(canonicalJson(verified)),
        name: type.startsWith("user.")
          ? [data.first_name, data.last_name].filter(Boolean).join(" ") ||
            data.username ||
            primary
          : data.name,
        email: primary,
        slug: data.slug ?? undefined,
        imageUrl: data.image_url ?? undefined,
        creatorClerkUserId,
        clerkOrgId: data.organization?.id,
        userId: data.public_user_data?.user_id,
      });
    } catch {
      return new Response("Webhook could not be processed", { status: 503 });
    }
    return new Response(null, { status: 200 });
  }),
});
router.route({
  path: "/ingest-usage",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (
      !(await validInternalSecret(
        request.headers.get("x-internal-secret"),
        process.env.GATEWAY_INTERNAL_SECRET,
      ))
    )
      return new Response("Unauthorized", { status: 401 });
    try {
      const body = await readBoundedJson(request, ingestUsage);
      const result = await recordUsageBatch(ctx, JSON.stringify(body));
      return Response.json(result);
    } catch (error) {
      return new Response(
        error instanceof BoundaryError
          ? error.message
          : "Settlement unavailable",
        { status: error instanceof BoundaryError ? error.status : 503 },
      );
    }
  }),
});
export default router;
