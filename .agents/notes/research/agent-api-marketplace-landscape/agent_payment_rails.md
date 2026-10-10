# Agent / Machine Payment Rails and Agentic Commerce Protocols (as of 2026-10-10), relative to Zevium

Scope note: research done 2026-10-10. Many 2026 figures come from secondary/vendor blogs and are labeled as such. "Primary" = vendor docs, official press, or GitHub. Zevium context: prepaid org credits (Stripe Checkout), CF Worker gateway with per-org wallet DO, Stripe Connect 95/5 payouts, non-x402 HTTP 402 today.

## Q1. How each rail works: flow/headers, settlement asset, fees, custody

### Takeaway

Two families have formed. (a) Per-request HTTP-402 challenge/response rails for machine-to-API payments: x402 (Coinbase origin, now Linux Foundation), Stripe/Tempo MPP, and L402 (Lightning). (b) Card-network "agentic checkout" trust/tokenization layers for buying goods: ACP (OpenAI/Stripe), Google AP2 (now at FIDO), Visa TAP/Intelligent Commerce, and Mastercard Agent Pay. Only family (a) fits per-call API metering. x402 is non-custodial and stablecoin-first. MPP settles into the seller's Stripe balance in fiat and also accepts x402 on Base. That makes Stripe the lowest-friction bridge to Zevium's existing Stripe/Connect stack.

### Cited Findings

**x402 (protocol)**

