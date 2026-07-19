# Backlog

Current truth as of 2026-07-19. `PRODUCT.md` owns priority; this file tracks concrete unfinished work only.

## Now — launch blockers

1. **Publish initial production catalogue.**
   - Live catalogue currently has zero public APIs.
   - Publish 1–3 owned, reliable APIs with real upstreams, credentials, descriptions, tags, pricing, and agent-readable docs.
   - Remove fallback-only mismatch where landing advertises Weather/FX/Embeddings but catalogue is empty.
2. **Prove real payment and settlement journey.**
   - Configure staging environment variables/secrets used by `.github/workflows/payment-drill.yml`.
   - Manually run authenticated publish/call plus real Stripe Checkout, refund, and Connect settlement drill.
   - Scheduled payment drills currently run deterministic tests only.
3. **Finish external production gates.**
   - Obtain written Stripe approval for pooled prepaid credits across independent publishers.
   - Accept platform/MoR legal and tax obligations.
   - Fix supported countries/currency and write refund, dispute, debt, risk-hold, and payout policies.
   - Complete operational runbook required by `.project/stripe-discovery.md`.

## Next — P0 product gaps

1. **Public quality signals and automated listing gates.**
   - Probe upstream reachability and uptime.
   - Expose latency, success rate, and freshness on catalogue listings.
   - Add per-API status surfaces and block publication when required gates fail.
2. **Production acceptance journey.**
   - Using separate publisher and consumer orgs: publish → buy credits → issue key → paid gateway call → usage ingest → 95/5 earnings → Connect transfer.
   - Also verify keyless mock and MCP calls against same listing.

## Later

- Full facilitator-verified x402 settlement.
- Per-listing MCP tool surfaces beyond current global search/load/call tools.
- Generated SDKs.
- Reviews/ratings.
- Security/compliance certification work after launch posture is defined.

## Completed findings removed from active backlog

- New-user org handling: Clerk auto-org creation plus `/app/org/create` guard.
- Landing count, credit pluralization, try-it key link, app Docs navigation, notification destinations.
- Browser-fetch paid-call and anonymous mock E2E coverage.
- Payout notification kinds.
- Production CI deployment from green `develop`.
