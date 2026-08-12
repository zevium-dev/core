import { describe, expect, it, vi } from "vitest";
import {
  ConsoleUsageSink,
  ConvexUsageClient,
  UsageIngestError,
  type ConvexUsageRecord,
  type RecordUsageResult,
} from "../src/usage";

import { MAX_USAGE_INGEST_EVENTS } from "@zevium/shared";
import { logDependencyFailure } from "../src/telemetry";

const sampleEvent: ConvexUsageRecord = {
  organizationId: "org_1",
  consumerClerkOrgId: "org_clerk_consumer_1",
  projectId: "proj_1",
  specVersionId: "version_1",
  endpoint: "/echo",
  method: "POST",
  credits: 3,
  status: 200,
  latencyMs: 10,
  keyId: "key_1",
  at: 1_700_000_000_000,
  settleRefId: "settle:res-1",
  billingOutcome: "settled",
  qualityOutcome: "success",
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

    await expect(client.recordUsage([sampleEvent])).rejects.toMatchObject({
      message: expect.stringMatching(/convex ingest failed: 401/),
      retryable: false,
      bisectable: false,
    });
  });

  it("marks deterministic 400 payload failures as bisectable", async () => {
    const client = new ConvexUsageClient({
      convexUrl: "https://example.convex.cloud",
      ingestUrl: "https://example.convex.site/ingest-usage",
      internalSecret: "secret-1",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "invalid event" }), {
          status: 400,
        })) as typeof fetch,
    });
    await expect(client.recordUsage([sampleEvent])).rejects.toMatchObject({
      retryable: false,
      bisectable: true,
    });
  });

  it("bisects deterministic failures on the direct Convex fallback too", async () => {
    const httpFailure = new ConvexUsageClient({
      convexUrl: "https://example.convex.cloud",
      adminKey: "test-admin-key",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "invalid event" }), {
          status: 400,
        })) as typeof fetch,
    });
    await expect(httpFailure.recordUsage([sampleEvent])).rejects.toMatchObject({
      retryable: false,
      bisectable: true,
    });

    const mutationFailure = new ConvexUsageClient({
      convexUrl: "https://example.convex.cloud",
      adminKey: "test-admin-key",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            status: "error",
            errorMessage: "validator rejected one event",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        )) as typeof fetch,
    });
    await expect(
      mutationFailure.recordUsage([sampleEvent]),
    ).rejects.toMatchObject({
      message: "validator rejected one event",
      retryable: false,
      bisectable: true,
    });
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

    await expect(client.recordUsage([sampleEvent])).rejects.toMatchObject({
      message: expect.stringMatching(/convex ingest failed: 500/),
      retryable: true,
    });
  });

  it("prefers mutationFn over ingest for tests", async () => {
    const mutationFn = vi.fn(async () => ({
      results: [
        {
          refId: sampleEvent.settleRefId,
          status: "already_applied" as const,
        },
      ],
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

  it("rejects oversized and duplicate-ref batches before transport", async () => {
    const fetchImpl = vi.fn();
    const client = new ConvexUsageClient({
      convexUrl: "https://example.convex.cloud",
      ingestUrl: "https://example.convex.site/ingest-usage",
      internalSecret: "secret-1",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(
      client.recordUsage(
        Array.from({ length: MAX_USAGE_INGEST_EVENTS + 1 }, (_, index) => ({
          ...sampleEvent,
          settleRefId: `settle:${index}`,
        })),
      ),
    ).rejects.toMatchObject({ retryable: false });
    await expect(
      client.recordUsage([sampleEvent, { ...sampleEvent }]),
    ).rejects.toMatchObject({
      message: "usage batch contains duplicate settlement references",
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires one exact classified outcome for every submitted ref", async () => {
    const omitted = new ConvexUsageClient({
      convexUrl: "https://test.invalid",
      mutationFn: async () => ({
        results: [],
        wallet: {
          clerkOrgId: sampleEvent.consumerClerkOrgId,
          balance: 1,
          sequence: 1,
        },
      }),
    });
    await expect(omitted.recordUsage([sampleEvent])).rejects.toMatchObject({
      message: "convex ingest omitted settlement outcomes",
      retryable: false,
      bisectable: false,
    });

    const unclassified = new ConvexUsageClient({
      convexUrl: "https://example.convex.cloud",
      ingestUrl: "https://example.convex.site/ingest-usage",
      internalSecret: "secret-1",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                refId: sampleEvent.settleRefId,
                status: "rejected",
                reason: "no classification",
              },
            ],
            wallet: {
              clerkOrgId: sampleEvent.consumerClerkOrgId,
              balance: 1,
              sequence: 1,
            },
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    await expect(unclassified.recordUsage([sampleEvent])).rejects.toMatchObject(
      { retryable: false },
    );
  });

  it("classifies ambiguous transport failure as retryable", async () => {
    const client = new ConvexUsageClient({
      convexUrl: "https://example.convex.cloud",
      ingestUrl: "https://example.convex.site/ingest-usage",
      internalSecret: "secret-1",
      fetchImpl: (async () => {
        throw new Error("connection reset");
      }) as typeof fetch,
    });
    await expect(client.recordUsage([sampleEvent])).rejects.toEqual(
      expect.objectContaining<Partial<UsageIngestError>>({
        retryable: true,
      }),
    );
  });
});
