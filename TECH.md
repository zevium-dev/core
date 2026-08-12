# Zevium Technical Decisions

> Last updated: 2026-07-12
> Companions: [PRODUCT.md](PRODUCT.md) (what), [FLOW.md](FLOW.md) (screens), [DESIGN.md](DESIGN.md) (feel). This doc: **how it's built and why**.
> Greenfield rules apply: zero users, data disposable, rebuild beats migrate.

## Principles

1. **TypeScript everywhere.** The only hard language constraint. The one component that may ever be ported for efficiency (the proxy Worker) is deliberately isolated so a future Go rewrite touches nothing else.
2. **Control plane / data plane split.** The metered proxy is the product's hot path: latency-sensitive, streaming, global. It lives at the edge. Everything else (CRUD, dashboards, catalog, ledger authority) is the control plane and optimizes for developer velocity, not latency.
3. **Buy the undifferentiated, own the differentiated.** Auth, payments, database sync = bought. Credit gating, metering, proxy, MCP surface = ours (that's the product).
4. **The seams are where bugs live.** Current stack's four known bugs are all integration glue (embedding upsert, Better Auth server props, unmetered MCP, unwired secrets). Fewer seams > familiar seams.

## Stack decision (2026-07-12)

| Layer                  | Choice                                                                       | Replaces                                     |
| ---------------------- | ---------------------------------------------------------------------------- | -------------------------------------------- |
| Frontend               | React 19 + TanStack Start/Router + shadcn/ui + Motion                        | (kept)                                       |
| Control plane          | **Convex** (DB, functions, realtime sync, vector search, cron, file storage) | tRPC + Drizzle + Turso + Upstash Redis cache |
| Data plane             | **Cloudflare Worker** (proxy + edge credit gate + MCP endpoint)              | (kept, rebuilt thin)                         |
| Auth + orgs + API keys | **Clerk** (sessions, org UI, machine API keys — GA 2026-04)                  | Better Auth + its apikey plugin              |
| Payments               | **Stripe Checkout + Connect** (top-ups, publisher onboarding/transfers)      | Polar checkout + manual payouts              |
| Credit ledger          | **Convex is the source of truth** (own tables), Worker holds the edge gate   | Vendor credit ledgers + Redis gate           |
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
- **Clerk Billing is NOT used**: verified subscriptions-only, no metered/usage billing, and no marketplace publisher settlement. Billing is ours + Stripe Checkout/Connect

### Why Stripe Checkout + Connect

- Checkout collects fixed, one-time credit-pack payments. A verified paid event grants the consumer organization exactly once; browser redirects never grant credits.
- Launch accounting is USD-only. Stripe Checkout adaptive pricing is disabled, and the platform Stripe account must settle into a USD balance so Connect transfers use the same currency as the credit ledger. A non-USD platform requires an explicit FX ledger before use.
- Connect owns publisher onboarding/KYC, connected-account capabilities, transfers, and bank-payout events. Zevium uses separate charges and transfers because a publisher is unknown when universal credits are purchased.
- Convex remains authoritative for credits, 95/5 usage settlement, earning holds, reversals, and transfer eligibility. Stripe Billing meters/customer credits never gate gateway calls.
- Stripe owns external payment/refund/dispute/transfer/payout facts. Zevium is the platform/merchant of record for this Connect funds flow and carries refund/dispute exposure.

## Repo shape

pnpm workspace + **Turborepo** (same pattern as sharath.ai):

```
apps/web/        # TanStack Start app (all screens)
apps/gateway/    # CF Worker: proxy, wallet DO, agent endpoint
convex/          # Convex schema + functions (control plane)
packages/shared/ # spec parsing, x-zevium-* extraction, types shared web↔gateway
```

Turborepo drives build/typecheck/test/lint pipelines with caching. Runtime pieces deploy through a compatibility-first release protocol: Convex expansion, gateway, then web; destructive Convex contraction is a later manual phase. Vendors remain independently deployed and cross-vendor atomicity does not exist. See [production deploy protocol](docs/production-deploy.md).

## Architecture

```
                    ┌──────────────────────────────────────────┐
  Browser ◀────────▶│ CONVEX (control plane, single region)    │
   realtime sync    │  orgs mirror, projects, specs+versions,  │
   (dashboards,     │  catalogue, credit LEDGER (truth),       │
    editors)        │  usage events, analytics rollups,        │
                    │  vector search, crons                    │
                    └───────▲──────────────┬───────────────────┘
                            │ webhooks     │ checkpoint sync
                            │ (Clerk,Stripe│  + reconciliation)
                            │  events)     ▼
┌─────────┐         ┌──────────────────────────────────────────┐
│ Clerk   │◀───────▶│ CLOUDFLARE WORKER (data plane, edge)     │
│ auth,   │ key     │  /proxy/{org}/{project}/*  + /mcp        │
│ orgs,   │ verify  │  1. verify API key (edge-cached)         │
│ API keys│ (cached)│  2. credit gate (Durable Object wallet)  │
└─────────┘         │  3. inject publisher upstream secrets    │
┌─────────┐         │  4. stream upstream response             │
│ Stripe  │─webhook▶│  5. emit usage event → Convex (async)    │
│Checkout/│ payments│  6. non-2xx → refund reservation         │
│ Connect │ payouts └──────────────────────────────────────────┘
└─────────┘
```

### Credit gate design (the hot path)

- **Durable Object per org wallet**: single-threaded actor = race-free reserve/settle/refund with zero lock code, lives at the edge near traffic
- Convex ledger is authoritative; DO holds a monotonic balance/sequence checkpoint plus active reservations and pending settlements. DO batches stable settlement refs to Convex; Convex returns per-ref `applied`/`already_applied`/`rejected` outcomes and a newer checkpoint. Only accepted refs are acknowledged, so lost acknowledgements and partial rejection converge without dropping usage.
- Zero balance **blocks** (PRODUCT.md rule: never surprise-overage). DO answers in-memory → sub-ms gate
- Key verification: Clerk verify API on first sight → cached in the DO/KV with TTL; Clerk webhooks (key revoked/updated) purge cache. Hot path never waits on Clerk

### What each domain owns (Convex schema sketch)

- `organizations` (mirror of Clerk orgs via webhook; Clerk is auth truth, Convex holds app data keyed by Clerk org id)
- `projects`, `specs` + `specVersions` (immutable published versions), `catalogueMeta` (derived quality signals)
- `wallets` (ledger: grants, reservations, settlements, refunds — append-only entries + materialized balance)
- `usageEvents` (per-call: project, endpoint, org, credits, latency, status) + rollup tables via cron (publisher analytics p95/p99 come from here)
- `organizationPayments`, `checkoutIntents`, `payments`, `paymentEvents` (Stripe customer/Connect projection, hosted Checkout correlation, durable webhook dedupe)
- `publisherEarnings`, `publisherTransfers`, `connectedPayouts` (risk-held 95/5 earnings, Connect transfer state, bank-payout projection)
- `embeddings` via `vectorIndex` (catalogue semantic search)

## Implementation notes (verified against code, waves 1-9 + hardening)

Decisions made during the build that extend or sharpen the stack decision above:

- **Usage ingest pipe**: the wallet DO's alarm (~5s, non-empty pending queue) batches settled usage and `POST`s it to `{CONVEX_SITE_URL}/ingest-usage`, an `httpAction` authenticated by a shared `x-internal-secret` header (`GATEWAY_INTERNAL_SECRET`) — no Convex deploy key on the hot path. `CONVEX_DEPLOY_KEY` remains as a fallback constructor path only, unused when the shared secret is configured. Release automation sends a fresh cryptographic challenge through the authenticated gateway request and persists it atomically with settlement metadata. Separate `RELEASE_PROBE_SECRET` protects bounded, one-time `/release-probe-accounting`; lookup binds request id + challenge + freshness + stamped gateway release, verifies consumer-wallet ownership and materialized ledger checkpoint, and returns minimal settlement/split totals without consumer identity, key, balance, sequence, or lifecycle state
- **Publisher webhook egress**: delivery-time validation is authoritative. Node HTTPS resolves every hop, rejects any non-public address in the complete DNS answer, and pins the TLS socket to one validated address while retaining the URL hostname for SNI, certificate verification, and `Host`. Redirects resolve and pin again; cross-origin hops lose sensitive headers. Connect/header/body/overall deadlines and bounded response draining prevent slow or oversized receivers from consuming unbounded action resources.
- **Cross-org metering**: the consumer's own org wallet always pays, never the publisher's. Private projects called with a key from a foreign org 404 (`project_not_found`) rather than 401/403, so private listings never leak existence to an unauthorized caller
- **Gateway CORS**: `/gateway`, `/mock`, `/discovery`, `/mcp` all allow wildcard origin. Safe because auth is bearer-key only, never cookie-based — a wildcard origin doesn't widen the attack surface for a bearer-token API
- **Per-key caps + rotation**: enforced in the wallet DO, not per-request against Convex. A `keySettings` sync (`/wallet-grants` pull) refreshes disabled/monthly-cap/rotation-grace state at ≤60s staleness (`SYNC_GRANTS_WINDOW_MS`, rate-limited to 1/60s per org). Only a monthly cap exists today (no daily/weekly reset windows); rotation grants the old key a 24h grace period before hard cutoff
- **Publisher upstream credentials**: project Settings writes AES-GCM encrypted header secrets into server-only `upstreamCredentials` rows. Convex requires `UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS` as JSON `{ current, keys }`; retain prior key ids during re-encryption rotation. `GATEWAY_INTERNAL_SECRET` authenticates transport only and is never encryption material. The transitional `migrateLegacyPlaintext` internal mutation encrypts legacy rows before the schema tightens to required ciphertext fields. Gateway resolves published spec + secrets through shared-secret-authenticated `GET /gateway-spec`, caches the result for 30s, strips consumer `Authorization`/`x-api-key`, then injects publisher headers before upstream fetch. Public catalogue, discovery, mock, and OpenAPI payloads never contain secret values.
  - Rollout command: `pnpm exec convex run admin:migrateSecurityRollout --identity '{"subject":"<admin-user-id>","org_id":"<admin-org-id>","org_role":"org:admin"}'`. Re-run until `remainingPlaintext`, `remainingUnencrypted`, and `remainingMissingHandles` are all exactly zero; only then make encryption/public-handle validators required and remove transitional fields.
- **Stripe payments**: `billing.createCheckout` creates server-priced hosted Checkout sessions. Platform and Connect webhook routes verify raw-body signatures, durably dedupe events, and fulfill grants/refunds/disputes or account/transfer/payout projections idempotently. Stripe API version is pinned in code.
- **Connect settlement**: publisher usage creates explicit risk-held 95/5 earning rows. Enabled connected accounts receive idempotent transfer batches after the hold; transfer and bank payout remain separate lifecycle states.
- **Semantic search**: embeddings come from `gemini-embedding-001` pinned to `outputDimensionality: 768` (matches the `specEmbeddings` `by_embedding` vectorIndex). Not `text-embedding-004` — that model was removed from the Gemini v1beta API (404) and `gemini-embedding-001` is its 768-dim replacement
- **Publisher webhooks**: HMAC-SHA256 signed (`x-zevium-signature` header, hex digest over the raw body), delivered with up to 3 attempts and backoff of 60s then 300s between retries before marking a delivery failed
- **Preview verification**: every trusted PR deploys isolated Convex, gateway, and web previews stamped with the exact checked-out SHA, then runs a bounded-propagation cross-service contract for web SSR/catalogue, gateway readiness/contract identity, CORS, and stable error behavior. A secret-free `gh` preflight resolves manual PR inputs and rejects forks, closed PRs, non-maintainer authors, and non-maintainer actors before any checkout or environment-secret job. After Convex provisioning, gateway deploy and web build run in parallel; web and gateway converge through explicit outputs/artifacts. Authenticated publisher/consumer E2E remains opt-in because it is long and stateful: add the `full-e2e` label or run **Pull Request Preview** manually. Publisher and consumer remain sequential because consumer verification reads publisher-created project artifact. Closed PRs invoke separate preview cleanup workflow.
- **Production releases**: exact git SHA is immutable release identity exposed by web metadata and gateway `/health`. Shared concurrency intentionally coalesces superseded normal SHAs into current `develop`; generic preflight semantically inventories exact git objects for every public/internal Convex function contract, table/index/search/vector definition, typed literal, and HTTP route, then enumerates every protected contract/lifecycle requirement since active production. Commit subjects carry no authority. Contract lane orders multiple protected contractions, verifies prior provenance, and deploys each exact target from its own frozen checkout. Contract and DO lanes emit GitHub-signed custom attestations bound to exact workflow/run/head, reviewed deployment environment, active/protected bases, phase, and canonical digest; raw commit statuses are not trusted. Every approved job runs GitHub stale/CI guard before checkout/setup, and every provider mutation rechecks identity plus exact active provider config in same shell block. Same SHA passes staging paid accounting and exact request-id/challenge E2E before production approval. Production persists attempt-bound recovery intent before mutation, uploads immutable Worker candidates, deploys compatible Convex expansion, verifies 0%-traffic candidates through version overrides, then promotes gateway and web. Signals record ambiguity only; separately protected recovery accepts failed deploy/lifecycle/recovery runs recursively, preserves stable root identity, and admits recovery-generated Worker versions only through a SHA-256 manifest lineage plus exact provider token proof. Browser E2E uses integrity-locked workspace `agent-browser` binary. All paid probes resolve one exact active Clerk key at runtime from Clerk secret key plus org slug/member/key constraints, mask immediately, and never persist it. Generic release rejects all DO lifecycle diffs before staging; dedicated lifecycle uses atomic `wrangler deploy`, never rolls back shared DO state, and fails closed when provider metadata cannot prove declarative tombstones/transfers. See [production deploy protocol](docs/production-deploy.md).
- **Deprecation signaling**: RFC 8594 headers on gateway responses for deprecated spec versions — `Deprecation: @<epoch-seconds>`, `Sunset: <HTTP-date>`, `Link: <catalogue-url>; rel="deprecation"`
- **Admin gate**: platform-admin access is an env allowlist, `ADMIN_USER_IDS` (Clerk subject ids), checked server-side in Convex — no separate roles table
- **Payouts**: Stripe Connect onboarding replaces free-form payout destinations. Earnings move through pending-risk, available, allocated, transferred, and reversed/failed states; `/admin/payouts` operates failed transfer retries while Stripe payout events project bank-delivery state.
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
