/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Id } from "./_generated/dataModel";
import { parseIngestUsageBody } from "./http";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const SECRET = "test-gateway-internal-secret";

type Seeded = {
  organizationId: Id<"organizations">;
  projectId: Id<"projects">;
};

async function seedOrgAndProject(
  t: ReturnType<typeof convexTest>,
): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_ingest_test",
      name: "Ingest Co",
      slug: "ingest-co",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId,
      name: "Ingest API",
      slug: "ingest-api",
      status: "published",
      visibility: "public",
      tags: [],
    });
    await ctx.db.insert("wallets", {
      organizationId,
      balance: 100,
    });
    return { organizationId, projectId };
  });
}

function makeEvent(
  organizationId: string,
  projectId: string,
  settleRefId: string,
  credits = 3,
) {
  return {
    organizationId,
    projectId,
    endpoint: "/echo",
    method: "POST",
    credits,
    status: 200,
    latencyMs: 12,
    keyId: "key_1",
    at: Date.now(),
    settleRefId,
  };
}

describe("parseIngestUsageBody", () => {
  it("rejects non-object and missing events", () => {
    expect(parseIngestUsageBody(null).ok).toBe(false);
    expect(parseIngestUsageBody([]).ok).toBe(false);
    expect(parseIngestUsageBody({}).ok).toBe(false);
  });

  it("rejects >500 events", () => {
    const events = Array.from({ length: 501 }, (_, i) =>
      makeEvent("o", "p", `settle:r${i}`),
    );
    const parsed = parseIngestUsageBody({ events });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toBe("too many events");
    }
  });

  it("accepts valid batch", () => {
    const parsed = parseIngestUsageBody({
      events: [makeEvent("o1", "p1", "settle:r1")],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.events).toHaveLength(1);
      expect(parsed.events[0]!.settleRefId).toBe("settle:r1");
    }
  });
});

describe("POST /ingest-usage", () => {
  const prevSecret = process.env.GATEWAY_INTERNAL_SECRET;

  beforeEach(() => {
    process.env.GATEWAY_INTERNAL_SECRET = SECRET;
  });

  afterEach(() => {
    if (prevSecret === undefined) {
      delete process.env.GATEWAY_INTERNAL_SECRET;
    } else {
      process.env.GATEWAY_INTERNAL_SECRET = prevSecret;
    }
  });

  it("rejects missing secret header", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/ingest-usage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("rejects wrong secret", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/ingest-usage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": "nope",
      },
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects when env secret unset", async () => {
    delete process.env.GATEWAY_INTERNAL_SECRET;
    const t = convexTest(schema, modules);
    const res = await t.fetch("/ingest-usage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": SECRET,
      },
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("applies events and dedupes settleRefId", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedOrgAndProject(t);
    const event = makeEvent(
      seed.organizationId,
      seed.projectId,
      "settle:res-1",
      5,
    );

    const first = await t.fetch("/ingest-usage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": SECRET,
      },
      body: JSON.stringify({ events: [event] }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      applied: number;
      skipped: number;
      balances: Record<string, number>;
    };
    expect(firstBody.applied).toBe(1);
    expect(firstBody.skipped).toBe(0);
    expect(firstBody.balances[seed.organizationId]).toBe(95);

    const second = await t.fetch("/ingest-usage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": SECRET,
      },
      body: JSON.stringify({ events: [event] }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      applied: number;
      skipped: number;
    };
    expect(secondBody.applied).toBe(0);
    expect(secondBody.skipped).toBe(1);

    const usageCount = await t.run(async (ctx) => {
      const rows = await ctx.db.query("usageEvents").collect();
      return rows.length;
    });
    expect(usageCount).toBe(1);
  });

  it("rejects invalid event shape", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/ingest-usage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": SECRET,
      },
      body: JSON.stringify({
        events: [{ organizationId: "x" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid event");
  });
});
