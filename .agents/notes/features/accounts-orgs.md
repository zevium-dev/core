# Accounts & organizations

> Status: partial (signup credit #317 built) · Updated: 2026-10-10
> Code: `convex/organizations.ts`, `convex/users.ts`, `convex/http.ts` (`/clerk-webhook`), `convex/lib/auth.ts`, `packages/shared/src/org-capabilities.ts`, `convex/clerk-webhook.test.ts`, `convex/organizations.test.ts`, `convex/signup-credit.test.ts`, `convex/org-admin-auth.test.ts`, `apps/web/src/routes/sign-in.$.tsx`, `apps/web/src/routes/sign-up.$.tsx`, `apps/web/src/routes/app.tsx`, `apps/web/src/routes/app/org/index.tsx`, `apps/web/src/routes/app/org/create.tsx`, `apps/web/src/routes/app/settings.tsx`, `apps/web/src/routes/app/settings/index.tsx`, `apps/web/src/components/app-sidebar.tsx`, `apps/web/src/hooks/use-ensure-mirror.ts`
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

### Why Clerk

- Org-scoped billing is a product decision ([product overview](../product/overview.md)); Clerk ships prebuilt `<OrganizationSwitcher/>`, `<OrganizationProfile/>`, invitations, roles — weeks of UI we don't build
- **Machine API Keys GA (2026-04-06)**: Clerk's [2026-04-17 changelog](https://clerk.com/changelog/2026-04-17-api-keys-ga) says availability began April 6. End-user keys are scoped to user or organization. Replaces the Better Auth apikey plugin
- Deepest Convex auth integration (`ConvexProviderWithClerk`, JWT templates)
- Vendor lock is accepted for a greenfield product with no users; current package compatibility is proved by repository typecheck/build tests, not this document
- **Clerk Billing is not used**: Zevium's current funds flow is implemented with prepaid credits and publisher settlement through Stripe
- **Lifecycle webhooks**: configure the Clerk instance's Svix endpoint at `{CONVEX_SITE_URL}/clerk-webhook` for `user.created`, `user.updated`, `user.deleted`, `organization.created`, `organization.updated`, `organization.deleted`, and `organizationMembership.deleted`. Set that endpoint's signing secret as `CLERK_WEBHOOK_SIGNING_SECRET` in the same Convex deployment. These events maintain mirrors and terminal organization/member revocation; browser mirror initialization does not replace deletion delivery. Confirm actual provider delivery after setup or secret rotation. Replay missed events, or canonically archive only provider-confirmed deleted records.

### Domain

- `organizations` (mirror of Clerk orgs via webhook; Clerk is auth truth, Convex holds app data keyed by Clerk org id)

### Implementation notes

- **Signup credit (#317)**: trusted Clerk organization mirrors pass `created_by` into the atomic promotion grant. Browser `ensureOrganization` never treats the active member as creator; signed webhook delivery fills that gap even when the browser mirror arrives first. Grant and anti-farming behavior, including the missing verified-email signal, live in [wallet-billing](wallet-billing.md#implementation-notes).

- **Org-role authorization**: Clerk's active-org JWT claims are authoritative. Members may read org/project state and collaborate on spec drafts. Exact `org:admin` is required server-side before project lifecycle/visibility/deletion, immutable publication/deprecation, webhook configuration/signing-secret reads, wallet top-ups, and Stripe Connect onboarding/transfers. Missing or unknown roles fail closed; cross-org resource mutations return the same not-found class as missing resources. Matching client gates hide unusable controls but never replace server authorization.
- **Authentication loading**: sign-in/up routes mount Clerk directly so their loading skeletons do not wait behind the authenticated Convex principal boundary. CSP derives the exact Clerk Frontend API origin from the build's publishable key, allowing production custom domains as well as development instances and Clerk's documented abuse-protection hosts. Client navigation to home starts catalogue teaser fetching without blocking the page shell; SSR still awaits data for hydration.

### Code map (observed)

- Clerk webhook router: `convex/http.ts` `/clerk-webhook` → `organizations.applyOrganizationWebhook` / `archiveFromClerk` / `deleteFromClerk`, `users.upsertFromClerk` / `deleteFromClerk`. Tests in `convex/clerk-webhook.test.ts` cover user personal-data deletion, org archive preserving financial/audit/project history, webhook-authoritative profile fields vs browser overwrite, minimal public org DTOs, Svix-id dedupe + stale-event rejection.
- Browser mirror init: `use-ensure-mirror.ts` calls `users.ensureUser` then `organizations.ensureOrganization`.
- Org-less guard: `useOrgLessGuard` in `apps/web/src/routes/app.tsx` pushes users with no active org and zero memberships to `/app/org/create` (skipped under `/app/org` to avoid redirect loop). Comment states Clerk auto-org-creation is enabled instance-wide for new signups.
- Role check: `requireOrgAdmin` (`convex/lib/auth.ts`) → `isPrivilegedOrgRole` (`packages/shared/src/org-capabilities.ts`) accepts `org:owner` or `org:admin`.
- Org page `/app/org`: Clerk `<OrganizationProfile/>` embed (with API-keys link to `/app/settings/keys`), public publisher handle card (`organizations.setPublicHandle`, `checkPublicHandleAvailability`), Connect payout status card; `<OrganizationList/>` + create CTA when no active org.
- Account settings `/app/settings`: Clerk `<UserProfile/>` embed (`apiKeysProps.hide`); tabs Account / API keys / Activity.
- Sidebar: Clerk `<OrganizationSwitcher organizationProfileMode="navigation" organizationProfileUrl="/app/org">`.
- Auth routes: `<SignIn/>` / `<SignUp/>` with `fallbackRedirectUrl` from a sanitized return path; `/app` dashboard renders onboarding checklist via `apps/web/src/lib/onboarding.ts`.

## Decisions

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
