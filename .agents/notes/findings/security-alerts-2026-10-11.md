# Dependency security alerts — 2026-10-11

Scope: GitHub Dependabot alerts #30–34 in `zevium-dev/core`, checked with the
security-alert APIs. Code scanning and secret scanning returned no open alerts.

## Dependency paths and fixes

- **#34, sharp:** Wrangler / Cloudflare Vite and Vitest tooling → Miniflare →
  sharp. Replace the old unconditional `0.35.4` override with
  `sharp@<0.35.5: 0.35.5`, including its patched platform binaries and libvips.
  This covers both installed Miniflare generations without changing Cloudflare
  tooling versions.
- **#33, shell-quote:** root `concurrently` → shell-quote. Upgrade the direct
  parent from `10.0.5` to `10.0.6`, which requires `shell-quote@1.12.0`, and remove
  the old `concurrently>shell-quote: 1.10.0` override. The separate launch-editor
  dependency already uses patched `1.11.0`.
- **#31 and #32, seroval:** `@tanstack/react-devtools` → `@tanstack/devtools` →
  `solid-js@1.9.14` / `seroval-plugins@1.5.6` → `seroval@1.5.6`. The direct devtools
  packages are already at their latest registry versions. Override only
  `seroval@<1.6.3` to `1.6.8`, matching the existing patched TanStack Start/Router
  SSR version. Solid and its plugin keep their current versions.
- **#30, postcss-selector-parser:** `@tailwindcss/typography@0.5.20` pins `6.0.10`
  and has no newer registry version. Override `postcss-selector-parser@<7.1.6`
  to `7.1.6`; the web build exercises typography's selector transformations.

Overrides belong in root `pnpm-workspace.yaml`, the existing pnpm 11 settings
location. No unrelated dependency updates or release-age/build-policy changes.
`pnpm why sharp shell-quote seroval postcss-selector-parser -r` verifies every
consumer path; TanStack SSR already used `seroval@1.6.8` before this change.

## Verification

Required gate: `TMPDIR="$PWD/.tmp" VITEST_MAX_WORKERS=2 mise exec -- pnpm ci:pr`
after `pnpm format`. It includes web unit tests, production web compilation,
and built Worker runtime checks, plus workspace and isolated Convex checks.
No deployment or application dev server is required.

Additional checks passed: `pnpm audit --json` reports zero vulnerabilities; a
focused smoke check renders Solid SSR and round-trips dates, maps, typed arrays,
and shared references through its patched Seroval. Solid and its existing
serialization plugin resolve the same Seroval module. Sharp SVG rasterization
also passes with `sharp@0.35.5`, libvips `8.18.7`, and librsvg `2.63.2`.
