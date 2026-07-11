import { httpRouter } from "convex/server";
import { Webhook } from "svix";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

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

export default http;
