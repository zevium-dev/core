# Production dogfood: md-to-html

Date: 2026-07-19

Goal: publish locally owned `md-to-html` Vercel API through Zevium production, then verify discovery, mock, metered execution, usage, and publisher earnings.

Security note: credentials and browser/session identifiers are never copied into this document. Secret values are recorded only as redacted configuration actions.

## Steps and observations

1. Confirmed Zevium production surfaces before this run:
   - `https://www.zevium.dev` rendered successfully.
   - `https://gateway.zevium.dev/health` returned `{"ok":true,"service":"zevium-gateway"}`.
   - `https://www.zevium.dev/catalogue` showed zero public APIs.
2. Located owned API project at `/home/tnfssc/Code/md-to-html`.
3. Found both Chrome and Helium remote-debugging endpoint files. Browser selection follows newest valid endpoint and a page-count-only liveness check; endpoint details remain redacted.
4. Selected Helium because its valid endpoint file was newer.
5. Started stable `cdt-helium` DevTools session successfully.
6. Inspected owned API source:
   - Hono `POST /` accepts `text/plain`.
   - Upstream authentication uses `x-api-key`, matched against `API_KEY`.
   - Success returns rendered `text/html` plus JSON-encoded `x-frontmatter`.
   - OpenAPI is served at `/openapi.json`; Scalar docs at `/scalar`.
7. Vercel CLI lookup failed because local CLI has no authentication token. GitHub deployment status confirmed latest Vercel deployment succeeded and supplied authenticated Vercel dashboard URL.
8. User approved Helium DevTools permission. Retried same stable session; liveness check succeeded with four pages.
9. Found task-relevant existing tabs without exposing unrelated tabs:
   - Vercel production environment for `md-to-html`.
   - Signed-in Zevium production dashboard.
10. Confirmed Vercel production:
    - Production branch is `develop`.
    - Production domain is `https://md-to-html-lemon.vercel.app`.
    - `API_KEY` exists for production.
11. Fetched deployed `/openapi.json`. Contract matches source, but lacks `servers`, operation metadata, and `x-zevium-cost`.
12. Confirmed active Zevium organization is `Sharath Chandra's Organization`, with 100,000 credits and no prior metered calls.
13. Opened Projects. One existing private draft named `test-22` was present.
14. Created project with:
    - Name: `Markdown to HTML`
    - Requested slug: `md-to-html`
    - Description: `Convert Markdown to styled HTML with GFM, syntax highlighting, MathJax, frontmatter, emoji, and external-link handling.`
15. Project creation succeeded as a private draft.
16. Opened Spec editor. Default spec displayed one `/health` path in editor but endpoint rail initially reported `0 endpoints`.
17. Replaced default spec with production contract:
    - OpenAPI 3.1.0, version 1.0.0.
    - Server `https://md-to-html-lemon.vercel.app`.
    - `POST /`, operation ID `renderMarkdown`.
    - `text/plain` request and `text/html` response.
    - Price: 20 credits/call.
    - Publisher-funded free tier: 5 calls/day.
18. Autosave succeeded. Editor rail updated to `1 endpoints, 20 credits, free tier on 1`; validation reported `Clean`.
19. Editor still warned `No description` despite description being submitted during project creation.
20. Opened Settings. Description was empty and slug was permanently locked to unexpected `mdtohtml`.
21. Restored description, added tags `markdown, html, rendering, developer-tools, content`, and saved successfully.
22. Looked for documented upstream credential controls in project Settings. None exist.
23. Confirmed source-level blocker:
    - Publishing docs tell users to attach upstream credentials in project Settings.
    - Convex schema/functions have no upstream-credential model.
    - Gateway strips consumer `Authorization` and `x-api-key`.
    - Gateway forwards no publisher-owned secret.
    - Therefore protected `md-to-html` cannot be executed through Zevium without leaking its secret or disabling upstream auth.
24. Implemented upstream credential path:
    - Added project-scoped `upstreamCredentials` table with indexed header names.
    - Added authenticated publisher list/upsert/remove functions. Publisher reads receive metadata only; secret values are write-only.
    - Added shared-secret-authenticated Convex `/gateway-spec` endpoint returning immutable published spec plus server-only upstream headers.
    - Gateway now uses internal HTTP spec source when internal secret is configured, caches response for 30 seconds, strips consumer auth headers, then injects publisher headers.
    - Added project Settings card for credential name/value, write-only secret input, configured-header list, replacement, and removal.
    - Project deletion now removes credential rows.
