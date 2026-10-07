# MCP request docs — implementation notes

## Ownership and scope

- Worktree: /home/tnfssc/.bruv/worktrees/t3-2533c64d-97bb1029baf2-task_a0ff1108
- Branch: bruv/mcp-executable-api-docs-a0ff1108
- Independently authored from Zevium contracts and existing parser/types; no Treg source, docs, or fixtures used.
- No changes to headers.ts, pipeline.ts, registry, pricing storage, or shared parser/types. No servers, commits, or pushes.

## Contract

- get_api_docs alone uses apps/gateway/src/mcp-api-docs.ts. Discovery/search still use endpointsFromSpec for compact method/path/summary/pricing.
- Shared ParsedOpenApiSpec already retains path parameters, raw standard operation fields, and components. Shared changes were unnecessary.
- Merge path-level and operation-level parameters by (in, name). Resolve parameter component identity for merging, but keep refs in the public result. Only final merged parameters seed reachable components.
- Keep request body required/description and each media type's schema, inline example, and named examples. Same media/schema/example extraction for response status/default maps; descriptions retained.
- Allowlist standard schema/parameter/example fields. Never dump raw operations/components. Example/default/enum/const values are payload JSON: keys stay intact; these are still untrusted data.
- Keep refs only to direct local components schemas/parameters/requestBodies/responses/examples. Include transitive reachable definitions under publisherData.components. JSON Pointer ~0/~1 component names work. Worklist dedup prevents recursive expansion, and nothing fetches external refs.
- Null-prototype construction and Object.fromEntries keep publisher-controlled dictionary keys inert.
- Preserve publisherDataTrust and static trustedUsageNotes. Publisher content never becomes trusted instructions. Usage notes explain path/query/body preparation and projection omissions.
- Existing immutable public-spec copy guard runs before extraction. Private/malformed/unsafe-release rejection stays intact.

## Deliberate limits / risks

- External refs, arbitrary local document refs, nested component pointers, security schemes, servers, vendor extensions, externalValue, response headers/links, and media encoding metadata are omitted. This is a call reference, not a lossless OpenAPI document.
- Missing supported component refs remain unresolved; no fabricated definitions. Unsupported schema keywords are not a full validator/renderer contract.
- Projection walks fail at depth >64 or >50,000 nodes, mapped to generic Published spec unreadable. Published OpenAPI bytes already cap at 393,216. No expansion-driven output blowup from refs.
- Schema examples/descriptions can contain hostile publisher prose or payload values. They stay untrusted; this projection does not claim to sanitize arbitrary publisher example content into trusted facts.
- Upstream server/auth metadata and separately injected upstreamHeaders are not exposed. Tests seed credential-looking values in excluded metadata and verify absence.

## Checks

- pnpm --filter @zevium/gateway exec vitest run test/discovery-mcp.test.ts: 84 passed.
- pnpm --filter @zevium/shared exec vitest run src/openapi.test.ts: 42 passed.
- Earlier gateway script invocation with double -- ran 11 files / 234 tests successfully; direct exec above is the focused check.
- pnpm --filter @zevium/gateway typecheck: passed.
- pnpm --filter @zevium/shared typecheck: passed.
- pnpm --filter @zevium/gateway lint: passed.
- pnpm --filter web typecheck: passed.
- git diff --check: passed.
- Prettier applied to touched source/docs. Initial @zevium/web filter matched nothing; corrected web filter ran TypeScript successfully.

## Regressions

- Inline inherited/override parameters, same name in distinct locations, required fields, content types, request/response schemas, inline/named examples, pricing/free tier, and hostile publisher descriptions.
- Referenced parameter override; body/response/example refs; transitive recursive schema closure; escaped component names; exclusion of unrelated definitions, upstream auth/server data, extensions, links/headers, and external/security refs.
- Search/discovery stay compact, boolean schema/null example, sparse responses, missing refs, input immutability, and depth cutoff.

Parent combined check: `pnpm ci:pr` passed on integrated diff (format, lint, static quality, typecheck, all tests, builds, whitespace). First run caught unsupported diagnostic second arguments in header-test `expect`; removed those, reran full gate successfully. No production/provider execution tested. Independent review later found one URI-reference bug; see final checkpoint below.

Independent review found URI-encoded component names stayed unresolved. Parent reproduced with failing regression (Pet%20Name, encoded separators, encoded parameter override). Fixed: decode local URI fragment before parsing JSON Pointer and ~0/~1 name escapes; retain original ref in docs, never fetch; malformed percent encoding omitted. Added own regression. Review found no metering/auth-scope blocker. Final full gate passed after this code change.

## Final checkpoint

All three gaps integrated in parent worktree. Independent review found one URI-reference bug; parent reproduced, fixed, and covered it. Final `pnpm ci:pr` passed after fix: format, lint, static quality, typecheck, tests, builds, whitespace. No production/provider execution proof. Ready to commit/push one PR against develop. Child worktrees are provenance only; parent branch owns release diff. Findings carry contracts and checks. One small value created/updated from source evidence and user feedback; no other repeat lesson added.
