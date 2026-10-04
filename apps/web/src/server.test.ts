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
