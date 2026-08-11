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

- Cloudflare Workers hosts web and gateway code. Gateway request and response
  bodies stream through Cloudflare to publisher-controlled upstream APIs.
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
- Google Gemini receives text assembled from project name, description, tags,
  and published OpenAPI endpoint paths/summaries for catalogue embeddings.
- Publisher upstream APIs receive consumer-selected gateway paths, query
  strings, filtered headers, and request bodies. Publisher response bodies and
  filtered headers stream back through the gateway.
- Publisher-configured webhook endpoints receive signed Zevium event payloads.
- GitHub and Blacksmith run source CI/deployment workflows. They should not
  receive production customer records, but repository and workflow metadata are
  in scope for access review.

Cloudflare, Convex, Clerk, Stripe, Google, GitHub, and Blacksmith locations,
retention settings, DPAs, regional configuration, support-access settings, and
current subprocessor lists are deployment/account evidence, not facts proved by
this repository.

## Data inventory

Data labels used below: **Public**, **Customer confidential**, **Personal**,
**Financial**, and **Secret**. A field can have more than one label.

| Data class                     | Exact data                                                                                                                                                             | Purpose and flow                                              | Store / recipient                                                                                                            | Current repository lifecycle                                                                                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User identity                  | Clerk user ID, display name, email; Clerk also owns login identifiers, credentials, OAuth links, verification and MFA/session data                                     | Authenticate users and render profiles                        | Clerk; ID/name/email mirror in Convex `users`                                                                                | Convex mirror is deleted on `user.deleted`; Clerk lifecycle and backups are vendor-configured; no DSR export workflow exists                                                          |
| Organization identity          | Clerk org ID, name, slug, image URL, public handle; Clerk membership, role and invitation data                                                                         | Tenant routing, authorization, catalogue identity             | Clerk; selected mirror in Convex `organizations`                                                                             | Org webhook currently deletes only wallet entries, wallet, and org row; related app/payment/usage records are not comprehensively erased                                              |
| Project/listing                | Project name, slug, description, tags, visibility/status, upstream origin, readiness result, draft and immutable published OpenAPI documents, deprecation reason/times | Publish and route APIs                                        | Convex; public listings/spec-derived material goes to browsers and gateway caches                                            | Project delete removes direct project/spec/credential data in code; no global retention schedule or backup-erasure proof                                                              |
| Embedding input/output         | Project name, description, tags, endpoint methods, paths and summaries; 768-dimension vector                                                                           | Semantic catalogue search                                     | Google Gemini receives input; Convex `specEmbeddings` stores input text/vector                                               | Rebuilt on publish; no time-based expiry; project cleanup exists, vendor request retention unknown                                                                                    |
| Publisher upstream credentials | Header name, encrypted value, IV, encryption-key version, update time; transitional schema can still represent legacy plaintext                                        | Inject publisher auth after consumer auth is stripped         | Convex `upstreamCredentials`; decrypted value delivered to Cloudflare gateway and publisher upstream                         | New writes use AES-GCM. Production must prove migration counts are zero, make ciphertext fields required, remove plaintext field, and document key rotation before claim is relied on |
| Consumer API keys              | API-key secret, key ID, subject/org, scopes, expiry/revocation; cap, disabled state, rotation linkage and grace period                                                 | Authenticate/gate calls and attribute usage                   | Clerk stores key authority/secret; Convex stores key metadata only; Cloudflare caches verification and controls              | Secret is copy-once through Clerk flow; cache staleness is bounded in code, but vendor retention and a user-level key deletion procedure are not documented                           |
| Gateway request                | Request ID; publisher/project route; path and query; method; filtered request headers; streaming body                                                                  | Proxy consumer call to publisher                              | Transits Cloudflare and publisher upstream; Cloudflare platform metadata may include IP, user agent, timing and network data | App code does not persist body or arbitrary headers. Bodies stream. Observability is enabled and its account retention/redaction settings are unverified                              |
| Gateway response               | Status, filtered headers, streaming response body, latency, request ID                                                                                                 | Return publisher result and meter outcome                     | Transits publisher upstream and Cloudflare to consumer                                                                       | App code does not persist body. `set-cookie`, auth and hop-by-hop headers are stripped; observability/account logs remain unverified                                                  |
| Usage and key attribution      | Consumer org ID, publisher org/project ID, key ID, method, normalized endpoint template, status, latency, credits, timestamp, settlement/request reference and outcome | Credit ledger, billing, consumer/publisher analytics, support | Cloudflare logs and Durable Object pending state; Convex `usageEvents`, wallet and earnings tables                           | Stored without fixed expiry. Console usage logs duplicate these fields when production Convex is configured. No IP/body is intentionally included by app logger                       |
| Wallet/ledger                  | Balance, sequence, entry kind/amount/reference, payment/usage links, reservations, grants, free-tier counters, settlement state                                        | Enforce prepaid spend and reconcile accounting                | Convex `wallets`/`walletEntries`; Cloudflare Durable Objects                                                                 | Convex ledger and DO state have no approved expiry. Deletion must preserve legally required financial evidence while severing user identifiers where allowed                          |
| Checkout/payment               | Pack, amount, currency, credits, Checkout Session/PaymentIntent/Charge/Customer IDs, event/object/account IDs, status, failures, refunds and disputes                  | Sell credits and reconcile payments                           | Stripe; projections in Convex checkout/payment/event tables                                                                  | Hosted Checkout keeps raw card data out of app schema. Records have no repository-enforced retention or pseudonymization schedule                                                     |
| Publisher KYC/payout           | Connected Account ID, requirements, capability/status flags, transfer/payout IDs, amounts, currency, arrival/failure data                                              | Publisher onboarding and payout                               | Stripe holds identity, tax, bank and KYC evidence; Convex stores IDs/status projections                                      | Stripe retention/legal duties apply; repository has no approved schedule or closed-account runbook                                                                                    |
| Earnings                       | Publisher org/project, usage settlement reference, gross/platform/net credits, availability/state, transfer link and timestamps                                        | 95/5 marketplace accounting                                   | Convex                                                                                                                       | No fixed expiry; likely financial-record retention, subject to counsel decision                                                                                                       |
| Notifications                  | Org ID, type, title, body, reference, read/create times                                                                                                                | In-app operational notices                                    | Convex                                                                                                                       | No fixed expiry or per-user preference model                                                                                                                                          |
| Publisher webhooks             | Endpoint URL, signing secret, active state; event payload, attempts, error and timestamps                                                                              | Notify publisher systems                                      | Convex; payload delivered to publisher-chosen endpoint                                                                       | Secret is stored as plaintext in Convex. Delivery logs/payloads have no expiry; delete endpoint does not delete prior delivery rows                                                   |
| Administrative access          | Admin Clerk user IDs in environment allowlist; admin reads/actions over orgs, projects, usage and payouts                                                              | Platform operations                                           | Convex environment and functions; vendor/provider audit logs if enabled                                                      | Server-side gate exists. No repo-owned admin action audit table, access-review cadence, JIT process, or production allowlist evidence                                                 |
| Vulnerability reports          | Reporter contact and reproduction details, potentially test identifiers                                                                                                | Triage and remediate security reports                         | GitHub private vulnerability reporting                                                                                       | GitHub retention/access settings govern it; reporters are told not to include credentials or personal data                                                                            |

