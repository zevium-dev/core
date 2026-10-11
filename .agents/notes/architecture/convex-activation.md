# Convex rebuild activation

> Status: owner execution required; code cutover does not authorize activation. Updated: 2026-10-11.
> Related: [rebuild plan](convex-rebuild.md), [deployment](deploy.md), [local development](dev-environment.md).

PR 7 makes root `convex/` canonical. It does **not** deploy, reset shared data, create secrets, change provider settings, or approve live Stripe payments. Payments still reject live keys/objects. x402, per-token execution and capability routing are absent. Names beginning `NEXT_` remain the reviewed wire/configuration contract; there is no runtime mode switch.

Every numbered step below requires the **owner** on each intended environment. Start with disposable development and Stripe test mode; repeat for the hosted production target only after its own explicit approval. Do not run the ordinary release workflow to perform the initial incompatible schema/DO cutover.

## 1. Approve evidence and stop old traffic

- Review PR 7 CI, browser evidence and the remaining gates in the rebuild plan. Approve the proposed promo self-consumption, payment-review A–C and read-surface D1–D6 defaults explicitly. Keep card surcharge disabled pending #318.
- Confirm the exact Convex deployment name/cloud URL/site URL, Clerk instance, Stripe test platform account, Worker name/route and web origin. Write them in private operator records. One environment must never ingest another environment's payments.
- Disable incoming gateway traffic and pause Checkout, transfers and publisher writes. Disable old Clerk/Stripe destinations and account for already queued deliveries/retries. Keep their receipt IDs for reconciliation; disabling delivery is not cancellation of provider money.
- Inspect old `WalletSqliteDO` storage and old Convex ledger. Export unresolved holds, final/usage queues, ACK state, payment/refund/dispute/transfer/account IDs and receipts. Complete old served-call settlement and resolve ambiguous provider operations against the **old paired code** before wiping it. If any outcome or journal is unresolved, stop here. Do not treat zero users or a timeout as proof of an empty journal.
- Export the old Convex deployment (including file storage if used) and retain Cloudflare version/configuration evidence privately. Record the owner-approved empty/drained result for every legacy wallet namespace. Existing `NextWalletDO` journals also survive retries; do not change deployment ID or discard referenced key versions after use.

## 2. Prepare matched configuration privately

Create independent values in the owner's secret manager. No values belong in Git, chat, notes, PRs or CI artifacts. Root `.env.example` lists names. Assemble a mode-0600 `.tmp/activation.json` with `convex`, `worker`, and `web` environment maps, then run:

```bash
pnpm activation:check .tmp/activation.json
```

This command is offline and prints names/errors only. It checks pairing, independent key material, test Stripe mode and disabled features. It cannot prove provider credentials, webhook delivery, OAuth consent or the browser money journey.

Convex runtime (the validator also accepts built-in `CONVEX_URL` and `CONVEX_SITE_URL` as target metadata; do not override those reserved values):

