/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { createNotification, upsertNotification } from "./lib/notifications";

const modules = import.meta.glob("./**/*.ts");

afterEach(() => vi.useRealTimers());

function asMember(
  t: ReturnType<typeof convexTest>,
  clerkOrgId = "org_test",
  slug = "test-co",
) {
  return t.withIdentity({
    subject: "user_member",
    org_id: clerkOrgId,
    org_slug: slug,
    org_role: "org:admin",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

describe("createNotification — idempotency", () => {
  it("creates once, dedupes on refId", async () => {
    const t = convexTest(schema, modules);

    const r1 = await t.run(async (ctx) => {
      return await createNotification(ctx, {
        clerkOrgId: "org_test",
        kind: "low_balance",
        title: "Low balance",
        body: "Top up",
        refId: "low_balance:org_test:2026-07-11",
      });
    });
    expect(r1.created).toBe(true);
    expect(r1.id).not.toBeNull();

    const r2 = await t.run(async (ctx) => {
      return await createNotification(ctx, {
        clerkOrgId: "org_test",
        kind: "low_balance",
        title: "Low balance",
        body: "Top up",
        refId: "low_balance:org_test:2026-07-11",
      });
    });
    expect(r2.created).toBe(false);
    expect(r2.id).toBe(r1.id);
  });

  it("different refId creates separate rows", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await createNotification(ctx, {
        clerkOrgId: "org_test",
        kind: "spec_published",
        title: "A",
        body: "b",
        refId: "r1",
      });
      await createNotification(ctx, {
        clerkOrgId: "org_test",
        kind: "spec_published",
        title: "B",
        body: "b",
        refId: "r2",
      });
    });

    const count = await t.run(async (ctx) => {
      return await ctx.db.query("notifications").collect();
    });
    expect(count).toHaveLength(2);
  });
});

describe("upsertNotification — canonical lifecycle state", () => {
  it("preserves reads on identical retry and revives changed content", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run(async (ctx) => {
      const created = await upsertNotification(ctx, {
        clerkOrgId: "org_test",
        kind: "project_retirement",
        title: "Retirement scheduled",
        body: "Old cutoff",
        refId: "retirement:canonical",
      });
      if (created.id === null) throw new Error("notification missing");
      await ctx.db.patch(created.id, { readAt: 123 });
      return created.id;
    });

    await t.run(async (ctx) => {
      await upsertNotification(ctx, {
        clerkOrgId: "org_test",
        kind: "project_retirement",
        title: "Retirement scheduled",
        body: "Old cutoff",
        refId: "retirement:canonical",
      });
    });
    expect(await t.run(async (ctx) => (await ctx.db.get(id))?.readAt)).toBe(
      123,
    );

    await t.run(async (ctx) => {
      await upsertNotification(ctx, {
        clerkOrgId: "org_test",
        kind: "project_retirement",
        title: "Retirement canceled",
        body: "API remains available",
        refId: "retirement:canonical",
        publisherHandle: "publisher",
        projectSlug: "api",
      });
    });
    const state = await t.run(async (ctx) => ({
      row: await ctx.db.get(id),
      all: await ctx.db.query("notifications").collect(),
    }));
    expect(state.all).toHaveLength(1);
    expect(state.row).toMatchObject({
      body: "API remains available",
      publisherHandle: "publisher",
      projectSlug: "api",
    });
    expect(state.row?.readAt).toBeUndefined();
  });
});

describe("notifications.listForOrg — auth", () => {
  it("rejects unauthenticated", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.query(api.notifications.listForOrg, {
        orgSlug: "test-co",
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow(/Not authenticated/);
  });

  it("scopes by signed org id instead of a supplied slug", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("organizations", {
        clerkOrgId: "org_test",
        name: "Test",
        slug: "test-co",
      });
      await ctx.db.insert("organizations", {
        clerkOrgId: "org_other",
        name: "Other",
        slug: "other",
      });
    });
    const outsider = t.withIdentity({
      subject: "user_out",
      org_id: "org_other",
      org_slug: "other",
      org_role: "org:member",
    } as {
      subject: string;
      org_id: string;
      org_slug: string;
      org_role: string;
    });
    const result = await outsider.query(api.notifications.listForOrg, {
      orgSlug: "test-co",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(result.page).toEqual([]);
  });
});

describe("notifications.listForOrg — data", () => {
  type Seeded = { orgId: Id<"organizations">; ids: Id<"notifications">[] };

  async function seedNotifications(
    t: ReturnType<typeof convexTest>,
  ): Promise<Seeded> {
    return await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_test",
        name: "Test Co",
        slug: "test-co",
      });
      const ids: Id<"notifications">[] = [];
      for (let i = 0; i < 5; i++) {
        const id = await ctx.db.insert("notifications", {
          clerkOrgId: "org_test",
          kind: "low_balance",
          title: `Notif ${i}`,
          body: `Body ${i}`,
          refId: `ref_${i}`,
          createdAt: 1_000_000 + i,
        });
        ids.push(id);
      }
      // Mark one as read
      await ctx.db.patch(ids[2]!, { readAt: 2_000_000 });
      return { orgId, ids };
    });
  }

  it("paginates newest first + reports unreadCount", async () => {
    const t = convexTest(schema, modules);
    await seedNotifications(t);
    const as = asMember(t);

    const page1 = await as.query(api.notifications.listForOrg, {
      orgSlug: "test-co",
      paginationOpts: { numItems: 2, cursor: null },
    });

    expect(page1.page).toHaveLength(2);
    // Newest first: createdAt descending
    expect(page1.page[0]!.createdAt).toBeGreaterThan(page1.page[1]!.createdAt);
    expect(page1.isDone).toBe(false);
    // 4 unread (5 total - 1 read)
    expect(page1.unreadCount).toBe(4);
  });

  it("returns all notifications across pages", async () => {
    const t = convexTest(schema, modules);
    await seedNotifications(t);
    const as = asMember(t);

    const all = await as.query(api.notifications.listForOrg, {
      orgSlug: "test-co",
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(all.page).toHaveLength(5);
    expect(all.isDone).toBe(true);
  });
});

