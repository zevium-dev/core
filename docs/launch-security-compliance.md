# Launch security and compliance posture

> Status: repository-evidenced draft, 2026-08-12. This is not legal advice, a
> privacy notice, an audit report, or evidence of certification.
>
> Launch decision: **BLOCKED** until every item in [Human sign-off gate](#human-sign-off-gate)
> has a named human approver and recorded approval. No approval is implied by
> merging this document.

This document records what the repository supports, what remains unknown in
deployed vendor accounts, and what must happen before Zevium handles production
customer data. Code is evidence for implementation controls only. It cannot
prove operating effectiveness, vendor configuration, staff behavior, contracts,
or legal conclusions.

## Evidence and interpretation rules

Research was refreshed on 2026-08-12 against current primary sources. These
sources define questions and control expectations; they do not decide whether a
law applies to Zevium or prove that Zevium satisfies it:

- [EU GDPR official text](https://eur-lex.europa.eu/eli/reg/2016/679/oj),
  especially Articles 5, 12–22, 28, 32–34 and 44–49, anchors minimization,
  storage limitation, data-subject rights, processor contracts, security,
  breach handling and international transfers.
- [EDPB data-subject-rights guide](https://www.edpb.europa.eu/sme/be-compliant/respect-individuals-rights_en)
  anchors an operational intake, identity verification, one-month response
  workflow, recipient follow-up and decision records where GDPR applies.
- [California Privacy Protection Agency laws and regulations](https://cppa.ca.gov/regulations/)
  is the current rulemaking index. Applicability, thresholds, effective rules
  and consumer-request duties require counsel review; an older FAQ is not a
  substitute for the current regulations.
- [HHS business-associate guidance](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/business-associates/index.html)
  and [HHS Security Rule summary](https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html)
  anchor the PHI/BAA analysis and administrative, physical and technical
  safeguards if Zevium ever becomes a regulated entity.
- [NIST SP 800-61 Rev. 3](https://csrc.nist.gov/pubs/sp/800/61/r3/final),
  published April 2025, anchors incident preparation, detection, response and
  recovery within broader cybersecurity risk management.
- [AICPA SOC services](https://www.aicpa-cima.com/resources/landing/system-and-organization-controls-soc-suite-of-services)
  establishes that SOC reports are assurance services performed by CPAs; this
  repository cannot create an examination or report.

Vendor public terms and marketing are due-diligence inputs only. For every
vendor, preserve the terms/DPA version that binds the actual account, plan and
entity; configuration exports; region and retention settings; current
subprocessor list; reviewer; review date; and renewal/change-monitoring record.
A live web page or repository link is not contract acceptance or operating
evidence.

## Accountability

The accountable role is **Security & Privacy Owner**. That role is currently
**unassigned in this repository**. A named human must accept it before launch.
The role owns this register, risk acceptance, DSR coordination, incident
coordination, access reviews, subprocessor review, and collection of sign-offs.
Engineering Lead owns technical remediation. Legal/Privacy Counsel owns legal
bases, notices, contracts, retention approval, jurisdiction decisions, and
regulatory notification decisions. Finance/Payments Owner owns Stripe and funds
flow controls. Operations Lead owns on-call and recovery exercises.

## System and data-flow boundary

Production source currently declares these services:

- Cloudflare Workers hosts web and gateway code. Direct `/gateway` request and
  response bodies stream through Cloudflare to publisher-controlled upstream
  APIs. MCP `call_api` reuses that metered path but buffers its JSON-RPC request
  and upstream response in Worker memory with explicit 1 MiB limits because the
  tool result embeds the response body.
- Cloudflare Durable Objects holds each consumer organization's working wallet,
  reservations, pending usage, key-control cache, free-tier counters, and
  reconciliation state.
- Convex stores application/control-plane records, ledger data, usage records,
  webhook delivery records, encrypted publisher credentials, and vector data.
- Clerk is authentication, session, user, organization, membership, invitation,
  and API-key authority. Convex mirrors selected user and organization fields.
- Stripe Checkout and Connect process credit purchases, identity/KYC, connected
  accounts, transfers, disputes, refunds, and bank payouts. Zevium stores Stripe
  identifiers and event projections, not card or bank-account numbers.
- Current `402` responses are generic prepaid-credit error envelopes containing
  a safe reason, request ID, and create-key/top-up/docs actions. They contain no
  x402 payment requirements, accept no signed payment, and perform no
  facilitator or onchain settlement. No x402 feature flag, payment Durable
  Object, facilitator client, payment-signature verifier, chain configuration,
  or Convex settlement table exists in this tree. x402 remains future P1 work.
- Server-side spec import requires a signed-in member with an active
  organization, exact same-origin request, and an organization/member rate
  lease before fetching a user-selected HTTPS URL. DNS/private-IP and redirect
  checks run for every hop. Accepted responses must advertise JSON, YAML, or
  plain-text spec media types. The destination receives the request URL
  (including path/query), source network metadata, and a narrow OpenAPI
  `Accept` header. Zevium buffers at most 2 MiB for 10 seconds and returns it to
  the editor. A rate-lease counter is stored; spec content is not stored until
  the user separately saves a draft.
- Google Gemini receives text assembled from project name, description, tags,
  and published OpenAPI endpoint paths/summaries for catalogue embeddings. It
  also receives each free-text semantic catalogue search query.
- Publisher upstream APIs receive consumer-selected gateway paths, query
  strings, filtered headers, and request bodies. Publisher response bodies and
  filtered headers stream back through the gateway.
- Publisher-configured webhook endpoints receive signed Zevium event payloads.
- GitHub and Blacksmith run source CI/deployment workflows. They should not
  receive production customer records, but repository and workflow metadata are
  in scope for access review.
- User browsers store theme preference in `localStorage`, sidebar state in a
  seven-day cookie, and a pasted playground API key in `sessionStorage`. Clerk's
  browser SDK separately manages authentication/session state under its service
  contract.

Cloudflare, Convex, Clerk, Stripe, Google, GitHub, Blacksmith, and user-selected
spec-import destinations have locations, retention settings, terms, regional
configuration, support-access settings, and subprocessors that are deployment,
account, or recipient evidence—not facts proved by this repository. Future x402
vendors and networks are not current recipients and must be inventoried again
against exact implementation and contracts before activation.

## Data inventory

Inventory labels are **Public**, **Customer confidential**, **Personal**,
**Financial**, and **Secret**. A field can have more than one label; “possible”
means free-form content can raise the classification above its intended schema.

| Data class                              | Exact data                                                                                                                                                                             | Purpose and flow                                                | Store / recipient                                                                                                              | Current repository lifecycle                                                                                                                                                                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User identity                           | Clerk user ID, display name, email; Clerk also owns login identifiers, credentials, OAuth links, verification and MFA/session data                                                     | Authenticate users and render profiles                          | Clerk; ID/name/email mirror in Convex `users`                                                                                  | Convex mirror is deleted on `user.deleted`; Clerk lifecycle and backups are vendor-configured; no DSR export workflow exists                                                                                                                                                                 |
| Organization identity                   | Clerk org ID, name, slug, image URL, public handle; Clerk membership, role and invitation data                                                                                         | Tenant routing, authorization, catalogue identity               | Clerk; selected mirror in Convex `organizations`                                                                               | Org webhook currently deletes only wallet entries, wallet, and org row; related app/payment/usage records are not comprehensively erased                                                                                                                                                     |
| Project/listing                         | Project name, slug, description, tags, visibility/status, upstream origin, readiness result, draft and immutable published OpenAPI documents, deprecation reason/times                 | Publish and route APIs                                          | Convex; public listings/spec-derived material goes to browsers and gateway caches                                              | Project delete removes project, draft, versions and upstream credentials, but currently leaves readiness, embedding, webhook, usage and earnings records; no global schedule or backup-erasure proof                                                                                         |
| Embedding input/output                  | Public project name, description, tags, endpoint methods, paths and summaries; free-text catalogue search queries; 768-dimension vectors                                               | Semantic catalogue search                                       | Google Gemini receives source/query text; Convex `specEmbeddings` stores source text/vector, not search queries                | Rebuilt on publish; no time-based expiry; search queries are not intentionally stored in app tables; Gemini service tier, request logging/retention, location and deletion remain unverified                                                                                                 |
| Publisher upstream credentials          | Header name, encrypted value, IV, encryption-key version, update time; transitional schema can still represent legacy plaintext                                                        | Inject publisher auth after consumer auth is stripped           | Convex `upstreamCredentials`; decrypted value delivered to Cloudflare gateway and publisher upstream                           | New writes use AES-GCM. Production must prove migration counts are zero, make ciphertext fields required, remove plaintext field, and document key rotation before claim is relied on                                                                                                        |
| Consumer API keys                       | API-key secret, key ID, subject/org, scopes, expiry/revocation; cap, disabled state, rotation linkage and grace period                                                                 | Authenticate/gate calls and attribute usage                     | Clerk stores key authority/secret; Convex stores key metadata/rotation operations; Cloudflare caches verification and controls | Secret is copy-once through Clerk flow; playground can retain a pasted key in browser `sessionStorage`; vendor retention, coordinated cache purge and user-level deletion procedure are not documented                                                                                       |
| Browser-local state                     | Theme value; sidebar expanded boolean; pasted playground API key; Clerk-managed auth/session state                                                                                     | Remember presentation, playground credential and login          | User browser `localStorage`, cookie and `sessionStorage`; Clerk browser SDK                                                    | Theme remains until cleared; sidebar cookie requests seven days; playground key follows browser session-storage lifecycle or explicit field clear. No remote app-table purge can erase device-local copies; user-facing clear instructions are absent                                        |
| Spec import (transient)                 | User-selected HTTPS URL including path/query; DNS resolution, source IP/network and request metadata; redirect targets; response content type and up to 2 MiB of returned OpenAPI text | Fetch a spec server-side for the authenticated editor           | Cloudflare web runtime and each user-selected external host; returned text transits to browser memory                          | Requires auth, active org/member context, exact Origin, durable rate lease, safe redirect targets, approved MIME, 10-second timeout and 2 MiB cap. Content is not intentionally stored during fetch; platform/destination logs and retention remain unverified; later draft save is separate |
| Operational control state               | Upstream readiness origin/hash/revision/time; key-rotation user/key IDs, operation state, failure and grace times; spec-import org/user rate window, count and expiry                  | Gate publishing, make key rotation idempotent and bound imports | Convex `publishReadiness`, `keyRotationOperations` and `specImportRateLeases`                                                  | Import leases expire logically after one minute but have no cleanup job; other rows have no fixed expiry. Project/user/org deletion does not comprehensively remove these rows                                                                                                               |
| Gateway request                         | Request ID; publisher/project route; path and query; method; filtered request headers; body                                                                                            | Proxy consumer call to publisher                                | Transits Cloudflare and publisher upstream; Cloudflare platform metadata may include IP, user agent, timing and network data   | App code does not persist body or arbitrary headers. Direct `/gateway` bodies stream; MCP JSON-RPC request/body is buffered in memory up to 1 MiB. Observability retention/redaction remains unverified                                                                                      |
| Gateway response                        | Status, filtered headers, response body, latency, request ID                                                                                                                           | Return publisher result and meter outcome                       | Transits publisher upstream and Cloudflare to consumer                                                                         | App code does not persist body. Direct `/gateway` response streams; MCP `call_api` buffers up to 1 MiB in memory. `set-cookie`, auth and hop-by-hop headers are stripped; observability/account logs remain unverified                                                                       |
| Usage and key attribution               | Consumer org ID, publisher org/project ID, key ID, method, normalized endpoint template, status, latency, credits, timestamp, settlement/request reference and outcome                 | Credit ledger, billing, consumer/publisher analytics, support   | Cloudflare logs and Durable Object pending state; Convex `usageEvents`, wallet and earnings tables                             | Stored without fixed expiry. Console usage logs duplicate these fields when production Convex is configured. No IP/body is intentionally included by app logger                                                                                                                              |
| Wallet/ledger                           | Balance, sequence, entry kind/amount/reference, payment/usage links, reservations, grants, free-tier counters, settlement state                                                        | Enforce prepaid spend and reconcile accounting                  | Convex `wallets`/`walletEntries`; Cloudflare Durable Objects                                                                   | Convex ledger and DO state have no approved expiry. Deletion must preserve legally required financial evidence while severing user identifiers where allowed                                                                                                                                 |
| Checkout/payment                        | Pack, amount, currency, credits, Checkout Session/PaymentIntent/Charge/Customer IDs, event/object/account IDs, status, failures, refunds and disputes                                  | Sell credits and reconcile payments                             | Stripe; projections in Convex checkout/payment/event tables                                                                    | Hosted Checkout keeps raw card data out of app schema. Records have no repository-enforced retention or pseudonymization schedule                                                                                                                                                            |
| Current `402` error metadata (not x402) | Request ID, human-safe reason, optional available balance/cost, and static create-key/top-up/docs links                                                                                | Explain why prepaid-credit execution was blocked                | Returned to caller; ordinary Cloudflare response/log processing may apply                                                      | No payment authorization or settlement data exists. App tables do not persist the envelope as a distinct record; request/usage logging described elsewhere can still apply                                                                                                                   |
| Publisher KYC/payout                    | Connected Account ID, requirements, capability/status flags, transfer/payout IDs, amounts, currency, arrival/failure data                                                              | Publisher onboarding and payout                                 | Stripe holds identity, tax, bank and KYC evidence; Convex stores IDs/status projections                                        | Stripe retention/legal duties apply; repository has no approved schedule or closed-account runbook                                                                                                                                                                                           |
| Earnings                                | Publisher org/project, usage settlement reference, gross/platform/net credits, availability/state, transfer link and timestamps                                                        | 95/5 marketplace accounting                                     | Convex                                                                                                                         | No fixed expiry; likely financial-record retention, subject to counsel decision                                                                                                                                                                                                              |
| Notifications                           | Org ID, type, title, body, reference, read/create times                                                                                                                                | In-app operational notices                                      | Convex                                                                                                                         | No fixed expiry or per-user preference model                                                                                                                                                                                                                                                 |
| Publisher webhooks                      | Endpoint URL, signing secret, active state; event payload, attempts, error and timestamps                                                                                              | Notify publisher systems                                        | Convex; payload delivered to publisher-chosen endpoint                                                                         | Secret is stored as plaintext in Convex. Delivery logs/payloads have no expiry; delete endpoint does not delete prior delivery rows                                                                                                                                                          |
| Administrative access                   | Admin Clerk user IDs in environment allowlist; admin reads/actions over orgs, projects, usage and payouts                                                                              | Platform operations                                             | Convex environment and functions; vendor/provider audit logs if enabled                                                        | Server-side gate exists. No repo-owned admin action audit table, access-review cadence, JIT process, or production allowlist evidence                                                                                                                                                        |
| Vulnerability reports                   | Reporter contact and reproduction details, potentially test identifiers                                                                                                                | Triage and remediate security reports                           | GitHub private vulnerability reporting                                                                                         | GitHub retention/access settings govern it; reporters are told not to include credentials or personal data                                                                                                                                                                                   |

| Data class                     | Inventory labels                                                                |
| ------------------------------ | ------------------------------------------------------------------------------- |
| User identity                  | Personal; Customer confidential; Secret for credentials/session factors         |
| Organization identity          | Public for published identity; Personal and Customer confidential otherwise     |
| Project/listing                | Public when published; Customer confidential while private; Personal possible   |
| Embedding input/output         | Public source text; Personal or Customer confidential search query possible     |
| Publisher upstream credentials | Secret; Customer confidential                                                   |
| Consumer API keys              | Secret; Personal attribution; Customer confidential                             |
| Browser-local state            | Secret for pasted key/auth; Personal; preference values                         |
| Spec import (transient)        | Customer confidential; Personal, Financial, Secret or Public content possible   |
| Operational control state      | Customer confidential; Personal for user attribution                            |
| Gateway request/response       | Customer confidential; Personal, Financial or Secret content possible           |
| Usage and key attribution      | Customer confidential; Personal; Financial                                      |
| Wallet/ledger                  | Financial; Customer confidential; Personal attribution possible                 |
| Checkout/payment               | Financial; Personal; Customer confidential                                      |
| Current `402` error metadata   | Customer confidential; Financial for balance/cost values; not x402 payment data |
| Publisher KYC/payout           | Personal; Financial; Secret                                                     |
| Earnings                       | Financial; Customer confidential                                                |
| Notifications                  | Customer confidential; Personal or Financial content possible                   |
| Publisher webhooks             | Secret for signing key; Customer confidential; Personal/Financial possible      |
| Administrative access          | Secret for allowlist/config; Personal; Customer confidential access capability  |
| Vulnerability reports          | Customer confidential; Personal; Secret content possible                        |

### Future x402 planning inventory—not current collection

No row below describes data currently collected, stored, or sent. No named
facilitator/network is selected, and exact fields cannot be approved before code
exists. Coinbase's current x402 FAQ describes a `402` price response followed by
a client retry with a signed payment; its CDP integration uses facilitator
credentials for verification/settlement. Any future Zevium design must replace
this planning row with exact-tree fields and tested recipients before activation.

| Possible future class             | Conditional data to inventory if implemented                                                                                                                                                                                                 | Required evidence before collection                                                                                                                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| x402 authorization and settlement | Payment requirements; signed authorization; payer/payee, asset/network/amount, expiry/nonce; request-resource binding; facilitator verification/settlement responses; transaction/replay/accounting identifiers; any wallet or onchain facts | Exact schemas/code/config; selected facilitator and network; recipient contracts and privacy facts; method/body/query disclosure; replay/retention/deletion controls; funded end-to-end and failure tests; counsel/Finance/Security approvals |

### Data deliberately not stored by application tables

- Raw payment-card numbers, CVCs, and publisher bank-account numbers.
- Gateway request bodies, response bodies, arbitrary request headers, consumer
  cookies, or publisher `set-cookie` response headers.
- Consumer API-key secret values in Convex tables.
- Generic current `402` envelopes contain no signed payment or settlement data.

These are narrow architecture statements, not PCI, privacy, or security
certifications. Vendor telemetry can still process network/request metadata and
must be checked separately.

Free-form project fields, OpenAPI documents, catalogue searches, gateway
payloads, webhook payloads and failure strings must be treated as potentially
personal, confidential or sensitive even when their intended schema is not.
Data labels describe intended use; they are not content inspection or DLP.

## Subprocessors and external recipients

No vendor may be represented as approved from this list alone.

| Party                          | Role / data                                                                                                                   | Pre-launch evidence required                                                                                                                                                                  | Owner                                    | Status                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare                     | Web/gateway host, edge network metadata, streamed content, Durable Object state, logs                                         | DPA, region/options, log retention/redaction, staff access, incident terms, deletion/export path, current subprocessor list                                                                   | Security & Privacy Owner                 | Blocked—account evidence absent                                                                                                                                                                                                                                                                                                       |
| Convex                         | Primary application database/functions/vector store and function logs                                                         | DPA, selected region, backups/retention, restore/deletion, support access, audit logs, incident terms, subprocessors                                                                          | Engineering Lead                         | Blocked—account evidence absent                                                                                                                                                                                                                                                                                                       |
| Clerk                          | Auth, users/orgs/memberships, sessions, MFA, API keys                                                                         | Applicable DPA/version; processor versus independent-controller role allocation; auth/MFA/admin settings; retention/deletion/export; breach terms; subprocessors                              | Security & Privacy Owner                 | Blocked—public DPA describes both roles and post-termination deletion, but actual account, settings and contract evidence are absent                                                                                                                                                                                                  |
| Stripe                         | Checkout, payments, disputes, Connect KYC/transfers/payouts                                                                   | Signed services terms/DPA; Stripe processor/controller role allocation and notices; Connect platform obligations; retention; restricted-key/RBAC review; webhook config; country availability | Finance/Payments Owner                   | Blocked—public DPA describes both processor and controller activities; account, entity, product and legal evidence are absent                                                                                                                                                                                                         |
| Google Gemini                  | Published catalogue embedding input and free-text semantic search queries                                                     | Active billed Cloud Project/paid-service proof; applicable DPA; request-log duration/location; no-product-improvement terms; region; data minimization and prohibited-use review              | Engineering Lead                         | Blocked—current Gemini terms say unpaid submissions may be used for product improvement and human review, EEA/Swiss/UK API clients must use paid services, and paid prompts/responses are logged for a limited period and may be transiently stored/cached wherever Google or its agents maintain facilities; account evidence absent |
| GitHub                         | Source, vulnerability reports, CI metadata and secrets handoff                                                                | Org MFA, least privilege, review policy, audit-log retention, secret-scanning settings, DPA/terms                                                                                             | Engineering Lead                         | Partial—default branch requires a PR and blocks deletion/non-fast-forward updates, but requires zero approving reviews and no status checks, CODEOWNER review, thread resolution or last-push approval; org evidence absent                                                                                                           |
| Blacksmith                     | Hosted CI runners and build metadata                                                                                          | DPA/terms, runner isolation, log/artifact retention, network/secrets handling, subprocessors                                                                                                  | Engineering Lead                         | Blocked—contract/account evidence absent                                                                                                                                                                                                                                                                                              |
| Each publisher upstream        | Independent recipient of consumer-selected request data; role depends on contract and processing facts                        | Publisher terms/DPA allocation, listing disclosures, prohibited-data rules, abuse contact and takedown path                                                                                   | Legal/Privacy Counsel                    | Blocked—contract model absent                                                                                                                                                                                                                                                                                                         |
| Publisher webhook destination  | Publisher-selected recipient of event payloads                                                                                | Payload inventory, tenant warning, deletion/retry behavior, SSRF review                                                                                                                       | Engineering Lead                         | Partial—URL validation/signing exist; governance absent                                                                                                                                                                                                                                                                               |
| User-selected spec-import host | Import URL path/query, source network/request metadata, redirect requests, and transient returned OpenAPI content up to 2 MiB | User warning and purpose limitation; destination terms/privacy responsibility; egress/log review; SSRF/auth/origin/rate/MIME tests; content-handling and deletion evidence                    | Engineering Lead + Legal/Privacy Counsel | Partial—member auth, strict Origin, durable rate lease, HTTPS, dual-family DNS/non-public-address, redirect, approved MIME, total timeout and size controls exist; arbitrary destination governance, platform logging, lease cleanup and user notice are absent                                                                       |

### Future x402 recipients—not current subprocessors or recipients

No facilitator, wallet provider, chain, RPC, sequencer, explorer, or settlement
store is used by current code. If P1 work starts, owners must select and inventory
each exact party and public-network disclosure before any funded test. Coinbase's
current documentation describes CDP facilitator credentials and signed-payment
settlement; it does not prove Zevium has an account, contract, approved wallet,
or implementation.

| Possible future party                         | Conditional review required                                                                                                                   | Status                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Selected x402 facilitator/wallet operator     | Entity, credentials, payment fields, screening, countries, terms/privacy/DPA, logs/retention, incidents, deletion, subprocessors, funded test | Not selected; no current integration |
| Selected network and infrastructure providers | Public transaction fields, wallet ownership, RPC/sequencer/explorer recipients, sanctions/regulatory/tax analysis, notice and erasure limits  | Not selected; no current integration |

Before adding a party: record purpose, data, countries, legal mechanism, DPA,
security review, deletion/return terms, incident notice, owner, approval date, and
public-notice impact. Security & Privacy Owner reviews the register at least
quarterly and before material data-flow changes. This cadence is a required
future control, not evidence that reviews have occurred.

Public vendor materials reviewed on 2026-08-12: [Cloudflare DPA](https://www.cloudflare.com/cloudflare-customer-dpa/),
[Convex DPA](https://www.convex.dev/legal/dpa),
[Clerk DPA](https://clerk.com/legal/dpa),
[Stripe DPA](https://stripe.com/legal/dpa), and
[Gemini API terms](https://ai.google.dev/gemini-api/terms). Future x402 planning
used the [current Coinbase x402 FAQ](https://docs.cdp.coinbase.com/x402/support/faq),
which describes signed-payment retry, facilitator settlement, CDP facilitator
credentials, and Base Sepolia testing. It is protocol/vendor research only: no
facilitator, wallet, network, account, contract, plan, or configuration is
selected or approved for Zevium. Current vendor rows remain `UNVERIFIED FOR
ACCOUNT` until assigned owners record the applicable entity, accepted version,
service scope, configuration and approval evidence.

## Retention schedule: proposed, not yet enforced

Legal/Privacy Counsel and Finance/Payments Owner must approve exact periods per
supported jurisdiction. Until then, production data collection must not start.

| Record                                | Proposed rule                                                                                                     | Current enforcement gap                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| User profile mirror                   | Active account; erase within 30 days of verified deletion unless hold applies                                     | Clerk webhook deletes Convex user mirror, but vendor/backups and case evidence are not coordinated                  |
| Org/project/draft/credentials         | Active service plus 30-day recovery window, then erase; public immutable versions require contract/legal decision | No soft-delete/recovery lifecycle; org cascade is incomplete; backups unverified                                    |
| Gateway payloads                      | No intentional application persistence                                                                            | Must verify Cloudflare log/body capture settings and publisher responsibilities                                     |
| Usage/security logs                   | 30 days searchable, up to 90 days restricted archive if justified                                                 | Cloudflare/Convex log retention not configured in repo; usage tables never expire                                   |
| Detailed usage attribution            | 13 months, then aggregate or delete key/user identifiers                                                          | No cron or aggregation/de-identification job                                                                        |
| Wallet/payment/earnings/payout ledger | Jurisdiction-specific financial/statutory period, then delete or irreversibly de-identify                         | No approved period, legal-hold flag, pseudonymization, or purge job                                                 |
| Spec import transient data            | No intentional application persistence; vendor/runtime minimum needed to fetch and secure service                 | Cloudflare/runtime and arbitrary destination logging/retention are unverified; no user notice or recipient schedule |
| Webhook delivery payload/error        | 30 days                                                                                                           | No purge job; orphaned deliveries can remain after endpoint deletion                                                |
| API-key metadata/cache                | Active key plus 30 days for security investigation; secret per Clerk policy                                       | No coordinated purge; Durable Object key/free-tier state lacks deletion workflow                                    |
| Browser-local state                   | Theme until user clears it; sidebar seven days; pasted playground key for browser session only                    | No explicit clear-all control or user instructions; browser restore/extension/device behavior is outside app proof  |
| Semantic search query                 | No intentional app-table persistence; vendor minimum needed to provide/secure service                             | Gemini paid-service status, logging period/location and deletion evidence unverified; no sensitive-query warning    |
| DSR and incident case record          | Minimum necessary proof for approved legal period                                                                 | No case system or schedule                                                                                          |

Future x402 retention is intentionally unset. Exact authorization, replay,
settlement, wallet, facilitator, application-table and public-network records
must be identified from implemented code before counsel can approve periods or
erasure limitations. No current `x402TestnetSettlements` table or payment Durable
Object exists.

Do not claim these periods publicly until jobs, vendor settings, tests, and
operating evidence match them.

## Deletion and data-subject-request procedure

This procedure is executable only after intake channel, case system, named
owners, vendor permissions, and legal schedule exist.

1. **Intake.** Receive access, correction, deletion, portability, restriction,
   or objection request through approved privacy channel. Current repository has
   no published privacy address; this blocks launch.
2. **Verify.** Authenticate requester using existing Clerk session and org
   authority. For locked-out users, use a counsel-approved recovery check. Never
   request password, full API key, card number, or publisher bank data.
3. **Open case.** Record request type, scope, jurisdictions, received/deadline
   times, verifier, assigned Security & Privacy Owner, systems searched,
   exemptions/holds, actions and delivery proof. Restrict case access.
4. **Scope identities.** Resolve Clerk user/org IDs, Convex IDs, Stripe customer
   and connected-account IDs, API-key IDs, project IDs, wallet, usage/payment/
   earning references, Cloudflare Durable Object namespace, vulnerability cases,
   publisher/webhook recipients, spec-import destinations where logs are
   obtainable, key-rotation rows, and device-local storage instructions. If a
   future x402 rail is implemented, extend this step from its then-current data
   inventory; do not assume any present table or Durable Object name.
   Search by canonical IDs, never email alone.
5. **Preserve only approved holds.** Legal/Privacy Counsel documents statutory
   financial retention, dispute, fraud, security or litigation holds. Separate
   held records and restrict access; do not use a hold as blanket refusal.
6. **Access/export.** Export responsive records from Clerk, Convex, Stripe,
   Cloudflare logs/DO state, relevant spec-import destination records where
   obtainable, and support/security systems. A future x402 export must separate
   Zevium-held, facilitator-held and any immutable public-network facts based on
   exact implementation. Exclude other tenants, secrets, payment signatures, wallet-signing
   material, internal abuse signals, and privileged material after counsel review. Deliver through an
   authenticated, expiring channel.
7. **Correct.** Correct Clerk source fields first, allow verified webhook sync,
   then correct eligible app metadata. Append accounting corrections; do not
   rewrite append-only ledger history.
8. **Delete/de-identify.** Revoke sessions/API keys; remove Clerk user/org data
   when authorized; delete Convex personal mirror and tenant data; purge gateway
   cache/DO state; request Stripe and other current-recipient deletion where
   allowed; delete webhook
   destinations/payloads; provide instructions to clear browser-local keys and
   preferences; notify publisher/spec-import recipients when contract/law
   requires. Any future public-chain limitation must be documented from the
   selected network before use; no current Zevium x402 transaction exists.
   Retained finance/security rows must replace direct user/key identifiers with
   irreversible case-scoped tokens where feasible.
9. **Verify.** Re-query every system and record vendor confirmations. Current
   `organization.deleted` code is not sufficient verification because it leaves
   related rows; use no automated org-deletion claim until cascade tests pass.
10. **Respond.** Legal/Privacy Counsel selects statutory deadline and response
    content. Internal target: finish within 30 calendar days when applicable,
    without representing that target as universal law.
11. **Close and sample.** Record outcome and retained categories/reasons. Security
    & Privacy Owner samples closed cases quarterly after launch.

Never run ad hoc database deletion against production without scoped IDs,
reviewer confirmation, export/hold decision, dry-run counts, and post-delete
verification. Financial history and immutable published material need explicit
policy decisions before delete automation is built.

## Incident response

### Roles and contact readiness

- Incident Commander: assigned by Operations Lead; **no named human recorded**.
- Security lead: Security & Privacy Owner; **unassigned**.
- Technical lead: Engineering Lead; **no named human recorded**.
- Legal/regulatory lead: Legal/Privacy Counsel; **no named human recorded**.
- Payments lead: Finance/Payments Owner; **no named human recorded**.
- Communications/customer support lead: **unassigned**.

No production launch until a private call tree, 24/7 escalation method, vendor
security contacts, status/customer channels, and backups are tested.

### Severity and response targets

| Severity | Example                                                                                                | Internal target                                                          |
| -------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| SEV-0    | Active cross-org access, credential/payment compromise, ledger bypass, destructive widespread incident | Page immediately; commander and containment work start within 15 minutes |
| SEV-1    | Confirmed limited data exposure, auth degradation, material funds/availability risk                    | Page within 30 minutes; containment plan within 1 hour                   |
| SEV-2    | Contained vulnerability or degraded control without known exposure                                     | Assign same business day                                                 |
| SEV-3    | Low-risk weakness or policy gap                                                                        | Track in normal remediation queue                                        |

These are objectives, not measured historical performance or customer SLAs.

### Runbook

1. Open restricted incident record; assign commander, severity, scribe and clock.
2. Preserve relevant Cloudflare, Convex, Clerk, Stripe, GitHub and CI evidence;
   if a future x402 rail is implemented, preserve its then-inventoried
   facilitator, wallet, replay, settlement and public-network evidence. Record
   timestamps and access. Do not copy secrets, signatures, private keys, full
   payment payloads, or customer payloads into chat/tickets.
3. Contain with smallest reversible action: revoke key/session/token, disable
   integration, delist project, stop deployment, rotate scoped secret, or block
   affected route. A future x402 runbook must define a tested kill switch,
   wallet/key custody, ambiguous-settlement handling, provider contacts and
   replay rules before activation. Protect ledger evidence before financial correction.
4. Determine affected data, tenants, time window, actors, geography, vendors,
   funds and safety impact. Treat request/response content as potentially
   sensitive even though app tables do not store it.
5. Eradicate root cause, add regression coverage, review adjacent paths, and
   restore from known-good state. Reconcile wallet/Stripe facts before reopening.
6. Legal/Privacy Counsel decides regulator, customer, law-enforcement, insurer,
   payment-network and contract notifications and deadlines. Never infer a
   universal breach-notice period from this document.
7. Communicate confirmed facts, impact, mitigations and next update time. Do not
   make certification, attribution, or “no data accessed” claims without evidence.
8. Within five business days of stabilization, complete blameless review with
   timeline, control failures, owners/dates and evidence links. Track actions to
   closure and update this posture.

This runbook maps to NIST SP 800-61 Rev. 3's preparation, detection, response
and recovery model only at design level. Pager evidence, detection sources,
decision authority, communications channels, recovery exercises and retained
records are still missing.

Public vulnerability intake and acknowledgement objective remain in
[`SECURITY.md`](../SECURITY.md). Vulnerability intake is not a substitute for an
internal incident channel.

## Least privilege, access and audit gaps

Repository-supported controls:

- Convex functions resolve identity and org claims server-side; sensitive org
  mutations use member/admin gates.
- Platform admin functions use a server-side Clerk user-ID allowlist.
- CI/deploy workflows declare `contents: read`; production deploy follows green
  CI on `develop` and uses environment secrets.
- Gateway strips consumer authorization, API-key, cookie and Cloudflare network
  headers before publisher forwarding; publisher cookies are stripped on return.
- Stripe/Clerk webhooks verify signatures; publisher webhooks are HMAC-signed.
- Gateway internal endpoints use shared-secret comparison; credentials encrypt
  with versioned AES-GCM keys.
- Generic current `402` responses expose only prepaid-credit recovery actions;
  they do not verify or settle payments.

Launch gaps:

- No evidence of MFA enforcement, SSO, JIT access, break-glass controls, quarterly
  reviews, offboarding SLA, or least-privilege roles in vendor accounts.
- `ADMIN_USER_IDS` is coarse and environment-managed; no app admin action audit
  trail or approval workflow exists.
- GitHub ruleset `7681356`, re-read through `gh api` on 2026-08-12, requires pull
  requests and blocks deletion and non-fast-forward updates on `develop`, but
  requires zero approvals, no required status checks, no CODEOWNER review, no
  thread resolution, and no last-push approval. No bypass actors are configured,
  but no evidence of signed-commit enforcement, secret-scanning configuration,
  or production environment reviewers was collected.
- Manual `format-fix` workflow grants `contents: write` and pushes formatted
  changes. Scope, branch restrictions, actor review and audit evidence need
  explicit approval even though protected `develop` currently requires a PR.
- Cloudflare observability logs detailed usage identifiers; retention, access,
  redaction, alerting and export are not repository-controlled.
- Convex function/vendor audit-log availability and retention are unverified.
- Publisher webhook signing secrets are plaintext at rest.
- Legacy upstream plaintext compatibility remains in schema until migration and
  tightening complete.
- Shared production secrets have no documented rotation cadence, dual-control,
  inventory, ownership, expiry or tested emergency rotation.
- No x402 implementation, selected facilitator/network, wallet custody model,
  kill switch, replay/retention design, alerting, or funded reconciliation
  exercise exists. P1 activation stays blocked until all are designed, tested,
  inventoried and approved against exact code.
- No formal asset inventory, endpoint inventory, data-classification enforcement,
  vulnerability scanning/SAST/DAST, penetration test, SIEM, anomaly alerting,
  backup restore test, RTO/RPO, or disaster-recovery exercise evidence.

## Supported-jurisdiction decision rubric

Current decision: **no launch jurisdiction is approved by this repository**.
Marketing availability, Stripe technical availability, company formation, and
lawful service availability are separate decisions.

Customer residence, publisher residence, Zevium contracting entity, Stripe
platform/connected-account countries, publisher upstream location, vendor data
location and where staff access data are separate inputs. A country appearing in
a vendor availability list does not approve any of them.

Legal/Privacy Counsel must create one signed row per launch country/region and
score each item Pass / Restricted / Fail / Unknown:

1. Zevium entity may sell marketplace credits and intermediate publisher funds;
   money-transmission, stored-value, marketplace, tax and invoicing analysis done.
2. Stripe Checkout/Connect model and required capabilities support platform and
   publisher countries; sanctions/export controls and restricted-business rules
   pass.
3. Controller/processor roles for Zevium, consumers, publishers and vendors are
   documented; privacy notice, terms, DPA and publisher agreement match them.
4. Lawful bases, consent/cookie requirements, DSR rights/deadlines, age/minor
   rules, automated-decision rules, and direct-marketing rules are handled.
5. Convex region and all onward transfers have approved mechanisms; vendor DPAs,
   transfer assessments and subprocessors are accepted.
   Gemini is either disabled or proven to use a paid service through an active
   billed Cloud Project; current terms require paid services for API clients
   available in the EEA, Switzerland or the UK.
6. Retention, deletion, legal hold, breach-notification and regulator-contact
   rules are executable in systems and runbooks.
7. Data categories permitted through marketplace APIs are defined; health,
   biometric, precise location, government ID, child, criminal and other
   sensitive data are blocked unless separately approved.
8. Customer support, incident response, language, accessibility and consumer
   cancellation/refund obligations can be met.
9. Insurance and contractual liability requirements are accepted by accountable
   executives.
10. If future x402 activation is proposed, counsel and Finance approve wallet
    ownership, sanctions screening, tax/accounting treatment,
    custody/money-transmission and digital-asset questions, public-chain notice,
    selected facilitator/network terms, and exact product boundary. Technical
    availability is not legal availability.

Any Fail or Unknown means unsupported. Restricted needs exact product/contract
guardrail and owner. Security & Privacy Owner records decision; Legal/Privacy
Counsel and Finance/Payments Owner sign it; accountable executive accepts
residual risk.

## HIPAA and sensitive-data prohibition

Zevium is **not approved for Protected Health Information (PHI)** and must not be
marketed or used as HIPAA compliant, HIPAA ready, or suitable for PHI. Do not
enter PHI into accounts, organization/project metadata, OpenAPI specs, gateway
requests, URL paths/query values, webhook payloads, support, logs, payment
descriptions, wallet labels, transaction metadata, or any future x402 resource.

This is a product prohibition broader than a legal conclusion. It does not mean
every health-related datum is PHI or that HIPAA applies to every party. Qualified
counsel must determine covered-entity/business-associate roles and applicable
rules. Independently, current Gemini API terms prohibit use in clinical practice,
medical advice, or regulated medical-device use, so vendor-contract review is
required even where HIPAA does not apply.

Removing this prohibition requires, at minimum: counsel-approved role analysis;
signed BAAs with every required vendor and customer/counterparty; verified vendor
HIPAA-eligible services/configuration; risk analysis; policies and workforce
training; access/audit controls; encryption and key management; backup/restore;
incident/breach procedures; data minimization; retention/deletion controls; and
independent validation. A BAA alone is insufficient.

Until a product control can technically reject PHI, terms, onboarding, publisher
agreement and acceptable-use policy must prohibit it and Security & Privacy Owner
must approve monitoring/enforcement. Those documents do not yet exist here.

## SOC 2 Trust Services Criteria gap matrix

Zevium has no SOC 2 examination or issued report. SOC 2 is a CPA assurance
service, not a certification or repository badge. Matrix is planning inventory
only; exact criteria, system scope, period, control design and evidence must be
validated with a qualified CPA firm.

| Area                          | Repository evidence                                                       | Missing operating/control evidence                                                                              | Status              |
| ----------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------- |
| CC1 Control environment       | Role gates and this ownership model                                       | Named control owners, governance charter, ethics/personnel policies, training, oversight minutes                | Major gap           |
| CC2 Information/communication | Source docs, security reporting policy, typed architecture                | Approved policy set, employee/customer control communication, evidence repository and review cadence            | Major gap           |
| CC3 Risk assessment           | Threat-sensitive code/tests around auth, SSRF, ledger, webhooks           | Formal scoped risk assessment, fraud risk, annual cadence, change/vendor risk process                           | Major gap           |
| CC4 Monitoring                | CI tests and production smoke checks                                      | Control monitoring plan, exception handling, internal audit, metrics, evidence retention                        | Major gap           |
| CC5 Control activities        | Validation, authorization helpers, signature checks, idempotency          | Complete control catalog, owners/frequency/evidence, manual control design and testing                          | Partial design only |
| CC6 Logical/physical access   | Clerk auth, org gates, admin allowlist, scoped workflow permissions       | Vendor RBAC/MFA evidence, joiner/mover/leaver, quarterly reviews, break-glass, physical responsibility mapping  | Major gap           |
| CC7 System operations         | Dependabot, private vulnerability intake, error handling                  | Asset/vulnerability program, alerting/SIEM, incident staffing/drills, patch SLA evidence, penetration test      | Major gap           |
| CC8 Change management         | CI before deploy, pinned payment API version, source history              | Protected-branch/reviewer evidence, segregation of duties, emergency change/rollback records, release approvals | Partial design only |
| CC9 Risk mitigation/vendors   | Vendor architecture identified                                            | Vendor due diligence, contracts/DPAs, subprocessor monitoring, business continuity, insurance/risk acceptance   | Major gap           |
| A1 Availability               | Edge architecture, health endpoint, smoke test, transactional DO patterns | Approved SLA, capacity plan, monitored SLOs, backup/restore, RTO/RPO and DR test                                | Major gap           |
| C1 Confidentiality            | Secret filtering, hosted payment, credential encryption design            | Classification policy, DLP, log redaction proof, key rotation, disposal verification                            | Major gap           |
| PI1 Processing integrity      | Ledger reconciliation/idempotency tests, webhook dedupe and validation    | Production reconciliations, exception review and completeness/accuracy evidence                                 | Partial design only |
| Privacy (P1–P8)               | User-delete mirror hook and this inventory/procedure                      | Approved notice/bases/consent, DSR tooling, retention enforcement, privacy training, jurisdiction decisions     | Major gap           |

No “SOC 2 compliant,” “SOC 2 ready,” “Type I,” or “Type II” claim is permitted
without scoped auditor advice and, for report claims, issued report language.

## Public claim to control matrix

| Allowed narrow claim                                                                               | Repository evidence                                                   | Qualification / release gate                                                                                                                             |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zero wallet balance blocks paid calls                                                              | Wallet DO reserve checks and gateway tests                            | Applies to real gateway calls; keyless `/mock` never reaches upstream and costs zero                                                                     |
| Published spec versions are immutable                                                              | Convex mutations create versions and only update deprecation metadata | Database/vendor admin access is outside app-level immutability; operating access must be reviewed                                                        |
| Direct `/gateway` proxies stream request/response bodies; app tables do not store them             | `pipeline.ts` passes streams; schema stores normalized usage only     | MCP `call_api` buffers bounded 1 MiB bodies in Worker memory; Cloudflare/publisher processing and telemetry apply; never say “we never process payloads” |
| Consumer auth and cookies are not forwarded to publisher upstreams                                 | Header filter and regression tests                                    | Publisher credentials are injected separately; other consumer headers/body are forwarded                                                                 |
| Raw card and bank details are handled by Stripe, not Zevium tables                                 | Hosted Checkout/Connect architecture and Convex schema                | Zevium remains responsible for its Stripe integration and stored identifiers; no PCI claim                                                               |
| Publisher webhook events are signed                                                                | HMAC-SHA256 delivery implementation/tests                             | Signing secret storage and recipient verification remain responsibilities; do not call delivery end-to-end secure                                        |
| Publisher upstream credentials are encrypted on new writes                                         | AES-GCM implementation and versioned ciphertext fields                | No broad at-rest claim until legacy migration is proven zero and schema is tightened                                                                     |
| Security reports can be submitted privately                                                        | GitHub private vulnerability link in `SECURITY.md`                    | Acknowledgement is an objective, not guaranteed SLA                                                                                                      |
| Upstream execution is metered and credit-gated                                                     | Gateway pipeline, wallet DO and tests                                 | Keyless `/mock` only synthesizes schema responses and never executes upstream; avoid assurance or absolute-safety wording                                |
| Current `402` failures provide create-key/top-up/docs recovery actions; they are not x402 payments | `payment-required.ts` and pipeline tests                              | No payment requirements, signed-payment verification, facilitator or onchain settlement exists; never market this envelope as x402                       |

Prohibited without new evidence and approval: compliance/certification badges;
“SOC 2 compliant/ready”; “HIPAA compliant/ready”; “GDPR/CCPA compliant”;
"PCI compliant"; "ISO 27001 certified"; enterprise/bank/military-grade
platform, security, secure, encryption or protection copy; "fully secure,"
"zero risk," and absolute breach/privacy claims.

`pnpm check:compliance-claims` runs normalization/adversarial tests, then unions
every Git-tracked file with generated deploy inputs. Web inputs are derived from
the built Wrangler manifest (`main`, server modules and assets directory);
gateway inputs are derived from a Wrangler dry-run output plus its esbuild
metafile allowlist. Production and preview workflows scan those exact inputs
before upload. There is no global test, generated, dist or extension bypass.
The scanner reads bounded bytes, follows symlinks only within the repository,
recognizes binary formats by magic bytes rather than names, scans decoded binary
content, treats NUL/control bytes as separators, and rejects unknown binary,
broken/out-of-tree symlink and oversized inputs. Hostile test sources are exempt
only by exact repository path plus whole-file SHA-256; changed content loses the
exemption.

Publisher-controlled organization name, Clerk slug, public handle, project
name/slug/description/tags, version/deprecation copy, every OpenAPI object key,
and every OpenAPI string value are checked at sync, explicit write, backfill,
seed, save, publish and make-public/admin boundaries. Whole-document scanning is
required because raw specs are public; parsed keys/values plus every raw JSON
string token are scanned so duplicate-key shadowing and escaped text cannot
hide copy. Coverage includes `info.version`, path keys, tags, summaries,
descriptions, operation IDs, parameters, schema title,
example/default/enum/const/pattern values, mock bodies and raw documentation.
Malformed JSON is a violation. Catalogue list/detail, semantic search, direct
public spec, gateway, anonymous mock, discovery and MCP boundaries re-check and
omit legacy/bypassed unsafe rows. Private owner/admin reads remain available for
remediation. Published spec bodies are never rewritten.

Matching normalizes compatibility forms, common Greek/Cyrillic/small-cap
homographs, zero-width characters, punctuation and line breaks. Policy blocks
normalized framework names only when local syntax makes a positive assurance,
plus enumerated absolute security/privacy phrases. Bare framework references,
report/documentation analysis APIs and direct odd-count negative disclaimers are
allowed. Negation applies only through adjacent soft separators; sentence
punctuation, double negation or remote negation does not suppress a positive
assertion. This is an explicit publisher boundary, not natural-language
understanding, legal review, image OCR or third-party-page review. Ambiguous
copy must be rephrased. A pass proves only that current lexical policy and
boundaries found no denied copy.

## Prioritized remediation plan

Timelines are relative to production launch (`T`). They are commitments required
for approval, not claims that work is staffed.

| Priority | Remediation                                                                                                                                                                                                                            | Owner                                                                          | Due                         | Exit evidence                                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Assign named Security & Privacy Owner, Legal/Privacy Counsel, Engineering, Operations, Finance and incident roles                                                                                                                      | Accountable executive                                                          | T-8 weeks                   | Signed role register and call tree                                                                                                            |
| P0       | Approve entity/funds-flow and jurisdiction row(s); publish counsel-approved terms, privacy notice, acceptable use and publisher agreement with PHI prohibition                                                                         | Legal/Privacy Counsel + Finance/Payments Owner                                 | T-6 weeks                   | Signed decisions and versioned public documents                                                                                               |
| P0       | Execute vendor/recipient reviews and DPAs; verify regions, retention, logs, access, incident terms and subprocessors                                                                                                                   | Security & Privacy Owner                                                       | T-6 weeks                   | Evidence links and approved subprocessor register                                                                                             |
| P0       | Prove Gemini uses applicable paid-service/DPA terms and approved locations/logging, prohibit sensitive search text, or disable semantic embeddings                                                                                     | Engineering Lead + Legal/Privacy Counsel                                       | T-6 weeks                   | Billing/config export, signed terms review and query-flow test                                                                                |
| P0       | Finish upstream-credential migration, remove plaintext field, rotate keys, encrypt publisher webhook secrets                                                                                                                           | Engineering Lead                                                               | T-4 weeks                   | Zero-count migration output, tightened schema/tests, rotation record                                                                          |
| P0       | Implement safe tenant erasure/export and Durable Object purge with dry run, holds, cascade tests and vendor coordination                                                                                                               | Engineering Lead + Legal/Privacy Counsel                                       | T-4 weeks                   | DSR test case with before/after inventory and approvals                                                                                       |
| P0       | Configure/admin-review MFA/RBAC, branch/environment protection, secrets, audit logs and offboarding across vendors                                                                                                                     | Engineering Lead + Security & Privacy Owner                                    | T-4 weeks                   | Screenshots/exports, access matrix and reviewer sign-off                                                                                      |
| P0       | Set log/data retention and purge jobs; remove or minimize duplicate console usage logs                                                                                                                                                 | Engineering Lead                                                               | T-3 weeks                   | Config exports, automated tests and purge execution evidence                                                                                  |
| P0       | Build on-call/incident channels and run cross-org/data/payment tabletop plus credential-rotation drill                                                                                                                                 | Operations Lead                                                                | T-2 weeks                   | Exercise record, gaps closed or accepted                                                                                                      |
| P0       | Backup/restore and wallet/payment reconciliation recovery test; approve RTO/RPO                                                                                                                                                        | Operations Lead + Finance/Payments Owner                                       | T-2 weeks                   | Timed restore/reconciliation evidence                                                                                                         |
| P0       | Final claim review and launch sign-off gate                                                                                                                                                                                            | Security & Privacy Owner + counsel + accountable executive                     | T-2 business days           | All gate rows signed; no unresolved P0                                                                                                        |
| P1       | Formal risk assessment, control catalog/evidence cadence, vulnerability management and independent penetration test                                                                                                                    | Security & Privacy Owner                                                       | Within 30 days after launch | Approved risk register and remediation tickets                                                                                                |
| P1       | Admin action audit log, JIT/scoped roles, access-review automation and security alerting                                                                                                                                               | Engineering Lead                                                               | Within 60 days after launch | Queryable audit trail, alert drill, review export                                                                                             |
| P1       | Aggregate/de-identify old usage; validate DSR and incident exercises quarterly                                                                                                                                                         | Security & Privacy Owner                                                       | Within 90 days after launch | Job results and exercise records                                                                                                              |
| P1       | Before any x402 activation, build exact rail and inventory; select and review facilitator/wallet/network; approve funds flow/public-chain notice; test kill switch, disclosure, replay, retention and funded settlement/reconciliation | Security & Privacy Owner + Finance/Payments Owner + Engineering Lead + counsel | Before any funded x402 test | Exact release code/config, signed approvals, captured requests, failure tests, transaction evidence and matching internal accounting evidence |

## Human sign-off gate

Merging code/docs, passing CI, vendor marketing pages, or an AI-generated review
cannot approve launch.

Approval record ID: `ISSUE-103-LAUNCH-POSTURE`. For each row, evidence must record
the signer's legal name and accountable role, exact released posture commit SHA,
decision and restrictions, UTC timestamp, and immutable evidence reference. Git
authorship, issue assignment, review comments, CI success or placeholder text do
not count as signature. `UNASSIGNED`, `NONE` or a missing timestamp always means
`BLOCKED`.

| Required signer                      | Named human    | Required decision                                                                                         | Evidence reference | Approved UTC | State   |
| ------------------------------------ | -------------- | --------------------------------------------------------------------------------------------------------- | ------------------ | ------------ | ------- |
| Security & Privacy Owner             | **UNASSIGNED** | Security risks, vendor evidence, retention/DSR/incident readiness accepted                                | **NONE**           | **NONE**     | BLOCKED |
| Legal/Privacy Counsel                | **UNASSIGNED** | Jurisdictions, roles/bases, notices/contracts, PHI prohibition, retention and notification rules approved | **NONE**           | **NONE**     | BLOCKED |
| Finance/Payments Owner               | **UNASSIGNED** | Stripe/Connect funds flow, country support, tax/refund/dispute and financial retention approved           | **NONE**           | **NONE**     | BLOCKED |
| Engineering Lead                     | **UNASSIGNED** | P0 technical controls deployed and evidence matches production                                            | **NONE**           | **NONE**     | BLOCKED |
| Operations Lead / Incident Commander | **UNASSIGNED** | On-call, recovery, escalation and exercises operational                                                   | **NONE**           | **NONE**     | BLOCKED |
| Accountable executive                | **UNASSIGNED** | Residual risk accepted after all specialist approvals                                                     | **NONE**           | **NONE**     | BLOCKED |

Exact external blocker: qualified Legal/Privacy Counsel must approve at least one
supported launch jurisdiction, controller/processor allocation, marketplace and
Stripe Connect funds flow, privacy/terms/DPA/publisher documents, retention and
deletion rules, breach-notification duties, and HIPAA/PHI prohibition. Future
x402 activation would separately require selected facilitator/network terms and
data-flow approval, public-chain notice, wallet/funds-flow and regulatory
decisions, approved retention/deletion exceptions, exact code evidence, and an
authorized funded end-to-end test. Vendor
DPAs/account configuration evidence and named human operational signers must also
exist. None can be supplied or approved by repository work.
