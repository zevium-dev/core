# Registry v2

Status: producer remains; gateway receiver deleted (#359). Updated: 2026-10-10.

Registry v2 describes the existing Convex producer contract. The gateway never implemented a v2 receiver. Its unrelated, unwritten v1 `ControlDO` receiver and per-call gate were deleted; both Wrangler configurations append a `v3` `deleted_classes: ["ControlDO"]` migration. Convex still enqueues v2 events to an absent route; producer/rebuild work is separate.

## Operations

Only these operations are valid:

`org.put`, `org.archive`, `route.put`, `route.archive`, `key.put`, `key.revoke`, `catalogue.snapshot`.

Each stream owns independent positive contiguous `revision` values. There is no global sequence, global hash chain, parked state, or cross-stream predecessor.

## Bytes And Signatures

Event bodies are exact canonical JSON UTF-8, maximum 524,288 bytes. Route specs are JSON values capped at 393,216 UTF-8 bytes. Object keys sort recursively by Unicode code point; arrays preserve order; undefined, non-finite, cyclic, and non-plain values are rejected.

Request signature bytes are `ASCII(timestamp) || 0x2e || ASCII(nonce) || 0x2e || rawCanonicalBody`. ACK signature bytes are `ASCII("ack.") || ASCII(requestTimestamp) || 0x2e || ASCII(requestNonce) || 0x2e || rawCanonicalAckBody`. Nonces are reused for retries, while timestamps and signatures may change.

## Lifecycle

Archive and revoke events are permanent stream tombstones. Route rename increments project generation, archives old alias first, then puts new alias and publishes dependent catalogue snapshot. Old aliases remain unavailable forever.

## Delivery

Outbox rows materialize complete event JSON at source mutation time. Claims use 32-byte random lease tokens and 30-second leases. Stale completion cannot change state. Dead letters block only same-stream successors and explicit dependents; unrelated streams continue.

## Secrets And Keys

Raw API-key secrets never enter Convex arguments, tables, outbox rows, events, logs, vectors, or telemetry. `key.put` carries only `secretSha256`, Clerk key identity, owner and subject identity, independent `budgetId`, lifecycle, caps, and scopes. Publisher credentials use AES-GCM transport envelopes with revision-bound AAD.

## Rollout

Initial registry backfill and security rollout operators were deleted in #354. Fresh deployments reserve routes through normal publish/enqueue operations. The existing producer, outbox, key identity proof, and route reservation remain until the Convex rebuild (#353).

## Implementation notes (moved from former TECH.md)

- **Edge registry producer contract**: `REGISTRY_V2_PRODUCER_CONTRACT` is frozen. Only `org.put`, `org.archive`, `route.put`, `route.archive`, `key.put`, `key.revoke`, and `catalogue.snapshot` exist. Events contain immutable per-stream revisions, event nonce, payload digest, and exact canonical JSON bytes capped at 524,288 UTF-8 bytes; embedded OpenAPI specs cap at 393,216 bytes. HMAC signs `timestamp.nonce.rawBody`; ACKs sign `ack.timestamp.nonce.rawAckBody` and bind every event identity field. No deployment-wide sequence or global poison ordering exists. Outbox leases are token-fenced and expired claims recover after crashes; dependencies block only same-stream predecessors or explicit rename edges. AES-GCM transport envelopes use versioned `GATEWAY_REGISTRY_TRANSPORT_KEYRING`.
- **Receiver deleted (#359)**: `/internal/registry/v1/*`, `control.ts`, `CONTROL` binding and paid-call gate are gone. Unused shared receiver verification, bootstrap, manifest and signed entitlement helpers plus test-only conformance vectors are deleted. API-key projection signing/sealing used by web and helpers imported by Convex remain. Gateway still resolves keys via Clerk and routes via cached Convex reads (30s specs / 60s catalogue); this PR does not activate registry v2 or immediate revocation.
