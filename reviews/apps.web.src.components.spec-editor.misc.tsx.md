# Spec-Editor Misc — Tiger Review

Files: `editor-toolbar.tsx`, `version-dialog.tsx`, `json-code-editor.tsx`, `spec-rail.tsx`, `codemirror-theme.ts`, `template.ts`, `index.ts`

## Verdict

**Incorrect** — two data-loss paths and a visual mess in the lint layer. Ship-blockers below.

## File Stats

| File | Lines | Findings |
|---|---|---|
| editor-toolbar.tsx | 153 | 2 (P1, P3) |
| json-code-editor.tsx | 121 | 2 (P2, P2) |
| spec-rail.tsx | 685 | 1 (P1) |
| codemirror-theme.ts | 96 | 1 (P2) |
| version-dialog.tsx | 165 | 1 (P3) |
| template.ts | 24 | 0 |
| index.ts | 4 | 0 |

Total: 7 findings (P0: 0, P1: 2, P2: 3, P3: 2)

## Findings

### [P1] Flush pending pricing edits on unmount, don't discard them

**Location:** `spec-rail.tsx` ~L120-125 (cleanup effect)

```tsx
  useEffect(() => {
    return () => {
      clearTimeout(flushTimer.current);
    };
  }, []);
```

**Problem:** `SpecRailEndpoints` debounces pricing edits in `pendingEdits.current` / `pendingKeys.current` and flushes them to `onPricingChange` after `PRICING_DEBOUNCE_MS` (300ms). The unmount cleanup only clears the timer — it does NOT flush the pending edits. If the user types in a cost/free-tier field and navigates away (route change, dialog open, parent re-render that unmounts the rail) within 300ms, the queued `PricingEdit` is silently dropped. `onPricingChange` is never called, so `SpecWorkspace.text` is never updated, and the autosave (which reads `text`) saves the old draft without the pricing change.

**Trigger:** Type a pricing edit → within 300ms navigate away (or otherwise unmount the rail).

**Impact:** Silent data loss of the user's pricing edit. The saved draft in Convex does not reflect the edit. No toast, no error — the user believes the edit took.

**Fix:** Flush synchronously on unmount before clearing:

```suggestion
  useEffect(() => {
    return () => {
      const edits = [...pendingEdits.current.values()];
      pendingEdits.current.clear();
      pendingKeys.current.clear();
      clearTimeout(flushTimer.current);
      for (const e of edits) onPricingChange?.(e);
    };
  }, [onPricingChange]);
```

(`onPricingChange` from `spec-workspace` is `useCallback`-stabilized, so adding it to deps is safe and keeps the closure current.)

---

### [P1] Template / Import / URL replace the editor with no dirty confirmation

**Location:** `editor-toolbar.tsx` ~L88-99 (dropdown items)

```tsx
          <DropdownMenuItem
            onSelect={() => {
              onApplyText(OPENAPI_TEMPLATE);
              toast.success("Template loaded");
            }}
            disabled={disabled}
          >
            <FileCode2 className="size-3.5" />
            Start from template
          </DropdownMenuItem>
```

**Problem:** All three import actions ("Start from template", "Upload .json / .yaml", "Import from URL") call `onApplyText(...)` which in `spec-workspace` is `applyEditorText` → `setText(converted.json)`. This replaces the entire editor text unconditionally. `disabled` is wired to `savePending` only — it is NOT wired to `dirty`. So when the user has unsaved draft changes (dirty=true, autosave not yet fired or blocked by client errors), a single misclick on "Start from template" overwrites the buffer. The autosave then saves the *new* text (template), destroying the previous unsaved draft. `VersionDialog.handleRestore` *does* gate restore on `dirty` with a two-step confirmation — this is inconsistent.

**Trigger:** Edit the spec (dirty) → click "Start from template" (or upload, or import URL) before autosave fires.

**Impact:** Unsaved draft work is overwritten and then auto-saved over. The user's prior draft is gone from both the buffer and (after autosave) the backend.

