WAVE 1 — CONVEX LANE. Project: /home/tnfssc/Code/zevium (pnpm monorepo). First read AGENTS.md, TECH.md, PRODUCT.md, and .project/PLAN.md at repo root. You may edit ONLY: convex/ directory, root package.json deps (pnpm add -w), and you may run `clerk api` (logged-in CLI) + `npx convex` commands from repo root.

GOAL: control-plane foundation in Convex.

1. Expand convex/schema.ts per TECH.md domains:
   - organizations (exists): clerkOrgId, name, slug, imageUrl optional
   - users mirror: clerkUserId, name, email — index by_clerk_user
   - projects (exists): add tags array, timestamps come free
   - specs: projectId, draft (string, the OpenAPI JSON), lastSavedAt
   - specVersions: projectId, version (semver string), spec (string), publishedAt — immutable, index by_project
   - wallets: organizationId (one per org), materialized balance (number)
   - walletEntries: append-only ledger — walletId, kind (grant|settle|refund_note), amount, refId (grantId or settlementId, unique dedupe index), createdAt
   - usageEvents: organizationId, projectId, endpoint, method, credits, status (number), latencyMs, keyId, at — index by_org, by_project
2. convex/auth.config.ts: Clerk JWT auth. Derive the Clerk frontend API issuer domain by base64-decoding the VITE_CLERK_PUBLISHABLE_KEY from apps/web/.env.local (pk_test_<base64 of domain$>). applicationID "convex". Create the Clerk JWT template named "convex" via `clerk api` (POST /jwt_templates) if missing — check GET /jwt_templates first.
3. convex/organizations.ts: query getBySlug, query listMine (by auth identity org claims), internalMutation upsertFromClerk(clerkOrgId, name, slug), public mutation ensureOrganization — called by web app with current Clerk org (validates identity via ctx.auth.getUserIdentity(), org id must match a claim), upserts mirror row + creates wallet with 0 balance if missing.
4. convex/users.ts: mutation ensureUser mirroring identity claims.
5. convex/http.ts: httpAction POST /clerk-webhook verifying svix signature with process.env.CLERK_WEBHOOK_SIGNING_SECRET (pnpm add -w svix). Handle organization.created/updated/deleted (upsert/delete mirror), user.created/updated. If env var unset, respond 503 (dev fallback is ensureOrganization).
6. Push schema: `npx convex dev --once` from repo root must succeed. Typecheck clean.

Verify: npx convex dev --once green. End final message with `DONE: <one-paragraph summary + files touched>` or `BLOCKED: <reason>`.
