/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Webhook } from "svix";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const secret = "whsec_dGVzdC13ZWJob29rLXNlY3JldA==";

describe("Clerk webhook user lifecycle", () => {
  const previousSecret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;

  beforeEach(() => {
    process.env.CLERK_WEBHOOK_SIGNING_SECRET = secret;
  });

  afterEach(() => {
    if (previousSecret === undefined) {
      delete process.env.CLERK_WEBHOOK_SIGNING_SECRET;
    } else {
      process.env.CLERK_WEBHOOK_SIGNING_SECRET = previousSecret;
    }
  });

  it("deletes mirrored personal data when Clerk deletes the user", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        clerkUserId: "user_deleted",
        name: "Deleted User",
        email: "deleted@example.com",
      });
    });

    const body = JSON.stringify({
      type: "user.deleted",
      data: { id: "user_deleted", deleted: true },
    });
    const messageId = "msg_user_deleted";
    const timestamp = new Date();
    const signature = new Webhook(secret).sign(messageId, timestamp, body);
    const response = await t.fetch("/clerk-webhook", {
      method: "POST",
      headers: {
        "svix-id": messageId,
        "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
        "svix-signature": signature,
      },
      body,
    });

    expect(response.status).toBe(200);
    const mirroredUser = await t.run(async (ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", "user_deleted"))
        .unique(),
    );
    expect(mirroredUser).toBeNull();
  });
});
