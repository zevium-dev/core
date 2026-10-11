# Catalogue and search

> Status: root cutover and generated Try it form implemented; owner activation pending · Updated: 2026-10-11
> Code: `convex/{catalogue,search,lib/catalogue}.ts`, `apps/web/src/components/{catalogue-browser,catalogue-detail}.tsx`, `apps/web/src/lib/catalogue-search.server.ts`, `tests/readSurfaces.test.ts`
> Related: [quality-signals](quality-signals.md), [reviews](reviews.md), [mock-sandbox](mock-sandbox.md), [agent-surface](agent-surface.md), [pricing](pricing.md), [publishing-specs](publishing-specs.md), [listing-lifecycle](listing-lifecycle.md), [landing-docs](landing-docs.md), [web-app](../architecture/web-app.md)

The public, no-auth catalogue of published APIs and each API's detail page. It is the SEO surface, the human evaluation surface, and the shared shell for the authenticated in-app catalogue. Discovery is semantic search plus tag filters; spec metadata drives every listing page.

## Product

- **Catalogue with quality signals** (search part; badges in [quality-signals](quality-signals.md)): semantic search + tag filters derived from spec metadata.
- Roadmap P0 #7 — Catalogue quality signals (latency, success rate, freshness) + semantic search ([roadmap](../product/roadmap.md)).
- Consumers (human developers) browse the catalogue, get a key, test in the playground, integrate ([product overview](../product/overview.md)).

### Research ideas — not decided

Source: [agent-api-marketplace-landscape](../research/agent-api-marketplace-landscape.md#trust-sell-your-agent-cannot-overspend-and-measured-quality).

- **Require a "use when" line and an output schema on every listing.** Evidence: Coinbase x402 Bazaar showed 34,062 listings on 2026-10-09, 94% lacked a "use when" line; nobody else enforces it.

## Flow

### Public catalogue — `/catalogue`

- **Public, no auth** — SEO surface + agents + zero-friction evaluation.
- Search (semantic), tag filters, sort (relevance / popularity / recently updated), filters (price range, has-free-tier).
- Listing cards: name, org, description, price range, quality badges (latency, success rate, freshness), agent-ready badge.
- Any paid action (key, real playground call) gates to sign-up.

### API detail page — `/catalogue/{org}/{api}` (public)

The listing's product page — shareable URL, the API's landing page. Spec metadata drives everything.

- Header: name, org, tags, quality badges (latency p50, success rate, uptime, freshness), agent-ready badge.
- Pricing table: per-endpoint credits, free tier highlighted ([pricing](pricing.md)).
- Docs: rendered from the published spec — three-column pattern (nav / prose / runnable code samples in curl/js/python), prose↔code hover-sync.
- **Try it** panel and **Mock mode** → [mock-sandbox](mock-sandbox.md).
- **Connect your agent** tab → [agent-surface](agent-surface.md).
- Version picker: published versions, spec-diff changelog between versions (P2) ([listing-lifecycle](listing-lifecycle.md)).
- Reviews/ratings (P2) → [reviews](reviews.md).

### In-app catalogue — `/app/catalogue`

- Browse actions open `/app/catalogue`; listing cards open `/app/catalogue/{org}/{api}`. Search, filters, API reference, playground, and back navigation keep the dashboard sidebar. Public catalogue URLs remain shareable outside the app.

## Tech

URL drafts reset during render only when the committed value changes; debounce callbacks use `useEffectEvent` in `apps/web/src/lib/catalogue-search.ts`. Playground parameters/body reset on endpoint identity changes, with initial defaults ready on first render; stored API-key hydration uses `useSyncExternalStore` in `apps/web/src/components/catalogue-detail.tsx`.

The detail playground derives typed parameters and JSON body controls from the immutable published operation (#427). `apps/web/src/lib/openapi-reference.ts` attaches the shared form model; `apps/web/src/components/schema-form.tsx` renders it. Supported shapes, raw fallback and validation limits are owned by [mock-sandbox](mock-sandbox.md#generated-request-form-427).

Catalogue price chips and detail labels contain only scalar per-call prices; dead `hasTokenPricing` / `tokenPricing` display branches are removed. Code: `apps/web/src/lib/catalogue-card.ts` and `apps/web/src/components/catalogue-detail.tsx`.

Root indexed browse/tag pages and facet counters are canonical. Query embeddings use a separate non-vector fenced cache; cache misses consume sharded trusted budgets. Direct anonymous actions degrade before buying embeddings; web connects through an authenticated server/IP-budget boundary when configured. Public hydration rechecks current visibility and omits unpriced/token operations. Combined filters can return short pages with continuations; totals describe selected tag/global catalogue, not arbitrary filter matches. Cards and detail render Operated by Zevium from server-owned houseOperated.

[Activation gates and configuration](../architecture/convex-activation.md). [PR 1–6 design/review evidence](../architecture/convex-rebuild.md).

## Decisions

- 2026-10-11 — PR #442 applies [read-surface review defaults](../decisions/2026-10-11-read-surface-review-defaults.md), pending owner sign-off.

- None recorded beyond TECH.md bullets above.
- 2026-10-10 — BUILT (#316): operations without `x-zevium-cost` are hidden and not callable; free only when explicitly `0`. Publishing remains allowed with a warning. [decision](../decisions/2026-10-10-unpriced-operations-hidden.md)
- 2026-10-10 — House listings labeled "Operated by Zevium". [decision](../decisions/2026-10-10-house-supply-via-aggregators.md)

## Open questions

- Resolved #330: MCP discovery reuses semantic search and cache; paraphrases produce the same ranked listings through public and gateway entry points.

- Resolved #358: semantic requests are rate-limited and query embeddings cached. Anonymous callers share one bucket until a trusted edge-derived identity becomes available; legitimate anonymous bursts can therefore use keyword fallback.

- FLOW sort "relevance / popularity / recently updated"; code sorts `newest`/`name`/`cheapest` (relevance only in semantic mode). No popularity sort.
- FLOW filter "price range"; code has max cost only.
- PRODUCT "tag filters derived from spec metadata"; code tags are admin-set project tags (`projects.update`, ≤32), not derived from the spec.
- FLOW cards show agent-ready badges; that badge remains detail-page-only. Quality badges ship on cards (#331).
- FLOW docs "three-column, curl/js/python, hover-sync"; code detail shows a `Reference` tab and curl copy only. Verify against FLOW or fix doc.
- Version picker on detail page absent; only latest version shown.
- Research idea ("use when" line + output schema required) undecided.
