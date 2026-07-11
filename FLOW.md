# Zevium Product Flow

> Last updated: 2026-07-11
> Companion to [PRODUCT.md](PRODUCT.md) (what the product is) — this doc is **what users see on screen**, screen by screen, per persona.
> Status legend: ✅ built · 🔨 built but incomplete/broken · 🆕 planned (from PRODUCT.md roadmap)

## Personas

| Persona | Who | Primary surface |
| --- | --- | --- |
| **Visitor** | Anonymous browser | Landing, public catalogue, auth |
| **Consumer** | Human dev buying API calls | Catalogue, API detail, playground, keys, credits |
| **Agent** | AI agent consuming APIs programmatically | Discovery index, MCP endpoint, proxy (no screens — machine surface) |
| **Publisher** | Org member selling APIs | Projects, spec editor, analytics, earnings |
| **Org admin** | Owner/admin of an organization | Org settings, members, invitations |
| **Platform admin** | Zevium staff | Moderation, quality gates, support tooling |

One account can be several personas at once (a publisher is usually also a consumer).

---

## 1. Visitor flow

### 1.1 Landing page — `/` ✅

- Sidebar shell: logo, Dashboard + API Catalogue links (redirect to sign-in when anonymous), theme toggle, Sign in
- Hero with rotating value prop ("Integrate payments/e-commerce/… in one click"), CTA → API hub
- Feature cards (Publish / Consume / Manage APIs), code snippet with copy button, footer
- 🆕 Should show: live catalogue teaser (top APIs with pricing), "publishers keep 95%" pitch, agent-first messaging (MCP/machine-readable badges)

### 1.2 Public catalogue (anonymous) 🆕

- Today catalogue lives behind auth (`/app/catalogue`). Discovery must be public — SEO + agents + zero-friction evaluation
- Anonymous users see listings + pricing + docs; any paid action (key, playground call) gates to sign-up
- Public API detail page doubles as the listing's landing page (sharable URL per API)

### 1.3 Auth — `/auth/*` ✅

- `/auth/sign-in` — email+password, Google OAuth, forgot-password link, sign-up link
- `/auth/sign-up` — name/email/password, Google OAuth
- `/auth/verify-email`, `/auth/sent-email` — verification loop
- `/auth/forgot-password` → `/auth/reset-password` — recovery loop
- `/auth/change-password` — authenticated password change
- `/auth/two-factor-auth`, `/auth/two-factor-verify` — 2FA enrollment + challenge
- Post-auth redirect → `/app`

---

## 2. Consumer flow (human developer)

**North-star: time-to-first-call < 60 seconds.** Sign up → key → successful playground call, zero tickets.

### 2.1 App dashboard — `/app` ✅ (minimal)

- Sidebar: org switcher, Dashboard, API Catalogue, Projects (if org selected), Settings, theme, user menu
- 🆕 Consumer dashboard content: credit balance card, calls today/this cycle, projected spend, recent calls, quick links (top-up, keys, catalogue), onboarding checklist for new users (get key → make first call → top up)

### 2.2 Catalogue — `/app/catalogue` ✅ 🔨

- Built: search by name, popular tag filters, listing grid (name, org, description)
- 🔨 Currently always empty — make-public is broken (embedding upsert bug)
- 🆕 Quality signals per card: latency badge, success rate, freshness ("updated 2w ago"), price range (derived from spec `x-zevium-cost` min–max), MCP-ready badge
- 🆕 Sort: relevance / popularity / recently updated. Filters: tag, price range, has-free-tier
- 🆕 Semantic search for humans — embeddings + vector search fully built but only the MCP tool queries them; the web catalogue still uses SQL `LIKE`

### 2.3 API detail page 🆕 (public route per listing)

The listing's product page. HuggingFace-card pattern: spec metadata drives everything.

