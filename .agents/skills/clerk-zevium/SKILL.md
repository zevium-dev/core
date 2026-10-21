---
name: clerk-zevium
description: Zevium-specific Clerk setup with the `clerk` CLI: which instance settings, JWT template, webhook destination, and MCP OAuth settings the Convex control plane and gateway depend on. Use alongside clerk-cli when activating an environment, checking why Convex rejects Clerk tokens, wiring the `/clerk-webhook` destination, or turning on OAuth for `/mcp`.
---

# Clerk for Zevium

General CLI usage lives in skill `clerk-cli`; this skill is what Zevium needs from the instance. `clerk whoami` shows the login and linked app; `clerk auth login` opens a browser, so the owner runs it. Before any write, state which instance (development or production) is linked: browser keys, server keys, Convex issuer and webhooks must all belong to the same one, or sign-in breaks in confusing ways.

## What Convex and the gateway depend on

Source of truth: [convex-activation.md](../../notes/architecture/convex-activation.md) step 3.

- **JWT template `convex`:** audience `convex`, issuer = `CLERK_JWT_ISSUER_DOMAIN`, with signed active-org claims. Convex derives the tenant from these claims and never from the browser. Inspect with `clerk api /jwt_templates`.
- **Organizations:** org feature on, roles admin/member, automatic personal org at signup. The $1 signup credit needs the creator-bearing `organization.created` webhook, so a missing destination silently removes the grant.
- **Webhook destination** `https://<deployment>.convex.site/clerk-webhook` for `user.created`, `user.updated`, `user.deleted`, `organization.created`, `organization.updated`, `organization.deleted`, `organizationMembership.deleted`; signing secret → Convex `CLERK_WEBHOOK_SIGNING_SECRET`. Clerk's API has no endpoint-create call (only `POST /webhooks/svix_url` for the Svix dashboard), so creating the endpoint is a dashboard step: generate the URL, give it to the owner, and have the secret set from their side.
- **MCP OAuth (optional):** OAuth authorization server with Dynamic Client Registration, S256 PKCE public clients, audience claim on, allowed scopes `openid profile email offline_access user:org:read` (Clerk rejects custom scopes) (`clerk api /instance/oauth_application_settings`). Set the gateway's `MCP_OAUTH_ISSUER`/`MCP_OAUTH_RESOURCE` only after a real token from that issuer carries the right audience and scopes. If the plan lacks a capability, leave OAuth off: API keys still work.

`CLERK_SECRET_KEY` and webhook secrets never go in chat, notes or PRs. `clerk env pull` writes keys to a file: keep it in an ignored path and don't print it.
