# Publishing specs

> Status: root cutover implemented; owner activation pending · Updated: 2026-10-11
> Code: `convex/{projects,specs,publishReadiness,publishReadinessAction}.ts`, `convex/lib/{dto,publicRoutes}.ts`, `apps/web/src/components/spec-editor/`, `tests/publishing.test.ts`
> Related: [pricing](pricing.md), [listing-lifecycle](listing-lifecycle.md), [quality-signals](quality-signals.md), [upstream-credentials](upstream-credentials.md), [catalogue-search](catalogue-search.md), [accounts-orgs](accounts-orgs.md), [product overview](../product/overview.md)

Organizations publish APIs as projects, each described by an OpenAPI spec. The spec is the product: upstream address, endpoints, per-endpoint pricing and free tier all live in it. Publishers draft, validate and publish immutable semver versions self-serve, with no platform-team involvement.

## Product

- Organizations publish APIs; each API is a project with an OpenAPI spec.
- **The spec is the product**: upstream address, endpoints, per-endpoint pricing, and free tier all live in the spec. No separate pricing configuration. Pricing extensions are owned by [pricing](pricing.md).
- **Self-serve end to end**: sign up, publish spec, set pricing, go live. Zero platform-team involvement. Publishing gates (auto-publish, declared health endpoint, suspension) are owned by [quality-signals](quality-signals.md) and [listing-lifecycle](listing-lifecycle.md).
- **Spec versioning**: draft → validate → publish with semver; published versions immutable.
- Product rules (AGENTS.md, never violate):
  - "The OpenAPI spec is the source of truth: upstream URL, endpoints, pricing (`x-zevium-cost`), free tier (`x-zevium-free-tier`). No parallel pricing tables"
  - "Published spec versions are immutable"

### Research ideas — not decided

