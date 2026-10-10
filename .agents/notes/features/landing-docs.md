# Landing & docs

> Status: partial (web `/llms.txt` #322 and shared client installs #326 built) · Updated: 2026-10-10
> Code: `apps/web/src/routes/index.tsx`, `apps/web/src/lib/landing.ts`, `apps/web/src/components/public-header.tsx`, `apps/web/src/routes/docs/index.tsx`, `apps/web/src/routes/docs/consuming.tsx`, `apps/web/src/routes/docs/publishing.tsx`, `apps/web/src/routes/docs/agents.tsx`, `apps/web/src/components/docs-layout.tsx`, `apps/web/src/components/docs-layout.test.tsx`, `apps/web/src/components/docs-code-block.tsx`, `apps/web/src/components/catalogue-detail.tsx` (copy curl), `apps/web/src/routes/llms[.]txt.ts`, `apps/web/src/lib/llms.ts`, `apps/web/src/lib/llms.test.ts`, `apps/web/src/components/agent-install.tsx`
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

**Dogfood — 2026-10-10**

- **P2 #386:** production docs have no main landmark.
- Existing **#326** also covers client-specific config friction: Claude Code rejected the generic URL/headers JSON; adding `"type": "http"` connected to local MCP. Production `/llms.txt` remains 404 (**#322**).

Evidence, workarounds and scope: [dogfood findings](../findings/dogfood-2026-10-10.md).

- **Docs landmark (#386)**: `DocsPage` wraps its article in the page’s single `<main id="main-content" tabIndex={-1}>`; the public-header skip link targets this focusable landmark. Shared layout applies to desktop and mobile. Component tests cover all four guides.
- Web `/llms.txt` provides an agent-readable setup guide; `/docs/agents` links to it. Request/config-derived URLs, route validation, current gateway error semantics, and client format references are owned by [agent surface](agent-surface.md#tech).
- `AgentInstall` replaces the three MCP config blocks on landing, agent docs, and listing agent tabs. Claude Code command, Cursor install link + JSON, and Codex TOML share `DocsCodeBlock` → `CopyButton` copy behavior and `ak_YOUR_API_KEY`. Listing usage notes also use that copy block. Docs mock URLs use `tryItBaseUrl` to normalize gateway origins ending in `/gateway`.
- Publisher guide (#316) states that missing prices hide operations and prevent calls; explicit `x-zevium-cost: 0` is required for free endpoints. No default-credit fallback is documented.

### Code map (observed)

- Landing data: `catalogue.listPublic` via `convexQuery`; `pickLandingTeasers(liveItems, 3)` maps live items only. Empty → "No public APIs yet" card with "Publish an API" CTA; error → "Catalogue unavailable" + Retry. Skeleton only while pending with no items.
- Loader: client navigation to home starts teaser fetch without blocking shell; SSR awaits data for hydration (see "Authentication loading" in [accounts-orgs](accounts-orgs.md)).
- Landing sections in code: hero (Browse catalogue / Open dashboard / Create account), How it works (single 3-step list `HOW_STEPS`: publish spec with `x-zevium-cost` → discover and call → pay for successful calls, 95/5), consumer + publisher cards, For agents (shared `AgentInstall` client instructions, `/mcp` + `/discovery` URLs from `VITE_GATEWAY_URL`, fallback `http://localhost:8787`), live catalogue teasers, footer.
- `/docs` routes: `index` (What is Zevium, Credits model, Quickstart, Next), `consuming` (API keys, calling through gateway, mock calls, response headers, zero balance blocks, refunds), `publishing` (model, pricing in spec, immutability, deprecation, webhooks), `agents`.
- `/docs/publishing` documents all five emitted publisher webhook events and visibility-change payload/no-op semantics (#393); event contract owned by [webhooks-notifications](webhooks-notifications.md).
- Integrate: API detail ships "Copy curl" (keyless mock URL or placeholder key, never the real secret) plus agent config snippet; no js/python snippet generation.

## Decisions

- 2026-10-10 — Web distribution implementation of [P0 agent bet](../decisions/2026-10-10-p0-agent-bet.md): #326 client installs share one component; #322 serves web `/llms.txt`, with gateway-side copy deferred to avoid concurrent gateway restructuring. Catalogue changes are limited to the agent panel.

- Wave 9 (user) — Docs: in-app `/docs` routes.
- 2026-07-19 — Generated SDKs and reviews/ratings stay deferred until catalogue has real supply and core paid journey is proven.
- Wave 6 — landing v2: scroll-depth sections, real footer, docs placeholder.

## Open questions

- Resolved 2026-10-10: old PLAN/BACKLOG fallback-teaser item was stale (fallbacks removed in commit `85aad61`, 2026-08-12); roadmap updated. Remaining blocker is publishing real listings.
- Proof-strip stat row (APIs listed, calls served) not in code; FLOW still lists it.
- How-it-works: FLOW wants three steps per side; code has one combined 3-step list plus per-side cards.
- Integrate snippets: FLOW wants curl/js/python per endpoint; code ships curl only.
