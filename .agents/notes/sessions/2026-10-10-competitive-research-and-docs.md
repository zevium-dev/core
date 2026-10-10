# 2026-10-10 — Competitive research, pricing direction, docs restructure

> Participants: user (tnfssc), Claude (Opus 5.5)
> Outputs: [treg comparison](../research/treg-comparison.md), [landscape report](../research/agent-api-marketplace-landscape.md), decisions dated 2026-10-10 in [decisions/](../decisions/README.md)

## Asked

1. Compare Zevium with treg.to; "take Zevium to the next level", be bold.
2. Research more competitors beyond treg.
3. Settle fee side, LLM endpoints, keyless x402.
4. Set anonymous wallet expiry; move all docs to `.agents/notes/` as committed agent memory.

## Findings (short)

- treg: operator-held vendor accounts give 3,800 endpoints on day one; Zevium has strong plumbing and zero supply. Cold start is the core risk.
- Landscape: no scaled competitor pays publishers 95%; big MCP directories pay authors nothing; RapidAPI now takes 25%. Billing/gateway plumbing is commodity (Zuplo, Kong, Cloudflare). Threats: Stripe (OpenRouter + Metronome + MPP), Cloudflare Monetization Gateway, Apify.
- Card fees exceed the 5% cut on small top-ups.
- x402 per-call on-chain settlement does not fit sub-cent calls; wallet sessions do.

## Decided

- Fee from publisher side; consumer pays face value. → [decision](../decisions/2026-10-10-platform-fee-publisher-side.md)
- Both rails: keys for enterprise, keyless x402 for individuals/agents. → [decision](../decisions/2026-10-10-dual-rail-keys-and-x402.md)
- Anonymous wallet balance expires in one year, revisitable. → [decision](../decisions/2026-10-10-anonymous-wallet-expiry.md)
- Docs restructure into `.agents/notes/`. → [decision](../decisions/2026-10-10-agents-notes-docs.md)
- Delete junk tooling/files; keep `t3.json`. → [decision](../decisions/2026-10-10-repo-cleanup.md)

### Later the same session

- Card fee: pass processing fee through at cost, transparent line item, OpenCode Zen style. Supersedes min-top-up proposal. → [decision](../decisions/2026-10-10-card-fee-passthrough.md)
- Free tier at $0: solved by ~$1 default credit for new orgs. → [decision](../decisions/2026-10-10-signup-credit.md)
- P0: x402 rail, agent distribution, capability routing. Infra freeze not approved. → [decision](../decisions/2026-10-10-p0-agent-bet.md)
- Supply: house listings via treg then RapidAPI, eat losses, build own over time. → [decision](../decisions/2026-10-10-house-supply-via-aggregators.md)

### Third round

- Signup credit confirmed: $1 once per org.
- House listings labeled "Operated by Zevium".
- Anonymous balance expires per top-up, one year after each top-up.
- LLM per-token: accepted; hold sizing copies OpenRouter (estimate input + `max_tokens`, settle actual).
- No price = not visible, not callable; explicit `0` = free.
- No BYOK for now; explore OAuth connected accounts (post on user's behalf).
- Email via Resend; key later.
- Two roles (admin, member); analytics + webhook delivery history admin-only; full permissions later.
- Reviews: anyone with one successful call now; tighten later (e.g. $20 topped up in last year).
- Deleted `paseo.json` and 60 old run logs.

### Fourth round

- Opened roadmap issues #313–#352 and audit issues #353–#367; closed #103.
- Codebase audit (4 areas): rebuild Convex, prune gateway/web/tooling. → [decision](../decisions/2026-10-10-codebase-reset.md)
- Greenfield, no compliance: deleted publisher-copy claims filter (~3.3k LOC) and compliance doc.
- User wants short answers (TLDR first).

## Proposed, not accepted

- No house LLM listings (part of LLM decision; not explicitly confirmed).

## User preferences observed

- Consumer-friendly economics over publisher-friendly; transparency over hidden fees (OpenCode Zen as model, not OpenRouter).
- Willing to subsidize early supply (eat losses) to beat cold start.
- Targets both enterprises and individual users.
- Wants junk removed aggressively; relies on T3 (`t3.json`) for workspace.
- Wants bold strategy, but earlier pushback ("dont feed me slop") on feature shopping without evidence — see [findings/values.md](../findings/values.md).
