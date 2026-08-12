import { describe, expect, it } from "vitest";
import {
  EDGE_KEY_REVOCATION_SCHEMA_VERSION,
  ackMatchesEdgeKeyRevocationEvent,
  edgeKeyRevocationBody,
  edgeKeyRevocationBodySha256,
  parseEdgeKeyRevocationAck,
  parseEdgeKeyRevocationEvent,
  signEdgeKeyRevocationAck,
  signEdgeKeyRevocationRequest,
  verifyEdgeKeyRevocationAck,
  verifyEdgeKeyRevocationRequest,
  type EdgeKeyRevocationEvent,
} from "./edge-key-revocation";

const SECRET = "x".repeat(32);

function sampleEvent(
  overrides: Partial<EdgeKeyRevocationEvent> = {},
): EdgeKeyRevocationEvent {
  return {
    schemaVersion: EDGE_KEY_REVOCATION_SCHEMA_VERSION,
    eventId: "ekr_test_event_0001",
    clerkOrgId: "org_edge",
    keyId: "key_edge",
    revision: 3,
    occurredAt: 1_700_000_000_000,
    reason: "membership_deleted",
    ...overrides,
  };
}

describe("edge key revocation contract", () => {
  it("signs and verifies request-bound acknowledgement identity", async () => {
    const event = sampleEvent();
    const body = edgeKeyRevocationBody(event);
    const bodySha256 = await edgeKeyRevocationBodySha256(body);
    const now = Date.now();
    const timestamp = String(now);
    const nonce = "nonce_edge_revocation_01";
    const signature = await signEdgeKeyRevocationRequest(
      SECRET,
      timestamp,
      nonce,
      body,
    );
    await expect(
      verifyEdgeKeyRevocationRequest(
        SECRET,
        timestamp,
        nonce,
        body,
        signature,
        now,
      ),
    ).resolves.toBe(true);
    await expect(
      verifyEdgeKeyRevocationRequest(
        SECRET,
        timestamp,
        nonce,
        body.replace("org_edge", "org_other"),
        signature,
        now,
      ),
    ).resolves.toBe(false);

    const ack = {
      schemaVersion: EDGE_KEY_REVOCATION_SCHEMA_VERSION,
      eventId: event.eventId,
      bodySha256,
      clerkOrgId: event.clerkOrgId,
      keyId: event.keyId,
      revision: event.revision,
      status: "applied" as const,
      receiverRevision: event.revision,
    };
    const { canonicalJson } = await import("./registry-sync");
    const canonicalAck = canonicalJson(ack);
    const ackSig = await signEdgeKeyRevocationAck(
      SECRET,
      timestamp,
      nonce,
      canonicalAck,
    );
    await expect(
      verifyEdgeKeyRevocationAck(
        SECRET,
        timestamp,
        nonce,
        canonicalAck,
        ackSig,
      ),
    ).resolves.toBe(true);
    expect(
      ackMatchesEdgeKeyRevocationEvent(
        parseEdgeKeyRevocationAck(JSON.parse(canonicalAck) as unknown),
        parseEdgeKeyRevocationEvent(JSON.parse(body) as unknown),
        bodySha256,
      ),
    ).toBe(true);
    expect(
      ackMatchesEdgeKeyRevocationEvent(
        parseEdgeKeyRevocationAck(JSON.parse(canonicalAck) as unknown),
        sampleEvent({ eventId: "ekr_other" }),
        bodySha256,
      ),
    ).toBe(false);
  });

  it("rejects weak secrets and clock skew", async () => {
    const body = edgeKeyRevocationBody(sampleEvent());
    await expect(
      signEdgeKeyRevocationRequest(
        "short",
        "1",
        "nonce_edge_revocation_01",
        body,
      ),
    ).rejects.toThrow(/at least 32 bytes/);
    const now = Date.now();
    const timestamp = String(now);
    const signature = await signEdgeKeyRevocationRequest(
      SECRET,
      timestamp,
      "nonce_edge_revocation_01",
      body,
    );
    await expect(
      verifyEdgeKeyRevocationRequest(
        SECRET,
        timestamp,
        "nonce_edge_revocation_01",
        body,
        signature,
        now + 400_000,
      ),
    ).resolves.toBe(false);
  });
});
