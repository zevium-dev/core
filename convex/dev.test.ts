/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("dev seed", () => {
  it("refuses unsafe legacy publisher copy instead of exposing seeded rows", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("organizations", {
        clerkOrgId: "org_test_seed",
        name: "HIPAA ready publisher",
        slug: "test-org",
        publicHandle: "test-org",
      });
    });

    await expect(t.mutation(internal.dev.seedDemoProjects, {})).rejects.toThrow(
      /public-copy policy/i,
    );
  });

  it("refuses unsafe existing project copy instead of refreshing its draft", async () => {
    const t = convexTest(schema, modules);
    const draftId = await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_test_seed",
        name: "Test Organization",
        slug: "test-org",
        publicHandle: "test-org",
      });
      const projectId = await ctx.db.insert("projects", {
        organizationId,
        name: "SOC.2 certified weather",
        slug: "weather-forecast",
        status: "published",
        visibility: "public",
        tags: ["weather"],
      });
      return await ctx.db.insert("specs", {
        projectId,
        draft: "{}",
        lastSavedAt: 1,
      });
    });

    await expect(t.mutation(internal.dev.seedDemoProjects, {})).rejects.toThrow(
      /public-copy policy/i,
    );
    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.draft).toBe("{}");
  });

  it("refreshes mutable draft without rewriting immutable published version", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_test_seed",
        name: "Test Organization",
        slug: "test-org",
        publicHandle: "test-org",
      });
      const projectId = await ctx.db.insert("projects", {
        organizationId,
        name: "Weather Forecast",
        slug: "weather-forecast",
        description: "Old draft metadata",
        status: "published",
        visibility: "public",
        tags: ["weather"],
      });
      await ctx.db.insert("specs", {
        projectId,
        draft: "{}",
        lastSavedAt: 1,
      });
      const immutableSpec = JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Original snapshot", version: "1.0.0" },
        paths: {},
      });
      const versionId = await ctx.db.insert("specVersions", {
        projectId,
        version: "1.0.0",
        spec: immutableSpec,
        publishedAt: 1,
      });
      return { projectId, versionId, immutableSpec };
    });

    const result = await t.mutation(internal.dev.seedDemoProjects, {});
    expect(result.updated).toContain("weather-forecast");

    const state = await t.run(async (ctx) => ({
      draft: await ctx.db
        .query("specs")
        .withIndex("by_project", (q) => q.eq("projectId", seeded.projectId))
        .unique(),
      version: await ctx.db.get(seeded.versionId),
    }));
    expect(state.draft?.draft).not.toBe("{}");
    expect(state.version?.spec).toBe(seeded.immutableSpec);
  });
});
