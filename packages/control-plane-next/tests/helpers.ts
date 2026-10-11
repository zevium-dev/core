declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}
import { convexTest } from "convex-test";
import { Webhook } from "svix";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { organization } from "./fixtures";
import { sha256Hex } from "@zevium/shared";
export const modules = import.meta.glob("../convex/**/*.ts");
export const webhookSecret = ["whsec", "dGVzdC13ZWJob29rLXNlY3JldA=="].join(
  "_",
);
export const keySecret = "test-projection-signing-secret-at-least-32";
export function harness() {
  return convexTest(schema, modules);
}
export type Harness = ReturnType<typeof harness>;
export function identity(org = "one", user = "user_one", role = "org:admin") {
  return { subject: user, org_id: `org_${org}`, org_slug: org, org_role: role };
}
export async function seed(t: Harness) {
  return t.run(async (ctx) => ({
    one: await ctx.db.insert("organizations", organization("one")),
    two: await ctx.db.insert("organizations", organization("two")),
  }));
}
export async function webhook(
  t: Harness,
  eventId: string,
  type: string,
  data: unknown,
  timestamp?: number,
) {
  const body = JSON.stringify({ type, data, timestamp });
  const now = new Date();
  return t.fetch("/clerk-webhook", {
    method: "POST",
    body,
    headers: {
      "svix-id": eventId,
      "svix-timestamp": String(Math.floor(now.getTime() / 1000)),
      "svix-signature": new Webhook(webhookSecret).sign(eventId, now, body),
    },
  });
}
export const spec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Echo", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/health": {
      get: {
        operationId: "health",
        "x-zevium-health-check": true,
        "x-zevium-cost": 0,
        responses: { "200": { description: "OK" } },
      },
    },
    "/echo": {
      post: {
        operationId: "echo",
        "x-zevium-cost": 5,
        "x-zevium-free-tier": 2,
        responses: { "200": { description: "OK" } },
      },
    },
    "/hidden": { get: { responses: { "200": { description: "OK" } } } },
  },
});
export async function draftProject(t: Harness) {
  const admin = t.withIdentity(identity());
  const project = await admin.mutation(api.projects.create, {
    orgSlug: "untrusted-slug",
    name: "Echo",
    slug: "echo",
  });
  await admin.mutation(api.specs.saveDraft, {
    projectId: project._id,
    spec,
    baseHash: await sha256Hex(""),
  });
  await admin.mutation(api.projects.update, {
    projectId: project._id,
    patch: { visibility: "public" },
  });
  return project;
}
export async function pass(t: Harness, projectId: Id<"projects">) {
  const target = await t.query(internal.publishReadiness.getTarget, {
    projectId,
    clerkOrgId: "org_one",
  });
  return t.mutation(internal.publishReadiness.recordPassingTest, {
    projectId,
    draftHash: target.draftHash!,
    credentialFingerprint: target.credentialFingerprint,
    healthCheckUrl: target.url!,
    healthCheckMethod: target.method!,
  });
}
