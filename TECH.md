# Zevium Technical Decisions

> Last updated: 2026-08-12
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
apps/deploy-broker/ # CF Worker: GitHub OIDC deployment capability broker
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

- **Usage ingest pipe**: the wallet DO's alarm (~5s, non-empty pending queue) batches settled usage and `POST`s it to `{CONVEX_SITE_URL}/ingest-usage`, an `httpAction` authenticated by a shared `x-internal-secret` header (`GATEWAY_INTERNAL_SECRET`) — no Convex deploy key on the hot path. `CONVEX_DEPLOY_KEY` remains as a fallback constructor path only, unused when the shared secret is configured
- **Publisher webhook egress**: delivery-time validation is authoritative. Node HTTPS resolves every hop, rejects any non-public address in the complete DNS answer, and pins the TLS socket to one validated address while retaining the URL hostname for SNI, certificate verification, and `Host`. Same-origin redirects resolve and pin again; cross-origin redirects are rejected before forwarding signed payload. Connect/header/body/overall deadlines and bounded response draining prevent slow or oversized receivers from consuming unbounded action resources.
- **Org-role authorization**: Clerk's active-org JWT claims are authoritative. Members may read org/project state and collaborate on spec drafts. Exact `org:admin` is required server-side before project lifecycle/visibility/deletion, immutable publication/deprecation, webhook configuration/signing-secret reads, wallet top-ups, and Stripe Connect onboarding/transfers. Missing or unknown roles fail closed; cross-org resource mutations return the same not-found class as missing resources. Matching client gates hide unusable controls but never replace server authorization.
- **Cross-org metering**: the consumer's own org wallet always pays, never the publisher's. Private projects called with a key from a foreign org 404 (`project_not_found`) rather than 401/403, so private listings never leak existence to an unauthorized caller
- **Gateway CORS**: `/gateway`, `/mock`, `/discovery`, `/mcp` all allow wildcard origin. Safe because auth is bearer-key only, never cookie-based — a wildcard origin doesn't widen the attack surface for a bearer-token API
- **Per-key caps + rotation**: enforced in the wallet DO, not per-request against Convex. A `keySettings` sync (`/wallet-grants` pull) refreshes disabled/monthly-cap/rotation-grace state at ≤60s staleness (`SYNC_GRANTS_WINDOW_MS`, rate-limited to 1/60s per org). Unknown provider keys are quarantined disabled and gateway execution fails closed without a tracked row. Rotation inherits one stable family id and family-wide monthly cap; settled and in-flight usage survive physical key replacement. Server derives a fixed 24h grace, then closes local authority and automatically revokes old Clerk key with bounded retry/recovery.
- **Publisher secrets**: project Settings writes upstream header credentials and webhook signing secrets as dual AES-256-GCM envelopes in server-only rows. `UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS` is JSON `{ current, keys }`: retained pre-v2 values may be arbitrary nonempty strings for legacy SHA-256-derived decryption, while `current` must be canonical padded base64 decoding to exactly 32 bytes before any dual-envelope write or migration. `admin:migrateSecurityRollout` returns this preflight and refuses writes until current key is v2-ready. `sealed*` v2 ciphertext uses purpose + stable resource + key-version AAD, blocking row/purpose transplants. `ciphertext` is a temporary legacy-readable rollback envelope. Plaintext-only rollout rows remain readable until migration; partial envelopes fail closed. Every normal write and migration decrypts both newly written envelopes before plaintext is scrubbed, and updates explicitly remove legacy plaintext. Webhook CRUD returns metadata only, explicit signing-secret reveal is org-admin-only, and delivery decrypts only inside server action memory. `GATEWAY_INTERNAL_SECRET` authenticates transport only and is never encryption material. Gateway resolves published spec + upstream secrets through shared-secret-authenticated `GET /gateway-spec`, caches the result for 30s, strips consumer `Authorization`/`x-api-key`, then injects publisher headers before upstream fetch. Public catalogue, discovery, mock, OpenAPI, webhook metadata, and delivery-log payloads never contain secret values.
  - **Staged migration / rollback runbook**: (1) back up Convex and current keyring; add a generated 32-byte base64 key without removing any old version. (2) Deploy optional `sealed*` schema plus dual-read/dual-write code. Previous release can still roll back because legacy envelope stays current and readable. (3) Run read-only `pnpm exec convex run admin:securityRolloutPreflight '{}' --identity '{"subject":"<admin-user-id>"}'`; require `boundEnvelopeReady: true` and inspect `legacyOnlyVersions` before any migration write. (4) Run `pnpm exec convex run admin:migrateSecurityRollout '{"credentialsCursor":null,"webhookCursor":null,"numItems":50}' --identity '{"subject":"<admin-user-id>"}'`; feed each returned `continueCursor` into next call until both `isDone` values are true. Every page reports exact `current`, `old`, `broken`, `corrupt`, `plaintext`, `recovered`, `rewrapped`, and `scrubbed` counts. (5) Run a second complete audit pass from null. Stop on any `broken`, `old`, or `plaintext` row; recover from backup or retained plaintext/legacy envelope. (6) To rotate, set new version as `current`, keep old keys, repeat two passes, and remove an old key only after full audit reports zero old/broken/plaintext rows. (7) Tighten schema to require both envelopes and remove `secret` only after verified zero; retain legacy envelope through rollback window. Reverse recovery is deploy previous reader against retained legacy envelope. Never retire legacy envelope and old application release in same deployment.
