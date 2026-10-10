# Review eligibility: any org that used the API once (tighten later)

> Date: 2026-10-10 · Status: built (#319) · Decided by: user
> Session: [2026-10-10](../sessions/2026-10-10-competitive-research-and-docs.md)

## Decision

- **Now**: any consumer org that made at least one successful call to the API — free-tier calls included — may review it.
- **Later (planned)**: tighten against spam/fake reviews, e.g. org must have topped up at least $20 in the last year. Threshold not final.

## Implementation — 2026-10-10

Both viewer state and review writes accept gateway-proven successful paid, free-tier, and zero-price calls. Failed/refunded/unproven usage does not qualify. One active review per consumer org, publisher self-review rejection, and audited moderation remain unchanged.

## Affects

[reviews](../features/reviews.md)
