/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("ADMIN_USER_IDS", "staff");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function setup(
  status: Doc<"projects">["status"] = "published",
  visibility: Doc<"projects">["visibility"] = "private",
  endpoint: "active" | "inactive" | "missing" = "active",
) {
  const t = convexTest(schema, modules);
  const projectId = await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_publisher",
      name: "Publisher",
      slug: "publisher",
      publicHandle: "publisher",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId,
      name: "Visibility API",
      slug: "visibility-api",
      description: "Original description",
      status,
      visibility,
      tags: [],
    });
    if (status === "published") {
      await ctx.db.insert("specVersions", {
        projectId,
        version: "0.0.1",
        spec: "{}",
        publishedAt: 1,
      });
    }
    if (endpoint !== "missing") {
      await ctx.db.insert("webhookEndpoints", {
        projectId,
        url: "https://example.com/webhook",
        active: endpoint === "active",
        createdAt: 1,
      });
    }
    return projectId;
  });
  const publisher = t.withIdentity({
    subject: "publisher",
    org_id: "org_publisher",
    org_role: "org:admin",
  });
  const staff = t.withIdentity({ subject: "staff" });
  const deliveries = () =>
    t.run((ctx) => ctx.db.query("webhookDeliveries").collect());
  return { t, projectId, publisher, staff, deliveries };
}

describe("project.visibility_changed", () => {
  it.each([
    ["published", "private", "public", false],
    ["published", "private", "public", true],
    ["draft", "private", "public", false],
    ["draft", "public", "private", false],
  ] as const)(
    "publisher %s %s → %s (clear description: %s) enqueues once on retry",
    async (status, before, visibility, clearDescription) => {
      const { t, projectId, publisher, deliveries } = await setup(
        status,
        before,
      );
      const args = {
        projectId,
        patch: {
          visibility,
          ...(clearDescription ? { description: null } : {}),
        },
      };
      const updated = await publisher.mutation(api.projects.update, args);
      expect(updated.visibility).toBe(visibility);
      if (clearDescription) expect(updated.description).toBeUndefined();
      await publisher.mutation(api.projects.update, args);
      const queued = await deliveries();
      expect(queued).toHaveLength(1);
      const delivery = queued[0]!;
      expect(delivery).toMatchObject({
        event: "project.visibility_changed",
        status: "pending",
        attempts: 0,
      });
      expect(JSON.parse(delivery.payload)).toEqual({
        event: "project.visibility_changed",
        data: { projectId, visibility },
        timestamp: expect.any(Number),
      });
      const jobs = await t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      );
      const webhookJobs = jobs.filter(
        (job) =>
          job.name ===
          getFunctionName(internal.webhookDeliveryAction.deliverWebhook),
      );
      expect(webhookJobs).toHaveLength(1);
      expect(webhookJobs[0]!.args).toEqual([{ deliveryId: delivery._id }]);
    },
  );

  it("staff overrides emit once per transition, including returning to a prior visibility", async () => {
    const { t, projectId, staff, deliveries } = await setup();
    for (const visibility of ["public", "private", "public"] as const) {
      const args = {
        organizationHandle: "publisher",
        projectSlug: "visibility-api",
        visibility,
      };
      const updated = await staff.mutation(
        api.admin.setProjectVisibility,
        args,
      );
      expect(updated.visibility).toBe(visibility);
      expect(
        await staff.mutation(api.admin.setProjectVisibility, args),
      ).toEqual(updated);
      vi.setSystemTime(Date.now() + 1);
    }
    expect(
      (await deliveries()).map((delivery) => JSON.parse(delivery.payload)),
    ).toEqual(
      ["public", "private", "public"].map((visibility) => ({
        event: "project.visibility_changed",
        data: { projectId, visibility },
        timestamp: expect.any(Number),
      })),
    );
    expect(
      await t.run((ctx) => ctx.db.query("notifications").collect()),
    ).toHaveLength(3);
  });

  it("metadata edits and unchanged visibility do not enqueue events", async () => {
    const { projectId, publisher, staff, deliveries } = await setup();
    await publisher.mutation(api.projects.update, {
      projectId,
      patch: { name: "Renamed", description: null, tags: ["updated"] },
    });
    await publisher.mutation(api.projects.update, {
      projectId,
      patch: { visibility: "private" },
    });
    await staff.mutation(api.admin.setProjectVisibility, {
      organizationHandle: "publisher",
      projectSlug: "visibility-api",
      visibility: "private",
    });
    expect(await deliveries()).toEqual([]);
  });

  it("rejected lifecycle and authorization changes do not enqueue events", async () => {
    const { t, projectId, publisher, deliveries } = await setup(
      "published",
      "public",
    );
    await expect(
      publisher.mutation(api.projects.update, {
        projectId,
        patch: { visibility: "private" },
      }),
    ).rejects.toThrow("Schedule project retirement");
    const member = t.withIdentity({
      subject: "member",
      org_id: "org_publisher",
      org_role: "org:member",
    });
    await expect(
      member.mutation(api.projects.update, {
        projectId,
        patch: { visibility: "private" },
      }),
    ).rejects.toThrow("Org admin or owner role required");
    await expect(
      publisher.mutation(api.admin.setProjectVisibility, {
        organizationHandle: "publisher",
        projectSlug: "visibility-api",
        visibility: "private",
      }),
    ).rejects.toThrow("Not authorized as admin");
    expect(await deliveries()).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(projectId))).toMatchObject({
      visibility: "public",
    });
  });

  it.each(["inactive", "missing"] as const)(
    "visibility changes succeed without deliveries when endpoint is %s",
    async (endpoint) => {
      const { projectId, publisher, staff, deliveries } = await setup(
        "published",
        "private",
        endpoint,
      );
      expect(
        await publisher.mutation(api.projects.update, {
          projectId,
          patch: { visibility: "public" },
        }),
      ).toMatchObject({ visibility: "public" });
      expect(
        await staff.mutation(api.admin.setProjectVisibility, {
          organizationHandle: "publisher",
          projectSlug: "visibility-api",
          visibility: "private",
        }),
      ).toMatchObject({ visibility: "private" });
      expect(await deliveries()).toEqual([]);
    },
  );
});
