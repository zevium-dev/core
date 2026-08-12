/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { decryptSecret, encryptSecret } from "./lib/credentialCrypto";
import { computeSignature, postWebhook } from "./lib/webhookDelivery";
import { validateWebhookUrl } from "./webhooks";

const { pinnedTransportMock } = vi.hoisted(() => ({
  pinnedTransportMock: vi.fn(),
}));
vi.mock("./lib/webhookTransport", () => ({
  deliverPinnedHttps: pinnedTransportMock,
}));

const modules = import.meta.glob("./**/*.ts");
const TEST_KEYRING = JSON.stringify({
  current: "webhook-test-v1",
  keys: { "webhook-test-v1": "webhook-encryption-test-material" },
});
const previousEncryptionKeys = process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS;

beforeEach(() => {
  process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS = TEST_KEYRING;
});

afterEach(() => {
  if (previousEncryptionKeys === undefined) {
    delete process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS;
  } else {
    process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS = previousEncryptionKeys;
  }
});

// ---------------------------------------------------------------------------
// Pure unit tests — no Convex context needed
// ---------------------------------------------------------------------------

describe("validateWebhookUrl", () => {
  it("accepts https URLs", () => {
    expect(validateWebhookUrl("https://example.com/hook")).toBe(true);
    expect(validateWebhookUrl("https://api.zevium.dev/wh")).toBe(true);
  });

  it("rejects http, including localhost", () => {
    expect(validateWebhookUrl("http://localhost:3000/hook")).toBe(false);
    expect(validateWebhookUrl("http://localhost/hook")).toBe(false);
    expect(validateWebhookUrl("http://example.com/hook")).toBe(false);
    expect(validateWebhookUrl("http://192.168.1.1/hook")).toBe(false);
  });

  it("rejects private and local https targets", () => {
    expect(validateWebhookUrl("https://localhost/hook")).toBe(false);
    expect(validateWebhookUrl("https://127.0.0.1/hook")).toBe(false);
    expect(validateWebhookUrl("https://10.0.0.8/hook")).toBe(false);
    expect(validateWebhookUrl("https://169.254.169.254/hook")).toBe(false);
    expect(validateWebhookUrl("https://172.16.0.1/hook")).toBe(false);
    expect(validateWebhookUrl("https://192.168.1.1/hook")).toBe(false);
    expect(validateWebhookUrl("https://192.0.2.1/hook")).toBe(false);
    expect(validateWebhookUrl("https://2130706433/hook")).toBe(false);
    expect(validateWebhookUrl("https://0177.0.0.1/hook")).toBe(false);
    expect(validateWebhookUrl("https://0x7f000001/hook")).toBe(false);
    expect(validateWebhookUrl("https://[::1]/hook")).toBe(false);
    expect(validateWebhookUrl("https://[fd00::1]/hook")).toBe(false);
    expect(validateWebhookUrl("https://[fe80::1]/hook")).toBe(false);
    expect(validateWebhookUrl("https://[::ffff:127.0.0.1]/hook")).toBe(false);
    expect(validateWebhookUrl("https://[2001:db8::1]/hook")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(validateWebhookUrl("not-a-url")).toBe(false);
    expect(validateWebhookUrl("")).toBe(false);
    expect(validateWebhookUrl("ftp://example.com")).toBe(false);
  });
});

describe("computeSignature", () => {
  it("returns 64-char lowercase hex", async () => {
    const sig = await computeSignature("mysecret", "body123");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for same input", async () => {
    const a = await computeSignature("key", "msg");
    const b = await computeSignature("key", "msg");
    expect(a).toBe(b);
  });

  it("changes with different key or message", async () => {
    const a = await computeSignature("key1", "msg");
    const b = await computeSignature("key2", "msg");
    const c = await computeSignature("key1", "other");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("postWebhook — injectable transport", () => {
  it("POSTs with HMAC signature + event headers + JSON body", async () => {
    const transport = vi.fn(async () => ({ status: 200 }));

    const result = await postWebhook(
      {
        url: "https://example.com/hook",
        secret: "s3cr3t",
        event: "spec.published",
        data: { projectId: "p1", version: "1.0.0" },
        timestamp: 123,
      },
      transport,
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    const input = transport.mock.calls[0]![0];
    expect(input.url.toString()).toBe("https://example.com/hook");
    const headers = input.headers;
    expect(headers["x-zevium-event"]).toBe("spec.published");
    expect(headers["x-zevium-signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(input.body);
    expect(body).toEqual({
      event: "spec.published",
      data: { projectId: "p1", version: "1.0.0" },
      timestamp: 123,
    });

    // Signature matches independent computation over the body
    const expectedSig = await computeSignature("s3cr3t", input.body);
    expect(headers["x-zevium-signature"]).toBe(expectedSig);
  });

  it("returns ok:false with error for non-2xx", async () => {
    const transport = vi.fn(async () => ({ status: 500 }));

    const result = await postWebhook(
      {
        url: "https://example.com/hook",
        secret: "s",
        event: "x",
        data: {},
        timestamp: 0,
      },
      transport,
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toBe("HTTP 500");
  });

  it("sanitizes network errors", async () => {
    const transport = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    const result = await postWebhook(
      {
        url: "https://example.com/hook",
        secret: "s",
        event: "x",
        data: {},
        timestamp: 0,
      },
      transport,
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toBe("Delivery failed");
    expect(result.error).not.toContain("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// Convex-test: endpoint CRUD + auth
// ---------------------------------------------------------------------------

type Seeded = {
  orgId: Id<"organizations">;
  projectId: Id<"projects">;
};

async function seedWorld(t: ReturnType<typeof convexTest>): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_pub",
      name: "Pub Co",
      slug: "pub-co",
    });
    await ctx.db.insert("organizations", {
      clerkOrgId: "org_stranger",
      name: "Stranger Co",
      slug: "stranger-co",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "My API",
      slug: "my-api",
      status: "published",
      visibility: "public",
      tags: [],
    });
    return { orgId, projectId };
  });
}

function asPublisher(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "user_pub",
    org_id: "org_pub",
    org_slug: "pub-co",
    org_role: "org:admin",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

function asStranger(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "user_stranger",
    org_id: "org_stranger",
    org_slug: "stranger-co",
    org_role: "org:member",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

function asMember(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "user_member",
    org_id: "org_pub",
    org_slug: "pub-co",
    org_role: "org:member",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

describe("webhooks.upsertEndpoint — CRUD + auth", () => {
  it("masks existing projects from cross-org callers", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    await expect(
      asStranger(t).mutation(api.webhooks.upsertEndpoint, {
        projectId: seed.projectId,
        url: "https://example.com/hook",
      }),
    ).rejects.toThrow(/Project not found/);
    expect(
      await t.run(async (ctx) => ctx.db.query("webhookEndpoints").collect()),
    ).toEqual([]);
  });

  it("rejects same-org members before creating an endpoint", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);

    await expect(
      asMember(t).mutation(api.webhooks.upsertEndpoint, {
        projectId: seed.projectId,
        url: "https://example.com/hook",
      }),
    ).rejects.toThrow(/Org admin role required/);

    expect(
      await t.run(async (ctx) => ctx.db.query("webhookEndpoints").collect()),
    ).toEqual([]);
  });

  it("rejects unauthenticated", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    await expect(
      t.mutation(api.webhooks.upsertEndpoint, {
        projectId: seed.projectId,
        url: "https://example.com/hook",
      }),
    ).rejects.toThrow(/Not authenticated/);
  });

  it("rejects non-https URL (non-localhost)", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    await expect(
      asPublisher(t).mutation(api.webhooks.upsertEndpoint, {
        projectId: seed.projectId,
        url: "http://example.com/hook",
      }),
    ).rejects.toThrow(/https/);
  });

  it("creates an encrypted endpoint and returns metadata only", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);

    const ep = await asPublisher(t).mutation(api.webhooks.upsertEndpoint, {
      projectId: seed.projectId,
      url: "https://example.com/hook",
    });

    expect(ep.url).toBe("https://example.com/hook");
    expect(ep.active).toBe(true);
    expect(ep).not.toHaveProperty("secret");
    expect(ep).not.toHaveProperty("ciphertext");
    expect(ep).not.toHaveProperty("iv");
    expect(ep).not.toHaveProperty("keyVersion");

    const stored = await t.run(async (ctx) => ctx.db.get(ep.id));
    expect(stored?.secret).toBeUndefined();
    expect(stored?.ciphertext).toBeTruthy();
    expect(stored?.ciphertext).not.toContain("webhook-test");
    expect(stored?.iv).toBeTruthy();
    expect(stored?.keyVersion).toBe("webhook-test-v1");
  });

  it("upsert preserves encrypted secret on update and changes metadata", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const as = asPublisher(t);

    const ep1 = await as.mutation(api.webhooks.upsertEndpoint, {
      projectId: seed.projectId,
      url: "https://example.com/old",
    });
    const storedBefore = await t.run(async (ctx) => ctx.db.get(ep1.id));

    const ep2 = await as.mutation(api.webhooks.upsertEndpoint, {
      projectId: seed.projectId,
      url: "https://example.com/new",
      active: false,
    });

    expect(ep2.url).toBe("https://example.com/new");
    expect(ep2.active).toBe(false);
    expect(ep2.id).toBe(ep1.id);

    const storedAfter = await t.run(async (ctx) => ctx.db.get(ep2.id));
    expect(storedAfter?.ciphertext).toBe(storedBefore?.ciphertext);
    expect(storedAfter?.iv).toBe(storedBefore?.iv);
    expect(storedAfter?.keyVersion).toBe(storedBefore?.keyVersion);
    expect(storedAfter?.secret).toBeUndefined();
  });

  it("fails closed without encryption keys and creates no row", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    delete process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS;

    await expect(
      asPublisher(t).mutation(api.webhooks.upsertEndpoint, {
        projectId: seed.projectId,
        url: "https://example.com/hook",
      }),
    ).rejects.toThrow("Signing secret could not be created");

    expect(
      await t.run(async (ctx) => ctx.db.query("webhookEndpoints").collect()),
    ).toEqual([]);
  });
});

describe("webhooks.getEndpoint", () => {
  it("returns endpoint for admins, null when none", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const as = asPublisher(t);

    const none = await as.query(api.webhooks.getEndpoint, {
      projectId: seed.projectId,
    });
    expect(none).toBeNull();

    await as.mutation(api.webhooks.upsertEndpoint, {
      projectId: seed.projectId,
      url: "https://example.com/hook",
    });

    const ep = await as.query(api.webhooks.getEndpoint, {
      projectId: seed.projectId,
    });
    expect(ep?.url).toBe("https://example.com/hook");
    expect(ep).not.toHaveProperty("secret");
    expect(ep).not.toHaveProperty("ciphertext");
    expect(ep).not.toHaveProperty("iv");
    expect(ep).not.toHaveProperty("keyVersion");
  });

  it("never reveals signing secrets to same-org members", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    await asPublisher(t).mutation(api.webhooks.upsertEndpoint, {
      projectId: seed.projectId,
      url: "https://example.com/hook",
    });

    await expect(
      asMember(t).query(api.webhooks.getEndpoint, {
        projectId: seed.projectId,
      }),
    ).rejects.toThrow(/Org admin role required/);
  });

  it("masks existing endpoints from cross-org callers", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    await expect(
      asStranger(t).query(api.webhooks.getEndpoint, {
        projectId: seed.projectId,
      }),
    ).rejects.toThrow(/Project not found/);
  });
});

describe("webhooks.revealSecret", () => {
  it("reveals a new encrypted row only to its org admin", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const admin = asPublisher(t);
    const created = await admin.mutation(api.webhooks.upsertEndpoint, {
      projectId: seed.projectId,
      url: "https://example.com/hook",
    });

    const result = await admin.mutation(api.webhooks.revealSecret, {
      projectId: seed.projectId,
    });
    expect(result?.secret.length).toBeGreaterThan(20);

    const stored = await t.run(async (ctx) => ctx.db.get(created.id));
    expect(stored?.secret).toBeUndefined();
    expect(
      await decryptSecret({
        ciphertext: stored!.ciphertext!,
        iv: stored!.iv!,
        keyVersion: stored!.keyVersion!,
      }),
    ).toBe(result?.secret);
  });

  it("rejects members and cross-org callers without changing the row", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const created = await asPublisher(t).mutation(api.webhooks.upsertEndpoint, {
      projectId: seed.projectId,
      url: "https://example.com/hook",
    });
    const before = await t.run(async (ctx) => ctx.db.get(created.id));

    await expect(
      asMember(t).mutation(api.webhooks.revealSecret, {
        projectId: seed.projectId,
      }),
    ).rejects.toThrow(/Org admin role required/);
    await expect(
      asStranger(t).mutation(api.webhooks.revealSecret, {
        projectId: seed.projectId,
      }),
    ).rejects.toThrow(/Project not found/);

    expect(await t.run(async (ctx) => ctx.db.get(created.id))).toEqual(before);
  });

  it("maps legacy, missing-key, and corrupt-ciphertext failures safely", async () => {
    const legacyTest = convexTest(schema, modules);
    const legacySeed = await seedWorld(legacyTest);
    await legacyTest.run(async (ctx) => {
      await ctx.db.insert("webhookEndpoints", {
        projectId: legacySeed.projectId,
        url: "https://example.com/legacy",
        secret: "plaintext-must-not-leak",
        active: true,
        createdAt: 1,
      });
    });
    await expect(
      asPublisher(legacyTest).mutation(api.webhooks.revealSecret, {
        projectId: legacySeed.projectId,
      }),
    ).rejects.toThrow("Signing secret is unavailable");

    const missingKeyTest = convexTest(schema, modules);
    const missingKeySeed = await seedWorld(missingKeyTest);
    await asPublisher(missingKeyTest).mutation(api.webhooks.upsertEndpoint, {
      projectId: missingKeySeed.projectId,
      url: "https://example.com/missing-key",
    });
    delete process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS;
    await expect(
      asPublisher(missingKeyTest).mutation(api.webhooks.revealSecret, {
        projectId: missingKeySeed.projectId,
      }),
    ).rejects.toThrow("Signing secret is unavailable");

    process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS = TEST_KEYRING;
    const corruptTest = convexTest(schema, modules);
    const corruptSeed = await seedWorld(corruptTest);
    await corruptTest.run(async (ctx) => {
      await ctx.db.insert("webhookEndpoints", {
        projectId: corruptSeed.projectId,
        url: "https://example.com/corrupt",
        ciphertext: "not-ciphertext",
        iv: "not-an-iv",
        keyVersion: "webhook-test-v1",
        active: true,
        createdAt: 1,
      });
    });
    await expect(
      asPublisher(corruptTest).mutation(api.webhooks.revealSecret, {
        projectId: corruptSeed.projectId,
      }),
    ).rejects.toThrow("Signing secret is unavailable");
  });
});

