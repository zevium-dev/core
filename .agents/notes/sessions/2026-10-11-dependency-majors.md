# Combined dependency majors — 2026-10-11

User requested one PR against develop covering Dependabot #305–#309, preserving payment behavior, checking test counts, and leaving ecosystem-blocked bumps open. Work is isolated in `dep-majors`; no deploys. Security-advisory package updates belong to a separate PR.

## Findings

- #305: historical CI reports React render purity, ref writes, synchronous state effects, and a useless worker export. Current tree has 21 findings under oxlint 1.86.0; corrected without rule suppression. Sidebar skeleton uses a fixed 70% width for stable rendering. Theme hydration uses the router hydration hook; mobile detection subscribes to media changes.
- #306: CI fails because `highlightText` was removed. v2 uses `highlightHTML(code, language, options)`; explicit inline/no-line-number options retain component markup. Existing semantic token styles remain valid.
- #308: existing CI passes. Optional native `utf-8-validate` bumps from 5.0.10 to 6.0.6; pnpm deduplicates its peer graph.
- #309: CI rejects Dahlia API-version literal and Accounts v2 onboarding `configurations`. Keep both wire values via two narrow, documented `@ts-expect-error` directives, as Stripe documents for older API versions. Network fakes assert the actual headers and recipient payload. Node 24 satisfies v23's Node >=20 requirement. Existing v2 pagination uses `next_page_url`; no removed V1 pagination fields, shared V2 address types, or `Stripe.ErrorType` usage needs migration. Incomplete-body connection errors remain ambiguous, like API errors. Signed webhook fixtures continue testing verification.
- #307: Vitest 5.0.3 lands for root/Convex, web, and shared. Gateway stays on 4.1.11: both `@cloudflare/vitest-pool-workers` 0.22.0 and latest 0.23.0 declare Vitest/runner/snapshot `^4.1.0`, and a v5 gateway probe fails before discovery with `SyntaxError: Unexpected identifier 'file'`, zero tests, and 15 unhandled errors. Per-manifest resolution keeps the pool on v4. No test selection/configuration is narrowed.
- Follow-up review: Codex's first activity fix remounted the whole page per filter window, which unmounted the focused filter `Select` trigger. Narrowed the key to the call list + inspector subtree.

## Verification

[Test inventory and commands](../architecture/testing.md#dependency-compatibility-2026-10-11). Baseline (`origin/develop` CI): 873 Vitest tests across 115 files. After: 877 across 117 files (two Stripe SDK and two highlighting regressions added). Node script tests unchanged. Full `pnpm ci:pr` also validates local anonymous Convex schema, OCC/races, paired Worker acceptance, build, and runtime security checks.

Rebased onto develop after the security PR #450 merged; lockfile regenerated with `pnpm install` from develop's lockfile rather than hand-merged, keeping #450's overrides.

## Sources

- [Stripe Node v23 migration](https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v23)
- [Stripe v23 changelog](https://github.com/stripe/stripe-node/blob/v23.0.0/CHANGELOG.md)
- [Stripe older API versions with TypeScript](https://github.com/stripe/stripe-node#using-old-api-versions-with-typescript)
- [Vitest v5 migration](https://vitest.dev/guide/migration.html)
- [Vitest custom pools](https://vitest.dev/guide/advanced/pool.html), [maxWorkers](https://vitest.dev/config/maxworkers.html)
- [Speed Highlight migration](https://github.com/speed-highlight/core#migrating-from-v1)
- Cloudflare pool peer ranges checked using `pnpm view @cloudflare/vitest-pool-workers@0.22.0 peerDependencies` and `pnpm view @cloudflare/vitest-pool-workers@0.23.0 peerDependencies`.
