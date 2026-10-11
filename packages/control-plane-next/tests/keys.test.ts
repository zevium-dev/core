import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  sha256Hex,
  signRegistryVerifiedKeyProjection,
  signRegistryVerifiedKeyRotationProjection,
  type RegistryVerifiedKeyProjection,
  type RegistryVerifiedKeyRotationProjection,
} from "@zevium/shared";
import {
  harness,
  seed,
  identity,
  keySecret,
  webhook,
  webhookSecret,
} from "./helpers";
import { organization } from "./fixtures";
import { api, internal } from "../convex/_generated/api";
const provider = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue({ revoked: false }),
  revoke: vi.fn().mockResolvedValue({}),
}));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({ apiKeys: provider }),
}));
function projection(
  id = "key_one",
  user = "user_one",
  org = "org_one",
): RegistryVerifiedKeyProjection {
  return {
    schemaVersion: 1,
    verifiedAt: Date.now(),
    provision: {
      clerkKeyId: id,
      clerkOrgId: org,
      ownerUserId: user,
      subjectUserId: user,
      secretSha256: (id === "key_one" ? "a" : "b").repeat(64),
      budgetId: "budget_one",
      budgetRevision: 1,
      lifecycle: "active",
      monthlyCapCredits: 1000,
      graceUntil: null,
      expiresAt: null,
      scopes: ["gateway:execute"],
    },
  };
}
async function signed(p: RegistryVerifiedKeyProjection) {
  return {
    projection: p,
    signature: await signRegistryVerifiedKeyProjection(keySecret, p),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubEnv("REGISTRY_KEY_PROJECTION_HMAC_SECRET", keySecret);
  vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", webhookSecret);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe("broker-verified keys without registry identity", () => {
  it("verifies existing broker wire signatures and stores hash-only immutable identity", async () => {
    const t = harness();
    await seed(t);
    const user = t.withIdentity(identity());
    const p = projection();
    const dto = await user.mutation(
      api.keySettings.registerVerified,
      await signed(p),
    );
    expect(dto.keyId).toBe("key_one");
    expect(JSON.stringify(dto)).not.toContain(p.provision.secretSha256);
    await user.mutation(api.keySettings.setDisabled, {
      keyId: "key_one",
      disabled: true,
    });
    expect(
      (await user.mutation(api.keySettings.registerVerified, await signed(p)))
        .disabled,
    ).toBe(true);
    await expect(
      user.mutation(
        api.keySettings.registerVerified,
        await signed(projection("key_two")),
      ),
    ).rejects.toThrow("already have a key");
    await expect(
      user.mutation(api.keySettings.registerVerified, {
        ...(await signed(p)),
        signature: "v1=" + "0".repeat(64),
      }),
    ).rejects.toThrow("signature");
    const stale = { ...p, verifiedAt: Date.now() - 300_001 };
    await expect(
      user.mutation(api.keySettings.registerVerified, await signed(stale)),
    ).rejects.toThrow("expired");
  });
  it("rejects forged owners, changed replay identity, global key/hash collisions and unknown attribution", async () => {
    const t = harness();
    await seed(t);
    const one = t.withIdentity(identity());
    await one.mutation(
      api.keySettings.registerVerified,
      await signed(projection()),
    );
    await expect(
      one.mutation(
        api.keySettings.registerVerified,
        await signed(projection("other", "user_other")),
      ),
    ).rejects.toThrow("identity");
    await expect(
      one.mutation(
        api.keySettings.registerVerified,
        await signed({
          ...projection(),
          provision: { ...projection().provision, budgetId: "changed" },
        }),
      ),
    ).rejects.toThrow("conflicts");
    const other = t.withIdentity(identity("two", "user_two"));
    await expect(
      other.mutation(
        api.keySettings.registerVerified,
        await signed(projection("key_one", "user_two", "org_two")),
      ),
    ).rejects.toThrow("conflicts");
    const hashCollision = projection("other", "user_two", "org_two");
    hashCollision.provision.secretSha256 = "a".repeat(64);
    await expect(
      other.mutation(
        api.keySettings.registerVerified,
        await signed(hashCollision),
      ),
    ).rejects.toThrow("conflicts");
    await expect(
      one.mutation(api.keySettings.registerOwnedKey, {
        keyId: "unknown",
        keyName: "Forged",
      }),
    ).rejects.toThrow("Verified key not found");
    await expect(
      other.mutation(api.keySettings.setDisabled, {
        keyId: "key_one",
        disabled: true,
      }),
    ).rejects.toThrow("Verified key not found");
  });
  it("enforces owner/member/admin controls and redacts all display DTOs", async () => {
    const t = harness();
    await seed(t);
    const member = t.withIdentity(identity("one", "user_one", "org:member"));
    await member.mutation(
      api.keySettings.registerVerified,
      await signed(projection()),
    );
    const other = t.withIdentity(identity("one", "user_other", "org:member"));
    expect(await other.query(api.keySettings.listKeys, {})).toEqual([]);
    await expect(
      other.mutation(api.keySettings.setDisabled, {
        keyId: "key_one",
        disabled: true,
      }),
    ).rejects.toThrow("Verified key not found");
    await expect(
      member.mutation(api.keySettings.setCap, {
        keyId: "key_one",
        monthlyCapCredits: 5,
      }),
    ).rejects.toThrow("admin");
    await member.mutation(api.keySettings.setDisabled, {
      keyId: "key_one",
      disabled: true,
    });
    const rows = await t
      .withIdentity(identity("one", "admin"))
      .query(api.keySettings.getForOrg, {});
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(
      /secretSha256|verifiedProjectionHash|providerRevoke/,
    );
  });
  it("retains rotation identity, fixed grace, canonical replay and family-wide caps", async () => {
    const t = harness();
    await seed(t);
    const admin = t.withIdentity(identity());
    await admin.mutation(
      api.keySettings.registerVerified,
      await signed(projection()),
    );
    const op = await admin.mutation(api.keySettings.beginRotation, {
      operationId: "rotate",
      oldKeyId: "key_one",
    });
    expect(
      (
        await admin.mutation(api.keySettings.beginRotation, {
          operationId: "rotate",
          oldKeyId: "key_one",
        })
      )._id,
    ).toBe(op._id);
    await expect(
      admin.mutation(api.keySettings.beginRotation, {
        operationId: "competing",
        oldKeyId: "key_one",
      }),
    ).rejects.toThrow("already in progress");
    const p: RegistryVerifiedKeyRotationProjection = {
      schemaVersion: 1,
      verifiedAt: Date.now(),
      operationId: "rotate",
      oldKeyId: "key_one",
      newProvision: projection("key_two").provision,
      graceUntil: Date.now() + 86_400_000,
    };
    const args = {
      projection: p,
      signature: await signRegistryVerifiedKeyRotationProjection(keySecret, p),
    };
    expect(
      (await admin.mutation(api.keySettings.completeRotation, args)).status,
    ).toBe("completed");
    expect(
      (await admin.mutation(api.keySettings.completeRotation, args)).status,
    ).toBe("completed");
    const changed = { ...p, graceUntil: p.graceUntil + 1 };
    await expect(
      admin.mutation(api.keySettings.completeRotation, {
        projection: changed,
        signature: await signRegistryVerifiedKeyRotationProjection(
          keySecret,
          changed,
        ),
      }),
    ).rejects.toThrow("conflicts");
    await admin.mutation(api.keySettings.setCap, {
      keyId: "key_two",
      monthlyCapCredits: 200,
    });
    const rows = await admin.query(api.keySettings.getForOrg, {});
    expect(rows.map((r) => r.monthlyCapCredits)).toEqual([200, 200]);
    expect(new Set(rows.map((r) => r.keyFamilyId))).toEqual(
      new Set(["key_one"]),
    );
    expect(
      await t.query(internal.keySettings.resolveMcpIdentity, {
        orgId: "org_one",
        userId: "user_one",
      }),
    ).toEqual({ orgId: "org_one", keyId: "key_two" });
    vi.setSystemTime(Date.now() + 86_400_001);
    await t.mutation(internal.keySettings.expireGrace, { keyId: "key_one" });
    expect(
      (await admin.query(api.keySettings.getForOrg, {}))[0]!.lifecycle,
    ).toBe("revoked");
  });
  it("does not complete failed, expired, disabled or revoked rotations", async () => {
    for (const state of ["failed", "expired", "disabled", "revoked"] as const) {
      const t = harness();
      await seed(t);
      const admin = t.withIdentity(identity());
      await admin.mutation(
        api.keySettings.registerVerified,
        await signed(projection()),
      );
      await admin.mutation(api.keySettings.beginRotation, {
        operationId: "rotate",
        oldKeyId: "key_one",
      });
      if (state === "failed")
        await admin.mutation(api.keySettings.failRotation, {
          operationId: "rotate",
          message: "provider secret must not be stored",
        });
      if (state === "disabled")
        await admin.mutation(api.keySettings.setDisabled, {
          keyId: "key_one",
          disabled: true,
        });
      if (state === "revoked")
        await admin.mutation(api.keySettings.revokePrevious, {
          keyId: "key_one",
        });
      if (state === "expired") vi.setSystemTime(Date.now() + 300_001);
      const p: RegistryVerifiedKeyRotationProjection = {
        schemaVersion: 1,
        verifiedAt: Date.now(),
        operationId: "rotate",
        oldKeyId: "key_one",
        newProvision: projection("key_two").provision,
        graceUntil: Date.now() + 86_400_000,
      };
      const result = await admin.mutation(api.keySettings.completeRotation, {
        projection: p,
        signature: await signRegistryVerifiedKeyRotationProjection(
          keySecret,
          p,
        ),
      });
      expect(result).toMatchObject({ status: "failed", newKeyId: "key_two" });
      expect(
        await admin.mutation(api.keySettings.completeRotation, {
          projection: p,
          signature: await signRegistryVerifiedKeyRotationProjection(
            keySecret,
            p,
          ),
        }),
      ).toEqual(result);
      await t.finishAllScheduledFunctions(() => vi.runAllTimers());
      expect(provider.revoke).toHaveBeenCalledWith({
        apiKeyId: "key_two",
        revocationReason: "Zevium key revoked",
      });
      const op = await t.run((ctx) =>
        ctx.db
          .query("apiKeys")
          .withIndex("by_new_key", (q) => q.eq("newKeyId", "key_two"))
          .unique(),
      );
      expect(op).toMatchObject({
        state: "failed",
        providerRevoke: { state: "complete", attempts: 1 },
      });
    }
  });
  it.each(["envelope", "svix"])(
    "revokes membership-deleted keys using %s time despite stale updated_at",
    async (timestampSource) => {
      const t = harness();
      const ids = await seed(t);
      const admin = t.withIdentity(identity());
      const p = projection();
      await admin.mutation(api.keySettings.registerVerified, await signed(p));
      vi.setSystemTime(Date.now() + 2000);
      const deletedAt =
        timestampSource === "envelope"
          ? Date.now() - 500
          : Math.floor(Date.now() / 1000) * 1000;
      await webhook(
        t,
        "membership",
        "organizationMembership.deleted",
        {
          id: "mem_one",
          created_at: p.verifiedAt - 86_400_000,
          updated_at: p.verifiedAt - 86_400_000,
          organization: { id: "org_one" },
          public_user_data: { user_id: "user_one" },
        },
        timestampSource === "envelope" ? deletedAt : undefined,
      );
      expect(
        await t.query(internal.keySettings.resolveMcpIdentity, {
          userId: "user_one",
          orgId: "org_one",
        }),
      ).toBeNull();
      await expect(
        admin.mutation(api.keySettings.setDisabled, {
          keyId: "key_one",
          disabled: false,
        }),
      ).rejects.toThrow("no longer active");
      await t.finishAllScheduledFunctions(() => vi.runAllTimers());
      const revoked = await t.run((ctx) => ctx.db.query("apiKeys").first());
      expect(revoked).toMatchObject({
        revokedAt: expect.any(Number),
        edgeRevision: 2,
        membershipRevokedAt: deletedAt,
        providerRevoke: { state: "complete" },
      });
      expect(provider.revoke).toHaveBeenCalledWith({
        apiKeyId: "key_one",
        revocationReason: "Zevium key revoked",
      });
      await t.mutation(internal.clerkWebhooks.membershipPage, {
        organizationId: ids.one,
        userId: "user_one",
        deletedAt,
        cursor: null,
      });
      expect(await t.run((ctx) => ctx.db.get(revoked!._id))).toEqual(revoked);
      const stale = projection("key_two");
      stale.verifiedAt = p.verifiedAt;
      await expect(
        admin.mutation(api.keySettings.registerVerified, await signed(stale)),
      ).rejects.toThrow("no longer active");
    },
  );
  it("keeps provider cleanup durable and fences stale workers", async () => {
    const t = harness();
    await seed(t);
    const admin = t.withIdentity(identity());
    await admin.mutation(
      api.keySettings.registerVerified,
      await signed(projection()),
    );
    await admin.mutation(api.keySettings.revokePrevious, { keyId: "key_one" });
    expect(
      await t.mutation(internal.keyRecovery.claim, { keyId: "key_one" }),
    ).toBe(1);
    expect(
      await t.mutation(internal.keyRecovery.claim, { keyId: "key_one" }),
    ).toBeNull();
    vi.setSystemTime(Date.now() + 60_001);
    expect(
      await t.mutation(internal.keyRecovery.claim, { keyId: "key_one" }),
    ).toBe(2);
    await t.mutation(internal.keyRecovery.finish, {
      keyId: "key_one",
      attempt: 1,
      success: true,
    });
    expect(await t.run((ctx) => ctx.db.query("apiKeys").first())).toMatchObject(
      { providerRevoke: { state: "processing", attempts: 2 } },
    );
    await t.mutation(internal.keyRecovery.finish, {
      keyId: "key_one",
      attempt: 2,
      success: false,
    });
    expect(await t.run((ctx) => ctx.db.query("apiKeys").first())).toMatchObject(
      { lifecycle: "disabled", providerRevoke: { state: "retry" } },
    );
  });
});

