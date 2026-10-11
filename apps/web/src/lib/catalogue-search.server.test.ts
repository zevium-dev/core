import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  request: new Request("https://web.invalid"),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => state.request,
}));
import { trustedCatalogueSearch } from "./catalogue-search.server";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("refuses spoofed connection headers without trusted runtime metadata", async () => {
  vi.stubEnv("NEXT_CONVEX_SITE_URL", "https://next.invalid");
  vi.stubEnv("NEXT_WEB_SEARCH_SECRET", "test-server-budget-secret");
  state.request = new Request("https://web.invalid", {
    headers: { "cf-connecting-ip": "1.2.3.4" },
  });
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(await trustedCatalogueSearch("echo")).toEqual({
    items: [],
    degraded: true,
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it("forwards an HMAC budget key without persisting or forwarding the raw IP", async () => {
  vi.stubEnv("NEXT_CONVEX_SITE_URL", "https://next.invalid");
  vi.stubEnv("NEXT_WEB_SEARCH_SECRET", "test-server-budget-secret");
  state.request = Object.assign(
    new Request("https://web.invalid", {
      headers: { "cf-connecting-ip": "1.2.3.4" },
    }),
    { cf: { colo: "TEST" } },
  );
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ items: [], degraded: false }),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(await trustedCatalogueSearch("echo")).toEqual({
    items: [],
    degraded: false,
  });
  const body = String(fetcher.mock.calls[0]?.[1]?.body);
  expect(body).not.toContain("1.2.3.4");
  expect(JSON.parse(body)).toMatchObject({
    query: "echo",
    anonymousKey: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
});
