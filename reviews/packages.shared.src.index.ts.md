# Tiger Review — `packages/shared/src/index.ts`

## Verdict

**Incorrect (structural).** The barrel re-exports compile and every name resolves to a
real export in its sibling, so there are no wrong re-exports or circular deps. But the
public surface is bloated with dead exports and leaks internal helpers/sub-types that no
consumer in the monorepo touches, and two credit-math constants defined directly in the
barrel are unused while the web app ships its own duplicate copy under a different name.

## File Stats

- File: `packages/shared/src/index.ts` (38 lines)
- Siblings reviewed (full read): `pricing.ts`, `openapi.ts`, `mock.ts`, `validate.ts`
- Consumers traced: `apps/gateway/src/{pipeline,mock,mcp,discovery}.ts`,
  `apps/web/src/{lib/spec-*,routes/catalogue/*,components/spec-editor/*}`,
  `convex/{catalogue,search,specs,dev,lib/validate,projects}.ts`
- Package surface: `package.json` exports only `"."` → `./src/index.ts` (no subpaths)
- Diff context (wave 9b, commit `00a8448`): index.ts gained
  `export { generateMockResponse, type GeneratedMockResponse } from "./mock.js";` (the
  only patch line); `openapi.ts` gained the `components?` field on `ParsedOpenApiSpec`.

## Findings

---

### [P2] Dead exports: `CREDITS_PER_DOLLAR` and `PLATFORM_CUT` are unused; web ships a duplicate

```ts
// packages/shared/src/index.ts:4-8
/** $1 = 10,000 credits (PRODUCT.md). One global constant, never per-API. */
export const CREDITS_PER_DOLLAR = 10_000;

/** Platform cut: 5%. Publishers keep 95%. */
export const PLATFORM_CUT = 0.05;
```

**Problem.** A repo-wide grep for `import { … CREDITS_PER_DOLLAR|PLATFORM_CUT … } from
"@zevium/shared"` returns zero matches. Neither constant is imported from the shared
package anywhere. Meanwhile `apps/web/src/lib/project-helpers.ts` defines its own
`export const CREDITS_PER_DOLLAR = 10_000` plus `PUBLISHER_SHARE = 0.95` and consumes
those locally (`project-earnings-panel.tsx`, `project-helpers.test.ts`). The shared
constant and the web duplicate hold the same value under the same name with no link
between them.

**Impact.** The index.ts doc-comment promises "One global constant, never per-API" but
the codebase actually has two unlinked copies. A future change to the credit→dollar
ratio (e.g. `12_000`) edits one and silently leaves the other at `10_000`, diverging
publisher-display math from gateway credit math. `PLATFORM_CUT` (0.05) and the web's
`PUBLISHER_SHARE` (0.95) are the same fact expressed two ways with no derivation linking
them. This is exactly the "parallel pricing tables" smell the project rules forbid, just
for constants.

**Fix.** Either wire `apps/web/src/lib/project-helpers.ts` to import `CREDITS_PER_DOLLAR`
(and a new `PUBLISHER_SHARE = 1 - PLATFORM_CUT`) from `@zevium/shared` and delete the
local copies, or — if these are genuinely web-only display constants — remove them from
`index.ts` so the barrel stops claiming ownership it doesn't exercise.

---

### [P2] `validateOpenApiSpec` is a dead export whose name collides with a consumer alias of different return type

```ts
// packages/shared/src/index.ts:33
  validateOpenApiSpec,
```

```ts
// packages/shared/src/validate.ts:177
export function validateOpenApiSpec(specText: string): SpecValidationResult {
  const issues = collectOpenApiSpecIssues(specText);
  return {
    errors: issues.filter((i) => i.level === "error"),
    warnings: issues.filter((i) => i.level === "warning"),
  };
}
```

**Problem.** The shared `validateOpenApiSpec` returns `SpecValidationResult`
(`{ errors, warnings }`). It has zero external importers — only its own unit test
(`validate.test.ts`) calls it. The actual call sites in `convex/dev.ts:300` and
`convex/specs.ts:46,154` import a DIFFERENT symbol named `validateOpenApiSpec` from
`convex/lib/validate.ts`, which re-exports `collectOpenApiSpecIssues as
validateOpenApiSpec` — i.e. the alias returns `SpecIssue[]`, not
`SpecValidationResult`. Those call sites then do `issues.some(i => i.level === "error")`
and `issues.filter(...)`, which only type-checks because the aliased symbol is an array.

