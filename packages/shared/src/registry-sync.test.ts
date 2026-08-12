import { describe, expect, it } from "vitest";
import {
  REGISTRY_MAX_EVENT_BYTES,
  REGISTRY_MAX_SPEC_BYTES,
  REGISTRY_V2_PRODUCER_CONTRACT,
  canonicalJson,
  createRegistryEvent,
  createRegistryManifestPage,
  decryptRegistryCredentials,
  encryptRegistryCredentials,
  parseRegistryTransportKeyring,
  registryEncodedByteLength,
  registryEntityKey,
  registryManifestShard,
  registryStreamKeyForPayload,
  sealOneTimeExecutionKey,
  sha256Hex,
  signRegistryAck,
  signRegistryEventRequest,
  validateRegistryAck,
  validateRegistryEvent,
  verifyRegistryAck,
  verifyRegistryEventRequest,
} from "./registry-sync";
import { REGISTRY_V2_SHARED_VECTORS } from "./registry-v2-vectors";

const SECRET = "registry-test-signing-secret-0123456789";
const NONCE = "TestNonce_0000001";

function orgPayload() {
  return {
    clerkOrgId: "org_test",
    organizationId: "organization_test",
    publisherHandle: "test-publisher",
  } as const;
}

async function orgEvent(revision = 1, nonce = NONCE) {
  return await createRegistryEvent({
    operation: "org.put",
    streamKey: "org:org_test",
    revision,
    occurredAt: 1_700_000_000_000 + revision,
    nonce,
    payload: orgPayload(),
  });
}