### Data deliberately not stored by application tables

- Raw payment-card numbers, CVCs, and publisher bank-account numbers.
- Gateway request bodies, response bodies, arbitrary request headers, consumer
  cookies, or publisher `set-cookie` response headers.
- Consumer API-key secret values in Convex tables.

These are narrow architecture statements, not PCI, privacy, or security
certifications. Vendor telemetry can still process network/request metadata and
must be checked separately.

## Subprocessors and external recipients

No vendor may be represented as approved from this list alone.

| Party                         | Role / data                                                                                            | Pre-launch evidence required                                                                                                         | Owner                    | Status                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare                    | Web/gateway host, edge network metadata, streamed content, Durable Object state, logs                  | DPA, region/options, log retention/redaction, staff access, incident terms, deletion/export path, current subprocessor list          | Security & Privacy Owner | Blocked—account evidence absent                                                                                                                                                                 |
| Convex                        | Primary application database/functions/vector store and function logs                                  | DPA, selected region, backups/retention, restore/deletion, support access, audit logs, incident terms, subprocessors                 | Engineering Lead         | Blocked—account evidence absent                                                                                                                                                                 |
| Clerk                         | Auth, users/orgs/memberships, sessions, MFA, API keys                                                  | DPA, auth settings, MFA/admin controls, retention/deletion/export, breach terms, subprocessors                                       | Security & Privacy Owner | Blocked—account evidence absent                                                                                                                                                                 |
| Stripe                        | Checkout, payments, disputes, Connect KYC/transfers/payouts                                            | Signed services terms/DPA, Connect platform obligations, retention, restricted-key/RBAC review, webhook config, country availability | Finance/Payments Owner   | Blocked—account and legal evidence absent                                                                                                                                                       |
| Google Gemini                 | Catalogue embedding input                                                                              | DPA/terms, no-training and retention setting evidence, region, data minimization decision                                            | Engineering Lead         | Blocked—account/contract evidence absent                                                                                                                                                        |
| GitHub                        | Source, vulnerability reports, CI metadata and secrets handoff                                         | Org MFA, least privilege, review policy, audit-log retention, secret-scanning settings, DPA/terms                                    | Engineering Lead         | Partial—default branch requires a PR and blocks deletion/non-fast-forward updates; zero approvals, CODEOWNER review, thread resolution and last-push approval are required; org evidence absent |
| Blacksmith                    | Hosted CI runners and build metadata                                                                   | DPA/terms, runner isolation, log/artifact retention, network/secrets handling, subprocessors                                         | Engineering Lead         | Blocked—contract/account evidence absent                                                                                                                                                        |
| Each publisher upstream       | Independent recipient of consumer-selected request data; role depends on contract and processing facts | Publisher terms/DPA allocation, listing disclosures, prohibited-data rules, abuse contact and takedown path                          | Legal/Privacy Counsel    | Blocked—contract model absent                                                                                                                                                                   |
| Publisher webhook destination | Publisher-selected recipient of event payloads                                                         | Payload inventory, tenant warning, deletion/retry behavior, SSRF review                                                              | Engineering Lead         | Partial—URL validation/signing exist; governance absent                                                                                                                                         |

