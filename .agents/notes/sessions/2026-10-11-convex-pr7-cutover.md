# Convex rebuild PR 7 — code cutover

Updated: 2026-10-11. Implements #353/#430 after merged #436–#439, #441 and #442. [Plan](../architecture/convex-rebuild.md) · [Owner activation](../architecture/convex-activation.md).

## Scope and interpretation

Root `convex/`, `contracts/` and `tests/` replace the temporary package and legacy control plane. Web and Worker have one runtime path. Old registry transport, unversioned admission-secret fallback, direct grants, machine-payment sessions and token execution are deleted. NEXT_* names remain protocol configuration. The accepted source-backed money behavior and unresolved owner policy approvals are unchanged.

The task authorizes code, isolated local tests and a PR. It explicitly does not authorize shared dev/prod/preview deployment, provider configuration changes or secret creation. Accordingly, both hosted workflows require owner activation variables, and real Clerk API-key creation was left unsubmitted. Existing Clerk dev credentials were used only for sign-in and local pairing. Synthetic keys/grants belong to disposable local fixtures.

Migrations v1–v5 in production and preview were compared semantically with base develop and are unchanged. New v6 deletes WalletSqliteDO. Its old storage is not migrated or assumed empty; the runbook requires owner drain/export/reconciliation before irreversible deletion. Existing NextWalletDO identity and journals remain intact.

## Local backend and HTTP evidence

- Canonical schema validates on fresh guarded anonymous loopback backends: 36 application tables and 28 component tables.
- Real OCC/money/finance races and 10,001-bucket reconciliation passed. Bounded reconciliation retains its measured transaction ceilings and completes over 1,250 pages.
- Real local Worker uses production migration declarations and canonical root functions. Acceptance covers cold key/wallet/OAuth, warm OAuth cache, signed snapshot authority, exact conservation, in-flight freeze/drain, stale/revoked keys, exceptions, Worker restart, lost ACK replay, queued refunds and archive/refund closure.
- Cutover additions cover direct large-response streaming, MCP refusal above 1 MiB with reservation restoration, no upstream at zero balance, keyless mock without upstream, retired v1 routes and x402 refusal. Money fixtures now include versioned admission and final signatures; an explicit regression rejects the removed unversioned secret fallback.
- Browser load exposed that an explicit refresh can overlap a DO alarm. Acceptance now waits for the durable close ACK with a fixed ten-second bound rather than assuming one RPC return proves completion. No production money logic was weakened.

## Real browser journey

Actual TanStack web dev app, actual local anonymous Convex backend, actual local workerd gateway; no frontend API interception or authentication bypass. Agent-browser used separate signed-in and anonymous sessions.

Covered:

1. Existing Clerk dev sign-in. The documented test password was stale; the existing test-email OTP flow succeeded without password reset or configuration changes.
2. Signed-in organization mirror, empty project list, project creation, OpenAPI editing and draft save, real public HTTPS readiness probe, public visibility confirmation and immutable version 1.0.0 publication.
3. Anonymous catalogue keyword search found the new publication. Public card and detail rendered **Operated by Zevium** on a designated house fixture.
4. Anonymous keyless mock returned HTTP 200 and the schema-derived JSON response through the local Worker.
5. The browser called the newly published project's live endpoint through the local Worker using a synthetic local fixture key and source-backed grant. HTTP 200; consumer balance 100 → 95; one 5-credit usage row; publisher 47,500 atoms and platform 2,500 atoms. The signed-in publisher earnings tab showed 1 call, 5 gross credits and 4.75 net credits. The fixture upstream is local; readiness separately exercised the real HTTPS probe.
6. Organization switch cleared the project list. Direct access to the prior organization's slug returned Project not found, without showing its project or earnings.
7. Billing packs, API-key list and create dialog rendered. Create was cancelled before issuing a real provider secret.

Blocked, not claimed complete:

- Hosted Checkout: local fixture Stripe configuration has no usable provider key/prices/destination pairing; Buy $10 returned `Checkout is unavailable. Please try again.` No payment or provider configuration was created. Real Checkout → signed provider receipt → grant remains owner-gated.
- Real Clerk key issuance is excluded by the explicit no-secret-creation limit. Broker/projection and metered calls are covered with synthetic fixtures, not a newly issued provider key.
- Creator-bearing first-org webhook grant, Connect onboarding/transfer/refund/dispute delivery, OAuth consent/DCR and Resend delivery need owner-approved provider configuration/destinations. Local signed receipt/replay and finance/HTTP tests cover their code paths but do not prove live provider behavior.
- No claim of a completed live provider-backed money journey. Activation remains blocked until the owner completes it and signs off the pending policy defaults.

Local browser services were shut down after verification. No shared backend was pushed, Worker deployed, provider configured, real API key created, or production secret written.

## Final gate

`pnpm format` and `VITEST_MAX_WORKERS=2 pnpm ci:pr` passed. The full gate included 872 unit tests (shared 105, web 459, gateway 124, Convex 184), offline activation validation, fresh schema/codegen, real OCC/finance/10,001-bucket reconciliation, paired Worker acceptance, production build/runtime checks, generated-file checks and diff checks. Hosted CI evidence is recorded in the PR description and final response. Scratch logs, runtime credentials and authenticated browser state are excluded from Git and artifacts.
