# Missing web origin fails closed

> Date: 2026-10-18 · Status: accepted (built) · Decided by: owner

Missing or invalid web-origin configuration must fail closed. No feature invents a web URL, production or local, when the environment does not name one.

What each feature does without a usable origin:

- **Notification email**: not sent; recorded as skipped and a config error is logged. In-app notifications are unaffected.
- **Checkout and publisher onboarding**: refused before any Stripe call, with the usual human-readable "unavailable" message.
- **Gateway and MCP payment-required responses**: still block the call; recovery links are omitted and MCP names the settings page in words instead of a URL.
- **Deprecation `Link` header**: omitted.
- **Gateway `/llms.txt`**: refused with the generic "temporarily unavailable" error, since the guide links the web app throughout.

A usable origin is HTTPS, or plain HTTP on loopback for local development. Local dev keeps working because the gateway dev script passes `http://localhost:3000` explicitly and each Convex dev deployment sets both web-origin variables; tests set fixture origins.

Code: `convex/lib/appOrigin.ts`, `apps/gateway/src/web-origin.ts`. Notes: [gateway](../features/gateway.md), [wallet-billing](../features/wallet-billing.md), [webhooks-notifications](../features/webhooks-notifications.md), [activation runbook](../architecture/convex-activation.md).
