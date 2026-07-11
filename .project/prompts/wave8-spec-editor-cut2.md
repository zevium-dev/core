Task: spec editor cut 2 — pricing rail write-back + version view/diff. Write scope: apps/web/src/components/spec-editor/, apps/web/src/lib/ (new helpers+tests), apps/web/src/routes/app/projects/$projectSlug/spec.tsx. Nothing else.

Read first: AGENTS.md, DESIGN.md, apps/web/src/components/spec-editor/* (cut 1: JsonCodeEditor theme=none CSS-var theme, SpecWorkspace autosave, spec-rail read-only), apps/web/src/lib/spec-endpoints.ts, convex/specs.ts getVersion ({versionId} → {version, spec, publishedAt}), packages/shared parseSpec.

BUILD:

1. Rail write-back: endpoint rows in the rail get editable cost + free-tier inputs (small, mono, right-aligned). Editing writes back into the editor JSON: parse current text → set paths[path][method]["x-zevium-cost"] / ["x-zevium-free-tier"] (delete key when cleared) → serialize with 2-space indent PRESERVING key order (surgical: use a targeted JSON edit — parse+stringify of whole doc is acceptable ONLY if key order preserved by insertion-order semantics, which JSON.parse/stringify does preserve for objects; keep numbers as numbers). Debounce 300ms; if editor text is invalid JSON, disable rail inputs with "fix errors to edit pricing". Two-way loop guard: don't re-trigger rail update from its own write.
   - Extract pure helper apps/web/src/lib/spec-pricing-edit.ts: applyPricingEdit(specText, {path, method, cost?, freeTier?}) → {ok, text} — full vitest coverage (set/update/clear, invalid json, missing path).
2. Version view + diff: versions card rows become clickable → dialog (large) fetching specs.getVersion (convexQuery, isPending skeleton): tabs "Spec" (read-only JsonCodeEditor readOnly) and "Diff vs draft" — line diff of version spec vs current SAVED draft, rendered with +/- gutter colors via semantic tokens (green=--chart-2-ish? NO — use text-muted-foreground for context, and for add/remove use the shadcn semantic pair: additions text-foreground bg-primary/10, deletions text-destructive bg-destructive/10). Implement diff with a tiny LCS line-diff helper in apps/web/src/lib/line-diff.ts + tests (no new heavy dependency).
   - "Restore to draft" button in dialog: sets editor text to version spec (does NOT autosave invalid; regular autosave takes over). Confirm via dialog if current draft is dirty.
3. Keep bundle sane: no new deps.

RULES: stock shadcn, semantic tokens only, motion tokens, isPending, reduced-motion.
TESTS: spec-pricing-edit.test.ts + line-diff.test.ts mandatory.
VERIFY: pnpm --filter web typecheck && pnpm --filter web test && pnpm --filter web build green.
Output: CHANGED list, VERIFY results, DONE or BLOCKED.
