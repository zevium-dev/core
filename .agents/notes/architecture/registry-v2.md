# Registry v2

Registry v2 is one contract shared by Convex producers and gateway receiver.

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

Security rollout is resumable and bounded to ten source rows per production or verification step. Immutable source preimages and event receipts are independently chained and verified before completion. Missing hashes or unsafe credential rows fail closed.

## Implementation notes (moved from former TECH.md)

- **Edge registry producer contract**: `REGISTRY_V2_PRODUCER_CONTRACT` is frozen. Only `org.put`, `org.archive`, `route.put`, `route.archive`, `key.put`, `key.revoke`, and `catalogue.snapshot` exist. Events contain immutable per-stream revisions, event nonce, payload digest, and exact canonical JSON bytes capped at 524,288 UTF-8 bytes; embedded OpenAPI specs cap at 393,216 bytes. HMAC signs `timestamp.nonce.rawBody`; ACKs sign `ack.timestamp.nonce.rawAckBody` and bind every event identity field. No deployment-wide sequence or global poison ordering exists. Outbox leases are token-fenced and expired claims recover after crashes; dependencies block only same-stream predecessors or explicit rename edges. AES-GCM transport envelopes use versioned `GATEWAY_REGISTRY_TRANSPORT_KEYRING`.
- **Initial registry rollout**: `admin:migrateSecurityRollout` starts/resumes one bounded phased job (credentials → every org → every published route → every key → source verifier → event verifier). Production and verification steps each read at most 10 rows. Each source preimage and emitted-event receipt is stored independently with exact `rolloutId`, page, ordinal, bindings, and canonical preimage; unrelated interleaved events never enter rollout provenance. Completion happens only after the separate verifier recomputes exact counts and both domain-separated digest chains from those immutable rows and checks each receipt against its immutable outbox event. Org phase deterministically repairs legacy handle collisions. Existing keys without a safely persisted hash are disabled and require forced replacement; no synthetic legacy operation is accepted. Transitional provenance fields are optional-first in schema, but legacy rows fail closed at runtime until upgraded.
- **Receiver status — not implemented here**: shared v2 contract and credential-free conformance vectors reserve `POST /internal/registry/v2/events` and `/internal/registry/v2/bootstrap`, exact signature/nonce/ACK rules, stateful bootstrap application, terminal kill joins, contiguous sequence recovery, and transport credential handling. Gateway still uses Clerk key verification plus 30s spec / 60s catalogue and wallet-sync windows around Convex-backed reads. Receiver storage, nonce replay state, revision/gap application, receiver-at-rest encryption, signed ACK transport, bootstrap HTTP transport, registry-DO lookup, immediate edge archive propagation, and raw-key issue/rotate/revoke wiring remain cutover blockers.
