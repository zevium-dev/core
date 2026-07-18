# Tiger Review — `apps/web/src/components/spec-editor/spec-workspace.tsx` (+ siblings)

Scope: `spec-workspace.tsx`, `spec-rail.tsx`, `version-dialog.tsx`, `editor-toolbar.tsx`, `json-code-editor.tsx`, `codemirror-theme.ts`, `index.ts`, `template.ts`, `lib/spec-save-status.ts`. No praise.

## Verdict

**Incorrect — do not merge.** Three P1 data-loss / liveness bugs in the autosave + remote-sync core: unsaved edits are silently clobbered by a sibling tab's save, navigating away within the 2s autosave window drops changes with no guard, and a server-rejected draft triggers an unbounded retry loop that spams toasts every 2s and hammers the backend. The rail/version-dialog UX is otherwise careful, but the concurrency model is not sound.

## File Stats

| File | Lines | Issues |
|---|---|---|
| spec-workspace.tsx | 473 | 4 (P1×3, P3×1) |
| version-dialog.tsx | 160 | 1 (P2) |
| codemirror-theme.ts | 96 | 1 (P3) |
| spec-rail.tsx | 685 | 1 (P2) |
| editor-toolbar.tsx | 117 | 0 |
| json-code-editor.tsx | 121 | 0 |
| index.ts / template.ts | — | 0 |
| lib/spec-save-status.ts | 56 | 0 |

## Findings

### [P1] Concurrent / multi-tab edit silently clobbers unsaved local edits
**Location:** `spec-workspace.tsx:135-142`
```ts
useEffect(() => {
  if (skipRemoteSync.current) {
    skipRemoteSync.current = false;
    return;
  }
  setText(savedDraft);
  setLastSavedAt(initialLastSavedAt);
}, [savedDraft, initialLastSavedAt]);
```
**Problem.** The remote-sync effect unconditionally `setText(savedDraft)` whenever the server draft changes. `skipRemoteSync` only short-circuits the case where *this* tab just saved. Convex realtime re-emits `getDraft` whenever *anyone* mutates the draft — a second tab, a second org member, or a stale invalidation refetch. When that happens with unsaved edits live in this tab, `dirty` is `true` and `textRef.current` holds work the user has not saved, yet the effect overwrites `text` with the incoming `savedDraft` and discards the local edits with no merge, no dirty-guard, no confirmation.
**Impact.** Silent data loss. A team member (or the same user in a second tab) saving the draft wipes whatever the first editor is mid-typing. There is no undo, no toast, no visible signal — the editor text just jumps to the other side's content.
**Fix.** Guard against clobbering dirty local state, e.g.
```ts
useEffect(() => {
  if (skipRemoteSync.current) {
    skipRemoteSync.current = false;
    return;
  }
  if (textRef.current !== savedDraft) {
    // local edits exist — surface divergence instead of overwriting
    return;
  }
  setText(savedDraft);
  setLastSavedAt(initialLastSavedAt);
}, [savedDraft, initialLastSavedAt]);
```
…paired with a visible "draft changed elsewhere — reload / discard" affordance rather than a silent overwrite.

---

### [P1] No navigation guard — leaving the editor within the 2s autosave window loses changes
**Location:** `spec-workspace.tsx:273-283` (autosave effect); no `beforeunload`/`useBlocker` anywhere in `apps/web/src` (confirmed by grep across `apps/web/src`).
```ts
useEffect(() => {
  if (!dirty || hasClientErrors || savePending) return;
  const handle = setTimeout(() => {
    const current = textRef.current;
    if (current === savedDraft) return;
    if (current.trim() !== "") {
      const issues = collectOpenApiSpecIssues(current);
      if (issues.some((i) => i.level === "error")) return;
    }
    saveDraft(current);
  }, AUTOSAVE_MS);
  return () => clearTimeout(handle);
}, [text, dirty, hasClientErrors, savePending, savedDraft, saveDraft]);
```
**Problem.** Autosave is debounced 2s; its timer is cleared by the effect cleanup on unmount. There is no `beforeunload` handler and no TanStack Router `useBlocker`. If the user types and then clicks a `<Link>` (e.g. the in-card "Add one in Settings" link at L366, or the nav bar) within 2s, the component unmounts, the pending autosave is cancelled, and `text` state is destroyed. Same loss path on version-switch via `VersionDialog` restore followed by immediate nav, or on tab close.
**Impact.** Silent data loss on navigate-away / tab close. The `dirty` flag is already computed but never wired to any guard.
**Fix.** Add a router blocker while dirty (and a `beforeunload` for tab close), e.g.
```ts
useBlocker({
  shouldBlock: () => dirty,
  ...,
});
useBeforeUnload(
  useCallback((e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  }, [dirty]),
);
```