it("recovers provider dispatch lost before the lease was claimed", async () => {
  const t = harness();
  await seed(t);
  const admin = t.withIdentity(identity());
  await admin.mutation(
    api.keySettings.registerVerified,
    await signed(projection()),
  );
  await admin.mutation(api.keySettings.revokePrevious, { keyId: "key_one" });
  await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    for (const job of jobs) await ctx.scheduler.cancel(job._id);
  });
  await t.mutation(internal.keyRecovery.recoverDue, {});
  const jobs = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  expect(jobs.filter((job) => job.state.kind === "pending")).toHaveLength(1);
  expect(
    await t.mutation(internal.keyRecovery.claim, { keyId: "key_one" }),
  ).toBe(1);
});

it("revokes deleted-user keys across multiple pages and organizations exactly once", async () => {
  const t = harness();
  await seed(t);
  const admin = t.withIdentity(identity());
  await admin.mutation(
    api.keySettings.registerVerified,
    await signed(projection()),
  );
  await t.run(async (ctx) => {
    const first = await ctx.db.query("apiKeys").first();
    if (first?.kind !== "key") throw new Error("missing fixture key");
    const { _id, _creationTime, ...fields } = first;
    for (let i = 0; i < 55; i++) {
      const org = await ctx.db.insert(
        "organizations",
        organization(`bulk${i}`),
      );
      await ctx.db.insert("apiKeys", {
        ...fields,
        organizationId: org,
        clerkOrgId: `org_bulk${i}`,
        keyId: `bulk_${i}`,
        secretSha256: await sha256Hex(`bulk_${i}`),
        lifecycle: i % 2 ? "grace" : "active",
      });
    }
    await ctx.db.insert("apiKeys", {
      ...fields,
      keyId: "other_user",
      ownerUserId: "user_other",
      subjectUserId: "user_other",
      secretSha256: "c".repeat(64),
    });
  });
  const deletedAt = Date.now();
  const event = { id: "user_one", updated_at: deletedAt - 86_400_000 };
  expect(
    (await webhook(t, "user-delete", "user.deleted", event, deletedAt)).status,
  ).toBe(200);
  expect(
    await t.query(internal.keySettings.resolveMcpIdentity, {
      orgId: "org_one",
      userId: "user_one",
    }),
  ).toBeNull();
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  const rows = await t.run((ctx) =>
    ctx.db
      .query("apiKeys")
      .withIndex("by_owner", (q) =>
        q.eq("kind", "key").eq("ownerUserId", "user_one"),
      )
      .collect(),
  );
  expect(rows).toHaveLength(56);
  for (const row of rows)
    expect(row).toMatchObject({
      lifecycle: "disabled",
      revokedAt: expect.any(Number),
      edgeRevision: 2,
      providerRevoke: { state: "complete", attempts: 1 },
    });
  expect(provider.revoke).toHaveBeenCalledTimes(56);
  expect(
    (await webhook(t, "user-delete", "user.deleted", event, deletedAt)).status,
  ).toBe(200);
  await t.mutation(internal.clerkWebhooks.userKeysPage, {
    userId: "user_one",
    cursor: null,
  });
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  expect(provider.revoke).toHaveBeenCalledTimes(56);
  expect(
    await t.run((ctx) =>
      ctx.db
        .query("apiKeys")
        .withIndex("by_key", (q) => q.eq("keyId", "other_user"))
        .unique(),
    ),
  ).not.toHaveProperty("revokedAt");
});

