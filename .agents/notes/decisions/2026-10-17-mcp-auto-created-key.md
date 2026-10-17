# First OAuth MCP connect auto-creates the member's key

> Date: 2026-10-17 · Status: accepted (built, #324) · Decided by: owner

Resolves the G2 follow-up ([mcp-oauth](../research/mcp-oauth.md)): when a verified OAuth user has
no current key in the consented org, Zevium creates one for them instead of asking them to visit
`/app/settings/keys` first.

- The created key **is** the member's one current key, named "MCP (auto-created)", listed and
  manageable on `/app/settings/keys` like any other. Same Clerk claims, budget, scopes and (absent)
  cap as a key created on that page.
- Its secret is never shown: OAuth pays through the key id server-side. The secret is hashed for
  the usual projection and dropped. Rotating the key issues a usable secret.
- First connect only. A member who later disables or revokes it gets the keyless explanation
  (built earlier on 2026-10-17), not a silent replacement. A held disabled key is never doubled.
- Concurrent connects create one key. Clerk must confirm a supported org role first.
- If creation fails or is not permitted, the keyless fallback stays, with backoff before retrying.
- No new hot-path calls: creation is triggered by Convex `/mcp-identity`, which the gateway calls
  only on OAuth cache miss/refresh.