---

### [P1] Autosave retries forever with toast spam when the server rejects a draft the client considers clean
**Location:** `spec-workspace.tsx:199-203` (`onSuccess` failure branch) + `273-283` (autosave gate).
```ts
onSuccess: async (result) => {
  setServerIssues(result.issues);
  if (!result.ok) {
    toast.error("Draft has errors — fix issues before saving");
    return;            // no lastSavedAt bump, no skipRemoteSync, no backoff
  }
  ...
}
...
// autosave gate:
if (!dirty || hasClientErrors || savePending) return;
```
**Problem.** `hasClientErrors` is derived from `clientIssues` only (L160-163: `clientIssues.filter(i => i.level === "error")`). Server-side issues land in `serverIssues` / `mergedIssues` but are invisible to the autosave gate and to `deriveSaveStatus`. When `saveDraft` resolves with `result.ok === false` (server validation stricter than `collectOpenApiSpecIssues`), `onSuccess` sets `serverIssues`, toasts, and returns without bumping `lastSavedAt` or setting `skipRemoteSync`. The mutation settles (`savePending → false`), so the autosave effect re-runs with `dirty=true`, `hasClientErrors=false` (client still says clean), and schedules another 2s save. The inner timer re-runs `collectOpenApiSpecIssues(current)` (client-side only) and finds no errors, so `saveDraft(current)` fires again. Loop. No retry count, no exponential backoff, no "last save failed" circuit-breaker.
**Impact.** Every 2s: a `toast.error("Draft has errors — fix issues before saving")` + a `saveDraft` Convex mutation. Persists until the user leaves the page or manages to satisfy the server validator. If the server error is not reproducible by the client validator (divergent OpenAPI rule sets, server-side business rules), the loop is **unbounded** and the user cannot stop it from the editor.
**Fix.** Gate autosave on merged/server errors and add a failure circuit-breaker, e.g.
```ts
const mergedErrors = mergedIssues.filter((i) => i.level === "error");
const lastSaveFailed = serverIssues.some((i) => i.level === "error");
useEffect(() => {
  if (!dirty || hasClientErrors || savePending || lastSaveFailed) return;
  ...
}, [text, dirty, hasClientErrors, savePending, lastSaveFailed, ...]);
```
…and reset `lastSaveFailed` only after a successful edit to the offending region.

---

### [P2] VersionDialog "Diff vs draft" diffs `savedDraft`, not the editor's current `text`
**Location:** `version-dialog.tsx:78-79`, wired via `spec-workspace.tsx:461-468`.
```ts
const diff = useMemo<DiffLine[] | null>(
  () => (data ? lineDiff(data.spec, savedDraft) : null),
  [data, savedDraft],
);
```
**Problem.** The diff baseline is the last *saved* draft (`savedDraft` prop), not the editor's live `text`. When the user has unsaved edits and opens the version dialog, the "Diff vs draft" tab compares the published version against the saved draft, silently hiding the user's in-flight edits. The restore confirmation (`dirty && !confirming`) mentions unsaved changes exist, but the visual diff the user is shown to make the restore decision does not reflect what they are about to discard.
**Impact.** Misleading diff → wrong restore decision. `dirty` is already passed to the dialog; the diff should baseline against `text`.
**Fix.** Pass `text` (or the full editor string) as the diff baseline:
```ts
// spec-workspace.tsx
<VersionDialog
  versionId={versionDialogId}
  savedDraft={text}        // diff against live editor content
  dirty={dirty}
  onRestore={(spec) => setText(spec)}
  ...
/>
```
(rename the prop to `editorText` for clarity, since the JSDoc already says "current SAVED draft" — that contract is the bug).

