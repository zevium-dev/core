# Codebase reset: rebuild Convex, prune the rest

> Date: 2026-10-10 · Status: accepted direction · Decided by: user ("if you want to delete the entire thing and rebuild from scratch I'm all in") + audit recommendation
> Evidence: [convex](../findings/codebase-audit-convex.md), [gateway](../findings/codebase-audit-gateway.md), [web](../findings/codebase-audit-web.md), [tooling](../findings/codebase-audit-tooling.md)

## Decision

| Area             | Call                                                               | Why                                                                                                                                | Issues                      |
| ---------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Convex (54k LOC) | **Rebuild contract-first**, ~24 tables, port the proven money core | ~13k LOC migration/rollout code for nonexistent data; 86 tables; 16 bugs                                                           | #354 → #353; bugs #355–#358 |
| Gateway (7k)     | **Prune + restructure** to ~3k                                     | Core (wallet hold/settle/refund, caps, header filter, idempotency) is good; ControlDO hop, dead registry, duplicate caches are not | #359 #360 #361              |
| Web (34k)        | **Prune**, rewrite 4 hotspots                                      | UI rules clean; rot is pagination/state-copy patterns                                                                              | #362 #363 #364 #367         |
| Tooling/CI/e2e   | **Prune** ~14k                                                     | Tooling that polices tooling; drill machinery CI never runs                                                                        | #365 #366                   |

Order: tooling prune and Convex deletion first (cheap, unblock everything), then gateway restructure (admit → forward → finalize, needed by x402/routing/LLM), then Convex rebuild behind the same web-facing functions, then web fixes.

## Already done (2026-10-10)

Publisher-copy claims filter and compliance doc deleted ([repo cleanup](2026-10-10-repo-cleanup.md)); all tests green after.

- 2026-10-10 — #354: deleted Convex finance migration/recovery, registry/security rollout, legacy settlement/transfer repair, associated tests, and runtime migration gates; removed 14 dead tables and unused indexes. Preserved money-core invariants, registry identity/reservation seams, and audit-listed tables with verified live references.