**Impact.** Two functions named `validateOpenApiSpec` coexist in the same monorepo,
both ultimately sourced from `@zevium/shared`, with different return shapes. If any
future maintainer in `convex/` switches an import from `"./lib/validate"` to
`"@zevium/shared"` (reasonable — they'd expect the "real" source), the call site breaks
at runtime: `{errors, warnings}.some` is `undefined` → TypeError, and TypeScript only
catches it if the call result is annotated. The shared export is dead weight that
creates a genuine footgun by existing under that name.

**Fix.** Remove `validateOpenApiSpec` from the shared barrel (and from `validate.ts`)
since nothing external consumes the `{errors, warnings}` form; consumers want the raw
`SpecIssue[]` from `collectOpenApiSpecIssues`. Alternatively, if the structured form is
the intended public API, rename the convex alias so the names stop colliding.

---

### [P3] Leaking internal path helpers `normalizePath` and `matchPathTemplate` through the public surface

```ts
// packages/shared/src/index.ts:16-17
  normalizePath,
  matchPathTemplate,
```

**Problem.** Both are internal implementation details of `matchOperation` and
`joinUpstreamUrl` (the two functions consumers actually call). No consumer imports
either from `@zevium/shared`; the only external-to-index callers are the package's own
tests, which import directly from `./openapi.js` (bypassing the barrel). They are
re-exported "just in case."

**Impact.** Export surface bloat. These helpers are now part of the package's public
API contract — renaming or refactoring them (e.g. switching to a compiled path matcher)
becomes a breaking change for a symbol nobody outside the package uses. It also couples
external consumers to the internal `{param}`-segment matching strategy.

**Fix.** Drop both from `index.ts`; keep them as unexported module-internal helpers in
`openapi.ts` (the tests can continue importing from `./openapi.js` since they already
do).

---

### [P3] Dead type exports `OpenApiServer` and `OpenApiPathItem` expose internal structure

```ts
// packages/shared/src/index.ts:20,22
  type OpenApiServer,
  …
  type OpenApiPathItem,
```

**Problem.** No consumer imports either type from `@zevium/shared`. They are structural
sub-types of `ParsedOpenApiSpec` (`servers: OpenApiServer[]`, `paths: Record<string,
OpenApiPathItem>`); consumers that touch `spec.servers[0].url` get the shape via
`ParsedOpenApiSpec` inference without needing the named sub-types.

**Impact.** Marginal bloat. `OpenApiServer` is a single-field `{ url: string }`; exporting
it pins the public API to the detail that servers is an array of `{url}` objects rather
than, say, a string array — a detail the package has no reason to commit to externally.

**Fix.** Remove both from `index.ts`; keep them unexported in `openapi.ts` (or inline
them into `ParsedOpenApiSpec`).

---

### [P3] `hasErrors` / `hasValidationErrors` are dead trivial wrappers

```ts
// packages/shared/src/index.ts:34-35
  hasErrors,
  hasValidationErrors,
```

**Problem.** `hasValidationErrors(result)` is `result.errors.length > 0` — a one-liner
with zero external importers (only `validate.test.ts` calls it). `hasErrors(issues)` is
`issues.some(i => i.level === "error")`; it is re-exported through
`convex/lib/validate.ts:8` but never actually called — `convex/dev.ts:301` and
`convex/specs.ts:155` inline `issues.some((i) => i.level === "error")` themselves rather
than calling the helper.

**Impact.** Dead wrapper functions in the public surface. `hasErrors` is doubly dead:
re-exported by convex, then never invoked, with the same logic inlined at the call sites.

**Fix.** Remove both from `index.ts` and `validate.ts`. If a helper is wanted, collapse to
one (`hasErrors(issues)`) and have convex call it instead of re-inlining.

---

### [P3] Barrel `index.ts` is not exercised by any test — re-export correctness is unverified

**Problem.** Every test in `packages/shared/src/` imports directly from the sibling
module: `openapi.test.ts` → `./openapi.js`, `mock.test.ts` → `./mock.js` +
`./openapi.js`, `validate.test.ts` → `./validate.js`. None import from `./index.js` (or
`@zevium/shared`). The barrel's re-export statements — which are the package's entire
public contract — have no test coverage.

**Impact.** A misspelled or dropped re-export is caught only indirectly, by consumer
typechecks in `apps/` and `convex/`. For the dead exports above (which no consumer
references), removing them would not be caught by any test. A rename in a sibling that
forgets to update `index.ts` silently drops a public symbol with no in-package signal.

**Fix.** Add a single smoke test that imports the full expected public surface from
`./index.js` (or `@zevium/shared`) and references each symbol, so the barrel itself is
guarded.

---

### [P3] Credit constants are defined directly in the barrel instead of in `pricing.ts`

```ts
// packages/shared/src/index.ts:4-8
export const CREDITS_PER_DOLLAR = 10_000;
export const PLATFORM_CUT = 0.05;
```

**Problem.** Every other export in `index.ts` is a re-export from a sibling module
(`pricing.js`, `openapi.js`, `mock.js`, `validate.js`). `pricing.ts` is the named home for
credit math (`EndpointPricing`), yet the two credit constants are defined inline in the
barrel itself, breaking the "barrel only re-exports" convention.

**Impact.** Inconsistent structure. A maintainer looking for the credit constants
naturally opens `pricing.ts` and finds only `EndpointPricing`; the constants are hidden
in the barrel. This also makes `pricing.ts` look like it owns credit math while
secretly not owning the two load-bearing scalars.

**Fix.** Move `CREDITS_PER_DOLLAR` and `PLATFORM_CUT` into `pricing.ts` and re-export
them from `index.ts` like everything else.

## Summary

- **Findings: 7** — P0: 0 · P1: 0 · P2: 2 · P3: 5
- **No circular deps.** Dependency graph is acyclic: `index.ts` → {`pricing`,
  `openapi`, `mock`, `validate`}; `openapi` → `pricing`; `mock` → `openapi`; `validate`
  → ∅.
- **No wrong re-exports.** Every name in `index.ts` resolves to a real export in its
  sibling module.
- **Top 3:**
  1. `CREDITS_PER_DOLLAR`/`PLATFORM_CUT` are dead in the barrel while `apps/web` ships a
     duplicate — a future ratio change diverges silently (P2).
  2. Shared `validateOpenApiSpec` is dead AND its name collides with a convex alias that
     returns a different shape — a `./lib/validate` → `@zevium/shared` import swap would
     crash at runtime (P2).
  3. `normalizePath`/`matchPathTemplate`/`OpenApiServer`/`OpenApiPathItem`/
     `hasValidationErrors`/`hasErrors` are dead or internal-only exports leaking through
     the public surface (P3 cluster).