Source: [agent-api-marketplace-landscape](../research/agent-api-marketplace-landscape.md#supply-list-apis-whose-owners-never-touched-zevium).

- **Claimable spec listings**: ingest public OpenAPI specs (APIs.guru, Postman public workspaces) as unclaimed, mock-only listings served through the keyless `/mock` carve-out (see [mock-sandbox](mock-sandbox.md)). Owner claims the listing, sets `x-zevium-cost`, passes KYC, earns 95%. Report caveat: legality of scraping specs under each provider's ToS is unverified; check before proxying anything real. Report places it in the "Next" horizon.
- **Founding-publisher deal with a written fee lock**: MCP-Hive and GET4AGENT run 0% founding fees; RapidAPI's post-acquisition fee hike (20%→25%) is the trust failure to exploit. Report places it in the "Now" horizon.
- Also listed in the report's supply section: negotiated house listings, an `mppx validate`-style conformance CLI, a GitHub Action that pushes spec versions, bounties for tools agents searched for and did not find.
- Tension (not from report): unclaimed listings vs non-goal "open unmoderated long-tail listing" in [product overview](../product/overview.md).

## Flow

Org switcher selects the workspace; URLs do not repeat the org slug (see Open questions).

- **Projects** — `/app/organizations/{org}/projects` (code: `/app/projects`): card list for all members; New Project and its empty-state CTA for org admins.
- **Create project** — `.../projects/create` (code: `/app/projects/create`): org admin only. Name (slug auto-derived), description → project page.
- **Project page** — `.../projects/{project}` (code: `/app/projects/$projectSlug`):
  - Header: name, slug, status badge (draft/published), visibility badge (private/public), admin-only Make Public action.
  - Tabs: Overview / Spec / Analytics / Quality / Earnings / Settings.
  - Settings tab: admin-only description, tags, **upstream credentials** (encrypted secrets attached to forwarded calls; see [upstream-credentials](upstream-credentials.md)), webhook secret/config, spec variables, danger zone.
- **Spec editor** — `.../projects/{project}/spec` (code: `/app/projects/$projectSlug/spec`):
  - Members: code editor with live validation, Issues panel, Save draft.
  - Org admins: connection gate, Publish (semver dialog), visibility, deprecate/restore lifecycle ([listing-lifecycle](listing-lifecycle.md)).
  - JSON + YAML both accepted.
  - Pricing lint: warn that unpriced operations will be hidden and not callable; publish is allowed; pricing summary sidebar ("12 endpoints, 2–10 credits, free tier on 3").
  - Import from URL / file upload.
  - Version history: published versions immutable, spec-diff between versions, rollback (P2).

### Publisher golden path

```
Sign up → Create org → Create project
  → Spec editor: import/paste OpenAPI → add x-zevium-cost per endpoint
  → attach upstream credentials → validate → Save draft → Publish v0.0.1
  → Make Public → automated gates pass → live in catalogue + discovery index + agent tools
  → watch Analytics tick (calls, p95, errors, revenue)
  → Earnings accrue at 95% → payout
```

## Tech

Editor event handlers synchronize their latest-text ref after commit (`useLayoutEffect` in `apps/web/src/components/spec-editor/use-spec-draft.ts`), preserving same-batch pricing edits without writing refs during render.

Draft bodies live in projectDrafts; small project metadata/readiness avoids oversized list/lifecycle reads. Paginated project lists and public DTO types are canonical in web. Publication requires the current draftHash and credential-bound reachability evidence, commits immutable versions and permanent route reservation atomically, and retains reload/overwrite conflict UX. Scalar prices only; unpriced/token operations do not become callable. House display metadata has no pricing exemption.

Optional house subsidy cap #429: assessed and skipped on 2026-10-11 under the owner's simplicity condition. Upstream billable execution is not preserved independently of consumer outcomes; exception settlements bypass ordinary rollups. Accurate accounting would require forwarding/finalization and settlement changes beyond a modest counter/gate. No cap is enforced. [Assessment and future proposal](../sessions/2026-10-11-house-subsidy-cap-assessment.md).

[Activation gates and configuration](../architecture/convex-activation.md). [PR 1–6 design/review evidence](../architecture/convex-rebuild.md).

- **Connected-account schemes**: `oauth2` + `authorizationCode` + `x-zevium-oauth-provider` are validated on save/publish (known provider, registry endpoints, provider-allowed scopes, `servers[0].url` host among the provider's API hosts, ≤ 4 schemes, one per operation). Other OAuth schemes stay documentation only. [connected-accounts](connected-accounts.md)

## Decisions

- 2026-10-11 — ACCEPTED: `oauth2` authorization-code schemes with `x-zevium-oauth-provider` declare connected accounts; endpoints come from Zevium's registry. [Decision](../decisions/2026-10-11-zevium-owned-oauth-clients.md).
- 2026-10-11 — PR #442 applies [read-surface review defaults](../decisions/2026-10-11-read-surface-review-defaults.md), pending owner sign-off.

- 2026-10-11 — ACCEPTED: Publisher spec is the contract; generated surfaces #428, existing MCP #110, form playground #427. Zevium writes house specs. [Decision](../decisions/2026-10-11-openapi-as-contract.md).
- 2026-10-11 — ACCEPTED: Ordinary house publisher org/95/5 ledger (#314); RapidAPI excluded (#313); cap optional P2 #429. [Decision](../decisions/2026-10-11-house-listing-accounting.md).
- 2026-10-11 — ACCEPTED: Hide and disable per-token LLM listings #425; code retained, revival P2 #431. [Decision](../decisions/2026-10-11-llm-deferred.md).

- 2026-07-11 — Spec editor: direction C phased. Cut 1 editor + validation + read-only rail; cut 2 write-back + diffs. Mockups: claude.ai/code/artifact/3591af48.
- 2026-07-11 — YAML accepted at input, converted client-side, stored canonical JSON (gateway stays JSON-only).
- 2026-10-10 — ACCEPTED: Zevium publishes house listings to seed supply, sourced via treg then RapidAPI, replaced over time by direct integrations; eats losses for now. ToS gate per source. [decision](../decisions/2026-10-10-house-supply-via-aggregators.md) (Historical; scope superseded 2026-10-11 above.)
- 2026-10-10 — BUILT (#316): operations without `x-zevium-cost` are hidden and not callable; free only when explicitly `0`. Publishing remains allowed with a warning. [decision](../decisions/2026-10-10-unpriced-operations-hidden.md)
- 2026-10-10 — House listings labeled "Operated by Zevium". [decision](../decisions/2026-10-10-house-supply-via-aggregators.md) (Historical; scope superseded 2026-10-11 above.)

## Open questions

- FLOW routes `/app/organizations/{org}/projects/...`; code routes `/app/projects/...` (org from active session). FLOW 2.3 already says URLs do not repeat the org slug; fix FLOW route lines.
- FLOW "spec-diff between versions": code diffs a published version against the saved draft only, not version-to-version. Rollback (P2) absent.
- Resolved #362: the duplicate import limiter entry point was dead; the active `specImportLimits` path is documented above. The unused table remains outside this change’s schema scope.
- Research ideas above (claimable listings, founding-publisher fee lock) undecided.
