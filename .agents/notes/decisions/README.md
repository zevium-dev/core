# Decision log

One file per decision: `YYYY-MM-DD-slug.md`. Newest last. Never rewrite an accepted decision — supersede it with a new file and mark the old one `superseded by <link>`.

Statuses: `proposed` (awaiting user) · `accepted` · `accepted direction, not built` · `superseded` · `deferred` (future work).

| Date       | Decision                                                                                             | Status                                 |
| ---------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 2026-07-11 | [Build scope and editor direction](2026-07-11-build-scope.md)                                        | accepted                               |
| 2026-07-12 | [Greenfield stack](2026-07-12-stack.md)                                                              | accepted (built)                       |
| 2026-07-12 | [Payout MVP and in-app docs](2026-07-12-payouts-and-docs.md)                                         | payouts superseded; docs built         |
| 2026-07-19 | [Launch readiness before more surface](2026-07-19-launch-readiness-first.md)                         | accepted                               |
| 2026-10-10 | [Platform fee from publisher side](2026-10-10-platform-fee-publisher-side.md)                        | accepted                               |
| 2026-10-10 | [Card-fee floor on top-ups](2026-10-10-card-fee-floor.md)                                            | superseded                             |
| 2026-10-10 | [LLM per-token pricing](2026-10-10-llm-per-token-pricing.md)                                         | superseded 2026-10-11                  |
| 2026-10-10 | [Two rails: keys + keyless x402](2026-10-10-dual-rail-keys-and-x402.md)                              | superseded 2026-10-11                  |
| 2026-10-10 | [Anonymous wallet expiry: 1 year](2026-10-10-anonymous-wallet-expiry.md)                             | partially superseded 2026-10-11        |
| 2026-10-10 | [Docs become .agents/notes](2026-10-10-agents-notes-docs.md)                                         | accepted (done)                        |
| 2026-10-10 | [Repo cleanup: dead tooling + legacy files](2026-10-10-repo-cleanup.md)                              | accepted (done)                        |
| 2026-10-10 | [Card fee passed through at cost](2026-10-10-card-fee-passthrough.md)                                | superseded 2026-10-11                  |
| 2026-10-10 | [Default signup credit (~$1)](2026-10-10-signup-credit.md)                                           | superseded 2026-10-11                  |
| 2026-10-10 | [P0: x402, distribution, capability routing](2026-10-10-p0-agent-bet.md)                             | partially superseded 2026-10-11        |
| 2026-10-10 | [House supply via treg/RapidAPI](2026-10-10-house-supply-via-aggregators.md)                         | partially superseded 2026-10-11        |
| 2026-10-10 | [Unpriced operations hidden + not callable](2026-10-10-unpriced-operations-hidden.md)                | built (#316)                           |
| 2026-10-10 | [No BYOK; explore connected accounts](2026-10-10-no-byok-connected-accounts.md)                      | accepted / exploring                   |
| 2026-10-10 | [Email via Resend](2026-10-10-email-resend.md)                                                       | accepted, not built                    |
| 2026-10-10 | [Two roles: admin + member](2026-10-10-two-roles-admin-member.md)                                    | accepted                               |
| 2026-10-10 | [Review eligibility](2026-10-10-review-eligibility.md)                                               | built (#319)                           |
| 2026-10-10 | [Codebase reset: rebuild Convex, prune rest](2026-10-10-codebase-reset.md)                           | accepted direction                     |
| 2026-10-10 | [Capability taxonomy and normalized web search](2026-10-10-capability-taxonomy.md)                   | deferred (P2)                          |
| 2026-10-11 | [Edge spend authority and bounded funding lots](2026-10-11-edge-authority-and-lots.md)               | accepted; delivery pending             |
| 2026-10-11 | [Signup credit belongs only to the signup personal org](2026-10-11-signup-credit-eligibility.md)     | accepted; delivery pending             |
| 2026-10-11 | [Estimated checkout card fee and full paid-amount refunds](2026-10-11-card-fee-and-refunds.md)       | accepted; delivery pending             |
| 2026-10-11 | [Defer LLM listings and preserve revival policy](2026-10-11-llm-deferred.md)                         | accepted deferral; enforcement tracked |
| 2026-10-11 | [Accept daily publisher risk-release buckets](2026-10-11-publisher-risk-release.md)                  | accepted; delivery pending             |
| 2026-10-11 | [Publisher OpenAPI is the contract for every surface](2026-10-11-openapi-as-contract.md)             | accepted; delivery pending             |
| 2026-10-11 | [Defer capability routing; keep one upstream per listing](2026-10-11-capability-routing-deferred.md) | accepted deferral; enforcement tracked |
| 2026-10-11 | [Disable x402 and retain an enablement runbook](2026-10-11-x402-disabled.md)                         | accepted deferral; enforcement tracked |
| 2026-10-11 | [Expired anonymous wallet money is Zevium revenue](2026-10-11-breakage-revenue.md)                   | accepted; delivery pending             |
| 2026-10-11 | [House listings use ordinary publisher accounting](2026-10-11-house-listing-accounting.md)           | accepted; delivery pending             |
| Date       | Decision                                                                                             | Status                                 |
| ---------- | ------------------------------------------------------------------------------------------           | ------------------------------         |
| 2026-07-11 | [Build scope and editor direction](2026-07-11-build-scope.md)                                        | accepted                               |
| 2026-07-12 | [Greenfield stack](2026-07-12-stack.md)                                                              | accepted (built)                       |
| 2026-07-12 | [Payout MVP and in-app docs](2026-07-12-payouts-and-docs.md)                                         | payouts superseded; docs built         |
| 2026-07-19 | [Launch readiness before more surface](2026-07-19-launch-readiness-first.md)                         | accepted                               |
| 2026-10-10 | [Platform fee from publisher side](2026-10-10-platform-fee-publisher-side.md)                        | accepted                               |
| 2026-10-10 | [Card-fee floor on top-ups](2026-10-10-card-fee-floor.md)                                            | superseded                             |
| 2026-10-10 | [LLM per-token pricing](2026-10-10-llm-per-token-pricing.md)                                         | accepted; built #329                   |
| 2026-10-10 | [Two rails: keys + keyless x402](2026-10-10-dual-rail-keys-and-x402.md)                              | built; activation pending              |
| 2026-10-10 | [Anonymous wallet expiry: 1 year](2026-10-10-anonymous-wallet-expiry.md)                             | built (#109)                           |
| 2026-10-10 | [Docs become .agents/notes](2026-10-10-agents-notes-docs.md)                                         | accepted (done)                        |
| 2026-10-10 | [Repo cleanup: dead tooling + legacy files](2026-10-10-repo-cleanup.md)                              | accepted (done)                        |
| 2026-10-10 | [Card fee passed through at cost](2026-10-10-card-fee-passthrough.md)                                | accepted direction, not built          |
| 2026-10-10 | [Default signup credit (~$1)](2026-10-10-signup-credit.md)                                           | built (#317)                           |
| 2026-10-10 | [P0: x402, distribution, capability routing](2026-10-10-p0-agent-bet.md)                             | accepted                               |
| 2026-10-10 | [House supply via treg/RapidAPI](2026-10-10-house-supply-via-aggregators.md)                         | accepted direction, not built          |
| 2026-10-10 | [Unpriced operations hidden + not callable](2026-10-10-unpriced-operations-hidden.md)                | built (#316)                           |
| 2026-10-10 | [No BYOK; explore connected accounts](2026-10-10-no-byok-connected-accounts.md)                      | accepted / exploring                   |
| 2026-10-10 | [Email via Resend](2026-10-10-email-resend.md)                                                       | accepted, not built                    |
| 2026-10-10 | [Two roles: admin + member](2026-10-10-two-roles-admin-member.md)                                    | accepted                               |
| 2026-10-10 | [Review eligibility](2026-10-10-review-eligibility.md)                                               | built (#319)                           |
| 2026-10-10 | [Codebase reset: rebuild Convex, prune rest](2026-10-10-codebase-reset.md)                           | accepted direction                     |
| 2026-10-10 | [Capability taxonomy and normalized web search](2026-10-10-capability-taxonomy.md)                   | proposed (awaiting user)               |
| 2026-10-11 | [Signup credit: first organization created](2026-10-11-signup-credit-first-created-org.md)           | accepted; #434                         |
| 2026-10-11 | [Convex rebuild: preserve durable facts](2026-10-11-convex-rebuild-durable-facts.md)                 | accepted; isolated schema built        |
| 2026-10-11 | [Promo self-consumption protection](2026-10-11-promo-self-consumption.md)                            | proposed; guard built                  |
| 2026-10-11 | [PR 4 payment review defaults](2026-10-11-payment-review-defaults.md)                                | proposed; pending owner sign-off       |
| 2026-10-11 | [Edge cold fills and issuance clock skew](2026-10-11-edge-cold-fill-and-clock-skew.md)               | accepted (built in PR #441)            |
| 2026-10-11 | [PR #442 read-surface review defaults](2026-10-11-read-surface-review-defaults.md)                   | proposed; applied in next preview      |
| 2026-10-11 | [Legacy wallet cutover data](2026-10-11-legacy-wallet-discard.md)                                    | accepted; v6 sign-off pending          |
| 2026-10-11 | [Connected accounts are the OAuth priority (API only)](2026-10-11-connected-accounts-oauth.md)       | accepted; build choices superseded     |
| 2026-10-11 | [Zevium owns one OAuth client per provider](2026-10-11-zevium-owned-oauth-clients.md)                | accepted; 37th table pending sign-off  |
| 2026-10-13 | [CLI ships as a plain Node script](2026-10-13-cli-node-script.md)                                    | accepted; built, owner release pending |
| 2026-10-13 | [CLI supports Node 22 LTS](2026-10-13-cli-node-22-lts.md)                                            | accepted (built)                       |
| 2026-10-17 | [MCP `call_api` splits into read/write](2026-10-17-mcp-call-api-read-write-split.md)                 | accepted (built)                       |
| 2026-10-17 | [MCP tools take no `key` argument](2026-10-17-mcp-no-key-argument.md)                                | accepted (built)                       |
| 2026-10-17 | [First OAuth MCP connect auto-creates the key](2026-10-17-mcp-auto-created-key.md)                   | accepted (built)                       |
| 2026-10-17 | [Claude Connectors Directory submission deferred](2026-10-17-connectors-directory-deferred.md)       | deferred                               |
| 2026-10-17 | [Legal and support pages ship as work in progress](2026-10-17-legal-pages-wip.md)                    | accepted; built, email pending owner   |
