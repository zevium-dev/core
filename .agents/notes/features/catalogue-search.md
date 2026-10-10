# Catalogue and search

> Status: built (P0 #7 semantic search built; #330 MCP parity built; FLOW gaps listed in Open questions) · Updated: 2026-10-10
> Code: `convex/catalogue.ts`, `convex/search.ts`, `convex/catalogue.test.ts`, `convex/search.test.ts`, `convex/http.ts` (`/gateway-search`), `apps/gateway/src/catalogue-search.ts`, `apps/web/src/routes/catalogue.tsx`, `apps/web/src/routes/catalogue/index.tsx`, `apps/web/src/routes/catalogue/$publisherHandle.$projectSlug.tsx`, `apps/web/src/routes/app/catalogue/index.tsx`, `apps/web/src/routes/app/catalogue/$publisherHandle.$projectSlug.tsx`, `apps/web/src/components/catalogue-browser.tsx`, `apps/web/src/components/catalogue-detail.tsx`, `apps/web/src/components/catalogue-shell.tsx`, `apps/web/src/components/route-providers.tsx`, `apps/web/src/lib/catalogue-search.ts`, `apps/web/src/components/copy-button.tsx`, `apps/web/src/components/list-boundary.tsx`, `apps/web/src/lib/format.ts`, `convex/convex.config.ts`, `convex/schema.ts`, `searchQueryEmbeddings`
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

- **Per-token pricing (#329)**: built for OpenAI-compatible JSON/SSE. Spec rates are exposed in catalogue references, editor, discovery, and MCP; admission holds an estimated maximum, an asynchronous tee observer settles actual usage, and wallet settlement releases the remainder. Missing usage charges zero. Wallet budget, whole-credit rounding, stream/parser limits, and `x-zevium-hold` are defined in the [pricing contract](../decisions/2026-10-10-llm-per-token-pricing.md#implementation-contract-329). Code: `packages/shared/src/pricing.ts`, `apps/gateway/src/token-metering.ts`, `apps/gateway/src/{admit,finalize,wallet}.ts`, `convex/wallets.ts`. Unpriced operations are hidden; explicit zero-price calls remain available to funded wallets.

- **Realtime lists (#363)**: `CatalogueList` uses Convex `usePaginatedQuery` over `catalogue.listPublicPaginated`; every loaded page remains subscribed and filter arguments reset pagination during render. Empty filtered pages remain loadable. `listPublic` retains its cursor/items contract for landing and SSR callers; the new endpoint shares its indexed implementation and preserves Convex split/end cursors. `publicFacets` subscribes independently. Public catalogue reuses its dehydrated first page while the live hook starts.
- **Detail fixes (#363)**: endpoints memoize on the immutable spec string; playground defaults reset only on selected endpoint id, preserving inputs/results during quality refreshes. Agent notes normalize the live `/gateway` base; key placeholder uses `ak_`; sign-in return paths follow the active catalogue namespace. Quality percentages require finite numeric evidence. Request/reference examples use shared `mock.ts` synthesis, including component refs.
- **Shared presentation (#363)**: stock shadcn Table, `components/copy-button.tsx`, `lib/format.ts`, and local `ListBoundary` replace duplicate rendering/copy/error machinery. Public and in-app route adapters remain separate because their authentication/provider and SSR boundaries differ; their page components are shared.
- **Semantic cost controls (#358)**: `@convex-dev/rate-limiter` is registered in `convex/convex.config.ts`. Before cache lookup or Gemini, token buckets permit 20 requests/minute per verified `tokenIdentifier`, 30/minute for the shared anonymous surrogate, and 120/minute across all callers (burst capacity equals each rate). The internal gateway search action additionally applies 20/minute per verified org and org/key pair, so rotating keys cannot evade an org limit; it shares the 120/minute global budget and embedding cache with web searches. Attribution is accepted only through the secret-authenticated HTTP route, from gateway-verified credentials. Public Convex actions expose no trusted anonymous IP/session; caller-supplied identifiers are not accepted. Refusal returns the existing `{ items: [], degraded: true }` keyword fallback without invoking Gemini.
- **Query embedding cache (#358)**: indexed `searchQueryEmbeddings` stores a normalized query (trimmed, capped at 200 chars) under a model/dimensions/task-specific key for 24 hours. Limit/result filtering are not cached; each search still rechecks listing visibility. A 30-second transactional claim prevents concurrent identical misses from repeating Gemini calls; pending callers fall back. Gemini has a 10-second timeout and validates 768 finite values. Failed attempts clear the claim; scheduled cleanup removes expired rows. `convex/search.test.ts` verifies burst refusal, identity/global limits, cache reuse/expiry, concurrent misses, and failed response retries.

From [architecture overview](../architecture/overview.md):

- **Catalogue routes**: public `/catalogue` and authenticated `/app/catalogue` adapters share catalogue and API-detail components. Each adapter owns typed route search and navigation; the app namespace inherits its sidebar and authenticated provider boundary. Cards, empty-state actions, and back links stay in their current namespace.
- **Navigation providers**: the root public Convex provider follows committed route matches, so an outgoing catalogue keeps its context while an authenticated destination loads. Signed-in catalogue detail pages lazily add Clerk and Convex authentication for review eligibility and publisher responses; anonymous public pages keep the plain Convex provider. Protected browser loaders do not start Convex queries; app routes finish user/organization mirroring before mounting tenant query components. Provider organization slugs permit repeated hyphens and up to 256 characters; canonical publisher handles remain strict 64-character kebab case and are allocated separately. Project list clicks seed the exact project detail query from the already authorized list document, retaining the current principal/org query scope so cold list→detail navigation has a complete morph destination. Wallet query failures stay within the dashboard's balance card instead of replacing its usage and navigation. Clerk CSS is injected into the `components` cascade layer through `ClerkProvider.appearance`, allowing Tailwind utilities to style embedded profiles consistently.
- **Semantic search**: embeddings come from `gemini-embedding-001` pinned to `outputDimensionality: 768` (matches the `specEmbeddings` `by_embedding` vectorIndex). Not `text-embedding-004` — that model was removed from the Gemini v1beta API (404) and `gemini-embedding-001` is its 768-dim replacement
- `specEmbeddings` via `vectorIndex` (catalogue semantic search)

Code facts (read from source 2026-10-10, not from TECH.md):

- Browse: `catalogue.listPublic` (args `search`, `tag`, `cursor`, `sort` = `newest`|`name`|`cheapest`, `hasFreeTier`, `maxCost`; search ≤200 chars, tag ≤64) reads the `catalogueListings` projection maintained by `syncCatalogueListing`, returns items, total, tag facets, free-tier count. Detail: `catalogue.getPublicDetail` (project, org, latest version incl. deprecation fields, quality snapshot).
- Semantic: `search.searchCatalogue` action (query ≤200 chars, limit default 10, max 20). Gemini failure returns `{ items: [], degraded: true }`, never throws. One embedding per project from name + description + tags + `METHOD path summary` per operation, rebuilt on publish (`specs.publish` schedules `search.embedProject`). `fetchSearchListings` re-checks public + published + active route before shaping cards. Both web and MCP rank up to 20 candidates by vector score, then fresh, sufficient gateway-measured API success rate (descending) and latency p50 (ascending), with publisher/slug as deterministic final tie-breaks. Missing, stale, or insufficient API measurements do not count as quality evidence; reachability is not used as API success. Ranking runs before the requested result limit.
- Web: semantic mode is a URL search flag (`semantic`), separate from keyword `q` filtering; cards show relevance score on semantic hits. Card/detail share `data-transition-surface` for list→detail morph.
- Detail tabs: `Try it`, `Reference`, `Connect your agent`; `QualityBadges`, deprecation banner and `ReviewSection` render on the page. Agent-ready badge shows when the published spec has ≥1 endpoint.

- **Card quality (#331)**: browse and semantic cards render compact `QualityBadges` with gateway success/latency, health-endpoint reachability and measurement freshness. Insufficient evidence retains the 20-call/3-probe floors. `catalogueListings.quality` stores current-version aggregates; normal paginated browse maps them without per-card snapshot reads. Maintenance/backfill details live in [quality-signals](quality-signals.md).

## Decisions

- None recorded beyond TECH.md bullets above.
- 2026-10-10 — BUILT: operations without `x-zevium-cost` are hidden and not callable; free only when explicitly `0`. Replaces code's default of 1 credit. [decision](../decisions/2026-10-10-unpriced-operations-hidden.md)
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
