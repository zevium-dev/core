# Agent tool marketplaces, MCP registries, and MCP gateways (as of 2026-10-10)

Scope: competitors and analogs for Zevium (OpenAPI-listed APIs, per-operation credit pricing, prepaid org wallets, metered CF Worker gateway, 95/5 publisher split, MCP endpoint with search_apis/get_api_docs/call_api). treg.to excluded (covered elsewhere). Sources are a mix of primary pages (vendor docs, pricing, press releases) and secondary reviews. Secondary-only claims are marked "(secondary)". Claims with no corroboration are marked "(unverified)".

## 1. What each player is, and who it's for

### Takeaway

The field splits into four groups. (a) First-party integration catalogs with managed OAuth for SaaS: Composio, Pipedream Connect, Zapier MCP, Arcade, Klavis, Toolhouse. (b) Registries and directories: the official MCP Registry, Smithery, Glama, mcp.so, Docker MCP Catalog. (c) Client app stores: the Anthropic Connectors Directory and the OpenAI/ChatGPT app directory. (d) Enterprise MCP gateways: Cloudflare MCP Server Portals, Kong, Docker MCP Gateway, Glama Gateway. None of the scaled players is a third-party paid-API marketplace like Zevium. The closest analogs are Apify and small paid-MCP marketplaces.

### Cited Findings

**Composio**

