# API and Data/Actor Marketplaces as Competitors/Analogs for Zevium (as of Oct 2026)

Scope: Apify Store, RapidAPI (Nokia API Hub), Postman API Network, APILayer, Zyla API Hub, AWS Marketplace (AI Agents & Tools), Nango, Replicate / Hugging Face, Snowflake Marketplace, Datarade, and new agent-native marketplaces from 2025-2026 (Coinbase Agentic.market / x402 Bazaar, Circle, MCPize, Smithery, MCP-Hive, GET4AGENT, run.pay, Cloudflare paid MCP tools). treg.to excluded per brief. Research date: 2026-10-10. Many traction numbers come from third-party or SEO sites; those are marked "unverified".

## 1. Business model, take rate, payout mechanics

### Takeaway

Take rates fall into three bands. Dev-API marketplaces charge 20-25% (RapidAPI raised its fee from 20% to 25% in Nov 2025; Apify and Zyla take 20%; api.market takes up to 20%). Enterprise cloud marketplaces charge 1.5-3% (AWS SaaS). Agent-native and crypto rails charge 0% to almost nothing to win early supply. Zevium's 5% sits between the cloud marketplaces and the free crypto rails, and well under the dev-API incumbents.

### Cited Findings

**Apify Store**

- PPE (pay per event) creator profit = 80% of revenue minus the Actor's platform usage costs. Standard PPE commission is 20%. — [Apify docs: PPE](https://docs.apify.com/platform/actors/publishing/monetize/pay-per-event); [Apify docs: pricing and costs](https://docs.apify.com/platform/actors/publishing/monetize/pricing-and-costs)
- Only paid-plan users count toward revenue and costs. Apify covers free-plan users' usage costs. An Actor with negative profit counts as $0 when aggregated, so its losses do not offset other Actors. — [Apify docs: pricing and costs](https://docs.apify.com/platform/actors/publishing/monetize/pricing-and-costs); [Apify docs: PPE](https://docs.apify.com/platform/actors/publishing/monetize/pay-per-event)
- Synthetic `apify-actor-start` event is on by default. Apify pays compute for the first 5s of every run. — [Apify docs: PPE](https://docs.apify.com/platform/actors/publishing/monetize/pay-per-event)
- Standby-mode Actors monetized only via PPE do not have to cover users' platform usage costs. — [Apify docs: pricing and costs](https://docs.apify.com/platform/actors/publishing/monetize/pricing-and-costs)
- Payouts are monthly, on the 11th. The dashboard shows revenue, users and runs. Help article dated Nov 10, 2025. — [Apify help: ship your Actor and get paid](https://help.apify.com/en/articles/12800725-ship-your-actor-and-get-paid)
- Rental model sunset: new rental Actors and price changes blocked from Apr 1, 2026. On Oct 1, 2026 all rental Actors are retired and remaining ones migrated to pay-per-usage. — [Apify docs: paid actors](https://docs.apify.com/platform/actors/paid-actors); third-party timeline in [godberrystudios](https://godberrystudios.com/posts/apify-pay-per-event-migration-playbook-2026/)
- Anecdote (unverified): developers report 40-70% revenue drops moving from rental to PPU without a proper PPE plan. — [godberrystudios](https://godberrystudios.com/posts/apify-pay-per-event-migration-playbook-2026/)
- Payout minimum and method: the docs page was not retrievable (404). See Gaps.

**RapidAPI / Nokia API Hub**

- Current fee is a flat **25%** on all payments through the Hub, effective Nov 15, 2025 under updated terms. The fee does not cover PayPal payout fees. — [RapidAPI docs: payouts and finance](https://docs.rapidapi.com/docs/payouts-and-finance)
- Earlier docs said 20%. — [RapidAPI docs v1.0](https://docs.rapidapi.com/v1.0/docs/payouts-and-finance); 2021 coverage of the 20% cut in [SiliconANGLE](https://siliconangle.com/2021/04/21/api-marketplace-rapidapi-raises-60m-funding-expand-developer-features/)
- In 2018 RapidAPI reportedly took about 1% per call. The take rate rose over time. — [TechCrunch 2018](https://techcrunch.com/2018/03/13/rapidapi-an-api-marketplace-that-processes-half-a-billion-api-calls-each-month-raises-9m-led-by-a16z/)
- PayPal is the only payout method. A month's charges are paid at the end of the following month (January charges reach PayPal in the first week of March). Payouts happen only after the card or bank settles. Refunds and chargebacks are offset against future payouts. W9 forms are available on request. — [RapidAPI docs: payouts and finance](https://docs.rapidapi.com/docs/payouts-and-finance)

**Zyla API Hub / APILayer**

- Zyla: providers keep 80% of subscription income and Zyla keeps 20%. Listing is free. — [Zyla help center](https://help.zylalabs.com/article/18-what-is-the-cost-of-uploading-my-api-to-zyla-api-hub)
- Zyla supports subscription, usage-based and pay-per-call billing. — [Zyla: monetize your API](https://www.zylalabs.com/monetize-your-api)
- APILayer was acquired by Idera on Jan 19, 2021 (terms undisclosed). It calls itself a "highly curated" marketplace that also lets developers monetize their own APIs. No public split found. — [VentureBeat](https://venturebeat.com/business/idera-acquires-api-developer-apilayer); [APILayer about](https://marketplace.apilayer.com/about-us)
- api.market retains up to 20% of sales. — [Zuplo guide](https://zuplo.com/learning-center/how-to-promote-your-api-api-marketplaces.md)

**Postman API Network**

- No native API billing. Providers bill outside Postman. Free for individuals, with paid tiers for teams. — [Apify blog, Jan 26 2026](https://blog.apify.com/best-rapidapi-alternatives/)

**AWS Marketplace**

- Fees since Jan 5, 2024: public SaaS and Data Exchange offers 3%. Private offers 3% under $1M TCV, 2% for $1M-$10M, 1.5% at $10M+. Private renewals 1.5%. Professional services 2.5%. CPPO adds +0.5%. — [AWS What's New, Jan 2024](https://aws.amazon.com/about-aws/whats-new/2024/01/aws-marketplace-simplified-reduced-listing-fees/)
- Server products (AMI, container, ML) reportedly stay at 20% for public offers. — [AWS re:Post](https://repost.aws/questions/QUFVr8yF6dTEeIyTT-dj9bKA/what-is-aws-marketplace-store-fee-for-paid-products)
- AI Agents & Tools listings: free or paid. Paid listings can use upfront contracts, pay-as-you-go subscriptions, or both. API-based listings qualify for the SaaS Co-Sell Benefit (incentives for AWS field sellers). — [AWS APN blog, Jul 16 2025](https://aws.amazon.com/blogs/apn/aws-partner-guide-to-ai-agents-and-tools-in-aws-marketplace)
- Oct 2025: contract and usage-based pricing added for Bedrock AgentCore Runtime containers. — [AWS What's New, Oct 2025](https://aws.amazon.com/about-aws/whats-new/2025/10/aws-marketplace-pricing-ai-agents-tools)

**Snowflake Marketplace**

- One plan per listing, usage-based or subscription. A plan cannot be removed once attached. Usage plans can combine billable events, per-query charges and a monthly fee, billed in arrears. Dynamic plans must set a monthly maximum, and usage above it is free. The first query each month is always charged, and providers can then grant free queries. USD only. — [Snowflake docs](https://docs.snowflake.com/en/collaboration/provider-listings-pricing-model); [Snowflake blog](https://www.snowflake.com/en/blog/marketplace-monetization-turn-data-apps-revenue-stream)
- Stripe pays providers. When a consumer pays from a Capacity commitment, Snowflake pays instead (the enterprise "burn your committed spend" mechanic). — [Snowflake docs](https://docs.snowflake.com/en/collaboration/provider-listings-pricing-model)

**Datarade**

- Free for buyers. Providers choose subscription tiers or a "Commission-only" plan (marked most popular, $1,000 posting budget). — [Datarade provider apply](https://providers.datarade.ai/apply)
- Unverified: annual subscriptions plus 30% commission plus per-GB egress. — [ZoomInfo pipeline article](https://pipeline.zoominfo.com/sales/datarade-pricing)
- Deals still close off-platform. Buyer requests get competing offers in 24-48h. — [ZoomInfo review](https://pipeline.zoominfo.com/sales/datarade-review)

**Model marketplaces**

- Hugging Face Inference Providers: pure pass-through with "no additional markup". Revenue sharing with providers is mentioned only as a possible future step. Monthly credits: $0.10 free, $2 PRO, $2 per Team/Enterprise seat. — [HF blog](https://huggingface.co/blog/inference-providers); [HF pricing docs](https://huggingface.co/docs/inference-providers/pricing)
- Replicate: Cloudflare announced the acquisition Nov 17, 2025 (terms undisclosed, 50k+ models, separate brand kept). No creator revenue-share program found. — [Cloudflare press release via Nasdaq](https://www.nasdaq.com/press-release/cloudflare-acquire-replicate-build-most-seamless-ai-cloud-developers-2025-11-17)

**Agent-native / MCP marketplaces (2025-2026)**

- Coinbase CDP x402 facilitator: 1,000 transactions free per month, then $0.001 per onchain transaction. Verification is free, and batch settlement spreads one onchain transaction over many payments. — [CDP facilitator docs](https://docs.cdp.coinbase.com/x402/core-concepts/facilitator). Conflict: the [CDP FAQ](https://docs.cdp.coinbase.com/x402/support/faq) says Base USDC carries zero facilitator fee.
- MCPize: 80% creator share per [Verdantix](https://atlas.verdantix.com/vendors/mcpize), 85% per [godberrystudios](https://godberrystudios.com/posts/how-to-monetize-mcp-servers-2026/) and [chatforest](https://chatforest.com/guides/mcp-marketplace-monetization/). Hosting included. Sources conflict.
- Smithery: one guide says creators pay $30/month and get no revenue share. — [chatforest](https://chatforest.com/guides/mcp-marketplace-monetization/). Another lists a "Monetization+" paid-server feature. — [aitoolsatlas](https://aitoolsatlas.ai/tools/smithery). Status unclear.
- Glama: revenue share "in the works", currently 0. — [chatforest](https://chatforest.com/guides/mcp-marketplace-monetization/)
- MCP-Hive: 0% fee for founding providers (unverified roundup). — [dev.to roundup, May 2026](https://dev.to/kirothebot/the-agent-economy-is-real-12-platforms-where-ai-agents-actually-earn-money-may-2026-5bm2)
- GET4AGENT: 0% fee during pilot. Agents pay as they go. — [get4agent partners](https://get4agent.com/partners)
- Cloudflare Agents SDK: `paidTool` sets a per-call USD price on individual MCP tools via x402 (docs example $0.01). Cloudflare takes no cut on this path. The separate Monetization Gateway is a closed beta for eligible US sellers. — [stablecoininsider](https://stablecoininsider.org/how-to-charge-for-mcp-tools-with-cloudflare-agents-x402/); [The New Stack](https://thenewstack.io/cloudflare-x402-agent-spending/); [CF docs](https://developers.cloudflare.com/agents/tools/payments/x402/pay-from-agents-sdk/index.md)

### Inferences

- RapidAPI raised its fee to 25% while traffic and attention moved elsewhere. That opens a direct pitch: "95% vs 75%" is a 20-point gap, and the publisher earns 27% more per dollar (0.95/0.75 ≈ 1.27).
- Apify's "80% minus your compute" makes creators carry infrastructure cost, so the effective take can exceed 20%. Zevium proxies but does not host, so it has no compute to pass through. A flat 5% is simpler to explain.
- Payout friction is a real differentiator. RapidAPI pays only via PayPal, with a lag of up to 2 months and fees excluded. Stripe Connect transfers on a short cycle would beat that clearly.
- Snowflake's mandatory monthly charge cap matches Zevium's "never surprise-overage" rule closely. Consider a per-listing or per-key spend cap as a first-class feature.

### Gaps

- Apify payout minimums and methods (manage-payouts page returned 404). Apify pay-per-result commission.
- Snowflake Marketplace commission (none published in the sources found).
- Datarade's real commission: only a secondary source says 30%.
- APILayer revenue split: not public.
- Postman: no evidence of any publisher monetization.

## 2. How they seeded supply

### Takeaway

The marketplaces that succeeded seeded supply in four ways: the operator built first-party listings, they ran cash creator challenges, they let developers import an existing artifact (collection, spec or endpoint) at almost no cost, and they indexed providers automatically from payment traffic. Coinbase's Bazaar indexes any x402 endpoint the first time a payment settles, with no sign-up. That is the most aggressive zero-friction seeding seen so far.

### Cited Findings

- **Apify $1M Challenge** (Nov 2025 to Jan 31, 2026): 704 developers published 3,329 Actors, of which 1,086 qualified. Grand prizes were $30k, $20k and $10k ($60k total) plus weekly spotlights and regional and newcomer awards. Judged on MAU, quality, technical excellence and usefulness. — [apify.com/challenge](https://apify.com/challenge); [challenge T&C](https://docs.apify.com/legal/challenge-terms-and-conditions)
- The challenge paid rewards on top of normal revenue for Actors published during the challenge window. — [Apify help](https://help.apify.com/en/articles/12800725-ship-your-actor-and-get-paid)
- Apify's promotion playbook tells creators to write SEO READMEs, post on Reddit, Quora, YouTube and Product Hunt, and tag Apify. Distribution work is pushed onto creators. — [Apify docs: monetize](https://docs.apify.com/platform/actors/publishing/monetize)
- **Coinbase Agentic.market / Bazaar**: endpoints are "indexed automatically by Bazaar". When the CDP Facilitator settles a payment on an x402 endpoint with the Bazaar extension active, the endpoint's metadata is extracted and indexed, with no provider registration ("self-learning"). More than 70 curated services sit on top of thousands of auto-detected ones. Curated listings get human-written metadata and rank higher. — [Stellagent](https://stellagent.ai/insights/coinbase-agentic-market-x402)
- CDP Bazaar holds 23,000+ x402 resources and is still "under active development". Search ranking and the MCP interface were recent additions. — [CDP: get discovered](https://docs.cdp.coinbase.com/x402/seller/get-discovered)
- **Postman**: supply grows out of existing public workspaces. Teams make a workspace public and consumers fork collections. The optional verified badge requires domain verification, quality docs and auth setup, and unlocks Publisher Analytics and Guided Auth. — [Postman verify publisher](https://learning.postman.com/docs/postman-api-network/showcase/prepare/verify-publisher-team.md)
- Postman's MCP Generator turns any public API Network request into an MCP server, one tool per request. That supply needed no new work from publishers. — [Postman docs: MCP generator](https://learning.postman.com/latest-v-12/docs/postman-ai/mcp-servers/generate)
- **AWS**: launched AI Agents & Tools at AWS Summit NYC, July 2025, with 900+ listings including Anthropic, Salesforce, IBM, PwC, Stripe, Perplexity, Automation Anywhere and C3.ai. — [PYMNTS](https://www.pymnts.com/artificial-intelligence-2/2025/aws-unveils-ai-agent-marketplace-as-one-stop-shop-for-enterprise-deployment/). AWS's own post says "hundreds" at launch. — [AWS APN blog](https://aws.amazon.com/blogs/apn/aws-partner-guide-to-ai-agents-and-tools-in-aws-marketplace). The lever was co-sell incentives for the AWS field sales force (SaaS Co-Sell Benefit).
- **Zyla**: grew out of the founder building his own APIs after failing to find affordable quality ones. Origin story points to operator-built supply. — [Zyla about](https://www.zylalabs.com/about-us)
- **Fee holidays**: MCP-Hive charges founding providers 0% ([dev.to roundup](https://dev.to/kirothebot/the-agent-economy-is-real-12-platforms-where-ai-agents-actually-earn-money-may-2026-5bm2)). GET4AGENT charges 0% during its pilot ([get4agent](https://get4agent.com/partners)).
- **Datarade**: buyers post requests and providers compete with offers in 24-48h. Demand pulls supply onto the platform. — [ZoomInfo review](https://pipeline.zoominfo.com/sales/datarade-review)

### Inferences

- Cash challenge ROI: Apify's $1M headline translated into about $60k in grand prizes plus weekly spotlights, and produced 1,086 qualifying Actors. Cheap supply for a marketplace with existing demand. Zevium has no demand yet, so a challenge alone would produce listings nobody calls.
- The Bazaar pattern (index on first paid call) fits Zevium's spec-ingest model well: auto-create a draft listing from any public OpenAPI spec and let the owner "claim" it to switch on payouts. This is the "unclaimed listing" pattern from Yelp and Google Business. Spec-scraping is unverified for any API marketplace here, but it is the obvious extension.
- Postman's leverage came from artifacts publishers already had. Zevium's OpenAPI-native publishing works the same way. A "paste your spec URL, get paid MCP tools in 60s" flow is the core supply hook.

### Gaps

- No primary source on how RapidAPI seeded its early catalog (e.g. scraping or operator wrappers).
- No data on Apify's share of first-party (apify/*) Actors versus community Actors.
- Unknown whether Zyla's 4,000+ APIs are mostly in-house.

## 3. Pricing models exposed to consumers

### Takeaway

The market is converging on per-event or per-call pricing with optional volume tiers and prepaid credit. Subscription-tier marketplaces (RapidAPI, Zyla, APILayer) are criticized for overage surprises and unclear "billing objects". Agent rails price per call in stablecoins with prepaid balances.

### Cited Findings

- Apify: PPE (charge per developer-defined event), pay-per-usage (platform cost only), and rental (being retired). Discount tiers FREE, BRONZE, SILVER, GOLD, plus enterprise PLATINUM and DIAMOND. Compute unit costs $0.20 (Free/Bronze), $0.16 (Silver), $0.13 (Gold). Console free tier includes $5/month credits. — [Apify docs: monetize](https://docs.apify.com/platform/actors/publishing/monetize); [pricing and costs](https://docs.apify.com/platform/actors/publishing/monetize/pricing-and-costs); [Apify blog](https://blog.apify.com/best-rapidapi-alternatives/)
- Apify: creators may limit free-plan users but must disclose limits in the README and input schema, and must exit gracefully with a clear status message, "don't let a policy restriction look like a bug". — [Apify docs: monetize](https://docs.apify.com/platform/actors/publishing/monetize)
- RapidAPI criticisms: no spend limits, no IP or domain restriction, limited monitoring (no p95/p99, no per-request logs), and non-standard "billing objects" with "overage surprises and plan changes". — [Apify blog, Jan 2026 (competitor; biased)](https://blog.apify.com/best-rapidapi-alternatives/)
- RapidAPI overages are not refunded without the provider's permission. — [RapidAPI docs](https://docs.rapidapi.com/docs/payouts-and-finance)
- "Despite the platform's lack of support for even basic pricing controls, they still charge 20%." — [Zuplo / dev.to](https://dev.to/zuplo/how-to-promote-and-market-your-api-api-marketplaces-4ink)
- Zyla: subscription with soft caps. APILayer: tiered per-API subscriptions with hard caps. — [Apify blog](https://blog.apify.com/best-rapidapi-alternatives/)
- Snowflake: usage-based (events, per-query, monthly fee) with a mandatory monthly cap, or upfront subscription. — [Snowflake docs](https://docs.snowflake.com/en/collaboration/provider-listings-pricing-model)
- AWS buyers can filter by pay-as-you-go, contract or free trial. — [AWS buyer guide](https://docs.aws.eu/marketplace/latest/buyerguide/ai-agent-discovery.html)
- Apify MCP agent payments are prepaid: x402 signs a $1.00 USDC balance, Skyfire PAY tokens need a $5 minimum. Unused x402 balance is refunded after 60 min of inactivity. Discovery calls are free. — [Apify MCP server README (GitHub MCP registry)](https://github.com/mcp/com.apify/apify-mcp-server)

### Inferences

- Zevium's prepaid org credits with zero-balance blocking match the direction of the most-praised models (Apify spend caps, Snowflake caps, x402 prepaid balance). RapidAPI's main pricing complaint is overage surprises, so Zevium can market "hard stop at zero" against it directly.
- Apify's free-plan disclosure rule is worth copying as a publisher guideline for free tiers (`x-zevium-free-tier`).

### Gaps

- No data on what share of RapidAPI or Zyla revenue is subscription versus pay-per-call.

## 4. Agent-facing features (MCP, llms.txt, tool search, agent payments)

### Takeaway

Every incumbent has added an MCP surface since 2025, using auto-generated one-tool-per-endpoint servers (RapidAPI, Postman) or a meta-server with dynamic search (Apify). Apify is furthest ahead: dynamic Actor discovery over MCP, plus keyless agent payment via x402 or Skyfire with eligibility gated to PPE Actors. Agent-native rails (Coinbase Agentic.market) skip accounts and keys entirely.

### Cited Findings

- **Apify MCP** (mcp.apify.com): agents discover and run Store Actors, read storage and results, and search docs. Default tools are Actor discovery, docs search and RAG Web Browser. The toolset can be narrowed with URL params (`?tools=actors,docs,apify/web-scraper`). Transport is Streamable HTTP with OAuth (SSE removed Apr 1, 2026). The hosted server does output-schema inference. Apify recommends its plugin plus Agent Skills for Claude Code. — [Apify MCP docs](https://docs.apify.com/platform/integrations/mcp)
- **Apify agentic payments**: agents that buy a prepaid token from "Apify AGI" over x402 or MPP can run any Actor with limited permissions. Per-request payers (e.g. Skyfire) can run only Actors that use PPE, charge only for events (no "PPE + usage"), run with limited permissions, and don't use Standby. The developer must pass KYC first. Eligibility is automatic, with no opt-in. — [Apify docs: monetize](https://docs.apify.com/platform/actors/publishing/monetize)
- Apify x402 needs no Apify account (USDC on Base via the `mcpc` client). — [Apify MCP README](https://github.com/mcp/com.apify/apify-mcp-server)
- **RapidAPI / Nokia API Hub MCP**: "When enabled", the hub generates one tool per REST endpoint, served from `mcp.rapidapi.com`. Auth is the existing `x-rapidapi-key`, and subscription governs access. The Playground has an MCP chat pane and pre-filled client config JSON. Page updated 2025-12-07. An AI chat on a Nokia-deployed LLM is "coming soon". — [RapidAPI docs: consume APIs using AI](https://docs.rapidapi.com/docs/consume-apis-using-ai)
- **Postman**: MCP Generator works from public API Network requests (STDIO plus streamable HTTP). POST/CON 2025 announced the Agentic AI Builder, an MCP request type, and an MCP server network with Verified and Community servers. — [Postman MCP generator](https://learning.postman.com/latest-v-12/docs/postman-ai/mcp-servers/generate); [BusinessWire, Jun 2025](https://www.businesswire.com/news/home/20250604664643/en); [SD Times](https://sdtimes.com/api/postman-releases-several-new-capabilities-at-its-annual-user-conference/)
- **AWS**: natural-language search by use case. API-based listings support MCP or A2A. Container listings run on Bedrock AgentCore. — [AWS APN blog](https://aws.amazon.com/blogs/apn/aws-partner-guide-to-ai-agents-and-tools-in-aws-marketplace)
- **Coinbase Agentic.market** (Apr 20, 2026): no account or login. Humans use the web UI and agents query the same catalog via MCP APIs. Seven categories: Inference, Data, Media, Search, Social, Infra, Trading. Named services include OpenAI, Venice, ElevenLabs, CoinGecko, Nansen, Allium, Bloomberg, Google Maps, Firecrawl, Browserbase and Exa. Each service ships predefined "skills" telling agents how to use it. Product lead Nick Prince: "zero API keys required". — [Stellagent](https://stellagent.ai/insights/coinbase-agentic-market-x402); [Invezz](https://invezz.com/in/news/2026/04/21/coinbase-backed-x402-launches-agenticmarket-to-power-ai-agent-services/); [KuCoin news](https://www.kucoin.com/vi/news/flash/coinbase-incubated-x402-protocol-launches-ai-agent-app-store-agent-market)
- **Circle Agent Marketplace**: launched May 11, 2026 with 32 services and 349 endpoints (unverified roundup). — [dev.to roundup](https://dev.to/kirothebot/the-agent-economy-is-real-12-platforms-where-ai-agents-actually-earn-money-may-2026-5bm2)
- **run.pay** (indie, getrunpay.com): MCP discovery plus Stripe, with a per-call price on any API. Self-reported. — [dev.to](https://dev.to/palabrex/i-built-a-stripe-native-marketplace-where-ai-agents-pay-for-apis-automatically-8gf)
- **Cloudflare**: Agents SDK `withX402` and `paidTool` for sellers, and `withX402Client` for buyers with a human-confirmation callback. Planned Virtual Wallets add allowance, allowlist and max transaction size. MPP via the `mppx` SDK is also supported. — [The New Stack](https://thenewstack.io/cloudflare-x402-agent-spending/); [CF docs](https://developers.cloudflare.com/agents/tools/payments/x402/pay-from-agents-sdk/index.md)
- **Nango**: open-source integrations runtime with 800+ APIs, tool calls, syncs and webhooks. Exposes integrations as agent tools via a hosted MCP server with per-connection credential scoping. Infra, not a paid-API marketplace ("provides the runtime for integrations - not the integrations themselves"). — [getknit review](https://getknit.dev/blog/nango-review-evaluation-integration-platform); [rywalker](https://rywalker.com/research/nango)
- MCP monetization is rare: fewer than 5% of MCP servers are monetized (unverified). — [chatforest](https://chatforest.com/guides/mcp-marketplace-monetization/)
- llms.txt: no evidence found that any of these marketplaces publishes a catalog-level llms.txt.

### Inferences

- Two MCP designs compete. (a) One tool per endpoint (RapidAPI, Postman): simple, but tool lists explode and context bloats. (b) A meta-server with search, describe and call tools (Apify): scales to a 30k-item catalog. Zevium's agent endpoint should be (b), with optional pinning of specific tools (copy Apify's `?tools=` URL param).
- RapidAPI's MCP is gated by per-API subscriptions, so an agent cannot call an API it has not subscribed to. Zevium's org-wide prepaid credits across every API ("one wallet, any tool") are a structural advantage for agents choosing tools at runtime.
- Apify's eligibility rules for keyless agent payment (event-only pricing, limited permissions, KYC'd publisher) are a ready-made policy template if Zevium adds x402 or MPP alongside credits.

### Gaps

- No catalog-level llms.txt usage found at any player.
- No data on what share of Apify, RapidAPI or Postman traffic comes through MCP.

## 5. Traction: listings, payouts, revenue, funding

### Takeaway

Apify is the only marketplace in this set with credible, growing creator payouts: over $1M per month to community developers by March 2026, on roughly $13M of 2024 revenue, nearly bootstrapped. RapidAPI's catalog is the biggest but the company collapsed from a $1B valuation to an acqui-hire. Agent-native volumes are inflated by wash and test traffic.

### Cited Findings

**Apify**

- Over $1M sent to community developers for March 2026 earnings, the first month above $1M. — Apify Discord post via search ([discord.apify.com/m/1397159285774880880](https://discord.apify.com/m/1397159285774880880) or [discord.apify.com/m/1217057339396460644](https://discord.apify.com/m/1217057339396460644); exact post unverified)
- Sept 2025 payouts $563K, 6x year over year. Over $4M paid cumulatively around then. Unverified secondary. — [use-apify](https://use-apify.com/docs/apify-for-developers/monetize-actors)
- One profile claims about $1.4M per month in payouts. Secondary, unverified. — [Notion profile](https://loud-particle-7d0.notion.site/He-raised-less-in-10-years-than-most-seed-rounds-Now-he-pays-out-1-4M-a-month-3d68d2b9402b80c0bcbaeeb420ca66be)
- Store size: 26,929 Actors in Apr 2026 ([vantaige](https://vantaige.io/ai-tool/apify)) and 30,000+ as of May 26, 2026 ([use-apify](https://use-apify.com/docs/best-apify-actors)). Third-party counts.
- Revenue: $13.3M in 2024 ([Latka](https://getlatka.com/companies/apify)). CEO cited $7.5M revenue and $1M profit for 2023 (via the same Latka profile). About $8M ARR claimed in Sept 2024 ([Chopping Block](https://www.choppingblock.ai/blogs/weekly-ai-recap-from-a-consulting-project-to-a-web-scraping-platform-with-8m-in-arr)). Sources conflict.
- Funding: about $3M from J&T Ventures and Reflex Capital, Apr 2024. Only $0.5M seed until 2019, then bootstrapped. — [Vestbee](https://vestbee.com/blog/articles/czech-apify-secures-around-3-m)

**RapidAPI**

- Raised $9M (a16z, 2018) ([TechCrunch](https://techcrunch.com/2018/03/13/rapidapi-an-api-marketplace-that-processes-half-a-billion-api-calls-each-month-raises-9m-led-by-a16z/)), $25M (2020), $60M (2021) ([SiliconANGLE](https://siliconangle.com/2021/04/21/api-marketplace-rapidapi-raises-60m-funding-expand-developer-features/)) and a $150M Series D led by SoftBank VF2 in Mar 2022 at about $1B. — [TechCrunch 2023](https://techcrunch.com/2023/04/25/rapidapi-valued-at-1-billion-last-year-cuts-staff-by-50/amp)
- Apr 2023: cut 50% of staff. Two weeks later reportedly 42 people left, down from 230. Founder Iddo Gino moved to an advisor role, reportedly "removed by the board". — [TechCrunch](https://techcrunch.com/2023/04/25/rapidapi-valued-at-1-billion-last-year-cuts-staff-by-50/amp)
- Nov 13, 2024: Nokia acquired Rapid's API hub tech and R&D team to integrate into Network as Code (5G network APIs). Terms undisclosed. — [TechCrunch](https://techcrunch.com/2024/11/13/nokia-acquires-rapid-the-api-company-once-valued-at-1b/)
- Globes estimated the price at about $150M in cash (sources-based). — [Globes](https://en.globes.co.il/en/article-nokia-acquires-israeli-api-co-rapid-1001494030)
- Status 2026: the public marketplace still runs under the RapidAPI brand with "Nokia API Hub" naming. 80K+ APIs claimed in Jan 2026. — [Apify blog](https://blog.apify.com/best-rapidapi-alternatives/); [buildmvpfast](https://www.buildmvpfast.com/alternatives/rapidapi). No shutdown announced. Nokia is steering it toward telecom and network APIs. — [Light Reading](https://www.lightreading.com/5g/nokia-snaps-up-rapid-to-give-network-apis-a-boost)

**Others**

- Zyla: 4,000+ APIs, 15M+ calls per month, 200K+ registered users (self-reported). — [Zyla about](https://www.zylalabs.com/about-us)
- Postman API Network: "100,000+ APIs", all usable as MCP servers, per a Postman product head (via SD Times coverage; unverified exact source). — [SD Times](https://sdtimes.com/api/postman-releases-several-new-capabilities-at-its-annual-user-conference/)
- AWS AI Agents & Tools: 900+ listings at launch (Jul 2025). — [PYMNTS](https://www.pymnts.com/artificial-intelligence-2/2025/aws-unveils-ai-agent-marketplace-as-one-stop-shop-for-enterprise-deployment/)
- Datarade: 120k+ monthly in-market buyers and 600+ providers (self-reported; other sources say 500+ or 550+). — [Datarade](https://datarade.ai/company/contact/data-providers)
- Nango: $7.5M seed led by Gradient, Mar/Apr 2026 (announcement dates conflict). Reportedly cash-flow positive before the round. — [Nango blog](https://nango.dev/blog/nango-raises-7-5m-led-by-gradient); [getknit](https://getknit.dev/blog/nango-review-evaluation-integration-platform)
- x402 ecosystem at the Agentic.market launch: 165M+ cumulative transactions, $50M volume, and 69k or 480k+ agents (sources conflict). One month earlier CoinDesk reported about $28k in daily volume. Artemis found "roughly half of observed x402 transactions reflect artificial activity". — [Stellagent](https://stellagent.ai/insights/coinbase-agentic-market-x402)

### Inferences

- Apify's payout curve ($563K/mo in Sept 2025 to over $1M/mo in Mar 2026) is the best evidence that a creator marketplace for agent-callable tools can reach real earnings. It sat on top of an existing scraping-demand platform. Supply followed demand, not the other way around.
- x402 headline volumes are not reliable traction signals. Agent-native marketplaces are mostly catalogs so far.

### Gaps

- No official Apify cumulative payout figure for 2026, and no official Store count.
- No RapidAPI GMV or revenue figures after the acquisition.
- No Agentic.market GMV or take-rate data.

## 6. Why marketplaces failed or stagnated (RapidAPI lessons)

### Takeaway

RapidAPI stalled for several reasons at once. The company overexpanded (enterprise hub, testing and more products alongside the marketplace) while the marketplace itself had weak quality control, poor discoverability, crude pricing controls, slow PayPal-only payouts and a 20% (now 25%) fee. Subscription-gated access also adds friction for agents choosing tools at runtime.

### Cited Findings

- CEO Marc Friend said Rapid tried "to compete on too many fronts" and "often sacrificed agility". Headcount had doubled in the prior year. — [TechCrunch 2023](https://techcrunch.com/2023/04/25/rapidapi-valued-at-1-billion-last-year-cuts-staff-by-50/amp)
- The large catalog is hard to search and "lacks standardization". Few spend or access guardrails, thin monitoring, no hosting, and non-standard billing objects that cause overage surprises. — [Apify blog (competitor)](https://blog.apify.com/best-rapidapi-alternatives/)
- 20% fee charged "despite the platform's lack of support for even basic pricing controls". The fee doesn't cover PayPal payout fees. — [Zuplo / dev.to](https://dev.to/zuplo/how-to-promote-and-market-your-api-api-marketplaces-4ink)
- Providers stay because RapidAPI "likely has the most users of any API hub". — [Zuplo](https://zuplo.com/learning-center/how-to-promote-your-api-api-marketplaces.md)
- Fee raised to 25% on Nov 15, 2025, after the Nokia acquisition. — [RapidAPI docs](https://docs.rapidapi.com/docs/payouts-and-finance)
- The acquirer's strategy is telecom network APIs, not the long-tail public hub. — [Light Reading](https://www.lightreading.com/5g/nokia-snaps-up-rapid-to-give-network-apis-a-boost); [TechCrunch](https://techcrunch.com/2024/11/13/nokia-acquires-rapid-the-api-company-once-valued-at-1b/)
- Agent-rail risk: Agentic.market could stay "a thin catalog with low transaction volume" if major providers don't integrate. — [KuCoin news](https://www.kucoin.com/vi/news/flash/coinbase-incubated-x402-protocol-launches-ai-agent-app-store-agent-market) (analysis, speculative)
- Datarade still closes deals off-platform, which leaks the marketplace's take. — [ZoomInfo review](https://pipeline.zoominfo.com/sales/datarade-review)

### Inferences

- Lessons for Zevium: (1) keep scope narrow (one product, not five); (2) make quality machine-checkable (spec-validated listings, uptime and latency badges from gateway telemetry, auto-delisting of dead upstreams); (3) never let a fee rise follow an acquisition; publish a fee-lock commitment; (4) fast, low-fee payouts.
- Gateway-mediated payment stops off-platform leakage (unlike Datarade), but publishers can still move heavy users to direct contracts. Volume tiers and the low 5% fee reduce that incentive.

### Gaps

- No primary Hacker News or Reddit postmortem threads on RapidAPI were retrieved. Search returned none.
- No quantitative churn data on RapidAPI providers.

## 7. Steal-worthy ideas and whitespace for Zevium

### Takeaway

Ideas worth copying: Apify's event pricing, disclosure rules and cash challenge; Bazaar's index-on-first-payment and claimable listings; Postman's import-what-you-have flow and verified badge; Snowflake's mandatory spend caps; RapidAPI's one key for every API, applied to agents. Whitespace: an OpenAPI-native, fiat (Stripe) prepaid wallet with a low flat take and a keyless meta-MCP for agents. No incumbent combines all of these.

### Cited Findings (basis for ideas)

- Apify PPE, the free-plan disclosure rule and the KYC gate for agent eligibility. — [Apify docs: monetize](https://docs.apify.com/platform/actors/publishing/monetize)
- Apify Challenge produced 1,086 qualifying Actors in 3 months. — [apify.com/challenge](https://apify.com/challenge)
- Bazaar auto-indexes x402 endpoints when a payment settles. Curated listings rank higher. — [Stellagent](https://stellagent.ai/insights/coinbase-agentic-market-x402); [CDP docs](https://docs.cdp.coinbase.com/x402/seller/get-discovered)
- Postman verified badge plus Publisher Analytics. — [Postman docs](https://learning.postman.com/docs/postman-api-network/showcase/prepare/verify-publisher-team.md)
- Snowflake mandatory monthly max charge. — [Snowflake docs](https://docs.snowflake.com/en/collaboration/provider-listings-pricing-model)
- Founding-provider 0% fee (MCP-Hive) and pilot 0% (GET4AGENT). — [dev.to roundup](https://dev.to/kirothebot/the-agent-economy-is-real-12-platforms-where-ai-agents-actually-earn-money-may-2026-5bm2); [get4agent](https://get4agent.com/partners)
- Snowflake lets buyers pay from committed spend, and AWS uses field co-sell incentives. — [Snowflake docs](https://docs.snowflake.com/en/collaboration/provider-listings-pricing-model); [AWS APN blog](https://aws.amazon.com/blogs/apn/aws-partner-guide-to-ai-agents-and-tools-in-aws-marketplace)
- Cloudflare's per-tool `paidTool` and planned Virtual Wallets (allowance, allowlist, max transaction). — [The New Stack](https://thenewstack.io/cloudflare-x402-agent-spending/)

### Inferences (ideas; not sourced facts)

- **Claimable spec listings**: ingest public OpenAPI specs (e.g. from APIs.guru or Postman public workspaces) as unclaimed, mock-only listings via Zevium's keyless `/mock`, with a "claim and set x-zevium-cost to earn 95%" flow. Supply density without owner effort; payouts start only after claim and KYC. Check upstream ToS before proxying anything real.
- **Founding publisher deal**: 0% for the first N months or first $X GMV for early publishers, then 5% locked for 24 months. Directly targets RapidAPI's 25%.
- **Mini-challenge**: Apify-style bounties for specific missing tools agents ask for, driven by failed agent tool searches. Pay per qualifying publisher with real paid calls, not per listing.
- **Meta-MCP with search, describe and call** plus an Apify-style `?tools=` pin parameter. One wallet across every API, with no per-API subscription (fixes RapidAPI's MCP gating).
- **Quality from telemetry**: auto badges (uptime, p95 latency, error rate, spec-conformance) from the gateway. Addresses RapidAPI's discoverability and quality problem, and agents can rank tools by them.
- **Spend controls as a feature**: per-key allowance, allowlist and max per call (Cloudflare Virtual Wallets concept) on top of zero-balance blocking. Sell "agents can't run up a bill".
- **Payouts as a feature**: Stripe Connect payouts faster than RapidAPI's PayPal-only, up-to-60-day lag.
- **Optional x402 or MPP intake later**: Apify and Cloudflare show stablecoin agent payments can run alongside fiat credits. Gate eligibility the way Apify does.
- **Whitespace summary**: incumbents are either human dev-API hubs with subscription friction and high fees (RapidAPI, Zyla, APILayer), crypto-only agent rails with inflated volume and thin catalogs (Agentic.market, Circle), compute-hosting creator platforms (Apify, which wants hosted Actors and not arbitrary existing APIs), or enterprise procurement channels (AWS, Snowflake). None offers a "bring your existing API via OpenAPI, fiat prepaid, 5%, agent-native" product. Main threat: Apify extending to proxied third-party APIs, or Cloudflare productizing Monetization Gateway plus Replicate into a marketplace at the same edge layer Zevium runs on.

### Gaps

- Unverified legality and ToS risk of auto-listing third-party specs without the owner's consent.
- No data on agent conversion economics (e.g. revenue per agent session) at any player.