Before adding a party: record purpose, data, countries, legal mechanism, DPA,
security review, deletion/return terms, incident notice, owner, approval date, and
public-notice impact. Security & Privacy Owner reviews the register at least
quarterly and before material data-flow changes. This cadence is a required
future control, not evidence that reviews have occurred.

## Retention schedule: proposed, not yet enforced

Legal/Privacy Counsel and Finance/Payments Owner must approve exact periods per
supported jurisdiction. Until then, production data collection must not start.

| Record                                | Proposed rule                                                                                                     | Current enforcement gap                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| User profile mirror                   | Active account; erase within 30 days of verified deletion unless hold applies                                     | Clerk webhook deletes Convex user mirror, but vendor/backups and case evidence are not coordinated |
| Org/project/draft/credentials         | Active service plus 30-day recovery window, then erase; public immutable versions require contract/legal decision | No soft-delete/recovery lifecycle; org cascade is incomplete; backups unverified                   |
| Gateway payloads                      | No intentional application persistence                                                                            | Must verify Cloudflare log/body capture settings and publisher responsibilities                    |
| Usage/security logs                   | 30 days searchable, up to 90 days restricted archive if justified                                                 | Cloudflare/Convex log retention not configured in repo; usage tables never expire                  |
| Detailed usage attribution            | 13 months, then aggregate or delete key/user identifiers                                                          | No cron or aggregation/de-identification job                                                       |
| Wallet/payment/earnings/payout ledger | Jurisdiction-specific financial/statutory period, then delete or irreversibly de-identify                         | No approved period, legal-hold flag, pseudonymization, or purge job                                |
| Webhook delivery payload/error        | 30 days                                                                                                           | No purge job; orphaned deliveries can remain after endpoint deletion                               |
| API-key metadata/cache                | Active key plus 30 days for security investigation; secret per Clerk policy                                       | No coordinated purge; Durable Object key/free-tier state lacks deletion workflow                   |
| DSR and incident case record          | Minimum necessary proof for approved legal period                                                                 | No case system or schedule                                                                         |

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
   and publisher/webhook recipients. Search by canonical IDs, never email alone.