---

### [P2] Cross-tab publish races on the saved-draft snapshot
**Location:** `spec-workspace.tsx` publish mutation, ~L215-243.
```ts
const { mutate: publish, isPending: publishPending } = useMutation({
  mutationFn: () =>
    publishFn({ projectId, version: version.trim() }),
  ...
});
```
**Problem.** The publish mutation sends only `{ projectId, version }`; the server snapshots whatever draft is persisted at execution time. The Publish button is disabled while `dirty || savePending || hasClientErrors`, so at click time `text === savedDraft`. But between the click and the server executing, a sibling tab/member can call `saveDraft` with different content, and the published version then snapshots that other content — labelled with the version string the first editor typed. There is no draft revision / ETag sent with the publish, so the server cannot detect the divergence.
**Impact.** A published (immutable) version can be cut from content its publisher never reviewed. Low probability but high consequence (immutable artifact shipped to the catalogue/data plane from the wrong draft).
**Fix.** Send a draft revision id (or hash) with `publish`; server rejects if the persisted draft no longer matches, forcing the publisher to re-confirm.

---

### [P3] Hardcoded `#ef4444` color in CodeMirror lint-error SVG
**Location:** `codemirror-theme.ts:74-77`
```ts
".cm-lintRange-error": {
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg ... stroke='%23ef4444' stroke-width='1'/%3E%3C/svg%3E\")",
},
```
**Problem.** `%23ef4444` is `#ef4444` (Tailwind `red-500`) hardcoded into the SVG data URI. Every other color in this theme resolves via `var(--…)` semantic tokens (`--destructive`, `--foreground`, etc.); this is the lone raw value. Violates the project rule "raw Tailwind colors rejected — semantic color tokens only".
**Impact.** The lint-error squiggle color cannot be themed (e.g. it will not track `--destructive` in a custom brand theme). Data URIs cannot read CSS vars directly, but the color can be injected at runtime via a CSS variable on a parent and `currentColor`, or the SVG stroke can reference `var(--destructive)` by inlining the theme value at mount.
**Fix.** Drive the stroke from a CSS var, e.g. set `stroke="currentColor"` and color the `.cm-lintRange-error` element via `color: var(--destructive)`.

---

### [P3] `onRestore` does not clear stale `serverIssues`
**Location:** `spec-workspace.tsx:465`
```ts
onRestore={(spec) => setText(spec)}
```
**Problem.** Restoring a published version into the editor calls only `setText(spec)`. `serverIssues` still holds the validation result from the *previous* draft, so the Validation rail surfaces stale errors that do not apply to the restored spec until the next autosave round-trip (~2s) refreshes `serverIssues` via `onSuccess`.
**Impact.** Up to 2s of misleading error state in the rail after every restore. Minor, but confusing right next to a destructive-ish action.
**Fix.**
```ts
onRestore={(spec) => {
  setText(spec);
  setServerIssues([]);
}}
```

---

## Summary

7 findings · P1×3 · P2×2 · P3×2

Top 3:
1. **Concurrent edit clobbers unsaved edits** (spec-workspace.tsx:135-142) — the remote-sync effect has no dirty-guard; any sibling save silently overwrites live local work.
2. **No navigation guard** (spec-workspace.tsx:273-283) — the 2s autosave timer is cleared on unmount; leaving the editor within the window drops changes with no `beforeunload`/`useBlocker`.
3. **Infinite autosave retry on server-rejected drafts** (spec-workspace.tsx:199-203, 273-283) — the gate only sees client errors, so a server-only validation failure loops every 2s with toast spam and backend load, with no backoff or circuit-breaker.
