import { afterEach, describe, expect, it, vi } from "vitest";

import {
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
          projectId: "project",
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
          projectId: "project",
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
});
