import { describe, expect, it, vi } from "vitest";
import {
  ConsoleUsageSink,
  ConvexUsageClient,
  type ConvexUsageRecord,
  type RecordUsageResult,
} from "../src/usage";
import { logDependencyFailure } from "../src/telemetry";

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
  it("logs only allowlisted aggregate telemetry fields", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const sentinels = [
      "org_private_sentinel",
      "key_private_sentinel",
      "/users/alice@example.com/private",
      "reservation_private_sentinel",
      "raw upstream secret failure",
    ];
    new ConsoleUsageSink().emit({
      requestId: "request_private_sentinel",
      organizationId: sentinels[0]!,
      consumerClerkOrgId: "clerk_private_sentinel",
      projectId: "project_private_sentinel",
      keyId: sentinels[1]!,
      orgSlug: "tenant-private",
      projectSlug: "project-private",
      method: "POST",
      pathTemplate: sentinels[2]!,
      cost: 37,
      status: 503,
      outcome: "refunded",
      latencyMs: 741,
      reservationId: sentinels[3]!,
    });
    logDependencyFailure("usage_sink", 503);

    const output = JSON.stringify([log.mock.calls, error.mock.calls]);
    for (const sentinel of sentinels) expect(output).not.toContain(sentinel);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({
      schema: 1,
      type: "zevium.usage",
      outcome: "refunded",
      statusClass: "5xx",
      latencyBucket: "500-1999ms",
      costBucket: "11-100",
    });
    expect(JSON.parse(String(error.mock.calls[0]![0]))).toEqual({
      schema: 1,
      type: "zevium.dependency_failure",
      component: "usage_sink",
      statusClass: "5xx",
    });
    log.mockRestore();
    error.mockRestore();
  });

  it("POSTs body + x-internal-secret and parses result", async () => {
    const result: RecordUsageResult = {
      results: [{ refId: "settle:res-1", status: "applied" }],
      wallet: {
        clerkOrgId: sampleEvent.consumerClerkOrgId,
        balance: 97,
        sequence: 4,
      },
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
      results: [{ refId: sampleEvent.settleRefId, status: "already_applied" }],
      wallet: {
        clerkOrgId: sampleEvent.consumerClerkOrgId,
        balance: 97,
        sequence: 4,
      },
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
    expect(out.results).toEqual([
      { refId: sampleEvent.settleRefId, status: "already_applied" },
    ]);
    expect(mutationFn).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects empty batches without calling the ingest endpoint", async () => {
    const fetchImpl = vi.fn();
    const client = new ConvexUsageClient({
      convexUrl: "https://example.convex.cloud",
      ingestUrl: "https://example.convex.site/ingest-usage",
      internalSecret: "secret-1",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(client.recordUsage([])).rejects.toThrow(
      "recordUsage requires at least one settlement",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
