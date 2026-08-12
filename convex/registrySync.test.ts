/// <reference types="vite/client" />
import {
  canonicalJson,
  registryPayloadDigest,
  signRegistrySyncRequest,
} from "@zevium/shared";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { encryptCredential } from "./lib/credentialCrypto";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const KEYRING = JSON.stringify({
  current: "registry-test-v1",
  keys: {
    "registry-test-v1": "MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTE=",
  },
});

const priorKeyring = process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS;
const priorBaseUrl = process.env.GATEWAY_REGISTRY_SYNC_BASE_URL;
const priorSecret = process.env.GATEWAY_REGISTRY_SYNC_HMAC_SECRET;

beforeEach(() => {
  process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS = KEYRING;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (priorKeyring === undefined) {
    delete process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS;
  } else {
    process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS = priorKeyring;
  }
  if (priorBaseUrl === undefined) {
    delete process.env.GATEWAY_REGISTRY_SYNC_BASE_URL;
  } else {
    process.env.GATEWAY_REGISTRY_SYNC_BASE_URL = priorBaseUrl;
  }
  if (priorSecret === undefined) {
    delete process.env.GATEWAY_REGISTRY_SYNC_HMAC_SECRET;
  } else {
    process.env.GATEWAY_REGISTRY_SYNC_HMAC_SECRET = priorSecret;
  }
});

async function seedPublishedProject(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_registry",
      name: "Registry Publisher",
      slug: "private-clerk-slug",
      publicHandle: "registry-publisher",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Weather",
      slug: "weather",
      status: "published",
      visibility: "private",
      tags: [],
    });
    await ctx.db.insert("specs", {
      projectId,
      draft:
        '{"openapi":"3.1.0","info":{"title":"Weather","version":"1.0.0"},"paths":{},"servers":[{"url":"https://api.example.com"}]}',
      lastSavedAt: 1,
    });
    await ctx.db.insert("specVersions", {
      projectId,
      version: "1.0.0",
      spec: '{"openapi":"3.1.0","info":{"title":"Weather","version":"1.0.0"},"paths":{},"servers":[{"url":"https://api.example.com"}]}',
      publishedAt: 1,
    });
    const encrypted = await encryptCredential(
      "publisher-secret",
      projectId,
      "authorization",
    );
    await ctx.db.insert("upstreamCredentials", {
      projectId,
      name: "authorization",
      ...encrypted,
      updatedAt: 1,
    });
    return { orgId, projectId };
  });
}

function asAdmin(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "user_admin",
    org_id: "org_registry",
    org_role: "org:admin",
    org_slug: "private-clerk-slug",
  } as { subject: string });
}