it.each(["stale-proof", "grace", "cap", "expired-key", "hash-collision"])(
  "retains cleanup when rotation validation fails: %s",
  async (failure) => {
    const t = harness();
    await seed(t);
    const admin = t.withIdentity(identity());
    await admin.mutation(
      api.keySettings.registerVerified,
      await signed(projection()),
    );
    await admin.mutation(api.keySettings.beginRotation, {
      operationId: "rotate",
      oldKeyId: "key_one",
    });
    const p: RegistryVerifiedKeyRotationProjection = {
      schemaVersion: 1,
      verifiedAt: Date.now(),
      operationId: "rotate",
      oldKeyId: "key_one",
      newProvision: projection("key_two").provision,
      graceUntil: Date.now() + 86_400_000,
    };
    if (failure === "stale-proof") vi.setSystemTime(Date.now() + 300_001);
    if (failure === "grace") p.graceUntil += 1;
    if (failure === "cap") p.newProvision.monthlyCapCredits = 2000;
    if (failure === "expired-key") p.newProvision.expiresAt = Date.now() - 1;
    if (failure === "hash-collision")
      p.newProvision.secretSha256 = "a".repeat(64);
    expect(
      await admin.mutation(api.keySettings.completeRotation, {
        projection: p,
        signature: await signRegistryVerifiedKeyRotationProjection(
          keySecret,
          p,
        ),
      }),
    ).toMatchObject({ status: "failed", newKeyId: "key_two" });
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system
        .query("_scheduled_functions")
        .collect())
        await ctx.scheduler.cancel(job._id);
    });
    await t.mutation(internal.keyRecovery.recoverDue, {});
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(provider.revoke).toHaveBeenCalledWith({
      apiKeyId: "key_two",
      revocationReason: "Zevium key revoked",
    });
    expect(
      (await admin.query(api.keySettings.listKeys, {})).map((row) => row.keyId),
    ).toEqual(["key_one"]);
  },
);

