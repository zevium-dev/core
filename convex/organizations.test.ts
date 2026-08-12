/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function asAdmin(t: ReturnType<typeof convexTest>, orgId = "org_pub") {
  return t.withIdentity({
    subject: "user_admin",
    org_id: orgId,
    org_slug: "new-clerk-slug",
    org_role: "org:admin",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("stable public handles", () => {
  it("allows draft-stage setup but freezes the handle after first publish", async () => {
    const t = convexTest(schema, modules);
    const { orgId, projectId } = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_pub",
        name: "Publisher",
        slug: "stale-clerk-slug",
        publicHandle: "old-handle",
      });
      const projectId = await ctx.db.insert("projects", {
        organizationId: orgId,
        name: "API",
        slug: "api",
        status: "draft",
        visibility: "private",
        tags: [],
      });
      return { orgId, projectId };
    });

    const actor = asAdmin(t);
    const renamed = await actor.mutation(api.organizations.setPublicHandle, {
      handle: "launch-handle",
    });
    expect(renamed.publicHandle).toBe("launch-handle");

    await t.run(async (ctx) => {
      await ctx.db.patch(projectId, { status: "published" });
    });
    await expect(
      actor.mutation(api.organizations.setPublicHandle, {
        handle: "broken-links",
      }),
    ).rejects.toThrow(/permanent after first publication/);
    expect(
      await t.run(async (ctx) => (await ctx.db.get(orgId))?.publicHandle),
    ).toBe("launch-handle");

    const mine = await actor.query(api.organizations.listMine, {});
    expect(mine[0]).toMatchObject({
      publisherHandle: "launch-handle",
      publicHandleLocked: true,
    });
  });
});

describe("organization archive ordering and scale", () => {
  it("delivers one canonical archive event with HMAC-bound raw bytes", async () => {
    const previousBaseUrl = process.env.GATEWAY_CONTROL_BASE_URL;
    const previousSecret = process.env.GATEWAY_INTERNAL_SECRET;
    process.env.GATEWAY_CONTROL_BASE_URL = "https://gateway.test";
    process.env.GATEWAY_INTERNAL_SECRET = "control-test-secret";
    try {
      const t = convexTest(schema, modules);
      await t.run(async (ctx) => {
        await ctx.db.insert("organizations", {
          clerkOrgId: "org_signed_archive",
          name: "Signed Archive",
          slug: "signed-archive",
          publicHandle: "signed-archive",
        });
      });
      await t.mutation(internal.organizations.archiveFromClerk, {
        clerkOrgId: "org_signed_archive",
      });
      await t.mutation(internal.organizations.archiveFromClerk, {
        clerkOrgId: "org_signed_archive",
      });
      const outbox = await t.run(async (ctx) =>
        ctx.db.query("gatewayControlOutbox").collect(),
      );
      expect(outbox).toHaveLength(1);

      let signedRequest: Request | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          signedRequest = new Request(input, init);
          const body = JSON.parse(await signedRequest.clone().text()) as {
            operation: string;
            sourceRevision: number;
          };
          return Response.json({
            status: "applied",
            operation: body.operation,
            sourceRevision: body.sourceRevision,
          });
        }),
      );

      await expect(
        t.action(internal.organizations.deliverGatewayControlOutbox, {
          outboxId: outbox[0]!._id,
        }),
      ).resolves.toEqual({ delivered: true });
      expect(signedRequest?.url).toBe(
        "https://gateway.test/internal/registry/v1/org/archive",
      );
      const timestamp = signedRequest?.headers.get("x-zevium-timestamp");
      const nonce = signedRequest?.headers.get("x-zevium-nonce");
      const signature = signedRequest?.headers.get("x-zevium-signature");
      const rawBody = await signedRequest!.clone().text();
      expect(timestamp).toMatch(/^\d+$/);
      expect(nonce).toMatch(/^[0-9a-f-]{36}$/i);
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("control-test-secret"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const expectedBytes = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${timestamp}.${nonce}.${rawBody}`),
      );
      const expected = [...new Uint8Array(expectedBytes)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      expect(signature).toBe(`v1=${expected}`);
      expect(
        await t.run(async (ctx) => ctx.db.get(outbox[0]!._id)),
      ).toMatchObject({ status: "acked", attempts: 1 });
    } finally {
      if (previousBaseUrl === undefined)
        delete process.env.GATEWAY_CONTROL_BASE_URL;
      else process.env.GATEWAY_CONTROL_BASE_URL = previousBaseUrl;
      if (previousSecret === undefined)
        delete process.env.GATEWAY_INTERNAL_SECRET;
      else process.env.GATEWAY_INTERNAL_SECRET = previousSecret;
    }
  });

  it("retains a delete-before-create tombstone and never resurrects the org", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);

    await t.mutation(internal.organizations.archiveFromClerk, {
      clerkOrgId: "org_late",
    });
    await t.mutation(internal.organizations.archiveFromClerk, {
      clerkOrgId: "org_late",
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    expect(
      await t.mutation(internal.organizations.upsertFromClerk, {
        clerkOrgId: "org_late",
        name: "Late Org",
        slug: "late-org",
      }),
    ).toBeNull();
    const state = await t.run(async (ctx) => ({
      orgs: await ctx.db.query("organizations").collect(),
      tombstones: await ctx.db.query("organizationTombstones").collect(),
    }));
    expect(state.orgs).toHaveLength(0);
    expect(state.tombstones).toHaveLength(1);

    await expect(
      asAdmin(t, "org_late").mutation(api.organizations.ensureOrganization, {
        clerkOrgId: "org_late",
      }),
    ).rejects.toThrow(/archived/);
  });

  it("commits archive first, then disables more than one key page idempotently", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const orgId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("organizations", {
        clerkOrgId: "org_large",
        name: "Large Org",
        slug: "large-org",
        publicHandle: "large-org",
      });
      for (let index = 0; index < 250; index += 1) {
        await ctx.db.insert("keySettings", {
          clerkOrgId: "org_large",
          keyId: `key_${index}`,
          disabled: false,
          updatedAt: 1,
        });
      }
      return id;
    });

    await t.mutation(internal.organizations.archiveFromClerk, {
      clerkOrgId: "org_large",
    });
    expect(
      await t.run(async (ctx) => (await ctx.db.get(orgId))?.archivedAt),
    ).toEqual(expect.any(Number));

    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    let state = await t.run(async (ctx) => ({
      keys: await ctx.db
        .query("keySettings")
        .withIndex("by_org", (q) => q.eq("clerkOrgId", "org_large"))
        .collect(),
      tombstones: await ctx.db.query("organizationTombstones").collect(),
    }));
    expect(state.keys).toHaveLength(250);
    expect(state.keys.every((key) => key.disabled)).toBe(true);
    expect(state.tombstones).toHaveLength(1);

    await t.mutation(internal.organizations.archiveFromClerk, {
      clerkOrgId: "org_large",
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    state = await t.run(async (ctx) => ({
      keys: await ctx.db.query("keySettings").collect(),
      tombstones: await ctx.db.query("organizationTombstones").collect(),
    }));
    expect(state.keys.every((key) => key.disabled)).toBe(true);
    expect(state.tombstones).toHaveLength(1);
  });
});