- **Stripe payments**: `billing.createCheckout` is admin/owner-only and creates server-priced hosted Checkout sessions. Its cancel URL carries only the local checkout-intent id; `getBillingState` resolves it under the active org before showing canceled state. Platform and Connect webhook routes verify raw-body signatures, persist each receipt and its scheduled processor in one transaction, lease processing attempts, retry with bounded backoff, and recover abandoned leases every minute. Every positive wallet source becomes a universal funding lot. Non-refundable promotion/admin inventory is consumed first, then refundable payment/restoration inventory FIFO; negative adjustments use the same fully preflighted allocator. Compatible lots compact into derived inventory with immutable root-to-derived lineage, and each settlement batch has a total-write budget rather than only an input-count cap. Refund/dispute exposure removes only the affected payment's unspent inventory. Pending and `requires_action` refunds reserve exposure; failed/canceled transitions restore publisher exposure first and then mint an exact payment-bound restoration lot for wallet inventory. Publisher clawback/restoration runs through a durable eight-row source-specific reconciliation journal, so a million historical allocations never enter one mutation. Only Stripe `funds_withdrawn` / `funds_reinstated` events move dispute money. Stripe API version is pinned in code.
- **Connect onboarding**: connected accounts and hosted onboarding links both use Accounts v2. Server-issued durable operation ids scope provider idempotency separately for account creation and each single-use link. Account creation first reconciles bounded v2 metadata (including 5f8-era `clerkOrgId` orphans), fails closed beyond the v2 replay window or a saturated scan, and persists the verified account id + livemode before link creation. Refresh is a separate active-org admin action that always rotates to a fresh link operation; URLs are HTTPS-only, link URLs are never stored, and account/link responses must match the local org, recipient configuration, and configured Stripe mode.
- **Finance schema rollout**: finance-v2 legacy fields stay optional in this expansion deploy, but optional money reads and writes fail closed unless the versioned global migration job and each touched wallet/payment/publisher scope are verified. `financeMigration.start` is admin-only and resumable. It fences each scope as `building`, replays at most one money-bearing history row per transaction, records sequence watermarks, and independently recomputes ledger, lot, allocation, reversal, exposure, publisher, transfer, 95/5, and cross-table conservation before atomically marking that scope verified. Concurrent runtime writes are blocked for the full unfinished/failed job; no half-built state is visible. Failed chunks persist a failed audit and keep the fence closed. Legacy transfers remain `provider_repair_required`: migration persists whether the original create used publisher-only, pre-version correlated, or current metadata; repair replays that exact parameter set under the original idempotency key when needed, updates metadata under a distinct repair key, retrieves Stripe's snapshot, resets final conservation, and records `provider_verified` only after exact amount/currency/destination/platform/nonce/HMAC/reversal agreement. No validator is tightened in this phase. Required-validator contraction is a separate later deploy, gated on the verified `finance-v2-universal-funding-v2` audit, zero unfinished jobs, provider proof for every legacy transfer, and zero missing optional finance fields; it then deletes legacy consumer-debt and `paymentFundingLots` / `paymentFundingAllocations` compatibility fields/tables.
- **Connect settlement**: publisher usage creates risk-held earning rows denominated in accounting atoms (`10,000 atoms = 1 credit`), making every per-call 95/5 split exact even for a one-credit call. Mature earnings post in indexed 25-row chunks into an append-only publisher settlement ledger plus materialized available / allocated / paid buckets and all-row pending-risk / reversed / failed aggregates; recent-row pagination is display-only. Refund/dispute clawbacks can make publisher available balance negative after already-paid earnings, so future earnings repay that publisher liability before payout; consumer wallets never carry debt. Transfers require the product's $10 minimum, allocate only whole Stripe cents, and leave all sub-cent atoms in canonical available balance. Transfer creation, provider repair, webhook projection, and crash recovery validate amount, currency, destination connected account, platform account, 256-bit server nonce, and HMAC metadata against a provider snapshot; cumulative reversals return the exact allocation without duplicating or dropping remainder. `STRIPE_PLATFORM_ACCOUNT_ID` and a 32-byte `STRIPE_TRANSFER_CORRELATION_SECRET` are required before transfer creation or legacy transfer repair.
- **Staging payment-drill acceptance and recovery**: run manual `Payment Drills` only from allowed `develop` ref against a dedicated staging fixture whose consumer wallet starts at zero, publisher has at least $10 mature available earnings, payment profile is transfer-enabled, and no transfer is unfinished. A passing schema-v3 acceptance report binds exact `GITHUB_SHA`, run reference, staging mode, fresh timestamps, and three service-specific immutable fingerprints returned by web `/.well-known/zevium-deployment.json`, gateway `/health`, and `deploymentProof:get`; stale or mismatched persistent staging cannot pass. Browser commands run with only browser session env, provider commands receive only restricted test keys/provider identifiers, and ledger commands receive only Convex/deployment identifiers. The authenticated app must invoke deployed `payouts.startOnboarding` through v2 `core.accountLinks.create`, observe Stripe-hosted Connect, then invoke `payouts.initiatePublisherTransfer`. Evidence correlates exact Clerk org, Convex organization/payment profile/transfer, connected and platform accounts, nonce/HMAC metadata, `transfer.created` receipt, and publisher settlement journal. Direct Stripe Accounts/transfer/payout primitives remain a separate supplemental-only report.
- **Refund acceptance**: paid-call evidence follows exact `x-zevium-request-id` values through `settle:{requestId}` wallet entries, usage rows, project publisher identity, and contiguous wallet sequences. Partial and remaining refunds must match exact provider refund ids, exposure rows, payment/event receipt, and wallet reversal journal. Acceptance waits for publisher reconciliation status `complete`; `pending`, `running`, or `failed` is terminal proof failure. Every active exposure must be fully applied and all source-specific clawbacks, affected earnings, publisher journal atoms, materialized balance buckets, aggregate pending/reversed/failed atoms, and wallet credits must conserve. Its intentional failure remains a disposable attempt-tagged `charge.refunded` canary; proof requires exclusive canonical/canary v1 topology and zero competing v2 snapshot destinations before replay.
- **Payment-drill compensation**: `PAYMENT_DRILL_PHASE=cleanup` always removes only attempt canaries, verifies canonical endpoint identity, completes exact remaining payment refund and publisher reconciliation, fully reverses app transfer, waits for `transfer.reversed`, and restores available/allocated/paid publisher buckets while preserving exact post-refund pending/reversed/failed aggregates. Provider-primitives cleanup separately closes its temporary v2 account, reverses test payout/transfers, and refunds source charges. Acceptance artifact generation is fail-closed: only explicitly allowlisted schema fields become minimal DTOs, identifiers use stable keyed hashes, and exact/encoded credentials, cookies, client secrets, and raw Clerk/Convex/Stripe ids are rejected. After runner loss, recover exact Checkout from `checkoutIntentId`, Clerk org, run reference, and workflow time; retry only exact event against canonical endpoint, then rerun cleanup with same reference. Never close payment proof work without one green real manual run and sanitized acceptance DTO.
- **Semantic search**: embeddings come from `gemini-embedding-001` pinned to `outputDimensionality: 768` (matches the `specEmbeddings` `by_embedding` vectorIndex). Not `text-embedding-004` — that model was removed from the Gemini v1beta API (404) and `gemini-embedding-001` is its 768-dim replacement
- **Publisher webhooks**: HMAC-SHA256 signed (`x-zevium-signature` header, hex digest over the raw body), delivered with up to 3 attempts and backoff of 60s then 300s between retries before marking a delivery failed
- **Preview verification**: every trusted PR deploys isolated Convex, gateway, and web previews and runs required curl-only checks for web `/`, web `/catalogue`, gateway `/health`, gateway CORS preflight, and a stable gateway 404. After Convex provisioning, gateway deploy and web build run in parallel; web deployment and gateway deployment converge at the smoke job through explicit job outputs/artifacts. The browser runtime and authenticated publisher/consumer journey are intentionally opt-in because they are long and stateful: add the `full-e2e` label to a PR, or run **Pull Request Preview** manually on the PR head with its PR number. Publisher and consumer remain sequential because consumer verification reads the publisher-created project artifact. Closed PRs invoke the separate preview cleanup workflow.
- **Cloudflare deployment broker**: GitHub stores no Cloudflare credential. Reusable deployment jobs mint short-lived GitHub Actions OIDC JWTs with manifest-digest audiences and register them with `zevium-deploy-broker`; a repo-owned exact API publisher uses the resulting one-JTI Durable Object session. Pinned Wrangler is build-only (`versions upload --dry-run`) for gateway module output and never mutates provider state. Broker verifies GitHub's RS256/JWKS signature and immutable repository, owner, actor, workflow, environment, run, ref, PR/source-CI provenance; it replaces OIDC authorization with its Worker secret only after exact method/path/query/multipart/JSON policy checks. Signed manifests fix stable staging/production or isolated preview script names, complete explicit bindings, append-only `WalletDO` v1 → `RegistryDO` v2 → `X402PaymentDO` v3 migrations, secret value digests, bare git SHA, native Cloudflare version metadata, asset hashes/MIME, and 100% traffic. Candidate UUID is durably recorded before bounded readback so a transient post-write failure resumes without repeating provider mutation. Publisher atomically persists `0600` provider-ID receipts before mutation. Staging recovery treats receipt UUIDs only as selectors and independently proves Cloudflare's immediately prior immutable, lifecycle-compatible version before a 100% redeploy; Durable Object migrations never roll back. Broker cannot target itself. Response/request bodies stream except bounded control metadata. Bootstrap, rotation, recovery, receipt schema, and endpoint inventory live in `docs/cloudflare-deploy-broker.md`.
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