describe("registry sync outbox", () => {
  it("persists route revisions without copying cleartext credentials", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedPublishedProject(t);

    await asAdmin(t).mutation(api.projects.update, {
      projectId,
      patch: { name: "Weather Pro" },
    });

    const first = await t.run(async (ctx) => {
      const outbox = await ctx.db.query("registrySyncOutbox").collect();
      const stream = await ctx.db.query("registrySyncStreams").unique();
      return { outbox, stream };
    });
    expect(first.outbox).toHaveLength(1);
    expect(first.outbox[0]).toMatchObject({
      operation: "route.upsert",
      sourceRevision: 1,
      status: "pending",
      attempts: 0,
    });
    expect(first.outbox[0]?.payloadJson).not.toContain("publisher-secret");
    const logical = JSON.parse(first.outbox[0]!.payloadJson) as unknown;
    expect(first.outbox[0]?.payloadDigest).toBe(
      await registryPayloadDigest("route.upsert", logical),
    );
    expect(first.stream?.sourceRevision).toBe(1);

    const snapshot = await t.query(internal.registrySync.materializeRoute, {
      projectId,
    });
    expect(snapshot?.snapshot.upstreamHeaders).toEqual({
      authorization: "publisher-secret",
    });

    await asAdmin(t).mutation(api.projects.remove, { projectId });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("registrySyncOutbox")
        .withIndex("by_stream_revision", (q) =>
          q.eq("streamKey", "route:registry-publisher/weather"),
        )
        .collect(),
    );
    expect(rows.map((row) => [row.operation, row.sourceRevision])).toEqual([
      ["route.upsert", 1],
      ["route.archive", 2],
    ]);
    expect(
      await t.query(internal.registrySync.materializeRoute, { projectId }),
    ).toBeNull();
  });

  it("publishes key upsert/state revisions and a paginated recovery manifest", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.keySettings.registerVerified, {
      clerkOrgId: "org_registry",
      userId: "user_owner",
      keyId: "key_registry_123",
    });
    await t.mutation(internal.keySettings.setCapVerified, {
      clerkOrgId: "org_registry",
      userId: "user_owner",
      keyId: "key_registry_123",
      monthlyCapCredits: 500,
    });

    const events = await t.run(async (ctx) =>
      ctx.db
        .query("registrySyncOutbox")
        .withIndex("by_stream_revision", (q) =>
          q.eq("streamKey", "key:key_registry_123"),
        )
        .collect(),
    );
    expect(events.map((row) => [row.operation, row.sourceRevision])).toEqual([
      ["key.upsert", 1],
      ["key.state", 2],
    ]);
    expect(JSON.parse(events[1]!.payloadJson)).toMatchObject({
      keyId: "key_registry_123",
      orgId: "org_registry",
      lifecycle: "active",
      monthlyCapCredits: 500,
    });

    const manifest = await t.query(internal.registrySync.getManifestPage, {
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(manifest.isDone).toBe(true);
    expect(manifest.page).toEqual([
      expect.objectContaining({
        streamKey: "key:key_registry_123",
        operation: "key.state",
        sourceRevision: 2,
        payload: expect.objectContaining({ monthlyCapCredits: 500 }),
      }),
    ]);
  });

  it("delivers once with canonical body, digest, nonce, and exact HMAC", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    process.env.GATEWAY_REGISTRY_SYNC_BASE_URL = "http://localhost:8787";
    const macTestKey = ["01234567", "89abcdef"].join("").repeat(2);
    process.env.GATEWAY_REGISTRY_SYNC_HMAC_SECRET = macTestKey;
    const requests: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), init: init ?? {} });
        const body = JSON.parse(String(init?.body)) as {
          operation: string;
          sourceRevision: number;
        };
        return new Response(
          JSON.stringify({
            status: "applied",
            operation: body.operation,
            sourceRevision: body.sourceRevision,
            keyId: "key_registry_123",
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );
    const t = convexTest(schema, modules);
    await t.mutation(internal.keySettings.registerVerified, {
      clerkOrgId: "org_registry",
      userId: "user_owner",
      keyId: "key_registry_123",
    });

    vi.runAllTimers();
    await t.finishInProgressScheduledFunctions();
    // Lease recovery wake-up observes delivered state and stays a no-op.
    vi.runAllTimers();
    await t.finishInProgressScheduledFunctions();

    expect(requests.map((request) => request.url)).toEqual([
      "http://localhost:8787/internal/registry/v1/key",
    ]);
    expect(requests[0]?.url).toBe(
      "http://localhost:8787/internal/registry/v1/key",
    );
    const rawBody = String(requests[0]?.init.body);
    expect(rawBody).toBe(canonicalJson(JSON.parse(rawBody)));
    const headers = new Headers(requests[0]?.init.headers);
    const timestamp = headers.get("x-zevium-timestamp")!;
    const nonce = headers.get("x-zevium-nonce")!;
    expect(JSON.parse(rawBody)).toMatchObject({
      schemaVersion: 1,
      operation: "key.upsert",
      sourceRevision: 1,
      nonce,
      payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(headers.get("x-zevium-signature")).toBe(
      await signRegistrySyncRequest(macTestKey, timestamp, nonce, rawBody),
    );
    const delivered = await t.run(async (ctx) =>
      ctx.db.query("registrySyncOutbox").unique(),
    );
    expect(delivered).toMatchObject({ status: "delivered", attempts: 1 });
  });
});