describe("canonical Registry v2 contract", () => {
  it("has only canonical operations and validates frozen vectors", async () => {
    expect(REGISTRY_V2_PRODUCER_CONTRACT.operations).toEqual([
      "org.put",
      "org.archive",
      "route.put",
      "route.archive",
      "key.put",
      "key.revoke",
      "catalogue.snapshot",
    ]);
    expect(JSON.stringify(REGISTRY_V2_PRODUCER_CONTRACT)).not.toMatch(
      /upsert|retire|provision|rotation_required|remove|globalSequence|parked/,
    );
    for (const vector of REGISTRY_V2_SHARED_VECTORS.events) {
      expect(canonicalJson(vector.event)).toBe(vector.canonicalBody);
      expect(registryEncodedByteLength(vector.event)).toBe(vector.encodedBytes);
      await expect(validateRegistryEvent(vector.event)).resolves.toEqual(
        vector.event,
      );
    }
    expect(
      canonicalJson(REGISTRY_V2_SHARED_VECTORS.acknowledgement.applied),
    ).toBe(REGISTRY_V2_SHARED_VECTORS.acknowledgement.canonicalBody);
  });

  it("sorts recursively, preserves arrays, and rejects hostile JSON", () => {
    expect(canonicalJson({ z: 1, a: { y: true, x: [2, 1] } })).toBe(
      '{"a":{"x":[2,1],"y":true},"z":1}',
    );
    expect(() => canonicalJson({ undefined: undefined })).toThrow("undefined");
    expect(() => canonicalJson({ bad: Number.NaN })).toThrow("non-finite");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow("cyclic");
    expect(canonicalJson({ "\u{1f600}": 1, "\uffff": 2 })).toBe(
      '{"\uffff":2,"😀":1}',
    );
  });

  it("binds event identity to stream, revision, nonce, payload, and exact body", async () => {
    const event = await orgEvent();
    expect(event.eventId).toMatch(/^r2_[a-f0-9]{64}$/);
    expect(registryStreamKeyForPayload(event.operation, event.payload)).toBe(
      event.streamKey,
    );
    expect(registryEntityKey(event)).toBe("org:org_test");
    await expect(validateRegistryEvent(event)).resolves.toEqual(event);
    await expect(
      validateRegistryEvent({ ...event, streamKey: "org:attacker" }),
    ).rejects.toThrow("identity");
    await expect(
      validateRegistryEvent({ ...event, revision: 2 }),
    ).rejects.toThrow("digest");
    await expect(
      validateRegistryEvent({
        ...event,
        payload: { ...event.payload, publisherHandle: "forged" },
      }),
    ).rejects.toThrow("digest");
    await expect(
      createRegistryEvent({ ...event, nonce: "short" }),
    ).rejects.toThrow("nonce");
  });

  it("uses raw canonical body HMAC and rejects whitespace, nonce, and header confusion", async () => {
    const event = await orgEvent();
    const body = canonicalJson(event);
    const signature = await signRegistryEventRequest(
      SECRET,
      "1700000000000",
      NONCE,
      body,
    );
    await expect(
      verifyRegistryEventRequest(
        SECRET,
        "1700000000000",
        NONCE,
        body,
        signature,
      ),
    ).resolves.toBe(true);
    await expect(
      verifyRegistryEventRequest(
        SECRET,
        "1700000000000",
        NONCE,
        `${body} `,
        signature,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyRegistryEventRequest(
        SECRET,
        "1700000000000",
        "TestNonce_0000002",
        body,
        signature,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyRegistryEventRequest(
        SECRET,
        "01700000000000",
        NONCE,
        body,
        signature,
      ),
    ).resolves.toBe(false);
    await expect(
      signRegistryEventRequest("short", "1700000000000", NONCE, body),
    ).rejects.toThrow("32-4096");
  });

  it("binds signed ACK to request timestamp and nonce plus every identity field", async () => {
    const event = await orgEvent();
    const body = canonicalJson(event);
    const ack = {
      ...REGISTRY_V2_SHARED_VECTORS.acknowledgement.applied,
      eventId: event.eventId,
      bodySha256: await sha256Hex(body),
      streamKey: event.streamKey,
      operation: event.operation,
      payloadSha256: event.payloadSha256,
      entityKey: registryEntityKey(event),
    } as const;
    const ackBody = canonicalJson(ack);
    validateRegistryAck(ack);
    const signature = await signRegistryAck(
      SECRET,
      "1700000000000",
      NONCE,
      ackBody,
    );
    await expect(
      verifyRegistryAck(SECRET, "1700000000000", NONCE, ackBody, signature),
    ).resolves.toBe(true);
    await expect(
      verifyRegistryAck(
        SECRET,
        "1700000000000",
        "TestNonce_0000002",
        ackBody,
        signature,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyRegistryAck(
        SECRET,
        "1700000000000",
        NONCE,
        canonicalJson({ ...ack, revision: 2 }),
        signature,
      ),
    ).resolves.toBe(false);
  });

  it("keeps transport credentials encrypted and AAD-bound to stream revision", async () => {
    const keyring = parseRegistryTransportKeyring(
      JSON.stringify({ current: "k1", keys: { k1: "11".repeat(32) } }),
    );
    const sealed = await encryptRegistryCredentials(
      keyring,
      "route:test-publisher/weather",
      7,
      { authorization: "Bearer publisher-secret" },
    );
    expect(JSON.stringify(sealed)).not.toContain("publisher-secret");
    await expect(
      decryptRegistryCredentials(
        keyring,
        "route:test-publisher/weather",
        7,
        sealed,
      ),
    ).resolves.toEqual({ authorization: "Bearer publisher-secret" });
    await expect(
      decryptRegistryCredentials(
        keyring,
        "route:test-publisher/weather",
        8,
        sealed,
      ),
    ).rejects.toThrow("authentication failed");
    await expect(
      decryptRegistryCredentials(keyring, "route:other/weather", 7, sealed),
    ).rejects.toThrow("authentication failed");
  });

  it("enforces spec and event byte ceilings using UTF-8", async () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "Large" },
      paths: { "/x": {} },
      filler: "x".repeat(REGISTRY_MAX_SPEC_BYTES),
    };
    await expect(
      createRegistryEvent({
        operation: "route.put",
        streamKey: "route:test-publisher/large",
        revision: 1,
        occurredAt: 1_700_000_000_000,
        nonce: NONCE,
        payload: {
          projectId: "project_large",
          projectGeneration: 1,
          publisherOrganizationId: "organization_large",
          publisherClerkOrgId: "org_large",
          publisherHandle: "test-publisher",
          projectSlug: "large",
          specVersionId: "version_large",
          version: "1.0.0",
          publishedAt: 1_700_000_000_000,
          spec,
          visibility: "public",
          credentialRevision: 1,
          upstreamCredentials: {
            algorithm: "A256GCM",
            aadVersion: 1,
            keyId: "k1",
            ivBase64Url: "AAAAAAAAAAAAAAAA",
            ciphertextBase64Url: "AAAAAAAAAAAAAAAAAAAAAAAA",
            plaintextSha256: "a".repeat(64),
          },
          admission: { mode: "open", policyRevision: 1 },
          deprecation: { deprecatedAt: null, sunsetAt: null, message: null },
        },
      }),
    ).rejects.toThrow("spec exceeds");
    const event = await orgEvent();
    expect(registryEncodedByteLength(event)).toBeLessThan(
      REGISTRY_MAX_EVENT_BYTES,
    );
  });

  it("makes manifests pinned, sorted, byte-bounded, and SHA-256 sharded", async () => {
    await expect(registryManifestShard("org:org_test")).resolves.toMatch(
      /^[a-f0-9]{2}$/,
    );
    const page = await createRegistryManifestPage({
      schemaVersion: 2,
      kind: "org",
      shard: "00",
      createdAt: 1_700_000_000_000,
      pageIndex: 0,
      afterEntityKey: null,
      items: [
        {
          entityKey: "org:b",
          streamKey: "org:b",
          revision: 1,
          eventId: "r2_b",
          operation: "org.put",
          payloadSha256: "a".repeat(64),
          tombstone: false,
        },
        {
          entityKey: "org:a",
          streamKey: "org:a",
          revision: 2,
          eventId: "r2_a",
          operation: "org.archive",
          payloadSha256: "b".repeat(64),
          tombstone: true,
        },
      ],
      totalCount: 2,
      nextAfterEntityKey: null,
    });
    expect(page.items.map((item) => item.entityKey)).toEqual([
      "org:a",
      "org:b",
    ]);
    expect(page.itemCount).toBe(2);
    expect(page.snapshotId).toMatch(/^rm2_[a-f0-9]{64}$/);
  });

  it("never puts raw one-time key material in canonical projection", async () => {
    const sealed = await sealOneTimeExecutionKey({
      keyId: "ck_1",
      secret: "one-time-secret-value",
      clerkOrgId: "org_test",
      ownerUserId: "user_1",
      subjectUserId: "user_1",
      budgetId: "budget_random_1",
      budgetRevision: 1,
      scopes: ["gateway:execute"],
    });
    expect(JSON.stringify(sealed.provision)).not.toContain(
      "one-time-secret-value",
    );
    expect(sealed.provision.secretSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(sealed.provision.budgetId).toBe("budget_random_1");
  });
});
