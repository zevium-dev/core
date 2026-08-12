// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:https";
import {
  openNodePinnedHead,
  probePinnedHttps,
  type ReadinessPinnedRequest,
  type ReadinessTransportDependencies,
} from "./readinessTransport";
import { TEST_TLS_CERT, TEST_TLS_KEY } from "./readinessTransport.test-cert";

function dependencies(
  resolveHostname: ReadinessTransportDependencies["resolveHostname"],
  openPinnedRequest: ReadinessTransportDependencies["openPinnedRequest"],
): ReadinessTransportDependencies {
  return { resolveHostname, openPinnedRequest, now: () => 1_000 };
}

describe("probePinnedHttps", () => {
  it("uses real pinned TLS sockets with correct SNI and no connection reuse", async () => {
    const seen: Array<{ authorization?: string; remotePort?: number }> = [];
    const server = createServer(
      { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
      (request, response) => {
        seen.push({
          authorization: request.headers.authorization,
          remotePort: request.socket.remotePort,
        });
        response.writeHead(204);
        response.end();
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected TCP test server");
      }
      const input = {
        url: new URL(`https://readiness.test:${address.port}/health`),
        address: "127.0.0.1",
        family: 4 as const,
        headers: { authorization: "Bearer publisher-secret" },
        deadlineAt: Date.now() + 5_000,
      };
      expect(
        await openNodePinnedHead(input, { ca: TEST_TLS_CERT }),
      ).toMatchObject({
        statusCode: 204,
      });
      expect(
        await openNodePinnedHead(input, { ca: TEST_TLS_CERT }),
      ).toMatchObject({
        statusCode: 204,
      });
      expect(seen).toHaveLength(2);
      expect(seen.map((request) => request.authorization)).toEqual([
        "Bearer publisher-secret",
        "Bearer publisher-secret",
      ]);
      expect(seen[0]?.remotePort).not.toBe(seen[1]?.remotePort);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("pins validated DNS answer into request and resolves exactly once per hop", async () => {
    const requests: ReadinessPinnedRequest[] = [];
    const resolve = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
    ]);
    const result = await probePinnedHttps(
      new URL("https://api.example.test/health"),
      { authorization: "Bearer publisher-secret" },
      dependencies(resolve, async (request) => {
        requests.push(request);
        return { statusCode: 204, headers: {} };
      }),
    );

    expect(result.statusCode).toBe(204);
    expect(resolve).toHaveBeenCalledOnce();
    expect(requests[0]).toMatchObject({
      address: "93.184.216.34",
      family: 4,
      headers: { authorization: "Bearer publisher-secret" },
    });
  });

  it("rejects credentialed cross-origin redirect before resolving or opening attacker hop", async () => {
    const requests: ReadinessPinnedRequest[] = [];
    const resolve = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
    ]);
    const promise = probePinnedHttps(
      new URL("https://api.example.test/health"),
      { "x-api-key": "publisher-secret" },
      dependencies(resolve, async (request) => {
        requests.push(request);
        return {
          statusCode: 302,
          headers: { location: "https://attacker.example/steal" },
        };
      }),
    );

    await expect(promise).rejects.toMatchObject({ kind: "blocked_target" });
    expect(resolve).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
  });

  it("re-resolves and re-pins same-origin redirects using a fresh request", async () => {
    const requests: ReadinessPinnedRequest[] = [];
    let answer = 0;
    const result = await probePinnedHttps(
      new URL("https://api.example.test/start"),
      { "x-api-key": "publisher-secret" },
      dependencies(
        async () => [
          {
            address: answer++ === 0 ? "93.184.216.34" : "142.250.72.14",
            family: 4,
          },
        ],
        async (request) => {
          requests.push(request);
          return requests.length === 1
            ? { statusCode: 307, headers: { location: "/final" } }
            : { statusCode: 200, headers: {} };
        },
      ),
    );

    expect(result.finalUrl.pathname).toBe("/final");
    expect(requests.map((request) => request.address)).toEqual([
      "93.184.216.34",
      "142.250.72.14",
    ]);
    expect(requests[1]?.headers["x-api-key"]).toBe("publisher-secret");
  });

  it.each([
    "10.0.0.1",
    "100.64.0.1",
    "192.0.0.9",
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b:1::7f00:1",
    "2001:db8::1",
  ])("blocks special-use DNS answer %s", async (address) => {
    const family = address.includes(":") ? 6 : 4;
    const open = vi.fn();
    await expect(
      probePinnedHttps(
        new URL("https://api.example.test/"),
        {},
        dependencies(async () => [{ address, family: family as 4 | 6 }], open),
      ),
    ).rejects.toMatchObject({ kind: "blocked_target" });
    expect(open).not.toHaveBeenCalled();
  });
});
