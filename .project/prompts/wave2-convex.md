WAVE 2 — CONVEX LANE. Project: /home/tnfssc/Code/zevium. Read AGENTS.md, PRODUCT.md, FLOW.md §4, TECH.md, .project/PLAN.md, and current convex/ code first. Edit ONLY convex/ (+ `npx convex dev --once` to push).

GOAL: publisher control-plane functions.

1. convex/projects.ts: authed queries/mutations, org-scoped via ctx.auth identity org claim:
   - list(orgSlug), get(orgSlug, projectSlug), create(name, slug, description) [creator must be member of org], update(patch), remove
   - slug rules: kebab, unique per org
2. convex/specs.ts:
   - getDraft(projectId), saveDraft(projectId, spec) — validate JSON parses + has openapi field + servers[0].url http(s); return structured issues array instead of throwing for validation problems
   - publish(projectId, version) — semver validate, spec must pass validation incl. every operation has x-zevium-cost number ≥ 0 warning list, snapshot into specVersions (immutable), set project.status published
   - listVersions(projectId)
3. Public (no-auth) queries for gateway + catalogue:
   - catalogue.ts: listPublic({search?, tag?, cursor?}) — visibility public + status published, joined org name/slug; getPublicDetail(orgSlug, projectSlug) returns latest published spec + metadata
   - specs.getPublishedForGateway(orgSlug, projectSlug) → { spec, projectId, organizationId, clerkOrgId } — this is what apps/gateway ConvexSpecSource will call via ConvexHttpClient
4. Wallet functions (wallets.ts): internalMutation grantCredits(clerkOrgId, amount, grantRefId) idempotent by refId; mutation getMyWallet(orgSlug) → balance + recent entries; internalMutation recordUsage(batch of usage events + settlement entries, refId dedupe) — called later by gateway flush; keep transactional integrity with walletEntries ledger + materialized balance.
5. Ensure `npx convex dev --once` green, typecheck green. Do not touch apps/.

End with `DONE: <summary + files>` or `BLOCKED: <reason>`.
