/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const SECRET = "edge-revocation-secret-32b-min!!";

async function seedOrgKey(
  t: ReturnType<typeof convexTest>,
  keyId = "key_edge_1",
) {
  return await t.run(async (ctx) => {
    await ctx.db.insert("organizations", {
      clerkOrgId: "org_edge",
      name: "Edge Org",
      slug: "edge-org",
    });
    const keyRow = await ctx.db.insert("keySettings", {
      clerkOrgId: "org_edge",
      ownerUserId: "user_edge",
      keyId,
      managed: true,
      familyId: keyId,
      disabled: false,
      updatedAt: Date.now(),
    });
    return { keyRow, keyId };
  });
}

describe("edge key revocation outbox", () => {
  it("enqueues durable event on membership disable and resumes after crash", async () => {
    const t = convexTest(schema, modules);
    vi.stubEnv("GATEWAY_INTERNAL_SECRET", SECRET);
    vi.stubEnv("GATEWAY_URL", "http://127.0.0.1:8787");
    const { keyId } = await seedOrgKey(t);

    const first = await t.mutation(
      internal.keySettings.revokeMembershipVerified,
      {
        clerkOrgId: "org_edge",
        userId: "user_edge",
        svixId: "svix_edge_1",
      },
    );
    expect(first.duplicate).toBe(false);

    const outbox = await t.run(async (ctx) => {
      return await ctx.db.query("edgeKeyRevocationOutbox").collect();
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.keyId).toBe(keyId);
    expect(outbox[0]!.reason).toBe("membership_deleted");
    expect(outbox[0]!.bodyJson).not.toMatch(/sk_|secret|password/i);
    expect(outbox[0]!.status).toBe("pending");

    await t.mutation(internal.edgeKeyRevocation.claim, {
      outboxId: outbox[0]!._id,
      leaseToken: "lease_token_crash_01xx",
    });
    const mid = await t.run(async (ctx) => ctx.db.get(outbox[0]!._id));
    expect(mid?.status).toBe("delivering");

    await t.mutation(internal.edgeKeyRevocation.markFailed, {
      outboxId: outbox[0]!._id,
      leaseToken: "lease_token_crash_01xx",
      errorCode: "simulated_crash",
    });
    const pending = await t.run(async (ctx) => ctx.db.get(outbox[0]!._id));
    expect(pending?.status).toBe("pending");
    expect(pending?.lastErrorCode).toBe("simulated_crash");

    const replay = await t.mutation(
      internal.keySettings.revokeMembershipVerified,
      {
        clerkOrgId: "org_edge",
        userId: "user_edge",
        svixId: "svix_edge_1",
      },
    );
    expect(replay.duplicate).toBe(true);

    const after = await t.run(async (ctx) => {
      const rows = await ctx.db.query("edgeKeyRevocationOutbox").collect();
      const key = await ctx.db
        .query("keySettings")
        .withIndex("by_key", (q) => q.eq("keyId", keyId))
        .unique();
      return { rows, key };
    });
    expect(after.rows).toHaveLength(1);
    expect(after.key?.disabled).toBe(true);
    expect(after.key?.edgeRevision).toBeGreaterThanOrEqual(1);
    vi.unstubAllEnvs();
  });

  it("keeps outbox open when edge delivery cannot complete", async () => {
    const t = convexTest(schema, modules);
    vi.stubEnv("GATEWAY_INTERNAL_SECRET", SECRET);
    vi.stubEnv("GATEWAY_URL", "http://127.0.0.1:9");
    await seedOrgKey(t, "key_edge_ack");
    await t.mutation(internal.keySettings.setDisabledVerified, {
      clerkOrgId: "org_edge",
      userId: "user_edge",
      keyId: "key_edge_ack",
      disabled: true,
    });
    const row = await t.run(async (ctx) => {
      return await ctx.db.query("edgeKeyRevocationOutbox").first();
    });
    expect(row).not.toBeNull();
    await t.run(async (ctx) => {
      await ctx.db.patch(row!._id, { nextAttemptAt: 0, status: "pending" });
    });
    await t.action(internal.edgeKeyRevocation.dispatch, {
      outboxId: row!._id,
    });
    const failed = await t.run(async (ctx) => ctx.db.get(row!._id));
    expect(failed?.status).toBe("pending");
    expect(failed?.ackedAt).toBeUndefined();
    vi.unstubAllEnvs();
  });
});
