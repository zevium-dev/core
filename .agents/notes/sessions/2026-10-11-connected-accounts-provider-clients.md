# Connected accounts: Zevium as the OAuth client of many providers

> Date: 2026-10-11 · Type: discussion, research, build · Branch: `feat/connected-accounts`

## Asked

- How a platform posts a user's uploaded video to YouTube on their behalf: plain APIs or MCP, and how OAuth is used.
- Whether one server can be the OAuth client of many providers, and whether there is a better way than one registered client per provider.
- Build it: one flow where Zevium is the single OAuth client exchanging with many providers' OAuth servers, then open a PR to `develop` and update the research notes.

## Found

- It's plain provider APIs plus OAuth. The platform registers one app per provider, keeps a provider table (endpoints, scopes, quirks, API hosts), runs one generic authorization-code flow with one callback, stores encrypted grants, refreshes on demand and only sends tokens to the provider's API.
- No fundamentally better architecture exists; managed token vaults run the same loop. Build beats buy at three providers.
- Platform review and shared quota, not code, gate real use ([research](../research/connected-accounts-providers.md#approval-and-quota)).

## Decided

- [Zevium owns one OAuth client per provider](../decisions/2026-10-11-zevium-owned-oauth-clients.md): code registry, specs reference providers, tokens only to provider API hosts, house listings only, renewal cron, provider revocation.

## Built

- Reworked the uncommitted generic build on `feat/connected-accounts` (rebased onto `develop` `3d51eb9`): removed publisher OAuth clients, added the registry and env-based clients, Instagram long-lived tokens, renewal and revocation, upstream host lock, a guard on the `next` pipeline. Design: [design/connected-accounts](../design/connected-accounts.md).
- Follow-ups: #444 media hosting, #445 provider apps and reviews, #446 bring-your-own client.

## User preferences observed

- Wants explanations of how a reference system works before building.
- Wants no mention of the reference product in Zevium docs or code.