it("failRotation requires signed cleanup evidence, persists newKeyId and reuses retry leases", async () => {
  const t = harness();
  await seed(t);
  const admin = t.withIdentity(identity());
  await admin.mutation(
    api.keySettings.registerVerified,
    await signed(projection()),
  );
  const op = await admin.mutation(api.keySettings.beginRotation, {
    operationId: "rotate",
    oldKeyId: "key_one",
  });
  const p: RegistryVerifiedKeyRotationProjection = {
    schemaVersion: 1,
    verifiedAt: Date.now(),
    operationId: "rotate",
    oldKeyId: "key_one",
    newProvision: projection("key_two").provision,
    graceUntil: Date.now() + 86_400_000,
  };
  const args = {
    operationId: "rotate",
    message: "provider secret",
    cleanup: {
      projection: p,
      signature: await signRegistryVerifiedKeyRotationProjection(keySecret, p),
    },
  };
  await expect(
    admin.mutation(api.keySettings.failRotation, {
      ...args,
      cleanup: { ...args.cleanup, signature: "v1=" + "0".repeat(64) },
    }),
  ).rejects.toThrow("signature");
  const result = await admin.mutation(api.keySettings.failRotation, args);
  expect(result).toMatchObject({ status: "failed", newKeyId: "key_two" });
  vi.setSystemTime(Date.now() + 1000);
  expect(await admin.mutation(api.keySettings.failRotation, args)).toEqual(
    result,
  );
  expect(
    await t.mutation(internal.keyRecovery.claim, { keyId: "key_two" }),
  ).toBe(1);
  vi.setSystemTime(Date.now() + 60_001);
  expect(
    await t.mutation(internal.keyRecovery.claim, { keyId: "key_two" }),
  ).toBe(2);
  await t.mutation(internal.keyRecovery.finish, {
    keyId: "key_two",
    attempt: 1,
    success: true,
  });
  expect(await t.run((ctx) => ctx.db.get(op._id))).toMatchObject({
    providerRevoke: { state: "processing", attempts: 2 },
  });
  await t.mutation(internal.keyRecovery.finish, {
    keyId: "key_two",
    attempt: 2,
    success: false,
  });
  expect(await t.run((ctx) => ctx.db.get(op._id))).toMatchObject({
    providerRevoke: { state: "retry", attempts: 2 },
  });
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  expect(await t.run((ctx) => ctx.db.get(op._id))).toMatchObject({
    providerRevoke: { state: "complete", attempts: 3 },
  });
  await expect(
    admin.mutation(
      api.keySettings.registerVerified,
      await signed(projection("key_two")),
    ),
  ).rejects.toThrow("no longer active");
});
