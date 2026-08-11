// @vitest-environment node
import type { IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebhookTransportError } from "./webhookDelivery";
import {
  deliverPinnedHttps,
  WEBHOOK_DNS_TIMEOUT_MS,
  WEBHOOK_MAX_RESPONSE_BYTES,
  type PinnedRequest,
  type WebhookTransportDependencies,
} from "./webhookTransport";

type FakeResponse = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<Uint8Array>;
  abort: () => void;
  cleanup: () => void;
};

function response(
  statusCode: number,
  headers: IncomingHttpHeaders = {},
  chunks: Uint8Array[] = [],
): FakeResponse {
  return {
    statusCode,
    headers,
    body: (async function* () {
      yield* chunks;
    })(),
    abort: vi.fn(),
    cleanup: vi.fn(),
  };
}

function dependencies(
  resolveHostname: WebhookTransportDependencies["resolveHostname"],
  openPinnedRequest: WebhookTransportDependencies["openPinnedRequest"],
): WebhookTransportDependencies {
  return { resolveHostname, openPinnedRequest, now: () => 1_000 };
}

const INPUT = {
  url: new URL("https://webhook.example/events"),
  headers: {
    "Content-Type": "application/json",
    "x-zevium-signature": "signature",
    "X-Zevium-Delivery-Id": "delivery-id",
  },
  body: '{"event":"test"}',
};

describe("deliverPinnedHttps", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pins connection to validated DNS answer without a second lookup", async () => {
    const requests: PinnedRequest[] = [];
    const resolveHostname = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
    ]);

    const result = await deliverPinnedHttps(
      INPUT,
      dependencies(resolveHostname, async (request) => {
        requests.push(request);
        return response(204);
      }),
    );

    expect(result).toEqual({ status: 204 });
    expect(resolveHostname).toHaveBeenCalledOnce();
    expect(requests[0]).toMatchObject({
      address: "93.184.216.34",
      family: 4,
    });
    expect(requests[0]!.url.hostname).toBe("webhook.example");
  });

  it("fails closed on mixed public/private multi-address DNS answers", async () => {
    const openPinnedRequest = vi.fn();
    const promise = deliverPinnedHttps(
      INPUT,
      dependencies(
        async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.8", family: 4 },
        ],
        openPinnedRequest,
      ),
    );

    await expect(promise).rejects.toMatchObject({ retryable: false });
    expect(openPinnedRequest).not.toHaveBeenCalled();
  });

  it("accepts public IPv6 and rejects mapped/private IPv6", async () => {
    const requests: PinnedRequest[] = [];
    await deliverPinnedHttps(
      INPUT,
      dependencies(
        async () => [{ address: "2606:4700:4700::1111", family: 6 }],
        async (request) => {
          requests.push(request);
          return response(200);
        },
      ),
    );
    expect(requests[0]?.family).toBe(6);

    for (const address of [
      "::ffff:127.0.0.1",
      "fe80::1",
      "2001:db8::1",
      "2002:7f00:1::",
      "2620:4f:8000::1",
    ]) {
      await expect(
        deliverPinnedHttps(
          INPUT,
          dependencies(
            async () => [{ address, family: 6 }],
            async () => response(200),
          ),
        ),
      ).rejects.toMatchObject({ retryable: false });
    }
  });

  it("re-resolves and re-pins each redirect, stripping sensitive cross-origin headers", async () => {
    const resolved: string[] = [];
    const requests: PinnedRequest[] = [];
    const result = await deliverPinnedHttps(INPUT, {
      now: () => 1_000,
      resolveHostname: async (hostname) => {
        resolved.push(hostname);
        return [
          {
            address:
              hostname === "webhook.example"
                ? "93.184.216.34"
                : "142.250.72.14",
            family: 4,
          },
        ];
      },
      openPinnedRequest: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? response(307, { location: "https://other.example/final" })
          : response(204);
      },
    });

    expect(result.status).toBe(204);
    expect(resolved).toEqual(["webhook.example", "other.example"]);
    expect(requests.map(({ address }) => address)).toEqual([
      "93.184.216.34",
      "142.250.72.14",
    ]);
    expect(requests[1]!.headers["x-zevium-signature"]).toBeUndefined();
    expect(requests[1]!.headers["X-Zevium-Delivery-Id"]).toBeUndefined();
    expect(requests[1]!.headers["Content-Type"]).toBe("application/json");
  });

  it("blocks private redirect before opening its connection", async () => {
    const openPinnedRequest = vi
      .fn<WebhookTransportDependencies["openPinnedRequest"]>()
      .mockResolvedValueOnce(
        response(302, { location: "https://metadata.example/latest" }),
      );
    const promise = deliverPinnedHttps(INPUT, {
      now: () => 1_000,
      resolveHostname: async (hostname) => [
        {
          address:
            hostname === "metadata.example"
              ? "169.254.169.254"
              : "93.184.216.34",
          family: 4,
        },
      ],
      openPinnedRequest,
    });

    await expect(promise).rejects.toMatchObject({ retryable: false });
    expect(openPinnedRequest).toHaveBeenCalledOnce();
  });

  it("bounds DNS resolution time and classifies timeout retryable", async () => {
    vi.useFakeTimers();
    const promise = deliverPinnedHttps(
      INPUT,
      dependencies(
        () => new Promise(() => undefined),
        async () => response(200),
      ),
    );
    const rejection = expect(promise).rejects.toBeInstanceOf(
      WebhookTransportError,
    );
    await vi.advanceTimersByTimeAsync(WEBHOOK_DNS_TIMEOUT_MS);
    await rejection;
    await expect(promise).rejects.toMatchObject({ retryable: true });
  });

  it("aborts response streaming after strict body limit", async () => {
    const oversized = response(200, {}, [
      new Uint8Array(WEBHOOK_MAX_RESPONSE_BYTES),
      new Uint8Array(1),
    ]);
    const promise = deliverPinnedHttps(
      INPUT,
      dependencies(
        async () => [{ address: "93.184.216.34", family: 4 }],
        async () => oversized,
      ),
    );

    await expect(promise).rejects.toMatchObject({ retryable: false });
    expect(oversized.abort).toHaveBeenCalledOnce();
    expect(oversized.cleanup).toHaveBeenCalledOnce();
  });
});