5. **Preserve only approved holds.** Legal/Privacy Counsel documents statutory
   financial retention, dispute, fraud, security or litigation holds. Separate
   held records and restrict access; do not use a hold as blanket refusal.
6. **Access/export.** Export responsive records from Clerk, Convex, Stripe,
   Cloudflare logs/DO state, and support/security systems. Exclude other tenants,
   secrets, internal abuse signals, and privileged material after counsel review.
   Deliver through authenticated, expiring channel.
7. **Correct.** Correct Clerk source fields first, allow verified webhook sync,
   then correct eligible app metadata. Append accounting corrections; do not
   rewrite append-only ledger history.
8. **Delete/de-identify.** Revoke sessions/API keys; remove Clerk user/org data
   when authorized; delete Convex personal mirror and tenant data; purge gateway
   cache/DO state; request Stripe/vendor deletion where allowed; delete webhook
   destinations/payloads; notify publisher recipients when contract/law requires.
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
   record timestamps and access. Do not copy secrets or customer payloads into
   chat/tickets.
3. Contain with smallest reversible action: revoke key/session/token, disable
   integration, delist project, stop deployment, rotate scoped secret, or block
   affected route. Protect ledger evidence before financial correction.
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

Launch gaps:

- No evidence of MFA enforcement, SSO, JIT access, break-glass controls, quarterly
  reviews, offboarding SLA, or least-privilege roles in vendor accounts.
- `ADMIN_USER_IDS` is coarse and environment-managed; no app admin action audit
  trail or approval workflow exists.
- GitHub ruleset evidence requires pull requests and blocks deletion and
  non-fast-forward updates on `develop`, but requires zero approvals, no
  CODEOWNER review, no thread resolution, and no last-push approval. No evidence
  of signed-commit enforcement, secret-scanning configuration, or production
  environment reviewers was collected.
- Cloudflare observability logs detailed usage identifiers; retention, access,
  redaction, alerting and export are not repository-controlled.
- Convex function/vendor audit-log availability and retention are unverified.
- Publisher webhook signing secrets are plaintext at rest.
- Legacy upstream plaintext compatibility remains in schema until migration and
  tightening complete.
- Shared production secrets have no documented rotation cadence, dual-control,
  inventory, ownership, expiry or tested emergency rotation.
- No formal asset inventory, endpoint inventory, data-classification enforcement,
  vulnerability scanning/SAST/DAST, penetration test, SIEM, anomaly alerting,
  backup restore test, RTO/RPO, or disaster-recovery exercise evidence.

## Supported-jurisdiction decision rubric

Current decision: **no launch jurisdiction is approved by this repository**.
Marketing availability, Stripe technical availability, company formation, and
lawful service availability are separate decisions.

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
6. Retention, deletion, legal hold, breach-notification and regulator-contact
   rules are executable in systems and runbooks.
7. Data categories permitted through marketplace APIs are defined; health,
   biometric, precise location, government ID, child, criminal and other
   sensitive data are blocked unless separately approved.
8. Customer support, incident response, language, accessibility and consumer
   cancellation/refund obligations can be met.
9. Insurance and contractual liability requirements are accepted by accountable
   executives.

Any Fail or Unknown means unsupported. Restricted needs exact product/contract
guardrail and owner. Security & Privacy Owner records decision; Legal/Privacy
Counsel and Finance/Payments Owner sign it; accountable executive accepts
residual risk.

## HIPAA and sensitive-data prohibition

