# Zevium Technical Decisions

> Last updated: 2026-07-11
> Companions: [PRODUCT.md](PRODUCT.md) (what), [FLOW.md](FLOW.md) (screens), [DESIGN.md](DESIGN.md) (feel). This doc: **how it's built and why**.
> Greenfield rules apply: zero users, data disposable, rebuild beats migrate.

## Principles

1. **TypeScript everywhere.** The only hard language constraint. The one component that may ever be ported for efficiency (the proxy Worker) is deliberately isolated so a future Go rewrite touches nothing else.
2. **Control plane / data plane split.** The metered proxy is the product's hot path: latency-sensitive, streaming, global. It lives at the edge. Everything else (CRUD, dashboards, catalog, ledger authority) is the control plane and optimizes for developer velocity, not latency.
3. **Buy the undifferentiated, own the differentiated.** Auth, payments, database sync = bought. Credit gating, metering, proxy, MCP surface = ours (that's the product).
4. **The seams are where bugs live.** Current stack's four known bugs are all integration glue (embedding upsert, Better Auth server props, unmetered MCP, unwired secrets). Fewer seams > familiar seams.

## Stack decision (2026-07-11)

| Layer | Choice | Replaces |
| --- | --- | --- |
| Frontend | React 19 + TanStack Start/Router + shadcn/ui + Motion | (kept) |
| Control plane | **Convex** (DB, functions, realtime sync, vector search, cron, file storage) | tRPC + Drizzle + Turso + Upstash Redis cache |
| Data plane | **Cloudflare Worker** (proxy + edge credit gate + MCP endpoint) | (kept, rebuilt thin) |
| Auth + orgs + API keys | **Clerk** (sessions, org UI, machine API keys — GA 2026-04) | Better Auth + its apikey plugin |
| Payments | **Polar** (checkout + merchant-of-record for top-ups ONLY) | Polar meters/benefits machinery |
| Credit ledger | **Convex is the source of truth** (own tables), Worker holds the edge gate | Polar meter credits + Redis gate |
| Embeddings | Provider API (Gemini or similar) via Convex action → Convex `vectorIndex` | Gemini + Turso `vector_top_k` |

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

## What dies from the current repo

tRPC + oRPC, Drizzle + Turso, Upstash Redis, Better Auth (+ apikey plugin), Polar plugin wiring in auth, drizzle/ migrations, the seed script in current form. Route tree, shadcn components, and Motion setup carry over conceptually; code is rewritten against Convex hooks.

## Open verifications before build starts

1. Clerk TanStack Start SDK beta — smoke-test the auth flow in a spike before committing (fallback: Clerk React SDK + manual SSR token handling)
2. Clerk API-key verification latency + rate limits from Workers — measure; tune cache TTL accordingly
3. Convex + TanStack Start data loading (`@convex-dev/react-query`) SSR behavior for public SEO pages (catalogue, API detail)
4. DO wallet ↔ Convex ledger sync: write the reconcile invariant first (sum of ledger == DO balance ± in-flight)

## Later (explicitly deferred)

- Go port of the proxy Worker if TypeScript ever becomes the bottleneck (isolated by design; measure first)
- x402 rail: implemented in the Worker (402 + payment header verification via facilitator) — P1 per PRODUCT.md, lands after the credit path is solid
- Multi-region Convex / read replicas: not our problem; control plane latency is not user-facing hot path
