import { describe, expect, it } from "vitest";

import {
  InternalHttpSpecSource,
  parsePublishedSpecPayload,
} from "../src/spec-source";

describe("internal gateway spec source", () => {
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
});
