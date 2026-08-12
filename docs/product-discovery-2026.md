# Zevium Product Discovery — Historical Research Snapshot

> Research captured 2026-07-11; factual corrections applied 2026-08-12.
> This file records market input available during product discovery. It is not
> current product status, architecture, operating evidence, legal review, or
> external sign-off. PRODUCT.md owns product decisions, FLOW.md owns user
> experience, TECH.md owns current technical decisions, and code wins when it
> disagrees with any document.

## Verified market events available to the research

### Rapid technology acquisition

On 2024-11-13, Nokia announced its acquisition of Rapid's technology assets,
including its public API marketplace, and Rapid's research and development
unit. Nokia described that marketplace as connecting developers to hundreds of
APIs and said financial terms were undisclosed. This primary source does not
establish Rapid's company-wide status, user count, deal price, or future public
marketplace strategy. Earlier language in this report that called the company
collapsed, claimed it was sold for parts, inferred a deal value, or declared a
market slot vacant went beyond the source and is withdrawn.

Source: [Nokia newsroom, 2024-11-13](https://www.nokia.com/newsroom/nokia-acquires-rapid-technology-and-rd-unit-to-strengthen-development-of-network-api-solutions-and-ecosystem/).

### x402 governance timeline

The Linux Foundation announced on 2026-04-02 that the x402 Foundation was being
formed and that Coinbase intended to contribute the protocol. A later
2026-07-14 announcement marked the foundation's operational launch and said
Coinbase's contribution had completed. Treating April's intent announcement as
completed governance transfer was premature.

Sources: [Linux Foundation intent announcement](https://www.linuxfoundation.org/press/linux-foundation-is-launching-the-x402-foundation-and-welcoming-the-contribution-of-the-x402-protocol), [Linux Foundation operational launch](https://www.linuxfoundation.org/press/linux-foundation-announces-operational-launch-of-x402-foundation-to-standardize-internet-native-payments-for-ai-agents-and-applications).

Coinbase's protocol FAQ describes payment-required, payment-signature, and
payment-response headers. That research made x402 relevant as a possible future
rail, not evidence that Zevium supported it. Current product decisions remain in
PRODUCT.md.

Source: [Coinbase x402 FAQ](https://docs.cdp.coinbase.com/x402/support/faq).

### Stripe Machine Payments Protocol

Stripe announced Machine Payments Protocol on 2026-03-18 as an open protocol
for agent-initiated payments. Its announcement covers microtransactions and
recurring payments through PaymentIntents, with stablecoin settlement as well
as existing fiat payment methods such as cards and bank methods. Earlier text
calling it session-based aggregated billing was unsupported and is withdrawn.

Source: [Stripe announcement, 2026-03-18](https://stripe.com/blog/machine-payments-protocol).

### Clerk API keys

Clerk's 2026-04-17 changelog says its API keys became generally available on
2026-04-06. The publication date and availability date are different; earlier
notes conflated them. Pricing and product limits remain vendor-controlled and
must be checked again before a purchasing or launch decision.

Source: [Clerk changelog, 2026-04-17](https://clerk.com/changelog/2026-04-17-api-keys-ga).

### Embedding model lifecycle

At correction time, Google's embeddings documentation describes
`gemini-embedding-2` as a newer model and warns that its vector space is not
compatible with earlier embedding models. This supports a product requirement
for planned re-indexing during model changes; it does not select current
implementation.

Source: [Google Gemini embeddings documentation](https://ai.google.dev/gemini-api/docs/embeddings).

## Product hypotheses produced by the research

These were discovery hypotheses, not claims that features existed:

- Make time-to-first-call a headline onboarding metric.
- Prefer one compact search-then-load agent surface over exposing every tool at
  once.
- Show per-endpoint price before execution.
- Keep published API descriptions versioned and immutable.
- Give consumers balance, per-key, per-endpoint, and projected-spend views.
- Give publishers latency, failure, demand, and earnings views.
- Use strict prepaid blocking to avoid surprise overage.
- Favor curation and quality signals over raw catalogue size.
- Keep any machine-native payment rail separate from prepaid credits until its
  funds flow, disclosures, replay controls, and operational ownership are
  approved.

PRODUCT.md records which hypotheses became product decisions and their
priority. This snapshot must not be used to infer delivery status.

## Superseded research baseline

The repository inspected during the original research used legacy components
and had known defects in its publish and key-issuance loop. Recommendations
about that baseline, including references to Better Auth, Polar, Turso, Redis,
per-project MCP exposure, a 30% platform cut, and manual publisher payouts, no
longer describe current architecture or product policy. They remain omitted
rather than rewritten as present-tense facts. TECH.md contains current
architecture and migration history.

## Evidence limits

This corrected snapshot uses the linked primary vendor or foundation sources
for dated vendor events. It makes no claim that a fixed source count was
reviewed, that independent reviewers voted on claims, or that legal, security,
privacy, finance, or vendor owners approved anything. Market sizes, competitor
catalogue counts, competitor take rates, user counts, protocol transaction
counts, and acquisition-price estimates from the earlier draft were not
re-verified from primary evidence and are intentionally excluded.