**Fix:** Gate destructive imports behind a confirmation when the buffer is dirty, mirroring `VersionDialog`'s pattern — either pass `dirty` into `EditorToolbar` and show a confirm dialog, or have `applyEditorText` in the workspace confirm before `setText` when `dirty`.

---

### [P2] Hardcoded `#ef4444` hex in lint squiggle SVG

**Location:** `codemirror-theme.ts` L75-77

```ts
      ".cm-lintRange-error": {
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='3'%3E%3Cpath d='M0 3 L3 0 L6 3' fill='none' stroke='%23ef4444' stroke-width='1'/%3E%3C/svg%3E\")",
      },
```

**Problem:** The error squiggle paints a raw `#ef4444` (Tailwind `red-500`) — a hardcoded hex that bypasses the project's semantic-token system. The UI rules require semantic tokens (`bg-primary`, `--destructive`, etc.) and reject raw Tailwind colors. This squiggle will not adapt when `--destructive` is redefined, and it is the only place in the web app that hardcodes red (confirmed via grep — `ef4444` appears nowhere else in `apps/web/src`). The rest of the theme correctly uses `var(--destructive)`, `var(--popover)`, etc.

**Impact:** Visual inconsistency with the design system; squiggle color drifts from `--destructive` if the token is rethemed. Also breaks dark-mode parity — `#ef4444` is fixed regardless of theme.

**Fix:** CSS variables cannot resolve inside a `data:` URI SVG (separate document context). Replace the data-URI squiggle with a CSS background that references the token, or omit the custom `backgroundImage` and let `@codemirror/lint`'s default error styling (already themed via `.cm-lintRange-error` border or a `text-decoration: underline wavy var(--destructive)`) carry it:

```suggestion
      ".cm-lintRange-error": {
        backgroundImage: "none",
        textDecoration: "underline wavy var(--destructive)",
      },
```

---

### [P2] Every lint diagnostic spans the entire document

**Location:** `json-code-editor.tsx` L23-31

```ts
function issuesToDiagnostics(doc: string, issues: SpecIssue[]): Diagnostic[] {
  if (issues.length === 0) return [];
  const end = Math.max(doc.length, 0);
  return issues.map((issue) => ({
    from: 0,
    to: Math.min(end, Math.max(1, end)),
    severity: issue.level === "error" ? "error" : "warning",
    message: `${issue.message} (${issue.path})`,
  }));
}
```

**Problem:** Every diagnostic has `from: 0, to: end` — the full document range. With `N` issues, `N` full-document underlines stack on top of each other, so the *entire* spec body gets a red wavy squiggle regardless of where the error is. The lint gutter markers are also unpositioned. `SpecIssue.path` (a JSON pointer like `/paths/~1health/get/x-zevium-cost`) is only echoed into the message text — never used to locate the offending range.

**Impact:** Useless lint visualization — the whole document is flagged red whenever there is any error, hiding the actual location. Hovering anywhere shows every diagnostic. Not actionable.

**Fix:** Resolve `issue.path` (JSON pointer) to a character range in `doc` (walk the parsed JSON or string-scan the pointer segments) and set `from`/`to` to the offending token. At minimum, scope each diagnostic to its line.

---

### [P2] Double debounce + stale lint source via `lintDoc` state

**Location:** `json-code-editor.tsx` L54-66

```ts
  const [lintDoc, setLintDoc] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    clearTimeout(timerRef.current ?? undefined);
    timerRef.current = setTimeout(() => {
      setLintDoc(value);
      timerRef.current = null;
    }, LINT_DEBOUNCE_MS);
    return () => {
      clearTimeout(timerRef.current ?? undefined);
    };
  }, [value]);

  const lintSource = useCallback(
    (view: { state: { doc: { toString(): string } } }) => {
      const text = view.state.doc.toString();
      const source = text === lintDoc || lintDoc === "" ? text : lintDoc;
      if (source.trim() === "") return [];
      const issues = collectOpenApiSpecIssues(source);
      return issuesToDiagnostics(source, issues);
    },
    [lintDoc],
  );
```

**Problem:** Two issues compound here.

