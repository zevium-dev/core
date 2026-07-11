# Zevium Technical Decisions

> Last updated: 2026-07-12
> Companions: [PRODUCT.md](PRODUCT.md) (what), [FLOW.md](FLOW.md) (screens), [DESIGN.md](DESIGN.md) (feel). This doc: **how it's built and why**.
> Greenfield rules apply: zero users, data disposable, rebuild beats migrate.

## Principles

1. **TypeScript everywhere.** The only hard language constraint. The one component that may ever be ported for efficiency (the proxy Worker) is deliberately isolated so a future Go rewrite touches nothing else.
2. **Control plane / data plane split.** The metered proxy is the product's hot path: latency-sensitive, streaming, global. It lives at the edge. Everything else (CRUD, dashboards, catalog, ledger authority) is the control plane and optimizes for developer velocity, not latency.
3. **Buy the undifferentiated, own the differentiated.** Auth, payments, database sync = bought. Credit gating, metering, proxy, MCP surface = ours (that's the product).
4. **The seams are where bugs live.** Current stack's four known bugs are all integration glue (embedding upsert, Better Auth server props, unmetered MCP, unwired secrets). Fewer seams > familiar seams.

## Stack decision (2026-07-11)

| Layer                  | Choice                                                                       | Replaces                                     |
| ---------------------- | ---------------------------------------------------------------------------- | -------------------------------------------- |
| Frontend               | React 19 + TanStack Start/Router + shadcn/ui + Motion                        | (kept)                                       |
| Control plane          | **Convex** (DB, functions, realtime sync, vector search, cron, file storage) | tRPC + Drizzle + Turso + Upstash Redis cache |
| Data plane             | **Cloudflare Worker** (proxy + edge credit gate + MCP endpoint)              | (kept, rebuilt thin)                         |
| Auth + orgs + API keys | **Clerk** (sessions, org UI, machine API keys — GA 2026-04)                  | Better Auth + its apikey plugin              |
| Payments               | **Polar** (checkout + merchant-of-record for top-ups ONLY)                   | Polar meters/benefits machinery              |
| Credit ledger          | **Convex is the source of truth** (own tables), Worker holds the edge gate   | Polar meter credits + Redis gate             |
| Embeddings             | Provider API (Gemini or similar) via Convex action → Convex `vectorIndex`    | Gemini + Turso `vector_top_k`                |

### Why Convex for the control plane (verified 2026-07-11)

- Realtime sync for free → dashboards that live-tick (feeds DESIGN.md "alive"), no cache invalidation code, no manual optimistic-update plumbing
- OCC hot-document contention on org wallets is a **named, solved problem**: first-party `@convex-dev/rate-limiter` component (sharded, transactionally-correct check-and-consume)
- Native vector search for catalogue semantic search
- Pricing sane: 25M function calls included at $25/seat; control-plane-only usage lands well inside it
- Constraint accepted: **single-region** (US-East or EU-West, +30%). Fine for the control plane; disqualifying for the proxy — which is why the proxy doesn't live there

### Why the proxy stays a Cloudflare Worker

- Convex is single-region with no edge story: +75–230ms per call for EU/Asia consumers. Proxy latency complaints helped kill RapidAPI; not repeating that
- Workers: global PoPs, native streaming passthrough (`fetch` → `Response` body pipe), cheap at millions of calls
- Isolated data plane = the future Go-port candidate, if ever needed

### Why Clerk

- Org-scoped billing is a product decision (PRODUCT.md); Clerk ships prebuilt `<OrganizationSwitcher/>`, `<OrganizationProfile/>`, invitations, roles — weeks of UI we don't build
- **Machine API Keys GA (2026-04-17)**: end-user keys scoped to user or organization, prebuilt management UI, $0.001/creation + $0.00001/verification (first 100k verifications/mo free). Replaces the Better Auth apikey plugin (the currently-broken piece)
- Deepest Convex auth integration (`ConvexProviderWithClerk`, JWT templates)
- Known caveats: TanStack Start SDK is beta; vendor lock accepted (greenfield, zero users, worst case is a rebuild we've already proven we can do)
- **Clerk Billing is NOT used**: verified subscriptions-only, no metered/usage billing, no self-serve credit top-ups, and it stacks 0.7% on Stripe fees. Billing is ours + Polar checkout

### Why Polar shrinks to checkout-only

- Polar keeps: hosted checkout, merchant-of-record (global tax — real work we don't want), one-time credit-pack products, `order.paid` webhooks
- Polar loses: meters, meter-credit benefits, customer-state as balance authority. Verified: Polar never enforces balances anyway and metered prices attach to subscriptions only — the machinery fought our model
- Flow: Polar checkout success → webhook → Convex mutation grants credits to org ledger. One direction, one seam

## Repo shape

pnpm workspace + **Turborepo** (same pattern as sharath.ai):

```
apps/web/        # TanStack Start app (all screens)
apps/gateway/    # CF Worker: proxy, wallet DO, agent endpoint
convex/          # Convex schema + functions (control plane)
packages/shared/ # spec parsing, x-zevium-* extraction, types shared web↔gateway
```

Turborepo drives build/typecheck/test/lint pipelines with caching; each app deploys independently (web → its host, gateway → Cloudflare, convex → `npx convex deploy`).

## Architecture

```
                    ┌──────────────────────────────────────────┐
  Browser ◀────────▶│ CONVEX (control plane, single region)    │
   realtime sync    │  orgs mirror, projects, specs+versions,  │
   (dashboards,     │  catalogue, credit LEDGER (truth),       │
    editors)        │  usage events, analytics rollups,        │
                    │  vector search, crons                    │
                    └───────▲──────────────┬───────────────────┘
                            │ webhooks     │ ledger sync (push on change
                            │ (Clerk, Polar│  + reconcile cron)
                            │  events)     ▼
┌─────────┐         ┌──────────────────────────────────────────┐
│ Clerk   │◀───────▶│ CLOUDFLARE WORKER (data plane, edge)     │
│ auth,   │ key     │  /proxy/{org}/{project}/*  + /mcp        │
│ orgs,   │ verify  │  1. verify API key (edge-cached)         │
│ API keys│ (cached)│  2. credit gate (Durable Object wallet)  │
└─────────┘         │  3. inject publisher upstream secrets    │
┌─────────┐         │  4. stream upstream response             │
│ Polar   │─webhook▶│  5. emit usage event → Convex (async)    │
│ checkout│ (grants)│  6. non-2xx → refund reservation         │
└─────────┘         └──────────────────────────────────────────┘
```

### Credit gate design (the hot path)

- **Durable Object per org wallet**: single-threaded actor = race-free reserve/settle/refund with zero lock code, lives at the edge near traffic
- Convex ledger is authoritative; DO holds a working balance. Sync: Convex pushes on grant/adjust (webhook → DO), DO flushes settled usage to Convex in batches (async, no hot-path dependency); reconcile cron heals drift
- Zero balance **blocks** (PRODUCT.md rule: never surprise-overage). DO answers in-memory → sub-ms gate
- Key verification: Clerk verify API on first sight → cached in the DO/KV with TTL; Clerk webhooks (key revoked/updated) purge cache. Hot path never waits on Clerk

### What each domain owns (Convex schema sketch)

- `organizations` (mirror of Clerk orgs via webhook; Clerk is auth truth, Convex holds app data keyed by Clerk org id)
- `projects`, `specs` + `specVersions` (immutable published versions), `catalogueMeta` (derived quality signals)
- `wallets` (ledger: grants, reservations, settlements, refunds — append-only entries + materialized balance)
- `usageEvents` (per-call: project, endpoint, org, credits, latency, status) + rollup tables via cron (publisher analytics p95/p99 come from here)
- `embeddings` via `vectorIndex` (catalogue semantic search)

## Implementation notes (verified against code, waves 1-9 + hardening)

Decisions made during the build that extend or sharpen the stack decision above:

- **Usage ingest pipe**: the wallet DO's alarm (~5s, non-empty pending queue) batches settled usage and `POST`s it to `{CONVEX_SITE_URL}/ingest-usage`, an `httpAction` authenticated by a shared `x-internal-secret` header (`GATEWAY_INTERNAL_SECRET`) — no Convex deploy key on the hot path. `CONVEX_DEPLOY_KEY` remains as a fallback constructor path only, unused when the shared secret is configured
- **Cross-org metering**: the consumer's own org wallet always pays, never the publisher's. Private projects called with a key from a foreign org 404 (`project_not_found`) rather than 401/403, so private listings never leak existence to an unauthorized caller
- **Gateway CORS**: `/gateway`, `/mock`, `/discovery`, `/mcp` all allow wildcard origin. Safe because auth is bearer-key only, never cookie-based — a wildcard origin doesn't widen the attack surface for a bearer-token API
- **Per-key caps + rotation**: enforced in the wallet DO, not per-request against Convex. A `keySettings` sync (`/wallet-grants` pull) refreshes disabled/monthly-cap/rotation-grace state at ≤60s staleness (`SYNC_GRANTS_WINDOW_MS`, rate-limited to 1/60s per org). Only a monthly cap exists today (no daily/weekly reset windows); rotation grants the old key a 24h grace period before hard cutoff
- **Polar manual sync**: `billing.syncWithPolar` action, gated by a server-side 5-minute cooldown (`POLAR_SYNC_COOLDOWN_MS`, stamped on the wallet doc) rather than a live webhook-only flow. Reconciles both planes via the wallet DO's `/sync-grants` HTTP surface — a user-triggered "Sync" button covers webhook delivery gaps without polling
- **Semantic search**: embeddings come from `gemini-embedding-001` pinned to `outputDimensionality: 768` (matches the `specEmbeddings` `by_embedding` vectorIndex). Not `text-embedding-004` — that model was removed from the Gemini v1beta API (404) and `gemini-embedding-001` is its 768-dim replacement
- **Publisher webhooks**: HMAC-SHA256 signed (`x-zevium-signature` header, hex digest over the raw body), delivered with up to 3 attempts and backoff of 60s then 300s between retries before marking a delivery failed
- **Deprecation signaling**: RFC 8594 headers on gateway responses for deprecated spec versions — `Deprecation: @<epoch-seconds>`, `Sunset: <HTTP-date>`, `Link: <catalogue-url>; rel="deprecation"`
- **Admin gate**: platform-admin access is an env allowlist, `ADMIN_USER_IDS` (Clerk subject ids), checked server-side in Convex — no separate roles table
- **Payouts**: manual-ledger MVP, not automatic scheduled settlement. Publishers request a payout once accumulated net earnings clear `MIN_PAYOUT_CREDITS` (100,000 credits = $10); the request lands in `payoutRequests` and is fulfilled by platform ops through the `/admin` payout queue
- **x402**: a stub, not the full rail. Every unauthenticated/invalid-key/insufficient-credit response on the keyless-capable surfaces (`/gateway`, `/mock`) returns a `402` with a machine-readable `actions` envelope (create-key, top-up, docs links) so an agent can self-serve next steps. No payment-header verification via a facilitator yet — that part of the x402 rail is still deferred (see below)

## What dies from the current repo

tRPC + oRPC, Drizzle + Turso, Upstash Redis, Better Auth (+ apikey plugin), Polar plugin wiring in auth, drizzle/ migrations, the seed script in current form. Route tree, shadcn components, and Motion setup carry over conceptually; code is rewritten against Convex hooks.

## Pre-build spikes — all verified GO (2026-07-11)

Four spikes ran as real code (scratch projects, reports + artifacts in session scratchpad). Verdicts and the design consequences they bought:

1. **Clerk + TanStack Start SDK** — GO. `@clerk/tanstack-react-start` 1.4.x: install/typecheck/production build clean against Start 1.168 + React 19.2; `auth()` works in server functions via `clerkMiddleware` → Start context → `ClerkProvider` hydration. Notes: **pin `react`/`react-dom`** (Clerk peers use tilde patch ranges, `19.4.x` would break resolution); middleware hard-fails all routes on bad keys; route protection is opt-in per route; Start scaffold pins `nitro-nightly` — budget upgrade churn. Live auth flow still unproven until a real Clerk instance exists
2. **Clerk API-key verify from Workers** — GO. `POST /v1/api_keys/verify` returns `subject` (`org_`/`user_`), scopes, expiry, revoked — everything the gateway cache needs. Measured p50 ~94ms fresh / ~33ms keepalive → confirms cache-first. Limits: 1000 req/10s per instance; $0.00001/verify after 100k/mo. **No `api_key.*` webhook events exist** → cache purge must come from OUR key screens (call Clerk, then purge wallet-DO cache) + short TTL (~60s) safety net. Do not use Clerk's prebuilt key-management component — it would bypass the purge. `@clerk/backend` is workerd-compatible
3. **Convex + TanStack Start SSR** — GO. Proven: Start loader `ensureQueryData(convexQuery(...))` fetches via HTTP client during SSR, listing text present in raw HTML (view-source SEO requirement), client hydrates into WebSocket subscription with same query keys. Convex local dev works with **zero account** (`CONVEX_AGENT_MODE=anonymous`) — CI/fresh-clone DX solved. Authed SSR needs explicit server-side token forwarding (Clerk guide exists)
4. **Wallet DO reconcile invariant** — GO. Full DO implemented + fuzz-tested in workerd (10/10 green; 200-op runs with ~30% ack loss and forced evictions). Invariant held: `ledgerGrants − ledgerSettled == doBalance + inFlight`, never negative. Hardening baked into the design: **stable settlement ids** (`settle:{reservationId}` — batch ids insufficient under lost-ack), terminal map for settle/refund idempotency, `storage.transaction` + `blockConcurrencyWhile` reload, refund restores availability without a ledger row. Spike code seeds `apps/gateway`

## Later (explicitly deferred)

- Go port of the proxy Worker if TypeScript ever becomes the bottleneck (isolated by design; measure first)
- x402 rail, full: the 402 + actions-envelope stub is live (see Implementation notes above); actual payment-header verification via a facilitator is still deferred — P1 per PRODUCT.md, lands after the credit path is solid
- Multi-region Convex / read replicas: not our problem; control plane latency is not user-facing hot path
