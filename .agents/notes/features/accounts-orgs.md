# Accounts & organizations

> Status: root cutover implemented; owner activation pending · Updated: 2026-10-20
> Code: `convex/{clerkWebhooks,organizations,users}.ts`, `convex/lib/{auth,identity}.ts`, `tests/{identity,money}.test.ts`, `apps/web/src/hooks/use-ensure-mirror.ts`, `apps/web/src/lib/ssr-query.ts`
> Related: [wallet-billing](wallet-billing.md), [api-keys](api-keys.md), [earnings-payouts](earnings-payouts.md), [listing-lifecycle](listing-lifecycle.md), [publisher-analytics](publisher-analytics.md), [platform-admin](platform-admin.md), [architecture overview](../architecture/overview.md), [product overview](../product/overview.md)

Sign-up, sign-in, and the organization model. Everything in Zevium is org-scoped: every user belongs to at least one org (a personal org is created at signup), the org owns the wallet, and org roles decide who may run lifecycle, money, and secret actions. Auth, orgs, invitations, and roles are bought from Clerk; Convex mirrors orgs/users for app data.

## Product

- Credits are **org-scoped**: the organization owns the wallet, member keys draw from it, admins see per-member and per-key attribution. Solo devs get a personal org automatically; there is no separate personal-wallet model. Wallet behavior lives in [wallet-billing](wallet-billing.md).
- **Headline consumer metric: time-to-first-call.** Signup → working key → first successful metered request must take under a minute, fully self-serve. Signup is the first leg of that path (roadmap P0 #4, see [roadmap](../product/roadmap.md)).
- One account can be several personas at once (a publisher is usually also a consumer). Every user belongs to at least one org (a personal org is created at signup) — the org owns the wallet.

### Personas

| Persona            | Who                                      | Primary surface                                                              |
| ------------------ | ---------------------------------------- | ---------------------------------------------------------------------------- |
| **Visitor**        | Anonymous browser                        | Landing, public catalogue, auth                                              |
| **Consumer**       | Human dev buying API calls               | Catalogue, API detail, playground, keys, wallet                              |
| **Agent**          | AI agent consuming APIs programmatically | Discovery index, agent-tool endpoint, gateway (no screens — machine surface) |
| **Publisher**      | Org member collaborating on API drafts   | Projects, spec editor, analytics, earnings                                   |
| **Org admin**      | Owner/admin of an organization           | Project/listing lifecycle, secrets, payouts, wallet, members, invitations    |
| **Platform admin** | Zevium staff                             | Moderation, quality gates, support tooling                                   |

## Flow

### Auth — `/auth/*` (FLOW target; code: `/sign-in/$`, `/sign-up/$`)

- Sign in / sign up (email+password, Google OAuth), email verification, password reset, 2FA enrollment + challenge
- Signup creates the personal org automatically
- Post-auth redirect → `/app` with onboarding checklist

### Create organization — `/app/organizations/create` (code: `/app/org/create`)

- Name, slug (auto-derived), logo → org created, redirected in

### Organization home — `/app/organizations/{org}` (code: `/app/org`)

- Publisher overview: total calls, revenue this cycle, top APIs, recent consumers, wallet summary

### Org settings — `.../organizations/{org}/settings`

- Profile (name, slug, logo), members list, roles (owner/admin/member), invite by email + role, remove member, danger zone
- Wallet admin: who may top up / set budgets (admin-only actions)

### Invitations — `/app/invitations`

- Incoming invitations: accept / decline

### Org switcher

- Sidebar switcher, per-tab active org; "Choose Organization" page when none active

## Tech

Public handle input synchronizes on canonical handle changes during render in `apps/web/src/routes/app/org/index.tsx`; local edits remain until the canonical value changes.

Verified Svix events atomically retain receipt ordering, terminal user/org tombstones, creator claims and the once-per-user 10,000-credit promo lot/source/journal. Only signed organization.created.created_by selects the first processed creator org. Ensure calls grant nothing. Signed active-org JWTs own tenant/role checks; archive denies new reads/admissions while finance and admitted settlements remain recoverable.

First-visit mirror: Convex has no `organizations` row until `ensureOrganization` runs, and org-scoped queries throw `Organization not found` before it. The browser is the only place the mirror runs: `useEnsureMirror` (`apps/web/src/hooks/use-ensure-mirror.ts`) calls `ensureUser` then `ensureOrganization` for the signed-in principal, and `/app` (`routes/app.tsx`) renders the workspace skeleton instead of `<Outlet/>` until it succeeds. Queries keep throwing for unmirrored orgs rather than returning a "not ready" state, so every org-scoped query keeps one tenant check and the client never asserts readiness. SSR always renders that skeleton, so the dashboard has no SSR loader; any other SSR prefetch that errors is not dehydrated (`lib/ssr-query.ts`), because a hydrated error is final for `useSuspenseQuery` and showed the route error screen on every org's first load (2026-10-20 production bug). The old unused SSR mirror server fn was deleted.

[Activation gates and configuration](../architecture/convex-activation.md). [PR 1–6 design/review evidence](../architecture/convex-rebuild.md).

## Decisions

- 2026-10-11 — ACCEPTED: Only signup auto-created personal org gets $1, once per user; later-created/joined orgs get nothing. P0 #426. [Decision](../decisions/2026-10-11-signup-credit-eligibility.md).
- 2026-10-11 — ACCEPTED: first signed org creation claims the one-time user signup promotion; automatic creation supplies the personal org. First-processed delivery wins if webhooks race. [Decision](../decisions/2026-10-11-signup-credit-first-created-org.md).
- 2026-10-11 — Owner: signup promotion belongs only to the automatically created signup personal org, once per Clerk user ever; later-created/joined orgs receive no signup grant. Supersedes the creator fallback below.
- 2026-10-11 — ACCEPTED: first signed org creation claims the one-time user signup promotion; automatic creation supplies the personal org. First-processed delivery wins if webhooks race. [Decision](../decisions/2026-10-11-signup-credit-first-created-org.md).

- 2026-10-10 — BUILT (#317): $1 signup promotion with once-per-Clerk-creator fallback. [decision](../decisions/2026-10-10-signup-credit.md) (Historical; scope superseded 2026-10-11 above.)
- 2026-10-10 — BUILT (#317): $1 signup promotion with once-per-Clerk-creator fallback. [decision](../decisions/2026-10-10-signup-credit.md)

- 2026-07-11 — Settings: Clerk UserProfile/OrganizationProfile embeds + custom app prefs; keys stay custom.
- 2026-07-12 — Clerk chosen for auth + orgs + API keys, replacing Better Auth + its apikey plugin (stack decision, see [architecture overview](../architecture/overview.md)).
- Resolved (known fact) — Clerk "Organizations feature required" nag was not a config issue: clerk-js cached a degraded environment fetch (dev-instance usage limits under e2e hammering) inside a long-lived tab and disabled org components client-side. Both Clerk APIs confirmed orgs enabled the whole time. Hard reload refetches and clears it. Prod keys unaffected.
- New-user org handling resolved: Clerk auto-org creation plus `/app/org/create` guard (BACKLOG completed findings).
- 2026-10-10 — ACCEPTED: two roles for now, admin + member (owner treated as admin); full permission-based access later. [decision](../decisions/2026-10-10-two-roles-admin-member.md)

## Open questions

- Route conflict: FLOW targets `/auth/*`, `/app/organizations/create`, `/app/organizations/{org}`, `.../settings`; code ships `/sign-in/$`, `/sign-up/$`, `/app/org/create`, `/app/org` (org settings = Clerk `<OrganizationProfile/>` on `/app/org`). FLOW 2.3 note already says org-scoped URLs do not repeat org slug.
- Org home (FLOW 4.2) publisher overview — total calls, revenue this cycle, top APIs, recent consumers, wallet summary — not on `/app/org` in code.
- No `/app/invitations` route in code; incoming invitations surface only via Clerk prebuilt components (switcher/org list). Confirm whether FLOW 5.2 needs a dedicated screen.
- PLAN "custom app prefs" (and FLOW 2.5 `/app/settings/preferences`): no preferences route/tab in code; theme toggle exists in shell, notification preferences absent.
- FLOW 5.1 "Wallet admin: who may top up / set budgets" — no configurable delegation in code; top-up gating is fixed to privileged org role.