- Header: name, org, tags, quality badges (latency p50, success rate, uptime, freshness), MCP-ready badge
- Pricing table: per-endpoint credits from `x-zevium-cost`, free tier from `x-zevium-free-tier`
- Docs: rendered from published OpenAPI spec (three-column Stripe pattern: nav / prose / runnable code samples in curl/js/python)
- **Try it** panel: paste key or one-click use-my-key, run request in-page, see live response. Key held in browser session storage only; test mode visually loud
- 🆕 **Mock mode**: Prism-style mock server auto-generated from the spec — exercise the API shape for free before spending credits (strongest try-before-buy conversion lever)
- Agent tab: MCP connection config snippet + agent usage notes (SKILL.md-style)
- Reviews/ratings 🆕 (later)

### 2.4 API Explorer — `/app/organizations/$org/projects/$project/explorer` ✅

- Built: Scalar-powered spec viewer, Try Requests panel (Zevium API key + upstream host inputs), endpoint list, Download OpenAPI Document
- Today publisher-scoped; the consumer-facing version is the API detail page above (2.3)

### 2.5 Get a key — `/app/settings/keys` ✅ 🔨

- Built: key table (key, rate limit, remaining quota), Create API Key dialog (name → create → copy-once reveal), one key per user enforced
- 🔨 Creation currently broken (Better Auth server-only props bug)
- 🆕 OpenRouter-pattern upgrades: per-key spend limit with daily/weekly/monthly reset, auto-disable on limit, enable/disable toggle, zero-downtime rotation (roll key, old key valid through grace period), last-used timestamp, per-key usage sparkline
- 🆕 Key-management API (programmatic CRUD) for SaaS consumers provisioning keys

### 2.6 Credits & billing — `/app/settings/credits` ✅ 🔨

- Built: balance card (X credits, consumed/total), Buy Credits (Polar checkout, fixed top-up products), Recent Top-Ups list
- 🆕 **Org-scoped billing (decided)**: wallet moves to the organization — org admins top up, member keys draw from the shared balance, billing screens show per-member + per-key attribution. Solo users get a personal org. This screen migrates from user settings to org context
- 🆕 Vercel-pattern transparency: current-cycle usage + **projected** end-of-cycle spend, per-endpoint and per-key cost breakdown, charges history (`listCharges`), per-key usage (`listPerKeyUsage` — RPC exists, no UI)
- 🆕 Spend controls: threshold alerts at 50/75/100% of a user-set budget (email + in-app), signed budget webhooks, hard cap toggle ("block calls at budget")
- 🆕 Bigger top-up denominations ($50+) surfaced first — dilutes payment-processing fixed fee

### 2.7 Activity — `/app/settings/activity` 🔨

- 🔨 Page renders **hardcoded mock data** (TODO in code); audit rows land in DB but no read RPC exists
- 🆕 Real audit feed + filterable call log: timestamp, API, endpoint, status, credits charged, latency; link from a charge → the exact call

### 2.8 Preferences — `/app/settings/preference` ✅

- Theme, notification preferences

### 2.9 Integrate (leave the app)

- Copy proxy base URL `https://zevium.dev/api/proxy/{orgSlug}/{projectSlug}/…` + key header
- 🆕 Per-language snippets on every endpoint (curl/js/python), generated SDKs later

---

## 3. Agent flow (machine surface — no screens, but part of the product)

### 3.1 Discovery index 🆕 (P1)

- Crawlable machine-readable endpoint (e.g. `/api/discovery`) listing published APIs with per-endpoint pricing metadata — x402-Bazaar-compatible shape
- Agents evaluate cost **before** calling

### 3.2 MCP gateway ✅ 🔨

- ✅ Exists at `/mcp/$` (undocumented, no UI surface): `search_zevium_api` tool — semantic search over catalogue via embeddings + Cohere rerank (search-then-load pattern, correct design)
- 🔨 **`execute_api_call` tool bypasses the billing proxy** — raw passthrough fetch, unmetered/unkeyed. P0: route through proxy
- 🆕 Per-project metered MCP, key auth, compact tool surface
- 🆕 Human-visible counterpart: "Connect your agent" section on the API detail page with copy-paste MCP config per client (Claude Code, Cursor, etc.)

