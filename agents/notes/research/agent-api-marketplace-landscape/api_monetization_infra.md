# API Monetization, Usage-Based Billing & API Gateway Platforms (publisher-side substitutes for Zevium), as of Oct 2026

Scope: the tools a publisher would use to "self-host monetization" instead of listing on Zevium. Grouped by type: (A) gateways with monetization (Zuplo, Kong, Tyk, Apigee, Moesif/WSO2, Cloudflare), (B) billing/metering engines (Stripe Billing + Metronome, Orb, Lago, OpenMeter, Amberflo, Stigg), (C) agent/outcome billing (Stripe token billing, Paid.ai), (D) agent payment rails (x402 via Cloudflare). Many claims come from vendor comparison blogs (Stigg, Lago, Orb, Zuplo write about rivals); flagged where relevant.

## Q1. What each player gives publishers (metering, rating, invoicing, prepaid credits, entitlements, dev portal, key mgmt)

### Takeaway

Gateway vendors (Zuplo, Kong, Tyk, Apigee) now bundle keys, quota gating, a dev portal and Stripe-backed plans. Billing engines (Metronome/Stripe, Orb, Lago, OpenMeter) handle metering, rating, credits and invoicing but not keys or the edge. Zuplo is the closest single-product substitute for Zevium's publisher side: it does OpenAPI-driven gateway, auto-issued keys, prepaid credit packs, edge 429 gating, MCP tools and a portal. None of them bring buyers.

### Cited Findings

**Zuplo (gateway + monetization)**

