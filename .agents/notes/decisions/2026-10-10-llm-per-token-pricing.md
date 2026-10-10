# LLM endpoints: per-token pricing, same fee rule

> Date: 2026-10-10 · Status: accepted direction; implemented in #329 · Decided by: user ("hold a max per call and settle the actual tokens used"; copy OpenRouter's hold sizing)
> Session: [2026-10-10](../sessions/2026-10-10-competitive-research-and-docs.md)

## Proposal

- Same 5% publisher-side fee. No special take rate, no parallel pricing table.
- Spec declares per-token pricing: input rate, output rate, and a per-call maximum.
- Gateway reserves the maximum, then settles actual usage and refunds the rest.
- Usage is read from the final streamed chunk (OpenAI-style `usage`) by teeing the stream — no buffering, streaming rule holds.
- Publishers reselling a model at provider list price must mark up themselves; that is their call.
- Zevium does not house-list LLMs (Stripe now owns OpenRouter; not worth the fight).

## Hold sizing (copy OpenRouter)

User: don't hold a lot; do what OpenRouter does. OpenRouter's documented behavior ([limits docs](https://openrouter.ai/docs/api_reference/limits.md), fetched 2026-10-10):

- Estimate each paid request's cost up front at endpoint prices: input tokens + completion tokens allowed by `max_tokens`, or a fixed per-request cap when `max_tokens` is unset.
- Hold the estimate while the request runs, replace it with actual cost in a short settlement window, release the rest.
- In-flight budget = a fraction of current balance, up to a fixed ceiling. A request that doesn't fit gets `402` before reaching the provider, even with a positive balance. `metadata.reason`: `in_flight_budget_exhausted` (transient, `Retry-After`) or `weight_exceeds_budget` (lower `max_tokens`/prompt or add credits).

Zevium mapping: hold = estimate in the wallet DO reservation (existing reserve/settle/refund); zero balance still blocks; reuse the 402 envelope with the two reasons.

## Open

Non-OpenAI-shaped LLM APIs remain unsupported by token metering.

## Affects

[pricing](../features/pricing.md), [gateway](../features/gateway.md)

## Implementation contract (#329)

- `x-zevium-cost: { per: "token", input: 2000, output: 8000, maxPerCall: 1000 }`. Rates are whole credits per million tokens (0–1,000,000); optional `maxPerCall` is a positive whole-credit ceiling, at most 1,000,000. Scalar prices remain per-call. Missing prices remain hidden. No independent pricing table.
- OpenAI-compatible JSON requests only, bounded to 1 MiB. Input estimate is **one token per original UTF-8 request byte**, including JSON overhead; client-supplied prompt counts are not trusted. Hold uses that estimate plus `max_completion_tokens`, otherwise `max_tokens`, otherwise 4,096 output tokens; output limit must be 1–1,000,000. Default output limit is forwarded explicitly. Only one completion (`n: 1`) is supported. Streaming requests get `stream_options.include_usage: true`.
- Hold = ceil((estimated input × input rate + allowed output × output rate) / 1,000,000), limited by `maxPerCall` or the platform ceiling, minimum one credit for a paid token endpoint. Actual = floor((reported prompt tokens × input rate + completion tokens × output rate) / 1,000,000), capped at the hold. Whole-credit rounding follows the existing ledger unit and favors consumers at settlement. Publishers absorb sub-credit fractions and usage beyond the estimate/cap; no overage.
- **Missing, invalid, oversized, interrupted, or timed-out usage charges zero**, releasing the entire hold. Publisher accepts this consumer-favorable fallback. Non-2xx and failed adapter responses use the existing refund path.
- Upstream response bytes go straight to the caller through one tee branch. An asynchronous observer parses final OpenAI SSE usage (65,536 UTF-16 code units per event) or JSON usage (1 MiB observer limit). Observer timeout is five minutes, before the ten-minute wallet lease; failed observation never changes client bytes. Direct responses are never buffered by the forwarding path. Only token-priced request JSON is read before admission; ordinary requests still stream.
- Token admissions enforce wallet in-flight budget = min(floor(current balance / 2), 100,000 credits). All active holds count toward exposure. A single hold above budget returns `402 weight_exceeds_budget`; exhausted remaining budget returns `402 in_flight_budget_exhausted` with `Retry-After: 5`. Reasons appear at top level and in `metadata.reason`. Existing key caps include the full hold; final counters consume only actual credits.
- `x-zevium-hold` reports the reservation, not a final price. Final charge is available in usage after settlement. Free-tier/zero-price calls retain `x-zevium-cost: 0`. The existing durable outbox, immutable spec identity, and 95/5 split remain authoritative. No house LLM listings added.