- `CLERK_JWT_ISSUER_DOMAIN`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`, `ADMIN_USER_IDS`.
- `NEXT_DEPLOYMENT_ID`: immutable identity for this paired ledger/edge deployment.
- `NEXT_SNAPSHOT_KEYS`, `NEXT_ADMISSION_KEYS`, `NEXT_TRANSPORT_KEYS`: three **independent** JSON keyrings, each `{current, keys}` with a current version and strings at least 32 characters long. Keep every version referenced by durable edge state.
- `GATEWAY_INTERNAL_SECRET`: independent, at least 32 characters; same value on Worker.
- `REGISTRY_KEY_PROJECTION_HMAC_SECRET`: independent, at least 32 characters; same value on web. Its name survives for broker compatibility; registry outbox/transport is deleted.
- `UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS`: independent `{current, keys}` keyring; each value canonical padded base64 encoding exactly 32 bytes. Retain versions used by credential/webhook envelopes.
- `NEXT_GATEWAY_URL`: exact gateway HTTPS origin; `NEXT_APP_ORIGIN` and `APP_ORIGIN`: identical web HTTPS origin (Checkout/Connect returns and email links).
- `NEXT_STRIPE_SECRET_KEY`: test restricted/secret key supported by the current integration; `NEXT_STRIPE_PLATFORM_ACCOUNT_ID`; `NEXT_STRIPE_PRICE_PACK_10`, `NEXT_STRIPE_PRICE_PACK_50`, `NEXT_STRIPE_PRICE_PACK_100`.
- `NEXT_STRIPE_WEBHOOK_SECRET`, `NEXT_STRIPE_CONNECT_WEBHOOK_SECRET`, `NEXT_STRIPE_V2_WEBHOOK_SECRET` for the three destinations below. The replacement uses **one** v2 destination signing secret, not the legacy pair of v2 secrets.
- Keep `NEXT_CARD_FEE_ENABLED` unset/false. Do not set fee-price/cents variables until #318 is approved.
- Optional `NEXT_WEB_SEARCH_SECRET` (independent, same on web) and `GEMINI_API_KEY`. Missing trusted search configuration degrades to keyword search; it must not purchase anonymous embeddings.
- Optional email: `RESEND_API_KEY`, `EMAIL_FROM`, `RESEND_WEBHOOK_SECRET`; see step 4.

Worker runtime:

- `CONVEX_SITE_URL`: exact HTTP-actions origin of the new Convex deployment. `CONVEX_URL` may be retained as operator metadata; authority uses the site URL.
- Matching `NEXT_DEPLOYMENT_ID`, three edge keyrings and `GATEWAY_INTERNAL_SECRET`; `APP_ORIGIN` equal to both Convex web-origin variables.
- Optional `CLERK_SECRET_KEY`, `MCP_OAUTH_ISSUER`, `MCP_OAUTH_RESOURCE` **together**, only after step 3. Resource must equal gateway origin plus `/mcp`.
- Release workflow supplies `ZEVIUM_RELEASE`; Wrangler supplies `CF_VERSION_METADATA`.
- Bindings: `EDGE_SNAPSHOTS` → `EdgeSnapshotDO`, `NEXT_WALLET` → `NextWalletDO`, `EDGE_OAUTH` → `EdgeOAuthDO`. There is no `WALLET` binding.

Web build/server:

- Build: `VITE_CONVEX_URL`, `VITE_GATEWAY_URL`, `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_BUILD_SHA`.
- Server: `CLERK_SECRET_KEY`, matching `CLERK_PUBLISHABLE_KEY` when set, `REGISTRY_KEY_PROJECTION_HMAC_SECRET`, `CONVEX_SITE_URL`, optional `NEXT_WEB_SEARCH_SECRET`.
- Browser and server Clerk keys must belong to the same instance as Convex issuer/webhooks. Clear old browser query/session data; document IDs do not survive reset.

Remove obsolete `CONTROL_PLANE_MODE`, `VITE_CONTROL_PLANE_MODE`, `VITE_NEXT_CONVEX_URL`, `NEXT_CONVEX_SITE_URL`, `NEXT_ADMISSION_SECRET`, registry sync/transport variables, old Stripe names and machine-payment/session credentials. Unversioned admission-secret fallback is deleted; all settlements require a retained signing key ID.

## 3. Configure Clerk destinations and OAuth

- Keep the reviewed org feature, roles and automatic personal-org behavior. Verify the `convex` JWT template has audience `convex`, the configured issuer and signed active-org claims. No browser-supplied tenant can replace them.
- Add a destination `https://<deployment>.convex.site/clerk-webhook` for `user.created`, `user.updated`, `user.deleted`, `organization.created`, `organization.updated`, `organization.deleted`, `organizationMembership.deleted`. Store its signing secret under `CLERK_WEBHOOK_SIGNING_SECRET`. Enable it only at step 7.
- Validate sign-in/sign-up redirects and allowed web origins for the selected Clerk instance. Existing orgs can be mirrored after reset, but a signup grant requires a signed creator-bearing `organization.created` delivery; an ensure call never creates that eligibility.
- Optional MCP OAuth: enable Clerk OAuth authorization-server/Dynamic Client Registration for the intended instance, S256 PKCE public clients, and scopes `user:org:read` plus `zevium:mcp:execute`. Configure the intended client redirect URIs/consent policy. Inspect Clerk's discovery document and DCR endpoint. Set Worker issuer/resource only after a token from that issuer has the correct audience/scopes. OAuth still resolves an active broker-managed key and pays from its org wallet. If any provider capability requires a plan/config change, leave OAuth off and retain API-key access.

## 4. Configure Stripe test and optional Resend destinations

