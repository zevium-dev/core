# Zevium Product Flow

> Last updated: 2026-08-12
> Companion to [PRODUCT.md](PRODUCT.md) (what), [DESIGN.md](DESIGN.md) (feel), [TECH.md](TECH.md) (how). This doc is **what users see on screen**, screen by screen, per persona — the target product, not the current code.
> Priority tags (P0/P1/P2) follow the PRODUCT.md roadmap; untagged = P0.

## Personas

| Persona            | Who                                      | Primary surface                                                              |
| ------------------ | ---------------------------------------- | ---------------------------------------------------------------------------- |
| **Visitor**        | Anonymous browser                        | Landing, public catalogue, auth                                              |
| **Consumer**       | Human dev buying API calls               | Catalogue, API detail, playground, keys, wallet                              |
| **Agent**          | AI agent consuming APIs programmatically | Discovery index, agent-tool endpoint, gateway (no screens — machine surface) |
| **Publisher**      | Org member selling APIs                  | Projects, spec editor, analytics, earnings                                   |
| **Org admin**      | Owner/admin of an organization           | Org settings, members, wallet, invitations                                   |
| **Platform admin** | Zevium staff                             | Moderation, quality gates, support tooling                                   |

One account can be several personas at once (a publisher is usually also a consumer). Every user belongs to at least one org (a personal org is created at signup) — the org owns the wallet.

---

## 1. Visitor flow

### 1.1 Landing page — `/`

