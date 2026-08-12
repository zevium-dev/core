import type { RegistryAck, RegistryEvent } from "./registry-sync.js";

const firstEvent = {
  schemaVersion: 2,
  eventId:
    "r2_0c46b80d140c76f3a3e85b47c61ffb8d72c81092b9799bc7e66aaaf907f9ee8a",
  streamKey: "org:org_vector",
  revision: 1,
  operation: "org.put",
  occurredAt: 1_700_000_000_000,
  nonce: "VectorNonce_0000001",
  payloadSha256:
    "375310714b762ac79425ebe423adbbb4013bde0518839b103f2895c422d3ae7d",
  payload: {
    clerkOrgId: "org_vector",
    organizationId: "organization_vector",
    publisherHandle: "vector-publisher",
  },
} as const satisfies RegistryEvent;

const secondEvent = {
  schemaVersion: 2,
  eventId:
    "r2_7d885fc51321301e7ce0adbbfb007e99f94357be45b15556e3b2ba6d50b36d8d",
  streamKey: "catalogue:project_vector",
  revision: 1,
  operation: "catalogue.snapshot",
  occurredAt: 1_700_000_000_001,
  nonce: "VectorNonce_0000002",
  payloadSha256:
    "e1c2d346abfce206bd1dcfb20b5b28e8705fa164e27987d1cfbb80c3df1a58cf",
  payload: {
    projectId: "project_vector",
    projectGeneration: 1,
    route: null,
    discoverable: false,
    listing: null,
  },
} as const satisfies RegistryEvent;

const appliedAck = {
  schemaVersion: 2,
  eventId: firstEvent.eventId,
  bodySha256:
    "0686f4ef34650fe998314192317b4c556ae8c932e5a56cbb332acdbc26df5113",
  streamKey: firstEvent.streamKey,
  revision: 1,
  operation: firstEvent.operation,
  payloadSha256: firstEvent.payloadSha256,
  entityKey: "org:org_vector",
  status: "applied",
  receiverRevision: 1,
  receiverEventId: firstEvent.eventId,
  receiverPayloadSha256: firstEvent.payloadSha256,
  receiverTombstone: false,
} as const satisfies RegistryAck;

/** Credential-free literals for cross-language Registry v2 conformance tests. */
export const REGISTRY_V2_SHARED_VECTORS = {
  events: [
    {
      event: firstEvent,
      encodedBytes: 417,
      canonicalBody:
        '{"eventId":"r2_0c46b80d140c76f3a3e85b47c61ffb8d72c81092b9799bc7e66aaaf907f9ee8a","nonce":"VectorNonce_0000001","occurredAt":1700000000000,"operation":"org.put","payload":{"clerkOrgId":"org_vector","organizationId":"organization_vector","publisherHandle":"vector-publisher"},"payloadSha256":"375310714b762ac79425ebe423adbbb4013bde0518839b103f2895c422d3ae7d","revision":1,"schemaVersion":2,"streamKey":"org:org_vector"}',
    },
    {
      event: secondEvent,
      encodedBytes: 436,
      canonicalBody:
        '{"eventId":"r2_7d885fc51321301e7ce0adbbfb007e99f94357be45b15556e3b2ba6d50b36d8d","nonce":"VectorNonce_0000002","occurredAt":1700000000001,"operation":"catalogue.snapshot","payload":{"discoverable":false,"listing":null,"projectGeneration":1,"projectId":"project_vector","route":null},"payloadSha256":"e1c2d346abfce206bd1dcfb20b5b28e8705fa164e27987d1cfbb80c3df1a58cf","revision":1,"schemaVersion":2,"streamKey":"catalogue:project_vector"}',
    },
  ],
  acknowledgement: {
    applied: appliedAck,
    canonicalBody:
      '{"bodySha256":"0686f4ef34650fe998314192317b4c556ae8c932e5a56cbb332acdbc26df5113","entityKey":"org:org_vector","eventId":"r2_0c46b80d140c76f3a3e85b47c61ffb8d72c81092b9799bc7e66aaaf907f9ee8a","operation":"org.put","payloadSha256":"375310714b762ac79425ebe423adbbb4013bde0518839b103f2895c422d3ae7d","receiverEventId":"r2_0c46b80d140c76f3a3e85b47c61ffb8d72c81092b9799bc7e66aaaf907f9ee8a","receiverPayloadSha256":"375310714b762ac79425ebe423adbbb4013bde0518839b103f2895c422d3ae7d","receiverRevision":1,"receiverTombstone":false,"revision":1,"schemaVersion":2,"status":"applied","streamKey":"org:org_vector"}',
    revisionCases: [
      { status: "applied", receiverRevision: 1, accepted: true },
      { status: "duplicate", receiverRevision: 1, accepted: true },
      { status: "superseded", receiverRevision: 2, accepted: true },
      { status: "gap", receiverRevision: 1, accepted: false },
      { status: "conflict", receiverRevision: 1, accepted: false },
    ],
  },
} as const;
