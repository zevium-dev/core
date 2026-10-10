WAVE 3 — KEYS LANE. Project: /home/tnfssc/Code/zevium. Read AGENTS.md, FLOW.md §2.2, TECH.md (Clerk machine API keys), existing apps/web. Edit ONLY apps/web/src/routes/app/settings* + related components (do not touch /catalogue, /app/billing, /app/projects).

1. /app/settings/keys: key management against Clerk machine API keys. Server functions (createServerFn + clerkClient from @clerk/tanstack-react-start/server or @clerk/backend with CLERK_SECRET_KEY): listKeys (current user subject), createKey(name) → returns secret ONCE, revokeKey(id). UI per FLOW.md: table (name, masked key, created, last used if available), Create dialog → copy-once reveal (blur-in per DESIGN.md: filter blur(8px)→0 + fade, DUR.base), revoke with confirm dialog. One key per user rule: disable create when a key exists.
2. /app/settings/index: profile section (Clerk UserProfile component themed shadcn) or simple info + link; /app/settings/activity: placeholder list reading convex usageEvents by org (query may exist as wallets/usage — if absent, render empty-state only, note it).
3. Toasts on create/revoke. isPending states. Build + typecheck green.

End with `DONE:` or `BLOCKED:`.