- Agent integration platform covering auth, actions, triggers, code execution, and custom tools across many SaaS apps. Works with MCP, LangChain, Vercel AI SDK, and OpenAI Agents — [PR Newswire, 2025-07-22](https://www.prnewswire.com/news-releases/composio-raises-29m-to-solve-ais-learning-problem-building-skills-that-actually-improve-over-time-302510684.html)
- Tool Router is a unified interface where an agent searches, plans, authenticates, and executes across thousands of tools through meta-tools (search, plus a "workbench" for large results). It powers Rube, Composio's consumer MCP server at rube.app/mcp — [Composio docs](https://docs.composio.dev/tool-router/overview); [Composio blog](<https://composio.dev/blog/introducing-tool-router-(beta)>)
- "Proxy execute" calls an endpoint Composio hasn't wrapped as a tool, while Composio still handles auth — [composio.dev/pricing](https://composio.dev/pricing)

**Smithery**

- Public MCP registry plus hosting. Servers install locally via CLI or run on Smithery infrastructure as managed endpoints, with built-in OAuth — [Towards AI (secondary)](https://pub.towardsai.net/8-best-mcp-marketplaces-to-discover-mcp-servers-fb6cb082efcb)
- Registry API covers publishing (URL or MCPB bundle), Agent Skills, search across tools on all servers, runtime logs, server secrets, custom domains, namespaces, and scoped service tokens for machine-to-machine access — [API Evangelist profile, 2026-05-25](https://github.com/api-evangelist/smithery-ai)
- **Acquired by Arcade.dev, announced 2026-08-05.** Co-founder Anirudh Kamath joined Arcade. No terms disclosed, and smithery.ai still takes signups — [Arcade blog](https://www.arcade.dev/blog/smithery-joins-arcade/); [Forbes, 2026-08-10](https://www.forbes.com/sites/janakirammsv/2026/08/10/arcade-acquires-smithery-to-own-the-agent-tool-supply-chain/)

**Pipedream (Connect + MCP)**

- Developer integration platform. Connect embeds managed auth for your app's end users across 3,000+ APIs and 10,000+ prebuilt tools and triggers. MCP servers are included on all plans — [pipedream.com/pricing](https://pipedream.com/pricing)
- Workday signed a definitive agreement to acquire Pipedream on 2025-11-19, with close expected in Workday's FY2026 Q4 (ending 2026-01-31) — [Workday newsroom](https://newsroom.workday.com/2025-11-19-Workday-Signs-Definitive-Agreement-to-Acquire-Pipedream)

**Zapier MCP**

- Connects AI clients (Claude, ChatGPT, Cursor) to 9,000+ apps and 66,000+ actions through one auth layer, on all plans — [eesel (secondary)](https://www.eesel.ai/blog/zapier-subscription)
- Agents run actions as tool calls with no Zap required. There is also a beta SDK — [zapier.com/pricing/rates](https://zapier.com/pricing/rates)

**Arcade.dev**

- An "authenticated tool-calling platform": delegated OAuth for agents acting on a user's behalf (Gmail, Slack, GitHub, Salesforce), prebuilt toolkits, and an SDK for custom tools — [BusinessWire, 2025-03-18](https://www.businesswire.com/news/home/20250318815130/en/Arcade.dev-Scores-%2412M-to-Solve-the-Biggest-Security-Problem-with-AI-Agents)
- Positions itself as the authorization, execution, and audit layer for enterprise agents. Bought Smithery to pair discovery with governance — [Arcade blog](https://www.arcade.dev/blog/smithery-joins-arcade/)

**Klavis AI**

- YC-backed open-source MCP integration layer. Strata is one MCP server that reveals thousands of tools step by step ("progressive discovery") instead of loading them all at once — [Launch HN, 2025-09-23](https://news.ycombinator.com/item?id=45347914)
- Batch label conflicts across sources: X25 ([YC LinkedIn](https://www.linkedin.com/posts/y-combinator_strata-from-klavis-ai-yc-x25-is-the-one-activity-7375916769183481856--yoD)), P25 ([HN title](https://news.ycombinator.com/item?id=45347914)), S25 ([revuo](https://www.revuo.ai/category/mcp-servers/klavis-ai))

**Toolhouse**

- Tool-execution and agent backend: workers, credits, and pre-integrated scrapers, RAG, and MCP — [dailyaifixs (secondary)](https://dailyaifixs.com/blog/toolhouse-pricing-2026-the-credit-and-worker-catch); [Kanopy Labs (secondary)](https://kanopylabs.com/blog/ai-agent-skills-frameworks-comparison-2026)

**Official MCP Registry** (registry.modelcontextprotocol.io)

- Launched in preview 2025-09-08 as an open catalog and API for public MCP servers. Both the registry and its parent OpenAPI spec are open source, so anyone can run a compatible public or private sub-registry — [MCP blog](https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview)
- Mid-2026 it was still formally "preview", with the API frozen at v0.1 — [Towards AI (secondary)](https://pub.towardsai.net/mcp-registries-in-mid-2026-one-upstream-won-2ce541b92036)
- Requires domain-ownership proof (DNS or .well-known). The Anthropic Directory does not — [claude.com docs](https://claude.com/docs/connectors/directory)

**Glama**

- Registry, inspector, and gateway. Claims to be "a superset of the official MCP Registry" in which every server is "maintainer-verified, continuously rebuilt, and scored for quality and safety" — [glama.ai](https://glama.ai)
- The gateway is a reverse proxy that logs every call, gates each tool, and stores OAuth credentials encrypted. It fronts both Glama-hosted servers and external endpoints — [glama.ai/mcp/gateway](https://glama.ai/mcp/gateway); [Glama FAQ](https://glama.ai/mcp/faq)

**mcp.so**

- High-volume, community-submitted free directory. Lighter detail per server than curated directories — [CallSphere (secondary)](https://callsphere.ai/blog/vw4g-mcp-registry-catalogs-smithery-mcp-so-comparison-2026); [Reddit r/mcp](https://www.reddit.com/r/mcp/comments/1tm7duq/i_built_the_largest_free_directory_of_mcp_servers)

**Docker MCP Catalog / Toolkit / Gateway**

- Curated catalog of verified MCP servers packaged as container images with versioning, provenance, and security updates. The Toolkit is the Docker Desktop GUI. The open-source MCP Gateway (the `docker mcp` CLI plugin) unifies servers into one endpoint — [Docker docs](https://docs.docker.com/ai/mcp-catalog-and-toolkit/catalog/); [GitHub docker/mcp-gateway](https://github.com/docker/mcp-gateway)
- "MCP Gateway as part of Docker AI Governance is an invite-only feature" — [Docker docs](https://docs.docker.com/ai/mcp-catalog-and-toolkit)

**Cloudflare MCP Server Portals**

- Part of Cloudflare One (SASE). Puts many MCP servers behind one HTTP endpoint behind Cloudflare Access, with per-portal curated tools and prompts. Open beta since 2025-08-26 — [CF changelog](https://developers.cloudflare.com/changelog/post/2025-08-26-mcp-server-portals); [CF blog](https://blog.cloudflare.com/zero-trust-mcp-server-portals)
- Supports stateless MCP `2026-07-28` and earlier Streamable HTTP versions — [CF docs](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals)

**Anthropic Claude Connectors Directory**

- One catalog of MCP connectors that serves claude.ai, Desktop, Mobile, Claude Code, and Cowork. Entries carry Verified or Community labels, and "Verification isn't a security audit" — [claude.com/docs/connectors/directory](https://claude.com/docs/connectors/directory)

**OpenAI ChatGPT apps directory**

- Apps SDK, built on MCP, announced at DevDay in Oct 2025 — [OpenAI](https://openai.com/index/introducing-apps-in-chatgpt)
- App submissions and the in-ChatGPT directory opened 2025-12-17 — [OpenAI](https://openai.com/index/developers-can-now-submit-apps-to-chatgpt)

**Kong**

- Kong MCP Registry inside the Konnect Catalog, announced 2026-02-02: an enterprise directory to register, discover, and govern MCP servers. Claims AAIF compliance — [PR Newswire](https://www.prnewswire.com/news-releases/kong-introduces-mcp-registry-in-kong-konnect-to-power-ai-connectivity-for-agent-discovery-and-governance-302676451.html)
- Kong Gateway 3.12 converts existing REST APIs into MCP servers "with a single plugin" — [Kong YouTube, 2026-04-17](https://www.youtube.com/watch?v=CyHgTvy3rPM&vl=en)

**Notable others**

- **Apify**: Actor marketplace that also hosts MCP servers. Developers monetize each tool call via pay-per-event — [apify.com/mcp/developers](https://apify.com/mcp/developers); [Apify SDK docs](https://docs.apify.com/sdk/python/docs/guides/mcp-servers)
- **Coinbase x402 Bazaar**: discovery catalog for paid x402 endpoints, reachable over MCP through `search_resources` and `proxy_tool_call`. No API key needed to search — [Coinbase CDP docs](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/bazaar-mcp-server); [CDP MCP payments](https://docs.cdp.coinbase.com/x402/buyer/mcp-payments)
- **Stripe Machine Payments Protocol (MPP)**: launched 2026-03-18 with Tempo. Session-based streaming payments on fiat rails — [WorkOS (secondary)](https://workos.com/blog/x402-vs-stripe-mpp-how-to-choose-payment-infrastructure-for-ai-agents-and-mcp-tools-in-2026); [Stripe Sessions 2026](https://stripe.com/th/sessions/2026/machine-payments-and-the)
- **Manufact** (the team behind the mcp-use SDK for MCP Apps): YC S25, raised a $6.3M seed — [YC job post](https://www.ycombinator.com/companies/manufact/jobs/4cyWd6S-developer-advocate-partnerships-devrel); [Fundable](https://www.tryfundable.ai/company/manufact)
- **Small paid-MCP marketplaces**: MCPize, MCP Marketplace (mcp-marketplace.io), MCP Hive, Agent Bazaar — see Section 2.
- **Other enterprise MCP gateways**: Permit.io MCP Gateway ([pricing](https://www.permit.io/mcp-gateway/pricing)), Portkey, TrueFoundry ([Kosmoy (secondary)](https://www.kosmoy.com/resources/blog/portkey-vs-kong-ai-gateway); [TrueFoundry](https://www.truefoundry.com/blog/arcade-vs-truefoundry))

### Inferences

- Groups (a) and (c) are Zevium's real substitutes for consumer attention. Group (b) is a distribution channel, not a competitor. Group (d) handles enterprise governance and doesn't overlap with a public paid marketplace.
- Zevium's distinct position is a two-sided market for third-party paid APIs with a billing layer. The SaaS-connector players (Composio, Pipedream, Zapier, Arcade) wrap free-to-call SaaS APIs on behalf of end users. They don't onboard paid API vendors.

### Gaps

- Gravitee MCP gateway: not researched within the tool budget.
- PulseMCP: only mentioned in passing, as a registry backer and as a curated catalog.

## 2. Business model, pricing, take rate, and publisher payouts

### Takeaway

Almost every scaled player charges consumers (per call, per task, per auth event, per external user, or per seat). **None documents a revenue share for third-party tool authors**: not Composio, Smithery, Glama, mcp.so, the official registry, Docker, Anthropic, or OpenAI. Paying marketplaces exist but are small (MCPize 80-85%, MCP Marketplace 85%, Agent Bazaar 82%) or crypto-native (x402). The one scaled payer is Apify, which pays out more than $500K/month. Zevium's 95% share is the highest documented split.

### Cited Findings

**Composio**

- New pricing applies to signups on or after 2026-08-15. Existing customers keep their plan through 2026-12-31. Premium tool calls are billed for all customers from 2026-09-10. Hobby is hard-capped, and Pro supports per-meter spend caps — [composio.dev/pricing](https://composio.dev/pricing)
- Add-on meters: sandbox execution (10K/mo free, then +$0.0001 per call), HIPAA BAA (+$0.0003 per call), IP allowlist (+$0.0001 per call) — [composio.dev/pricing](https://composio.dev/pricing)
- Tier figures conflict between secondary sources:
  - One says Free is 20K calls, $29 is 50K (previously 200K), the $229 tier was replaced by a $599 tier with the same 50K, and overage rose from $0.25-0.30 per 1K to $4 per 1K ($3 via Sessions). Triggers, LLM tokens, premium tools, sandbox, and storage are now metered separately — [Scalekit (secondary)](https://www.scalekit.com/blog/composio-pricing-change)
  - Another says Free is 100K calls plus 50K trigger events, Pro is $29 with a usage credit, overage is $0.0003 per call, and trigger overage is $0.003 per event (as of Aug 2026) — [CapSolver (secondary)](https://www.capsolver.com/blog/ai/composio-review)
- Composio pays no third-party tool authors. A third party, "Agent Bazaar", filed a GitHub issue (2026-03-04) proposing per-call billing for Composio tool providers with an 82% Stripe Connect revenue share. It was labeled stale — [GitHub #2818](https://github.com/ComposioHQ/composio/issues/2818)

**Smithery**

- Priced in RPCs (one JSON-RPC request each):
  - Hobby: free, 50K RPCs/mo, 3 namespaces, managed OAuth
  - Pay as You Go: flat fee, 100K RPCs, 100 namespaces
  - Custom: SLA and custom rate limits
  - Publishing is free — [AgentAya (secondary)](https://agentaya.com/ai-review/smithery)
- Creator monetization: conflicting. Some listings cite an 80% split, while a 2026 review says there is "no creator monetization" — [SEOSiri (secondary), 2026-09-13](https://www.seosiri.com/2026/09/mcp-monetization-gap-glama-smithery-developer-losses.html)

**Pipedream Connect**

- Free: development only.
- Startup: $99/mo billed annually or $150/mo billed monthly. Includes 100 external users (then $2 per user) and 10,000 credits (then $0.012 each).
- 1 credit = 30 seconds of compute, covering actions, MCP tool calls, proxy requests, and triggers. Management calls are free.
- An external user is anyone who connects at least one account; a user with five connected apps counts once — [pipedream.com/pricing](https://pipedream.com/pricing)

**Zapier MCP**

- "Each MCP tool call uses two tasks from your plan's quota — the same task bucket your Zaps use" — [zapier.com/pricing/rates](https://zapier.com/pricing/rates)
- Failed calls, tool listing, auth, and history cost 0 tasks — [Latenode (secondary)](https://latenode.com/blog/zapier-mcp-pricing)
- Plans: Free has 100 tasks/mo (about 50 calls). Professional is $19.99/mo (annual) for 750 tasks. Team is $69/mo for 2,000 tasks — [Latenode (secondary)](https://latenode.com/blog/zapier-mcp-pricing)

**Arcade.dev**

- Free: 2,000 auth events + 2,000 tool calls per month.
- Team: $25/mo plus $0.10 per auth event and $0.01 per tool call.
- Enterprise: annual bundles; Arcade Cloud, your VPC, or air-gapped; SSO, RBAC, audit logs, and private registry — [arcade.dev/pricing](https://www.arcade.dev/pricing)
- Older pricing (undated blog) made credential provenance a price lever:
  - Pro tool execution: $0.01 with your own credentials, $0.50 with Arcade's
  - $0.05 per scope change
  - Hosted workers: $0.05 per server-hour — [Arcade blog: pricing updates](https://www.arcade.dev/blog/pricing-updates)

**Toolhouse**

- Conflicting sources. One says $0.003 per execution with no subscription — [Kanopy Labs (secondary)](https://kanopylabs.com/blog/ai-agent-skills-frameworks-comparison-2026)
- Another (Aug 2026) says Business is $500/mo for 25K credits and 50 workers, and Business Max is $1,200/mo for 80K credits and 500 workers — [dailyaifixs (secondary)](https://dailyaifixs.com/blog/toolhouse-pricing-2026-the-credit-and-worker-catch)

**Glama**

- Freemium SaaS at $9/$26/$80 per month (bundling AI credits and hosting). Free hosting for open-source maintainers. "No published revenue-share program" — [SEOSiri (secondary)](https://www.seosiri.com/2026/09/mcp-monetization-gap-glama-smithery-developer-losses.html). The glama.ai/pricing page fetched no plan data.

**Free directories and catalogs: no author payouts**

- mcp.so: free to list, no payouts observed.
- Official MCP Registry: no monetization by design.
- Docker MCP Catalog: bundled into Docker pricing, no MCP-specific payouts — [SEOSiri (secondary)](https://www.seosiri.com/2026/09/mcp-monetization-gap-glama-smithery-developer-losses.html)

**Anthropic Connectors Directory**

- The directory doc mentions no monetization or revenue share. Listings are governed by the Anthropic Software Directory Policy and Terms — [claude.com docs](https://claude.com/docs/connectors/directory)

**OpenAI apps**

- "Current approval is limited to plugins for physical goods purchases." External checkout on the developer's own domain is "the recommended and generally available approach." The ChatGPT payment sheet is private beta for select marketplaces. PCI DSS L1 merchants can implement the ACP Delegate Payment endpoint. No OpenAI fee or revenue share is described — [OpenAI Apps SDK monetization docs](https://developers.openai.com/apps-sdk/build/monetization)
- One community-forum reply says apps that monetize digital products or services can't be submitted — [OpenAI community (unverified)](https://community.openai.com/t/chatgpt-app-monetization-apps-sdk/1372343)
- In-chat Instant Checkout reportedly expanded 2026-02-16 and was pulled 2026-03-04. Secondary sources conflict — [Digital Commerce 360](https://www.digitalcommerce360.com/2026/02/16/openai-expands-agentic-commerce-push/)

**Apify**

- Pay-per-event via `Actor.charge('eventName', count=N)`, monthly payouts, no upfront fees. Apify handles payments, taxes, and invoicing. Self-reported: "$500k+ paid to developers every month" and "$1.6M paid out last month" — [apify.com/mcp/developers](https://apify.com/mcp/developers)
- Developers "commonly receive 80%" of eligible revenue. Negative profit (infra cost above revenue) can reduce payouts. Rental listings stopped 2026-04-01 and retire 2026-10-01, leaving pay-per-event as the flagship model — [use-apify.com guide (unofficial domain; secondary)](https://use-apify.com/docs/apify-for-developers/monetize-actors)

**Other paying marketplaces** — all from [SEOSiri (secondary)](https://www.seosiri.com/2026/09/mcp-monetization-gap-glama-smithery-developer-losses.html)

- MCPize: 80% standard, 85% for founding members before 2026-06-10, via Stripe Connect.
- MCP Marketplace: 85% (15% fee). 5,800+ servers and 1,000+ developers as of mid-2026, via Stripe Connect plus license-key SDKs.
- x402 self-hosted: about 100% minus rail fees. 3.3M transactions in a 30-day window at about $0.46 average.
- MuleRun Creator Studio: about 100% plus bonuses (beta).
- "Fewer than 5% of listed MCP servers are on a monetized path" (ChatForest, cited by SEOSiri).

**Payment rails and other gateways**

- x402: searching is free and only paid calls trigger payment. The client intercepts 402 responses, attaches the payment to the MCP request's `_meta`, and retries — [Coinbase CDP](https://docs.cdp.coinbase.com/x402/buyer/mcp-payments)
- AWS AgentCore Gateway can add the Bazaar as a target, reaching "10,000+ existing paid MCP tools that support x402" — [AWS docs](https://docs.aws.amazon.com/it_it/bedrock-agentcore/latest/devguide/payments-connect-bazaar.md)
- Permit MCP Gateway: Community tier free (1,000 MAU, human plus agentic). Pro from $25/mo (50K MAU, OAuth 2.1 proxy and consent editor) — [permit.io](https://www.permit.io/mcp-gateway/pricing)

### Inferences

- Charging consumers per call while paying vendors nothing is the norm, and it works because those catalogs wrap SaaS APIs the end user already pays for. Zevium's model, where the API itself is the paid product, is a different market. Its direct comparables are Apify (80%), RapidAPI-style hubs, and paid-MCP startups (80-85%).
- Composio's Aug 2026 repricing and Zapier's 2-tasks-per-call rule both drew "gotcha" coverage. Simple, transparent per-call pricing with no hidden meters is a selling point in its own right.
- Arcade's $0.01 vs $0.50 split shows that bundling vendor credentials (operator-held keys) supports a large markup. That's the treg model; Zevium's publisher-set price avoids it.

### Gaps

- No primary-source current tier table for Composio. Secondary sources conflict, and the fetched pricing page text was partial.
- No primary-source Smithery pricing; no Glama pricing (page didn't render).
- Whether the Anthropic Directory permits connectors that require paid credits: the policy doc wasn't fetched.
- RapidAPI's current state and take rate: not researched here; likely covered by another researcher.

## 3. Distribution tactics

### Takeaway

Distribution runs through (1) the client-native directories (Claude Connectors Directory with Suggested Connectors, the ChatGPT app directory), (2) the official registry, which feeds downstream aggregators (Glama is a superset), (3) one-click client install buttons (Docker Toolkit, mcp.directory), (4) generous free dev tiers, and (5) partner-platform syndication (Apify to Make/n8n/Zapier).

### Cited Findings

**Anthropic Connectors Directory**

- Every directory entry is automatically eligible for **Suggested Connectors**, in-chat recommendations shown when relevant to the user's task. Ranking is usage-based, "similar to other app stores".
- Submission runs through claude.ai/directory/manage; "anyone on a paid Claude plan can submit". After publication the same dashboard shows the server's health and usage.
- On Team plans, members without permission see a "Request" button that notifies Owners — [claude.com docs](https://claude.com/docs/connectors/directory)
- The submission portal reportedly opened 2026-09-25 and accepts single MCP connectors or GitHub-hosted plugin bundles (MCP plus skills). Auto-analysis lists the server as Community, with human review for only some — [BornCity (secondary)](https://borncity.com/news/anthropic-oeffnet-claude-verzeichnis-entwickler-reichen-plugins-direkt-ein/); [Pasquale Pillitteri (secondary)](https://pasqualepillitteri.it/fr/news/18445/anthropic-portail-plugins-connecteurs-mcp-claude)
- Common rejection causes: missing readOnly/destructive tool annotations and no public privacy policy — [Tallyfy guide (secondary)](https://mta-sts.tallyfy.com/how-to-list-mcp-server-anthropic-claude-connectors/)

**OpenAI app directory**

- Apps that meet higher design and functionality standards "may be featured more prominently—both in the directory and in conversations" — [OpenAI](https://openai.com/index/introducing-apps-in-chatgpt); [OpenAI Help](https://help.openai.com/en/articles/12515353-build-with-the-apps-sdk)

**Official MCP Registry**

- Designed as the upstream that public and private sub-registries (marketplaces, enterprise catalogs) build on — [MCP blog](https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview)
- Glama claims to be a superset of it, and Kong positions its registry on the same standard — [glama.ai](https://glama.ai); [Kong](https://konghq.com/blog/learning-center/what-is-an-mcp-registry)

**Docker**

- The Toolkit connects selected servers "with one click" to Claude Code, Claude Desktop, Codex, Cursor, Continue.dev, and Gemini CLI. Custom or forked catalogs are supported — [Docker blog](https://www.docker.com/blog/build-custom-mcp-catalog)
- E2B sandboxes ship with direct access to the Docker MCP Catalog — [Docker docs](https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway)

**Free tiers and dev modes**

- Pipedream: free dev mode with full API/SDK/MCP and no card — [pipedream.com/pricing](https://pipedream.com/pricing)
- Arcade: free 2K calls/auth events — [arcade.dev/pricing](https://www.arcade.dev/pricing)
- Smithery: free 50K RPCs, free publishing — [AgentAya (secondary)](https://agentaya.com/ai-review/smithery)
- Zapier MCP: available on the free plan — [Latenode (secondary)](https://latenode.com/blog/zapier-mcp-pricing)

**Apify syndication**

- Apify syndicates MCP servers to Make, n8n, Gumloop, and Zapier, and claims "top spots in all MCP registries" — [apify.com/mcp/developers](https://apify.com/mcp/developers)

**Monetized directory placement**

- mcp.directory shows a "Sponsored" slot and one-click install for Cursor, VS Code, Claude, and Codex — [mcp.directory](https://mcp.directory)

**Launch tactics**

- Klavis launched via Launch HN: 133 points, 66 comments, 2025-09-23 — [HN](https://news.ycombinator.com/item?id=45347914)
- Composio content marketing targets competitor-alternative searches (e.g. "Glama alternatives") — [Composio](https://composio.dev/content/glama-alternatives)

### Inferences

- The two highest-leverage channels for Zevium are free: (1) a Claude Directory listing, where Suggested Connectors provides intent-matched in-chat placement and usage-based ranking rewards traffic, and (2) publishing to the official MCP Registry so Glama, Kong, and others pick Zevium up automatically.
- The ChatGPT directory is riskier because OpenAI currently restricts digital-goods monetization. A credit-gated connector may not pass review (unverified).

### Gaps

- Whether the Claude Directory Policy allows connectors whose tools require prepaid credits on a third-party wallet.

## 4. Agent-facing features: tool search, auth, observability, rate limits, sandboxing, quality signals

### Takeaway

The leaders have converged on **a few meta-tools instead of full tool lists**: Cloudflare Code Mode (search plus execute), Composio Tool Router/Rube (search plus workbench), Klavis Strata (progressive discovery), and the x402 Bazaar (search plus proxy call). The other common pieces are managed per-user OAuth, centralized call logging with per-tool ACLs, container or V8 sandboxing, and early quality scores (Glama grades, Arcade ToolBench, MCPMark). Zevium's search_apis/get_api_docs/call_api fits this pattern already.

### Cited Findings

**Tool search and dynamic loading**

- Cloudflare Code Mode collapses all upstream tools into `portal_codemode_search` and `portal_codemode_execute`; the model writes JS that runs in a Dynamic Workers sandbox. 52 tools (about 9,400 tokens) became 2 tools (about 600 tokens), a 94% cut that stays fixed as servers are added. Cloudflare's own API MCP cut 99.9%. Enabled with `?codemode=search_and_execute` — [CF blog, 2026-04-14](https://blog.cloudflare.com/enterprise-mcp)
- Composio Tool Router: agents call search first (e.g. `RUBE_SEARCH_TOOLS`) to get current schemas, then load tools dynamically through one MCP endpoint — [Composio docs](https://docs.composio.dev/tool-router/overview); [skills.sh](https://www.skills.sh/composiohq/awesome-claude-skills/composio-search-automation)
- Klavis Strata: tiered discovery so agents aren't flooded. The founders note most servers "cap at 40~50 tools" to avoid context overload — [HN](https://news.ycombinator.com/item?id=45347914)
- Klavis claims +15.2% and +13.4% pass@1 over the official GitHub and Notion MCP servers on MCPMark (vendor-adjacent) — [rywalker.com](https://rywalker.com/research/klavis-ai)
- Smithery's registry API lets you search tools across servers — [API Evangelist](https://github.com/api-evangelist/smithery-ai)

**Auth**

- Pipedream: managed auth for end users with approved client IDs — [CommandPlusK (secondary)](https://commandplusk.com/vs/pipedream)
- Arcade: delegated OAuth, metered by auth event — [arcade.dev/pricing](https://www.arcade.dev/pricing)
- Cloudflare portals: users log in once via Access, then authenticate separately to each OAuth server. Linked App Tokens propagate user context downstream — [CF docs](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals); [Nanosek (secondary)](https://www.nanosek.com/cloudflare-mcp-governance)
- Kong: OAuth2 scope-based tool filtering, RFC 8693 token exchange, MCP Tool ACLs (AI Gateway 3.13, Jan 2026) — [Kosmoy (secondary)](https://www.kosmoy.com/resources/blog/portkey-vs-kong-ai-gateway)

**Observability and governance**

- Glama Gateway: "Every call logged · Every tool gated · Every credential managed" — [glama.ai/mcp/gateway](https://glama.ai/mcp/gateway)
- Cloudflare: centralized logging, DLP rules (e.g. block PII going to specific servers), and shadow-MCP detection by hostname (`mcp.*`), URI (`/mcp`, `/mcp/sse`), and JSON-RPC method body inspection (`tools/call`, `initialize`) — [CF blog](https://blog.cloudflare.com/enterprise-mcp)
- Docker: built-in logging and call tracing — [Docker docs](https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway)
- Zapier MCP: per-action read/write permissions, but "no approval step anywhere in the path" — [Sprites (secondary)](https://www.sprites.ai/compare/zapier-mcp)

**Rate limits and spend controls**

- Composio: Hobby hard cap, Pro per-meter spend caps — [composio.dev/pricing](https://composio.dev/pricing)
- Smithery Custom: custom rate limits — [AgentAya (secondary)](https://agentaya.com/ai-review/smithery)
- x402: "no spending limit primitive at the protocol layer" — [WorkOS (secondary)](https://workos.com/blog/x402-vs-stripe-mpp-how-to-choose-payment-infrastructure-for-ai-agents-and-mcp-tools-in-2026)

**Sandboxing**

- Docker runs servers in isolated containers with restricted privileges, network, and resources — [Docker docs](https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway)
- Composio bills a sandbox runtime as a separate meter — [composio.dev/pricing](https://composio.dev/pricing)
- Cloudflare runs Code Mode in Dynamic Workers — [CF blog](https://blog.cloudflare.com/enterprise-mcp)

**Quality signals and evals**

- Glama grades each server A-F on license, quality, and maintenance, and sorts by recent usage, npm/PyPI downloads, and GitHub stars. Exposes `GET /v1/servers` — [glama.ai/mcp/servers](https://glama.ai/mcp/servers)
- Arcade cites its ToolBench benchmark, arguing tool quality lags adoption — [Arcade blog](https://www.arcade.dev/blog/smithery-joins-arcade/)
- Claude Directory: Verified vs Community labels, usage-based ranking, and publisher health/usage dashboard — [claude.com docs](https://claude.com/docs/connectors/directory)

**Registry security**

- Listing ≠ vetting: a March 2026 scan of 100 Smithery servers found 22 with security findings — [CallSphere (secondary)](https://callsphere.ai/blog/vw4g-mcp-registry-catalogs-smithery-mcp-so-comparison-2026)
- GitGuardian flagged a Smithery path-traversal vulnerability in mid-2025 — [SEOSiri (secondary)](https://www.seosiri.com/2026/09/mcp-monetization-gap-glama-smithery-developer-losses.html)

### Inferences

- Zevium's gateway sees every paid call's latency, error rate, and spend. That supports **measured** quality signals (uptime, p50/p95, success rate, cost per successful call) that directories built on GitHub stars can't produce.
- Code Mode suggests a fourth meta-tool for Zevium: sandboxed composition of several call_api invocations in one step. It would need per-call credit gating inside the sandbox.

### Gaps

- No independent benchmark comparing tool-search approaches across vendors. All token-savings figures are vendor-reported.

## 5. Traction signals

### Takeaway

Funding concentrates in auth and integration layers (Composio $29M, Arcade seed plus a 2026 Series A). Consolidation is underway: Workday bought Pipedream (Nov 2025) and Arcade bought Smithery (Aug 2026). Raw directory counts run from about 300 (Docker, verified) to about 92K (Glama, indexed). Third-party trackers put the official registry at about 39K by Oct 2026. Measured usage is thin: Glama self-reports 1M+ tool calls/month.

### Cited Findings

**Funding and acquisitions**

- Composio: $25M Series A led by Lightspeed, total $29M, announced 2025-07-22. Angels include Guillermo Rauch and Dharmesh Shah — [PR Newswire](https://www.prnewswire.com/news-releases/composio-raises-29m-to-solve-ais-learning-problem-building-skills-that-actually-improve-over-time-302510684.html)
- Composio has "seven-figure revenue", 200+ customers including Glean, and 100K+ developers (aggregator) — [Startup Intros (unverified)](https://startupintros.com/orgs/composio)
- The GitHub repo had 27K+ stars as of 2026-03 — [GitHub #2818](https://github.com/ComposioHQ/composio/issues/2818)
- Arcade: $12M seed led by Laude Ventures, 2025-03-18 — [BusinessWire](https://www.businesswire.com/news/home/20250318815130/en/Arcade.dev-Scores-%2412M-to-Solve-the-Biggest-Security-Problem-with-AI-Agents)
- Arcade's last round was a Series A on 2026-06-12, amount not shown — [Caplight](https://www.caplight.com/company/arcade-dev)
- Arcade acquired Smithery on 2026-08-05 — [Arcade blog](https://www.arcade.dev/blog/smithery-joins-arcade/)
- Pipedream: 3,000+ connectors and 5,000+ customers. Workday acquisition announced 2025-11-19, terms undisclosed — [Constellation Research](https://www.constellationr.com/insights/news/workday-acquires-pipedream-launches-midmarket-focused-workday-go); [Workday](https://newsroom.workday.com/2025-11-19-Workday-Signs-Definitive-Agreement-to-Acquire-Pipedream)
- Klavis: seed from HSG (formerly Sequoia China) and YC — [klavis.ai](https://www.klavis.ai)
- Klavis total of $500K (seed 2025-06-10) — [Caplight (aggregator)](https://www.caplight.com/company/klavis)
- Toolhouse: $2.1M pre-seed, 2024-09-09 — [Caplight (aggregator)](https://www.caplight.com/company/toolhouse)
- Manufact: $6.3M seed. mcp-use reportedly at 7-8M+ downloads — [YC](https://www.ycombinator.com/companies/manufact/jobs/4cyWd6S-developer-advocate-partnerships-devrel). Peak XV as lead is unconfirmed — [80aj.com (unverified)](https://www.80aj.com/2026/07/01/manufact-vercel-mcp-funding/)

**Catalog and directory counts**

- Glama: 91,691 MCP servers, 23,828 connectors, "50,000+ developers · 1M+ tool calls / month" (self-reported, Oct 2026) — [glama.ai](https://glama.ai)
- Official registry, third-party trackers: 39,238 servers on 2026-10-04 (474 deprecated); 30,375 on 2026-09-10, with about one-third from roughly 50 accounts; about 16,967 in July 2026 — [dev.to](https://dev.to/amareswer/the-mcp-registry-by-the-numbers-38nc); [Digital Applied](https://digitalapplied.com/blog/mcp-adoption-statistics-2026)
- Smithery counts conflict:
  - 3,000+ verified (mid-2026) — [Towards AI](https://pub.towardsai.net/8-best-mcp-marketplaces-to-discover-mcp-servers-fb6cb082efcb)
  - 7,000+ — [CallSphere](https://callsphere.ai/blog/vw4g-mcp-registry-catalogs-smithery-mcp-so-comparison-2026)
  - 17,300+ (Aug 2026) — [ai.engineer](https://www.ai.engineer/orgs/smithery)
- mcp.so: 19,700+ to about 21,000 — [CallSphere](https://callsphere.ai/blog/vw4g-mcp-registry-catalogs-smithery-mcp-so-comparison-2026); [Reddit](https://www.reddit.com/r/mcp/comments/1tm7duq/i_built_the_largest_free_directory_of_mcp_servers)
- Docker MCP Catalog: 300+ verified servers (accessed 2026-09-29), up from 100 at the June 2025 launch — [Docker docs](https://docs.docker.com/ai/mcp-catalog-and-toolkit/catalog/); [i-programmer](https://i-programmer.info/news/90-tools/18089-docker-adds-mcp-catalog-and-toolkit.html)
- Zapier: 9,000+ apps and 66,000+ actions — [eesel](https://www.eesel.ai/blog/zapier-subscription)
- Composio: "20,000+ tools across 870+ apps" per its own integration pages; its Rube page cites 10,000 tools across 500+ servers — [Composio](https://composio.dev/toolkits/ritekit/framework/codex); [Composio](https://composio.dev/content/glama-alternatives)
- Apify: 83,526 Actors, 36K+ monthly developers, $500K+/month paid to developers (self-reported) — [apify.com/mcp/developers](https://apify.com/mcp/developers)
- Company-operated remote MCP servers grew from 425 (Aug 2025) to 1,412 (Feb 2026), less than 1% of the 151K API subdomains in the same 2M-company universe — [Bloomberry](https://bloomberry.com/blog/we-analyzed-1400-mcp-servers-heres-what-we-learned)

### Inferences

- Counts are inflated by duplicates and forks; registry growth is concentrated in a few accounts. Remote company-run servers (about 1.4K) are the market that matters for paid APIs, and they're still small next to the API universe (about 151K API subdomains). That's the opening for an OpenAPI-first approach (listing existing APIs without requiring MCP servers).

### Gaps

- Arcade Series A amount and lead investor not found.
- Whether the Workday-Pipedream deal closed: no confirmation found.
- No GMV or payout figures for any MCP-native paying marketplace beyond SEOSiri's secondary numbers.

## 6. Weaknesses and gaps of incumbents

### Takeaway

Shared weaknesses: (1) no revenue for tool authors, (2) opaque or fast-changing multi-meter pricing, (3) a listing badge that isn't a security vet, (4) neutrality erosion through acquisitions, (5) SaaS-connector bias that ignores paid data and compute APIs, and (6) OpenAI's ban on in-app digital-goods monetization.

### Cited Findings

**Composio**

- The Aug 2026 repricing cut included calls by 75% at $29 and raised overage about 13-16x (per Scalekit). It also added separate meters for triggers, tokens, premium tools, sandbox, and storage — [Scalekit (secondary)](https://www.scalekit.com/blog/composio-pricing-change)
- "A large toolkit count does not make all connectors equally deep" — [CapSolver (secondary)](https://www.capsolver.com/blog/ai/composio-review)

**Zapier MCP**

- The free plan amounts to about 50 calls/month. Actions execute rather than propose, with no approval step — [Sprites (secondary)](https://www.sprites.ai/compare/zapier-mcp); [usecarly](https://www.usecarly.com/blog/zapier-mcp)

**Pipedream**

- The per-external-user meter (about $2/user) gets expensive for consumer or PLG products. Under Workday, the roadmap is likely to bend toward Workday's enterprise suite. Catalog-first, so exposing your own API is your own work — [CommandPlusK (secondary)](https://commandplusk.com/vs/pipedream)

**Arcade**

- Two meters (auth events plus tool calls). SSO, RBAC, and audit logs are gated to Enterprise despite homepage claims — [TrueFoundry (secondary)](https://www.truefoundry.com/blog/arcade-vs-truefoundry)
- After buying Smithery, Arcade controls both registry and runtime. Forbes notes "conflicts of interest, portability, and independent grading" concerns — [Forbes](https://www.forbes.com/sites/janakirammsv/2026/08/10/arcade-acquires-smithery-to-own-the-agent-tool-supply-chain/)

**Registries**

- Registry inclusion ≠ security, per the Smithery scan above — [CallSphere (secondary)](https://callsphere.ai/blog/vw4g-mcp-registry-catalogs-smithery-mcp-so-comparison-2026)
- Claude Directory: "Verification isn't a security audit" — [claude.com docs](https://claude.com/docs/connectors/directory)
- Official registry: still preview, metadata only, no monetization — [Towards AI](https://pub.towardsai.net/mcp-registries-in-mid-2026-one-upstream-won-2ce541b92036); [SEOSiri](https://www.seosiri.com/2026/09/mcp-monetization-gap-glama-smithery-developer-losses.html)

**OpenAI**

- Monetization is limited to physical goods, and the in-chat payment sheet is restricted to select marketplaces — [OpenAI docs](https://developers.openai.com/apps-sdk/build/monetization)
- GPT Store revenue sharing was promised but produced little visible author income — [VentureBeat](https://venturebeat.com/technology/openai-now-accepting-chatgpt-app-submissions-from-third-party-devs-launches)

**Payments rails and gateways**

- x402 requires crypto wallets and lacks a spend-limit primitive — [WorkOS (secondary)](https://workos.com/blog/x402-vs-stripe-mpp-how-to-choose-payment-infrastructure-for-ai-agents-and-mcp-tools-in-2026)
- Paid-MCP marketplaces are "early and low-adoption" — [SEOSiri (secondary)](https://www.seosiri.com/2026/09/mcp-monetization-gap-glama-smithery-developer-losses.html)
- Neither Portkey nor Kong "sandboxes agent execution or provides a kill switch" — [Kosmoy (secondary)](https://www.kosmoy.com/resources/blog/portkey-vs-kong-ai-gateway)

**Commoditization**

- REST-to-MCP conversion is now a single Kong plugin — [Kong YouTube](https://www.youtube.com/watch?v=CyHgTvy3rPM&vl=en)

### Inferences

- Converting OpenAPI specs into MCP tools is not a moat; Kong, Composio's proxy execute, and Cloudflare all do it. Zevium's defensible pieces are the **two-sided billing ledger plus publisher payouts plus neutral measured quality**.

### Gaps

- No user-sentiment data (e.g. reviews, churn) for Glama, Smithery, or Klavis.

## 7. Ideas worth borrowing, and whitespace for Zevium

### Takeaway

Borrow: meta-tool and Code Mode token economics, Suggested Connectors and registry syndication, measured quality grades, charging only for successful calls, hard spend caps, one-click client installs, and a publisher health dashboard. Whitespace: a neutral, fiat, prepaid marketplace that pays API publishers 95% for third-party paid APIs (data, compute, vertical APIs) that SaaS-connector catalogs don't cover.

### Cited Findings (evidence for each idea)

1. **Don't charge for failed calls.** Zapier bills 0 tasks for failed calls and for listing, auth, and history — [Latenode](https://latenode.com/blog/zapier-mcp-pricing). Zevium equivalent: auto-refund credits on upstream 5xx and timeouts; search_apis and get_api_docs stay free.
2. **Hard caps plus per-key and per-meter spend caps** to back up "zero balance blocks". Composio offers a Hobby hard cap and per-meter caps — [composio.dev/pricing](https://composio.dev/pricing). x402 lacks this primitive — [WorkOS](https://workos.com/blog/x402-vs-stripe-mpp-how-to-choose-payment-infrastructure-for-ai-agents-and-mcp-tools-in-2026). Pitch: "agent can't overspend."
3. **Code Mode-style composition tool.** A fixed 2-tool surface gave Cloudflare a 94% token cut — [CF blog](https://blog.cloudflare.com/enterprise-mcp). Zevium could add a sandboxed `run_script` that chains call_api calls, with per-call wallet gating. Cloudflare Dynamic Workers is native to Zevium's stack.
4. **Progressive discovery.** Strata's tiered app → category → operation discovery — [HN](https://news.ycombinator.com/item?id=45347914). search_apis could return API-level hits first, then operation-level detail via get_api_docs, which matches the current design.
5. **Measured quality grades.** Glama grades A-F on license, quality, and maintenance — [glama.ai/mcp/servers](https://glama.ai/mcp/servers). Arcade has ToolBench — [Arcade](https://www.arcade.dev/blog/smithery-joins-arcade/). Zevium can publish gateway-measured success rate, p95 latency, and uptime per API and operation, and feed them into search ranking. This is neutral grading that Forbes says the Arcade/Smithery combination calls into question — [Forbes](https://www.forbes.com/sites/janakirammsv/2026/08/10/arcade-acquires-smithery-to-own-the-agent-tool-supply-chain/).
6. **Get into the Claude Connectors Directory.** Suggested Connectors gives auto-eligible in-chat recommendations with usage-based ranking, and paid-plan users can self-submit at claude.ai/directory/manage. Annotate every tool readOnly/destructive and publish a privacy policy — [claude.com docs](https://claude.com/docs/connectors/directory); [Tallyfy](https://mta-sts.tallyfy.com/how-to-list-mcp-server-anthropic-claude-connectors/)
7. **Publish to the official MCP Registry** under a verified Zevium namespace (domain proof required), and consider exposing a Zevium sub-registry API that implements the open registry spec so enterprise and aggregator registries (Glama, Kong) ingest Zevium listings — [MCP blog](https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview); [glama.ai](https://glama.ai); [Kong](https://konghq.com/blog/learning-center/what-is-an-mcp-registry)
8. **One-click "Add to Claude Code / Cursor / Codex / VS Code" buttons** on every API page and on the org key page — [Docker blog](https://www.docker.com/blog/build-custom-mcp-catalog); [mcp.directory](https://mcp.directory)
9. **Publisher dashboard with health and usage**, as the Claude Directory gives publishers — [claude.com docs](https://claude.com/docs/connectors/directory). Apify adds detailed usage analytics plus monthly payouts — [apify.com/mcp/developers](https://apify.com/mcp/developers)
10. **Lead with the 95% split.** Documented comparables are Apify (commonly 80%), MCPize (80-85%), MCP Marketplace (85%), Agent Bazaar (82%), and $0 at every big directory — [SEOSiri](https://www.seosiri.com/2026/09/mcp-monetization-gap-glama-smithery-developer-losses.html); [GitHub #2818](https://github.com/ComposioHQ/composio/issues/2818)
11. **Syndication and partner distribution** in the style of Apify (Make, n8n, Gumloop, Zapier) — [apify.com/mcp/developers](https://apify.com/mcp/developers)
12. **Optional machine-payment rails** for keyless agents: list Zevium endpoints in the x402 Bazaar (10,000+ paid tools reachable via AWS AgentCore) or accept Stripe MPP sessions as a wallet top-up path — [AWS docs](https://docs.aws.amazon.com/it_it/bedrock-agentcore/latest/devguide/payments-connect-bazaar.md); [Coinbase](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/bazaar-mcp-server); [Stripe Sessions](https://stripe.com/th/sessions/2026/machine-payments-and-the)
13. **Simple pricing with no meter changes** as a contrast to Composio's Aug 2026 repricing and Zapier's 2-tasks-per-call: one meter (credits per operation, set by the publisher's spec) — [Scalekit](https://www.scalekit.com/blog/composio-pricing-change); [zapier.com/pricing/rates](https://zapier.com/pricing/rates)
14. **Agent-readable docs.** Cloudflare and Claude docs expose llms.txt and "View as Markdown / Agent setup" — [CF changelog](https://developers.cloudflare.com/changelog/post/2025-08-26-mcp-server-portals); [claude.com docs](https://claude.com/docs/connectors/directory). (treg also does this; out of scope.)

### Inferences (whitespace)

- **Paying publishers at scale is open.** Every large MCP directory pays authors $0. Payers are small, crypto-native, or scraping-specific (Apify). A fiat, prepaid, card-funded marketplace at 95/5 has no direct scaled competitor in the evidence gathered.
- **Paid third-party APIs are underserved.** Composio, Pipedream, Zapier, and Arcade monetize auth to SaaS apps the user already owns. None gives a data or compute API vendor a way to sell per call to agents. That is Zevium's core segment.
- **Neutrality.** After Workday/Pipedream and Arcade/Smithery, independent discovery plus grading backed by real metering is a sellable position.
- **OpenAPI-first beats MCP-first for supply.** Remote company MCP servers number about 1.4K against about 151K API subdomains (Bloomberry). Letting vendors list existing OpenAPI APIs without writing an MCP server reaches far more supply. Kong's REST-to-MCP plugin shows the conversion is easy; the billing and payout layer is what's missing.
- **Risk: client-store policy.** OpenAI blocks digital-goods monetization in apps, and Anthropic's policy on paid-credit connectors is unknown. Zevium's MCP connector may need to work as "BYO prepaid org key" with purchase on zevium.dev (external checkout), which OpenAI calls the generally available approach.
- **Risk: Cloudflare as a competitor.** Cloudflare owns portals, Code Mode, Dynamic Workers, and has payment-adjacent primitives. If it adds marketplace billing, Zevium's CF Worker stack would be competing with the platform it runs on (speculative).

### Gaps

- Anthropic Directory policy on paid or credit-gated connectors: not fetched.
- RapidAPI and other classic API marketplaces: not covered here (likely another researcher's scope).
- Gravitee and Portkey MCP gateway specifics not researched.