- Header: logo, Catalogue, Docs, theme toggle, Sign in — Docs is a standalone in-app section at `/docs` (quickstart, consuming, publishing, agents guides), not an external site
- Hero: agent-first value prop, primary CTA → catalogue. Motion per DESIGN.md (staggered entrance, magnetic CTA — the page's whole delight budget)
- Proof strip: live catalogue teaser (top APIs with real pricing), "publishers keep 95%" pitch, stat row (APIs listed, calls served)
- How-it-works: three steps per side (publish spec → set price → earn) / (find API → get key → call)
- Footer: standard

### 1.2 Public catalogue — `/catalogue`

- **Public, no auth** — SEO surface + agents + zero-friction evaluation
- Search (semantic), tag filters, sort (relevance / popularity / recently updated), filters (price range, has-free-tier)
- Listing cards: name, org, description, price range, quality badges (latency, success rate, freshness), agent-ready badge
- Any paid action (key, real playground call) gates to sign-up

### 1.3 API detail page — `/catalogue/{org}/{api}` (public)

The listing's product page — shareable URL, the API's landing page. Spec metadata drives everything.

- Header: name, org, tags, quality badges (latency p50, success rate, uptime, freshness), agent-ready badge
- Pricing table: per-endpoint credits, free tier highlighted
- Docs: rendered from the published spec — three-column pattern (nav / prose / runnable code samples in curl/js/python), prose↔code hover-sync
- **Try it** panel: one-click use-my-key (or paste key), run request in-page, live response. Key held in browser session storage only; test mode visually loud
- **Mock mode**: free, anonymous spec-generated responses — exercise the API shape without spending credits or executing the upstream
- **Connect your agent** tab: copy-paste agent-tool config per client + agent-readable usage notes
- Version picker: published versions, spec-diff changelog between versions (P2)
- Reviews/ratings (P2)

### 1.4 Auth — `/auth/*`

- Sign in / sign up (email+password, Google OAuth), email verification, password reset, 2FA enrollment + challenge
- Signup creates the personal org automatically
- Post-auth redirect → `/app` with onboarding checklist

---

## 2. Consumer flow (human developer)

**North-star: time-to-first-call < 60 seconds.** Sign up → key → successful playground call, zero tickets.

### 2.1 App dashboard — `/app`

- Sidebar: org switcher, Dashboard, Catalogue, Projects, Settings, theme, user menu
- Content: wallet balance card (live-ticking), calls this cycle + projected spend, recent calls, quick actions (top up, keys, browse)
- First-visit onboarding checklist: get key → make first call → top up

### 2.2 Keys — `/app/settings/keys`

- Key table: name, masked key, per-key spend limit, remaining, last used, per-key usage sparkline, enable/disable
- Create key dialog: name → create → copy-once reveal (blur-in animation per DESIGN.md)
- Per-key spend limits with auto-disable. Monthly limits are available; daily and weekly reset choices remain P1
- Zero-downtime rotation: roll key, old key remains usable for a 24-hour grace period
- Programmatic key-management API for SaaS consumers (P1)

### 2.3 Wallet & billing — `/app/organizations/{org}/billing`

Current screen: `/app/billing`. Org switcher selects workspace for this and every org-scoped screen in §4 and §5; URL does not repeat org slug.

Org-scoped — the org owns the wallet; admins manage it, members view their own attribution.

- Balance (live), Buy Credits (hosted checkout, credit-pack products — larger denominations surfaced first), top-up history
- Usage: current-cycle consumption + **projected** end-of-cycle spend; breakdown per member, per key, per API, per endpoint
- Charges history: itemized, each charge links to the exact call
- Spend controls (P1): budget with 50/75/100% threshold alerts (email + in-app), signed budget webhooks, hard-cap toggle
- Note: zero balance always blocks calls — the "cap" here is the alerting budget, not the wallet

### 2.4 Activity — `/app/settings/activity`

- Filterable account activity + call log: timestamp, API, endpoint, status, credits charged, latency

### 2.5 Preferences — `/app/settings/preferences`

- Theme, notification preferences

### 2.6 Integrate (leaving the app)

- Copy gateway base URL + key header snippet per language (curl/js/python) on every endpoint
- Generated SDKs (P2)

---

## 3. Agent flow (machine surface — no screens, still product)

### 3.1 Discovery index (P1)

- Crawlable machine-readable index of published APIs with per-endpoint pricing metadata — agents evaluate cost **before** calling

### 3.2 Agent-tool endpoint

- Marketplace-wide agent server: semantic catalogue search tool + execute tool — **execution routes through the same key-authenticated, credit-gated gateway as human traffic; no unmetered side doors**
- Per-API agent tooling generated from the published spec (P1); compact tool surface — search-then-load, never every endpoint as a tool
- Human-visible counterpart: "Connect your agent" tab on the API detail page

### 3.3 Gateway — `/gateway/{org}/{api}/…`

- The metered call path (behavior spec in PRODUCT.md "What happens on a call")
- Error semantics: `402` insufficient balance, `429` rate/quota exceeded, request-id header on every response
- Deprecation signaling on responses for sunsetting APIs (P1)

### 3.4 x402 machine payments (P1)

- Future signed-payment retry, facilitator verification, and settlement flow; no x402 payment implementation exists in the current tree
- Current `/gateway` and `/mock` failures use a generic `402` actions envelope (create key, top up, docs) for the prepaid-credit flow. That envelope contains no x402 payment requirements and cannot authorize or settle a payment

---

## 4. Publisher flow

### 4.1 Create organization — `/app/organizations/create`

- Name, slug (auto-derived), logo → org created, redirected in

### 4.2 Organization home — `/app/organizations/{org}`

- Publisher overview: total calls, revenue this cycle, top APIs, recent consumers, wallet summary

### 4.3 Projects — `/app/organizations/{org}/projects`

- Card list, New Project, empty state with CTA

### 4.4 Create project — `.../projects/create`

- Name (slug auto-derived), description → project page

### 4.5 Project page — `.../projects/{project}`

- Header: name, slug, status badge (draft/published), visibility badge (private/public), Make Public action
- Tabs: Overview / Spec / Analytics / Earnings / Settings
- Settings tab: description, tags, **upstream credentials** (attached to forwarded calls and never shown again after save), spec variables, danger zone

### 4.6 Spec editor — `.../projects/{project}/spec`

- Code editor with live validation, Issues panel, Save draft, Publish (semver dialog)
- JSON + YAML both accepted
- Pricing lint: warn on operations missing `x-zevium-cost`; pricing summary sidebar ("12 endpoints, 2–10 credits, free tier on 3")
- Import from URL / file upload
- Version history: published versions immutable, spec-diff between versions, rollback (P2)

### 4.7 Publisher analytics — `.../projects/{project}/analytics`

- Calls over time per endpoint, success rate, error-type breakdown (4xx / 5xx / upstream-timeout)
- Latency: p50 / p95 / p99 per endpoint
- Consumers: count, top consumers by calls (anonymized), retention
- Revenue: credits earned per endpoint per period
- Live-updating — dashboards tick per DESIGN.md "alive"

### 4.8 Earnings & payouts — `.../organizations/{org}/earnings` (P2)

- Accumulated publisher share (95%), settlement schedule, payout history, payout method, statement export
- `/app/org` handles payout onboarding and remediation. `/app/earnings` separates pending-risk, available, allocated, transferred, reversed, and failed earnings and shows transfer and bank-payout history. Staff can retry failed transfers. Zevium never displays or stores bank destinations.

### 4.9 Listing lifecycle

- Publish: auto-publish with automated gates (spec valid, upstream reachable, uptime probe); post-hoc review may delist
- Deprecate/unpublish (P1): cannot silently kill an API with active consumers — set sunset date → consumers notified (banner + email), gateway signals deprecation, new subscriptions freeze, wind-down, hard cutoff
- Quality surface (P2): uptime status on own listing, security-scan results, freshness nudges

### 4.10 Publisher webhooks (P1)

- Subscribe to: new consumer, usage spike / abnormal traffic, revenue milestone, key revoked

---

## 5. Org admin flow

### 5.1 Org settings — `.../organizations/{org}/settings`

- Profile (name, slug, logo), members list, roles (owner/admin/member), invite by email + role, remove member, danger zone
- Wallet admin: who may top up / set budgets (admin-only actions)

### 5.2 Invitations — `/app/invitations`

- Incoming invitations: accept / decline

### 5.3 Org switcher

- Sidebar switcher, per-tab active org; "Choose Organization" page when none active

---

## 6. Platform admin flow (staff-only, `/admin`)

- **Moderation queue**: new/updated public listings; approve / delist with reason
- **Quality dashboard**: listings failing uptime/security gates, auto-delist toggles
- **Users & orgs**: search, account state (wallet, keys, calls), suspend/ban
- **Billing ops**: top-up/refund lookup, manual credit grants (promotional credits), webhook replay
- **Platform metrics**: GMV, take, active consumers/publishers, call volume, error rates

---

## 7. Cross-cutting UI

- **Global shell**: collapsible sidebar, org switcher, breadcrumb header, theme toggle, user menu — motion per DESIGN.md (nav pill slides, sidebar collapse animation)
- **Toasts**: human-readable messages only — never raw errors/internals
- **Confirm dialogs**: global, promise-based, queued
- **Notifications (email + in-app)**: verification, invitations, budget thresholds, deprecation/sunset notices, payout notices, listing-status changes
- **Empty states**: every list has one, with a CTA (per DESIGN.md, revealed once)
- **Skeletons**: layout-stable, shaped like the real content

---

## 8. The two golden paths, end to end

### Consumer golden path

```
Landing → Sign up (personal org auto-created) → /app onboarding checklist
  → Catalogue → API detail → Try it (mock mode or free tier)
  → Create key (copy once) → Top up wallet (checkout)
  → First real call from playground or curl   ← under 60s from signup
  → Integrate (snippet) → watch usage/spend on billing page (live)
  → set budget alerts → top up again
```

### Publisher golden path

```
Sign up → Create org → Create project
  → Spec editor: import/paste OpenAPI → add x-zevium-cost per endpoint
  → attach upstream credentials → validate → Save draft → Publish v0.0.1
  → Make Public → automated gates pass → live in catalogue + discovery index + agent tools
  → watch Analytics tick (calls, p95, errors, revenue)
  → Earnings accrue at 95% → payout
```