describe("webhooks.migrateLegacyPlaintext", () => {
  it("encrypts legacy rows, scrubs hybrid plaintext, and reports idempotent counts", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const alreadyEncrypted = await encryptSecret("already-encrypted");
    const hybridEncrypted = await encryptSecret("hybrid-encrypted-value");
    const ids = await t.run(async (ctx) => ({
      legacy: await ctx.db.insert("webhookEndpoints", {
        projectId: seed.projectId,
        url: "https://example.com/legacy",
        secret: "legacy-plaintext",
        active: true,
        createdAt: 1,
      }),
      hybrid: await ctx.db.insert("webhookEndpoints", {
        projectId: seed.projectId,
        url: "https://example.com/hybrid",
        ...hybridEncrypted,
        secret: "stale-plaintext-copy",
        active: true,
        createdAt: 2,
      }),
      encrypted: await ctx.db.insert("webhookEndpoints", {
        projectId: seed.projectId,
        url: "https://example.com/encrypted",
        ...alreadyEncrypted,
        active: true,
        createdAt: 3,
      }),
      broken: await ctx.db.insert("webhookEndpoints", {
        projectId: seed.projectId,
        url: "https://example.com/broken",
        active: false,
        createdAt: 4,
      }),
    }));

    expect(
      await t.mutation(internal.webhooks.migrateLegacyPlaintext, {}),
    ).toEqual({ migrated: 2, remaining: 1 });

    const rows = await t.run(async (ctx) => ({
      legacy: await ctx.db.get(ids.legacy),
      hybrid: await ctx.db.get(ids.hybrid),
      encrypted: await ctx.db.get(ids.encrypted),
      broken: await ctx.db.get(ids.broken),
    }));
    expect(rows.legacy?.secret).toBeUndefined();
    expect(
      await decryptSecret({
        ciphertext: rows.legacy!.ciphertext!,
        iv: rows.legacy!.iv!,
        keyVersion: rows.legacy!.keyVersion!,
      }),
    ).toBe("legacy-plaintext");
    expect(rows.hybrid?.secret).toBeUndefined();
    expect(rows.hybrid?.ciphertext).toBe(hybridEncrypted.ciphertext);
    expect(rows.encrypted?.ciphertext).toBe(alreadyEncrypted.ciphertext);
    expect(rows.broken?.ciphertext).toBeUndefined();

    expect(
      await t.mutation(internal.webhooks.migrateLegacyPlaintext, {}),
    ).toEqual({ migrated: 0, remaining: 1 });
  });

  it("rolls back every row when encryption keys are missing", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const ids = await t.run(async (ctx) => [
      await ctx.db.insert("webhookEndpoints", {
        projectId: seed.projectId,
        url: "https://example.com/one",
        secret: "first-plaintext",
        active: true,
        createdAt: 1,
      }),
      await ctx.db.insert("webhookEndpoints", {
        projectId: seed.projectId,
        url: "https://example.com/two",
        secret: "second-plaintext",
        active: true,
        createdAt: 2,
      }),
    ]);
    delete process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS;

    await expect(
      t.mutation(internal.webhooks.migrateLegacyPlaintext, {}),
    ).rejects.toThrow(/keyring/);

    const rows = await t.run(async (ctx) =>
      Promise.all(ids.map(async (id) => await ctx.db.get(id))),
    );
    expect(rows.map((row) => row?.secret)).toEqual([
      "first-plaintext",
      "second-plaintext",
    ]);
    expect(rows.every((row) => row?.ciphertext === undefined)).toBe(true);
  });
});

