import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
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
import { api, internal } from "../convex/_generated/api";
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
      await expect(
        admin.mutation(api.keySettings.completeRotation, {
          projection: p,
          signature: await signRegistryVerifiedKeyRotationProjection(
            keySecret,
            p,
          ),
        }),
      ).rejects.toThrow(/failed|current key/);
    }
  });
  it("denies membership-deleted keys immediately before cleanup and stale projection replay", async () => {
    const t = harness();
    await seed(t);
    const admin = t.withIdentity(identity());
    const p = projection();
    await admin.mutation(api.keySettings.registerVerified, await signed(p));
    await webhook(t, "membership", "organizationMembership.deleted", {
      id: "mem_one",
      updated_at: Date.now(),
      organization: { id: "org_one" },
      public_user_data: { user_id: "user_one" },
    });
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
    await admin.mutation(api.keySettings.revokePrevious, { keyId: "key_one" });
    await expect(
      admin.mutation(
        api.keySettings.registerVerified,
        await signed(projection("key_two")),
      ),
    ).rejects.toThrow("no longer active");
  });
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
