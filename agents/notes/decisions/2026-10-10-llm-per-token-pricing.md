# LLM endpoints: per-token pricing, same fee rule

> Date: 2026-10-10 · Status: accepted direction, not built · Decided by: user ("hold a max per call and settle the actual tokens used"; copy OpenRouter's hold sizing)
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

Spec extension shape; behaviour when upstream omits usage; non-OpenAI-shaped LLM APIs.

## Affects

[pricing](../features/pricing.md), [gateway](../features/gateway.md)
