---
name: security-alerts-2026-11-01
description: Nov 2026 dependency audit fixes (zod, undici, vite, launch-editor, @vitest/mocker, seroval) and why Dependabot vite PRs fail CI on fresh releases
---

# Dependency security alerts — 2026-11-01

Scope: `pnpm audit` on develop reported 7 high, 15 moderate, 1 low.

## Fixes

- **zod** (GHSA-mrhx-c7xc-m3w5): direct ranges `^4.6.5` → `^4.6.7`. `@cloudflare/vitest-pool-workers@0.22.0`
  pins `zod@4.4.3` exactly, so `zod@<4.6.6: 4.6.7` override in `pnpm-workspace.yaml`.
- **undici**: existing unconditional override `7.30.0` → `7.30.1`.
- **vite**: `apps/web` `^8.3.2` → `^8.3.5`. Vite brings newer rolldown/oxc with it.
- **launch-editor**: `@tanstack/devtools-bundler-core` asks `^2.14.1`; override `launch-editor@<2.14.2: 2.14.2`.
- **@vitest/mocker**: gateway (`@cloudflare/vitest-pool-workers@0.22` peers `vitest ^4.1`) and cli stay on vitest 4;
  `^4.1.11` → `^4.1.12`. `@vitest/mocker@5.x` used by root/web/shared is outside the advisory ranges.
- **seroval**: override `seroval@<1.6.3: 1.6.8` → `seroval@<1.6.11: 1.6.12` (TanStack Router/Start and Solid).

Left open: minimatch GHSA-g3hv-75wg-m249 (moderate, eslint tooling under `@tanstack/eslint-plugin-router`).

## Gotcha: minimumReleaseAge

`pnpm-workspace.yaml` sets `minimumReleaseAge: 720` (12 h) with `minimumReleaseAgeStrict`. Dependabot
lockfiles that pull a fresh release fail `pnpm install` in CI with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`
(vite PR #479 died on `seroval@1.6.12` published 9 minutes before the run). Fix is regenerating the lockfile
once the release is older than 12 h, not relaxing the policy.
