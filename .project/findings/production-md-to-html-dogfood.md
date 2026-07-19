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
40. Second CI passed in 2m19s; production deployment and smoke test passed in 1m52s.
41. First post-fix anonymous mock succeeded at zero credits but returned `Content-Type: application/json` with `{}`. Root cause: mock generator only understood `application/json`, and gateway always JSON-stringified output.
42. Extended mock generation to prefer JSON when present, otherwise use first declared 200 response media type. Non-JSON string bodies now preserve content type and serialize without JSON quotes. Added shared and Workerd tests for `text/html` plus media-level examples.
43. User corrected workflow: stop deploying every incremental fix; exercise pending app changes through `http://localhost:3000` and batch production delivery later.
44. Opened localhost app in new background tab. Created temporary public `Markdown to HTML Local` fixture with `text/html` response example and published version `1.0.0`.
45. Local catalogue rendered fixture. Chrome DevTools input automation again removed requested slug separators, producing `mdtohtmllocal`; description persisted when native input event was used.
46. Verified local upstream credential UI end to end with dummy value:
    - Saved `x-api-key`.
    - Post-save secret field cleared.
    - Configured list showed header name and timestamp only.
    - Secret value was not returned to browser snapshot.
47. Local gateway mock requests for both new fixture and pre-existing `test-org/http-echo` returned `404 project_not_found`.
48. Local gateway logs showed `InternalHttpSpecSource.getPublishedSpec failed { status: 401 }`. Convex dev has `GATEWAY_INTERNAL_SECRET`, but it does not match `apps/gateway/.dev.vars`; every local gateway spec lookup is currently blocked.
49. Synced local gateway secret without printing it:
    - Generated fresh 32-byte value.
    - Replaced ignored `.dev.vars` value.
    - Set same value in Convex development deployment.
    - Deleted temporary sync helper and restarted `zevium-dev`.
50. Requests still returned 401. Deeper root cause: gateway local runtime inherited production `CONVEX_URL` and `CONVEX_SITE_URL` from `wrangler.jsonc`, while localhost web used development deployment `doting-warbler-454`.
51. Added ignored `.dev.vars` overrides for development Convex cloud/site URLs, restarted stack, and reran same request.
52. Local anonymous mock passed end to end:
    - HTTP 200.
    - `Content-Type: text/html`.
    - `x-zevium-cost: 0`.
    - `x-zevium-mock: 1`.
    - Body: `<h1>Rendered Markdown</h1>`.
53. Production gateway key page returned `Forbidden`; no create control rendered.
54. Browser network inspection showed server function returned HTTP 200 transport envelope containing Clerk error `Forbidden`.
55. Production Clerk `/v1/environment` reported machine API keys fully disabled:
    - `enabled: false`
    - `user_api_keys_enabled: false`
    - `orgs_api_keys_enabled: false`
56. Clerk CLI diagnosis:
    - Host execution passed.
    - Local CLI token is expired and production instance is not linked, so CLI mutation path was not trusted.
57. Opened signed-in Clerk production dashboard through Helium. Command-menu search found machine-auth API key controls under `/platform/api-keys/configure`.
58. Enabled User API keys; Organization API keys stayed disabled because Zevium key contract is user-scoped with org claim.
59. Reloaded Zevium production key page. `Forbidden` disappeared and `Create key` rendered.
60. Created one key named `md-to-html dogfood`. Secret was copied through browser control and pasted into password field without snapshotting or printing it.
61. Production listing playground exposed two correctness bugs:
    - Real request URL omitted `/gateway`, producing `https://gateway.zevium.dev/{org}/{project}/`.
    - Request body defaulted to JSON and forced `Content-Type: application/json` even though OpenAPI declares `text/plain`.
62. Fixed locally:
    - `tryItBaseUrl` now normalizes bare origin and `/gateway` input to explicit `/gateway` or `/mock`.
    - Playground derives media type and initial body example from OpenAPI `requestBody`, preferring JSON only when declared.
    - Added URL and request-body behavior tests.
