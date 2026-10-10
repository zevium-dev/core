# LLM Routers (business-model analogs) and Agent-Native Data/Tool APIs (supply or competition), as of Oct 10, 2026

Scope note: treg.to is excluded (covered elsewhere). Pricing figures are from vendor pages fetched Oct 2026 unless marked third-party. Third-party pricing trackers (costbench, tinyfish, agentdeals, toolradar) often disagree with each other, so those figures are flagged.

## Q1. OpenRouter mechanics: credit fee, BYOK fee, rankings, app attribution, provider routing/fallback

### Takeaway

OpenRouter passes inference through at provider list price and earns a ~5-5.5% fee when credits are bought (5.5% card / 5% crypto), plus 5% on BYOK above a free allowance. Distribution comes from public rankings fed by voluntary app-attribution headers (HTTP-Referer + X-OpenRouter-Title). Reliability comes from price-weighted load balancing with automatic fallback across providers.

### Cited Findings

**Fees**

- Card credit purchases cost "5.5% ($0.80 minimum)"; crypto costs 5%. Inference is passed through at provider price with no markup — [OpenRouter FAQ](https://openrouter.ai/docs/faq)
- BYOK: the free allowance is measured in list-price inference cost, not in requests. Pay-as-you-go accounts get **$25,000/month** of list-price usage with no BYOK fee; above that the fee is **5%** of what the same model/provider would cost on OpenRouter, taken from credits. Enterprise allowances are custom — [OpenRouter FAQ](https://openrouter.ai/docs/faq)
  - Conflict: an Aug 2026 article describes BYOK as "waived ... for a company's first 1 million requests each month", citing a Vercel comparison. This looks like the older request-count policy. Treat the FAQ as current — [implicator.ai](https://www.implicator.ai/stripe-openrouter-7-billion-agreement/)
- Platform fees are non-refundable. Unused credit can be refunded only within 24h of purchase. Crypto is never refunded. OpenRouter "reserves the right to expire unused credits one year after purchase" — [OpenRouter FAQ](https://openrouter.ai/docs/faq)
- Sacra describes monetization as a flat ~5% take rate on inference spend — [Sacra](https://sacra.com/c/openrouter/)

**App attribution and rankings**

- `HTTP-Referer` (required) is "used as the primary identifier for rankings." Without it no app page is created. `X-OpenRouter-Title` sets the display name (legacy `X-Title` still works). `X-OpenRouter-Categories` assigns marketplace categories: max 2 per request, 10 per app, from a fixed list (e.g. `cli-agent`, `ide-extension`, `cloud-agent`, `roleplay`, `image-gen`) — [OpenRouter App Attribution](https://openrouter.ai/docs/app-attribution)
- Benefits to apps: placement in public rankings (daily/weekly/monthly), an "Apps" tab on each model page, and public analytics at `openrouter.ai/apps?url=<app>`. `X-OpenRouter-App-Visibility: hidden` opts an app out of public listings — [OpenRouter App Attribution](https://openrouter.ai/docs/app-attribution)
- Public usage data became a research/PR asset: "State of AI: An Empirical 100 Trillion Token Study with OpenRouter" (a16z + OpenRouter, Dec 2025, arXiv 2601.10088). Findings: open-weight models ~1/3 of tokens; Chinese OSS models went from ~1.2% to peaks near 30% of weekly share in 2025; roleplay >50% of OSS usage, programming ~15-20% — [a16z](https://www.a16z.com/state-of-ai), [OpenRouter PDF](https://openrouter.ai/assets/State-of-AI.pdf), [cryptobriefing](https://cryptobriefing.com/openrouter-100-trillion-token-study/)
- The study uses metadata only (model/provider IDs, tokens, timing, geography), not prompt content — [themoonlight review](https://www.themoonlight.io/de/review/state-of-ai-an-empirical-100-trillion-token-study-with-openrouter)

**Provider routing and fallback**

- Default routing is price-prioritized: (1) providers with no significant outage in the last 30s first; (2) among those, cheapest picked by **inverse-square-of-price** weighting (a $1 provider is chosen ~9x as often as a $3 one); (3) the rest are fallbacks — [OpenRouter Provider Selection](https://openrouter.ai/docs/guides/routing/provider-selection)
- `allow_fallbacks` defaults to true. `sort` (`price`/`throughput`/`latency`) turns off load balancing and tries providers in order. Shortcuts: `:nitro` (throughput sort, priority tier) and `:floor` (price sort, flex tier). `data_collection: "deny"` and `zdr` filter providers. `max_price` caps $/M tokens — [OpenRouter Provider Selection](https://openrouter.ai/docs/guides/routing/provider-selection)
- On provider error OpenRouter falls back to the next provider transparently, and pooled uptime gives better availability at direct pricing — [OpenRouter FAQ](https://openrouter.ai/docs/faq)

**Tool resale inside OpenRouter (directly relevant to Zevium)**

- OpenRouter's web plugin resells data APIs on OpenRouter credits. It uses native provider search where available, otherwise **Exa** ($7/1k default; $12 Deep; $15 Deep Reasoning; +$1/1k results over 10). It also offers Parallel ($1/1k Turbo/Fast; $5/1k Basic/Advanced), Perplexity ($0.005/req), and Firecrawl (BYOK only, no OpenRouter charge) — [OpenRouter Web Search](https://openrouter.ai/docs/guides/features/plugins/web-search)

**Traction, funding, exit**

- $40M Series A at ~$547M (2025). **$113M Series B led by CapitalG at ~$1.3B post** (May 26, 2026); NVentures plus ServiceNow, MongoDB, Snowflake and Databricks venture arms participated — [Shopifreaks](https://www.shopifreaks.com/openrouter-raises-113m-series-b-led-by-capitalg-at-1-3b-valuation-more-than-doubling-from-547m-a-year-ago/), [Dealroom](https://dealroom.co/news/129679-openrouter-raises-113m-series-b-hits-1-3b-valuation/)
- May 2026 company claims: 8M users, 400+ models, 25T tokens/week (5x in six months) — [implicator.ai](https://www.implicator.ai/stripe-openrouter-7-billion-agreement/)
- Sacra revenue estimates: ~$19M annualized end-2025 → ~$50M Mar 2026 → **~$140M Jul 2026**, growing 29% MoM over four months. ~250T tokens/month; Chinese OSS models now 50%+ of usage; per-token monetization down ~60% as cheaper models take share — [Sacra (Aug 12, 2026)](https://sacra.com/research/openrouter-growing-29-mom-at-140m-year). The two Sacra estimates diverge with no explanation given — [implicator.ai](https://www.implicator.ai/stripe-openrouter-7-billion-agreement/)
- **Stripe is acquiring OpenRouter** (signed and announced ~Aug 19, 2026; Stripe's largest acquisition). NYT reports ~$7.5B, Bloomberg ">$7B". WSJ had reported talks near $10B in July. Stripe had been OpenRouter's payments provider since at least Jan 2026 — [The Stack](https://www.thestack.technology/stripe-acquires-openrouter-setting-up-a-battle-for-ai-routing-business/), [implicator.ai](https://www.implicator.ai/stripe-openrouter-7-billion-agreement/), [Dealroom](https://app.dealroom.co/news/note/stripe-agrees-to-acquire-openrouter)
- Stripe also bought Metronome (usage billing) for ~$1B — [Sacra](https://sacra.com/research/openrouter-growing-29-mom-at-140m-year)

### Inferences

- A thin ~5% take on prepaid credits, with zero markup on the underlying unit price, reached ~$140M ARR. That validates Zevium's 5% model, but only at huge GMV (~$2.8B GMV implied at 5%; this is my arithmetic, not a sourced figure).
- Credit-purchase fees are collected up front and are non-refundable, so revenue lands before usage. Zevium could charge its 5% on top-up rather than on the publisher split, or both. A choice to make.
- Price compression (per-token revenue down ~60%) shows an aggregator's revenue tracks the cheapest supply. Zevium faces the same pressure if cheap API clones list.

### Gaps

- No primary-source GMV figure (only a Sacra report title, "OpenRouter at $100M GMV").
- Post-acquisition fee/neutrality changes under Stripe not found (The Stack article is paywalled).
- Not found: exact closing status of the Stripe deal, and whether OpenRouter rankings drive measurable signups.

## Q2. Other routers/gateways: fee models and positioning

### Takeaway

The field split three ways. (1) Hyperscaler/platform gateways at 0-5%, used as loss-leaders: Vercel 0%, Cloudflare 5% on credits. (2) Neutral marketplaces at ~5% (OpenRouter, Requesty). (3) Enterprise control planes that monetize governance, not tokens (Portkey, LiteLLM). Smart-routing pure plays (Martian, Not Diamond) stayed small.

### Cited Findings

- **Vercel AI Gateway**: "no markup and no platform fee on tokens" at provider list price; BYOK carries no fee (paid tier); free tier includes $5/month credit — [Vercel docs](https://vercel.com/docs/ai-gateway/usage-and-pricing), [Vercel FAQ](https://vercel.com/docs/ai-gateway/faq). GA with pay-as-you-go + BYOK reportedly Sep 2025 (third-party, unconfirmed) — [dsebastien notes](https://notes.dsebastien.net/30+Areas/33+Permanent+notes/33.02+Content/Vercel+AI+Gateway). Third parties report a payment-processing fee on credit purchases and $0.10/1k requests for team-wide ZDR (unverified) — [rywalker](https://rywalker.com/research/vercel-ai-gateway)
- **Cloudflare AI Gateway Unified Billing**: **5% fee on credit purchases** ($100 credit = $105 charge); provider inference passed through with no markup; auto top-up; balance can go negative and the card on file is charged — [Cloudflare docs](https://developers.cloudflare.com/ai-gateway/features/unified-billing/), [Cloudflare pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing). Workers AI and AI Gateway merged behind one control plane in 2026 — [runtimewire](https://runtimewire.com/article/cloudflare-unifies-workers-ai-ai-gateway-control-plane)
- Cloudflare announced its acquisition of Replicate (50k+ models) on Nov 17, 2025 — [SiliconANGLE](https://siliconangle.com/2025/11/17/cloudflare-acquires-ai-deployment-startup-replicate/)
- **Portkey**: $15M Series A (Elevation Capital, Lightspeed), Feb 19, 2026. Claims 500B tokens/day, 125M requests/day, >$500k AI spend managed daily, 24k+ orgs. Made its core enterprise gateway free; roadmap is agent governance (permissions, identity, budget guardrails) — [VCA Online](https://www.vcaonline.com/news/2026021904/portkey-raises-15m-series-a-to-scale-the-unified-control-plane-for-production-ai/), [Pulse 2.0](https://pulse2.com/portkey-15-million-raised-for-unified-control-plane-for-production-ai)
- **LiteLLM (BerriAI)**: open-source proxy; only disclosed funding is a ~$1.6M seed (YC et al.) — [CB Insights](https://www.cbinsights.com/company/berriai), [everydev](https://www.everydev.ai/developers/berriai)
- **Requesty**: flat ~5% markup, no subscription (per comparison sites, not the vendor); $10 free credits for new users (vendor blog) — [Respan](https://respan.ai/market-map/compare/openrouter-vs-requesty), [Requesty blog](https://requesty.ai/blog/how-to-route-llm-requests-by-cost-and-latency)
- **Martian**: $9M seed (NEA, General Catalyst, Prosus et al., Nov 2023); Accenture Ventures invested Sep 2024 to embed Martian in Accenture "switchboard" services — [SiliconANGLE](https://siliconangle.com/2023/11/15/martian-debuts-novel-ai-model-mapping-technology-apps-leverage-multiple-llms/), [Accenture](https://newsroom.accenture.com/news/2024/accenture-invests-in-martian-to-bring-dynamic-routing-of-large-language-queries-and-more-effective-ai-systems-to-clients)
- **Not Diamond**: $2.3M total, last round July 2024; investors include Jeff Dean — [vcbacked](https://www.vcbacked.co/company/not-diamond)
- Sacra names the competitive categories as Vercel (public gateways), Kong (enterprise gateways), and in-house model routing at Cursor, Databricks and Ramp — [Sacra](https://sacra.com/research/openrouter-growing-29-mom-at-140m-year)

### Inferences

- Platform gateways (Vercel 0%, Cloudflare 5%) cap what a pure aggregator can charge. Zevium's 5% matches market norms. Going above ~5-10% invites a 0%-fee platform competitor.
- "Smart routing" as a standalone product (Martian, Not Diamond) didn't scale. Value accrued to the aggregator with supply plus billing, not to routing IQ.
- Zevium runs on Cloudflare Workers. Cloudflare already has the billing primitive (credits + 5%) and could extend it from LLMs to arbitrary APIs. That is platform risk.

### Gaps

- Requesty funding not found. LiteLLM 2026 funding/security news found only in unverified aggregators. Vercel's credit-processing fee not confirmed on a primary page.

## Q3. What made routers win

### Takeaway

They won on one OpenAI-compatible API shape, one key and one prepaid balance, list-price transparency with no markup on units, automatic fallback/uptime pooling, and public usage leaderboards that turned consumer apps into a marketing channel. The leaderboard is the distinctive growth loop.

### Cited Findings

- One API, pooled uptime and automatic fallback at "direct pricing" are the core pitch — [OpenRouter FAQ](https://openrouter.ai/docs/faq)
- Inference passed through at provider price; the fee sits on credit purchase, so unit prices are transparent — [OpenRouter FAQ](https://openrouter.ai/docs/faq), [Vercel](https://vercel.com/docs/ai-gateway/usage-and-pricing), [Cloudflare](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)
- Public rankings and per-model "Apps" tabs reward apps for self-identifying via headers (free distribution for apps, demand signal for model providers) — [OpenRouter App Attribution](https://openrouter.ai/docs/app-attribution)
- Usage-data reports became earned media (a16z State of AI, 100T tokens) — [a16z](https://www.a16z.com/state-of-ai)
- The model catalog's long tail (Chinese OSS models at 50%+ of usage, from ~2% in mid-2025) drove growth that first-party APIs can't capture — [Sacra](https://sacra.com/research/openrouter-growing-29-mom-at-140m-year)
- "Neutrality among competing models" is described as OpenRouter's main selling point; OpenRouter: "OpenRouter exists to give users every model on equal footing" — [implicator.ai](https://www.implicator.ai/stripe-openrouter-7-billion-agreement/), [The Stack](https://www.thestack.technology/stripe-acquires-openrouter-setting-up-a-battle-for-ai-routing-business/)

### Inferences

- LLMs are near-substitutes with one schema, so a unified API is natural. Data APIs are heterogeneous: Exa search ≠ Firecrawl scrape ≠ Browserbase session. Zevium's equivalent of "one schema" is per-category normalized shapes (e.g. a generic `search`, `scrape`, `browser` contract), with OpenAPI as a fallback for the long tail.
- Routers grew where users wanted many substitutable suppliers. Zevium wins in categories with several competing suppliers (search, scraping, SERP, enrichment), not unique APIs.

### Gaps

- No quantitative attribution of OpenRouter growth to rankings vs. other channels was found.

## Q4. Agent-native data/tool APIs: per-call pricing, free tiers, credit models, funding

### Takeaway

Agent search has converged on **$1-$16 per 1,000 calls**: Parallel $1-5, Exa $4-7, Brave $5, Perplexity $5, Tavily $8-16. Scraping costs ~$1/1k pages (Firecrawl ~1 credit/page). SERP is pricier ($9-25/1k at low tiers). Built-in model search tools (OpenAI, Anthropic) cost $10/1k, Google $14/1k. Almost all use prepaid credits with a monthly free allowance. Several pure-plays raised at $2B+ in 2026.

### Cited Findings

**Exa**

- Search $4/1k (`instant`), $7/1k (`fast`/`auto`); Deep $12, Deep-Reasoning $15; Contents $1/1k pages per content type; Answer $5/1k; Monitors $15/1k; +$1/1k results over 10; Agent $0.012-$1.00/request. $10 free monthly (resets) plus a one-time $10 onboarding bonus, no card needed. Prepaid credits, no minimum; enterprise can be postpaid — [Exa pricing](https://exa.ai/docs/reference/pricing)
- Base search price rose from $5 to $7/1k in the Mar 2026 pricing update — [Exa changelog](https://exa.ai/docs/changelog/pricing-update), [usagepricing](https://usagepricing.com/blueprint/activity/exa-ai-2026-04-price-change)
- $250M Series C at $2.2B led by a16z (May 2026); prior round $85M at $700M (fall 2025); ~$357M raised in total — [Bloomberg Gov](https://news.bgov.com/antitrust/andreessen-backed-ai-search-startup-exa-valued-at-2-2-billion), [Pulse 2.0](https://pulse2.com/exa-250-million-series-c/)
- Hosted MCP at `https://mcp.exa.ai/mcp`, with setup docs for Claude Desktop, Cursor, VS Code and 10+ assistants — [Exa MCP docs](https://exa.ai/docs/reference/exa-mcp.md)

**Parallel Web Systems**

- Search $1/1k (turbo/fast), $5/1k (basic/advanced); Extract $1/1k URLs; Task $5-$2,400 per 1k runs across 9 tiers (lite→ultra8x); Monitor $3-10/1k; FindAll is priced per run plus per match — [Parallel pricing](https://docs.parallel.ai/getting-started/pricing)
- $100M Series B at $2B led by Sequoia (Apr 29, 2026), five months after a $100M Series A at $740M (Nov 2025); $230M raised in total; 100k+ developers; customers include Clay, Harvey, Notion, Opendoor — [TechCrunch](https://techcrunch.com/2026/04/29/parallel-web-systems-hits-2b-valuation-five-months-after-its-last-big-raise/)

**Tavily** (now Nebius)

- 1,000 free credits/month, no card; PAYG $0.008/credit; plans run from $30/4k credits to $500/100k ($0.005/credit); credits reset monthly — [Tavily docs](https://docs.tavily.com/guides/api-credits), [Tavily help](https://help.tavily.com/articles/8816424538-pricing). Basic search = 1 credit ($8/1k), advanced = 2 ($16/1k) — [Digital Applied (Oct 2026)](https://www.digitalapplied.com/blog/web-search-apis-for-ai-agents-compared-2026)

**Brave Search API**

- $5/1k (Search, 50 QPS); Answers $4/1k plus $5/M tokens. The old no-card free tier (2k/month) was retired in early 2026 and replaced by $5 monthly credit; card required. Third-party sources only, with conflicting dates — [costbench](https://costbench.com/software/ai-search-apis/brave-search-api/), [Firecrawl blog](https://www.firecrawl.dev/blog/brave-search-api-alternatives), [Digital Applied](https://www.digitalapplied.com/blog/web-search-apis-for-ai-agents-compared-2026)
- Tailwind: Microsoft retired the Bing Search APIs on Aug 11, 2025 and pushed users to "Grounding with Bing" inside Azure AI Agents, which doesn't return raw results — [Microsoft Learn](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement), [The Register](https://www.theregister.com/2025/05/15/bing_search_apis_retired/)

**Perplexity Sonar / Search API**

- Search API ~$5/1k ($1 Fast), no token cost — [Digital Applied](https://www.digitalapplied.com/blog/web-search-apis-for-ai-agents-compared-2026). Sonar charges a request fee of $5/$8/$12 per 1k by context size (Sonar Pro $6/$10/$14) plus tokens. Third-party sources; reportedly Sonar Chat Completions is deprecated with support until Sep 27, 2026, and Perplexity points new builds at an Agent API — [Puter](https://developer.puter.com/tutorials/perplexity-api-pricing/), [CloudZero](https://www.cloudzero.com/blog/perplexity-api-pricing/)

**Built-in model search (the incumbent "default")**

- Anthropic web search: $10/1k plus tokens; failed searches not billed — [Anthropic pricing](https://docs.anthropic.com/it/docs/about-claude/pricing). Brave was presumed to be the backend at launch; Anthropic hasn't confirmed this — [Simon Willison (May 2025)](https://simonwillison.net/2025/May/7/anthropic-api-search)
- OpenAI web_search $10/1k; Google grounding (Gemini 3.x) $14/1k with 5k/month free; Gemini 2.5 grounding $35/1k prompts — [Digital Applied (prices read Oct 3, 2026)](https://www.digitalapplied.com/blog/web-search-apis-for-ai-agents-compared-2026)
- Linkup: $5-6/1k, 4k free queries; also sold through Cloudflare at $5 — [Digital Applied](https://www.digitalapplied.com/blog/web-search-apis-for-ai-agents-compared-2026)

**Firecrawl**

- Free 1k credits/month (no card); Hobby $16/mo (annual) for 5k credits; Standard $83 for 100k; Growth $333 for 500k; Scale $599 for 1M. Scrape/crawl/map = 1 credit/page; search = 2 credits per 10 results; browser "Interact" = 2 credits/min; JSON extraction +4 credits/page. PAYG top-ups only on paid plans ($5 increments). Failed scrapes free; 403/404 billed — [Firecrawl pricing](https://www.firecrawl.dev/pricing)
- $75M Series B led by Smash Capital (Sep 2026), tied to "Alexandria", a knowledge library for agents. An SEC filing suggests up to $82M — [Dealroom](https://dealroom.co/news/155341-firecrawl-raises-75m-series-b-to-build-a-knowledge-library-for-ai-agents/), [runtimewire](https://runtimewire.com/article/scoop-firecrawl-raises-82m-after-its-14-5m-series-a-warm-up)

**Browserbase / Hyperbrowser / Steel (browser infra)**

- Browserbase: Free (1 browser-hr; 1k Search + 1k Fetch calls); Developer $20/mo (100 hrs, ~$0.12/hr overage); Startup $99 (500 hrs, ~$0.10/hr); proxies ~$10-12/GB; Search overage $7/1k; Fetch $1/1k. Third-party sources only — [tinyfish](https://www.tinyfish.ai/blog/browserbase-pricing), [scrapegraphai](https://scrapegraphai.com/blog/browserbase-pricing)
- Browserbase: $40M Series B at $300M (Notable Capital, June 2025); ~$67.5M raised in total; no 2026 round found; headcount 61→80 by Jun 30, 2026 — [Sacra](https://sacra.com/c/browserbase), [Caplight](https://www.caplight.com/company/browserbase)
- Hyperbrowser: Free / $30 Startup (30k credits, 25 concurrent) / $100 Scale. Steel: $29-$499/mo credit plans, no free tier. Third-party; no reliable funding data — [costbench Hyperbrowser](https://costbench.com/software/browser-automation/hyperbrowser/), [costbench Steel](https://costbench.com/software/browser-automation/steel-dev/)

**SerpAPI**

- Free 250/mo; Starter $25/1k searches (2.5¢); Developer $75/5k; Production $150/15k; Big Data $275/30k (~0.92¢); Enterprise from $3,750/mo. No PAYG; overage triggers "Automatic Early Renewal" at full plan price — [scrapegraphai](https://scrapegraphai.com/blog/serpapi-pricing), [apiserpent](https://apiserpent.com/blog/serpapi-pricing-explained)
- Legal: Google's DMCA suit against SerpApi was dismissed Jul 20, 2026 (Judge Gonzalez Rogers, N.D. Cal.) with leave to amend. Plain search results were held not copyrightable. A separate Reddit suit vs. SerpApi is proceeding in SDNY — [MediaPost](https://www.mediapost.com/publications/article/416687/judge-dismisses-google-complaint-against-serpapi-o.html), [Gigazine](https://www.gigazine.net/gsc_news/en/20260723-google-loses-lawsuit-against-serpapi). Google renewed the fight afterward — [MediaPost](https://www.mediapost.com/publications/article/417185/google-renews-battle-with-serpapi-over-scraping.html)

**Bright Data**

- MCP server: ~5k requests/month free ("Rapid" mode: `search_engine` + `scrape_as_markdown`); the full 60+ scraper toolset needs a paid plan; Web Unlocker ~$3/1k successful responses (Mar 2026 data). Third-party — [agentdeals](https://agentdeals.dev/vendor/bright-data-mcp), [use-apify](https://use-apify.com/blog/bright-data-pricing-guide-2026)

**Jina AI** — see Q6 (acquired by Elastic).

### Inferences

- Unit prices are small ($0.001-$0.016/call). A 5% Zevium cut is $0.00005-$0.0008 per call, so a fixed per-transaction Stripe fee can't be charged per call. Prepaid credits with a fee at top-up (the OpenRouter/Cloudflare model) is the only viable shape. Zevium already does prepay.
- Vendor plans are monthly-subscription-heavy (Firecrawl, SerpAPI, Hyperbrowser, Steel) with no or limited PAYG. Zevium's pure per-call PAYG across vendors is a real consumer benefit for low-volume agent builders. Whether vendors' ToS allow resale is unclear (see Gaps).

### Gaps

- Official pricing pages for Brave, Perplexity, Browserbase, SerpAPI, Bright Data, Hyperbrowser and Steel were not fetched; figures above are third-party.
- No reliable 2026 funding for Steel, Hyperbrowser, SerpAPI or Brave's API business.

## Q5. Distribution: how data APIs get into agent defaults and which already sell via marketplaces/protocols

### Takeaway

Distribution runs through (1) **being the default engine inside an aggregator or model API** (Exa inside OpenRouter's web plugin; Brave presumed behind Claude search), (2) **hosted MCP servers** installable in Claude, Cursor and VS Code, and (3) **agent-payment protocols and marketplaces**. Exa and Firecrawl already sell keyless per-call via x402. Browserbase and Parallel launched on Stripe MPP. Coinbase's Agentic.Market lists 365+ x402 services with no approval process. Apify pays 80% to developers under pay-per-event.

### Cited Findings

- OpenRouter's web plugin falls back to Exa for all non-native models and resells Parallel and Perplexity on OpenRouter credits — [OpenRouter Web Search](https://openrouter.ai/docs/guides/features/plugins/web-search)
- No source confirms Exa as the _default_ search in Cursor or Claude Code. It is installable via hosted MCP — [Exa MCP docs](https://exa.ai/docs/reference/exa-mcp.md)
- **x402**: Exa supports keyless x402 on `/search` and `/contents` (402 response with price → signed USDC payment → retry); sending an API key bypasses x402. Example price $0.007 USDC/request on Base — [Exa x402 guide](https://exa.ai/docs/reference/x402-guide), [Coinbase launch](https://www.coinbase.com/pt-pt/developer-platform/discover/launches/exa)
- Firecrawl has had an x402 search+scrape endpoint since Aug 2025 ("no API keys or prepaid credits") — [Coinbase case study](https://www.coinbase.com/developer-platform/discover/case-studies/firecrawl). Its pricing page doesn't mention x402 — [Firecrawl pricing](https://www.firecrawl.dev/pricing)
- **Coinbase Agentic.Market** (Apr 20, 2026): consumer-facing view of the x402 Bazaar index; 365+ services in 7 categories (Inference, Data, Media, Search, Social, Infra, Trading); launch roster included OpenAI, Venice, Bloomberg, CoinGecko, AWS Lambda, QuickNode, Alchemy. **No approval process**; sellers self-list with usage-based pricing; average call settles under $0.31; no stated marketplace fee (Coinbase earns on rails/wallet) — [BlockEden](https://blockeden.xyz/blog/2026/04/22/coinbase-agentic-market-launch-x402-165m-transactions-base-agent-commerce/)
- x402 volume claims vs. reality: Coinbase claims 160M+ agentic payments in a year. TRM Labs found ~198.9M settlements (~$52.7M) since May 2025, of which only **0.6-7.5% by amount** came from AI agents; scripts and self-trading inflate the counts. Daily transactions fell ~92% from Dec 2025 (~731k) to Mar 2026 (~57k), per OKX Ventures — [KuCoin](https://www.kucoin.com/news/flash/coinbase-processes-1t-in-stablecoin-payments-annually-x402-hits-160m-transactions), [BlockEden](https://blockeden.xyz/blog/2026/04/22/coinbase-agentic-market-launch-x402-165m-transactions-base-agent-commerce/)
- x402 Foundation launched under the Linux Foundation (Apr 2026) with Google, Microsoft, AWS, Visa, Mastercard; Stripe added x402 support (Feb 2026); Amazon launched AgentCore Payments (May 2026) with Coinbase + Stripe. Secondary summary of search results; not individually verified — [KuCoin](https://www.kucoin.com/news/flash/coinbase-processes-1t-in-stablecoin-payments-annually-x402-hits-160m-transactions)
- **Stripe + Tempo Machine Payments Protocol (MPP)**, Mar 18, 2026: 402-challenge → credential → receipt; settles into the normal Stripe balance; cards/BNPL via Shared Payment Tokens plus stablecoins. Launch examples: **Browserbase** (agents pay per browser session) and **Parallel** (pay per API call) — [Stripe blog](https://stripe.com/it/blog/machine-payments-protocol), [Zuplo](https://zuplo.com/blog/stripe-mpp-for-agentic-payments). Reported 100+ services in the MPP directory at launch (secondary) — [Techstrong](https://techstrong.ai/features/stripes-machine-payments-protocol-gives-ai-agents-a-way-to-spend-money-without-human-help/)
- **Apify Store**: pay-per-event (PPE) gives developers **80%** of event revenue minus platform costs (20% commission); PPE is "fully compatible" with MCP and gets priority store placement; rentals retired (no new ones after Apr 1, 2026; fully gone Oct 1, 2026) — [Apify PPE docs](https://docs.apify.com/actors/publishing/monetize/pay-per-event.md), [Apify MCP developers](https://apify.com/mcp/developers)
- Linkup is resold via Cloudflare at $5/1k — [Digital Applied](https://www.digitalapplied.com/blog/web-search-apis-for-ai-agents-compared-2026)

### Inferences

- Top data APIs already have three non-Zevium agent-payment channels: their own MCP + key, x402, and MPP. They need Zevium only if it brings demand. The OpenRouter lesson: supply lists where agent builders already hold a balance.
- Agentic.Market's no-approval model has pricing in the listing but weak curation, and TRM data suggests little real agent demand. Zevium could differentiate on curated, spec-verified listings with fiat prepaid credits (orgs, invoices, refunds), not crypto.
- Apify's 80/20 split sets the benchmark publishers will compare against. Zevium's 95/5 is far more generous; lead with it.

### Gaps

- No marketplace fee found for Agentic.Market/Bazaar. No Bazaar-specific volume.
- Not found whether Tavily, Brave or Perplexity accept x402/MPP.
- Not found whether vendor ToS (Exa, Tavily, Brave) permit third-party resale through a marketplace. OpenRouter's reselling of Exa/Parallel/Perplexity shows such deals exist, but terms are private.

## Q6. Consolidation and acquisitions, 2025-2026

### Takeaway

Big consolidation wave. Search/data APIs are being absorbed by clouds (Nebius←Tavily, Elastic←Jina, Cloudflare←Replicate), and the leading router went to the leading payments company (Stripe←OpenRouter, ~$7.5B). Independents raised at $2B+ (Exa, Parallel). The agent-commerce layer is being claimed by payment rails, not by marketplaces.

### Cited Findings

- **Stripe ← OpenRouter**, announced ~Aug 19, 2026, ~$7.5B (NYT), Stripe's largest-ever deal — [The Stack](https://www.thestack.technology/stripe-acquires-openrouter-setting-up-a-battle-for-ai-routing-business/), [Outlook Business](https://www.outlookbusiness.com/deeptech/stripe-eyes-bigger-ai-push-with-usd-7-bn-plus-openrouter-deal)
- **Stripe ← Metronome** (~$1B, usage billing) — [Sacra](https://sacra.com/research/openrouter-growing-29-mom-at-140m-year)
- **Nebius ← Tavily**, announced Feb 10, 2026. Reported $275M upfront, up to $400M with earnout (Calcalist via secondary). The earnout is tied to ARR milestones in Dec 2026 and Mar 2027; the deal closed by Q2 2026. Tavily is being folded into Nebius AI cloud next to Token Factory — [Nebius 6-K (SEC)](https://www.sec.gov/Archives/edgar/data/0001513845/000110465926094844/nbis-20260812xex99d2.htm), [The Middle Market](https://www.themiddlemarket.com/?p=93534)
- **Elastic ← Jina AI** (completed, announced Oct 9, 2025; terms undisclosed). Jina models continue on Hugging Face and the Elastic Inference Service — [Business Wire](https://www.businesswire.com/news/home/20251009619654/en/Elastic-Completes-Acquisition-of-Jina-AI-a-Leader-in-Frontier-Models-for-Multimodal-and-Multilingual-Search)
- **Cloudflare ← Replicate** (announced Nov 17, 2025) — [SiliconANGLE](https://siliconangle.com/2025/11/17/cloudflare-acquires-ai-deployment-startup-replicate/)
- **Microsoft killed the Bing Search APIs** (Aug 11, 2025), pulling a major raw-search supplier off the market — [Microsoft Learn](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement)
- Mega-rounds: Exa $250M at $2.2B (May 2026); Parallel $100M at $2B (Apr 2026); Firecrawl $75M Series B (Sep 2026); OpenRouter $113M at $1.3B (May 2026, pre-exit); Portkey $15M (Feb 2026) — sources in Q1/Q2/Q4

### Inferences

- Stripe now owns the leading LLM router plus usage billing (Metronome) plus an agent-payment protocol (MPP). It is the most likely party to build "OpenRouter for APIs". This is the biggest strategic threat to Zevium. It is also a possible exit path or partnership if Zevium builds the API-catalog layer Stripe lacks.
- Clouds are buying search to bundle with inference (Nebius, Elastic, Cloudflare). Independent data APIs face pressure to get distribution, which favors neutral marketplaces as a channel.

### Gaps

- Exact Stripe-OpenRouter close date and post-deal pricing not confirmed. Price for Elastic-Jina not disclosed.

## Q7. Would agent data APIs list on Zevium or compete? Steal-worthy ideas

### Takeaway

Big players (Exa, Parallel, Firecrawl, Browserbase) are unlikely to list early. They already have their own MCP, x402 and MPP channels and $2B+ war chests, and OpenRouter-style resale deals are negotiated, not self-serve. Long-tail and mid-tier APIs (SERP clones, vertical data, Apify-style tools) are the realistic early supply. Zevium should copy the OpenRouter playbook: prepaid credits with the fee at top-up, no markup on unit price, attribution-fed public leaderboards, fallback across substitutable suppliers, and a data report as PR.

### Cited Findings

- Exa and Parallel are already resold inside OpenRouter's web plugin on OpenRouter credits, so suppliers will accept aggregator distribution on negotiated terms — [OpenRouter Web Search](https://openrouter.ai/docs/guides/features/plugins/web-search)
- Firecrawl is offered on OpenRouter only as BYOK (no resale) — [OpenRouter Web Search](https://openrouter.ai/docs/guides/features/plugins/web-search)
- Exa, Firecrawl (x402) and Browserbase, Parallel (MPP) already sell keyless pay-per-call — [Exa x402](https://exa.ai/docs/reference/x402-guide), [Coinbase/Firecrawl](https://www.coinbase.com/developer-platform/discover/case-studies/firecrawl), [Stripe MPP](https://stripe.com/it/blog/machine-payments-protocol)
- Marketplace splits publishers will compare against: Apify 80/20 — [Apify](https://docs.apify.com/actors/publishing/monetize/pay-per-event.md); OpenRouter/Requesty/Cloudflare ~5% on top of list price — [OpenRouter](https://openrouter.ai/docs/faq), [Cloudflare](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)

### Inferences (steal-worthy ideas, ranked)

1. **Fee on top-up, list price on calls.** Show the publisher's `x-zevium-cost` unmodified and take 5% at credit purchase (OpenRouter 5.5%, Cloudflare 5%). Revenue arrives up front, prices look transparent, and fees are non-refundable. Note: this conflicts with the current "publisher keeps 95%" framing; decide whether the 5% comes off the publisher split or sits on top of consumer top-ups.
2. **App attribution headers → public rankings.** Copy `HTTP-Referer`/`X-Title`/categories: e.g. `X-Zevium-App` plus categories, with per-API "Top apps using this" tabs and daily/weekly leaderboards of APIs by calls and spend, plus a hidden-visibility opt-out. This gives publishers a reason to drive traffic and consumers a reason to self-identify.
3. **Substitutable-supplier routing.** For categories with normalized schemas (web search, scrape, SERP), offer an `auto` endpoint: inverse-square price weighting, skip suppliers with recent outages (30s window), `allow_fallbacks`, `sort=price|latency`, `max_price`. This is Zevium's equivalent of OpenRouter's core value prop. It requires category schemas on top of raw OpenAPI.
4. **BYOK passthrough with a free allowance.** Let consumers bring existing Exa/Firecrawl keys through Zevium (OpenRouter: free up to $25k/mo list price, then 5%). Zevium gets attribution and metering data without needing the supplier to list. Supply can be onboarded before the publisher signs up.
5. **Operator-negotiated "house" listings of the big APIs.** OpenRouter resells Exa/Parallel/Perplexity. Zevium can seed supply by reselling top APIs under platform agreements before self-serve publishers arrive.
6. **Accept MPP/x402 at the edge as a payment method into the org wallet, not as a replacement.** Lets keyless agents pay. The prepaid-credit gate stays the source of truth (Zevium rule: zero balance blocks).
7. **Publish a "State of Agent APIs" usage report** from metadata only (like OpenRouter's a16z 100T-token study) once there's volume. It worked as earned media.
8. **Lead with 95/5 against Apify's 80/20** in publisher acquisition; target SERP/scraping long-tail sellers frustrated by subscription-only plans (SerpAPI has no PAYG; Firecrawl PAYG only on paid plans).
9. **Watch Stripe.** It owns OpenRouter, Metronome and MPP and could launch an API marketplace directly. Position Zevium as complementary (built on Stripe Connect/MPP) to stay partner/acquirer-friendly.

### Gaps

- No direct statements from Exa/Parallel/Firecrawl/Browserbase on listing in third-party API marketplaces.
- No data on what share of their revenue comes via aggregators like OpenRouter.
