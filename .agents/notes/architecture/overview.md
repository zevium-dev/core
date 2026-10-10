# Architecture overview

> Updated: 2026-10-10 (split from former root `TECH.md`, last updated 2026-08-12)
> Greenfield rules apply: zero users, data disposable, rebuild beats migrate.
> Feature-level implementation lives in each `../features/*.md` Tech section. This file owns only cross-cutting architecture.

## Principles

1. **TypeScript everywhere.** The only hard language constraint. The one component that may ever be ported for efficiency (the proxy Worker) is deliberately isolated so a future Go rewrite touches nothing else.
2. **Control plane / data plane split.** The metered proxy is the product's hot path: latency-sensitive, streaming, global. It lives at the edge. Everything else (CRUD, dashboards, catalog, ledger authority) is the control plane and optimizes for developer velocity, not latency.
3. **Buy the undifferentiated, own the differentiated.** Auth, payments, database sync = bought. Credit gating, metering, proxy, MCP surface = ours (that's the product).
4. **The seams are where bugs live.** Cross-service identity, metering, cache and webhook boundaries receive explicit tests. Fewer seams > familiar seams.

## Stack decision (2026-07-12)

Decision record: [2026-07-12-stack](../decisions/2026-07-12-stack.md).

| Layer                  | Choice                                                                       | Replaces                                     |
| ---------------------- | ---------------------------------------------------------------------------- | -------------------------------------------- |
| Frontend               | React 19 + TanStack Start/Router + shadcn/ui + Motion                        | (kept)                                       |
| Control plane          | **Convex** (DB, functions, realtime sync, vector search, cron, file storage) | tRPC + Drizzle + Turso + Upstash Redis cache |
| Data plane             | **Cloudflare Worker** (proxy + edge credit gate + MCP endpoint)              | (kept, rebuilt thin)                         |
| Auth + orgs + API keys | **Clerk** (sessions, org UI, machine API keys — GA 2026-04)                  | Better Auth + its apikey plugin              |
| Payments               | **Stripe Checkout + Connect** (top-ups, publisher onboarding/transfers)      | Polar checkout + manual payouts              |
| Credit ledger          | **Convex is the source of truth** (own tables), Worker holds the edge gate   | Vendor credit ledgers + Redis gate           |
| Embeddings             | Provider API (Gemini or similar) via Convex action → Convex `vectorIndex`    | Gemini + Turso `vector_top_k`                |

### Why Convex for the control plane

- Realtime sync for free → dashboards that live-tick (feeds [design system](../design/design-system.md) "alive"), no cache invalidation code, no manual optimistic-update plumbing
- OCC hot-document contention on org wallets is a **named, solved problem**: first-party `@convex-dev/rate-limiter` component (sharded, transactionally-correct check-and-consume)
- Native vector search for catalogue semantic search
- Control-plane traffic is outside the per-call proxy hot path; vendor price and region choices must be rechecked against the active account before launch

### Why the proxy stays a Cloudflare Worker

- Worker placement keeps request streaming and credit authorization out of the control-plane request path
- Workers support native streaming passthrough (`fetch` → `Response` body pipe)
- Isolated data plane = the future Go-port candidate, if ever needed

### Why Clerk / Why Stripe

Owned by feature notes: [accounts-orgs](../features/accounts-orgs.md) (Clerk), [wallet-billing](../features/wallet-billing.md) (Checkout), [earnings-payouts](../features/earnings-payouts.md) (Connect).

## Repo shape

pnpm workspace + **Turborepo**:

```
apps/web/        # TanStack Start app (all screens)
apps/gateway/    # CF Worker: proxy, wallet DO, agent endpoint
convex/          # Convex schema + functions (control plane)
packages/shared/ # spec parsing, x-zevium-* extraction, types shared web↔gateway
.agents/notes/    # agent memory: product, features, architecture, decisions, research
```

Turborepo drives build/typecheck/test/lint pipelines with caching; each app deploys independently (web → its host, gateway → Cloudflare, convex → `npx convex deploy`). Local setup: [dev-environment](dev-environment.md). Web app internals: [web-app](web-app.md).

## Architecture

```
                    ┌──────────────────────────────────────────┐
  Browser ◀────────▶│ CONVEX (control plane, single region)    │
   realtime sync    │  orgs mirror, projects, specs+versions,  │
   (dashboards,     │  catalogue, credit LEDGER (truth),       │
    editors)        │  usage events, analytics rollups,        │
                    │  vector search, crons                    │
                    └───────▲──────────────┬───────────────────┘
                            │ webhooks     │ registry outbox (receiver pending)
                            │ (Clerk,Stripe│  + wallet reconciliation)
                            │  events)     ▼
┌─────────┐         ┌──────────────────────────────────────────┐
│ Clerk   │◀───────▶│ CLOUDFLARE WORKER (data plane, edge)     │
│ auth,   │ key     │  /gateway/{org}/{project}/* + /mcp       │
│ orgs,   │ verify  │  1. verify API key (edge-cached)         │
│ API keys│ (cached)│  2. credit gate (Durable Object wallet)  │
└─────────┘         │  3. inject publisher upstream secrets    │
┌─────────┐         │  4. stream upstream response             │
│ Stripe  │─webhook▶│  5. emit usage event → Convex (async)    │
│Checkout/│ payments│  6. non-2xx → refund reservation         │
│ Connect │ payouts └──────────────────────────────────────────┘
└─────────┘
```

Call pipeline detail: [gateway](../features/gateway.md). Credit gate (wallet DO): [wallet-billing](../features/wallet-billing.md). Edge registry: [registry-v2](registry-v2.md).

### What each domain owns (Convex schema sketch)

| Tables                                                                 | Owner note                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------- |
| `organizations` (Clerk org mirror)                                     | [accounts-orgs](../features/accounts-orgs.md)             |
| `projects`, `specs`, `specVersions`, `specImportRateLeases`            | [publishing-specs](../features/publishing-specs.md)       |
| `wallets`, `walletEntries`                                             | [wallet-billing](../features/wallet-billing.md)           |
| `organizationPayments`, `checkoutIntents`, `payments`, `paymentEvents` | [wallet-billing](../features/wallet-billing.md)           |
| `usageEvents` + rollups                                                | [publisher-analytics](../features/publisher-analytics.md) |
| `publisherEarnings`, `publisherTransfers`, `connectedPayouts`          | [earnings-payouts](../features/earnings-payouts.md)       |
| `specEmbeddings` (`vectorIndex`)                                       | [catalogue-search](../features/catalogue-search.md)       |

`convex/schema.ts` is authoritative; this table is a map, not a schema.

## History

- **What died in the rebuild**: tRPC + oRPC, Drizzle + Turso, Upstash Redis, Better Auth (+ apikey plugin), Polar plugin wiring in auth, drizzle/ migrations, the seed script in its legacy form. Route tree, shadcn components, and Motion setup carried over conceptually; code was rewritten against Convex hooks. Never resurrect these patterns.
- **Pre-build spike notes (2026-07-11)**: internal spikes informed initial choices for Clerk/Start integration, API-key verification, authenticated Convex SSR, and wallet reconciliation. Scratchpad artifacts are not retained launch evidence, and no external review or approval is recorded. Current source, tests and generated builds are the only repository evidence for implementation behavior.
- Build waves 1–12 and their orchestration state: [history/build-plan.md](../history/build-plan.md).

## Later (explicitly deferred)

- Go port of the proxy Worker if TypeScript ever becomes the bottleneck (isolated by design; measure first)
- x402 rail: direction decided 2026-10-10 ([dual-rail decision](../decisions/2026-10-10-dual-rail-keys-and-x402.md)); design and status in [machine-payments](../features/machine-payments.md). Any implementation needs signed-payment verification, settlement/replay controls, tests, data inventory, and approved operating evidence; generic current `402` action envelopes are not an x402 stub
- Multi-region Convex / read replicas: not our problem; control plane latency is not user-facing hot path
