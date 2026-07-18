# Zevium Tiger-Style Code Review — Master Report

**Scope:** 118 review files across `convex/`, `apps/gateway/`, `packages/shared/`, `apps/web/` (routes, lib, components, hooks), `scripts/`.
**Method:** One file per subagent, serial → parallel (32-cap), two passes (initial + deep-dive). Every review in `reviews/`.
**Stance:** Tiger-style. No praise, only problems. P0=blocker/security/data-loss, P1=correctness, P2=design/perf, P3=nit.

---

## Headline Numbers

| Severity | Count (approx, deduped) |
|----------|------------------------|
| **P0** | ~12 |
| **P1** | ~170 |
| **P2** | ~350 |
| **P3** | ~400 |
| **Total findings** | **~930** |
| **Files reviewed** | 118 review files covering ~130 source files |

Every file got `Incorrect` or `NEEDS WORK`. Zero files shipped clean.

---

## Top 12 P0s (ship-blockers)

| # | File | P0 Finding |
|---|------|-----------|
| 1 | `convex/billing.ts` | Non-transactional grant/refund/dispute pipeline: 3 P0s — failed events never re-driven (200-before-grant + no retry/DLQ), scheduler-failure variant loses events, non-transactional reversal diverges ledger from projection. **Money-in is unsafe.** |
| 2 | `convex/lib/webhookDelivery.ts` | SSRF via redirect-following reaches cloud metadata (169.254.169.254) + accepts any https URL incl. private IPs/loopback. Publisher-controlled webhook URL fetched server-side with no IP pinning. |
| 3 | `convex/webhooks.ts` | `validateWebhookUrl` accepts every https URL regardless of destination — 169.254.169.254, 10.0.0.1, [::1], metadata.google.internal all pass. SSRF from Convex runtime. |
| 4 | `convex/lib/validate.ts` + `packages/shared/src/validate.ts` | 2 P0s: SSRF via `servers[0].url` (accepts internal IPs/localhost/metadata); `x-zevium-cost:0` validates as free but gateway charges 1 (pricing oracle inverted at boundary). |
| 5 | `packages/shared/src/mock.ts` | 2 P0s: O(N^5) synthesis explosion — recursive $ref with no breadth cap OOMs the 128MB Worker; SSRF via `servers[0].url`. |
| 6 | `apps/web/src/lib/spec-import.ts` | SSRF oracle: server-side fetch of any http(s) URL, no private-host blocklist, no timeout, redirect:follow, status-code echo = network scanner. |
| 7 | `apps/web/src/routes/app/projects/$projectSlug/spec.tsx` | SSRF escalated P1→P0: cloud-metadata reachable via fetchSpecFromUrl, response-body exfiltration. |
| 8 | `apps/web/src/router.tsx` | Module-scoped `convexQueryClient.serverHttpClient.setAuth(token)` races under concurrent SSR (Cloudflare worker isolate), leaking cross-user identity/data across every authed Convex loader. |

---

## 10 Systemic Themes (cross-file)

### 1. SSRF everywhere, no private-IP filtering
**Files:** `convex/lib/validate.ts`, `packages/shared/src/validate.ts`, `convex/webhooks.ts`, `convex/lib/webhookDelivery.ts`, `apps/web/src/lib/spec-import.ts`, `apps/gateway/src/pipeline.ts`, `apps/web/src/routes/app/projects/$projectSlug/spec.tsx`.

Every server-side fetch of a user/publisher-controlled URL has zero private-IP/loopback/metadata filtering. `servers[0].url`, webhook endpoint URLs, spec-import URLs, and gateway upstream fetches all accept `169.254.169.254`, `127.0.0.1`, `10.x`, `192.168.x`, `[::1]`. Cloud metadata endpoints reachable from multiple paths. `redirect:follow` defeats any future allowlist.

**Fix:** Single shared `assertPublicUrl()` helper, IP-pinning, redirect:manual, scheme allowlist, DNS-rebinding guard.

### 2. Pricing divergence (validator ≠ gateway ≠ editor ≠ display)
**Files:** `packages/shared/src/pricing.ts`, `packages/shared/src/validate.ts`, `apps/web/src/lib/spec-pricing-edit.ts`, `apps/gateway/src/pipeline.ts`, `convex/specs.ts`.

