/// <reference types="vite/client" />
import {
  canonicalJson,
  decryptRegistryCredentials,
  parseRegistryTransportKeyring,
  sha256Hex,
  signRegistryAck,
  validateRegistryEvent,
  type RegistryAck,
  type RegistryEvent,
} from "@zevium/shared";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { encryptCredential } from "./lib/credentialCrypto";
import {
  enqueueCatalogueSnapshot,
  enqueueKeyPut,
  enqueueKeyRevoke,
  enqueueOrgArchive,
  enqueueOrgPut,
  enqueuePublishedProjectProjection,
  enqueueRegistryEvent,
  enqueueRouteArchive,
} from "./registrySync";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const HMAC_SECRET = "registry-test-signing-secret-0123456789";
const TRANSPORT_KEYRING = JSON.stringify({
  current: "transport-v1",
  keys: { "transport-v1": "22".repeat(32) },
});
const previous = {
  base: process.env.GATEWAY_REGISTRY_SYNC_BASE_URL,
  hmac: process.env.GATEWAY_REGISTRY_SYNC_HMAC_SECRET,
  transport: process.env.GATEWAY_REGISTRY_TRANSPORT_KEYRING,
  upstream: process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2027-01-15T00:00:00.000Z"));
  process.env.GATEWAY_REGISTRY_TRANSPORT_KEYRING = TRANSPORT_KEYRING;
  process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify({
    current: "upstream-v1",
    keys: { "upstream-v1": "upstream-test-material" },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries({
    GATEWAY_REGISTRY_SYNC_BASE_URL: previous.base,
    GATEWAY_REGISTRY_SYNC_HMAC_SECRET: previous.hmac,
    GATEWAY_REGISTRY_TRANSPORT_KEYRING: previous.transport,
    UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS: previous.upstream,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function seedPublished(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_registry",
      name: "Registry Publisher",
      slug: "registry-publisher",
      publicHandle: "registry-publisher",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId,
      name: "Weather",
      slug: "weather",
      description: "Forecasts",
      status: "published",
      visibility: "public",
      tags: ["weather"],
      publicationGeneration: 1,
    });
    const spec = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Weather", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      paths: { "/forecast": { get: { "x-zevium-cost": 7 } } },
    });
    const versionId = await ctx.db.insert("specVersions", {
      projectId,
      version: "1.0.0",
      spec,
      publishedAt: 1_700_000_000_000,
    });
    await ctx.db.insert("upstreamCredentials", {
      projectId,
      name: "authorization",
      ...(await encryptCredential("Bearer publisher-secret")),
      updatedAt: 100,
    });
    return { organizationId, projectId, versionId };
  });
}

