# Cold refresh budget kept at 20 burst, 5/s

> Date: 2026-10-18 · Status: accepted · Decided by: owner

The per-isolate cold refresh budget stays at a burst of 20 and five permits per second, as set by the [2026-10-11 cold fill decision](2026-10-11-edge-cold-fill-and-clock-skew.md).

The known cost: a brand-new consumer's first call uses about five permits, so one isolate's burst covers about four new consumers before slowing ([finding](../findings/edge-acceptance-cold-budget.md)). Revisit from real traffic metrics before any public announcement or expected traffic spike.

Notes: [gateway](../features/gateway.md), [roadmap](../product/roadmap.md).
