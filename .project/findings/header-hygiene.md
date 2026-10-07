# Gateway header hygiene

- Authored locally from Zevium source and requirements; no Treg code/docs consulted or copied.
- Request filtering drops `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, existing Cloudflare noise, and all `X-Zevium-*` metadata. Existing consumer authorization/API-key, cookie, host and content-length exclusions stay intact.
- Both directions parse original `Connection` value before copying headers. Comma-separated options are trimmed and lowercased, including combined values from repeated header lines. Every nominated field is removed alongside fixed hop-by-hop fields; input headers remain unchanged.
- Upstream `X-Zevium-*` response headers are untrusted. Otherwise a paid response could falsely advertise free-tier status or carry arbitrary platform metadata. Existing pipeline filters first and stamps its own request-id/cost/free-tier afterward; do not move filtering after gateway metadata application.
- Keep normal end-to-end application headers. Use own-property membership for fixed exclusion table: `in` also matches inherited names such as `constructor` and accidentally drops valid application headers.
- Preserve existing upstream response set-cookie, content-length and shared auth exclusions. No changes to `pipeline.ts`, credential injection, streaming or metering.

## Verification

- `pnpm --filter @zevium/gateway test test/headers.test.ts`: 6 tests passed. Covers identity/internal fields, unchanged inputs, ordinary application headers, inherited-property names, fixed/Connection-nominated exclusions in both directions, and post-filter platform stamping.
- `pnpm --filter @zevium/gateway test test/headers.test.ts test/pipeline.test.ts`: 43 tests passed across 2 files (6 header tests, 37 existing pipeline tests).
- `pnpm --filter @zevium/gateway typecheck`: passed (`tsc --noEmit`).

## Scope and risks

Forwarding-identity and X-Zevium namespaces intentionally no longer pass through from consumers/upstreams. Publishers relying on these untrusted values must use their own application header namespace. No arbitrary vendor identity-header denylist was added. No dev servers, commits or pushes. Tests exercise local Worker harness, not production edge behavior.

Parent integration adds real pipeline assertion: upstream cannot spoof cost/free-tier/future metadata; Connection-nominated field dies, platform cost stamp survives. Full gateway before this added assertion: 13 files, 242 tests passed. Final combined gates still pending.

Parent combined check: `pnpm ci:pr` passed on integrated diff (format, lint, static quality, typecheck, all tests, builds, whitespace). First run caught unsupported diagnostic second arguments in header-test `expect`; removed those, reran full gate successfully. No production/provider execution tested. Independent review later found one URI-reference bug; see final checkpoint below.

## Final checkpoint

All three gaps integrated in parent worktree. Independent review found one URI-reference bug; parent reproduced, fixed, and covered it. Final `pnpm ci:pr` passed after fix: format, lint, static quality, typecheck, tests, builds, whitespace. No production/provider execution proof. Ready to commit/push one PR against develop. Child worktrees are provenance only; parent branch owns release diff. Findings carry contracts and checks. One small value created/updated from source evidence and user feedback; no other repeat lesson added.