describe("canonical registry producer", () => {
  it("writes exact per-stream events and no global sequencing tables", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, projectId } = await seedPublished(t);
    const receipts = await t.run(async (ctx) => {
      const org = (await ctx.db.get(organizationId))!;
      const orgEvent = await enqueueOrgPut(ctx, org);
      const projection = await enqueuePublishedProjectProjection(
        ctx,
        projectId,
      );
      if (projection === null) throw new Error("missing projection");
      return { orgEvent, projection };
    });
    expect(receipts.orgEvent.streamKey).toBe("org:org_registry");
    expect(receipts.projection.route.operation).toBe("route.put");
    expect(receipts.projection.catalogue.operation).toBe("catalogue.snapshot");
    expect(receipts.projection.catalogue.revision).toBe(1);
    expect(receipts.projection.catalogue).toMatchObject({
      entityKey: `catalogue:${projectId}:1`,
    });
    const rows = await t.run(async (ctx) => ({
      streams: await ctx.db.query("registryStreams").collect(),
      outbox: await ctx.db.query("registryOutbox").collect(),
    }));
    expect(rows.streams.map((row) => row.streamKey).sort()).toEqual(
      [
        "catalogue:" + projectId,
        "org:org_registry",
        "route:registry-publisher/weather",
      ].sort(),
    );
    expect(
      rows.outbox.every(
        (row) =>
          row.schemaVersion === 2 &&
          row.eventJson === canonicalJson(JSON.parse(row.eventJson)),
      ),
    ).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("publisher-secret");
    expect(JSON.stringify(rows)).not.toContain("globalSequence");
  });

  it("decrypts only route transport envelopes bound to exact stream revision", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedPublished(t);
    const route = await t.run(
      async (ctx) =>
        (await enqueuePublishedProjectProjection(ctx, projectId))!.route,
    );
    const row = await t.run(
      async (ctx) =>
        await ctx.db
          .query("registryOutbox")
          .withIndex("by_event", (q) => q.eq("eventId", route.eventId))
          .unique(),
    );
    if (row === null) throw new Error("missing route event");
    const event = JSON.parse(row.eventJson) as RegistryEvent<"route.put">;
    const keyring = parseRegistryTransportKeyring(TRANSPORT_KEYRING);
    await expect(
      decryptRegistryCredentials(
        keyring,
        event.streamKey,
        event.revision,
        event.payload.upstreamCredentials,
      ),
    ).resolves.toEqual({ authorization: "Bearer publisher-secret" });
    await expect(
      decryptRegistryCredentials(
        keyring,
        event.streamKey,
        event.revision + 1,
        event.payload.upstreamCredentials,
      ),
    ).rejects.toThrow("authentication failed");
    await expect(validateRegistryEvent(event)).resolves.toEqual(event);
  });

  it("keeps independent streams claimable when another stream is poisoned", async () => {
    const t = convexTest(schema, modules);
    const rows = await t.run(async (ctx) => {
      const first = await enqueueRegistryEvent(ctx, {
        operation: "org.put",
        streamKey: "org:org_poisoned",
        payload: {
          clerkOrgId: "org_poisoned",
          organizationId: "organization_poisoned",
          publisherHandle: "poisoned",
        },
      });
      const second = await enqueueRegistryEvent(ctx, {
        operation: "org.put",
        streamKey: "org:org_healthy",
        payload: {
          clerkOrgId: "org_healthy",
          organizationId: "organization_healthy",
          publisherHandle: "healthy",
        },
      });
      return { first, second };
    });
    await t.run(async (ctx) => {
      const first = await ctx.db
        .query("registryOutbox")
        .withIndex("by_event", (q) => q.eq("eventId", rows.first.eventId))
        .unique();
      if (first === null) throw new Error("missing poisoned row");
      await ctx.db.patch(first._id, {
        status: "dead_letter",
        lastErrorCode: "hostile_receiver",
      });
    });
    await expect(
      t.mutation(internal.registrySync.claim, {
        outboxId: (
          await t.run(
            async (ctx) =>
              await ctx.db
                .query("registryOutbox")
                .withIndex("by_event", (q) =>
                  q.eq("eventId", rows.second.eventId),
                )
                .unique(),
          )!
        )._id,
      }),
    ).resolves.toMatchObject({ event: { eventId: rows.second.eventId } });
  });

  it("fences expired leases and recovers after a worker crash", async () => {
    const t = convexTest(schema, modules);
    const outboxId = await t.run(async (ctx) => {
      await enqueueRegistryEvent(ctx, {
        operation: "org.put",
        streamKey: "org:org_lease",
        payload: {
          clerkOrgId: "org_lease",
          organizationId: "organization_lease",
          publisherHandle: "lease",
        },
      });
      return (await ctx.db.query("registryOutbox").unique())!._id;
    });
    const first = await t.mutation(internal.registrySync.claim, { outboxId });
    expect(first?.attempt).toBe(1);
    vi.advanceTimersByTime(30_001);
    const second = await t.mutation(internal.registrySync.claim, { outboxId });
    expect(second?.attempt).toBe(2);
    await expect(
      t.mutation(internal.registrySync.markFailed, {
        outboxId,
        attempt: first!.attempt,
        leaseToken: first!.leaseToken,
        error: "stale worker",
      }),
    ).resolves.toBe(false);
    const row = await t.run(async (ctx) => ctx.db.get(outboxId));
    expect(row).toMatchObject({ status: "delivering", attempts: 2 });
  });

  it("makes archive terminal and rejects resurrection", async () => {
    const t = convexTest(schema, modules);
    const { organizationId } = await seedPublished(t);
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(organizationId))!;
      await enqueueOrgPut(ctx, org);
      await enqueueOrgArchive(
        ctx,
        org.clerkOrgId,
        String(org._id),
        1_700_000_000_100,
      );
      await expect(enqueueOrgPut(ctx, org)).rejects.toThrow("terminal");
    });
    const stream = await t.run(
      async (ctx) =>
        await ctx.db
          .query("registryStreams")
          .withIndex("by_stream", (q) => q.eq("streamKey", "org:org_registry"))
          .unique(),
    );
    expect(stream).toMatchObject({
      terminal: true,
      lastOperation: "org.archive",
    });
  });

  it("emits key.put and key.revoke with independent budget identity and no raw key", async () => {
    const t = convexTest(schema, modules);
    const secret = "one-time-secret-never-persisted";
    const secretSha256 = await sha256Hex(secret);
    const put = await t.run(
      async (ctx) =>
        await enqueueKeyPut(ctx, {
          secretSha256,
          clerkKeyId: "ck_registry",
          clerkOrgId: "org_registry",
          ownerUserId: "user_registry",
          subjectUserId: "user_registry",
          budgetId: "budget_independent",
          budgetRevision: 1,
          lifecycle: "active",
          monthlyCapCredits: null,
          graceUntil: null,
          expiresAt: null,
          scopes: ["gateway:execute"],
        }),
    );
    const keyId = await t.run(
      async (ctx) =>
        await ctx.db.insert("keySettings", {
          clerkOrgId: "org_registry",
          keyId: "ck_registry",
          ownerUserId: "user_registry",
          subjectUserId: "user_registry",
          budgetId: "budget_independent",
          budgetRevision: 1,
          secretSha256,
          lifecycle: "active",
          disabled: false,
          updatedAt: 1,
        }),
    );
    const revoke = await t.run(
      async (ctx) =>
        await enqueueKeyRevoke(
          ctx,
          (await ctx.db.get(keyId))!,
          "admin_revoked",
        ),
    );
    expect(put.streamKey).toBe(`key:${secretSha256}`);
    expect(revoke?.operation).toBe("key.revoke");
    const stored = await t.run(
      async (ctx) => await ctx.db.query("registryOutbox").collect(),
    );
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(stored.map((row) => row.operation)).toEqual([
      "key.put",
      "key.revoke",
    ]);
  });

  it("accepts only a signed exact ACK bound to request and event identity", async () => {
    process.env.GATEWAY_REGISTRY_SYNC_BASE_URL = "http://localhost:8787";
    process.env.GATEWAY_REGISTRY_SYNC_HMAC_SECRET = HMAC_SECRET;
    const requests: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requests.push(init ?? {});
        const event = JSON.parse(String(init?.body)) as RegistryEvent;
        const ack: RegistryAck = {
          schemaVersion: 2,
          eventId: event.eventId,
          bodySha256: await sha256Hex(String(init?.body)),
          streamKey: event.streamKey,
          revision: event.revision,
          operation: event.operation,
          payloadSha256: event.payloadSha256,
          entityKey: `org:${event.payload.clerkOrgId}`,
          status: "applied",
          receiverRevision: event.revision,
          receiverEventId: event.eventId,
          receiverPayloadSha256: event.payloadSha256,
          receiverTombstone: false,
        };
        const body = canonicalJson(ack);
        const timestamp = String(Date.now());
        const nonce = event.nonce;
        return new Response(body, {
          headers: {
            "x-zevium-registry-ack-signature": await signRegistryAck(
              HMAC_SECRET,
              timestamp,
              nonce,
              body,
            ),
            "x-test-timestamp": timestamp,
          },
        });
      }),
    );
    const t = convexTest(schema, modules);
    const outboxId = await t.run(async (ctx) => {
      await enqueueRegistryEvent(ctx, {
        operation: "org.put",
        streamKey: "org:org_signed",
        payload: {
          clerkOrgId: "org_signed",
          organizationId: "organization_signed",
          publisherHandle: "signed",
        },
      });
      return (await ctx.db.query("registryOutbox").unique())!._id;
    });
    await t.action(internal.registrySync.dispatchEvent, { outboxId });
    expect(requests).toHaveLength(1);
  });
});
