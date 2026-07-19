# UX hardening dogfood

Date: 2026-07-19

## Publisher loop: local draft → readiness → visibility

1. Opened `http://localhost:3000/app/projects/test-api-22/spec` through the direct Helium CDP connection on port 9333.
2. **Fixed:** a blank persisted draft rendered the OpenAPI template as a textarea placeholder while the endpoint rail showed `0 endpoints`. The template is now actual dirty editor state and autosaves, so the editor, validation, endpoint rail, and publish checklist represent the same document.
   - Proof: after reload, UI reported `1 endpoints, 1 credit`; the Endpoints rail rendered `GET /health` and the readiness checklist reported pricing and mock preview ready.
3. **Fixed:** the Spec rail's `Make public` action changed visibility without confirmation.
   - Proof: clicking `Make public` opened a modal titled `Make project public?` with explicit `Cancel` and `Make public` actions; the destructive action was not exercised.
4. **Added:** a publisher-only readiness checklist covers saved valid spec, server reachability, optional upstream credential verification, pricing, metadata, and mock availability. It names the exact next action rather than disabling valid keyless projects.
5. **Added:** `Test connection` is a control-plane HEAD probe using the saved draft and server-side stored headers. It does not invoke the gateway or wallet. It reports a typed, human-safe status and measured latency/status when available.
   - Proof: the local `https://api.example.com` fixture returned `Could not resolve the upstream hostname`; no raw transport error, response body, request header, or secret was rendered.
6. **Fixed:** upstream credential removal now requires a confirmation dialog and warns that paid upstream calls can fail after cache propagation. Credential writes/removals and readiness tests require the active organization admin role.
7. **Fixed:** credential storage now AES-GCM encrypts values at rest (`ciphertext`, IV, key version); member-facing queries continue returning metadata only. Gateway-only/internal reads decrypt server-side.
8. **Fixed:** gateway rejects literal/private/internal/non-HTTPS upstream targets before credit reservation or fetch, has a 15 second upstream-header timeout, maps transport errors to human-safe errors, and fails closed when a production Convex spec source lacks its authenticated internal configuration.
9. **Fixed:** public listing/gateway lookup now uses a separately stored public publisher handle rather than the Clerk slug. The organization settings page provides availability feedback and a destructive confirmation before changing its canonical public handle.
10. **Fixed:** key rows label a replacement `Current` and a grace key `Previous — valid until <local time>`; a grace key cannot be rotated again, and the grace boundary rejects exactly at `now >= graceUntil`.
11. **Fixed:** Activity is a direct sidebar destination at its canonical `/app/settings/activity` route rather than hidden behind the general Settings page.
12. **Hardened:** the gateway Worker enables Cloudflare's `global_fetch_strictly_public` compatibility flag, alongside URL and readiness checks, so global fetch rejects private-network destinations at egress.
13. **Fixed:** publishing now requires a passing 2xx readiness result for the exact saved draft and credential revision; saving a changed draft or changing credentials makes the prior test stale. The check is a control-plane HEAD request, never a gateway call, so it creates no usage, wallet reservation, or earnings event.
14. **Fixed:** public publisher handles are role-aware. Admins receive availability-only feedback and can copy the canonical catalogue URL; members receive read-only guidance. Clerk slugs remain internal identity data.
15. **Verified at 320px:** direct Helium CDP keyboard smoke on `/catalogue` exposed the accessible mobile menu button, heading, search, sort, cost, and free-tier controls in tab order.
16. **Fixed:** readiness action failures now remain inline in the publish checklist with an actionable message instead of disappearing into a toast and leaving an unexplained stale state.

## Final verified proof fixture

Fixture: `http://localhost:3000/app/projects/httpbin-final-proof/spec`
Publisher handle/project: `sharath-chandra-s-organization-1784408078450790548/httpbin-final-proof`

1. **Readiness persistence:** Import URL saved a valid OpenAPI 3.1 draft, then
   `Test connection` returned a 2xx response from `https://httpbin.org`.
   A fresh reload retained the passing state and displayed “Saved passing
   connection test is current.” The authoritative development
   `publishReadiness:getCurrent` result was `current: true`, `reason: null`,
   with matching draft/readiness hashes, `status: "ok"`,
   `credentialRevision: 0`, and `serverOrigin: "https://httpbin.org"`.
   The rerun updated `testedAt`; the subsequent reload remained current.
2. **Published Import URL journey:** The published detail showed the exact
   three imported operations with `20` credits and `5/day` each. The fixture
   was left unchanged during verification, then removed during final cleanup.
3. **Zero-credit free calls:** Real gateway calls succeeded for HTML and JSON
   at zero balance with `x-zevium-cost: 0` and
   `x-zevium-free-tier: 1`.
   - HTML request ID: `86b676ec-8711-46d7-a955-05d72c950ef1`
   - JSON request IDs: `760f4286-1144-4c4f-869e-1942c1fca796` and
     `9d80a993-85ef-41dc-8857-24508bda80b0`
4. **Failure refund:** The real upstream `/status/401` response remained
   `401` and its free quota reservation was refunded. Request ID:
   `2bd8fea3-8898-4c0d-8c7b-0903d2f1614c`. A repeated real JSON request then
   succeeded as free, proving the failed operation did not consume the JSON
   operation’s allowance.
5. **Mock contract:** `/mock/.../status/401` returned a declared `401
Unauthorized`, confirming mock status preservation rather than a forced
   `200`.
6. **Responsive pass:** The catalogue/detail controls remained available in
   the accessibility tree at the narrow 320px check: navigation, pricing,
   free-tier labels, endpoint selector, mock toggle, API-key field, and Send
   control were reachable in keyboard order.
7. **Cleanup:** Temporary local gateway diagnostics were removed. The proof
   project was deleted and the browser’s Gateway API-key settings showed “No
   API keys yet.” No secrets are recorded here, and no production deployment
   occurred.

## Grounded residual

Cloudflare `global_fetch_strictly_public` rejects private-network destinations at global-fetch egress. Normal Worker fetch cannot pin a hostname DNS answer; strict URL policy and the Node readiness resolver remain defense in depth. A dedicated egress service is required only for a stronger per-dial DNS-pinning guarantee.

## Automation-only exclusions

- Helium/CDP availability, browser clipboard behavior, Vercel CLI authentication,
  stale local auth, and automation viewport/clipboard targeting were not treated
  as product findings.

## Focused verification

- `pnpm exec vitest run --config convex/vitest.config.ts convex/publishReadinessAction.test.ts` — 3 passed.
- `pnpm exec vitest run --config convex/vitest.config.ts convex/upstreamCredentials.test.ts` — 6 passed.
- `pnpm --filter @zevium/gateway test -- pipeline.test.ts` — 85 passed.
- `pnpm --filter web typecheck` and `pnpm --filter @zevium/gateway typecheck` — passed.
- `pnpm --filter @zevium/gateway test` — 92 passed.
- `pnpm --filter web test` — 160 passed.
- `pnpm test:convex` — 116 passed.
