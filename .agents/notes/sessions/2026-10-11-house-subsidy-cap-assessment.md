# House subsidy cap assessment — #429

> Date: 2026-10-11 · Outcome: skipped under the owner's simplicity condition
> Base inspected: `origin/develop` at `53a2f552`
> Issue: [#429](https://github.com/zevium-dev/core/issues/429)
> Policy: [ordinary house publisher accounting](../decisions/2026-10-11-house-listing-accounting.md)

## Request and outcome

Assess within a 10-minute investigation whether a $100/month total house-listing subsidy cutoff fits the rebuilt Convex and wallet DO plane as a modest change. Subsidy means upstream cost minus consumer receipts; ordinary 95/5 accounting must remain intact. Skip if execution-path changes, new contention, or substantial implementation are necessary.

Skipped. No runtime code, schema, environment variable, deployment, or tests changed. The existing sharded rollups and signed route refresh path are useful building blocks, but they do not contain sufficient upstream billing evidence. Counting successful settlements alone would understate some costs; counting every reservation would invent costs for calls that never reached upstream. Owner explicitly accepts losses when this is not simple; the cap remains no launch gate.

## Code evidence

- `apps/gateway/src/forward.ts`: upstream fetch and MCP response preparation share one catch. A successful upstream response followed by adapter buffering failure becomes the same failure result as a fetch failure. The upstream may have charged even though the consumer is refunded.
- `apps/gateway/src/next/wallet.ts` (`finalize`): finalization receives HTTP status, latency, and `recoveryUnknown`; its settlement contract contains no upstream execution/billable-cost fact. Crash recovery cannot establish whether admitted work reached upstream.
- `convex/money/settle.ts`: normal settlement validates the immutable spec and records earnings/rollups idempotently. `recordException` stores a zero-debit event and reconciliation evidence, then advances the watermark without ordinary rollups. An upstream cost can exist despite zero consumer debit. A new cost counter only in `recordRollups` would miss these cases.
- `convex/money/rollups.ts` and `convex/schema/settlement.ts`: existing totals are daily/lifetime, with 128 shards for platform and publisher totals. No house cost or monthly subsidy aggregate exists. Extending existing platform daily rows could avoid new contended writes, but month reads can involve up to 31 × 128 = 3,968 rows. A smaller fan-in requires a new monthly projection, not an existing counter.
- `convex/edgeSnapshots.ts` and `packages/shared/src/edge/snapshots.ts`: `houseOperated` is catalogue metadata; executable route snapshots have no subsidy gate. A signed gate can fit existing refreshes without an extra warm-request network call. Their 30-second authority plus asynchronous settlement means this would be an eventual cutoff, not a strict spend ceiling. That lag alone is not the reason for skipping: the requested example already permits settlement-driven gating.

## Minimal future design — proposal only

1. Restrict fixed upstream pricing to trusted Zevium-operated listings. Validate an operation-level `x-zevium-house-upstream-cost` in immutable specs, in explicitly documented integer accounting units. Define billable attempts, refunds, ambiguous execution, promotional funding, and receipt adjustments before treating the value as actual subsidy.
2. Preserve upstream execution/cost evidence independently of consumer response preparation. Make exception/recovery cost treatment explicit; unknown execution must not silently become zero cost. This requires changes in the forwarding/finalization path and settlement contract, which disqualifies this attempt under the owner's limit.
3. Attribute each call consistently to a UTC calendar month, using its admission time and immutable spec. Record idempotent upstream cost and consumer receipts separately; compute their aggregate difference, not publisher net earnings and not a sum of per-call positive-only losses. Reuse 128 settlement-reference shards in `usageRollups`; add a dedicated monthly projection only if its bounded read/write budget is justified. Never update one global counter per call.
4. Read the bounded month total when issuing existing route snapshots. Include the month and a house-only unavailable reason; return `503 house_subsidy_cap_reached` with a readable monthly-limit message before wallet reservation/upstream execution. One Convex variable, `HOUSE_SUBSIDY_CAP_USD`, would default to `100`. At UTC rollover, fresh snapshots use the new month and reopen routes; preserve ordinary retirement/visibility gates.
5. Test duplicate settlement, upstream success followed by MCP failure, recovery/exception handling, threshold refusal, non-house isolation, UTC rollover, bounded shard access, and no additional warm-path network calls. Document settlement/authority lag and possible overshoot. A strict $100 ceiling would instead require coordinated reservations or allocated budgets and is outside this proposal.

## Validation

`pnpm install` completed in the isolated `subsidy-cap` worktree. Assessment used source inspection, not a runtime proof. Implementation tests and `ci:pr` were not run because implementation was deliberately skipped. Local documentation formatting and diff checks cover the recorded outcome.
