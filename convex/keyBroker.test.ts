/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import schema from "./schema";

type FakeKey = {
  id: string;
  type: string;
  name: string;
  subject: string;
  scopes: string[];
  claims: Record<string, string> | null;
  revoked: boolean;
  revocationReason: string | null;
  expired: boolean;
  expiration: number | null;
  createdBy: string | null;
  description: string | null;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
  secret?: string;
};

const clerk = vi.hoisted(() => ({
  keys: [] as FakeKey[],
  sequence: 0,
  membership: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({
    organizations: {
      getOrganizationMembershipList: clerk.membership,
    },
    apiKeys: {
      list: clerk.list,
      create: clerk.create,
      get: clerk.get,
      revoke: clerk.revoke,
    },
  }),
}));
vi.mock("./registrySync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./registrySync")>()),
  enqueueKeyState: vi.fn(async () => undefined),
  enqueueKeyUpsert: vi.fn(async () => undefined),
}));

const modules = import.meta.glob("./**/*.ts");
const previousClerkSecret = process.env.CLERK_SECRET_KEY;

function membership(userId = "user_owner") {
  return {
    data: [{ publicUserData: { userId } }],
    totalCount: 1,
  };
}

function fakeKey(id: string, options: Partial<FakeKey> = {}): FakeKey {
  return {
    id,
    type: "api_key",
    name: options.name ?? id,
    subject: options.subject ?? "user_owner",
    scopes: options.scopes ?? [],
    claims: options.claims ?? { org_id: "org_acme" },
    revoked: options.revoked ?? false,
    revocationReason: options.revocationReason ?? null,
    expired: options.expired ?? false,
    expiration: options.expiration ?? null,
    createdBy: options.createdBy ?? "user_owner",
    description: options.description ?? null,
    lastUsedAt: options.lastUsedAt ?? null,
    createdAt: options.createdAt ?? Date.now(),
    updatedAt: options.updatedAt ?? Date.now(),
    ...(options.secret === undefined ? {} : { secret: options.secret }),
  };
}

function asOwner(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "user_owner",
    org_id: "org_acme",
    org_role: "org:member",
  });
}

async function seedOrganization(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("organizations", {
      clerkOrgId: "org_acme",
      name: "Acme",
      slug: "acme",
    });
  });
}

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = "sk_test_never_sent";
  clerk.keys = [];
  clerk.sequence = 0;
  clerk.membership.mockReset().mockResolvedValue(membership());
  clerk.list
    .mockReset()
    .mockImplementation(async (args: { offset: number; limit: number }) => {
      const visible = clerk.keys.filter((key) => !key.revoked && !key.expired);
      return {
        data: visible.slice(args.offset, args.offset + args.limit),
        totalCount: visible.length,
      };
    });
  clerk.create
    .mockReset()
    .mockImplementation(
      async (args: {
        name: string;
        subject: string;
        createdBy: string;
        claims: Record<string, string>;
      }) => {
        clerk.sequence += 1;
        const key = fakeKey(`key_created_${clerk.sequence}`, {
          name: args.name,
          subject: args.subject,
          createdBy: args.createdBy,
          claims: args.claims,
          secret: `zev_secret_${clerk.sequence}`,
        });
        clerk.keys.push(key);
        return key;
      },
    );
  clerk.get.mockReset().mockImplementation(async (keyId: string) => {
    const key = clerk.keys.find((candidate) => candidate.id === keyId);
    if (key === undefined) {
      throw Object.assign(new Error("not found"), { status: 404 });
    }
    return key;
  });
  clerk.revoke
    .mockReset()
    .mockImplementation(async ({ apiKeyId }: { apiKeyId: string }) => {
      const index = clerk.keys.findIndex((key) => key.id === apiKeyId);
      if (index < 0)
        throw Object.assign(new Error("not found"), { status: 404 });
      clerk.keys[index] = { ...clerk.keys[index]!, revoked: true };
      return clerk.keys[index];
    });
});

afterEach(() => {
  vi.useRealTimers();
  if (previousClerkSecret === undefined) delete process.env.CLERK_SECRET_KEY;
  else process.env.CLERK_SECRET_KEY = previousClerkSecret;
});