describe("notifications.markRead", () => {
  it("rejects unauthenticated", async () => {
    const t = convexTest(schema, modules);
    const notificationId = await t.run(async (ctx) => {
      return await ctx.db.insert("notifications", {
        clerkOrgId: "org_test",
        kind: "low_balance",
        title: "T",
        body: "B",
        refId: "unauth_ref",
        createdAt: Date.now(),
      });
    });
    await expect(
      t.mutation(api.notifications.markRead, { notificationId }),
    ).rejects.toThrow(/Not authenticated/);
  });

  it("rejects non-org notification", async () => {
    const t = convexTest(schema, modules);
    const notificationId = await t.run(async (ctx) => {
      return await ctx.db.insert("notifications", {
        clerkOrgId: "org_test",
        kind: "low_balance",
        title: "T",
        body: "B",
        refId: "ref_x",
        createdAt: Date.now(),
      });
    });

    const stranger = t.withIdentity({
      subject: "user_stranger",
      org_id: "org_other",
      org_slug: "other",
      org_role: "org:member",
    } as {
      subject: string;
      org_id: string;
      org_slug: string;
      org_role: string;
    });
    await expect(
      stranger.mutation(api.notifications.markRead, { notificationId }),
    ).rejects.toThrow(/Not a member/);
  });

  it("marks unread notification as read", async () => {
    const t = convexTest(schema, modules);
    const notificationId = await t.run(async (ctx) => {
      await ctx.db.insert("organizations", {
        clerkOrgId: "org_test",
        name: "Test",
        slug: "test-co",
      });
      return await ctx.db.insert("notifications", {
        clerkOrgId: "org_test",
        kind: "low_balance",
        title: "T",
        body: "B",
        refId: "ref_y",
        createdAt: Date.now(),
      });
    });

    const as = asMember(t);
    const result = await as.mutation(api.notifications.markRead, {
      notificationId,
    });
    expect(result.ok).toBe(true);

    const notif = await t.run(async (ctx) => {
      return await ctx.db.get(notificationId);
    });
    expect(notif?.readAt).not.toBeUndefined();
  });
});

describe("notifications.markAllRead", () => {
  it("marks all unread as read", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("organizations", {
        clerkOrgId: "org_test",
        name: "Test",
        slug: "test-co",
      });
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert("notifications", {
          clerkOrgId: "org_test",
          kind: "low_balance",
          title: `N${i}`,
          body: "B",
          refId: `all_${i}`,
          createdAt: Date.now() + i,
        });
      }
    });

    const as = asMember(t);
    const result = await as.mutation(api.notifications.markAllRead, {
      orgSlug: "test-co",
    });
    expect(result.updated).toBe(3);

    const unread = await t.run(async (ctx) => {
      return await ctx.db
        .query("notifications")
        .filter((q) => q.eq(q.field("readAt"), undefined))
        .collect();
    });
    expect(unread).toHaveLength(0);
  });

  it("drains hundreds in bounded pages and keeps unread metadata honest", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const orgId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("organizations", {
        clerkOrgId: "org_test",
        name: "Test",
        slug: "test-co",
      });
      for (let index = 0; index < 205; index += 1) {
        await ctx.db.insert("notifications", {
          clerkOrgId: "org_test",
          kind: "low_balance",
          title: `Notice ${index}`,
          body: "Top up",
          refId: `scale_${index}`,
          createdAt: index + 1,
        });
      }
      return id;
    });
    const actor = asMember(t);

    const list = await actor.query(api.notifications.listForOrg, {
      orgSlug: "test-co",
      paginationOpts: { numItems: 10_000, cursor: null },
    });
    expect(list.page).toHaveLength(50);
    expect(list.unreadCount).toBe(100);
    expect(list.unreadCountCapped).toBe(true);

    expect(
      await actor.mutation(api.notifications.markAllRead, {
        orgSlug: "test-co",
      }),
    ).toEqual({ updated: 100, complete: false });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    const state = await t.run(async (ctx) => ({
      unread: await ctx.db
        .query("notifications")
        .withIndex("by_org_read", (q) =>
          q.eq("clerkOrgId", "org_test").eq("readAt", undefined),
        )
        .take(1),
      org: await ctx.db.get(orgId),
    }));
    expect(state.unread).toHaveLength(0);
    expect(state.org).toMatchObject({
      unreadNotificationCount: 0,
      unreadNotificationCountCapped: false,
    });
  });
});
