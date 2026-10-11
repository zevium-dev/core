import { describe, expect, it } from "vitest";
import {
  getGeneratedContract,
  handleListingDocs,
} from "../src/generated-contract";
import { FixtureSpecSource, type PublishedSpec } from "../src/spec-source";

const published: PublishedSpec = {
  spec: JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Demo", version: "wrong-label" },
    paths: {
      "/echo": { post: { "x-zevium-cost": 2 } },
      "/hidden": { get: { summary: "HIDDEN_SENTINEL" } },
    },
  }),
  version: "2.0.0",
  specVersionId: "immutable-v2",
  visibility: "public",
  organizationId: "org",
  clerkOrgId: "org_clerk",
  projectId: "project",
};

describe("generated listing reference", () => {
  it("caches immutable version bytes across source refreshes, but not version changes", () => {
    const first = getGeneratedContract(published);
    expect(first.version).toBe("2.0.0");
    expect(getGeneratedContract({ ...published })).toBe(first);
    expect(getGeneratedContract({ ...published, version: "3.0.0" })).not.toBe(
      first,
    );
  });
  it("freezes cached artifacts and evicts old versions after 16 entries", () => {
    const first = getGeneratedContract(published);
    expect(Object.isFrozen(first.operations[0]?.tool.inputSchema)).toBe(true);
    for (let i = 0; i < 17; i++)
      getGeneratedContract({ ...published, version: `revision-${i}` });
    expect(getGeneratedContract(published)).not.toBe(first);
  });

  it("delivers Markdown and rechecks visibility before using cached data", async () => {
    const source = new FixtureSpecSource({ "acme/demo": published });
    const request = new Request("https://gateway.test/docs/acme/demo");
    const response = await handleListingDocs(request, source, "acme", "demo");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(await response.text()).toBe(
      getGeneratedContract(published).markdown,
    );
    source.set("acme", "demo", { ...published, visibility: "private" });
    expect(
      (await handleListingDocs(request, source, "acme", "demo")).status,
    ).toBe(404);
    expect(
      (await handleListingDocs(request, source, "missing", "demo")).status,
    ).toBe(404);
  });
  it("exposes safe failure codes for oversized generation", async () => {
    const source = new FixtureSpecSource({
      "acme/demo": { ...published, spec: "not json" },
    });
    const request = new Request("https://gateway.test/docs/acme/demo");
    expect(
      (await handleListingDocs(request, source, "acme", "demo")).status,
    ).toBe(404);
    source.set("acme", "demo", {
      ...published,
      spec: JSON.stringify({ openapi: "2.0" }),
    });
    const response = await handleListingDocs(request, source, "acme", "demo");
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "generation_unavailable",
      reason: "unsupported_openapi_version",
    });
    expect(
      (
        await handleListingDocs(
          new Request(request, { method: "POST" }),
          source,
          "acme",
          "demo",
        )
      ).status,
    ).toBe(405);
  });
});
