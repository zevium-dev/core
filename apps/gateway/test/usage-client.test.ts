import { describe, expect, it, vi } from "vitest";
import {
  ConvexUsageClient,
  type ConvexUsageRecord,
  type RecordUsageResult,
} from "../src/usage";

const sampleEvent: ConvexUsageRecord = {
  organizationId: "org_1",
  consumerClerkOrgId: "org_clerk_consumer_1",
  projectId: "proj_1",
  endpoint: "/echo",
  method: "POST",
  credits: 3,
  status: 200,
  latencyMs: 10,
  keyId: "key_1",
  at: 1_700_000_000_000,
  settleRefId: "settle:res-1",
};

describe("ConvexUsageClient ingest path", () => {
  it("POSTs body + x-internal-secret and parses result", async () => {
    const result: RecordUsageResult = {
      applied: 1,
      skipped: 0,
      balances: { org_1: 97 },
    };
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://example.convex.site/ingest-usage");
        expect(init?.method).toBe("POST");
        const headers = new Headers(init?.headers);
        expect(headers.get("content-type")).toBe("application/json");
        expect(headers.get("x-internal-secret")).toBe("secret-1");
        expect(JSON.parse(String(init?.body))).toEqual({
          events: [sampleEvent],
        });
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );

    const client = new ConvexUsageClient({
      convexUrl: "https://example.convex.cloud",
      ingestUrl: "https://example.convex.site/ingest-usage",
      internalSecret: "secret-1",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const out = await client.recordUsage([sampleEvent]);
    expect(out).toEqual(result);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws on 401", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
        }),
    );
    const client = new ConvexUsageClient({
      convexUrl: "https://example.convex.cloud",
      ingestUrl: "https://example.convex.site/ingest-usage",
      internalSecret: "secret-1",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(client.recordUsage([sampleEvent])).rejects.toThrow(
      /convex ingest failed: 401/,
    );
  });

  it("throws on 500", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "ingest failed" }), {
          status: 500,
        }),
    );
    const client = new ConvexUsageClient({
      convexUrl: "https://example.convex.cloud",
      ingestUrl: "https://example.convex.site/ingest-usage",
      internalSecret: "secret-1",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(client.recordUsage([sampleEvent])).rejects.toThrow(
      /convex ingest failed: 500/,
    );
  });

  it("prefers mutationFn over ingest for tests", async () => {
    const mutationFn = vi.fn(async () => ({
      applied: 2,
      skipped: 0,
      balances: {},
    }));
    const fetchImpl = vi.fn();
    const client = new ConvexUsageClient({
      convexUrl: "https://example.convex.cloud",
      ingestUrl: "https://example.convex.site/ingest-usage",
      internalSecret: "secret-1",
      mutationFn,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const out = await client.recordUsage([sampleEvent]);
    expect(out.applied).toBe(2);
    expect(mutationFn).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns empty result for empty batch without fetch", async () => {
    const fetchImpl = vi.fn();
    const client = new ConvexUsageClient({
      convexUrl: "https://example.convex.cloud",
      ingestUrl: "https://example.convex.site/ingest-usage",
      internalSecret: "secret-1",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const out = await client.recordUsage([]);
    expect(out).toEqual({ applied: 0, skipped: 0, balances: {} });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
