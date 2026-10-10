# Dogfood round 2 — 2026-10-10

> Baseline: `origin/develop` at `75633792` in isolated `dogfood-2` worktree. Browser journeys plus live local gateway/MCP requests. Product code unchanged.
> Result: **10 requested round-one findings fixed; #396 partially fixed and reopened; 2 new confirmed issues (#416, #417).** Publisher and funded consumer/MCP paths work. Fresh signup and hosted Checkout remain unverified because of external test-environment blockers.

## Environment and limits

- Node 24.15.0 / pnpm 11.8.0; frozen install; normal `pnpm dev`, including Convex typechecking. Web `localhost:3000`, gateway `localhost:8787`, isolated anonymous Convex `127.0.0.1:3210` / HTTP actions `3211`. No functions or data written to the shared Convex deployment.
- Clerk test instance; separate browser sessions and newly created publisher/consumer organizations under the seeded test identity. **Not a two-identity RBAC test.** UI-created keys, without provider-key fixtures or imported key settings.
- Fresh test-account signup encountered Clerk's Cloudflare browser challenge and did not complete. Continued with the seed identity via email test OTP; did not reset the shared password.
- Clerk cannot deliver webhooks to localhost. Signup-credit verification used a **synthetic, locally signed `organization.created` webhook** for the UI-created consumer organization and seed creator. Replaying the identical event produced one grant. This verifies local projection/idempotency and downstream spending, not end-to-end provider webhook delivery or fresh-account eligibility.
- Copied Stripe credentials were test-mode but expired (`api_key_expired`). Both CLI listener authentication and Checkout creation failed. No payment, refund, transfer, payout, or production account was created. Billing showed the safe message `Could not start secure checkout.`
- MCP OAuth, x402 wallet sessions, and Resend were not activated. These configuration-gated flows are **unverified**, not reported as product failures.
- Production browsing was anonymous only. Observed production web release `91784e45f1e2e4cf4d458baa13689cc5298e60fb`, older than this baseline; its docs still lacked a main landmark and `/llms.txt` returned 404. Current-develop judgments below use the local build.
- All logs, browser captures, test credentials and scripts stayed in ignored `.tmp/`. Shared Git exclude contains `.tmp/`. No secrets, provider identifiers, or raw echo payloads are committed.

## Round-one verification

#385 was excluded from standalone re-verification as requested. Normal startup and UI key issuance were nevertheless exercised as necessary parts of the golden paths. Numbers in the range that were PRs, rather than findings, are not extra issue targets.