`x-zevium-cost:0` validates clean but `extractPricing` rewrites to 1 (free endpoints silently overcharged). Fractional costs (3.9) silently floored (3). `x-zevium-free-tier` never validated — silently disabled, unbounded 1e9 quota accepted. Editor write path, display path, validation path, and runtime `extractPricing` all apply different sanitization to the same keys. Three-way systematic drift.

**Fix:** Single source of truth for pricing extraction. Validate at publish what the gateway will charge. Reject (don't floor) non-integer costs. Validate free-tier shape.

### 3. Non-transactional money pipeline
**Files:** `convex/billing.ts`, `convex/payouts.ts`, `convex/earnings.ts`, `convex/accounting.ts`, `convex/crons.ts`.

Money-in (`billing.ts`): grant/refund/dispute split across multiple `internalMutation` calls from an `internalAction` with no retry, no re-drive cron, 200-before-grant. Money-out (`payouts.ts`): illegal status transitions on out-of-order webhooks (reversed→succeeded), stranded earnings behind failed transfers with no `failed→available` recovery path, Stripe idempotency key exceeds 255-char limit at ~9 earnings. `releaseMatureEarnings` exists with a purpose-built index but is wired to NO cron — mature earnings orphan in `pending_risk` forever. Refunds/disputes never reverse `publisherEarnings` — platform eats refunded credits.

**Fix:** Transactional grant pipeline with retry + DLQ + re-drive cron. Wire `releaseMatureEarnings` to a cron. Reverse `publisherEarnings` on refund/dispute. Cap idempotency key length.

### 4. Webhook idempotency gaps (inbound + outbound)
**Files:** `convex/http.ts`, `convex/lib/webhookDelivery.ts`, `convex/webhooks.ts`.

Inbound (Polar/Stripe → Convex): 200-before-grant, no idempotency key on event processing, schedule-once-with-no-retry. Outbound (Zevium → publisher): no terminal-state guard (late duplicates resurrect `failed→ok`), no `deliveryId` propagation (consumers can't dedupe at-least-once), `deliverWebhook` action non-idempotent (Convex re-execution double-POSTs), retries permanent 4xx, raw transport-error strings interpolated into publisher-visible notification body.

**Fix:** Idempotency key on every webhook event. Terminal-state guard on delivery state machine. Propagate `deliveryId` in HTTP headers. Classify 4xx as terminal, not retryable.

### 5. Private spec leakage (visibility gate bypass)
**Files:** `convex/specs.ts`, `apps/gateway/src/mock.ts`, `apps/gateway/src/mcp.ts`, `apps/gateway/src/discovery.ts`, `apps/gateway/src/index.ts`.

`specs.getPublishedForGateway` is a public no-auth query that returns the full OpenAPI spec of any **private** project to anyone knowing the two kebab-case slugs. `visibility` is returned but never gated. Reachable from `/mock` (keyless), `/mcp get_api_docs` (unauthenticated), `/discovery`, and the gateway pipeline. The keyless `/mock` patch added a visibility gate to `/gateway` but not `/mock` — test enshrines the bug.

**Fix:** Gate `getPublishedForGateway` on `visibility === "public"`. Apply visibility check in every public-facing route that calls it.

### 6. Gateway hot path defeats caches
**Files:** `apps/gateway/src/index.ts`, `apps/gateway/src/spec-source.ts`, `apps/gateway/src/catalogue-source.ts`, `apps/gateway/src/key-verifier.ts`.

`index.ts#buildDeps` constructs fresh `CachedSpecSource`/`CachedCatalogueSource`/`ClerkKeyVerifier` per request, so the 30s/60s TTL caches NEVER hit across requests. Convex QPS scales 1:1 with gateway QPS — the documented hot path budget (no Convex/Clerk per request) is dead in prod. Key verifier: per-request instantiation defeats the per-isolate memory cache; 60s negative caching of transport/429/5xx failures amplifies brief Clerk blips into minute-long auth outages.

**Fix:** Module-scoped or singleton dep construction. Move cache instantiation out of per-request path.

### 7. Authz: orgRole parsed but never enforced
**Files:** `convex/lib/auth.ts`, `convex/auth.config.ts`, `convex/projects.ts`, `convex/organizations.ts`.

`claims.orgRole` is parsed off every JWT and discarded everywhere. Any `org:member` can delete projects, flip visibility to public, rename org slug, register webhooks. `ensureOrganization` lets any member rename org + change public slug with no uniqueness enforcement. Deleted org can be resurrected with a zeroed wallet by stale JWT or late `organization.updated` webhook — silent prepaid-credit and publisher-earnings destruction.

**Fix:** Enforce `orgRole` on every org-scoped mutation. Gate destructive actions on `org:admin`. Add org-deletion tombstone.

### 8. Non-unique Convex indexes → duplicate-row races
**Files:** `convex/schema.ts`, `convex/users.ts`, `convex/organizations.ts`, `convex/wallets.ts`.

Convex has no native unique indexes. Every "one per X" read-then-insert idempotency guard (18+ sites) races under concurrency. `by_clerk_user` index on `users` is non-unique — concurrent webhook + app-boot both insert, every subsequent `.unique()` throws `NonUniqueResponseError` permanently, bricking `ensureUser` for that user. Same pattern on `by_clerk_org_id` for organizations, `by_organization` for wallets. Stripe-webhook path multiplies credit grants because the downstream `walletEntries.by_ref` dedupe key derives from the duplicated payment's `_id`.

**Fix:** Defensive insert-then-on-conflict-update, or application-level unique-key enforcement with retry. At minimum, handle `NonUniqueResponseError` gracefully.

### 9. Spec editor data loss
**Files:** `apps/web/src/components/spec-editor/spec-workspace.tsx`, `apps/web/src/routes/app/projects/$projectSlug/spec.tsx`, `apps/web/src/components/project-settings-panel.tsx`.

Three independent data-loss vectors: (1) concurrent/multi-tab edit silently clobbers unsaved local edits via unguarded `setText(savedDraft)` sync effect; (2) no `beforeunload`/`useBlocker` — navigating away within the 2s autosave window drops changes; (3) server-rejected draft (client says clean) loops autosave every 2s with toast spam + backend load, no backoff/circuit-breaker. Realtime `useEffect` sync overwrites in-progress edits on `project.tags` array ref change.

**Fix:** Track last-saved content (not boolean flag). Add `useBlocker` + `beforeunload` on dirty state. Circuit breaker on autosave failure.

### 10. SSR cross-user identity leak + header hygiene
**Files:** `apps/web/src/router.tsx`, `apps/gateway/src/headers.ts`, `apps/gateway/src/errors.ts`.

Module-scoped `convexQueryClient.serverHttpClient.setAuth(token)` and shared `queryClient` in root `beforeLoad` race under concurrent SSR (Cloudflare worker isolate), leaking cross-user identity/data across every authed Convex loader. Gateway `headers.ts` forwards consumer `Cookie` to upstream (session fixation) and reflects upstream `Set-Cookie` to clients (credential leak). `errors.ts` advertises "Never leaks internals" but `pipeline.ts` pipes raw `Error.message` into the 402/502 client body.

**Fix:** Per-request `ConvexHttpClient` instance in SSR. Strip `Cookie`/`Set-Cookie` in gateway proxy. Map internal errors to human-readable before sending to client.

---

## File-by-File Verdicts (top findings per file)

See `reviews/*.md` for full detail. Below: verdict + top finding per file.

### Convex (control plane)

| File | Verdict | Top Finding |
|------|---------|-------------|
| `wallets.ts` | NEEDS WORK | 7 P1: materialized balance/sequence overflow, cross-wallet refId-collision leak, no sign-by-kind guard, recordUsage input holes, missing admin audit |
| `accounting.ts` | NEEDS WORK | 2 P1: sub-cent residual credit loss on every transfer; publisherEarningSplit per-event yields 0% platform take on default 1-credit calls |
| `billing.ts` | DO NOT MERGE | 3 P0 + 5 P1: non-transactional grant pipeline, 200-before-grant, status paid before grant, concurrent refund double-debit |
| `payouts.ts` | DO NOT MERGE | 7 P1: illegal status transitions, stranded earnings, Stripe idempotency key >255 chars, refunds never reverse publisherEarnings |
| `earnings.ts` | FAIL | 3 P1: reversed/failed inflate totals, refund path never reverses publisherEarnings, unbounded full scan |
| `usage.ts` | NEEDS WORK | 2 P1: cross-org ledger leak in appendWalletEntry on refId collision, dead event.organizationId with unverified publisher attribution |
| `specs.ts` | BLOCKER | 3 P1: public query leaks private published specs, fractional x-zevium-cost floored to 0 (free), explicit cost:0 rewritten to 1 |
| `schema.ts` | NEEDS WORK | 1 P1: systemic uniqueness race (no native unique indexes, 18+ read-then-insert sites race) |
| `projects.ts` | NEEDS WORK | 2 P1: remove orphans 3 tables (specEmbeddings, webhookEndpoints, webhookDeliveries), getPublishedForGateway leaks private specs |
| `organizations.ts` | NEEDS WORK | 5 P1: deleted org resurrectable with zeroed wallet, mirror sync races, getBySlug/listMine have ZERO callers (attack surface only) |
| `users.ts` | NEEDS WORK | 2 P1: user.deleted silently dropped (GDPR/CCPA violation), duplicate clerkUserId insert race bricks ensureUser |
| `keySettings.ts` | NEEDS WORK | 1 P1: cross-org shadow-row DoS (convex trusts client keyId for new rows), client graceUntil unbounded |
| `webhooks.ts` | DO NOT MERGE | 1 P0 + 9 P1: SSRF via validateWebhookUrl, no terminal-state guard, retries permanent 4xx, secret re-exposed on every upsert/get |
| `http.ts` | DO NOT MERGE | 4 P1: 200-before-grant, timing-unsafe shared-secret compare, Clerk user.deleted silently dropped, no replay protection |
| `admin.ts` | NEEDS WORK | 3 P1: retryPublisherTransfer marks succeeded without inspecting Stripe status, retry-vs-webhook race, no admin audit trail |
| `analytics.ts` | NEEDS WORK | 2 P1: scans usageEvents ignoring time indexes (silently undercounts), fractional rangeDays collapses to 0 |
| `catalogue.ts` + `search.ts` | NEEDS WORK | 3 P1: Gemini API key in URL query string, unauthenticated search = denial-of-wallet, stale/orphaned embeddings never cleaned |
| `notifications.ts` | NEEDS WORK | 5 P1: listForOrg no dedupe by refId, readAt:undefined makes unread unindexable, humanError surfaces raw markRead error, no TTL/GC |
| `crons.ts` | NEEDS WORK | 7 P1: hourly cron wastes 23/24 ticks, no per-org error boundary, releaseMatureEarnings not wired to any cron |
| `dev.ts` | NEEDS WORK | 1 P1: published specVersions.spec body mutated in place (immutability violation), no production guard |
| `auth.config.ts` | NEEDS WORK | 2 P2: CLERK_JWT_ISSUER_DOMAIN guard leaks whitespace/path values, applicationID hardcoded magic string |
| `lib/auth.ts` | NEEDS WORK | 1 P1: orgRole parsed but never enforced (any org:member can delete projects, flip visibility, rename org) |
| `lib/validate.ts` | REJECT | 2 P0 + 3 P1: SSRF, pricing divergence, validateOpenApiSpec symbol collision across boundary |
| `lib/webhookDelivery.ts` | DO NOT MERGE | 1 P0 + 6 P1: SSRF via redirect-following, no idempotency key, retries permanent 4xx, raw errors in notification body |
| `lib/notifications.ts` | NEEDS WORK | 2 P1: cross-org notification creation, fan-out write amplification |

### Gateway (data plane)

| File | Verdict | Top Finding |
|------|---------|-------------|
| `pipeline.ts` | DO NOT MERGE | 7 P1: credit-gate settle/refund results discarded, no in-flight reaper, no upstream timeout, Cookie passthrough, SSRF, raw error leakage |
| `wallet.ts` | NOT SHIPPABLE | 6 P1: alarm() no try/finally orphans pending forever, key enforcement fails open on 3 paths, negative-balance escape when syncGrants lowers balance below in-flight hold |
| `index.ts` | SHIP-BLOCKED | 3 P1: per-request buildDeps defeats caches, /mock + /mcp leak private specs, unhandled DO RPC throws |
| `key-verifier.ts` | NEEDS WORK | 2 P1: per-request instantiation defeats memory cache, 60s negative caching amplifies Clerk blips into auth outages |
| `usage.ts` | INCORRECT | 2 P1: admin-key fallback hand-rolls Convex mutation request with wrong shape (loses ALL usage events), no batch-size cap |
| `mock.ts` | SHIP BLOCKER | 2 P1: private-spec info disclosure (keyless route has no visibility gate), O(N^5) synthesis explosion OOMs Worker |
| `mcp.ts` | INCORRECT | 1 P1: get_api_docs leaks private specs to unauthenticated callers |
| `discovery.ts` | INCORRECT | 3 P1: /discovery truncates to 24 items, leaks private specs, gatewayOrigin from Host header (origin poisoning) |
| `misc (cors/errors/headers/spec-source/catalogue-source/x402)` | DO NOT SHIP | 6 P1: Cookie/Set-Cookie passthrough, raw err.message to client, transient Convex errors cached 30s as false-404 |
| `spec-source.ts` | NEEDS WORK | 1 P1: transient Convex errors swallowed to null + cached 30s = false-404 outage |
| `catalogue-source.ts` | NEEDS WORK | 3 P2: caches Convex error responses as valid empty pages, unbounded user strings into cache key, mutable cached state |

### Shared package

| File | Verdict | Top Finding |
|------|---------|-------------|
| `shared deep (openapi+pricing+mock+index)` | REJECT | 2 P0: mock OOM DoS, SSRF via servers[0].url. Inverted pricing table (cost:0→1, cost:0.5→0 free) |
| `validate.ts` | REJECT | 2 P0 + 2 P1: SSRF, pricing divergence, dead exports, symbol collision |
| `pricing.ts` | INCORRECT | 1 P1: extractPricing rewrites cost:0→1, floors 3.9→3, free-tier never validated |
| `mock.ts` | INCORRECT | 1 P1: schema traversal explosion (recursive $ref → OOM) |
| `openapi.ts` | INCORRECT | 4 P2: parser DoS surface, missing size caps |
| `index.ts` | INCORRECT | 2 P2: dead exports, symbol collision, duplicate credit constants across packages |

### Web app

| File | Verdict | Top Finding |
|------|---------|-------------|
| `router.tsx` | INCORRECT | 1 P0: module-scoped setAuth races under concurrent SSR, leaking cross-user data |
| `routes/app/projects/$projectSlug/spec.tsx` | INCORRECT | 1 P0: SSRF (cloud-metadata reachable). 3 P1: data-loss (empty-draft wipe, concurrent clobber, no nav guard) |
| `routes/app/settings/keys.tsx` | FAIL | 5 P1: old Clerk key never revoked, client controls graceUntil+keyId, plaintext secret in DOM no auto-hide |
| `routes/app/settings/activity.tsx` | DO NOT SHIP | 1 P1: project filter shows false "No activity yet". 7 P2: hand-rolled pagination racy across filter/pagination/mount/live updates |
| `routes/app/billing.tsx` | NEEDS WORK | 1 P1: checkoutStateFromStatus never matches "complete" (stuck "Confirming payment" after credit). Internal config strings leak to toast |
| `routes/app/earnings.tsx` | INCORRECT | 3 P1: matured earnings never release without cron, failed transfer shadows new available, getPayoutState capped at 100 rows |
| `routes/catalogue/index.tsx` | FAIL | 2 P1: stale-results race (no request-token guard), tag-filter only from first 24-item page |
| `routes/catalogue/$orgSlug.$projectSlug.tsx` | INCORRECT | 1 P1: no error boundary, unbounded result.body rendered verbatim |
| `components/spec-editor/spec-workspace.tsx` | NOT READY | 3 P1: multi-tab clobber, no beforeunload/useBlocker, autosave loop on server-rejected draft |
| `hooks + ensure-mirror + clerk-client` | FAIL | 7 P1: duplicate-row race SSR↔client, stale-auth window, method:GET auth fns no cache-control, mass sign-out on Clerk outage |
| `lib/spec-import.ts` | INCORRECT | 2 P1: unrestricted SSRF oracle, no fetch timeout |
| `lib/api-keys.ts` | FAIL | 4 P1: non-atomic rotation, missing org-scope checks, client keyId trusted, clipboard never cleared |
| `lib/motion.ts` | INCORRECT | 3 P1: NumberTicker retargeting bug, SSR locale hydration mismatch, vt.ts latches vtState.active before SSR guard |
| `lib/webhook-secret.ts` | REJECT | 2 P1: dead code contradicts server secret format, isHexSecret rejects all real secrets |
| `routes/admin.tsx` | SHIPPABLE W/ CHANGES | 2 P1: retryPublisherTransfer marks succeeded without Stripe status, accumulated-pagination append-only = stale data |
| `routes/index.tsx` | INCORRECT | 4 P2: #pricing anchor 404, SSR opacity:0 no JS fallback, hardcoded stagger, layout shift |

---

## Product Implications

1. **Money is not safe.** The credit-grant pipeline (money-in) and payout pipeline (money-out) both have non-transactional paths that can lose events, double-grant, or strand earnings. A single transient failure on a Polar webhook = lost credits with no recovery. A Stripe idempotency key >255 chars = every non-trivial payout fails. This is the #1 blocker.

2. **Anyone can read private API specs.** The `getPublishedForGateway` query returns private project specs to anonymous callers. A competitor knowing two slugs can read the full OpenAPI spec (endpoints, schemas, upstream URL) of any private API. Reachable from `/mock`, `/mcp`, `/discovery`.

3. **Pricing is wrong.** Free endpoints (`x-zevium-cost:0`) get charged 1 credit. Fractional costs silently floored. Free-tier never validated. Publishers set one price, gateway charges another. This directly contradicts the product rule: "The OpenAPI spec is the source of truth for pricing."

4. **Gateway doesn't scale.** Per-request dep construction defeats every TTL cache. Every metered gateway call hits Convex. The hot path budget rule ("no Convex/Clerk per request") is dead in production. At any real volume, Convex becomes the bottleneck.

5. **SSRF from multiple paths.** Spec import, webhook delivery, spec validation, and gateway upstream fetches all accept internal/metadata IPs. An attacker can probe internal infrastructure and exfiltrate cloud metadata credentials.

6. **Spec editor loses work.** Multi-tab editing, navigation during autosave, and server-rejected drafts all silently destroy unsaved changes. Publishers will lose specs.

7. **Authz has holes.** Any org member (not just admin) can delete projects, flip visibility, and rename the org slug. Deleted orgs can be resurrected with zeroed wallets.

---

## Recommended Fix Priority

1. **P0: Transactional money pipeline** — billing.ts grant/refund/dispatch + payouts.ts status transitions + releaseMatureEarnings cron
2. **P0: SSRF guard** — single `assertPublicUrl()` across all server-side fetches
3. **P0: Private spec visibility gate** — gate `getPublishedForGateway` on `visibility === "public"`
4. **P0: Pricing single-source-of-truth** — make validator, editor, display, and extractPricing agree
5. **P0: Gateway cache singleton** — move dep construction out of per-request path
6. **P0: SSR per-request auth** — per-request `ConvexHttpClient`, not module-scoped `setAuth`
7. **P1: Webhook idempotency** — terminal-state guard + deliveryId propagation + 4xx classification
8. **P1: orgRole enforcement** — gate destructive mutations on `org:admin`
9. **P1: Spec editor data-loss** — last-saved-content tracking + useBlocker + autosave circuit breaker
10. **P1: Unique-key handling** — graceful `NonUniqueResponseError` handling or insert-or-update

---

*118 review files in `reviews/`. Each has full findings with line numbers, code snippets, impact, and fixes.*