describe("Clerk key broker public boundary", () => {
  it("lets one concurrent create fence mint exactly one tracked provider key", async () => {
    const t = convexTest(schema, modules);
    await seedOrganization(t);
    const owner = asOwner(t);
    let releaseCreate: (() => void) | undefined;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const defaultCreate = clerk.create.getMockImplementation();
    clerk.create.mockImplementation(async (...args: unknown[]) => {
      await createGate;
      return await defaultCreate!(...args);
    });

    const settled = Promise.allSettled([
      owner.action(api.keyBroker.createManagedKey, {
        operationId: "create-concurrent-1",
        name: "Production",
      }),
      owner.action(api.keyBroker.createManagedKey, {
        operationId: "create-concurrent-1",
        name: "Production",
      }),
    ]);
    await vi.waitFor(() => expect(clerk.create).toHaveBeenCalledOnce(), {
      timeout: 5_000,
    });
    releaseCreate?.();
    const results = await settled;

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(clerk.create).toHaveBeenCalledOnce();
    expect(clerk.keys.filter((key) => !key.revoked)).toHaveLength(1);
    const rows = await owner.query(api.keySettings.getForOrg, {});
    expect(rows).toEqual([
      expect.objectContaining({
        keyId: "key_created_1",
        managed: true,
        disabled: false,
      }),
    ]);
    expect(clerk.create.mock.calls[0]![0].claims).toMatchObject({
      org_id: "org_acme",
      zevium_operation_id: "create-concurrent-1",
      zevium_operation_kind: "create",
    });
  });

  it("compensates a provider key if membership disappears during creation", async () => {
    const t = convexTest(schema, modules);
    await seedOrganization(t);
    clerk.membership
      .mockResolvedValueOnce(membership())
      .mockResolvedValueOnce(membership())
      .mockResolvedValueOnce({ data: [], totalCount: 0 });

    await expect(
      asOwner(t).action(api.keyBroker.createManagedKey, {
        operationId: "create-membership-race",
        name: "Race",
      }),
    ).rejects.toThrow("authorization changed");

    expect(clerk.create).toHaveBeenCalledOnce();
    expect(clerk.revoke).toHaveBeenCalledOnce();
    expect(clerk.keys).toEqual([
      expect.objectContaining({ id: "key_created_1", revoked: true }),
    ]);
    expect(await asOwner(t).query(api.keySettings.getForOrg, {})).toEqual([]);
  });

  it("fences create completion if deletion lands after final provider check", async () => {
    const t = convexTest(schema, modules);
    await seedOrganization(t);
    clerk.membership
      .mockResolvedValueOnce(membership())
      .mockResolvedValueOnce(membership())
      .mockImplementationOnce(async () => {
        await t.mutation(internal.keySettings.revokeMembershipVerified, {
          clerkOrgId: "org_acme",
          userId: "user_owner",
          svixId: "membership-between-create-check-and-complete",
        });
        return membership();
      });

    await expect(
      asOwner(t).action(api.keyBroker.createManagedKey, {
        operationId: "create-membership-completion-fence",
        name: "Completion fence",
      }),
    ).rejects.toThrow();

    expect(clerk.create).toHaveBeenCalledOnce();
    expect(clerk.keys).toEqual([
      expect.objectContaining({ id: "key_created_1", revoked: true }),
    ]);
    expect(await asOwner(t).query(api.keySettings.getForOrg, {})).toEqual([]);
    const state = await t.run(async (ctx) =>
      ctx.db
        .query("clerkMembershipStates")
        .withIndex("by_membership", (q) =>
          q.eq("clerkOrgId", "org_acme").eq("userId", "user_owner"),
        )
        .unique(),
    );
    expect(state).toMatchObject({ status: "revoked", revision: 1 });
  });

  it("reconciles a live provider orphan after compensation revoke fails", async () => {
    const t = convexTest(schema, modules);
    await seedOrganization(t);
    const workingRevoke = clerk.revoke.getMockImplementation();
    clerk.membership
      .mockResolvedValueOnce(membership())
      .mockResolvedValueOnce(membership())
      .mockResolvedValueOnce({ data: [], totalCount: 0 });
    clerk.revoke.mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(
      asOwner(t).action(api.keyBroker.createManagedKey, {
        operationId: "create-orphan-reconcile",
        name: "Orphan fence",
      }),
    ).rejects.toThrow("cleanup is still in progress");
    expect(clerk.keys[0]).toMatchObject({ revoked: false });

    const operation = await t.run(async (ctx) =>
      ctx.db
        .query("keyLifecycleOperations")
        .withIndex("by_operation", (q) =>
          q
            .eq("clerkOrgId", "org_acme")
            .eq("userId", "user_owner")
            .eq("operationId", "create-orphan-reconcile"),
        )
        .unique(),
    );
    if (operation?.leaseToken === undefined) {
      throw new Error("Missing failed create fence");
    }
    clerk.revoke.mockImplementation(workingRevoke!);
    await t.action(internal.keyBroker.reconcileCreateOperation, {
      clerkOrgId: "org_acme",
      userId: "user_owner",
      operationId: operation.operationId,
      leaseToken: operation.leaseToken,
    });

    expect(clerk.keys[0]).toMatchObject({ revoked: true });
    const reconciled = await t.run(async (ctx) => ctx.db.get(operation._id));
    expect(reconciled).toMatchObject({
      status: "failed",
      orphanReconciledAt: expect.any(Number),
    });
  });

  it("recovers an expired reserved saga when its original scheduler message is lost", async () => {
    let now = 1_800_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const t = convexTest(schema, modules);
      await seedOrganization(t);
      const operationId = "create-lost-expiry-message";
      const leaseToken = "create-lost-expiry-lease";
      await t.mutation(internal.keySettings.beginCreateVerified, {
        clerkOrgId: "org_acme",
        userId: "user_owner",
        operationId,
        requestedName: "Lost scheduler",
        membershipVerifiedAt: now,
        leaseToken,
      });
      clerk.keys.push(
        fakeKey("key_lost_scheduler_orphan", {
          claims: {
            org_id: "org_acme",
            zevium_operation_id: operationId,
            zevium_lease_token: leaseToken,
            zevium_operation_kind: "create",
          },
        }),
      );
      now += 5 * 60_000 + 1;

      await expect(
        t.mutation(internal.keySettings.resumeStaleSagaCleanup, {}),
      ).resolves.toEqual({ scheduled: 1 });
      await vi.waitFor(() =>
        expect(clerk.keys[0]).toMatchObject({ revoked: true }),
      );
      await t.finishInProgressScheduledFunctions();
      const operation = await t.run(async (ctx) =>
        ctx.db
          .query("keyLifecycleOperations")
          .withIndex("by_operation", (q) =>
            q
              .eq("clerkOrgId", "org_acme")
              .eq("userId", "user_owner")
              .eq("operationId", operationId),
          )
          .unique(),
      );
      expect(operation).toMatchObject({
        status: "failed",
        orphanReconciledAt: expect.any(Number),
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps old rotation authority closed when membership disappears", async () => {
    const t = convexTest(schema, modules);
    await seedOrganization(t);
    const workingRevoke = clerk.revoke.getMockImplementation();
    const old = fakeKey("key_membership_rotation_old", { name: "Old" });
    clerk.keys.push(old);
    await t.run(async (ctx) => {
      await ctx.db.insert("keySettings", {
        clerkOrgId: "org_acme",
        ownerUserId: "user_owner",
        keyId: old.id,
        managed: true,
        familyId: old.id,
        disabled: false,
        updatedAt: Date.now(),
      });
    });
    clerk.membership
      .mockResolvedValueOnce(membership())
      .mockResolvedValueOnce(membership())
      .mockResolvedValueOnce({ data: [], totalCount: 0 });
    clerk.revoke.mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(
      asOwner(t).action(api.keyBroker.rotateManagedKey, {
        operationId: "rotation-membership-race",
        oldKeyId: old.id,
        name: "Replacement",
      }),
    ).rejects.toThrow("cleanup is still in progress");

    const rows = await asOwner(t).query(api.keySettings.getForOrg, {});
    expect(rows).toEqual([
      expect.objectContaining({
        keyId: old.id,
        disabled: true,
      }),
    ]);
    const storedOld = await t.run(async (ctx) =>
      ctx.db
        .query("keySettings")
        .withIndex("by_key", (q) => q.eq("keyId", old.id))
        .unique(),
    );
    expect(storedOld?.membershipRevokedAt).toEqual(expect.any(Number));
    expect(clerk.keys.find((key) => key.id === "key_created_1")).toMatchObject({
      revoked: false,
    });

    const operation = await t.run(async (ctx) =>
      ctx.db
        .query("keyRotationOperations")
        .withIndex("by_operation", (q) =>
          q
            .eq("clerkOrgId", "org_acme")
            .eq("userId", "user_owner")
            .eq("operationId", "rotation-membership-race"),
        )
        .unique(),
    );
    if (operation?.leaseToken === undefined) {
      throw new Error("Missing failed rotation fence");
    }
    clerk.revoke.mockImplementation(workingRevoke!);
    await t.action(internal.keyBroker.reconcileRotationOperation, {
      clerkOrgId: "org_acme",
      userId: "user_owner",
      operationId: operation.operationId,
      leaseToken: operation.leaseToken,
    });
    expect(clerk.keys.find((key) => key.id === "key_created_1")).toMatchObject({
      revoked: true,
    });

    await t.action(internal.keyBroker.revokeMembershipKeys, {
      clerkOrgId: "org_acme",
      userId: "user_owner",
    });
    expect(clerk.keys.every((key) => key.revoked)).toBe(true);
  });

  it("fences rotation completion if deletion lands after final provider check", async () => {
    const t = convexTest(schema, modules);
    await seedOrganization(t);
    const old = fakeKey("key_rotation_completion_fence", { name: "Old" });
    clerk.keys.push(old);
    await t.run(async (ctx) => {
      await ctx.db.insert("keySettings", {
        clerkOrgId: "org_acme",
        ownerUserId: "user_owner",
        keyId: old.id,
        managed: true,
        familyId: old.id,
        disabled: false,
        updatedAt: Date.now(),
      });
    });
    clerk.membership
      .mockResolvedValueOnce(membership())
      .mockResolvedValueOnce(membership())
      .mockImplementationOnce(async () => {
        await t.mutation(internal.keySettings.revokeMembershipVerified, {
          clerkOrgId: "org_acme",
          userId: "user_owner",
          svixId: "membership-between-rotation-check-and-complete",
        });
        return membership();
      });

    await expect(
      asOwner(t).action(api.keyBroker.rotateManagedKey, {
        operationId: "rotation-membership-completion-fence",
        oldKeyId: old.id,
        name: "Replacement",
      }),
    ).rejects.toThrow();

    const rows = await asOwner(t).query(api.keySettings.getForOrg, {});
    expect(rows).toEqual([
      expect.objectContaining({ keyId: old.id, disabled: true }),
    ]);
    expect(clerk.keys.find((key) => key.id === "key_created_1")).toMatchObject({
      revoked: true,
    });
  });

  it("inherits family cap through concurrent rotation and updates it family-wide", async () => {
    const t = convexTest(schema, modules);
    await seedOrganization(t);
    const owner = asOwner(t);
    const old = fakeKey("key_rotation_old", { name: "Old" });
    clerk.keys.push(old);
    await t.run(async (ctx) => {
      await ctx.db.insert("keySettings", {
        clerkOrgId: "org_acme",
        ownerUserId: "user_owner",
        keyId: old.id,
        managed: true,
        familyId: "family-stable",
        monthlyCapCredits: 75,
        disabled: false,
        updatedAt: Date.now(),
      });
    });
    const startedAt = Date.now();
    const results = await Promise.allSettled([
      owner.action(api.keyBroker.rotateManagedKey, {
        operationId: "rotation-concurrent-1",
        oldKeyId: old.id,
        name: "Replacement",
      }),
      owner.action(api.keyBroker.rotateManagedKey, {
        operationId: "rotation-concurrent-1",
        oldKeyId: old.id,
        name: "Replacement",
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(clerk.create).toHaveBeenCalledOnce();
    const rows = await owner.query(api.keySettings.getForOrg, {});
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.familyId))).toEqual(
      new Set(["family-stable"]),
    );
    expect(rows.every((row) => row.monthlyCapCredits === 75)).toBe(true);
    const oldRow = rows.find((row) => row.keyId === old.id);
    expect(oldRow?.graceUntil).toBeGreaterThanOrEqual(
      startedAt + 24 * 60 * 60_000,
    );

    await owner.action(api.keyBroker.setCap, {
      keyId: "key_created_1",
      monthlyCapCredits: 90,
    });
    const updated = await owner.query(api.keySettings.getForOrg, {});
    expect(updated.every((row) => row.monthlyCapCredits === 90)).toBe(true);

    await t.run(async (ctx) => {
      const operation = await ctx.db
        .query("keyRotationOperations")
        .withIndex("by_operation", (q) =>
          q
            .eq("clerkOrgId", "org_acme")
            .eq("userId", "user_owner")
            .eq("operationId", "rotation-concurrent-1"),
        )
        .unique();
      if (operation === null) throw new Error("Missing rotation");
      await ctx.db.patch(operation._id, { graceUntil: 0 });
    });
    await expect(
      t.mutation(internal.keySettings.resumeDueAutoRevokes, {}),
    ).resolves.toEqual({ scheduled: 1 });
    await vi.waitFor(() =>
      expect(clerk.revoke).toHaveBeenCalledWith(
        expect.objectContaining({ apiKeyId: old.id }),
      ),
    );
    await t.finishInProgressScheduledFunctions();
    const revoked = await owner.query(api.keySettings.getForOrg, {});
    expect(revoked.find((row) => row.keyId === old.id)?.disabled).toBe(true);
  });

  it("paginates bounded provider listings without per-key fresh reads", async () => {
    const t = convexTest(schema, modules);
    await seedOrganization(t);
    clerk.keys = Array.from({ length: 501 }, (_, index) =>
      fakeKey(`key_page_${String(index).padStart(4, "0")}`, {
        claims: { org_id: index === 500 ? "org_acme" : "org_other" },
      }),
    );

    const rows = await asOwner(t).action(api.keyBroker.listOwnedKeys, {});

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("key_page_0500");
    expect(clerk.membership).toHaveBeenCalledOnce();
    expect(clerk.list).toHaveBeenCalledTimes(4);
    expect(clerk.get).not.toHaveBeenCalled();
    await expect(
      asOwner(t).query(api.keySettings.getForOrg, {}),
    ).resolves.toEqual([
      expect.objectContaining({
        keyId: "key_page_0500",
        managed: false,
        disabled: true,
      }),
    ]);
  });

  it("rejects provider counts beyond the enforced pagination bound", async () => {
    const t = convexTest(schema, modules);
    await seedOrganization(t);
    clerk.list.mockResolvedValue({ data: [], totalCount: 2_001 });
    await expect(
      asOwner(t).action(api.keyBroker.listOwnedKeys, {}),
    ).rejects.toThrow("count exceeds the supported limit");
    expect(clerk.list).toHaveBeenCalledOnce();
    expect(clerk.get).not.toHaveBeenCalled();
  });

  it("fails closed when provider pagination changes between pages", async () => {
    const t = convexTest(schema, modules);
    await seedOrganization(t);
    const firstPage = Array.from({ length: 500 }, (_, index) =>
      fakeKey(`key_unstable_${String(index).padStart(4, "0")}`, {
        claims: { org_id: "org_other" },
      }),
    );
    clerk.list
      .mockResolvedValueOnce({ data: firstPage, totalCount: 501 })
      .mockResolvedValueOnce({ data: [], totalCount: 502 });

    await expect(
      asOwner(t).action(api.keyBroker.listOwnedKeys, {}),
    ).rejects.toThrow("changed while it was being read");
    expect(clerk.list).toHaveBeenCalledTimes(2);
    expect(clerk.get).not.toHaveBeenCalled();
  });

  it("fails closed when shifting pages repeat a provider key", async () => {
    const t = convexTest(schema, modules);
    await seedOrganization(t);
    const firstPage = Array.from({ length: 500 }, (_, index) =>
      fakeKey(`key_shift_${String(index).padStart(4, "0")}`, {
        claims: { org_id: "org_other" },
      }),
    );
    clerk.list
      .mockResolvedValueOnce({ data: firstPage, totalCount: 501 })
      .mockResolvedValueOnce({ data: [firstPage[499]!], totalCount: 501 });

    await expect(
      asOwner(t).action(api.keyBroker.listOwnedKeys, {}),
    ).rejects.toThrow("changed while it was being read");
    expect(clerk.list).toHaveBeenCalledTimes(2);
    expect(clerk.get).not.toHaveBeenCalled();
  });

  it("rejects same-count provider churn between two complete snapshots", async () => {
    const t = convexTest(schema, modules);
    await seedOrganization(t);
    const stable = Array.from({ length: 501 }, (_, index) =>
      fakeKey(`key_churn_${String(index).padStart(4, "0")}`, {
        claims: { org_id: "org_other" },
      }),
    );
    const hiddenScoped = fakeKey("key_hidden_scoped", {
      claims: { org_id: "org_acme" },
    });
    clerk.list
      .mockResolvedValueOnce({ data: stable.slice(0, 500), totalCount: 501 })
      .mockResolvedValueOnce({ data: stable.slice(500), totalCount: 501 })
      .mockResolvedValueOnce({
        data: [hiddenScoped, ...stable.slice(1, 500)],
        totalCount: 501,
      })
      .mockResolvedValueOnce({ data: stable.slice(500), totalCount: 501 });

    await expect(
      asOwner(t).action(api.keyBroker.createManagedKey, {
        operationId: "same-count-churn",
        name: "Must not mint",
      }),
    ).rejects.toThrow("changed while it was being read");
    expect(clerk.list).toHaveBeenCalledTimes(4);
    expect(clerk.create).not.toHaveBeenCalled();
  });

  it("compensates create when post-create provider set contains another scoped key", async () => {
    const t = convexTest(schema, modules);
    await seedOrganization(t);
    const hidden = fakeKey("key_hidden_after_create");
    clerk.list
      .mockResolvedValueOnce({ data: [], totalCount: 0 })
      .mockImplementationOnce(async () => ({
        data: [clerk.keys[0]!, hidden],
        totalCount: 2,
      }));

    await expect(
      asOwner(t).action(api.keyBroker.createManagedKey, {
        operationId: "post-create-compensation",
        name: "Compensate",
      }),
    ).rejects.toThrow("New key was revoked");
    expect(clerk.create).toHaveBeenCalledOnce();
    expect(clerk.revoke).toHaveBeenCalledWith({
      apiKeyId: "key_created_1",
      revocationReason: "Provider key set changed during creation",
    });
    expect(clerk.keys[0]).toMatchObject({ revoked: true });
  });

  it("compensates rotation when post-create provider set is unexpected", async () => {
    const t = convexTest(schema, modules);
    await seedOrganization(t);
    const old = fakeKey("key_rotation_old", { name: "Old" });
    const hidden = fakeKey("key_hidden_after_rotation");
    clerk.keys.push(old);
    await t.run(async (ctx) => {
      await ctx.db.insert("keySettings", {
        clerkOrgId: "org_acme",
        ownerUserId: "user_owner",
        keyId: old.id,
        managed: true,
        familyId: old.id,
        disabled: false,
        updatedAt: 1,
      });
    });
    clerk.list
      .mockResolvedValueOnce({ data: [old], totalCount: 1 })
      .mockImplementationOnce(async () => ({
        data: [old, clerk.keys[1]!, hidden],
        totalCount: 3,
      }));

    await expect(
      asOwner(t).action(api.keyBroker.rotateManagedKey, {
        operationId: "post-rotation-compensation",
        oldKeyId: old.id,
        name: "Replacement",
      }),
    ).rejects.toThrow("Replacement was revoked");
    expect(clerk.revoke).toHaveBeenCalledWith({
      apiKeyId: "key_created_1",
      revocationReason: "Provider key set changed during rotation",
    });
    expect(clerk.keys.find((key) => key.id === old.id)?.revoked).toBe(false);
    expect(
      clerk.keys.find((key) => key.id === "key_created_1")?.revoked,
    ).toBe(true);
  });

  it("keeps membership cleanup durable past five failures and duplicate receipt", async () => {
    const t = convexTest(schema, modules);
    await seedOrganization(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("clerkWebhookReceipts", {
        svixId: "membership-cleanup-replay",
        eventType: "organizationMembership.deleted",
        receivedAt: 1,
      });
      await ctx.db.insert("clerkMembershipStates", {
        clerkOrgId: "org_acme",
        userId: "user_owner",
        status: "revoked",
        revision: 9,
        updatedAt: 1,
      });
      await ctx.db.insert("membershipCleanupJobs", {
        clerkOrgId: "org_acme",
        userId: "user_owner",
        membershipRevision: 9,
        status: "pending",
        attempts: 0,
        zeroVerificationPasses: 0,
        nextRunAt: 0,
        createdAt: 1,
        updatedAt: 1,
      });
    });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const leaseToken = `membership-cleanup-lease-${attempt}`;
      await expect(
        t.mutation(internal.keySettings.claimMembershipCleanup, {
          clerkOrgId: "org_acme",
          userId: "user_owner",
          leaseToken,
        }),
      ).resolves.toMatchObject({ membershipRevision: 9 });
      await t.mutation(internal.keySettings.retryMembershipCleanup, {
        clerkOrgId: "org_acme",
        userId: "user_owner",
        membershipRevision: 9,
        leaseToken,
        errorCode: "provider_unavailable",
      });
    }
    let job = await t.run(async (ctx) =>
      ctx.db
        .query("membershipCleanupJobs")
        .withIndex("by_membership", (q) =>
          q.eq("clerkOrgId", "org_acme").eq("userId", "user_owner"),
        )
        .unique(),
    );
    expect(job).toMatchObject({
      status: "pending",
      attempts: 8,
      lastErrorCode: "provider_unavailable",
    });
    expect(job?.completedAt).toBeUndefined();

    await expect(
      t.mutation(internal.keySettings.revokeMembershipVerified, {
        clerkOrgId: "org_acme",
        userId: "user_owner",
        svixId: "membership-cleanup-replay",
      }),
    ).resolves.toEqual({ duplicate: true, keyIds: [] });
    job = await t.run(async (ctx) =>
      ctx.db
        .query("membershipCleanupJobs")
        .withIndex("by_membership", (q) =>
          q.eq("clerkOrgId", "org_acme").eq("userId", "user_owner"),
        )
        .unique(),
    );
    expect(job).toMatchObject({ status: "pending", nextRunAt: expect.any(Number) });
    expect(job?.leaseToken).toBeUndefined();
  });

  it("completes membership cleanup only after provider relist proves zero twice", async () => {
    const t = convexTest(schema, modules);
    await seedOrganization(t);
    const live = fakeKey("key_membership_cleanup_live");
    clerk.keys.push(live);
    await t.run(async (ctx) => {
      await ctx.db.insert("clerkMembershipStates", {
        clerkOrgId: "org_acme",
        userId: "user_owner",
        status: "revoked",
        revision: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("membershipCleanupJobs", {
        clerkOrgId: "org_acme",
        userId: "user_owner",
        membershipRevision: 1,
        status: "pending",
        attempts: 0,
        zeroVerificationPasses: 0,
        nextRunAt: 0,
        createdAt: 1,
        updatedAt: 1,
      });
    });

    await t.action(internal.keyBroker.revokeMembershipKeys, {
      clerkOrgId: "org_acme",
      userId: "user_owner",
    });
    expect(clerk.keys[0]).toMatchObject({ revoked: true });
    await t.action(internal.keyBroker.revokeMembershipKeys, {
      clerkOrgId: "org_acme",
      userId: "user_owner",
    });
    let job = await t.run(async (ctx) =>
      ctx.db
        .query("membershipCleanupJobs")
        .withIndex("by_membership", (q) =>
          q.eq("clerkOrgId", "org_acme").eq("userId", "user_owner"),
        )
        .unique(),
    );
    expect(job).toMatchObject({
      status: "pending",
      zeroVerificationPasses: 1,
    });
    await t.action(internal.keyBroker.revokeMembershipKeys, {
      clerkOrgId: "org_acme",
      userId: "user_owner",
    });
    job = await t.run(async (ctx) =>
      ctx.db
        .query("membershipCleanupJobs")
        .withIndex("by_membership", (q) =>
          q.eq("clerkOrgId", "org_acme").eq("userId", "user_owner"),
        )
        .unique(),
    );
    expect(job).toMatchObject({
      status: "completed",
      zeroVerificationPasses: 2,
      completedAt: expect.any(Number),
    });
  });

  it("durably pages past 1,000 unrelated keys before revoking malformed tail", async () => {
    const t = convexTest(schema, modules);
    await seedOrganization(t);
    clerk.keys.push(
      ...Array.from({ length: 1_000 }, (_, index) =>
        fakeKey(`key_other_${String(index).padStart(4, "0")}`, {
          claims: { org_id: "org_other" },
        }),
      ),
      fakeKey("key_membership_cleanup_tail"),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("clerkMembershipStates", {
        clerkOrgId: "org_acme",
        userId: "user_owner",
        status: "revoked",
        revision: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("membershipCleanupJobs", {
        clerkOrgId: "org_acme",
        userId: "user_owner",
        membershipRevision: 1,
        status: "pending",
        attempts: 0,
        zeroVerificationPasses: 0,
        cursorOffset: 0,
        nextRunAt: 0,
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const run = async () =>
      await t.action(internal.keyBroker.revokeMembershipKeys, {
        clerkOrgId: "org_acme",
        userId: "user_owner",
      });
    const job = async () =>
      await t.run(async (ctx) =>
        ctx.db
          .query("membershipCleanupJobs")
          .withIndex("by_membership", (q) =>
            q.eq("clerkOrgId", "org_acme").eq("userId", "user_owner"),
          )
          .unique(),
      );

    await run();
    expect(await job()).toMatchObject({ status: "pending", cursorOffset: 500 });
    await run();
    expect(await job()).toMatchObject({
      status: "pending",
      cursorOffset: 1_000,
    });
    expect(clerk.keys.at(-1)).toMatchObject({ revoked: false });

    await run();
    expect(clerk.keys.at(-1)).toMatchObject({ revoked: true });
    expect(await job()).toMatchObject({
      status: "pending",
      cursorOffset: 0,
      zeroVerificationPasses: 0,
    });

    for (let pass = 0; pass < 4; pass += 1) await run();
    expect(await job()).toMatchObject({
      status: "completed",
      attempts: 7,
      cursorOffset: 0,
      zeroVerificationPasses: 2,
      completedAt: expect.any(Number),
    });
  });

  it("reclaims crashed membership cleanup lease without losing cursor", async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const t = convexTest(schema, modules);
    await seedOrganization(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("clerkMembershipStates", {
        clerkOrgId: "org_acme",
        userId: "user_owner",
        status: "revoked",
        revision: 4,
        updatedAt: now,
      });
      await ctx.db.insert("membershipCleanupJobs", {
        clerkOrgId: "org_acme",
        userId: "user_owner",
        membershipRevision: 4,
        status: "pending",
        attempts: 0,
        zeroVerificationPasses: 0,
        cursorOffset: 500,
        scanExpectedTotal: 600,
        scanProviderIds: Array.from(
          { length: 500 },
          (_, index) => `key_seen_${index}`,
        ),
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });
    await expect(
      t.mutation(internal.keySettings.claimMembershipCleanup, {
        clerkOrgId: "org_acme",
        userId: "user_owner",
        leaseToken: "membership-crashed-lease",
      }),
    ).resolves.toMatchObject({ cursorOffset: 500, scanExpectedTotal: 600 });

    now += 2 * 60_000 + 1;
    await expect(
      t.mutation(internal.keySettings.claimMembershipCleanup, {
        clerkOrgId: "org_acme",
        userId: "user_owner",
        leaseToken: "membership-recovered-lease",
      }),
    ).resolves.toMatchObject({ cursorOffset: 500, scanExpectedTotal: 600 });
    const stored = await t.run(async (ctx) =>
      ctx.db.query("membershipCleanupJobs").first(),
    );
    expect(stored).toMatchObject({
      status: "running",
      attempts: 2,
      leaseToken: "membership-recovered-lease",
      cursorOffset: 500,
    });
  });
});