### 3.3 Proxy — `/api/proxy/...` ✅ 🔨

- The actual metered call path (resolve project → spec → cost → key → gate → forward → ingest/refund)
- Error semantics (built): `402` insufficient credits, `429 {"error":"Rate limit exceeded"}` / `{"error":"Usage exceeded"}` with quota-unit refund, `x-zevium-request-id` header on responses
- 🔨 **Secrets + variables not wired**: proxy forwards to raw `servers[0].url` with no secret injection and no `%VAR%` substitution — publisher upstream auth is a zombie feature until this lands (P0)

### 3.4 x402 rail 🆕 (P1 — promoted)

- 402 responses with payment instructions on proxy endpoints; agents pay per-call in stablecoins, no account

---

## 4. Publisher flow

### 4.1 Create organization — `/app/organizations/create` ✅

- Name, slug (auto-derived), logo upload → creates org, redirects into it

### 4.2 Organization home — `/app/organizations/$org` ✅

- Org overview; sidebar gains Projects entry
- 🆕 Publisher overview widgets: total calls, revenue this cycle, top APIs, recent consumers

### 4.3 Projects list — `/app/organizations/$org/projects` ✅

- Card list of org projects; New Project button; empty state

### 4.4 Create project — `/app/organizations/$org/projects/create` ✅

- Name (slug auto-derived, TanStack Form isDirty gating), description → project page

### 4.5 Project page — `/app/organizations/$org/projects/$project` ✅ 🔨

- Built: name, slug, Draft/published badge, private/public badge, Make Public dialog, Manage Spec, API Explorer, project ID copy, description card
- 🔨 Make Public broken (embedding upsert bug — the blocking P0)
- 🆕 Tabs: Overview / Analytics / Earnings / Settings (variables, secrets, tags — RPCs exist)

### 4.6 Spec editor — `.../spec` ✅ 🔨

- Built: Monaco editor (JSON), live validation with Issues panel, Save draft, Publish (semver dialog, e.g. 0.0.1), unsaved-changes indicator, last-saved timestamp, More actions
- Built: **Variables tab** (`%VAR%` tokens substituted into the exported spec) and **Secrets tab** (encrypted per-project name/value store, audited) — 🔨 neither reaches the live proxy: secrets never injected into upstream calls, variables never substituted at call time. Wire both (P0)
- 🆕 YAML support (today JSON-only — silent trap, error surfaces late)
- 🆕 Pricing lint: warn on operations missing `x-zevium-cost`; pricing summary sidebar ("12 endpoints, 2–10 credits, free tier on 3")
- 🆕 Version history: list published versions, **spec-diff changelog** between versions, rollback
- 🆕 Import from URL / file upload

### 4.7 Publisher analytics 🆕 (P0)

Per project, the screen RapidAPI never shipped properly:

- Calls over time (per endpoint), success rate, error-type breakdown (4xx vs 5xx vs upstream-timeout)
- Latency: p50 / p95 / p99 per endpoint
- Consumers: count, top consumers by calls (anonymized ids), retention
- Revenue: credits earned per endpoint per period

### 4.8 Earnings & payouts 🆕 (P2)

- Balance: accumulated publisher share (95%), settlement schedule, payout history
- Payout method setup, statement export

### 4.9 Listing quality 🆕 (P2)

- Uptime monitor status on own listing, security-scan results, freshness nudges ("spec not updated in 90 days — listings rank lower")
- Publishing model (decided): **auto-publish with automated gates** (spec valid, upstream reachable, uptime probe) + post-hoc review; no pre-approval queue

### 4.10 Lifecycle: deprecate / unpublish 🆕 (P1)