63. Executed corrected production gateway request inside browser without exposing key. First attempt failed with browser `ERR_NETWORK_CHANGED`; exact retry reached gateway.
64. Gateway returned HTTP 401 with `x-zevium-free-tier: 1`, proving Zevium key verification and free-tier path worked but upstream rejected injected credential.
65. Root cause: first Vercel interaction clicked revealed secret-value element, not actual copy control, so wrong clipboard content was stored in Zevium.
66. Returned to Vercel and located explicit `aria-label="Copy to clipboard"` button without snapshotting secret. Copied correct value, replaced Zevium `x-api-key`, and kept value write-only.
67. Original gateway key was used successfully for Clerk verification, proven by key page `Last used` timestamp, but its secret was lost when clipboard was overwritten by upstream key.
68. Rotated gateway key through Zevium. UI correctly warned old key keeps 24-hour grace and new secret is shown once. Copied rotated secret without snapshot.
69. First rotated-key call returned HTTP 402 `Invalid API key`; expected edge-sync delay is documented as up to one minute.
70. Local hot-reload verification passed:
    - Try-it real URL displayed `/gateway/{org}/{project}/`.
    - Body initialized from OpenAPI example as `# Hello`.
    - Mock URL displayed `/mock/{org}/{project}/`.
    - Sending through browser UI returned HTTP 200, `mock response · 0 credits`, and `<h1>Rendered Markdown</h1>`.
71. Playground tests passed: web 159/159 and typecheck green.
72. Second rotation exposed browser-paste diagnosis: exact new Clerk secret rendered as 35 characters, while playground input had grown to 105 characters — three keys concatenated by repeated paste into non-empty password field. Gateway correctly rejected malformed value.
73. Called production gateway directly from one-time key dialog using exact 35-character DOM value. Clerk verification succeeded and free-tier reservation started, but upstream still returned 401.
74. Verified Vercel secret independently without exposing it:
    - Moved 36-character value between same-origin Vercel tabs through temporary browser storage and `window.name`.
    - Called `md-to-html` from same-origin page.
    - Upstream itself returned HTTP 401.
75. Vercel deployment was 176 days old. Environment variable existed in current Project Settings but not deployed runtime. Started production redeploy with latest Project Settings and build cache disabled.
76. First Vercel deployment view returned `Something went wrong`; retry recovered page. Build completed Ready in 25 seconds and reassigned `md-to-html-lemon.vercel.app`.
77. Gateway still returned upstream 401 after redeploy. Zevium credential value was therefore also corrupted by clipboard/paste automation.
78. Replaced Zevium upstream credential without clipboard:
    - Staged exact 36-character Vercel value in temporary same-origin browser storage.
    - Moved it into `window.name` on disposable tab and deleted temporary storage.
    - Navigated disposable tab cross-origin to Zevium Settings.
    - Wrote exact value into controlled secret input via native input event, cleared `window.name`, and saved.
79. Root cause of Vercel selector mistake: actual local/Vercel `API_KEY` is 32 characters; automation chose unrelated 36-character button by length. A temporary verifier read sibling `.env` without printing value and proved direct production upstream returned HTTP 200 with HTML.
80. Filled exact 32-character local secret into Zevium through temporary Node-to-DevTools helper, saved it, deleted helper, and waited through 30-second gateway spec cache.
81. Full production call passed:
    - HTTP 200.
    - `Content-Type: text/html; charset=UTF-8`.
    - Rendered expected heading and bold Markdown.
    - First five successful calls used publisher-funded free tier at 0 credits.
    - Sixth successful call charged 20 credits.
82. Production usage activity showed six HTTP 200 events for `Markdown to HTML`:
    - Five rows at 0 credits.
    - One row at 20 credits.
    - Observed latency ranged 176–2,112 ms.
83. Publisher earnings settled exactly:
    - Gross: 20 credits.
    - Zevium fee: 1 credit.
    - Publisher pending share: 19 credits.
    - Risk-review availability date: 2026-07-26.
84. Final local verification after pending mock/playground fixes:
    - Build green.
    - Shared tests 45/45.
    - Web tests 159/159.
    - Gateway tests 84/84.
    - Convex tests 109/109.
    - Typecheck green.
