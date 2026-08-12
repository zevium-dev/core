/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function identity(
  t: ReturnType<typeof convexTest>,
  role: "org:admin" | "org:member",
) {
  return t.withIdentity({
    subject: role === "org:admin" ? "user_admin" : "user_member",
    org_id: "org_acme",
    org_slug: "acme",
    org_role: role,
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

describe("project lifecycle authorization", () => {
  it.each([
    ["org:owner", true],
    ["org:admin", true],
    ["org:member", false],
  ] as const)("projects server capabilities for %s", async (role, privileged) => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("organizations", {
        clerkOrgId: "org_acme",
        name: "Acme",
        slug: "acme",
      });
    });
    const actor = t.withIdentity({
      subject: `user_${role}`,
      org_id: "org_acme",
      org_slug: "acme",
      org_role: role,
    } as {
      subject: string;
      org_id: string;
      org_slug: string;
      org_role: string;
    });

    const access = await actor.query(api.organizations.activeCapabilities, {});
    expect(access.role).toBe(role);
    expect(access.capabilities.managePublisher).toBe(privileged);
    expect(access.capabilities.viewOrgUsage).toBe(privileged);
    expect(access.capabilities.viewOwnUsage).toBe(true);
  });

  it("lets members read projects but rejects create, update, and delete", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_acme",
        name: "Acme",
        slug: "acme",
      });
      return await ctx.db.insert("projects", {
        organizationId,
        name: "Existing API",
        slug: "existing-api",
        status: "draft",
        visibility: "private",
        tags: [],
      });
    });
    const member = identity(t, "org:member");

    await expect(
      member.query(api.projects.list, { orgSlug: "acme" }),
    ).resolves.toHaveLength(1);
    await expect(
      member.mutation(api.projects.create, {
        orgSlug: "acme",
        name: "Blocked API",
        slug: "blocked-api",
      }),
    ).rejects.toThrow("Org admin or owner role required");
    await expect(
      member.mutation(api.projects.update, {
        projectId,
        patch: { visibility: "public" },
      }),
    ).rejects.toThrow("Org admin or owner role required");
    await expect(
      member.mutation(api.projects.remove, { projectId }),
    ).rejects.toThrow("Org admin or owner role required");

    const unchanged = await t.run(async (ctx) => await ctx.db.get(projectId));
    expect(unchanged).toMatchObject({
      name: "Existing API",
      visibility: "private",
    });
  });

  it("allows an org admin to create a canonical private draft", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("organizations", {
        clerkOrgId: "org_acme",
        name: "Acme",
        slug: "acme",
      });
    });

    const created = await identity(t, "org:admin").mutation(
      api.projects.create,
      { orgSlug: "acme", name: "New API", slug: "new-api" },
    );
    expect(created).toMatchObject({
      name: "New API",
      slug: "new-api",
      status: "draft",
      visibility: "private",
    });
  });

  it("treats an org owner as privileged", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("organizations", {
        clerkOrgId: "org_acme",
        name: "Acme",
        slug: "acme",
      });
    });

    const owner = t.withIdentity({
      subject: "user_owner",
      org_id: "org_acme",
      org_slug: "acme",
      org_role: "org:owner",
    } as {
      subject: string;
      org_id: string;
      org_slug: string;
      org_role: string;
    });
    await expect(
      owner.mutation(api.projects.create, {
        orgSlug: "acme",
        name: "Owner API",
        slug: "owner-api",
      }),
    ).resolves.toMatchObject({ slug: "owner-api" });
  });
});