- Verify the selected test platform's USD account identity and key permissions: account/balance reads, Customers, Checkout Sessions, PaymentIntents/Charges/BalanceTransactions and prices, refunds/disputes reads, Transfers, Accounts v2/account links, connected payout reads and canonical reconciliation reads. Use existing approved test keys; live mode is not enabled by this PR.
- Configure fixed USD prices for the three server-owned packs ($10/$50/$100 principal); no fee line while surcharge is off. Redirect success is never a grant.
- Platform snapshot destination `/stripe-webhook`: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `refund.created`, `refund.updated`, `refund.failed`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`, `transfer.created`, `transfer.updated`, `transfer.reversed`.
- Connected-account snapshot destination `/stripe-connect-webhook`: `payout.created`, `payout.updated`, `payout.paid`, `payout.failed`, `payout.canceled` with connected-account context.
- Accounts v2 thin destination `/stripe-connect-v2-webhook`: subscribe to `v2.core.account.created`, `v2.core.account.updated`, `v2.core.account.closed`, `v2.core.account[requirements].updated`, `v2.core.account[configuration.recipient].updated`, and `v2.core.account[configuration.recipient].capability_status_updated` for the configured recipient flow. These names match the pinned Stripe SDK; confirm availability for the account configuration in the owner dashboard. Confirm its payload contains `related_object.id`; it is not a v1 `account.updated` snapshot destination. Record the selected event list in the private provider setup record.
- All three URLs use the **same new Convex site**. Store each matching signing secret under the names in step 2. Keep destinations disabled until code is deployed; never deliver a historical payment to both old and new ledgers.
- Optional Resend: verify sender domain; set `EMAIL_FROM` and matched `APP_ORIGIN`. Optional `/resend-webhook` subscribes to `email.*` with `RESEND_WEBHOOK_SECRET`. Set `RESEND_API_KEY` last, after notification/browser tests. Missing key deliberately leaves email dormant. Removing it stops new enqueues; cancel queued component messages or revoke the provider key separately.

## 5. Reset disposable Convex data and deploy root functions

Only after step 1 is signed off, export again and wipe the exact owner-selected disposable dev/prod target. The following builds an empty snapshot locally; it performs no reset by itself:

```bash
mkdir -p .tmp
python3 - <<'PY'
from zipfile import ZipFile
with ZipFile('.tmp/empty-control-plane.zip', 'w') as archive:
    archive.writestr('organizations/documents.jsonl', '')
PY
```

Owner verifies the CLI target and deploy-key scope, then runs `pnpm exec convex import --replace-all --deployment "$ACTIVATION_CONVEX_DEPLOYMENT" .tmp/empty-control-plane.zip`. Keep the confirmation prompt. Do this separately for each approved disposable deployment. Do not use a broad public clear mutation or relax schema validation. Inspect component queues separately: stop/cancel old scheduled/provider/email jobs before the wipe, and explicitly clear disposable component data through the component dashboard/import scope where required. A root import must not be assumed to clear external provider state or all component queues.

Set Convex runtime variables on that exact target, then push **root** schema/functions: owner-selected development uses `pnpm exec convex dev --once`; production uses its scoped `CONVEX_DEPLOY_KEY` and `pnpm exec convex deploy`. Inspect the target before confirming. Generated bindings must match the reviewed tree. Verify 36 application tables plus 28 component tables and no registry/machine-payment/release-proof tables.

## 6. Deploy Worker migrations, then web

- Reconfirm old `WalletSqliteDO` is drained/exported/reconciled. PR 7 appends `v6-control-plane-cutover`, deleting that class and **its storage irreversibly**. Tags v1–v5 remain byte-for-byte semantically unchanged. No migration transfers old wallet balances into `NextWalletDO`.
- Configure Worker secrets and matched variables, then use the owner-selected `wrangler deploy` with canonical production or preview config to apply the new migration. **Initial DO migration cannot use `wrangler versions upload`**. Do not edit/reuse migration tags or change `NextWalletDO` identity after traffic. Verify `/health` contract `2` and exact release. Leave public traffic blocked until paired checks pass.
- Build web with the same Convex/Worker destinations and release SHA, configure web server bindings, then deploy web. Verify its release metadata, Clerk instance, HTTP and WebSocket destinations.

Owner command sequence, from the repository root after steps 1–5 and private configuration validation (placeholders are names, not supplied values):

```bash
ACTIVATION_SHA="$(git rev-parse HEAD)"
ACTIVATION_TAG="production-$ACTIVATION_SHA"
# For disposable hosted development use staging-$ACTIVATION_SHA instead.
# Owner sets ACTIVATION_GATEWAY_NAME and ACTIVATION_GATEWAY_CONFIG
# (wrangler.jsonc or wrangler.preview.jsonc, relative to apps/gateway).
pnpm --filter @zevium/gateway exec wrangler deploy \
  --config "$ACTIVATION_GATEWAY_CONFIG" --name "$ACTIVATION_GATEWAY_NAME" \
  --secrets-file ../../.tmp/gateway-secrets.json \
  --var "CONVEX_SITE_URL:$CONVEX_SITE_URL" \
  --var "NEXT_DEPLOYMENT_ID:$NEXT_DEPLOYMENT_ID" \
  --var "APP_ORIGIN:$APP_ORIGIN" \
  --var "ZEVIUM_RELEASE:$ACTIVATION_SHA" --tag "$ACTIVATION_TAG"
VITE_BUILD_SHA="$ACTIVATION_SHA" pnpm --filter web build
pnpm --filter web exec wrangler deploy \
  --config dist/server/wrangler.json --name "$ACTIVATION_WEB_NAME" \
  --secrets-file ../../.tmp/web-secrets.json --tag "$ACTIVATION_TAG"