Zevium is **not approved for Protected Health Information (PHI)** and must not be
marketed or used as HIPAA compliant, HIPAA ready, or suitable for PHI. Do not
enter PHI into accounts, organization/project metadata, OpenAPI specs, gateway
requests, webhook payloads, support, logs, or payment descriptions.

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

Zevium has **not been audited or certified for SOC 2**. SOC 2 is an attestation,
not a repository badge. Matrix is planning inventory only; criteria mapping and
scope must be validated by qualified auditors.

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
| PI1 Processing integrity      | Ledger reconciliation/idempotency tests, webhook dedupe, validation       | Production reconciliations, exception review, completeness/accuracy evidence and retained approvals             | Partial design only |
| P1 Privacy                    | User-delete mirror hook and this inventory/procedure                      | Approved notice/bases/consent, DSR tooling, retention enforcement, privacy training, jurisdiction decisions     | Major gap           |

No “SOC 2 compliant,” “SOC 2 ready,” “Type I,” or “Type II” claim is permitted
without scoped auditor advice and, for report claims, issued report language.

## Public claim to control matrix

| Allowed narrow claim                                                     | Repository evidence                                                                | Qualification / release gate                                                                                      |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Zero wallet balance blocks paid calls                                    | Wallet DO reserve checks and gateway tests                                         | Applies to real gateway calls; keyless `/mock` never reaches upstream and costs zero                              |
| Published spec versions are immutable                                    | Convex mutations create versions and only update deprecation metadata              | Database/vendor admin access is outside app-level immutability; operating access must be reviewed                 |
| Gateway streams request/response bodies and app tables do not store them | `pipeline.ts` passes request/response streams; schema stores normalized usage only | Cloudflare/publisher processing and telemetry still apply; never say “we never process payloads”                  |
| Consumer auth and cookies are not forwarded to publisher upstreams       | Header filter and regression tests                                                 | Publisher credentials are injected separately; other consumer headers/body are forwarded                          |
| Raw card and bank details are handled by Stripe, not Zevium tables       | Hosted Checkout/Connect architecture and Convex schema                             | Zevium remains responsible for its Stripe integration and stored identifiers; no PCI claim                        |
| Publisher webhook events are signed                                      | HMAC-SHA256 delivery implementation/tests                                          | Signing secret storage and recipient verification remain responsibilities; do not call delivery end-to-end secure |
| Publisher upstream credentials are encrypted on new writes               | AES-GCM implementation and versioned ciphertext fields                             | No broad at-rest claim until legacy migration is proven zero and schema is tightened                              |
| Security reports can be submitted privately                              | GitHub private vulnerability link in `SECURITY.md`                                 | Acknowledgement is an objective, not guaranteed SLA                                                               |
| Zevium is metered and credit-gated                                       | Gateway pipeline, wallet DO and tests                                              | Avoid “secure,” “compliant,” “certified,” or absolute safety claims                                               |

Prohibited without new evidence and approval: compliance/certification badges;
“SOC 2 compliant/ready”; “HIPAA compliant/ready”; “GDPR/CCPA compliant”;
“PCI compliant”; “ISO 27001 certified”; “enterprise-grade,” “bank-grade,”
“military-grade,” “fully secure,” “zero risk,” and absolute breach/privacy claims.

## Prioritized remediation plan

Timelines are relative to production launch (`T`). They are commitments required
for approval, not claims that work is staffed.