25. Pushed Convex schema/functions to development deployment and regenerated API types.
26. Added behavior tests:
    - Convex authorization, write-only metadata, canonical header names, replacement, removal, internal gateway delivery, and CRLF/blocked-header rejection.
    - Gateway internal spec-source authentication/parsing.
    - Gateway consumer-header stripping and publisher-header injection.
27. First focused Convex test run had one assertion mismatch: auth helper returned `Not a member of this organization`, not expected `Project not found`. Corrected test to actual established auth contract.
28. Verification passed:
    - Focused Convex tests: 5/5.
    - Gateway suite: 83/83.
    - Root build: green.
    - Root tests: shared 43, web 156, gateway 83, Convex 109 — all green.
    - Root typecheck: green.
29. User authorized production delivery after blocker explanation.
30. Created commits:
    - `8fe98a1 docs: sync project roadmap`
    - `a1026c1 feat(gateway): inject publisher upstream credentials`
31. Pushed `develop`; CI-gated production deployment pending.
32. CI passed in 3m37s. Production deployment passed Convex, gateway, web, and smoke-test stages in 2m29s.
33. Refreshed production Settings. Upstream credential UI appeared.
34. Copied existing Vercel `API_KEY` through browser clipboard and pasted it into write-only Zevium secret field. Saved `x-api-key`; post-save UI showed header name and timestamp only.
35. Published immutable version `1.0.0` and made project public.
36. Public catalogue and detail page rendered listing, description, tags, version, 20-credit price, and 5/day free tier.
37. First anonymous mock request returned `404 project_not_found` after cache-expiry retry.
38. Production Worker tail revealed exact failure: `InternalHttpSpecSource.getPublishedSpec failed TypeError: Illegal invocation: function called with incorrect this reference.`
39. Root cause: gateway stored bare Workerd global `fetch` in a private field, then invoked it with the class instance as receiver. Workerd requires global receiver. Fixed default fetch with closure that calls global `fetch` directly.

## Issues

- **Browser permission blocked automation:** first page-count liveness command timed out after 30 seconds immediately after DevTools session start. This matches Helium's permission-gated remote-debugging flow. User must click **Allow** in Helium; same stable session and endpoint will then be retried.
- **Vercel CLI unavailable:** `vercel ls md-to-html` returned `Error: The request is missing an authentication token`. Browser-authenticated Vercel dashboard is used instead; no token workaround attempted.
- **DevTools key spelling:** `press_key ESC` failed because CLI accepts `Escape`, not `ESC`. Retrying with `Escape` closed Clerk organization dialog.
- **Sensitive-value exposure risk:** Vercel environment page had secret value already revealed. Accessibility snapshot therefore included it in raw automation output. Value is intentionally omitted here and will not be repeated. Production secret should be rotated after Zevium credential configuration because automation transcript is not a safe secret store.
- **Slug changed unexpectedly:** create form was filled with `md-to-html`, but created project URL and displayed slug are `mdtohtml`. No validation message or normalization preview appeared. This harms readable gateway/catalogue URLs and should be fixed or clearly previewed.
- **Description silently dropped:** description was filled before `Create project`, but created project had an empty description and editor warned that catalogue card would be blank. Saving same description through Settings worked.
- **Initial endpoint rail stale:** newly created default spec visibly contained `/health`, yet rail showed `0 endpoints` until editor content changed.
- **P0 launch blocker — upstream credentials are documentation-only:** app has no credential UI or backend/gateway injection path. Protected upstreams cannot work. Fix must land before publishing this listing; passing the Vercel secret from consumers or making upstream public would violate product contract.
- **Authorization test wording differed:** focused test expected hidden-resource wording, while shared auth helper intentionally returned `Not a member of this organization`. Implementation was correct; test expectation changed.
- **Production deployment requires repository delivery:** local fix is verified, but Zevium production cannot expose credential UI/injection until changes are committed and pushed through CI-gated `develop` deployment.
- **Textarea automation limitation, not app data loss:** `chrome-devtools fill` changed raw textarea DOM value but did not update React controlled state. Saving therefore sent empty description. Dispatching native textarea `input` event updated React state; reload proved persistence. Earlier “description silently dropped” observation was automation-induced.
- **Visibility confirmation inconsistency:** Spec rail's `Make public` action changed visibility immediately even though accessible metadata reported a dialog-capable control. Settings visibility action uses explicit confirmation.
- **Production-only Workerd fetch binding bug:** default internal spec source stored bare global `fetch`; tests injected a mock and could not reproduce receiver requirement. Result was `Illegal invocation` and every gateway/mock lookup returned `project_not_found`. Fixed default path to call global `fetch` through closure.
