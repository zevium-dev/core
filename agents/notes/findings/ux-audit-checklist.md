# Zevium UX audit checklist and static audit

Date: 2026-07-19
Scope: `apps/web/src` user-facing routes/components, product contracts in `PRODUCT.md`, `FLOW.md`, `DESIGN.md`, and `.project/findings/production-md-to-html-dogfood.md`. No browser automation was run; this is a static audit plus review of the existing dogfood journal.

## How to use this checklist

For every persona journey, run each test at 320/400/768/1280 CSS px, keyboard-only, screen reader/accessibility tree, light/dark themes, `prefers-reduced-motion: reduce`, slow 3G, offline/API failure, empty data, long labels/URLs, and repeated submission. Record URL, role/name, expected/actual, request ID, and screenshot or DOM evidence. A finding is actionable only when it has a severity, journey, source location, user impact, and acceptance criterion.

Severity:

- **P0** — blocks a golden path, causes unsafe billing/data loss, or prevents an assistive-technology user completing a core task.
- **P1** — materially harms completion, discoverability, trust, error recovery, or repeatability, but a workaround exists.
- **P2** — polish, consistency, or efficiency issue with no material task block.

## Primary/high-quality source pack and practical tests

### WCAG 2.2 / WAI

- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) — normative success criteria.
- [Understanding 1.3.1 Info and Relationships](https://www.w3.org/WAI/WCAG22/Understanding/info-and-relationships.html): inspect headings, labels, table headers, field grouping, and DOM order; use a screen reader to confirm relationships survive visual styling.
- [Understanding 1.4.3 Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) and [1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html): measure normal text at 4.5:1, large text at 3:1, and focus/borders/icons at 3:1 in both themes.
- [Understanding 2.1.1 Keyboard](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html), [2.4.7 Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html), [2.4.11 Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured.html): Tab through every route; activate every control with Enter/Space; ensure focus remains visible and is not covered by sticky shell, dialog, or keyboard viewport.
- [Understanding 2.4.3 Focus Order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html) and [2.4.6 Headings and Labels](https://www.w3.org/WAI/WCAG22/Understanding/headings-and-labels.html): compare visual and DOM order; one descriptive page `h1`; headings describe purpose.
- [Understanding 3.3.1 Error Identification](https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html), [3.3.2 Labels or Instructions](https://www.w3.org/WAI/WCAG22/Understanding/labels-or-instructions.html), [3.3.3 Error Suggestion](https://www.w3.org/WAI/WCAG22/Understanding/error-suggestion.html): submit blank, malformed, too-long, unauthorized, insufficient-credit, timeout, and duplicate forms; identify the field, preserve input, explain correction, focus first error, and announce it.
- [Understanding 4.1.2 Name, Role, Value](https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html) and [4.1.3 Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html): inspect accessible names/states and verify save/toast/loading/result updates are announced without focus theft.
- [WAI Forms Tutorial](https://www.w3.org/WAI/tutorials/forms/): every control has a programmatic label, useful autocomplete/input type, grouped related controls, and errors adjacent to the control.

### Interaction and content heuristics

- [Nielsen Norman Group: 10 Usability Heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/): test visibility of system status, match to real-world language, user control/undo, consistency, error prevention/recovery, recognition over recall, and help. For each mutation, capture pending, success, failure, retry, and cancellation states.
- [GOV.UK: Form validation](https://www.gov.uk/service-manual/design/form-validation), [Error messages](https://design-system.service.gov.uk/components/error-message/), and [Question pages](https://design-system.service.gov.uk/patterns/question-pages/): validate on submit and (where useful) blur, place a summary plus inline messages, use plain language and a specific fix, never erase entered values, and do not prevent users pasting secrets/codes.
- [Material 3: Buttons](https://m3.material.io/components/buttons/overview), [Progress indicators](https://m3.material.io/components/progress-indicators/overview), and [Dialogs](https://m3.material.io/components/dialogs/overview): primary action is unambiguous; progress communicates what is happening; destructive/irreversible actions state consequence and require deliberate confirmation.
- [Apple Human Interface Guidelines: Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback): every action has immediate, intelligible feedback; errors explain recovery; avoid feedback that disappears before a user can perceive it.
- [Vercel Web Interface Guidelines (latest fetched source)](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md): check semantic controls, labels, `aria-live`, visible `:focus-visible`, autocomplete/types, inline errors, reduced motion, explicit transition properties, URL-synced state, destructive confirmation/undo, long-content handling, and actionable error copy. Source fetched 2026-07-19.

### API marketplace/developer-portal patterns

- [OpenAPI 3.1 Specification](https://spec.openapis.org/oas/v3.1.0.html): rendered docs and playground must reflect the published contract, operation, media type, examples, parameters, and security—not a parallel hand-maintained interpretation.
- [Google API Design Guide: Errors](https://cloud.google.com/apis/design/errors), [HTTP semantics](https://cloud.google.com/apis/design/standard_methods), and [AIP-193](https://google.aip.dev/193): show stable machine status plus human action; preserve request/correlation ID; distinguish authentication, authorization, quota, validation, upstream, and transient failures.
- [Microsoft REST API Guidelines](https://github.com/microsoft/api-guidelines/blob/vNext/Guidelines.md): consistent resource URLs, HTTP methods/statuses, error envelopes, pagination/filter semantics, and retry guidance. Test copied/deep-linked filtered URLs and back/forward restoration.
- [Postman: API documentation](https://learning.postman.com/docs/publishing-your-api/documenting-your-api/): docs should provide discoverable examples, authentication instructions, and copyable working snippets. Test every generated snippet against the displayed endpoint/media type.
- [Swagger UI](https://swagger.io/tools/swagger-ui/) and [Redocly documentation](https://redocly.com/docs-legacy/developer-portal/guides/docs-navigation/): endpoint navigation, method/path, auth, parameters, examples, and response schemas stay synchronized and scannable.

## Reusable journey checklist

### Visitor / consumer golden path (P0)

1. `/` → `/catalogue` via keyboard and deep link; verify one `h1`, skip link, meaningful link names, no layout shift, and catalogue fallback is clearly labeled as fallback rather than live inventory.
2. Catalogue search/filter/sort: type, submit, clear, reload, copy URL, open in new tab, use back/forward, and test no results/degraded search/network failure. URL must encode state or product must explicitly state it is session-local.
3. Detail page: verify OpenAPI path, method, summary, request/response media type, price/free tier, auth, examples, and generated curl/MCP config all agree. Test a text/plain and JSON operation, path parameter escaping, long response, 4xx/402/429/5xx, CORS/network error, retry, and mock mode.
4. Try-it: make charged-vs-mock state impossible to confuse; require deliberate send; show estimated charge before send; never put a secret in a copied snippet without a warning and explicit opt-in; expose status, timing, response, and request ID; announce results to assistive technology.
5. Sign up/sign in: keyboard complete, password manager works, pasted credentials work, errors identify correction, focus goes to first error, redirect returns to intended route, and org creation is explained.
6. `/app` onboarding: first visit has exactly one next action; complete key → call → top-up in under 60 seconds with preserved state, actionable failures, and no dead-end empty cards.

### Publisher / admin journeys

1. Create org/project: labels, slug preview/normalization, uniqueness conflict, description persistence, cancel/back, and success destination are explicit.
2. Spec editor: import URL/file/template, validation, autosave, stale/pending indicators, unsaved-change navigation guard, recoverable parse/network errors, pricing lint, draft save, publish semver, immutable version, and endpoint rail refresh are all observable.
3. Settings/credentials: secrets are write-only, paste works, replacement/removal are deliberate, no secret appears in logs/snippets, and upstream failure explains safe remediation.
4. Visibility/deletion/deprecation: destructive action names consequence, requires confirmation or undo, supports Escape/cancel, and post-action state is canonical across all surfaces.
5. Analytics/earnings/billing: empty/loading/error states retain context; totals disclose truncation/projection; credits, fees, pending risk, and dates use unambiguous number/date formatting; tables remain usable on mobile and with zoom.
6. Org switching: active org is visible, switching updates every query and URL/state, no cross-org data flash, and unauthorized/deleted org has recovery guidance.

## Static findings in current code and journal

### 2026-07-19 dogfood reconciliation

The following findings below are historical static-audit entries and are
resolved in the local implementation/dogfood run: Activity shell
discoverability, explicit public-visibility confirmation, initial endpoint-rail
reconciliation, current/previous key-grace labeling, and the explicit
“Copy with key” warning. They remain documented for audit traceability rather
than as release blockers. The remaining search/deep-link, degradation, error
copy, accessibility, and form-contract entries still require their stated
acceptance tests.

### P1 — Activity is not discoverable from the app shell

- **Persona/journey:** Consumer → inspect usage/activity after first call.
- **Evidence:** `apps/web/src/components/app-sidebar.tsx:27-52` lists Dashboard, Catalogue, Projects, Organization, Billing, Earnings, Settings, Docs but no Activity. Journal confirms `/app/activity` is Not Found and actual route is `/app/settings/activity` (`.project/findings/production-md-to-html-dogfood.md`, Issues, “Activity route discoverability mismatch”).
- **User impact:** A consumer following the product’s activity promise cannot find call history; guessing the documented-looking URL dead-ends.
- **Acceptance criterion:** Add an obvious Activity destination (or make `/app/activity` a deliberate redirect) and ensure active state, breadcrumb/title, keyboard navigation, deep link, back/forward, and empty/error states work. **Known local fix:** none recorded in journal.

### P1 — Search and catalogue filters are not deep-linkable

- **Persona/journey:** Visitor/consumer → share or resume catalogue evaluation.
- **Evidence:** `apps/web/src/routes/catalogue/index.tsx:81-92` stores search, tag, sort, free-only, and max-cost controls in local React state; `:94-101` separately stores semantic results. No route search params are read or written.
- **User impact:** Refresh, back/forward, copied URL, and shared links lose the exact evaluation state; agents/humans cannot hand off a filtered catalogue view.
- **Acceptance criterion:** Encode all meaningful filters/query/sort in validated URL search params; reload and back/forward reproduce state; semantic degraded/error state is explicit and does not silently change the user’s interpretation.

### P1 — Semantic-search degradation is silent

- **Persona/journey:** Visitor/consumer → find an API by intent.
- **Evidence:** `apps/web/src/routes/catalogue/index.tsx:93-111` sets semantic results to `null` on `res.degraded` or error, while comments explicitly call this a “silent substring fallback.”
- **User impact:** User believes ranked semantic results were returned when exact substring browse results were shown; relevance and trust are compromised.
- **Acceptance criterion:** Preserve query, announce “Semantic search unavailable; showing exact matches,” offer retry, and expose loading/success/degraded/error via `role=status`/`aria-live` without stealing focus. Test Gemini failure and retry.

### P1 — Try-it can copy credentials into a shell command without warning

- **Persona/journey:** Consumer → copy integration command.
- **Evidence:** `apps/web/src/routes/catalogue/$orgSlug.$projectSlug.tsx:637-641` adds the API key to headers; `:647-658` builds curl; `:833-846` copies it with the label “Copy as curl.”
- **User impact:** Clipboard, shell history, screenshots, support tickets, and shared snippets can leak a long-lived gateway secret. The copy action gives no secret-handling warning or redaction choice.
- **Acceptance criterion:** Default generated curl redacts/omits the secret (`YOUR_API_KEY`), visibly says replacement is required, and offers a separate explicit “Copy with key” action with warning. Test empty key, masked key, clipboard failure, and repeated copy.

### P1 — Playground exposes raw gateway/upstream response bodies for errors

- **Persona/journey:** Consumer → recover from failed paid call.
- **Evidence:** `apps/web/src/routes/catalogue/$orgSlug.$projectSlug.tsx:599-627` stores every response body verbatim; `:860-875` renders it through `SyntaxCode`. Only network exceptions are mapped through `humanError`; HTTP 401/402/429/5xx bodies are not mapped to user guidance.
- **User impact:** Internal/provider details may leak; a user sees machine payloads without “check balance,” “rotate key,” “retry later,” or request ID. This violates the product rule that users get human-readable errors.
- **Acceptance criterion:** Map status classes to plain-language copy and next action, preserve request ID/status/endpoint, include collapsible raw details only when safe, and never display secrets/internal stack traces. Test 401, 402, 429, 500, malformed body, and upstream timeout.

### P1 — Key rotation UI contradicts actual grace-period state

- **Persona/journey:** Consumer → rotate/revoke a production key safely.
- **Evidence:** `apps/web/src/routes/app/settings/keys.tsx:183-187` says “One active key per user” and “1 active key allowed per user,” while journal records two rotations leaving three enabled keys and notes the mismatch (`production-md-to-html-dogfood.md`, Issues, “Rotation permits multiple enabled keys”).
- **User impact:** Users cannot tell which key is active, when old keys expire, or whether multiple enabled rows are intentional grace-period overlap; stale credentials remain attack surface.
- **Acceptance criterion:** Represent `current`, `grace until`, and `revoked` explicitly; explain 24-hour overlap; enforce or clearly document one current key; show expiry countdown/date and provide safe revoke. Test rotate twice, refresh, gateway propagation delay, and revoke old key.

### P1 — Destructive visibility action is inconsistent

- **Persona/journey:** Publisher → make listing public or private.
- **Evidence:** Journal reports Spec rail `Make public` changed visibility immediately despite dialog-capable metadata, while Settings uses explicit confirmation (`production-md-to-html-dogfood.md`, Issues, “Visibility confirmation inconsistency”).
- **User impact:** A publisher can expose an unfinished/protected API unintentionally; inconsistent confirmation makes the action hard to predict.
- **Acceptance criterion:** Every visibility transition uses one consistent pattern: explicit confirmation naming audience, URL, pricing, and consequence, or a short undo window. Post-action status updates everywhere and is announced.

### P1 — New spec endpoint rail initially reports stale data

- **Persona/journey:** Publisher → validate pricing and publish an imported spec.
- **Evidence:** Journal says newly created default spec visibly contained `/health` while endpoint rail reported `0 endpoints` until editor content changed (`production-md-to-html-dogfood.md`, Issues, “Initial endpoint rail stale”).
- **User impact:** Publisher may publish believing there are no endpoints or miss missing prices; visible editor and summary disagree.
- **Acceptance criterion:** On initial load/import, parse and reconcile editor text and rail before enabling publish/save; show “updating” while stale, never display `0` as authoritative; test hard load, hydration, import, autosave, and parse failure.

### P2 — Playground authentication sends two credential headers

- **Persona/journey:** Consumer → try a request and inspect/copy it.
- **Evidence:** `apps/web/src/routes/catalogue/$orgSlug.$projectSlug.tsx:583-588` and `:636-641` send both `Authorization: Bearer` and `X-Api-Key` for one key.
- **User impact:** Confusing generated requests, duplicated secret exposure, and ambiguous upstream/gateway behavior; users cannot tell canonical integration contract.
- **Acceptance criterion:** Send and document one canonical gateway auth header; if compatibility requires both, explain why, suppress publisher forwarding, and show the canonical snippet separately.

### P2 — Heading semantics contain a nested heading

- **Persona/journey:** Consumer → navigate dashboard with screen reader.
- **Evidence:** `apps/web/src/routes/app/index.tsx:190-194` renders `<CardTitle><h2>Recent calls</h2></CardTitle>`; stock `CardTitle` is itself heading-like in the UI primitive.
- **User impact:** Assistive technology may expose duplicate/nested heading structure, making section navigation noisy or invalid.
- **Acceptance criterion:** Each section has one semantic heading at the intended level; verify accessibility tree and heading list for dashboard, catalogue, detail, settings, and editor.

### P2 — Form autocomplete and examples are inconsistent with guidance

- **Persona/journey:** Consumer/publisher → complete forms with password managers and keyboard.
- **Evidence:** `apps/web/src/routes/catalogue/$orgSlug.$projectSlug.tsx:761-767` uses password API-key input with `autoComplete="off"`; `:754` uses placeholder equal to parameter name rather than an example; `:801` uses an example placeholder only for headers. `apps/web/src/components/project-settings-panel.tsx:474-490` uses placeholders for credential name/value but no explicit examples/help beyond placeholder.
- **User impact:** Password managers and users cannot infer accepted format reliably; placeholders disappear on entry and do not provide durable instruction.
- **Acceptance criterion:** Use meaningful `name`, `autocomplete` semantics appropriate to machine credentials, persistent help text, correct `type`/`inputmode`, and examples that match actual OpenAPI parameter/media-type constraints. Test paste, autofill, zoom, and validation.

## Known fixes already present locally (do not relabel as current defects)

The journal records these as implemented and locally verified; production status must be checked separately before claiming shipped:

- Upstream credential storage/UI, write-only secret handling, Convex gateway-spec delivery, header injection, blocked-header/CRLF validation: journal steps 24–28.
- Workerd `fetch` receiver bug fixed: steps 38–40.
- Non-JSON mock responses/content types fixed and tested: steps 41–42.
- Playground `/gateway` URL normalization and OpenAPI request-body/media-type defaults fixed; web tests 159/159 and typecheck green: steps 60–71.
- Project deletion cascades credentials and local temporary fixture cleanup completed: steps 88–89.

## Operator/automation/environment failures — not product UX findings

Keep these separate from application defects and reproduce manually before filing as product bugs:

- Helium permission prompt, bridge EOF/timeouts, stale port 9222, and screenshot hangs: browser/operator environment; journal Issues.
- Vercel CLI unauthenticated/expired session and dashboard transient “Something went wrong”: operator/environment.
- DevTools `fill`/paste not dispatching React input events, repeated paste concatenating secrets, wrong clipboard selector, and secret exposure in automation snapshot: automation/operator; not evidence of ordinary user behavior.
- Local gateway/Convex secret mismatch and production Convex URL inherited by localhost Worker: environment configuration drift; not a visitor UX defect.
- Rotated-key propagation delay up to one minute: expected distributed-system behavior; UI should communicate it, but the delay itself is not an automation failure.
- Slug separator loss during DevTools input may be automation-induced (`md-to-html` became `mdtohtml`); first reproduce with ordinary keyboard/manual submission before assigning product severity.
- Description loss was automation-induced controlled-textarea input; native input event made persistence succeed. Keep a manual regression test because the same symptom would be P0 data loss if reproducible with normal typing.

## Exit criteria for a release audit

- All P0/P1 findings have acceptance tests run on every affected route and persona; no raw/internal error leakage; no unconfirmed destructive action; no golden-path dead end.
- Keyboard and screen-reader pass includes focus order, names/roles/states, live status, errors, dialogs, tables, and mobile navigation.
- Every stateful catalogue/editor/filter state is deep-linkable or explicitly documented as ephemeral.
- Published OpenAPI, rendered docs, playground request, curl/MCP snippets, gateway status/errors, pricing, and auth behavior are contract-identical.
- Tests cover empty, loading, degraded, unauthorized, insufficient-credit, rate-limited, upstream-failure, retry, duplicate-submit, offline, long-content, dark/light, zoom, and reduced-motion states.
- Dogfood evidence distinguishes observed production behavior, current local code, and operator/environment failures; no secret values are stored in reports.
