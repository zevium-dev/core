import { afterEach, describe, expect, it, vi } from "vitest";

const { startHandler } = vi.hoisted(() => ({
  startHandler: vi.fn(async () => new Response("application route")),
}));

vi.mock("@tanstack/react-start/server", () => ({
  createStartHandler: () => startHandler,
  defaultStreamHandler: vi.fn(),
}));
vi.mock("@tanstack/react-start/server-entry", () => ({
  createServerEntry: (entry: unknown) => entry,
}));

import server from "./server";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("Worker-first asset routing", () => {
  it.each(["/favicon.ico", "/logo192.png", "/logo512.png", "/manifest.json"])(
    "serves public asset %s in production",
    async (path) => {
      vi.stubEnv("DEV", false);
      const request = new Request(`https://www.zevium.dev${path}`);
      const assets = {
        context: {},
        ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      };
      const response = await server.fetch(request, assets);
      expect(response.status).toBe(200);
      expect(assets.ASSETS.fetch).toHaveBeenCalledWith(request);
      expect(startHandler).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["/src/styles.css", "text/css"],
    ["/@tanstack-start/styles.css?routes=__root__", "text/css"],
    ["/@id/virtual:tanstack-start-dev-client-entry", "text/javascript"],
    ["/@vite/client", "text/javascript"],
    ["/@react-refresh", "text/javascript"],
    ["/@fs/workspace/packages/shared/src/index.ts", "text/javascript"],
    ["/node_modules/.vite/deps/react.js", "text/javascript"],
  ])(
    "serves development resource %s through Vite assets",
    async (path, type) => {
      vi.stubEnv("DEV", true);
      const request = new Request(`http://localhost:3000${path}`);
      const assets = {
        context: {},
        ASSETS: {
          fetch: vi.fn(
            async () =>
              new Response("client resource", {
                headers: { "content-type": type },
              }),
          ),
        },
      };

      const response = await server.fetch(request, assets);

      expect(assets.ASSETS.fetch).toHaveBeenCalledWith(request);
      expect(startHandler).not.toHaveBeenCalled();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(type);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.text()).toBe("client resource");
    },
  );

  it.each([true, false])(
    "keeps application routes in Start (DEV=%s)",
    async (dev) => {
      vi.stubEnv("DEV", dev);
      const assets = { context: {}, ASSETS: { fetch: vi.fn() } };
      const response = await server.fetch(
        new Request("http://localhost:3000/app/projects"),
        assets,
      );

      expect(assets.ASSETS.fetch).not.toHaveBeenCalled();
      expect(startHandler).toHaveBeenCalledOnce();
      expect(await response.text()).toBe("application route");
    },
  );

  it("does not expose development modules through production assets", async () => {
    vi.stubEnv("DEV", false);
    const assets = { context: {}, ASSETS: { fetch: vi.fn() } };
    await server.fetch(
      new Request("https://www.zevium.dev/src/server.ts"),
      assets,
    );

    expect(assets.ASSETS.fetch).not.toHaveBeenCalled();
    expect(startHandler).toHaveBeenCalledOnce();
  });
});

describe("deployment proof", () => {
  const gitSha = "a".repeat(40);
  const metadata = {
    id: "12345678-1234-4123-8123-123456789abc",
    tag: `staging-${gitSha}`,
    timestamp: "2026-10-10T12:00:00.12345Z",
  };
  const url = "https://www.zevium.dev/.well-known/zevium-deployment.json";

  it.each([
    [`staging-${gitSha}`, "staging"],
    [`production-${gitSha}-123-2`, "production"],
    [`preview-367-${gitSha}`, "preview"],
  ])("serves public release facts for %s", async (tag, mode) => {
    vi.stubEnv("VITE_BUILD_SHA", gitSha);
    const options = {
      context: {},
      CF_VERSION_METADATA: { ...metadata, tag },
      CLERK_SECRET_KEY: "must-not-be-exposed",
    };
    const response = await server.fetch(new Request(url), options);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      service: "web",
      mode,
      gitSha,
      deploymentId: metadata.id,
      deployedAt: "2026-10-10T12:00:00.123Z",
    });
    expect(startHandler).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { ...metadata, tag: `staging-${"b".repeat(40)}` },
    { ...metadata, id: "local-web-unbound" },
    { ...metadata, timestamp: "invalid" },
  ])("rejects unavailable or mismatched runtime metadata", async (value) => {
    vi.stubEnv("VITE_BUILD_SHA", gitSha);
    const options = { context: {}, CF_VERSION_METADATA: value };
    const response = await server.fetch(new Request(url), options);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      error: "Deployment metadata unavailable",
    });
    expect(startHandler).not.toHaveBeenCalled();
  });

  it("supports HEAD and rejects writes", async () => {
    vi.stubEnv("VITE_BUILD_SHA", gitSha);
    const options = { context: {}, CF_VERSION_METADATA: metadata };
    const head = await server.fetch(
      new Request(url, { method: "HEAD" }),
      options,
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("application/json");
    expect(await head.text()).toBe("");
    const post = await server.fetch(
      new Request(url, { method: "POST" }),
      options,
    );
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect(startHandler).not.toHaveBeenCalled();
  });
});