| Priority | Remediation                                                                                                                                                    | Owner                                                      | Due                         | Exit evidence                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------- |
| P0       | Assign named Security & Privacy Owner, Legal/Privacy Counsel, Engineering, Operations, Finance and incident roles                                              | Accountable executive                                      | T-8 weeks                   | Signed role register and call tree                                   |
| P0       | Approve entity/funds-flow and jurisdiction row(s); publish counsel-approved terms, privacy notice, acceptable use and publisher agreement with PHI prohibition | Legal/Privacy Counsel + Finance/Payments Owner             | T-6 weeks                   | Signed decisions and versioned public documents                      |
| P0       | Execute vendor/recipient reviews and DPAs; verify regions, retention, logs, access, incident terms and subprocessors                                           | Security & Privacy Owner                                   | T-6 weeks                   | Evidence links and approved subprocessor register                    |
| P0       | Finish upstream-credential migration, remove plaintext field, rotate keys, encrypt publisher webhook secrets                                                   | Engineering Lead                                           | T-4 weeks                   | Zero-count migration output, tightened schema/tests, rotation record |
| P0       | Implement safe tenant erasure/export and Durable Object purge with dry run, holds, cascade tests and vendor coordination                                       | Engineering Lead + Legal/Privacy Counsel                   | T-4 weeks                   | DSR test case with before/after inventory and approvals              |
| P0       | Configure/admin-review MFA/RBAC, branch/environment protection, secrets, audit logs and offboarding across vendors                                             | Engineering Lead + Security & Privacy Owner                | T-4 weeks                   | Screenshots/exports, access matrix and reviewer sign-off             |
| P0       | Set log/data retention and purge jobs; remove or minimize duplicate console usage logs                                                                         | Engineering Lead                                           | T-3 weeks                   | Config exports, automated tests and purge execution evidence         |
| P0       | Build on-call/incident channels and run cross-org/data/payment tabletop plus credential-rotation drill                                                         | Operations Lead                                            | T-2 weeks                   | Exercise record, gaps closed or accepted                             |
| P0       | Backup/restore and wallet/payment reconciliation recovery test; approve RTO/RPO                                                                                | Operations Lead + Finance/Payments Owner                   | T-2 weeks                   | Timed restore/reconciliation evidence                                |
| P0       | Final claim review and launch sign-off gate                                                                                                                    | Security & Privacy Owner + counsel + accountable executive | T-2 business days           | All gate rows signed; no unresolved P0                               |
| P1       | Formal risk assessment, control catalog/evidence cadence, vulnerability management and independent penetration test                                            | Security & Privacy Owner                                   | Within 30 days after launch | Approved risk register and remediation tickets                       |
| P1       | Admin action audit log, JIT/scoped roles, access-review automation and security alerting                                                                       | Engineering Lead                                           | Within 60 days after launch | Queryable audit trail, alert drill, review export                    |
| P1       | Aggregate/de-identify old usage; validate DSR and incident exercises quarterly                                                                                 | Security & Privacy Owner                                   | Within 90 days after launch | Job results and exercise records                                     |

## Human sign-off gate

Merging code/docs, passing CI, vendor marketing pages, or an AI-generated review
cannot approve launch.

| Required signer                      | Named human    | Required decision                                                                                         | Approval evidence          | State   |
| ------------------------------------ | -------------- | --------------------------------------------------------------------------------------------------------- | -------------------------- | ------- |
| Security & Privacy Owner             | **UNASSIGNED** | Security risks, vendor evidence, retention/DSR/incident readiness accepted                                | Dated signed decision      | BLOCKED |
| Legal/Privacy Counsel                | **UNASSIGNED** | Jurisdictions, roles/bases, notices/contracts, PHI prohibition, retention and notification rules approved | Dated legal approval       | BLOCKED |
| Finance/Payments Owner               | **UNASSIGNED** | Stripe/Connect funds flow, country support, tax/refund/dispute and financial retention approved           | Dated signed decision      | BLOCKED |
| Engineering Lead                     | **UNASSIGNED** | P0 technical controls deployed and evidence matches production                                            | Release/control checklist  | BLOCKED |
| Operations Lead / Incident Commander | **UNASSIGNED** | On-call, recovery, escalation and exercises operational                                                   | Drill and call-tree record | BLOCKED |
| Accountable executive                | **UNASSIGNED** | Residual risk accepted after all specialist approvals                                                     | Dated launch authorization | BLOCKED |

Exact external blocker: qualified Legal/Privacy Counsel must approve at least one
supported launch jurisdiction, controller/processor allocation, marketplace and
Stripe Connect funds flow, privacy/terms/DPA/publisher documents, retention and
deletion rules, breach-notification duties, and HIPAA/PHI prohibition. Vendor
DPAs/account configuration evidence and named human operational signers must also
exist. None can be supplied or approved by repository work.
