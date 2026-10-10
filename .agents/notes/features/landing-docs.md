# Landing & docs

> Status: partial · Updated: 2026-10-10
> Code: `apps/web/src/routes/index.tsx`, `apps/web/src/lib/landing.ts`, `apps/web/src/components/public-header.tsx`, `apps/web/src/routes/docs/index.tsx`, `apps/web/src/routes/docs/consuming.tsx`, `apps/web/src/routes/docs/publishing.tsx`, `apps/web/src/routes/docs/agents.tsx`, `apps/web/src/components/docs-layout.tsx`, `apps/web/src/components/docs-code-block.tsx`, `apps/web/src/components/catalogue-detail.tsx` (copy curl)
> Related: [catalogue-search](catalogue-search.md), [agent-surface](agent-surface.md), [mock-sandbox](mock-sandbox.md), [gateway](gateway.md), [accounts-orgs](accounts-orgs.md), [webhooks-notifications](webhooks-notifications.md), [design system](../design/design-system.md), [roadmap](../product/roadmap.md)

Public front door and integration help. Landing page pitches the agent-first marketplace and teases live catalogue listings; `/docs` is an in-app guide section (quickstart, consuming, publishing, agents). Integrate covers copy-paste snippets for leaving the app; generated SDKs are P2.

## Product

- Generated SDKs are P2 (listed in FLOW only; not on the PRODUCT roadmap).

## Flow

### Landing page — `/`

- Header: logo, Catalogue, Docs, theme toggle, Sign in — Docs is a standalone in-app section at `/docs` (quickstart, consuming, publishing, agents guides), not an external site
- Hero: agent-first value prop, primary CTA → catalogue. Motion per DESIGN.md (staggered entrance, magnetic CTA — the page's whole delight budget) — see [design system](../design/design-system.md)
- Proof strip: live catalogue teaser (top APIs with real pricing), "publishers keep 95%" pitch, stat row (APIs listed, calls served)
- How-it-works: three steps per side (publish spec → set price → earn) / (find API → get key → call)
- Footer: standard

### Integrate (leaving the app)

- Copy gateway base URL + key header snippet per language (curl/js/python) on every endpoint
- Generated SDKs (P2)

## Tech

### Code map (observed)

- Landing data: `catalogue.listPublic` via `convexQuery`; `pickLandingTeasers(liveItems, 3)` maps live items only. Empty → "No public APIs yet" card with "Publish an API" CTA; error → "Catalogue unavailable" + Retry. Skeleton only while pending with no items.
- Loader: client navigation to home starts teaser fetch without blocking shell; SSR awaits data for hydration (see "Authentication loading" in [accounts-orgs](accounts-orgs.md)).
- Landing sections in code: hero (Browse catalogue / Open dashboard / Create account), How it works (single 3-step list `HOW_STEPS`: publish spec with `x-zevium-cost` → discover and call → pay for successful calls, 95/5), consumer + publisher cards, For agents (MCP config snippet `buildMcpConfigSnippet`, `/mcp` + `/discovery` URLs from `VITE_GATEWAY_URL`, fallback `http://localhost:8787`), live catalogue teasers, footer.
- `/docs` routes: `index` (What is Zevium, Credits model, Quickstart, Next), `consuming` (API keys, calling through gateway, mock calls, response headers, zero balance blocks, refunds), `publishing` (model, pricing in spec, immutability, deprecation, webhooks), `agents`.
- Integrate: API detail ships "Copy curl" (keyless mock URL or placeholder key, never the real secret) plus agent config snippet; no js/python snippet generation.

## Decisions

- Wave 9 (user) — Docs: in-app `/docs` routes.
- 2026-07-19 — Generated SDKs and reviews/ratings stay deferred until catalogue has real supply and core paid journey is proven.
- Wave 6 — landing v2: scroll-depth sections, real footer, docs placeholder.

## Open questions

- Resolved 2026-10-10: old PLAN/BACKLOG fallback-teaser item was stale (fallbacks removed in commit `85aad61`, 2026-08-12); roadmap updated. Remaining blocker is publishing real listings.
- Proof-strip stat row (APIs listed, calls served) not in code; FLOW still lists it.
- How-it-works: FLOW wants three steps per side; code has one combined 3-step list plus per-side cards.
- Integrate snippets: FLOW wants curl/js/python per endpoint; code ships curl only.
