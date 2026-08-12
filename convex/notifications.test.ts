/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { createNotification } from "./lib/notifications";

const modules = import.meta.glob("./**/*.ts");

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

  it("rejects non-member", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("organizations", {
        clerkOrgId: "org_test",
        name: "Test",
        slug: "test-co",
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
    await expect(
      outsider.query(api.notifications.listForOrg, {
        orgSlug: "test-co",
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow(/Not a member/);
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
    expect(page1.unreadCountCapped).toBe(false);
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
      through: Number.MAX_SAFE_INTEGER,
    });
    expect(result.updated).toBe(3);
    expect(result).toMatchObject({ updated: 3, hasMore: false });
    expect(result.through).toBe(Number.MAX_SAFE_INTEGER);

    const unread = await t.run(async (ctx) => {
      return await ctx.db
        .query("notifications")
        .filter((q) => q.eq(q.field("readAt"), undefined))
        .collect();
    });
    expect(unread).toHaveLength(0);
  });

  it("clears an exact snapshot in bounded batches", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("organizations", {
        clerkOrgId: "org_test",
        name: "Test",
        slug: "test-co",
      });
      for (let i = 0; i < 205; i++) {
        await ctx.db.insert("notifications", {
          clerkOrgId: "org_test",
          kind: "low_balance",
          title: `N${i}`,
          body: "B",
          refId: `batch_${i}`,
          createdAt: i,
        });
      }
    });

    const as = asMember(t);
    const capped = await as.query(api.notifications.listForOrg, {
      orgSlug: "test-co",
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(capped.unreadCount).toBe(100);
    expect(capped.unreadCountCapped).toBe(true);

    let totalUpdated = 0;
    let hasMore = true;
    let through: number | undefined = 204;
    while (hasMore) {
      const result = await as.mutation(api.notifications.markAllRead, {
        orgSlug: "test-co",
        through,
      });
      totalUpdated += result.updated;
      through = result.through;
      hasMore = result.hasMore;
    }
    expect(totalUpdated).toBe(205);

    const final = await as.query(api.notifications.listForOrg, {
      orgSlug: "test-co",
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(final.unreadCount).toBe(0);
    expect(final.unreadCountCapped).toBe(false);
  });

  it("leaves notifications created after the click snapshot unread", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("organizations", {
        clerkOrgId: "org_test",
        name: "Test",
        slug: "test-co",
      });
      for (const createdAt of [10, 20, 30]) {
        await ctx.db.insert("notifications", {
          clerkOrgId: "org_test",
          kind: "low_balance",
          title: `N${createdAt}`,
          body: "B",
          refId: `snapshot_${createdAt}`,
          createdAt,
        });
      }
    });

    const as = asMember(t);
    const result = await as.mutation(api.notifications.markAllRead, {
      orgSlug: "test-co",
      through: 20,
    });
    expect(result).toEqual({ updated: 2, hasMore: false, through: 20 });

    const page = await as.query(api.notifications.listForOrg, {
      orgSlug: "test-co",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.unreadCount).toBe(1);
    expect(
      page.page.find((row) => row.createdAt === 30)?.readAt,
    ).toBeUndefined();
  });
});
