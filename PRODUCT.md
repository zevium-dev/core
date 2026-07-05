# Zevium Product Specification

> Last updated: 2026-07-05

## What is Zevium

Zevium is a **per-call API marketplace** — like RapidAPI, but consumers pay per API call via prepaid credits instead of monthly subscriptions.

## Two-sided platform

### Publishers (API sellers)

- Organizations that publish their APIs on Zevium
- Each API = a `project` with an OpenAPI spec
- Publishers set **per-endpoint pricing** (credits per call) in the OpenAPI spec
- Publishers earn revenue when consumers call their endpoints
- The upstream server URL lives in the OpenAPI spec's `servers` field

### Consumers (API buyers)

- Users who browse the API catalog and call endpoints through our proxy
- Pre-pay for credits (Polar meter credits, user-scoped)
- Each API call deducts credits based on the endpoint's price
- API keys are user-scoped (one key per user)

## Revenue model

```
Consumer pays:     10 credits / call
Zevium takes:       3 credits (30% platform cut)
Publisher earns:    7 credits (70% revenue share)
```

- Credits are prepaid by consumers via Polar fixed-product top-ups
- Platform cut + publisher share are calculated at call time
- Publisher earnings accumulate and are settled later (payout system TBD)

## How pricing works

Pricing is stored **in the OpenAPI spec** as a vendor extension on each path/operation:

```yaml
openapi: 3.1.0
info:
  title: OpenAI GPT API
servers:
  - url: https://api.openai.com
paths:
  /v1/chat/completions:
    post:
      x-zevium-cost: 10        # credits per call
      x-zevium-free-tier: 5    # optional: free calls per day
      summary: Chat completion
      ...
  /v1/embeddings:
    post:
      x-zevium-cost: 2
      summary: Create embeddings
      ...
```

No separate pricing table. The OpenAPI spec IS the source of truth for:

- Upstream server URL (`servers[0].url`)
- Available endpoints (`paths`)
- Per-endpoint pricing (`x-zevium-cost` on each operation)
- Rate limits / free tier (`x-zevium-free-tier`, optional)

## Data model mapping

| Concept                      | DB table                                    | Notes                                        |
| ---------------------------- | ------------------------------------------- | -------------------------------------------- |
| Publisher                    | `organization`                              | An org that publishes APIs                   |
| Published API                | `project`                                   | Has `status`, `visibility`, `organizationId` |
| API spec (draft + published) | `openapi_schema` + `openapi_schema_version` | 1:1 with project                             |
| Endpoint pricing             | OpenAPI `x-zevium-cost` extension           | Lives IN the spec, not a separate table      |
| Consumer credits             | Polar meter credits                         | User-scoped, prepaid via Polar checkout      |
| Consumer API keys            | `apikey` (better-auth plugin)               | User-scoped, one key per user                |
| Proxy call logging           | Polar `proxy_call` events                   | Ingested for billing + analytics             |

## Proxy call flow

```
Consumer → POST /api/proxy/{orgSlug}/{projectSlug}/v1/chat/completions
                        ↓
  1. Resolve {orgSlug}/{projectSlug} → project record
  2. Load project's published OpenAPI spec
  3. Match request path → find operation in spec
  4. Read x-zevium-cost from the matched operation
  5. Resolve upstream server from spec's servers[0].url
  6. Verify API key → get userId
  7. Gate: creditedUnits - userConsumed >= cost?
  8. Reserve credits (cost)
  9. Forward to upstream server + path
 10. On 2xx: ingest proxy_call event (deduct from meter)
     On non-2xx: refund credits
 11. Platform cut + publisher share calculated from the ingested event
```

## What does NOT exist yet (future work)

- **Publisher payouts**: No payout system yet. Credits accumulate on the publisher side.
- **Revenue split enforcement**: Currently the full cost is charged to the consumer. Platform cut / publisher share calculation is a future feature.
- **Per-endpoint cost lookup from OpenAPI spec**: The proxy currently uses env-based host config. Needs to read from the project's OpenAPI spec instead.
- **API catalog / browse**: UI for consumers to discover APIs.
- **Usage analytics**: Dashboard showing per-consumer usage and per-publisher earnings.
