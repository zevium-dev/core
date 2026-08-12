import { describe, expect, it } from "vitest";
import {
  REGISTRY_PROTOCOL_VERSION,
  REGISTRY_V2_PRODUCER_CONTRACT,
  createRegistryEvent,
  validateRegistryAck,
  validateRegistryEvent,
} from "./registry-v2";
import { REGISTRY_V2_SHARED_VECTORS } from "./registry-v2-vectors";

describe("canonical registry v2 seam", () => {
  it("exposes exact producer contract operations", () => {
    expect(REGISTRY_PROTOCOL_VERSION).toBe(2);
    expect(REGISTRY_V2_PRODUCER_CONTRACT.operations).toEqual([
      "org.put",
      "org.archive",
      "route.put",
      "route.archive",
      "key.put",
      "key.revoke",
      "catalogue.snapshot",
    ]);
    expect(REGISTRY_V2_PRODUCER_CONTRACT.rawSecret).toBe(
      "never_persisted_or_sent",
    );
  });

  it("validates golden event and bound acknowledgement", async () => {
    const golden = REGISTRY_V2_SHARED_VECTORS.events[0]!.event;
    const event = await validateRegistryEvent(golden);
    expect(event.eventId).toBe(golden.eventId);
    validateRegistryAck(REGISTRY_V2_SHARED_VECTORS.acknowledgement.applied);
    expect(REGISTRY_V2_SHARED_VECTORS.acknowledgement.applied.eventId).toBe(
      event.eventId,
    );
    expect(REGISTRY_V2_SHARED_VECTORS.acknowledgement.applied.streamKey).toBe(
      event.streamKey,
    );
    expect(REGISTRY_V2_SHARED_VECTORS.acknowledgement.applied.revision).toBe(
      event.revision,
    );
    expect(
      REGISTRY_V2_SHARED_VECTORS.acknowledgement.applied.payloadSha256,
    ).toBe(event.payloadSha256);
  });

  it("creates deterministic event ids without raw secrets", async () => {
    const event = await createRegistryEvent({
      streamKey: "org:org_vector",
      revision: 1,
      operation: "org.put",
      occurredAt: 1_700_000_000_000,
      nonce: "VectorNonce_0000001",
      payload: {
        clerkOrgId: "org_vector",
        organizationId: "organization_vector",
        publisherHandle: "vector-publisher",
      },
    });
    expect(event.schemaVersion).toBe(2);
    expect(event.eventId.startsWith("r2_")).toBe(true);
    expect(JSON.stringify(event)).not.toMatch(/sk_live|secret|password/i);
  });
});