- Publisher cannot silently unpublish an API with active consumers
- Deprecate flow: set sunset date → consumers notified (in-dashboard banner + email), proxy adds `Deprecation`/`Sunset` headers (RFC 8594), new subscriptions freeze, existing calls honored through wind-down, hard cutoff after sunset
- 🆕 (P2) Version pinning per key: consumers stay on the spec version they integrated against; publisher spec changes affect new consumers only

### 4.11 Publisher webhooks 🆕 (P1)

- Subscribe to events: new consumer, usage spike / abnormal traffic (fraud or DDoS on upstream), revenue milestone, key revoked

---

## 5. Org admin flow

### 5.1 Org settings — `/app/organizations/$org/settings` ✅

- Org profile (name, slug, logo), members list, roles (owner/admin/member), invite member (email + role), remove member, danger zone (delete org)

### 5.2 Invitations — `/app/invitations` ✅

- Incoming invitations for current user: accept / decline

### 5.3 Choose organization — `/app/organizations` ✅

- Org list / switcher page ("Choose Organization" when none active)

---

## 6. Platform admin flow 🆕 (all planned — no admin UI exists)

Internal staff surface, separate route group (e.g. `/admin`), role-gated:

- **Moderation queue**: new/updated public listings pending review; approve / reject with reason
- **Quality dashboard**: listings failing uptime/security gates, auto-delist toggles
- **Users & orgs**: search, view account state (credits, keys, calls), suspend/ban
- **Billing ops**: top-up/refund lookup, manual credit grants (promotional credits, Kong-pattern), webhook replay
- **Platform metrics**: GMV, take, active consumers/publishers, call volume, error rates

Until built: DB + Polar dashboard + Redis by hand.

---

## 7. Cross-cutting UI

- **Global shell** ✅: collapsible sidebar, org switcher, breadcrumb header, theme toggle (hydration-mismatch bug on theme icon 🔨), user menu (Sign out)
- **Toasts** ✅ (Sonner) — 🔨 error toasts can dump raw internals (768-dim embedding vector seen); map to human messages, never raw SQL/params
- **Confirm dialogs** ✅ (global `useConfirm`, FIFO queue)
- **Emails** ✅ — exactly three templates exist: email-verify, reset-password, org-invitation (previewable at `/$internal/email-templates-preview`) — 🆕 budget alerts, payout notices, deprecation/sunset notices, listing-status notices
- **Dispute flow** 🆕 (P2): consumer flags a charged call whose 200 response was garbage → credits held pending review → refund or reject; per-API status pages with subscribable uptime feeds
- **Dead scaffolds in repo** (empty dirs, no routes/RPCs — delete or build): `src/routes/embed/`, `src/routes/p/`, `src/server/rpcs/request/`, `src/server/rpcs/audit/`
- **Dev/test routes** ✅: `/$internal/confirm-test`, `/$internal/image-upload-test`, `/$internal/email-templates-preview`
- **OpenAPI of Zevium itself** ✅: `/api/openapi/$` (oRPC-generated docs)

---

## 8. The two golden paths, end to end

### Consumer golden path

```
Landing → Sign up → verify email → /app (onboarding checklist)
  → Catalogue → API detail → Try it (free tier or test mode)
  → Create key (copy once) → Top up credits (Polar checkout)
  → First real call from playground or curl   ← under 60s from signup
  → Integrate (snippet) → monitor usage/spend in Settings → Credits
  → set budget alerts → top up again (or auto-top-up 🆕)
```

### Publisher golden path

```
Sign up → Create org → Create project
  → Spec editor: paste/import OpenAPI → add x-zevium-cost per endpoint
  → validate (Issues panel) → Save draft → Publish v0.0.1
  → Make Public → listing live in catalogue + discovery index + MCP 🆕
  → watch Analytics (calls, p95, errors, revenue)
  → Earnings accrue at 95% → payout 🆕
```

Both paths currently break mid-way (make-public bug, key-creation bug) — fixing them is P0 item 1.