describe("webhooks.deleteEndpoint", () => {
  it("deletes endpoint for admins", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const as = asPublisher(t);

    await as.mutation(api.webhooks.upsertEndpoint, {
      projectId: seed.projectId,
      url: "https://example.com/hook",
    });

    const result = await as.mutation(api.webhooks.deleteEndpoint, {
      projectId: seed.projectId,
    });
    expect(result.deleted).toBe(true);

    const ep = await as.query(api.webhooks.getEndpoint, {
      projectId: seed.projectId,
    });
    expect(ep).toBeNull();
  });

  it("rejects same-org members without deleting endpoint", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const created = await asPublisher(t).mutation(api.webhooks.upsertEndpoint, {
      projectId: seed.projectId,
      url: "https://example.com/hook",
    });

    await expect(
      asMember(t).mutation(api.webhooks.deleteEndpoint, {
        projectId: seed.projectId,
      }),
    ).rejects.toThrow(/Org admin role required/);

    const stored = await t.run(async (ctx) => ctx.db.get(created.id));
    expect(stored).not.toBeNull();
    expect(stored?.ciphertext).toBeTruthy();
  });

  it("masks cross-org deletes without touching endpoint or deliveries", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const created = await asPublisher(t).mutation(api.webhooks.upsertEndpoint, {
      projectId: seed.projectId,
      url: "https://example.com/hook",
    });
    const deliveryId = await t.run(async (ctx) =>
      ctx.db.insert("webhookDeliveries", {
        endpointId: created.id,
        event: "spec.published",
        status: "pending",
        attempts: 0,
        createdAt: 1,
        payload: "{}",
      }),
    );
    const before = await t.run(async (ctx) => ({
      endpoint: await ctx.db.get(created.id),
      delivery: await ctx.db.get(deliveryId),
    }));

    await expect(
      asStranger(t).mutation(api.webhooks.deleteEndpoint, {
        projectId: seed.projectId,
      }),
    ).rejects.toThrow(/Project not found/);

    expect(
      await t.run(async (ctx) => ({
        endpoint: await ctx.db.get(created.id),
        delivery: await ctx.db.get(deliveryId),
      })),
    ).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Convex-test: delivery state machine
// ---------------------------------------------------------------------------

describe("recordDeliveryAttempt — state machine", () => {
  it("marks delivery ok on success", async () => {
    const t = convexTest(schema, modules);

    const { deliveryId } = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_wh",
        name: "WH Co",
        slug: "wh-co",
      });
      const projectId = await ctx.db.insert("projects", {
        organizationId: orgId,
        name: "API",
        slug: "api",
        status: "published",
        visibility: "public",
        tags: [],
      });
      const encryptedSecret = await encryptSecret("s3cr3t");
      const endpointId = await ctx.db.insert("webhookEndpoints", {
        projectId,
        url: "https://example.com/hook",
        ...encryptedSecret,
        active: true,
        createdAt: Date.now(),
      });
      const deliveryId = await ctx.db.insert("webhookDeliveries", {
        endpointId,
        event: "spec.published",
        status: "pending",
        attempts: 0,
        createdAt: Date.now(),
        payload: JSON.stringify({
          event: "spec.published",
          data: { projectId, version: "1.0.0" },
          timestamp: Date.now(),
        }),
      });
      return { deliveryId };
    });

    await t.run(async (ctx) => {
      await ctx.runMutation(internal.webhooks.recordDeliveryAttempt, {
        deliveryId,
        ok: true,
      });
      await ctx.runMutation(internal.webhooks.recordDeliveryAttempt, {
        deliveryId,
        ok: false,
        error: "late duplicate",
      });
    });

    const delivery = await t.run(async (ctx) => {
      return await ctx.db.get(deliveryId);
    });
    expect(delivery?.status).toBe("ok");
    expect(delivery?.attempts).toBe(1);
  });

  it("marks failed + creates notification on final attempt", async () => {
    const t = convexTest(schema, modules);

    const { deliveryId } = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_wh",
        name: "WH Co",
        slug: "wh-co",
      });
      const projectId = await ctx.db.insert("projects", {
        organizationId: orgId,
        name: "API",
        slug: "api",
        status: "published",
        visibility: "public",
        tags: [],
      });
      const encryptedSecret = await encryptSecret("s3cr3t");
      const endpointId = await ctx.db.insert("webhookEndpoints", {
        projectId,
        url: "https://example.com/hook",
        ...encryptedSecret,
        active: true,
        createdAt: Date.now(),
      });
      // Seed at attempts: 2 → next failure is 3rd = final
      const deliveryId = await ctx.db.insert("webhookDeliveries", {
        endpointId,
        event: "spec.published",
        status: "pending",
        attempts: 2,
        createdAt: Date.now(),
        payload: JSON.stringify({
          event: "spec.published",
          data: {},
          timestamp: Date.now(),
        }),
      });
      return { deliveryId };
    });

    await t.run(async (ctx) => {
      await ctx.runMutation(internal.webhooks.recordDeliveryAttempt, {
        deliveryId,
        ok: false,
        error: "Connection refused",
      });
    });

    const delivery = await t.run(async (ctx) => {
      return await ctx.db.get(deliveryId);
    });
    expect(delivery?.status).toBe("failed");
    expect(delivery?.attempts).toBe(3);
    expect(delivery?.lastError).toBe("Connection refused");

    // webhook_failed notification fired
    const notifs = await t.run(async (ctx) => {
      return await ctx.db.query("notifications").collect();
    });
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.kind).toBe("webhook_failed");
    expect(notifs[0]!.refId).toBe(`webhook_failed:${deliveryId}`);
  });

  it("increments attempts + stays pending on non-final failure", async () => {
    const t = convexTest(schema, modules);

    const { deliveryId, endpointId } = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_wh",
        name: "WH Co",
        slug: "wh-co",
      });
      const projectId = await ctx.db.insert("projects", {
        organizationId: orgId,
        name: "API",
        slug: "api",
        status: "published",
        visibility: "public",
        tags: [],
      });
      const encryptedSecret = await encryptSecret("s3cr3t");
      const endpointId = await ctx.db.insert("webhookEndpoints", {
        projectId,
        url: "https://example.com/hook",
        ...encryptedSecret,
        active: true,
        createdAt: Date.now(),
      });
      const deliveryId = await ctx.db.insert("webhookDeliveries", {
        endpointId,
        event: "spec.published",
        status: "pending",
        attempts: 0,
        createdAt: Date.now(),
        payload: JSON.stringify({
          event: "spec.published",
          data: {},
          timestamp: Date.now(),
        }),
      });
      // Delete endpoint so scheduled retry finds no endpoint → no cascade
      await ctx.db.delete(endpointId);
      return { deliveryId, endpointId };
    });

    await t.run(async (ctx) => {
      await ctx.runMutation(internal.webhooks.recordDeliveryAttempt, {
        deliveryId,
        ok: false,
        error: "timeout",
      });
      // Verify state BEFORE scheduled action runs
      const delivery = await ctx.db.get(deliveryId);
      expect(delivery?.attempts).toBe(1);
      expect(delivery?.status).toBe("pending");
      expect(delivery?.lastError).toBe("timeout");
    });

    // endpointId was deleted; scheduled retry action exits harmlessly
    expect(endpointId).toBeDefined();
  });
});

