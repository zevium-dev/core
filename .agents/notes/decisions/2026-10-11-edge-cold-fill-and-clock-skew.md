# Edge cold fills and issuance clock skew

Status: accepted; implemented in isolated rebuild PR #441. Date: 2026-10-11.

Parent review decisions:

- A cold or expired authority cache performs one single-flight synchronous fill inside its coordinator DO. Cold caller and fetch budgets are approximately two seconds; warm requests keep using local authority. This includes new keys, routes, orgs, OAuth identities, catalogue manifests and wallet checkpoints. Failure returns unavailable, never stale execution authority or an empty catalogue disguised as success.
- Allow up to 1,000 ms of positive skew on `generatedAt` only. `expiresAt` remains an exact cutoff, with no grace period.

Cost controls accompany cold fill: a shared per-isolate budget permits a burst of 20 fills and refills five permits per second. Missing scopes and invalid OAuth outcomes keep a ten-second negative result, no persisted refresh identity or bearer, and one cleanup alarm. Verified snapshot/OAuth scopes refresh every 15 seconds while active and delete state after 60 seconds idle. Wallet journals remain durable; idle wallets stop polling after five minutes, while holds, pending finals and closing/freeze work keep alarms active.

Supersedes the PR 5 handoff's alarm-only cold-read behavior and zero issuance-skew interpretation. Legacy remains default until PR 7. See [gateway](../features/gateway.md) and [rebuild plan](../architecture/convex-rebuild.md#pr-5-implementation-and-handoff--2026-10-11).
