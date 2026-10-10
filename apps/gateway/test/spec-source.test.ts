import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CachedSpecSource,
  ConvexPublicSpecSource,
  getParsedSpec,
  InternalHttpSpecSource,
  parsePublicPublishedSpecPayload,
  parsePublishedSpecPayload,
} from "../src/spec-source";

describe("internal gateway spec source", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves the Workerd global fetch receiver", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(function (
      this: typeof globalThis,
    ) {
      expect(this).toBe(globalThis);
      return Promise.resolve(
        Response.json({
          spec: '{"openapi":"3.1.0"}',
          specVersionId: "version",
          version: "1.0.0",
          projectId: "project",
          admission: { mode: "open", policyRevision: 1, allowed: true },
          organizationId: "organization",
          clerkOrgId: "org_publisher",
          visibility: "public",
        }),
      );
    });
    const source = new InternalHttpSpecSource({
      siteUrl: "https://control.test////",
      internalSecret: "internal-secret",
    });

    await expect(
      source.getPublishedSpec("publisher", "md-to-html"),
    ).resolves.toMatchObject({ projectId: "project" });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("authenticates request and parses upstream headers", async () => {
    const source = new InternalHttpSpecSource({
      siteUrl: "https://control.test/",
      internalSecret: "internal-secret",
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        expect(request.headers.get("x-internal-secret")).toBe(
          "internal-secret",
        );
        const url = new URL(request.url);
        expect(url.pathname).toBe("/gateway-spec");
        expect(url.searchParams.get("publisherHandle")).toBe("publisher");
        expect(url.searchParams.get("projectSlug")).toBe("md-to-html");
        return Response.json({
          spec: '{"openapi":"3.1.0"}',
          specVersionId: "version",
          version: "1.0.0",
          projectId: "project",
          admission: { mode: "open", policyRevision: 1, allowed: true },
          organizationId: "organization",
          clerkOrgId: "org_publisher",
          visibility: "public",
          upstreamHeaders: { "x-api-key": "publisher-secret" },
        });
      },
    });

    await expect(
      source.getPublishedSpec("publisher", "md-to-html"),
    ).resolves.toMatchObject({
      upstreamHeaders: { "x-api-key": "publisher-secret" },
    });
  });

  it("drops malformed upstream header values from payload", () => {
    expect(
      parsePublishedSpecPayload({
        spec: "{}",
        specVersionId: "version",
        version: "1.0.0",
        projectId: "project",
        organizationId: "organization",
        clerkOrgId: "org_publisher",
        visibility: "public",
        upstreamHeaders: {
          "x-valid": "secret",
          "x-invalid": 42,
        },
      }),
    ).toMatchObject({
      upstreamHeaders: { "x-valid": "secret" },
    });
  });

  it("accepts minimal public spec DTO without metering or Clerk ids", () => {
    expect(
      parsePublicPublishedSpecPayload({
        spec: '{"openapi":"3.1.0"}',
        version: "1.0.0",
        visibility: "public",
        deprecatedAt: 1,
        sunsetAt: 2,
      }),
    ).toEqual({
      spec: '{"openapi":"3.1.0"}',
      version: "1.0.0",
      visibility: "public",
      deprecatedAt: 1,
      sunsetAt: 2,
    });
    expect(
      parsePublicPublishedSpecPayload({
        spec: "{}",
        visibility: "private",
      }),
    ).toBeNull();
  });

  it("fails closed on malformed JSON", () => {
    expect(
      parsePublishedSpecPayload({
        specVersionId: "version",
        version: "1.0.0",
        projectId: "project",
        organizationId: "organization",
        clerkOrgId: "org_publisher",
        visibility: "public",
        spec: "{broken",
      }),
    ).toBeNull();
  });
});

describe("cached route versions", () => {
  it("refreshes lifecycle and credentials while reusing immutable parsed bytes", async () => {
    let now = 0;
    let value = {
      spec: '{"openapi":"3.1.0","paths":{"/cached":{"get":{"x-zevium-cost":3}}}}',
      visibility: "public" as const,
      upstreamHeaders: { authorization: "old" },
      deprecatedAt: undefined as number | undefined,
    };
    const load = vi.fn(async () => ({ ...value }));
    const source = new CachedSpecSource({
      inner: { getPublishedSpec: load },
      ttlMs: 30,
      now: () => now,
    });
    const first = (await source.getPublishedSpec("pub", "api"))!;
    const parsed = getParsedSpec(first);
    expect(await source.getPublishedSpec("pub", "api")).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    value = {
      ...value,
      deprecatedAt: 20,
      upstreamHeaders: { authorization: "new" },
    };
    now = 30;
    const refreshed = (await source.getPublishedSpec("pub", "api"))!;
    expect(refreshed.deprecatedAt).toBe(20);
    expect(refreshed.upstreamHeaders.authorization).toBe("new");
    expect(getParsedSpec(refreshed)).toBe(parsed);
    value = {
      ...value,
      spec: value.spec.replace('"x-zevium-cost":3', '"x-zevium-cost":4'),
    };
    source.invalidate("pub", "api");
    expect(
      getParsedSpec((await source.getPublishedSpec("pub", "api"))!),
    ).not.toBe(parsed);
  });

  it("isolates cached eligibility between consumer organizations", async () => {
    const load = vi.fn(
      async (_publisher: string, _project: string, consumer?: string) => ({
        spec: "{}",
        visibility: "public" as const,
        admission: {
          mode: "entitled_only" as const,
          policyRevision: 2,
          allowed: consumer === "existing",
        },
      }),
    );
    const source = new CachedSpecSource({ inner: { getPublishedSpec: load } });
    expect(
      (await source.getPublishedSpec("pub", "api", "existing"))?.admission
        .allowed,
    ).toBe(true);
    expect(
      (await source.getPublishedSpec("pub", "api", "new"))?.admission.allowed,
    ).toBe(false);
    expect(
      (await source.getPublishedSpec("pub", "api", "existing"))?.admission
        .allowed,
    ).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache source outages as missing routes", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue(null);
    const source = new CachedSpecSource({ inner: { getPublishedSpec: load } });
    await expect(source.getPublishedSpec("pub", "api")).rejects.toThrow(
      "unavailable",
    );
    await expect(source.getPublishedSpec("pub", "api")).resolves.toBeNull();
    await expect(source.getPublishedSpec("pub", "api")).resolves.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("public Convex query transport", () => {
  it("sends JSON query arguments and validates the public DTO", async () => {
    const source = new ConvexPublicSpecSource({
      convexUrl: "https://control.convex.cloud/",
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe("https://control.convex.cloud/api/query");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          path: "specs:getPublishedForGateway",
          args: { publisherHandle: "pub", projectSlug: "api" },
          format: "json",
        });
        return Response.json({
          status: "success",
          value: { spec: "{}", visibility: "public" },
        });
      },
    });
    await expect(source.getPublishedSpec("pub", "api")).resolves.toEqual({
      spec: "{}",
      visibility: "public",
    });
  });

  it.each([
    Response.json({ status: "error" }),
    Response.json({ value: {} }),
    new Response(null, { status: 503 }),
  ])("fails closed on protocol or transport failure", async (response) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const source = new ConvexPublicSpecSource({
        convexUrl: "https://control.convex.cloud",
        fetchImpl: async () => response,
      });
      await expect(source.getPublishedSpec("pub", "api")).resolves.toBeNull();
    } finally {
      log.mockRestore();
    }
  });
});