| Issue                                                 | Result                                     | Evidence on `75633792`                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#384](https://github.com/zevium-dev/core/issues/384) | Fixed                                      | Documented `pnpm seed` succeeded without a scratch-script workaround; existing test user, org and membership reused.                                                                                                                                                                                                |
| [#386](https://github.com/zevium-dev/core/issues/386) | Fixed                                      | Local `/docs` has one main landmark.                                                                                                                                                                                                                                                                                |
| [#387](https://github.com/zevium-dev/core/issues/387) | Fixed                                      | Authenticated workspace, live queries and mutations loaded against loopback Convex without a CSP bypass.                                                                                                                                                                                                            |
| [#389](https://github.com/zevium-dev/core/issues/389) | Fixed                                      | Stored harmless publisher credential first; health check passed; normal Publish created immutable version `1.0.0` with credential still present.                                                                                                                                                                    |
| [#392](https://github.com/zevium-dev/core/issues/392) | Fixed                                      | Discovery, MCP search/docs, listing setup and `/llms.txt` advertised `http://localhost:8787`. Separate recovery-link bug: #417.                                                                                                                                                                                     |
| [#393](https://github.com/zevium-dev/core/issues/393) | Fixed                                      | `spec.published` and publisher `project.visibility_changed` each delivered to the test echo receiver in one attempt.                                                                                                                                                                                                |
| [#395](https://github.com/zevium-dev/core/issues/395) | Fixed                                      | Paid MCP `/get?message=paid-mcp` succeeded; structured repeated query values reached upstream as an array. Charged 7 credits.                                                                                                                                                                                       |
| [#396](https://github.com/zevium-dev/core/issues/396) | Still broken in monthly-cap case; reopened | Original empty-wallet case passes: reason, actions, available balance and required credits survive. Monthly-cap 402 retains only `key_cap_exceeded`, dropping the direct gateway's safe explanation and recovery guidance. [Retest comment](https://github.com/zevium-dev/core/issues/396#issuecomment-6099935655). |
| [#397](https://github.com/zevium-dev/core/issues/397) | Fixed                                      | App has `navigation "App navigation"`; project settings expose level-2 section headings below the project h1, with recent deliveries at level 3. Account/key settings also expose the expected h1/h2 hierarchy.                                                                                                     |
| [#398](https://github.com/zevium-dev/core/issues/398) | Fixed                                      | Two paid 7-credit calls show 13.30 net credits in both Analytics and Earnings, including project and organization totals.                                                                                                                                                                                           |
| [#399](https://github.com/zevium-dev/core/issues/399) | Fixed                                      | Inline `-1` shows `Enter a whole number from 0 to 1,000,000.` while the field remains enabled; correcting to 7 works.                                                                                                                                                                                               |

## Journeys

### Visitor and publisher

- Production landing/catalogue remained understandable; one public listing. Catalogue at 390 × 844 had equal viewport/scroll width (390 px). This was not a full accessibility audit.
- Created publisher organization and project through the UI. Added a write-only harmless upstream header and a webhook receiver before publication.
- Pasted OpenAPI 3.0.3 for the public HTTP echo service: GET `/get` at 7 credits with one free call/day; safe health GET `/status/200` at explicit zero; unpriced GET `/uuid`; POST `/post` with token rates of 100,000 input / 200,000 output credits per million tokens and a 50-credit hold ceiling.
- Editor rejected malformed JSON and an out-of-range token rate with useful validation. Valid spec autosaved. Unpriced operation warned that it would be hidden. Token pricing displayed explicitly rather than pretending to be a fixed per-call cost.
- Publication required completing isolated-backend configuration: credential encryption uses a canonical 32-byte base64 key; registry transport used a 32-byte hex key. An omitted/malformed registry key blocked publication until corrected. These were setup mistakes, not a recurrence of #389 or product-code workarounds.
- Published `1.0.0`, made it public, found it in catalogue/discovery. Credential remained stored throughout publication and was echoed only by the deliberately configured test upstream during authenticated calls.
- Public operation picker, discovery and MCP docs contained the three explicitly priced operations; `/uuid` was absent. Direct `/uuid` and its anonymous mock returned 404. Priced anonymous mock returned 200 with `x-zevium-mock: 1`, cost 0 and generated response shape.
- Quality started at `API quality: insufficient data (0/20)` and `Reachability: insufficient data (0/3)`. After real calls, publisher Quality showed measured 100.0% API success and latency, while declared-health reachability still correctly lacked enough samples. No false 0% or unsupported uptime claim observed.

### Consumer and accounting

- Created consumer organization and key through normal UI; copied the secret once. Publisher key screen did not list the consumer key despite the shared human identity.
- Empty consumer wallet blocked both the free-tier operation and explicit zero-price health operation with 402. A separate zero-wallet token call also blocked, preserving `available: 0, requiredCredits: 11` in MCP.
- Synthetic local Clerk creation webhook granted 10,000 promotional credits. Duplicate replay did not increase the balance. Billing showed 10,000 credits and no Stripe payments.
- A wallet already cached at zero required the normal control-plane refresh before it recognized the grant. One immediate playground retry still returned 402; the following direct call succeeded. No forced edge grant or wallet data patch was used.
- First successful `/get` call used the free tier (`x-zevium-cost: 0`, `x-zevium-free-tier: 1`). Direct and MCP paid calls then charged 7 credits each. Both preserved query input and the publisher header; consumer Authorization was not forwarded.
- Token-priced POST returned 200 with `x-zevium-hold: 13`. Echo response had no OpenAI usage object, so settlement charged zero and released the hold. **Actual nonzero token usage and SSE metering were not tested.**
- Billing converged to 9,986 credits, 4 successful calls and 14 spent; per-member/key/API/endpoint breakdowns agreed. Publisher Analytics and Earnings both showed 13.30 net credits. The free and missing-usage calls counted in analytics but did not create paid publisher earnings.
- Submitted a consumer review successfully after successful calls. It displayed as a verified consumer review. Because paid calls occurred before submission, this is **not an isolated free-tier-only eligibility test**.
- Burst of 70 requests to the valid zero-price health endpoint returned exactly 60 HTTP 200 and 10 HTTP 429 in about 2.65 seconds. Rejections included integer `Retry-After: 1` and `key_rate_limited`; wallet spend remained 14 credits.
- All 64 successful calls at that checkpoint reached Convex. Activity loaded 25 → 50 → 64 rows, exhausted pagination, then added a 65th successful call live without a page reload. A later zero-cost control-refresh probe brought the count to 66; the signed ledger had one +10,000 grant and 66 usage settlements totaling −14.
- Set monthly cap to the already-spent 14 credits through UI. After normal control refresh, both direct and MCP paid attempts were blocked by `key_cap_exceeded`; a zero-cost health call remained allowed. Direct explanation survived; MCP explanation did not (#396).

- Two successive UI rotations produced temporary `403 key_untracked` responses before the wallet control snapshot refreshed. Both rotated keys worked within the UI’s documented one-minute convergence window, predecessors remained usable during grace, and the 14-credit cap carried over. #419 was initially filed, then closed as not planned after confirming the existing UI notice; it is not counted as a defect. All test keys were subsequently revoked and rejected by the gateway.

### Agent

- `/llms.txt` returned 200 with local web/gateway links, pricing rules, mocks, error recovery and client setup. Native client coverage was Claude Code only.
- Listing setup offered Claude Code command, Cursor install deeplink/JSON and Codex TOML. Decoded Cursor link contained the local MCP URL and a placeholder key, not a real credential. Did not launch Cursor/Codex through those snippets.
- Executed the displayed Claude Code command with its placeholder in an isolated `.tmp/claude` config. Registration succeeded and `claude mcp list` reported Connected. This proves read/initialize connectivity, not an inference run or authenticated execution by Claude.
- MCP initialized with protocol `2025-11-25`; `tools/list` exposed `search_apis`, `get_api_docs`, `call_api`.
- Semantic request `inspect request arguments` returned the echo listing with `searchMode: "semantic"`, `degraded: false`, and score about 0.694. Docs contained prices, free tier, parameter schema and token rates, with publisher content marked untrusted.
- Paid MCP query execution succeeded. Missing-key and insufficient-wallet cases now expose structured reasons and actions. The actions still target production in local/preview contexts (#417); monthly-cap recovery remains incomplete (#396).

## New issues

Searched all open/closed issues before creation. Bodies contain steps, expected/actual behavior, environment and severity rationale. No duplicate issue was created for the remaining #396 case. [#419](https://github.com/zevium-dev/core/issues/419) was created and closed during verification: observed key-rotation propagation matched the existing one-minute UI notice.

| Issue                                                 | Priority         | Problem                                                                                                                                                          |
| ----------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#416](https://github.com/zevium-dev/core/issues/416) | P2 / area:web    | Creating an organization leaves notifications in a persistent authentication error. Reproduced twice; normal dashboard recovers, notification boundary does not. |
| [#417](https://github.com/zevium-dev/core/issues/417) | P1 / area:agents | Local 402 recovery links send users to production key management and billing, which cannot recover the local wallet.                                             |

## Top five impressions

1. **Publication is materially better.** Stored credentials, inline-price correction, hidden unpriced operations and visibility webhooks now work through normal UI.
2. **Agent integration is usable, with incomplete recovery edges.** Semantic discovery, client setup and query-bearing calls work. Environment-specific recovery and cap explanations still need attention.
3. **The exercised ledger stays coherent.** Free calls, fixed-price spending, missing-token-usage refunds, burst rejection and fractional publisher earnings agreed. This remains a small sandbox sample, not real-money or nonzero-token certification.
4. **Onboarding still depends on reliable external configuration.** Signup challenge, localhost webhook delivery, expired Stripe credentials and edge refresh delay prevent a clean sub-minute end-to-end acceptance claim.
5. **Realtime and evidence presentation improved.** Loaded activity pages absorb new rows, quality badges distinguish insufficient evidence from measured results, while the notification transition still leaves a persistent UI error. Key rotation has a documented one-minute propagation window.

## Verification and cleanup

- Final ledger: 69 successful calls, 14 credits spent, 9,986 remaining; 70 wallet entries (one +10,000 promotional grant and 69 usage settlements). The three calls after the 66-call checkpoint were zero-price rotation/grace checks. No balance patch, forced edge grant, or paid-call fixture was used.
- All four issued key generations ended `revoked` and disabled in Convex. The gateway rejected each with `invalid_api_key` after cache convergence. UI revocation worked for current and predecessor keys; repeated rotation retired the older predecessor.
- Both isolated browser sessions closed. The failed Stripe listener had exited. Web, gateway and local Convex stopped; ports 3000, 8787, 3210 and 3211 had no listeners.
- `mise exec -- pnpm typecheck` and `mise exec -- pnpm test` passed. Workspace tasks reused valid Turbo cache; Convex tests and worktree/seed/local-discovery smoke checks ran successfully.
- `pnpm build` initially lacked required exported build variables; rerun with the same synthetic Clerk/URL fixture strategy as repository CI plus the baseline SHA passed. No deployment was performed.
- Prettier ran on `.agents/notes`; final formatting and `git diff --check` passed. Only notes are included in the commit.
- Disposable Clerk test organizations and isolated local backend data remain test artifacts. No production mutation or charge occurred.
