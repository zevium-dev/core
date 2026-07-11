Task: spec editor cut 1 — replace textarea with real editor experience.
Write scope: /home/tnfssc/Code/zevium/apps/web/ AND /home/tnfssc/Code/zevium/packages/shared/ AND exactly one file /home/tnfssc/Code/zevium/convex/lib/validate.ts (re-export shim only). Nothing else in convex/.

Read first: AGENTS.md, DESIGN.md (motion tokens, loading rules), FLOW.md 4.6, apps/web/src/routes/app/projects/$projectSlug/spec.tsx (current editor), convex/lib/validate.ts, packages/shared/src/openapi.ts, apps/web/src/lib/spec-pricing.ts.

DIRECTION (decided): editor + live right rail. Cut 1 = read-only rail. NO rail→spec write-back yet, NO version diff yet.

BUILD:

1. Shared validation port: move the validation logic from convex/lib/validate.ts into packages/shared/src/validate.ts (same behavior, pure function validateOpenApiSpec(specText) → {errors, warnings} with JSON paths). convex/lib/validate.ts becomes a thin re-export from @zevium/shared — convex bundler resolves workspace deps fine. Add unit tests packages/shared/src/validate.test.ts (port + extend: bad json, missing openapi, bad servers, bad x-zevium-cost type, warning on missing cost).

2. CodeMirror editor (apps/web): replace the textarea in spec route with CodeMirror 6 (@uiw/react-codemirror + @codemirror/lang-json + @codemirror/lint). JSON syntax highlight, line numbers, lint gutter fed by shared validateOpenApiSpec (debounced ~300ms). Editor theme derives from shadcn CSS vars (bg-background, muted-foreground); must look native in light AND dark. Component: apps/web/src/components/spec-editor/ (new dir) — split route file, keep route thin.

3. YAML input: accept YAML paste/import — detect non-JSON, parse with `yaml` package, convert to pretty JSON immediately client-side, toast "Converted YAML to JSON" (storage stays canonical JSON; gateway/convex untouched).

4. Import menu in editor toolbar: (a) upload .json/.yaml file, (b) import from URL — server fn in apps/web that fetches the URL server-side (avoids CORS), validates size < 2MB, returns text; zod-validate the URL. (c) "start from template" = current placeholder skeleton.

5. Live rail (right, ~40% width, stacks below on mobile):
   - Endpoints card: parsed live from editor text via @zevium/shared parseSpec/extractPricing — method chip, path, cost credits, free-tier. Invalid text → keep last-good with subtle "stale" state.
   - Validation card: live errors/warnings with JSON path (replaces after-save-only Issues panel; keep server issues merged after save).
   - Versions card: existing listVersions + publish dialog (unchanged semantics: publish snapshots SAVED draft, semver, immutable).
   - Publish card includes visibility nudge: if project.visibility === "private" show inline warning "Project is private — publishing won't list it in the catalogue" with a Make public button (existing projects.update mutation).

6. Autosave: debounce 2s after last keystroke → specs.saveDraft; keep manual Save button; show "saved Ns ago / saving… / unsaved" status. Never autosave invalid JSON (client errors present) — show "fix errors to save". Use .mutate in handlers; isPending; optimistic where safe.

7. Motion/UI rules: stock shadcn, semantic tokens only, motion tokens from src/lib/motion.ts / CSS vars, skeletons layout-stable, prefers-reduced-motion respected. List→detail VT morphs already exist; keep viewTransitionName wiring intact.

TESTS (mandatory): packages/shared validate tests (above) + apps/web unit tests for pure logic you add (yaml-detect/convert helper, url import validation schema) with vitest — put helpers in testable modules (apps/web/src/lib/), add test files alongside. Web test script exists (vitest run --passWithNoTests).

VERIFY: root `pnpm typecheck`, `pnpm test`, `pnpm build` all green. pnpm add deps inside apps/web and packages/shared as needed (pnpm --filter web add …).

Output: CHANGED list, VERIFY results, DONE or BLOCKED.
