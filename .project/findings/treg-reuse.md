# Treg review -> scoped Zevium PR

User: "look at the treg project. see what things can be brought over". Then: "dude just dont feed me slop okay?". Then: "make pr".

## Source

Reviewed https://github.com/superdesigndev/treg at 6021b8a7dd686bebb076bd8e197954b7aac4db29. Local read-only clone: /home/tnfssc/.cache/zevium-research/treg. No local project named Treg was registered; this public tool registry matched requested product.

Treg LICENSE adds hosted/embedded third-party restrictions to Apache 2.0. Prior written authorization required for software reuse in Zevium. No source, skill prose, assets, or test fixtures copied. Changes are independently authored from checked Zevium gaps.

## What earns this PR

- apps/gateway/src/headers.ts forwards Idempotency-Key unchanged while pipeline.ts injects shared publisher credentials. Different buyers can share provider dedupe namespace. Fix scoped label. Risk depends on provider behavior; no live exploit claimed.
- Header filtering misses Connection-nominated fields, forwarded identity, and platform-internal headers. Fix boundary, keep legitimate app headers and stronger cookie stripping.
- apps/gateway/src/mcp.ts get_api_docs has paths/prices but omits inputs. Add OpenAPI parameter/body/schema/example docs with publisherData trust boundary intact. Search/discovery stay compact.

Treg patterns informing review: src/treg/infra/upstream/relay.py; src/treg/domain/catalog/store.py; src/treg/routers/catalog.py. No wholesale port.

## What did not earn this PR

CLI, plugins, onboarding, LLM search judges, demand intake, routing, and query credentials are suggestions, not proven needs. Earlier review mixed those with verified gaps. User rejected feature shopping. Keep claims tied to files and tests. Existing prepaid billing, key controls, streaming proxy, schema mocks, and web semantic search do not need rebuild.

No product economics or vendor stack change. No live provider calls. No gateway response-replay promise.

## Work and checks

Parent worktree: /home/tnfssc/.t3/worktrees/zevium/t3-2533c64d, branch t3/review-treg-portable-work. Split details and retry-key contract in gateway-idempotency.md. Header/docs agents use isolated persistent worktrees. Combine selected files, review diff, run tests/static checks, then one PR against develop.

All child changes integrated and parent-reviewed. `pnpm ci:pr` passed on full diff. Independent review found one URI-encoded component-ref bug, now reproduced and fixed with regression. No metering/auth-scope blocker found. Final `pnpm ci:pr` passed after fix. Ready to commit/push one PR against develop. No copied Treg material.

values.md was missing. Created one value from old model-failure evidence and current license check. Updated it to separate checked gaps from feature suggestions after user's feedback. No broad new rule set.