```

The owner supplies mode-0600 secret maps: gateway contains the three NEXT keyrings, internal secret and optional Clerk OAuth secret; web contains Clerk secret, broker HMAC, matched Convex site and optional search HMAC. Nonsecret OAuth issuer/resource belong in the owner-selected Worker configuration when enabled. Configure the intended web routes before deploying its generated config; production routes must not be reused for hosted development. VITE_CONVEX_URL, VITE_GATEWAY_URL, VITE_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY must be exported for the web build. Verify actual CLI target and route output before accepting any change. These commands are owner instructions, not completed implementation actions.

## 7. Enable destinations and run the hard gate

Enable new Clerk and Stripe test destinations; verify signed deliveries and durable receipt completion. Keep old destinations disabled. Run the **real authenticated browser** journey on an empty deployment:

1. Sign in, create first org, receive exactly one 10,000-credit creator grant; replay receipt and verify no second grant. Join/switch another org and verify isolation.
2. Create API, save draft, run readiness probe, publish immutable version. Test stale draft conflict. Verify public catalogue/detail, hidden unpriced/token operations and **“Operated by Zevium”** for a staff-designated house listing.
3. Buy test credits via hosted Checkout. Verify one canonical payment/lot/source/journal, principal only, correct return URL and receipt replay.
4. Issue key in UI. Call local/hosted paired HTTP gateway and MCP; verify consumer debit, exact publisher/platform 95/5, usage, estimates/partial labels, no upstream at zero balance. Keyless mock costs zero and never contacts upstream.
5. Verify Connect test onboarding, risk release after the real hold (or an explicitly isolated test clock fixture), whole-cent transfer, sub-cent carry and canonical provider evidence. Do not weaken production hold rules to speed the check.
6. Test refund/dispute withdrawal/reinstatement; close/drain before reclaim, original-source conservation, retained exceptions, operator audit notes and no invented debit/earnings. Verify unknown transfer outcome stays allocated.
7. Revoke key/archive org, wait through the accepted authority window, verify refusal. Check restart/lost ACK replay and that no unresolved journal is discarded. If OAuth/email enabled, verify real consent/refresh and fresh notification delivery/opt-out too.

Backend fixtures and local HTTP acceptance do not satisfy the live provider-backed portions. If Clerk/test payments cannot work without owner configuration, record the exact failure and leave activation blocked.

## 8. Permit later automated releases

After initial migration and all gates, owner may set repository variable `CONVEX_REBUILD_ACTIVATED=true`. Production still requires protected-environment approval and green current-develop CI. Set `PRODUCTION_CONVEX_URL`, `PRODUCTION_CONVEX_SITE_URL`, `PRODUCTION_GATEWAY_URL`, `PRODUCTION_WEB_URL`, `PRODUCTION_DEPLOYMENT_ID`; provision corresponding `PRODUCTION_NEXT_SNAPSHOT_KEYS`, `PRODUCTION_NEXT_ADMISSION_KEYS`, `PRODUCTION_NEXT_TRANSPORT_KEYS`, `PRODUCTION_GATEWAY_INTERNAL_SECRET`, optional `PRODUCTION_NEXT_WEB_SEARCH_SECRET`, existing broker/credential/Clerk/deploy secrets. Provider secrets already live on the approved Convex target.

Preview requires separate `CONVEX_REBUILD_PREVIEW_ACTIVATED=true`, stable independent `PREVIEW_NEXT_SNAPSHOT_KEYS`, `PREVIEW_NEXT_ADMISSION_KEYS`, `PREVIEW_NEXT_TRANSPORT_KEYS`, `GATEWAY_PREVIEW_INTERNAL_SECRET`, optional `PREVIEW_NEXT_WEB_SEARCH_SECRET`, existing broker/credential and Clerk preview secrets. Preview ID is `preview-pr-<number>`; pair URLs/Clerk/Stripe destinations per preview. Do not rotate keys on each rebuild. Existing legacy preview databases require explicit disposable reset before reuse. Neither label nor merge bypasses these gates.

## Rollback

Before any provider money/new usage, keep traffic and destinations off and restore the **paired** old backend/web/Worker only if its storage remains intact. Once v6 deletes old DO storage, a Worker version rollback alone cannot restore it; recovery requires the verified export and a separately reviewed restoration plan.

After any money or usage: freeze admission, keep the current backend and DO journals, drain all holds/finals, export provider IDs and reconciliation evidence, and reconcile before changing destinations. Preserve every signing/decryption version still referenced. Prefer roll forward. Never replay payments into two deployments, reset edge spend counters, forget unknown transfers, or manufacture a drain ACK. An unavailable DO keeps affected wallets closed until evidence is recovered.