- API Monetization entered public beta 2026-03-26. The inbound monetization policy meters requests in real time per subscription. Hard limits block requests; soft limits allow overage billed via Stripe — [Zuplo changelog](https://zuplo.com/changelog/2026/03/26/api-monetization-beta)
- Plans can be flat-rate, tiered or usage-based, with weekly to annual cadence and graduated tiers (e.g. $0.01/call for the first 1K, $0.005 for the next 10K). Plan lifecycle runs Draft → Published → End of Sale → Retired; plans can be versioned or private — [Zuplo changelog](https://zuplo.com/changelog/2026/03/26/api-monetization-beta)
- Publishing a plan auto-creates Stripe Products/Prices. Stripe runs checkout/payment. "Zuplo is the source of truth for access control and metering", Stripe holds payment state — [Zuplo changelog](https://zuplo.com/changelog/2026/03/26/api-monetization-beta)
- Dev portal gains a pricing page, self-serve subscription management (upgrade/downgrade/cancel) and a usage dashboard. API keys are auto-issued per subscription, tied to plan entitlements, and customers can regenerate them — [Zuplo changelog](https://zuplo.com/changelog/2026/03/26/api-monetization-beta)
- Six pricing models: token metering, request metering, flat rate, **prepaid credit packs**, tiered usage, freemium. Example packs: $7 for 1,000 credits (never expire, 1 call = 1 credit), $42 for 10K credits with 25% bonus + **auto-refill**, $128 for 100K with 50% bonus. Edge quota returns 429 with no backend code. Custom meters are written as TypeScript policies (tokens, payload size, computed values). Also per-endpoint revenue tracking, MRR and key growth, and git-push deploy — [Zuplo monetize page](https://zuplo.com/solutions/monetize-and-control)
- "Core billing flows are production-ready"; going live requires contacting sales@zuplo.com — [Zuplo changelog](https://zuplo.com/changelog/2026/03/26/api-monetization-beta)

**Kong (Konnect + OpenMeter)**

- Konnect Metering & Billing (built on OpenMeter) monitors, prices and invoices API, AI and event-stream usage. It meters LLM traffic per token, per model, per customer and per request, with invoices at cycle end or on demand — [Kong feature page](https://konghq.com/products/kong-konnect/features/usage-based-metering-and-billing)
- Launch press release (said "available as part of Konnect Q4 2025") covers APIs, AI agents and data streams — [Kong PR](https://konghq.com/company/press-room/press-release/kong-introduces-konnect-metering-and-billing-to-monetize-apis-ai-agents-and-data-streams); [Kong blog](https://konghq.com/blog/product-releases/konnect-metering-and-billing)
- OpenMeter covers usage-based pricing, entitlements and invoicing. It stays open source under Kong — [Kong blog](https://konghq.com/blog/news/kong-acquires-openmeter); [SiliconANGLE](https://siliconangle.com/2025/09/03/kong-acquires-openmeter-power-api-ai-monetization/)

**Tyk**

- Tiered subscription plans for internal, external and partner consumers, with per-tier access levels, rate limits, quotas and pricing. The dev portal acts as a "storefront" for buying API access — [Tyk monetization](https://tyk.io/api-monetization/)
- Tyk lists an "MCP Gateway" product; no detail found on whether it is billable/monetizable — [secondary: frontdeskreview](https://frontdeskreview.com/software/api-management/tyk/)

**Apigee (Google Cloud)**

- Rate plans attach to API products: pay-per-call, volume-banded and revenue-share plan types — [Apigee docs: rate plans](https://docs.apigee.com/api-platform/monetization/create-rate-plans); [2026 tutorial](https://oneuptime.com/blog/post/2026-02-17-how-to-enable-and-configure-apigee-monetization-for-paid-api-products/view)
- Prepaid: the base fee is deducted from the developer's prepaid balance at plan purchase, and the purchase fails on insufficient funds. Postpaid developers get invoices — [Apigee docs: fees](https://docs.apigee.com/api-platform/monetization/add-fees-rate-plan)
- One Capterra user review calls Edge monetization "very unstable" (anecdote) — [Capterra](https://www.capterra.com/p/149092/Apigee-Edge/)

**Moesif (now WSO2)**

- Billing meters on API usage. Syncs to Stripe, Zuora, Chargebee and Recurly. Prepaid, postpaid and PAYG plans, with quota enforcement via governance rules. Analytics-first; it is not a gateway or key issuer — [Moesif metered billing](https://www.moesif.com/solutions/metered-api-billing); [Moesif extensions](https://www.moesif.com/extensions/api-monetization)

**Stripe Billing + Metronome**

- Stripe's pricing page says usage-based billing is included and "handled by Metronome, a Stripe product" — [Stripe Billing pricing](https://stripe.com/cz/billing/pricing). Third-party sites say Metronome usage billing is priced separately; this conflict is unresolved — [erpresearch](https://erpresearch.com/erp-add-ons/billing-subscriptions/stripe-billing/pricing)
- Metronome's roadmap after the acquisition: seat-based credits, real-time spend alerts, hierarchical accounts — [PYMNTS](https://www.pymnts.com/acquisitions/2025/stripe-acquires-metronome-to-enhance-metered-pricing-capabilities-for-ai-companies)

**Orb**

- Strong on prepaid credits/wallets per comparisons (vendor-written). Cloud-only, closed source — [Lago vs Orb (vendor)](https://getlago.com/blog/lago-vs-orb)

**Lago**

- Open-source, self-hostable billing (metering, plans, invoicing, credits). Users reportedly include Mistral AI, Algolia and GitHub (vendor-adjacent claim) — [Solvimon](https://www.solvimon.com/blog/best-billing-systems-in-2026); [Lago blog](https://getlago.com/blog/orb-adyen-acquisition-lago-alternative)

**Amberflo**

- AI monetization infrastructure: usage tracking, cost allocation, automated billing, prepaid credits, tiered and outcome-based pricing — [Amberflo platform](https://amberflo.io/platform)

**Stigg**

- Positions itself as a "usage runtime" / entitlements layer that checks entitlements and spend limits **before** a request reaches billing. It is not a billing ledger — [Stigg blog](https://www.stigg.io/blog-posts/usage-based-billing-software); [Stigg: entitlements gap](https://www.stigg.io/blog-posts/metronome-alternatives)

### Inferences

- The stack has two layers. Gateways do keys, gating and portal; billing engines do rating, credits and invoices. A self-host publisher needs one of each (e.g. Kong + Konnect M&B, or Zuplo + Stripe), or Zuplo alone, which is the most complete substitute.
- Zuplo's credit-pack shape (bonus tiers, auto-refill, non-expiring credits) is a de facto benchmark for publisher-facing prepaid UX.

### Gaps

- Tyk: no published monetization pricing, no confirmed billing integration details, no detail on MCP Gateway billing.
- Orb/Lago feature specifics are mainly from rivals' comparison posts; primary docs not fetched.

## Q2. Pricing: platform fee, % of revenue vs flat

### Takeaway

Infra vendors charge flat/tiered SaaS fees, per-event fees, or a small % of billed volume (Stripe 0.7%, Amberflo ~0.5% beyond free tier). None take a 5% marketplace cut, but none bring demand either. At low volume, Zuplo's free tier (100K monetization events/mo) makes self-hosting nearly free. On fees alone, Zevium's 5% loses to self-hosting. Comparing it with other marketplaces' take rates is left to the marketplace notes.

### Cited Findings

- **Zuplo**: monetization is included on Free and Builder plans with 100K monetization events/mo at no extra cost. On Enterprise it is an add-on with custom limits — [Zuplo changelog](https://zuplo.com/changelog/2026/03/26/api-monetization-beta); "Free up to 100K monetization events / month" — [Zuplo monetize page](https://zuplo.com/solutions/monetize-and-control). MCP Gateway is included on every plan, with tool-invocation limits per tier (1K / 10K / unlimited) — [Zuplo pricing](https://zuplo.com/pricing). Builder plan reportedly $25/mo plus usage (third-party, possibly stale) — [Capterra](https://www.capterra.com/p/10025504/Zuplo/). Zuplo free tier reportedly includes 1M requests/mo (Zuplo's own learning-center page) — [Zuplo pricing comparison](https://zuplo.com/learning-center/api-gateway-pricing-comparison-2026.md)
- **Stripe Billing**: pay-as-you-go at 0.7% of Billing volume, no recurring fee. Annual plans are also available — [Stripe Billing pricing](https://stripe.com/en-cn/billing/pricing). Aggregator lists $620/mo up to $100K volume and $1,500/mo up to $250K with 0.67% overage (unverified against Stripe) — [erpresearch](https://erpresearch.com/erp-add-ons/billing-subscriptions/stripe-billing/pricing). Stripe processing fees are on top (standard; not re-verified here).
- **Kong Konnect**: entry managed tier around $105 per service/month plus request overage (source is competitor Zuplo) — [Zuplo pricing comparison](https://zuplo.com/learning-center/api-gateway-pricing-comparison-2026.md). Metering & Billing add-on price not found.
- **Apigee**: platform fee separate from monetization. API calls cost $100/M up to 50M, $80/M from 50M to 500M, $64/M above 500M. PAYG environments start at $365/mo per region — [apigatewaycost.com](https://apigatewaycost.com/apigee); official page — [Google Apigee pricing](https://cloud.google.com/apigee/pricing)
- **Tyk**: Open Source is free and self-hosted. Core is usage-based, Professional is a flat monthly fee, Enterprise is custom. Paid tiers are sales-gated. Cloud has a 48-hour trial (verified 2026-06-15, third-party) — [agentdeals Tyk](https://agentdeals.dev/vendor/tyk)
- **Orb**: Core/Advanced/Enterprise, all custom, priced "primarily on billings and events" plus a platform fee on higher tiers — [Stigg: Orb alternative](https://www.stigg.io/blog-posts/orb-alternative)
- **Metronome**: quote only — [Stigg: Metronome pricing](https://www.stigg.io/blog-posts/metronome-pricing)
- **Lago**: free to self-host; cloud plans custom/contact sales — [Stigg: billing software](https://www.stigg.io/blog-posts/billing-system-software); [Solvimon](https://www.solvimon.com/blog/best-billing-systems-in-2026)
- **Amberflo**: $99/mo startup tier and $599/mo Growth (per competitor Orb) — [Orb on Amberflo](https://www.withorb.com/blog/amberflo-reviews). Alternatively 25 free invoices/mo, then 0.5% of invoiced amounts (per SaaSworthy). Sources conflict — [SaaSworthy](https://www.saasworthy.com/product/amberflo-io)
- **Stigg**: free self-serve plan; Growth from $5,376/yr (vendor blog) — [Stigg: Metronome pricing](https://www.stigg.io/blog-posts/metronome-pricing)
- **Stripe AI Gateway / token billing**: Stripe reportedly applies no markup of its own on usage through its gateway (yet) — [TechCrunch](https://techcrunch.com/2026/03/02/stripe-wants-to-turn-your-ai-costs-into-a-profit-center)
- **Cloudflare Monetization Gateway**: the launch post does not disclose fees — [Cloudflare blog](https://blog.cloudflare.com/monetization-gateway/)

### Inferences

- At small scale, a self-host publisher on Zuplo Free + Stripe pays roughly Stripe processing + 0.7% (if using Stripe Billing), probably ~3.5–4% all-in, versus Zevium's 5% + processing (depending on who absorbs card fees). The fee gap is small. Zevium's 5% must be justified by demand, agent distribution and no-ops payouts/tax, not by price.
- Enterprise tools (Apigee, Kong, Orb, Metronome) are sales-gated or quote-only, so they are effectively inaccessible to indie publishers. Zevium's real self-host competitor for the long tail is Zuplo (+ Stripe), plus Cloudflare when x402 opens up.

### Gaps

- Kong Metering & Billing add-on price, Paid.ai pricing and Cloudflare Monetization Gateway fees: none found.
- Whether Metronome usage billing costs extra on top of Stripe's 0.7%: sources conflict.

## Q3. Agent-era features: MCP from OpenAPI, per-token/outcome billing, x402

### Takeaway

"OpenAPI → billable MCP tools" is now table stakes at gateway vendors (Zuplo, Kong). Per-token LLM metering with markup is commoditized (Stripe, Kong, Zuplo). Outcome-based billing has a funded specialist (Paid.ai). x402 / HTTP 402 keyless pay-per-call is the emerging threat: Cloudflare's Monetization Gateway (announced 2026-07-01, closed beta Oct 2026) lets any Cloudflare customer charge per API call or MCP tool call with no signup or API key.

### Cited Findings

- **Zuplo**: "Turn any OpenAPI route into a billable MCP tool with no extra configuration". Gateway entitlement checks run before the tool call reaches the API. MCP requests use the same meters and Stripe invoices as REST. Agents authenticate via API key or OAuth — [Zuplo monetize page](https://zuplo.com/solutions/monetize-and-control)
- Zuplo guidance: meter only `tools/call` so protocol chatter stays free. MCP access is gated by plan as a premium feature (403 for free users) — [Zuplo: monetize an MCP server](https://zuplo.com/blog/monetize-an-mcp-server)
- Zuplo per-model token metering across OpenAI, Anthropic and Gemini — [Zuplo monetize page](https://zuplo.com/solutions/monetize-and-control)
- **Kong**: the AI MCP Server entity has a "Generate from REST API" mode that converts REST paths into MCP tools and serves MCP on the route. The older AI MCP Proxy plugin converts API schemas into MCP tool definitions — [Kong docs: autogenerate MCP tools](https://developer.konghq.com/mcp/autogenerate-mcp-tools); [Kong docs: map API to MCP](https://developer.konghq.com/ai-gateway/map-api-to-mcp-tools/). The AI MCP OAuth2 plugin enforces OAuth 2.1 and maps claims to per-tool ACLs — [Kong enterprise MCP gateway blog](https://konghq.com/blog/product-releases/enterprise-mcp-gateway). Konnect MCP support was announced 2025-10-14 — [Kong PR](https://www.konghq.com/company/press-room/press-release/kong-announces-konnect-mcp-support-to-make-ai-and-agentic-development-easier-more-secure-and-cost-effective). Metering page lists MCP as a monetizable resource — [Kong feature page](https://konghq.com/products/kong-konnect/features/usage-based-metering-and-billing)
- **Stripe token billing**: private preview, launched 2026-03-02. It sets a markup over model costs, syncs model prices across providers, and meters per customer by model and token type (input/output/cached). Stripe auto-configures prices, meters and rate cards. Usage arrives via the Stripe AI Gateway, partners (Vercel, OpenRouter) or self-report — [Stripe docs: token billing](https://docs.stripe.com/billing/token-billing); [TechCrunch](https://techcrunch.com/2026/03/02/stripe-wants-to-turn-your-ai-costs-into-a-profit-center)
- **Paid.ai**: billing for AI agents that charges for value or outcomes delivered rather than seats or tokens. Customers include Artisan and IFS — [Yahoo Finance/TechCrunch syndication](https://finance.yahoo.com/news/outreach-palantir-salesforce-veterans-raise-180106299.html); [EQT Ventures](https://stories.eqtventures.com/articles/rewriting-the-rules-of-ai-monetization-why-we-re-backing-paid-s-10m-pre-seed-round)
- **Amberflo**: outcome-based pricing supported — [Amberflo platform](https://amberflo.io/platform)
- **Cloudflare Monetization Gateway** (blog dated 2026-07-01): charges "any caller for any resource, from an API to data to an MCP tool call". Supports route/verb pricing (e.g. "$0.01 for every GET or POST request to /api/premium/*") and variable pricing ("up to $2, depending on the compute used"). Can turn origin 401s into 402s with a price. Managed via dashboard, API or Terraform. Settles in stablecoins (USDC, Open USD) over x402, redeemable to fiat. "No signup, no API key, no prior relationship required." Buyers can be required to use Web Bot Auth. No OpenAPI integration or buyer directory mentioned — [Cloudflare blog](https://blog.cloudflare.com/monetization-gateway/)
- Status Oct 2026: closed beta limited to eligible US sellers and buyers, USDC on Base — [daily.dev](https://daily.dev/posts/cloudflare-brings-paid-access-to-mcp-tools-who-controls-the-agent-s-spending--ahhn1cm31); [Intelligent CIO, 2026-10-08](https://www.intelligentcio.com/me/2026/10/08/cloudflare-launches-monetization-gateway-beta-to-enable-usage-based-payments-for-ai-agents/)
- Buyer-side Account/Virtual Wallets with spend caps reportedly shipped 2026-08-04. Single secondary source, unconfirmed — [explainx](https://explainx.ai/blog/cloudflare-monetization-gateway-x402-mcp-api-micropayments-2026)
- Predecessor Pay Per Crawl (private beta): publisher sets a per-request price, edge returns 402, Cloudflare bills the AI company and pays the publisher — [Blankspace](https://blankspace.so/blog/what-is-cloudflare-pay-per-crawl-publishers/)
- Cloudflare co-launched the x402 Foundation with Coinbase and added x402 to the Agents SDK and MCP servers — [Cloudflare x402 tag](https://blog.cloudflare.com/tag/x402/)
- Counter-signal: one report says x402 settlement volume is down 93% YTD in 2026 — [Yahoo Finance/CCN](https://finance.yahoo.com/markets/crypto/articles/x402-settlement-volume-plunges-93-105710906.html)

### Inferences

- Zevium's "OpenAPI spec → priced endpoints → agent tool" pipeline is not unique. Zuplo and Kong both ship OpenAPI→MCP. Zevium's distinct claim is pricing **inside the spec** (`x-zevium-cost`) plus cross-publisher discovery and one wallet for buyers.
- Cloudflare's 402 model is the biggest strategic threat. It removes the key/signup/prepay friction that Zevium's org-credit model has, on the network many publishers already sit behind. Its current limits are closed beta, US-only, stablecoin-only, no discovery and no OpenAPI. Zevium could add x402 as a settlement option rather than compete with it.
- Nobody found does per-operation pricing declared in OpenAPI extensions. Zuplo plans and Cloudflare rules are configured separately from the spec.

### Gaps

- Tyk MCP Gateway capabilities and billing: no details found.
- Whether Zuplo, Kong or Stripe support x402: none found in sources reviewed.
- Paid.ai product specifics (signals API, pricing) not fetched.

## Q4. Traction, funding, acquisitions (dated)

### Takeaway

The category is consolidating fast into payments and gateway incumbents: WSO2 bought Moesif (May 2025), Kong bought OpenMeter (Sep 2025), Stripe bought Metronome (~$1B reported; signed Dec 2025, closed 2026-01-14), and Adyen bought Orb (announced 2026-06-11, reported ~$335M). Standalone survivors are Lago, Stigg, Amberflo and Paid.ai. Billing is becoming a feature of the payment processor or gateway.

### Cited Findings

- **Stripe ← Metronome**: definitive agreement 2025-12-02. Terms undisclosed, reported $1B (Upstart Media/Alex Konrad). Collison: "Metered pricing is the native business model for the AI era." Customers include OpenAI, Anthropic, Databricks, NVIDIA — [FinTech Futures](https://www.fintechfutures.com/m-a/stripe-to-acquire-billing-platform-metronome); [Payments Dive](https://www.paymentsdive.com/news/stripe-to-buy-metronome/807055/). Completed 2026-01-14 — [Stripe newsroom](https://stripe.com/en-nl/newsroom/news/stripe-completes-metronome-acquisition). Metronome previously raised a $50M Series C — [Sacra](https://sacra.com/research/why-stripe-bought-metronome/)
- **Kong ← OpenMeter**: announced 2025-09-03, terms undisclosed, Kong's second acquisition. OpenMeter was founded 2023 by Peter Marton and Andras Toth. Integration into Konnect by early 2026, full customer migration mid-2026 — [Kong PR](https://konghq.com/company/press-room/press-release/kong-acquires-openmeter-to-unlock-ai-and-api-monetization-for-the-agentic-era); [The Stack](https://www.thestack.technology/api-gateway-firm-kong-snaps-up-openmeter/); [SiliconANGLE](https://siliconangle.com/2025/09/03/kong-acquires-openmeter-power-api-ai-monetization/)
- **WSO2 ← Moesif**: announced 2025-05-28, all-cash, terms undisclosed. Runs as an independent subsidiary in WSO2's API Management unit — [WSO2 news](https://wso2.com/about/news/wso2-acquires-leading-api-analytics-and-monetization-startup-moesif/); [WSO2 acquisitions](https://wso2.com/acquisitions/moesif/)
- **Adyen ← Orb**: announced 2026-06-11, close guided around 2026-07-01, reported $335M. Orb continues standalone. Source is rival Lago — [Lago blog](https://getlago.com/blog/orb-adyen-acquisition-lago-alternative). Orb had raised ~$44M before the deal — [Sacra](https://sacra.com/c/lago/)
- **Lago**: $15M Series A, March 2024, led by FirstMark at ~$100M est. valuation; ~$22M total — [Sacra](https://sacra.com/c/lago/)
- **Paid.ai** (Manny Medina, ex-Outreach): €10M pre-seed March 2025 (EQT Ventures), then a ~$21–21.6M seed led by Lightspeed; ~$33M total. Valuation reportedly >$100M — [EQT](https://stories.eqtventures.com/articles/rewriting-the-rules-of-ai-monetization-why-we-re-backing-paid-s-10m-pre-seed-round); [Yahoo Finance](https://finance.yahoo.com/news/outreach-palantir-salesforce-veterans-raise-180106299.html); [Startuphub](https://www.startuphub.ai/news/paid-ai-nabs-33m-for-ai-outcome-based-pricing)
- **Stripe token billing**: preview 2026-03-02 — [TechCrunch](https://techcrunch.com/2026/03/02/stripe-wants-to-turn-your-ai-costs-into-a-profit-center)
- **Zuplo monetization**: public beta 2026-03-26 — [Zuplo changelog](https://zuplo.com/changelog/2026/03/26/api-monetization-beta)
- **Cloudflare Monetization Gateway**: waitlist 2026-07-01, closed beta by Oct 2026 — [Cloudflare blog](https://blog.cloudflare.com/monetization-gateway/); [Intelligent CIO](https://www.intelligentcio.com/me/2026/10/08/cloudflare-launches-monetization-gateway-beta-to-enable-usage-based-payments-for-ai-agents/)

### Inferences

- Processors (Stripe, Adyen) now own the top usage-billing engines, so billing is being bundled into payments. Publishers on Stripe get metering "free-ish". This raises the bar for Zevium to justify a separate ledger, and its answer has to be the buyer side, not billing.
- The gateway–billing merger (Kong+OpenMeter, Zuplo native monetization, WSO2+Moesif) means "gateway + metering + portal + Stripe" is a commodity bundle by 2026.

### Gaps

- Stigg and Amberflo funding: no reliable 2025–26 data found (PitchBook/CB Insights pages paywalled).
- Zuplo funding/traction for monetization (customer count, GMV): not found.
- Orb-Adyen price is from a rival vendor blog; no primary Adyen confirmation fetched.

## Q5. Where they fall short for a small publisher wanting demand; implications for Zevium (why a marketplace, must-match features, ideas worth copying)

### Takeaway

Every self-host tool reviewed sells **plumbing, not buyers**. None list the publisher in a cross-vendor catalog, give buyers one wallet across APIs, or route agents to them. Cloudflare's no-signup x402 comes closest to removing buyer friction, but it has no discovery. Zevium's defensible pitch is demand plus one wallet plus agent distribution, with plumbing at parity.

### Cited Findings

- Zuplo's monetization page mentions no marketplace, buyer referral or revenue share. Its portal is per-publisher — [Zuplo monetize page](https://zuplo.com/solutions/monetize-and-control)
- Cloudflare Monetization Gateway post describes no buyer directory or OpenAPI integration. Agents discover price only when they hit a 402 — [Cloudflare blog](https://blog.cloudflare.com/monetization-gateway/)
- Tyk's portal is a "storefront" for the publisher's own APIs only — [Tyk monetization](https://tyk.io/api-monetization/)
- Going live on Zuplo monetization requires contacting sales — [Zuplo changelog](https://zuplo.com/changelog/2026/03/26/api-monetization-beta). Orb, Metronome, Lago cloud and Apigee are quote or sales-led — [Stigg](https://www.stigg.io/blog-posts/metronome-pricing); [Solvimon](https://www.solvimon.com/blog/best-billing-systems-in-2026)
- Stigg frames a market "entitlements gap": billing engines don't gate requests in real time, so a separate runtime check is needed before a request is served — [Stigg](https://www.stigg.io/blog-posts/metronome-alternatives)

### Inferences

**Why a publisher picks Zevium over self-host**

- Demand: none of the tools bring buyers, so a cross-publisher catalog and agent-tool endpoint is the only reason to accept a 5% cut over roughly 0.7%–4% self-host costs.
- Buyer friction: each self-hosted API forces the buyer to sign up, add a card and get a key per vendor. Zevium's single org wallet (one top-up for all APIs) removes that friction, which is what Cloudflare's x402 attacks from the other side.
- Ops: no Stripe account setup, no invoicing, Connect payouts handled, and per-call micro-amounts work without card-fee floors because buyers prepay credits.
- Time-to-revenue: spec upload → live priced endpoints, versus Zuplo's "contact sales to go live" and enterprise quote cycles.

**Must-match (parity table stakes in 2026)**

- OpenAPI → MCP tool generation with per-tool metering, billing only `tools/call` (Zuplo, Kong).
- Edge hard-limit gating with clear 402/429 messaging, no backend code (Zuplo; Zevium already blocks at zero balance).
- Credit packs with bonus tiers, auto-refill and non-expiring credits (Zuplo packs).
- Free tier/freemium per operation (Zevium has `x-zevium-free-tier`). Also graduated/tiered per-call pricing (Zuplo, Apigee), which Zevium lacks if `x-zevium-cost` is a flat number.
- Publisher dashboard: per-endpoint revenue, request volume, key/consumer growth, MRR (Zuplo).
- Buyer dashboard: real-time usage/spend and spend alerts (Metronome roadmap; Stripe).
- Plan/version lifecycle (Draft/Published/End of Sale/Retired); Zevium has immutable spec versions, so it needs deprecation/retirement semantics.
- Token-based metering for LLM-wrapping APIs (Stripe, Kong, Zuplo) via a computed-cost hook, since some publisher APIs wrap LLMs and need cost-plus pricing.

**Ideas worth copying**

- Stripe token billing's "markup over upstream cost" lets publishers price as cost + X% and keep up with changing model prices, a `x-zevium-cost` variant (e.g. `cost-plus`).
- Cloudflare's variable pricing up to a cap ("up to $2 depending on compute"): a per-operation max price with actual-cost settlement fits the wallet DO pre-authorize/settle pattern.
- Cloudflare's 401→402 conversion and "no signup" pay-per-request: offer x402 as an alternate settlement rail at the Zevium gateway so non-account agents can pay per call, with Zevium as facilitator and the catalog for discovery.
- Kong's per-tool ACLs from OAuth claims: per-operation scopes on Zevium keys (agent keys limited to specific tools/spend caps).
- Cloudflare-style virtual wallets with spending allowances and transaction caps: per-agent sub-budgets inside an org wallet.
- Outcome-based pricing (Paid.ai, Amberflo): a P2 option where the publisher's response signals billable success, e.g. charge only on 2xx or a specific outcome field.
- Zuplo's "git push deploys gateway + billing": spec-in-repo CI publish (GitHub Action pushing a new spec version).

### Gaps

- No quantitative data found on how much demand marketplaces actually deliver versus self-host (conversion, share of revenue from discovery). Would be needed to prove the core value claim.
- No data on publisher willingness to pay a 5% take vs self-host.
- Whether Zuplo/Kong/Stripe plan to add buyer-side discovery or x402: not found.
