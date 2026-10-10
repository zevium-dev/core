# Publishing specs

> Status: partial (P0 credentialed publication blocked by #389; P2 rollback not built) · Updated: 2026-10-10
> Code: `convex/projects.ts`, `convex/specs.ts`, `convex/specImportLimits.ts`, `convex/publishReadiness.ts`, `convex/publishReadinessAction.ts`, `packages/shared/src/openapi.ts`, `packages/shared/src/validate.ts`, `apps/web/src/routes/app/projects/`, `apps/web/src/components/spec-editor/`, `apps/web/src/components/project/`, `apps/web/src/lib/spec-import.server.ts`, `convex/specImports.ts`
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
  - Tabs: Overview / Spec / Analytics / Earnings / Settings.
  - Settings tab: admin-only description, tags, **upstream credentials** (encrypted secrets attached to forwarded calls; see [upstream-credentials](upstream-credentials.md)), webhook secret/config, spec variables, danger zone.
- **Spec editor** — `.../projects/{project}/spec` (code: `/app/projects/$projectSlug/spec`):
  - Members: code editor with live validation, Issues panel, Save draft.
  - Org admins: connection gate, Publish (semver dialog), visibility, deprecate/restore lifecycle ([listing-lifecycle](listing-lifecycle.md)).
  - JSON + YAML both accepted.
  - Pricing lint: warn on operations missing `x-zevium-cost`; pricing summary sidebar ("12 endpoints, 2–10 credits, free tier on 3").
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

**Dogfood — 2026-10-10**

- **P0 #389:** credentials stored before publication cause repeated `Run a new credential-free reachability test before publishing.` even after a passing probe. Readiness and publication compare different credential revision representations.
- **P2 #399:** entering a negative inline price invalidates the draft and disables the field needed to correct it; recovery requires editing the source spec.

Evidence, workarounds and scope: [dogfood findings](../findings/dogfood-2026-10-10.md).

From [architecture overview](../architecture/overview.md):

- `projects`, `specs` + `specVersions` (immutable published spec bodies; deprecation metadata remains mutable)
- `specImportLimits` (durable per-principal/global import concurrency and fixed-window rate bounds); the unused `specImportRateLeases` table is retained for separate schema cleanup.
- **Spec editor dependencies**: the JSON parser and syntax highlighter share one workspace-pinned `@lezer/common` version. Separate module instances allocate conflicting NodeProp identities and can crash highlighting even when both versions satisfy package ranges.

Code facts (read from source 2026-10-10, not from TECH.md):

- `specs.saveDraft` / `specs.publish` / `specs.listVersions` / `specs.getVersion`. Publish rejects non-semver (`isValidSemver`), rejects an already-published version (`Version X already published (immutable)`), and requires a current publish-readiness record (`publishReadiness.readinessValidity`: status ok, `READINESS_TTL_MS` 15 min, same saved-draft SHA-256). Saving a draft deletes the readiness record. Publish schedules `internal.search.embedProject`.
- Connection gate: `publishReadinessAction.testConnection` (org admin only) probes the spec's single `x-zevium-health-check` operation without publisher credentials; detail in [quality-signals](quality-signals.md).
- URL import: `apps/web/src/lib/spec-import.server.ts`, HTTPS only, public-IP DNS check, JSON drafts ≤384 KiB, YAML input ≤256 KiB (converted client-side to canonical JSON). The live path uses `specImportLimits.acquire/renew/release` (per-principal concurrency 2, 10/60s, 30s lease; global concurrency 40, 200/window) on table `specImportLimits`. The duplicate `fetchSpecFromUrlServerBoundary` pipeline and its unused `specImports.acquireLease` mutation were removed after checking callers. `text/plain` responses (including GitHub raw) pass the same validation, DNS, redirect, size, and lease checks.
- Version view/diff: `components/spec-editor/version-dialog.tsx` shows a published version and a read-only `@codemirror/merge` unified diff against the saved draft. Bounded scanning/time and collapsed unchanged regions replace the quadratic LCS matrix. No rollback.

- **Concurrent saves**: `specs.saveDraft` requires `baseHash` (`null` only for an absent row); it compares the current SHA-256 inside the mutation transaction. A conflict returns the canonical draft/hash/timestamp without changing the draft or readiness. Identical retries remain idempotent. `useSpecDraft` keeps the editing base stable across remote pushes and saves in flight; autosave pauses on conflict. Reload adopts the latest known snapshot; explicit overwrite retries against its hash, so another intervening save can still conflict.
- **Editor ownership**: the workspace is keyed by project ID. Draft reducer, YAML conversion, publish controls, version dialog, lifecycle dialogs, and rail components are separate modules. `SaveStatusLabel` owns the one-second clock. Publish version suggestions are derived until typed; realtime version updates never reset typed text. Navigation has one save-and-leave completion path and does not leave if new text was typed during the save.
- **Editor feedback**: pricing rail writes valid numbers immediately and keeps raw text such as `1.` until blur; failed `applyPricingEdit` writes show a human error. Endpoint rows are parsed once for the rail and pricing summary. Health results are tied to the tested draft. CodeMirror uses its own debounced linter and syntax-tree diagnostic ranges, without React lint state.
- **YAML bounds**: byte/line preflight stays outside the killable worker; alias/expansion validation runs inside it, so markdown bullets and scalar text are not mistaken for aliases. A ready handshake separates the 10-second module startup bound from the 250 ms hard parser deadline. Conversion revisions are canceled on replacement, reload, rail edits, and unmount.
- **Settings**: project-ID-keyed cards derive untouched fields from realtime data and retain local overrides while typing. Convex subscriptions own updates; there are no cache invalidations or manual optimistic cache writes in editor/settings. Admin/owner access follows the shared privileged-role predicate. Webhook URL input survives rotation; reveal-once version tracking remains intact.

## Decisions

- 2026-07-11 — Spec editor: direction C phased. Cut 1 editor + validation + read-only rail; cut 2 write-back + diffs. Mockups: claude.ai/code/artifact/3591af48.
- 2026-07-11 — YAML accepted at input, converted client-side, stored canonical JSON (gateway stays JSON-only).
- 2026-10-10 — ACCEPTED: Zevium publishes house listings to seed supply, sourced via treg then RapidAPI, replaced over time by direct integrations; eats losses for now. ToS gate per source. [decision](../decisions/2026-10-10-house-supply-via-aggregators.md)
- 2026-10-10 — ACCEPTED (not built): operations without `x-zevium-cost` are hidden and not callable; free only when explicitly `0`. Replaces code's default of 1 credit. [decision](../decisions/2026-10-10-unpriced-operations-hidden.md)
- 2026-10-10 — House listings labeled "Operated by Zevium". [decision](../decisions/2026-10-10-house-supply-via-aggregators.md)

## Open questions

- FLOW routes `/app/organizations/{org}/projects/...`; code routes `/app/projects/...` (org from active session). FLOW 2.3 already says URLs do not repeat the org slug; fix FLOW route lines.
- FLOW "spec-diff between versions": code diffs a published version against the saved draft only, not version-to-version. Rollback (P2) absent.
- Resolved #362: the duplicate import limiter entry point was dead; the active `specImportLimits` path is documented above. The unused table remains outside this change’s schema scope.
- Research ideas above (claimable listings, founding-publisher fee lock) undecided.
