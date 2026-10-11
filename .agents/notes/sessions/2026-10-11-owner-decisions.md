# Owner answers to rebuild and capability-routing questions

> Date: 2026-10-11 · Type: owner decisions; documentation and issue updates only
> Context: [Convex rebuild plan PR #394](https://github.com/zevium-dev/core/pull/394), branch `t3/convex-rebuild-plan`, `.agents/notes/architecture/convex-rebuild.md`; [capability design PR #372](https://github.com/zevium-dev/core/pull/372), [design](../design/capability-routing.md)

## Asked and decided

Owner supplied answers to the open money/authority questions in PR #394 and routing questions in #372. The decision files own policy; this map connects the original question numbers to their answers and delivery work.

| Owner item                                   | Decision                                                                                                                                                                        | Delivery                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1. Edge authority                            | [DO authority, 30s snapshots, freeze/drain, no fixed-price debt; lost-DO availability cost accepted, no global revoke path](../decisions/2026-10-11-edge-authority-and-lots.md) | P0 #353                                                                                |
| 2. Funding slices and dust                   | [At most 32 slices, traceable same-expiry dust merge, no resumable allocator](../decisions/2026-10-11-edge-authority-and-lots.md)                                               | P0 #430 within #353                                                                    |
| 3. Signup                                    | [Only signup auto-created personal org, once per user](../decisions/2026-10-11-signup-credit-eligibility.md)                                                                    | P0 #426; supersedes #317 eligibility                                                   |
| 4. Card fees/refunds                         | [Estimate, no true-up, refund full paid amount including fee](../decisions/2026-10-11-card-fee-and-refunds.md)                                                                  | P0 #318; legal gate retained                                                           |
| 5–6. LLM scope/rounding                      | [Defer entirely; preserve future hold/debt/cancel/usage and precision questions](../decisions/2026-10-11-llm-deferred.md)                                                       | P0 #425 disable; P2 #431 revival                                                       |
| 7. Risk release                              | [Daily buckets, up to ~24h after seven-day hold](../decisions/2026-10-11-publisher-risk-release.md)                                                                             | P0 #353                                                                                |
| 8. Contracts                                 | [Publisher OpenAPI contract; generated surfaces and form playground](../decisions/2026-10-11-openapi-as-contract.md)                                                            | P0 #428, existing P1 #110, P1 #427; existing P2 #350                                   |
| 9–12. Routing/budgets/maps/ranking/suppliers | [Defer; one listing → one upstream; publisher owns failover](../decisions/2026-10-11-capability-routing-deferred.md)                                                            | #327/#328 relabeled P2; #372 retained                                                  |
| 13. x402                                     | [Off for now; activation deferred](../decisions/2026-10-11-x402-disabled.md)                                                                                                    | P1 #424 enforcement + [runbook](../architecture/x402-enablement.md); #109 relabeled P2 |
| 14. Breakage                                 | [Expired anonymous money is revenue; no expiry warnings/display](../decisions/2026-10-11-breakage-revenue.md)                                                                   | #353 accounting; #424 future enablement acceptance                                     |
| 15. House supply                             | [Ordinary publisher 95/5, optional total cap; RapidAPI excluded](../decisions/2026-10-11-house-listing-accounting.md)                                                           | Existing #313/#314 updated; optional P2 #429                                           |

## Found and retained

- Existing #110 covers listing-scoped MCP generation; #350 covers SDKs only. New #428 fills shared converter/CLI/docs scope instead of duplicating those implementations.
- Current signup code proves creator identity, not the signup personal-org relationship. #426 records that gap.
- Current x402 rail is configuration-gated and token pricing code is present. This docs-only PR does not disable either; #424/#425 own enforcement.
- Recorded [resale research](../research/house-listing-resale-terms.md) excludes RapidAPI under its standard terms. No new supplier rights granted.
- Existing 2026-10-10 decisions remain as history with superseding annotations. Rebuild plan stays on its own branch; its owner questions should be read with this map. No runtime implementation or deployment is claimed.

## Proposed or unresolved

Dust threshold $0.10/1,000 credits, future LLM hold ~$0.10 and floor ~-$1 are approximate/proposed values. LLM usage reconciliation and precision require a revival decision and an explicit amendment to “Never surprise-overage.” Future x402 facilitator/finality configuration remains to be chosen. These do not block fixed-price launch scope.

Owner preferences: agent distribution stays P0; x402 and capability routing leave P0; keep routing/ranking small; optional subsidy cap must not become an infrastructure project. No code changes requested in this task.