1. **Double debounce.** `linter(lintSource, { delay: LINT_DEBOUNCE_MS })` already debounces lint runs by 300ms. The `lintDoc` state adds *another* 300ms debounce on top, so diagnostics settle ~600ms after the last keystroke. The `lintDoc` state is redundant — `linter`'s `delay` is the canonical debounce.

2. **Stale source.** When `text !== lintDoc` (i.e., during the 300ms window before `lintDoc` catches up), `lintSource` deliberately lints `lintDoc` (the stale value) instead of `view.state.doc` (the current text). Diagnostics are computed against an old document version and then rendered on the new one. Because `issuesToDiagnostics` uses `from: 0, to: lintDoc.length` (not `text.length`), the diagnostic range is also wrong relative to the live doc.

**Impact:** Lint feedback lags an extra 300ms and shows stale diagnostics during the debounce window — the user sees errors that may have already been fixed, or misses errors they just introduced, for up to 600ms.

**Fix:** Drop `lintDoc` entirely and lint against `view.state.doc.toString()`:

```suggestion
  const lintSource = useCallback(
    (view: { state: { doc: { toString(): string } } }) => {
      const source = view.state.doc.toString();
      if (source.trim() === "") return [];
      const issues = collectOpenApiSpecIssues(source);
      return issuesToDiagnostics(source, issues);
    },
    [],
  );
```

The `linter(..., { delay: LINT_DEBOUNCE_MS })` already throttles. (This also removes the `lintDoc`/`timerRef` state and its cleanup effect, killing a class of subtle staleness bugs.)

---

### [P3] Hidden file input is not disabled with the toolbar

**Location:** `editor-toolbar.tsx` L79-84

```tsx
      <input
        ref={fileRef}
        type="file"
        accept=".json,.yaml,.yml,..."
        className="hidden"
        onChange={(e) => void onFileChange(e.target.files)}
      />
```

**Problem:** The dropdown menu items are disabled when `disabled` is true (e.g., during save), but the hidden `<input type="file">` itself is never `disabled`. A keyboard user can Tab to it and activate it (Enter/Space opens the file picker) even while the toolbar is supposedly disabled. `onFileChange` would then read the file and call `applyImportedRaw` → `onApplyText`, bypassing the disabled state.

**Impact:** Minor a11y / state-bypass — the disabled toolbar is not fully disabled.

**Fix:** Add `disabled={disabled}` to the input.

---

### [P3] `confirming` state in `VersionDialogBody` persists across `versionId` changes

**Location:** `version-dialog.tsx` ~L66-77 (`handleRestore` + `confirming` state)

**Problem:** When the dialog is open and the user clicks a *different* version in the rail (without closing), `versionId` changes but `VersionDialogBody` does not remount (it stays mounted as long as `versionId !== null`). Its `confirming` state persists. So if the user clicked "Restore to draft" on version A (`confirming=true`), then selects version B, the confirm UI is already showing for version B, and a single click on "Restore" executes the restore without re-asking. The intent confirmation was for version A.

**Impact:** Minor — the user already signaled intent to replace the draft. But the confirm text refers to "current unsaved draft changes" generically, and the version context silently swapped under it.

**Fix:** Reset `confirming` when `versionId` changes — add `useEffect(() => setConfirming(false), [versionId])`, or key the body by `versionId` so it remounts.

## Summary

7 findings: 0 P0, 2 P1, 3 P2, 2 P3.

**Top 3 to fix before merge:**

1. **P1 — Pricing edits dropped on unmount** (`spec-rail.tsx`): flush `pendingEdits` in the cleanup, don't just clear the timer. Silent data loss.
2. **P1 — Template/Import overwrites unsaved editor without confirmation** (`editor-toolbar.tsx`): gate destructive imports on `dirty`, mirroring `VersionDialog`'s restore-confirm pattern.
3. **P2 — Lint diagnostics span the entire document** (`json-code-editor.tsx`): `from: 0, to: end` makes every error underline the whole spec — unusable lint visualization; resolve `issue.path` to a range.

Other cleanups: drop the hardcoded `#ef4444` squiggle for a token, simplify the double-debounced `lintDoc` lint source, disable the hidden file input with the toolbar, and reset `confirming` on `versionId` change.