- Flow: the server returns 402 with a `PAYMENT-REQUIRED` header carrying a base64 `PaymentRequired` object. The client retries with a `PAYMENT-SIGNATURE` header (`PaymentPayload`). The server returns `PAYMENT-RESPONSE` (base64 JSON settlement response). The resource server POSTs to a facilitator's `/verify` and `/settle`, or settles on-chain itself — [github.com/x402-foundation/x402](https://github.com/x402-foundation/x402)
- Schemes: `exact`, `upto`, `batch-settlement` (EVM) — [github.com/x402-foundation/x402](https://github.com/x402-foundation/x402)
- Trust model: "all payment schemes must not allow for the facilitator or resource server to move funds" beyond what the client intended. Scope "aims to support all networks (both crypto & fiat)" — [github.com/x402-foundation/x402](https://github.com/x402-foundation/x402)
- SDKs: `@x402/core`, `@x402/fetch`, `@x402/axios`, `@x402/hono`, `@x402/express`, `@x402/next`, `@x402/fastify`, `@x402/paywall`, `@x402/extensions`, `@x402/mcp`. Chain packages: `@x402/svm`, `@x402/avm`, `@x402/aptos`, `@x402/stellar`, `@x402/hedera`, and others. Go module `.../go/v2`. The repo warns against assuming the public x402.org facilitator is the default for mainnet EVM — [github.com/x402-foundation/x402](https://github.com/x402-foundation/x402)
- V2 shipped 2025-12-11. It added a unified network/asset format (multi-chain by default, Base and Solana named), card/ACH/SEPA facilitators in the same model, wallet-based sessions/identity so callers skip repaying on every call, automatic API discovery, dynamic payment recipients, and a modular SDK — [x402.org V2 launch](https://www.x402.org/writing/x402-v2-launch); [The Block](https://www.theblock.co/post/382284/coinbase-incubated-x402-payments-protocol-built-for-ais-rolls-out-v2)
- CDP Facilitator pricing: 1,000 on-chain tx/month free, then $0.001 per on-chain tx. Verification is always free. `batch-settlement` claims thousands of vouchers in one on-chain tx. Deposits, refunds, and withdrawals each count as a tx. Gas is separate. Networks: ERC-20 on Base, Polygon, Arbitrum, World, and Solana (EIP-3009 for USDC/EURC, Permit2 for any ERC-20) — [CDP facilitator docs](https://docs.cdp.coinbase.com/x402/core-concepts/facilitator); [CDP welcome](https://docs.cdp.coinbase.com/x402/welcome)
- Custody: sellers receive funds at "any address they control": CDP custodial wallet, Coinbase Business, Prime, or self-custody — [CDP x402 welcome](https://docs.cdp.coinbase.com/x402/welcome)
- Third-party analysis: tickets at or below $0.001 need batch-settlement, or facilitator fees eat the margin after the free tier (analysis, not CDP docs) — [Stablecoin Insider](https://stablecoininsider.org/how-to-price-an-x402-api-in-usdc/)

**Coinbase CDP / Agentic Wallets**

- Agentic Wallets launched 2026-02-11. They are key-based, fundable in minutes, gasless on Base, and have no identity requirement (secondary) — [Spartan Group](https://www.spartangroup.io/insights/ai-agents-and-the-next-wave-of-onchain-demand)
- Buyers pay from a CDP wallet or any other signer — [CDP x402 welcome](https://docs.cdp.coinbase.com/x402/welcome)

**Stripe Machine Payments + MPP (launched 2026-03-18 with Tempo mainnet)**

- MPP is an open protocol co-authored by Stripe and Tempo; spec at [mpp.dev](https://mpp.dev). Flow: 402 challenge, then the agent retries with a credential, then the server calls `POST /v1/payment_intents` to record the payment, then the server returns the resource plus a receipt. Server lib is `mppx` (`Mppx.create`, `mppx.charge({amount})`, `mppx.compose()` for per-method pricing). Challenges are HMAC-bound. `npx mppx validate` tests discovery, challenge format, and the full flow — [Stripe MPP docs](https://docs.stripe.com/payments/machine/mpp)
- Payment methods: cards via Shared Payment Tokens (SPTs) at a $0.50 minimum, and stablecoins at a 0.01 USDC minimum. MPP sessions charge in sub-cent increments, but the minimum settlement is 0.01 USDC — [Stripe machine payments](https://docs.stripe.com/payments/machine)
- Networks: MPP on Tempo (USDC.e) and Solana (USDC). Stripe also accepts x402 on Base (USDC). Stablecoin funds are auto-offramped into the Stripe balance and settle in fiat. Refunds go through the normal Refunds API. "Machine payments are available for Connect platforms across all charge types" — [Stripe machine payments](https://docs.stripe.com/payments/machine)
- Stripe can sponsor Tempo gas (`hostedFeePayer: true`), but this cannot be combined with Connect integrations — [Stripe MPP docs](https://docs.stripe.com/payments/machine/mpp)
- Stablecoin acceptance: all US states except New York. Outside the US, access to 30+ countries is by email request. SPTs: all US states plus listed countries — [Stripe machine payments](https://docs.stripe.com/payments/machine)
- API surface is still preview (`Stripe-Version: 2026-07-29.preview` for business profiles and crypto deposit addresses) — [Stripe MPP docs](https://docs.stripe.com/payments/machine/mpp)
- MPP design partners reportedly ranged from OpenAI and Anthropic to Visa, Mastercard, and Deutsche Bank. Rails are said to extend to cards and Lightning via Lightspark (press coverage) — [Silicon Republic](https://www.siliconrepublic.com/business/stripes-crypto-joint-venture-tempo-launches-payments-protocol-for-ai); [crypto.news](https://crypto.news/stripe-and-paradigms-tempo-mainnet-goes-live-for-machine-payments/)
- Stripe's documented fee for machine payments: not found on the docs pages fetched (see Gaps).

**Stripe/OpenAI Agentic Commerce Protocol (ACP) + Shared Payment Tokens**

- ACP powers ChatGPT Instant Checkout, launched 2025-09. Non-Stripe merchants can join via Stripe's SPT API or ACP's Delegated Payments Spec without switching processors — [OpenAI](https://openai.com/index/buy-it-in-chatgpt/)
- SPTs are scoped grants with usage and expiry limits. Agents issue them from the Link Agent Wallet (`@stripe/link-cli`, also usable as an MCP server) — [Stripe machine payments](https://docs.stripe.com/payments/machine); [Stripe MPP docs](https://docs.stripe.com/payments/machine/mpp)
- Instant Checkout's status after March 2026 is unclear. One guide implies the checkout changed in 2026-03 and that only the ACP spec remains; others describe it as current (unverified) — [ekamoira](https://www.ekamoira.com/blog/chatgpt-instant-checkout-agentic-commerce-protocol-2026)

**Google AP2**

- AP2 was announced 2025-09 with 60+ partners. v0.2 (2026-04) added "Human Not Present" pre-authorized autonomous purchases. Google donated AP2, plus Verifiable Intent (co-developed with Mastercard), to the FIDO Alliance. FIDO formed Agentic Authentication and Payments working groups, the latter chaired by Visa and Mastercard — [Google blog](https://blog.google/products-and-platforms/platforms/google-pay/agent-payments-protocol-fido-alliance/); [FIDO Alliance](https://fidoalliance.org/google-donates-agent-payments-protocol-to-fido-alliance/); [TNW I/O 2026](https://thenextweb.com/news/google-universal-cart-agent-payments-shopping-io-2026)
- AP2 is a mandate/credential framework (intent and cart mandates) and is rail-agnostic. It is a goods-checkout trust layer, not a per-call metering protocol (inferred from the above; no primary spec fetched).

**Visa Intelligent Commerce / Trusted Agent Protocol (TAP)**

- TAP launched 2025-10 with Cloudflare. It is built on HTTP Message Signatures (RFC 9421) and lets merchants distinguish legitimate agents from bots. Visa's 2026 framework accepts payments initiated via TAP, MPP, ACP, and UCP — [Visa press](https://usa.visa.com/about-visa/newsroom/press-releases.releaseId.22276.html); [stellagent explainer](https://stellagent.ai/insights/visa-intelligent-commerce-vic-explained)
- Visa is reportedly building a card SDK for MPP (secondary) — [Tokenized](https://www.tokenizedpod.com/learn/what-is-machine-payments-protocol)

**Mastercard Agent Pay**

- Agentic Tokens are bound to consent policy, merchant scope, and spend limit, and the PAN is never exposed. Verifiable Intent (with Google) launched 2026-03-05. "Agent Pay for Machines" launched ~2026-06 with 30+ partners across cards, stablecoins, and L1s (single vendor-leaning source). Skyfire was named a KYA partner on 2026-09-30 — [eco.com](https://eco.com/support/en/articles/15192001-what-is-mastercard-agent-pay-ai-agent-commerce-protocol-in-2026); [Genfinity](https://genfinity.io/2026/06/10/mastercard-agent-pay-for-machines-launch/); [fintechspecs](https://fintechspecs.com/blog/mastercard-agent-pay-trust-intelligence-skyfire-kya-2026/)
- Mastercard's x402 Foundation quote names "Mastercard Agent Pay for Machines" as its machine-payments link to x402 — [x402 Foundation press](https://x402.org/linux-foundation-announces-operational-launch-of-x402-foundation-to-standardize-internet-native-payments-for-ai-agents-and-applications/)

**Cloudflare (pay-per-crawl, Monetization Gateway, Wallets, NET Dollar, Agents SDK)**

- Monetization Gateway was announced 2026-07-01 and is waitlisted, not GA. Customers can charge for web pages, datasets, APIs, and MCP tools behind Cloudflare via x402. Rules can be written as expressions in the dashboard, the API, or Terraform. Examples include per-verb route pricing, compute-variable pricing, and turning 401 responses into 402. Settlement is in stablecoins "at launch" (Open USD and USDC named), peer-to-peer into the seller wallet, and the seller can redeem to a bank. No fee schedule is published. It is described as the "next step" after Pay Per Crawl — [Cloudflare blog](https://blog.cloudflare.com/monetization-gateway/)
- Pay Per Crawl remains a closed/private beta (secondary) — [Stack Overflow blog](https://stackoverflow.blog/2026/02/26/how-pay-per-crawl-is-reshaping-data-monetization/)
- Agents SDK: `paidTool` / `withX402` for charging per MCP tool call — [CF docs: Charge for MCP tools](https://developers.cloudflare.com/agents/x402/charge-for-mcp-tools/)
- Cloudflare Wallets (buy side, `cloudflare.pay` identity) reportedly shipped 2026-08-04 (secondary) — [getaibook](https://getaibook.com/news/cloudflare-wallets-equip-ai-agents-with-x402-spending-contro/)
- NET Dollar: announced 2025-09-25 as a USD-backed stablecoin for agent payments — [The Block](https://www.theblock.co/amp/post/372387/cloudflare-plans-to-launch-stablecoin-called-net-dollar-as-market-is-poised-to-expand). No evidence of a live launch found. The Monetization Gateway post names "Open USD", not NET Dollar — [Cloudflare blog](https://blog.cloudflare.com/monetization-gateway/)

**Vercel**

- `x402-mcp` gives AI SDK integration: server-side `paidTool` with a price (e.g. $0.001), client-side `withPayment` wrapper — [Vercel blog](https://vercel.com/blog/introducing-x402-mcp-open-protocol-payments-for-mcp-tools); [Vercel changelog](https://vercel.com/changelog/402-mcp-enables-x402-payments-in-mcp)

**L402 / Lightning Labs**

- L402 is a macaroon plus Lightning invoice behind HTTP 402. Lightning Labs agent tools (Feb–Mar 2026): `lnget` auto-pays L402, an MCP server for node ops, remote signing, scoped macaroons, and a max-cost flag. It requires running LND — [Lightning Labs blog](https://lightning.engineering/posts/2026-03-11-L402-for-agents/); [Bitcoin.com News](https://news.bitcoin.com/lightning-labs-open%E2%80%91sources-l402-agent-tools-to-power-ai-payments/)
- A vendor claims zero L402-native MCP servers in the public MCP registry (vendor claim, may be stale) — [loop-mcp](https://mcpservers.org/th/servers/loop-xxi/loop-mcp)

**Agent-wallet / payment startups (all secondary or vendor sources)**

- Skyfire: KYA identity via signed JWTs plus KYAPay. Reported ~2–3% fee (unconfirmed) — [leaveit2ai review](https://leaveit2ai.com/ai-tools/finance/skyfire); [eco.com KYA](https://eco.com/support/en/articles/14846277-know-your-agent-kya-identity-for-agent-payments)
- Nevermined: metering/monetization middleware over x402, Visa, AP2, MCP, and A2A, with no native wallet. It is the closest functional competitor to Zevium's metering layer — [Nevermined (self-published)](https://nevermined.ai/blog/best-platforms-agentic-payments)
- Crossmint: full-stack wallets with a non-custodial dual-key TEE, stablecoins plus Visa/Mastercard rails. Founding member of the Agentic Commerce Consortium (2025-09, with Basis Theory, Lithic, Skyfire, Rye) — [fluxapay comparison](https://fluxapay.xyz/learning/6-crossmint-alternatives-for-ai-agent-payments-2026); [Trio](https://trio.dev/agentic-payments-companies-redefining-checkout/)
- Payman: B2B and pay-humans focus, SOC-2/PCI, Fifth Third Bank USD custody, ACH/wire — [pinkwallet comparison](https://pinkwallet.com/agentic/learn/ai-agent-spend-governance-tools-compared/)

**MCP payment extensions**

- No formal MCP spec extension/SEP for payments was found. De facto options are `@x402/mcp` (Coinbase/Foundation), Vercel `x402-mcp`, Cloudflare `paidTool`, and Rust `r402-mcp` (payment data in JSON-RPC `_meta`) — [Vercel](https://vercel.com/blog/introducing-x402-mcp-open-protocol-payments-for-mcp-tools); [CF docs](https://developers.cloudflare.com/agents/x402/charge-for-mcp-tools/); [docs.rs r402-mcp](https://docs.rs/crate/r402-mcp/0.12.0)

### Inferences

- For per-call APIs only x402, MPP, and L402 are relevant. ACP, AP2, TAP, and Agent Pay are goods-checkout and identity layers. They matter to Zevium only for agent identity signals (TAP/RFC 9421, KYA JWT) and as card-backed funding sources via SPTs.
- MPP's card minimum ($0.50) kills per-call card settlement for sub-dollar calls. Cards only make sense as a credit top-up, which is Zevium's existing model.

### Gaps

- Stripe's processing fee for MPP stablecoin and SPT payments was not on the fetched pages. Stripe's general stablecoin fee (historically 1.5%) was not re-verified for 2026.
- The MPP header names (mpp.dev spec) were not fetched. The Stripe page shows only the 402 challenge, credential, and receipt semantics.
- Cloudflare Monetization Gateway fees and custody model are not published.
- The AP2 v0.2 spec text was not fetched directly.

## Q2. Maturity and real traction (dates; hype vs verified)

### Takeaway

x402 has by far the most verified on-chain activity: hundreds of millions of transactions cumulatively and 14–45M per month by mid/late 2026. Dollar volume is small, with tens of millions cumulative, and demand is concentrated in a few listings with heavy test/wash noise. MPP is about 7 months old, and its traction numbers are unverified secondary claims. Card-network agent programs are live but report no agent-specific volumes.

### Cited Findings

- x402 Foundation went operational under the Linux Foundation on 2026-07-14 with 40 members (39 named). The 17 premier members are Adyen, AWS, Amex, Circle, Cloudflare, Coinbase, Fiserv, Google, Mastercard, Monad, MoonPay, Ripple, Shopify, Solana Foundation, Stellar, Stripe, and Visa. The release contains no volume stats — [x402 Foundation press](https://x402.org/linux-foundation-announces-operational-launch-of-x402-foundation-to-standardize-internet-native-payments-for-ai-agents-and-applications/)
- The x402 Foundation was first announced by Cloudflare and Coinbase in 2025-09 — [The Block](https://www.theblock.co/amp/post/372387/cloudflare-plans-to-launch-stablecoin-called-net-dollar-as-market-is-poised-to-expand)
- CDP: "more than 100 million x402 payments across Base and Solana" (primary, undated page) — [CDP welcome](https://docs.cdp.coinbase.com/x402/welcome)
- Cumulative x402 transactions were 160M+ by ~June 2026 (>90% on Base), with 14–17.8M tx in a 30-day window around Aug 2026 (secondary) — [Crypto Briefing](https://cryptobriefing.com/usdc-dominates-agentic-transfer-volume-x402/). A separate source says >165M tx and ~$50M cumulative settled volume as of April 2026 — [Coingape](https://coingape.com/block-of-fame/case-studies/coinbase-case-study-why-coinbase-agentic-wallets-are-winning-the-ai-payments-race/). Agent counts conflict (69k vs 400k vs 480k).
- Turnkey reports 44,930,157 authorized stablecoin transfers from 440,608 distinct payers on x402/Base, 2026-08-13 to 09-13 (secondary, via search summary) — [Turnkey](https://www.turnkey.com/blog/agents-buying-coinbases-x402-bazaar-discovery-layer)
- Bearish data: CoinDesk (2026-03) put daily volume near $28k with much of it test/wash. x402scan-based analysis: 3.69M tx and $1.11M over 30 days, down ~77% from the Nov 2025 peak — [note.com x402 Inc](https://note.com/x402inc/n/nfd6227f13b55?hl=en-US); [PaymentsJournal](https://www.paymentsjournal.com/agentic-commerce-traffic-on-coinbases-protocol-has-yet-to-accelerate/amp/); [GitHub comparative analysis, Oct 2026](https://github.com/Ricosworks1/blockchain-payment-flow-analysis/releases/tag/comparative-analysis-ai-agent-payments-infrastructure-race-oct-2026)
- Bazaar snapshot (2026-10-09): 34,062 listings on 2,158 hosts. Only 420 listings had 10 or more payers, 16,236 had at most 1 payer, and 94% lacked a "use when" description — [DEV: State of the x402 Bazaar](https://dev.to/tanod/state-of-the-x402-bazaar-34062-listings-2158-hosts-and-94-missing-a-use-when-line-34co)
- Bazaar 30-day data: top-100 listings drew 208,415 calls, with web search/content retrieval at 42% and crypto market data at 23.4% — [Turnkey](https://www.turnkey.com/blog/agents-buying-coinbases-x402-bazaar-discovery-layer); [DEV 30-day data](https://dev.to/tanod/what-ai-agents-actually-pay-for-over-x402-30-day-data-from-the-bazaar-d6d)
- Notable real adopter, observed first-hand 2026-10-10: Tavily's keyless search API returned `hourly_cap_reached` with a `next_actions` entry of type `agentic_payment` pointing to x402 to "continue immediately". This is the keyless-to-x402 upsell pattern live in production — [Tavily x402 docs](https://docs.tavily.com/documentation/machine-payments/x402)
- MPP: "53+ services" (incl. Cloudflare Workers, Vercel, Resend) and "$14M in 60 days" come from a single unverified blog that also misdates the launch — [signb.ee](https://signb.ee/blog/mpp-is-moving-faster-than-anyone-expected). Forrester calls MPP a micropayments "turning point" (opinion) — [Forrester](https://www.forrester.com/blogs/why-stripes-machine-payments-protocol-signals-a-turning-point-for-micropayments/)
- Mastercard Agent Pay is live in the US. The first Singapore transaction was 2026-03-04 (blog-sourced). Fiserv/Clover integration was announced 2026-01 — [eco.com](https://eco.com/support/en/articles/15192001-what-is-mastercard-agent-pay-ai-agent-commerce-protocol-in-2026)
- Visa: named merchants (Henry Labs, Honeylove, Jomashop, Fabrique) completed real transactions. No official TAP volume was found — [Visa partners](https://corporate.visa.com/en/sites/visa-perspectives/newsroom/visa-partners-complete-secure-agentic-transactions.html)

### Inferences

- Treat x402 as "real but tiny in dollars". Average ticket is roughly $0.25–0.30 if the ~$50M/165M figures hold (computed, rough). Agent API demand exists but is long-tail and concentrated. Being listed is cheap optionality, not a revenue engine.
- The x402 governance risk is gone, since x402 is now vendor-neutral and has Stripe, Visa, Mastercard, Google, AWS, and Cloudflare as premier members. Adopting it is no longer a bet on Coinbase alone.

### Gaps

- No authoritative Coinbase or Foundation dashboard figure for October 2026 was found. A "205M tx / $53M / 69k agents through Aug 2026" figure appeared in a search summary without a resolvable primary source.
- No verified MPP volume.
- No AP2 production volume.

## Q3. Regulatory / compliance burden for a marketplace paying out publishers

### Takeaway

The lowest-burden path keeps Stripe as the regulated party: funds land in Zevium's Stripe balance and publishers are paid via Connect, with Stripe doing KYC on connected accounts. Holding pooled USDC and paying publishers in crypto would make Zevium look like a custodian/transmitter. x402's non-custodial design avoids that only if funds go straight to the publisher's own wallet, which bypasses Zevium's ledger and take rate.

### Cited Findings

- Stripe machine payments (MPP and x402) settle into the Stripe balance in fiat, and are "available for Connect platforms across all charge types" — [Stripe machine payments](https://docs.stripe.com/payments/machine)
- Stripe stablecoin acceptance excludes New York and needs approval of the "Stablecoins and Crypto" payment method. Non-US access is by request — [Stripe machine payments](https://docs.stripe.com/payments/machine)
- x402 schemes must not let the facilitator or resource server move funds beyond client intent, so the protocol is non-custodial by design — [x402 GitHub](https://github.com/x402-foundation/x402). CDP lets sellers receive to self-custody or CDP custodial wallets — [CDP welcome](https://docs.cdp.coinbase.com/x402/welcome)
- GENIUS Act (signed July 2025): effective on the earlier of 2027-01-18 or 120 days after final rules. It preempts conflicting state rules for payment stablecoin issuers. Intermediaries face KYC/AML/sanctions expectations (vendor characterization) — [Paul Weiss](https://www.paulweiss.com/insights/client-memos/genius-act-ushers-in-comprehensive-federal-regulation-of-payment-stablecoins); [Steptoe](https://www.steptoe.com/en/news-publications/blockchain-blog/the-genius-act-and-financial-crimes-compliance-a-detailed-guide.html)
- State money-transmitter exposure for stablecoin intermediaries is called a "minefield" — [Cozen O'Connor](https://www.cozen.com/news-resources/publications/2025/stablecoins-navigating-the-money-transmitter-minefield)
- Coinbase Agentic Wallets need no identity (KYC) to create (secondary) — [Spartan Group](https://www.spartangroup.io/insights/ai-agents-and-the-next-wave-of-onchain-demand). Buyers may therefore be anonymous wallets, which raises sanctions-screening questions for whoever receives funds.

### Inferences

- Safe hybrid: accept x402/MPP **through Stripe**, so Stripe offramps to fiat and the funds become ordinary Stripe balance. Zevium credits the org ledger, and publishers keep getting Connect transfers. Zevium never holds crypto and never transmits crypto. Its compliance posture stays the same as today's Checkout top-ups.
- Running its own CDP facilitator with Zevium-owned `payTo` addresses would put pooled USDC on Zevium's books, plus off-ramp, sanctions screening, and possible MTL analysis. Avoid this at zero users.
- Per-publisher `payTo` (publisher's own wallet) is non-custodial but breaks the 95/5 split unless the split happens on-chain. It also undermines the "Convex owns the publisher ledger" rule.

### Gaps

- No FinCEN or state guidance specific to x402/HTTP-402 marketplace facilitation was found.
- No legal analysis of whether converting inbound x402 USDC (via Stripe) into marketplace credits changes Stripe Connect platform obligations.
- Not confirmed whether Stripe x402/Base acceptance (not only MPP) works with Connect destination charges or application fees. The docs state Connect support generally, and say `hostedFeePayer` cannot be used with Connect.

## Q4. Fit with prepaid credits + Stripe Connect: hybrid designs

### Takeaway

Zevium's wallet DO is a pre-funded, off-chain session. That is the same pattern MPP "sessions" and x402 V2 "wallet sessions/batch-settlement" are building toward. The cleanest design is "x402/MPP as a top-up and keyless-onboarding rail into the existing credit ledger", not per-call on-chain settlement. Per-call settlement adds facilitator fees ($0.001/tx past the free tier), the 0.01 USDC Stripe minimum, and latency, which conflicts with the hot-path budget.

### Cited Findings

- MPP sessions: authorize once and pre-deposit funds, then settle per call, with sub-cent increments but a 0.01 USDC minimum settlement — [Stripe machine payments](https://docs.stripe.com/payments/machine); [bex.co](https://bex.co/blog/2026/04/03/tempo-machine-payments-sessions-ai-agent-stablecoin-streaming-payments)
- x402 V2 wallet sessions let callers skip repaying per call. `batch-settlement` verifies vouchers off-chain and claims many in one tx — [x402 V2 launch](https://www.x402.org/writing/x402-v2-launch); [CDP facilitator](https://docs.cdp.coinbase.com/x402/core-concepts/facilitator)
- Stripe deposit addresses (`/v1/crypto/deposit_addresses`, network=tempo) auto-offramp stablecoins to the Stripe balance. Stripe recommends keeping address creation off the core request path — [Stripe MPP docs](https://docs.stripe.com/payments/machine/mpp)
- `mppx.charge()` is a fetch-style `Request -> Response` handler and would run in a CF Worker. Cloudflare Workers is listed as an MPP-supporting service (secondary) — [Stripe MPP docs](https://docs.stripe.com/payments/machine/mpp); [signb.ee](https://signb.ee/blog/mpp-is-moving-faster-than-anyone-expected)
- `@x402/hono` exists and Hono runs on Workers. Cloudflare's Agents SDK has `withX402`/`paidTool` — [x402 GitHub](https://github.com/x402-foundation/x402); [CF docs](https://developers.cloudflare.com/agents/x402/charge-for-mcp-tools/)
- Cloudflare Monetization Gateway can convert 401 responses into 402 and price per route/verb at the edge (waitlist) — [Cloudflare blog](https://blog.cloudflare.com/monetization-gateway/)

### Inferences (candidate designs, ranked)

1. **x402/MPP top-up into the credit wallet (recommended first).** When the balance is short, the gateway's 402 adds a standards-compliant `PAYMENT-REQUIRED` (x402) and/or MPP challenge priced at a top-up amount (e.g. $5) or "price of this call + buffer". When the agent pays, Stripe settles to Zevium's balance, a webhook credits the org ledger in Convex, the DO balance refreshes, and the call proceeds. Publisher payout stays on Connect, and the "zero balance blocks" rule holds. Complexity: medium. The 402 body needs x402/MPP-shaped fields, the verify/settle call happens off the normal hot path (only on the 402 path), and Convex needs a webhook. Gotcha: verify/settle requires a network call, so either accept that on the 402 path only or credit asynchronously and ask the agent to retry.
2. **Keyless x402 per-call for anonymous agents ("pay-as-you-go identity = wallet").** Map a payer wallet address to an ephemeral Zevium org with no Clerk signup. Use x402 V2 wallet sessions so later calls hit the DO, not the chain. This beats design 1 for zero-signup agent onboarding (the Tavily pattern), but it needs wallet-to-org identity mapping and conflicts with "every call is key-authenticated" unless the signed wallet session counts as the key.
3. **Per-call on-chain settlement (avoid for now).** Every call pays the facilitator fee and adds latency, and it fails the 0.01 USDC Stripe minimum for sub-cent calls. Batch-settlement mitigates this but adds complexity. It also duplicates the DO's purpose.

- Cards via SPT have a $0.50 minimum, so they work only as top-ups. That overlaps Checkout, but it lets agents with a Link Agent Wallet top up without a human browser session.

### Gaps

- Whether Stripe-accepted x402 payments fire standard `payment_intent.succeeded` webhooks usable for ledger crediting was not confirmed from docs.
- Latency of Stripe x402/MPP verification was not found.

## Q5. Discovery layers attached to payment rails — can Zevium list there or become one?

### Takeaway

Rails now come with discovery. Coinbase's x402 Bazaar auto-indexes endpoints that settle through the CDP facilitator, is public, and ranks by volume, unique payers, and metadata quality. Stripe has a "Directory" for MPP/x402 sellers. Both are noisy or new. Zevium can list its gateway endpoints in both, and can compete as a curated, spec-driven, quality-ranked catalog, which is exactly what Bazaar lacks.

### Cited Findings

- Bazaar is a catalog of payment-gated services discovered by the CDP Facilitator. Discovery is public and needs no API key. Interfaces: CDP SDK `searchX402Resources` / `listX402DiscoveryResources` / `listX402DiscoveryMerchant`, REST, and a Bazaar MCP server where agents search and pay in one client. Filters: network, asset, scheme, `payTo`, URL, max USD price, extension. Max 20 results per search, ranked by relevance plus quality (30-day call volume, unique payers, completeness of descriptions, output schemas, and metadata). Merchant lookup returns all active resources per `payTo` — [CDP Bazaar docs](https://docs.cdp.coinbase.com/x402/bazaar)
- Listing happens after a settled payment through the CDP facilitator. Indexing bugs exist: resources were not indexed 24h+ after real settlements — [Bazaar snapshot, DEV](https://dev.to/tanod/state-of-the-x402-bazaar-34062-listings-2158-hosts-and-94-missing-a-use-when-line-34co); [x402 issue #3677](https://github.com/x402-foundation/x402/issues/3677)
- Bazaar quality is poor: 94% of listings lack a "use when" line, and most have at most 1 payer — [DEV](https://dev.to/tanod/state-of-the-x402-bazaar-34062-listings-2158-hosts-and-94-missing-a-use-when-line-34co). Community explorers and indexers exist (x402scan, bazaar-explorer) — [x402 GitHub](https://github.com/x402-foundation/x402); [x402-bazaar-explorer](https://github.com/nunojsferreira/x402-bazaar-explorer)
- Stripe Directory is "a catalog of tools and services that helps agents find your business". Submission is by email with Stripe account ID, profile ID, `llms.txt` link, agent skills, SPT/stablecoin support, and 1–3 example prompts — [Stripe machine payments](https://docs.stripe.com/payments/machine)
- `mppx validate` checks "discovery" as part of conformance, so MPP has a discovery convention — [Stripe MPP docs](https://docs.stripe.com/payments/machine/mpp)
- x402 V2 added "automatic API discovery" — [x402 V2 launch](https://www.x402.org/writing/x402-v2-launch)

### Inferences (recommendation inputs and steal-worthy ideas)

- **Rail order:** (1) Stripe-hosted x402 (Base USDC) plus MPP as a top-up rail into the existing ledger. One vendor and one compliance posture, and Connect is unchanged. (2) Bazaar and Stripe Directory listings for the gateway. (3) Wallet-session keyless onboarding. (4) Skip L402, AP2, ACP, TAP, and Agent Pay as payment rails for now. Optionally accept TAP/RFC 9421 signatures as an agent-identity signal later.
- **Why x402 plus MPP together:** Stripe supports both through one integration and balance, and `mppx` covers SPT cards plus Tempo/Solana stablecoins. x402 has the larger buyer base: Coinbase Agentic Wallets, Bazaar MCP, Vercel/Cloudflare SDKs, and Tavily-style clients.
- **Bazaar listing feasibility:** auto-listing requires settlement through the CDP facilitator, and Bazaar groups by `payTo`. If Zevium settles through Stripe's x402, it is unverified whether those endpoints appear in Bazaar. Testing needed: one Zevium `payTo` would make all Zevium-proxied APIs look like a single merchant.
- **Steal-worthy ideas:**
  - Bazaar's quality ranking (30-day calls, unique payers, schema completeness), applied to Zevium search ranking.
  - A required "use when" field and output schema on listings. Zevium already derives these from OpenAPI, which is its advantage over Bazaar's 94% gap.
  - Discovery exposed as an MCP server where search and pay happen in one client.
  - Machine-readable 402 bodies with `next_actions` (Tavily) that tell the agent exactly how to pay or top up.
  - An `mppx validate`-style conformance CLI for publishers.
  - `llms.txt` plus example prompts as listing metadata (Stripe Directory).
  - Cloudflare's "401 to 402" rule concept: unauthenticated callers get a payable offer instead of a dead end.
- **Competitive threat:** Cloudflare Monetization Gateway (once GA) lets any CF customer paywall APIs and MCP tools natively with x402. Nevermined targets the same metering niche. Zevium's differentiators: spec-as-source-of-truth pricing, curated discovery, fiat-first credits with a hard zero-balance block, and Connect payouts in fiat.

### Gaps

- Exact Bazaar listing mechanics (the "Get discovered" page was not fetched), whether non-CDP facilitators or aggregators can list many endpoints, and whether listing under one marketplace `payTo` is allowed.
- Stripe Directory size and traffic are unknown.

## Implementation check for #109 (2026-10-10)

Re-read the official [Stripe x402 guide](https://docs.stripe.com/payments/machine/x402) and [MPP guide](https://docs.stripe.com/payments/machine/mpp) during implementation. The x402 guide separates the external CDP facilitator from Stripe: `/verify` and `/settle` send Base USDC to a Stripe-created deposit address; afterward a `transaction_verification` PaymentIntent records the transaction using its hash as the idempotency key (`2026-05-27.preview`). “Stripe-hosted x402” in the earlier recommendation describes where funds land, not a Stripe-hosted `/verify` endpoint. MPP uses a Stripe business profile and a separate protocol/SDK; it must not be advertised merely because x402 is implemented.

Test account probes: Base deposit address creation initially succeeded; business-profile lookup returned `not_found`; the later test-only transaction-verification probe returned `api_key_expired`. No live-money test. Owner activation and a real sandbox journey remain required; [machine-payments](../../features/machine-payments.md) owns those steps.