describe("deliverWebhook — action integration", () => {
  afterEach(() => {
    pinnedTransportMock.mockReset();
  });

  async function seedDelivery(
    t: ReturnType<typeof convexTest>,
    status: "pending" | "ok" | "failed" = "pending",
  ) {
    return await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_action",
        name: "Action Co",
        slug: "action-co",
      });
      const projectId = await ctx.db.insert("projects", {
        organizationId: orgId,
        name: "Action API",
        slug: "action-api",
        status: "published",
        visibility: "public",
        tags: [],
      });
      const encryptedSecret = await encryptSecret(
        "delivery-plaintext-never-returned",
      );
      const endpointId = await ctx.db.insert("webhookEndpoints", {
        projectId,
        url: "https://example.com/hook",
        ...encryptedSecret,
        active: true,
        createdAt: Date.now(),
      });
      return await ctx.db.insert("webhookDeliveries", {
        endpointId,
        event: "spec.published",
        status,
        attempts: status === "pending" ? 0 : 1,
        createdAt: Date.now(),
        payload: JSON.stringify({
          event: "spec.published",
          data: { projectId },
          timestamp: 123,
        }),
      });
    });
  }

  it("sends the delivery id header and skips completed deliveries", async () => {
    const t = convexTest(schema, modules);
    const pendingId = await seedDelivery(t);
    pinnedTransportMock.mockResolvedValue({ status: 200 });

    const queryResult = await t.query(internal.webhooks.getDeliveryForAction, {
      deliveryId: pendingId,
    });
    expect(queryResult).not.toHaveProperty("secret");
    expect(JSON.stringify(queryResult)).not.toContain(
      "delivery-plaintext-never-returned",
    );

    await t.action(internal.webhookDeliveryAction.deliverWebhook, {
      deliveryId: pendingId,
    });

    expect(pinnedTransportMock).toHaveBeenCalledTimes(1);
    const headers = pinnedTransportMock.mock.calls[0]![0].headers;
    expect(headers["X-Zevium-Delivery-Id"]).toBe(pendingId);

    await t.action(internal.webhookDeliveryAction.deliverWebhook, {
      deliveryId: pendingId,
    });
    expect(pinnedTransportMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed without decryption keys and never reaches transport", async () => {
    const t = convexTest(schema, modules);
    const deliveryId = await seedDelivery(t);
    delete process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS;

    await t.action(internal.webhookDeliveryAction.deliverWebhook, {
      deliveryId,
    });

    expect(pinnedTransportMock).not.toHaveBeenCalled();
    const delivery = await t.run(async (ctx) => ctx.db.get(deliveryId));
    expect(delivery).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "Signing secret unavailable",
    });
    expect(JSON.stringify(delivery)).not.toContain("webhook-encryption-test");
  });

  it("does not retry a terminal 4xx response", async () => {
    const t = convexTest(schema, modules);
    const deliveryId = await seedDelivery(t);
    pinnedTransportMock.mockResolvedValue({ status: 400 });

    await t.action(internal.webhookDeliveryAction.deliverWebhook, {
      deliveryId,
    });

    const delivery = await t.run(async (ctx) => ctx.db.get(deliveryId));
    expect(delivery?.status).toBe("failed");
    expect(delivery?.attempts).toBe(1);
    expect(delivery?.lastError).toBe("HTTP 400");
  });
});
