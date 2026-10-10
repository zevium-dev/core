# Zevium vs treg.to

> Date: 2026-10-10 · Type: research (not decisions)
> Sources: [treg.to](https://treg.to), [treg.to/llms.txt](https://treg.to/llms.txt), [github.com/superdesigndev/treg](https://github.com/superdesigndev/treg) at `a82d66de`
> Earlier code-level reuse review: [findings/treg-reuse.md](../findings/treg-reuse.md) (license blocks copying; no treg material reused)

## What treg is

"OpenRouter for agent tools": one token, ~3,800 endpoints from 111 providers. treg holds vendor accounts itself and resells per call (claims no markup; earns on negotiated volume pricing). $1 free credit. SEO/growth/enrichment/ads focus.

## Comparison

|                 | treg                                                                                                                 | Zevium                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Model           | Operator is the publisher; supply solved day one                                                                     | Two-sided marketplace; supply zero                                                        |
| Agent entry     | `llms.txt` setup link, `install.sh` CLI, Claude Code plugin, skills.sh, claude.ai connector at `/mcp/v2/` with OAuth | `/mcp` (search_apis, get_api_docs, call_api), `/discovery`; no OAuth, no llms.txt, no CLI |
| Selection       | Search by job; per-provider price, observed success, median speed, last success                                      | Per-listing badges; no routing on them                                                    |
| Routing         | `treg.<capability>` tools choose provider, fall back on errors, respect cost cap                                     | Provider fallback is P2 #22                                                               |
| Money knobs     | `X-Treg-Cost-Micro`, `X-Treg-Route-Max-Cost`, 402 when broke, Idempotency-Key, cache hit at 10% price                | Prepaid org wallet in edge DO, ledger, Connect payouts (stronger)                         |
| Resell          | `X-Treg-Meta` tags, per-tag budgets, customer-pinned tokens                                                          | Org wallet + per-key caps; no end-customer attribution                                    |
| BYOK            | Own key always wins, unmetered                                                                                       | Conflicts with no-unmetered-paths rule                                                    |
| Publisher earns | Nobody                                                                                                               | 95%                                                                                       |

## Ideas raised (not decided)

1. Zevium-operated house listings where resale ToS allows, to break cold start.
2. Capability-level routing (`x-zevium-capability`, max-cost, fallback on 429/5xx/timeout only).
3. x402/MPP rail (now decided as direction: [dual rail](../decisions/2026-10-10-dual-rail-keys-and-x402.md)).
4. Agent distribution: llms.txt, MCP OAuth, Connectors Directory, Claude Code plugin, one-line install.
5. Reseller primitives: meta tags, per-tag budgets, end-customer keys.
6. `x-zevium-cache` publisher-opt-in cache pricing.
7. Pick one vertical treg doesn't own.
8. Infra freeze until 20 listings + 100 external paid agent calls.
9. BYOK with small routing fee (keeps metering rule) — open.
