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
