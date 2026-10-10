# Zevium agent notes

Committed agent memory. Every piece of development documentation lives here: product direction, features, architecture, design, decisions, research, and what was discussed with agents. Agents are the primary writers and readers. Humans read it too, so keep it navigable.

Code wins. When a note and the code disagree, fix the note in the same change.

## How to read

1. This file — find the area.
2. [product/overview.md](product/overview.md) — what Zevium is and why. [product/roadmap.md](product/roadmap.md) — what matters now.
3. The feature note(s) for the code you are about to touch, in [features/](features/).
4. [architecture/overview.md](architecture/overview.md) only for cross-cutting work.
5. [decisions/](decisions/README.md) when a note says "decided" and you need the why.

## Map

| Dir                               | Holds                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [product/](product/)              | Overview (what, personas, revenue model, positioning, golden paths, non-goals) and roadmap/backlog        |
| [features/](features/)            | One file per feature: Product / Flow / Tech / Decisions / Open questions. Status + code pointers on top   |
| [architecture/](architecture/)    | Cross-cutting tech: overview, web app, dev environment, testing, deploy, registry v2, security/compliance |
| [design/](design/)                | Design system (visual + motion) and cross-cutting UI shell                                                |
| [decisions/](decisions/README.md) | Dated decision log (`YYYY-MM-DD-slug.md`), with index                                                     |
| [research/](research/)            | Market and vendor research. Input to decisions, never itself a decision                                   |
| [sessions/](sessions/)            | Dated logs of substantial user ↔ agent discussions: asked, found, decided, proposed                       |
| [findings/](findings/)            | Lessons and review findings. `values.md` = standing lessons                                               |
| [history/](history/)              | Read-only archive: build plan and wave prompts from the greenfield build. Do not update                   |

## Features

| Feature                                                      | Area                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| [accounts-orgs](features/accounts-orgs.md)                   | Auth, Clerk orgs, roles, invitations, org switcher                       |
| [catalogue-search](features/catalogue-search.md)             | Public catalogue, API detail page, semantic search                       |
| [quality-signals](features/quality-signals.md)               | Badges, health probes, publish gates, suspension                         |
| [reviews](features/reviews.md)                               | Verified consumer reviews                                                |
| [publishing-specs](features/publishing-specs.md)             | Projects, spec editor, import, versioning                                |
| [pricing](features/pricing.md)                               | `x-zevium-*` pricing, revenue split, exchange rate, planned extensions   |
| [listing-lifecycle](features/listing-lifecycle.md)           | Publish, deprecate, sunset, archive, tombstones                          |
| [gateway](features/gateway.md)                               | Metered call path, forwarding boundary, errors                           |
| [upstream-credentials](features/upstream-credentials.md)     | Publisher secrets injected into forwarded calls                          |
| [connected-accounts](features/connected-accounts.md)         | Consumer OAuth connections so APIs act on their behalf (exploring)       |
| [wallet-billing](features/wallet-billing.md)                 | Org wallet, credit ledger, Stripe top-ups, refunds/disputes, usage views |
| [api-keys](features/api-keys.md)                             | Keys, per-key caps, rotation                                             |
| [agent-surface](features/agent-surface.md)                   | MCP endpoint, discovery index, connect-your-agent, agent distribution    |
| [capability-routing](features/capability-routing.md)         | Route by job across interchangeable providers, fallback, max cost        |
| [machine-payments](features/machine-payments.md)             | x402 / keyless wallet sessions (planned), 402 envelopes                  |
| [mock-sandbox](features/mock-sandbox.md)                     | Keyless spec-generated mocks, playground                                 |
| [publisher-analytics](features/publisher-analytics.md)       | Calls, latency, errors, revenue per endpoint                             |
| [earnings-payouts](features/earnings-payouts.md)             | 95% earnings, Stripe Connect onboarding, transfers, payouts              |
| [webhooks-notifications](features/webhooks-notifications.md) | Publisher webhooks, in-app/email notifications                           |
| [platform-admin](features/platform-admin.md)                 | Staff `/admin` tools                                                     |
| [landing-docs](features/landing-docs.md)                     | Landing page, in-app `/docs`, integrate snippets                         |

Status of each feature is in its header line. [roadmap](product/roadmap.md) maps roadmap items to features.

## How to write

**One owner per fact.** Put a fact in the one file that owns it; link from everywhere else. Duplicated facts drift.

| You did / learned                         | Write it in                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Changed a feature's behavior              | That feature note: Status, `Updated:` date, Tech, Code pointers. Same change as the code                                              |
| User made a decision                      | `decisions/YYYY-MM-DD-slug.md` + row in [decisions/README.md](decisions/README.md) + bullet in feature Decisions                      |
| Agent proposed something, user undecided  | Decision file with `Status: proposed`, or feature Open questions                                                                      |
| Substantial discussion / research session | `sessions/YYYY-MM-DD-slug.md` (asked, found, decided, proposed, user preferences observed)                                            |
| Market / vendor research                  | `research/<topic>.md` with sources and dates. Mark ideas as ideas                                                                     |
| Hard-won lesson, review finding           | `findings/<topic>.md`; standing lessons in [findings/values.md](findings/values.md)                                                   |
| Local setup quirk                         | [architecture/dev-environment.md](architecture/dev-environment.md)                                                                    |
| New feature area                          | Copy [features/_template.md](features/_template.md), add a row above                                                                  |
| New work decided                          | Open a GitHub issue in `zevium-dev/core` (priority + `area:*` labels); put `#N` in [roadmap](product/roadmap.md) and the feature note |
| Priority change                           | [product/roadmap.md](product/roadmap.md) — only after the user approves                                                               |

Style:

- Feature notes keep language discipline: Product/Flow = product language; Tech = implementation.
- Terse, dense, exact technical terms. Tables and bullets over prose. No emojis.
- Every claim about current behavior is checked against code. Mark research, proposals, and unverified numbers as such.
- Dates absolute (`2026-10-10`), never "yesterday" or "last week".
- Accepted decisions are never rewritten — supersede with a new file.
- No secrets, tokens, keys, raw customer data, or personal data. Ever.
- `history/` is frozen. Don't edit it; summarize into current notes instead.
