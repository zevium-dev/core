/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const INTERNAL_SECRET = "test-gateway-internal-secret";

async function seedProject(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_publisher",
      name: "Publisher",
      slug: "publisher",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId,
      name: "Markdown to HTML",
      slug: "md-to-html",
      description: "Render markdown",
      status: "published",
      visibility: "public",
      tags: ["markdown"],
    });
    await ctx.db.insert("specs", {
      projectId,
      draft: "{}",
      lastSavedAt: 1,
    });
    await ctx.db.insert("specVersions", {
      projectId,
      version: "1.0.0",
      spec: '{"openapi":"3.1.0"}',
      publishedAt: 1,
    });
    return { projectId };
  });
}

function asPublisher(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "user_publisher",
    org_id: "org_publisher",
    org_slug: "publisher",
    org_role: "org:admin",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

function asStranger(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "user_stranger",
    org_id: "org_stranger",
    org_slug: "stranger",
    org_role: "org:admin",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

describe("upstream credentials", () => {
  const previousSecret = process.env.GATEWAY_INTERNAL_SECRET;

  beforeEach(() => {
    process.env.GATEWAY_INTERNAL_SECRET = INTERNAL_SECRET;
  });

  afterEach(() => {
    if (previousSecret === undefined) {
      delete process.env.GATEWAY_INTERNAL_SECRET;
    } else {
      process.env.GATEWAY_INTERNAL_SECRET = previousSecret;
    }
  });

  it("writes secret once and only returns metadata to publisher", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedProject(t);
    const publisher = asPublisher(t);

    const created = await publisher.mutation(api.upstreamCredentials.upsert, {
      projectId,
      name: "X-API-Key",
      secret: "publisher-secret",
    });
    expect(created.name).toBe("x-api-key");
    expect(created).not.toHaveProperty("secret");

    const rows = await publisher.query(api.upstreamCredentials.listForProject, {
      projectId,
    });
    expect(rows).toEqual([created]);

    const stored = await t.run(async (ctx) =>
      ctx.db.get(created.id as Id<"upstreamCredentials">),
    );
    expect(stored?.secret).toBe("publisher-secret");
  });

  it("updates same header and gateway endpoint receives latest value", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedProject(t);
    const publisher = asPublisher(t);

    const first = await publisher.mutation(api.upstreamCredentials.upsert, {
      projectId,
      name: "x-api-key",
      secret: "first",
    });
    const second = await publisher.mutation(api.upstreamCredentials.upsert, {
      projectId,
      name: "X-API-KEY",
      secret: "second",
    });
    expect(second.id).toBe(first.id);

    const response = await t.fetch(
      "/gateway-spec?orgSlug=publisher&projectSlug=md-to-html",
      { headers: { "x-internal-secret": INTERNAL_SECRET } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      projectId,
      upstreamHeaders: { "x-api-key": "second" },
    });
  });

  it("rejects unauthorized reads and mutations", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedProject(t);
    await expect(
      asStranger(t).query(api.upstreamCredentials.listForProject, {
        projectId,
      }),
    ).rejects.toThrow(/Not a member of this organization/);
    await expect(
      asStranger(t).mutation(api.upstreamCredentials.upsert, {
        projectId,
        name: "x-api-key",
        secret: "stolen",
      }),
    ).rejects.toThrow(/Not a member of this organization/);
  });

  it("rejects unsafe headers and values", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedProject(t);
    const publisher = asPublisher(t);

    await expect(
      publisher.mutation(api.upstreamCredentials.upsert, {
        projectId,
        name: "host",
        secret: "example.com",
      }),
    ).rejects.toThrow(/cannot be configured/);
    await expect(
      publisher.mutation(api.upstreamCredentials.upsert, {
        projectId,
        name: "x-api-key",
        secret: "value\r\nx-injected: yes",
      }),
    ).rejects.toThrow(/newlines/);
  });

  it("removes configured credential", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedProject(t);
    const publisher = asPublisher(t);
    const created = await publisher.mutation(api.upstreamCredentials.upsert, {
      projectId,
      name: "authorization",
      secret: "Bearer upstream",
    });

    await publisher.mutation(api.upstreamCredentials.remove, {
      credentialId: created.id,
    });
    expect(
      await publisher.query(api.upstreamCredentials.listForProject, {
        projectId,
      }),
    ).toEqual([]);
  });
});