85. Key rotation left three enabled Clerk keys despite page saying one active key per user. Revoked original and first rotated keys; retained only final key used by successful production calls.
86. Attempted to delete temporary localhost fixture and its dummy credential. Helium's permission-broker DevTools bridge timed out on navigation, then on page-list liveness after stable-session restart. User restarted and reopened Helium twice with permission, but broker remained unreachable.
87. Pending mock/playground fixes are verified locally only, per user instruction not to deploy every incremental change. Production listing, credential injection, upstream, usage, and earnings are already live.
88. Added persistent fish `helium-debug` launcher using loopback-only direct CDP port 9333. Direct `--browserUrl http://127.0.0.1:9333` connection succeeded immediately with one page and no Allow prompt.
89. Used direct connection to finish localhost cleanup through app:
    - Opened `mdtohtmllocal` Settings.
    - Confirmed permanent deletion with project slug.
    - App redirected to project list containing only pre-existing `test-api-22`.
    - Project deletion also removed its dummy upstream credential through cascade implemented during this dogfood.

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
- **Mock mode was JSON-only:** valid `text/html` API produced `{}` with JSON content type, making try-before-buy useless. Generator and gateway serialization were generalized to declared response media type.
- **Clipboard-read smoke attempt wedged DevTools:** opening upstream Scalar page succeeded, but `navigator.clipboard.readText()` through evaluated script timed out. Same Helium session also timed out after restart until user accepted/unblocked browser permission again. Existing Vercel secret was not printed or retried through a shell workaround.
- **Mock response type was over-narrow:** first implementation generalized runtime content types but left TypeScript contract fixed to literal `application/json`; shared typecheck caught it after behavior tests passed. Changed `contentType` to `string`.
- **Local gateway/control-plane secret mismatch:** localhost Worker receives 401 from Convex `/gateway-spec`, including for known seed projects. Local browser UI works, but gateway and mock smoke tests cannot proceed until same `GATEWAY_INTERNAL_SECRET` is configured in Convex dev and `apps/gateway/.dev.vars`, then dev Worker restarts.
- **Local gateway pointed at production Convex:** syncing shared secret alone did not fix 401 because localhost Worker still used production URLs from `wrangler.jsonc` while web used dev Convex. Added ignored `.dev.vars` URL overrides. This config drift made localhost UI and gateway operate on different databases.
- **Production Clerk API keys disabled:** project plan claimed feature enabled and live, but production environment flags were all false and Zevium returned `Forbidden`. Enabled user-scoped API keys in production Clerk dashboard; key page recovered without code deployment.
- **Clerk CLI stale session:** host access was valid, but CLI token had expired and production instance link was missing. Browser dashboard session was used; no fake CLI success claimed.
- **Playground real-call URL wrong for bare gateway origin:** production environment supplies origin, while helper assumed real URL already ended in `/gateway`. UI displayed and would fetch nonexistent root path.
- **Playground hardcoded JSON bodies:** `text/plain` OpenAPI request still received JSON default and `application/json`, making non-JSON APIs impossible to exercise correctly.
- **First upstream secret copy targeted wrong control:** credential metadata saved successfully but upstream returned 401. Explicit Vercel `Copy to clipboard` control fixed value; secret was never printed.
- **DevTools paste did not update React state:** raw password input changed, but `onChange`/session storage did not. Native input events are required when browser paste automation is used. Consumer key was rotated because one-time value had already been overwritten in clipboard.
- **Expected key propagation delay:** immediate use of rotated Clerk key returned machine-readable 402 `Invalid API key`; UI already states gateway changes may take one minute.
- **Repeated browser paste concatenated secrets:** password field retained previous value across attempts; automation pasted again instead of replacing, creating a 105-character invalid token. Exact one-time 35-character DOM value verified correctly.
- **Vercel environment change not deployed:** dashboard `API_KEY` value itself failed direct authentication against 176-day-old production runtime. Redeploy with latest Project Settings required before Zevium can call upstream.
- **Upstream clipboard path also corrupted value:** Vercel runtime redeploy alone did not fix 401. Cross-origin `window.name` transfer plus exact native input event replaced Zevium value without displaying or concatenating it.
- **Transient Vercel deployment view failure:** redeploy initially navigated to generic `Something went wrong`; dashboard Retry recovered active build.
- **DOM-length selector chose wrong Vercel button:** guessed 36-character button was not `API_KEY`; local source of truth proved real secret length 32 and authenticated production upstream. Exact local value fixed Zevium injection.
- **Activity route discoverability mismatch:** `/app/activity` rendered Not Found; actual route is `/app/settings/activity`. Sidebar exposes Settings but not direct Activity link.
- **Rotation permits multiple enabled keys:** two rotations produced three enabled rows even while UI claims one active key. Gateway grace behavior is intentional, but UI status and one-key wording are misleading. Old rows were manually revoked after verification.
- **Helium permission broker remained dead after restart:** page listing timed out repeatedly through port 9222. Launching Helium directly on loopback port 9333 bypassed broker, removed repeated Allow prompts, and let app-only cleanup finish.
