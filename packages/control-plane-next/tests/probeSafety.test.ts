// @vitest-environment node
import { expect, it, vi } from "vitest";
import {
  probePublicHttps,
  type PinnedHeadRequester,
} from "../convex/qualityProbeAction";
it("never opens a socket for mixed private DNS and validates redirect destinations again", async () => {
  const socket = vi.fn(async () => ({ statusCode: 200 }));
  const blocked = await probePublicHttps("https://example.com/health", "GET", {
    resolver: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
    requestHead: socket,
  });
  expect(["blocked_target", "dns_error"]).toContain(blocked.outcome);
  expect(socket).not.toHaveBeenCalled();
  const redirect = vi.fn(async () => ({
    statusCode: 302,
    location: "https://127.0.0.1/admin",
  }));
  expect(
    (
      await probePublicHttps("https://example.com/health", "HEAD", {
        resolver: async (host) => [
          {
            address: host === "127.0.0.1" ? "127.0.0.1" : "93.184.216.34",
            family: 4,
          },
        ],
        requestHead: redirect,
      })
    ).outcome,
  ).toBe("blocked_target");
  expect(redirect).toHaveBeenCalledTimes(1);
});
it("pins the vetted address and keeps real HTTP failure separate from network failure", async () => {
  const request = vi.fn<PinnedHeadRequester>(async () => ({ statusCode: 503 }));
  expect(
    (
      await probePublicHttps("https://example.com/health", "GET", {
        resolver: async () => [{ address: "93.184.216.34", family: 4 }],
        requestHead: request,
      })
    ).outcome,
  ).toBe("http_error");
  expect(request.mock.calls[0]?.[1]).toEqual({
    address: "93.184.216.34",
    family: 4,
  });
});
