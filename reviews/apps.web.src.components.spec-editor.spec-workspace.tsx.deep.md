# Tiger Review — `apps/web/src/components/spec-editor/spec-workspace.tsx` (DEEP)

Files reviewed end-to-end: `spec-workspace.tsx`, `spec-rail.tsx`, `version-dialog.tsx`,
`editor-toolbar.tsx`, `json-code-editor.tsx`, `codemirror-theme.ts`, `template.ts`,
`index.ts`, `apps/web/src/lib/spec-save-status.ts`. Cross-checked against
`convex/specs.ts` (saveDraft/publish contracts), `apps/web/src/lib/spec-pricing.ts`,
and the route caller `routes/app/projects/$projectSlug/spec.tsx`.

## Verdict

NOT ship-ready. The autosave/remote-sync core has three load-bearing correctness
defects that will silently destroy user work under realistic conditions
(multi-tab, slow network, server-rejected drafts). The prior review's seven
findings are all confirmed and reproduced below; this pass expands to 22 issues
across correctness, design, and perf. Most are fixable with a small, focused
rewrite of the sync effect + autosave gate.

## File Stats

- File: `apps/web/src/components/spec-editor/spec-workspace.tsx`
- LOC: 473 (component proper ~360 lines)
- Public surface: `SpecWorkspace`, `SpecWorkspaceProps`
- Dependencies: Convex mutations (`specs.saveDraft`, `specs.publish`,
  `projects.update`), 4 sibling spec-editor modules, 5 lib helpers
- Prior review findings: 3 P1 + 2 P2 + 2 P3 — all confirmed below
- This review: 3 P1 + 9 P2 + 10 P3 = 22 findings

## Findings

---

### [SEV: P1] #1 — Remote-sync effect silently clobbers unsaved local edits on any `savedDraft` change (multi-tab / realtime push)

**Location:** `spec-workspace.tsx:135-141`

```tsx
useEffect(() => {
  if (skipRemoteSync.current) {
    skipRemoteSync.current = false;
    return;
  }
  setText(savedDraft);
  setLastSavedAt(initialLastSavedAt);
}, [savedDraft, initialLastSavedAt]);
```

**Problem:** `savedDraft` comes from `useSuspenseQuery(convexQuery(api.specs.getDraft, …))`
in `routes/app/projects/$projectSlug/spec.tsx:115-118`, which is a **live realtime
subscription**. Any other tab, device, or collaborator saving the draft pushes a
new `savedDraft` into THIS tab's props. The effect unconditionally calls
`setText(savedDraft)`, wiping whatever the user in THIS tab is currently typing
— including text that has not yet crossed the 2s autosave threshold and therefore
was never persisted. There is no dirty check, no merge, no conflict prompt, no
diff. `skipRemoteSync` only guards the local tab's OWN save echo (and is itself
racy — see #12).

**Repro:** Tab A and Tab B open the same project spec. Tab B types 10 characters
(doesn't wait 2s). Tab A saves (or autosaves). Tab B's editor silently reverts
to Tab A's draft. Tab B's keystrokes are gone — not in the editor, not on the
server.

**Impact:** Silent data loss of unsaved edits. The 2s autosave window is exactly
the exposure — anything typed within 2s of a remote push is destroyed. For a
spec editor this is the worst-case failure mode: the user keeps typing, unaware
their buffer just rewound.

**Fix:** Do not `setText` blindly on remote change. Track `dirty` and either
(a) refuse to overwrite when `dirty` (queue a "remote draft changed — reload?"
prompt), or (b) diff remote `savedDraft` vs local `textRef.current` and only
patch non-overlapping regions. At minimum, gate the clobber:

```tsx
useEffect(() => {
  if (skipRemoteSync.current) { skipRemoteSync.current = false; return; }
  if (textRef.current !== savedDraft && dirtyRef.current) {
    // local edits in flight — surface conflict, do not clobber
    setRemoteConflict(true);
    return;
  }
  setText(savedDraft);
  setLastSavedAt(initialLastSavedAt);
}, [savedDraft, initialLastSavedAt]);
```

---

### [SEV: P1] #2 — No `beforeunload` / `useBlocker` — route change or tab close within the 2s autosave window drops changes

**Location:** whole file; absence confirmed by `grep beforeunload|useBlocker` →
no matches anywhere in `apps/web/src`.

**Problem:** The autosave timer (`AUTOSAVE_MS = 2000`) is a `setTimeout` cleared
on unmount. If the user navigates to another route, closes the tab, or reloads
within 2s of their last keystroke, the timer never fires and the edits are lost.
The `Save draft` button is the only other save path and is opt-in. There is no
router-level blocker (`@tanstack/react-router` ships `useBlocker`) and no
`beforeunload` listener. The route's `loader` does client-side
`prefetchQuery(projectQuery)` and returns — there is nothing preventing a fast
nav away.

**Impact:** Unsaved work lost on any navigation within the 2s window. The
editor's own autosave cadence is the risk window. Combined with #1 (which can
extend `dirty` indefinitely when a remote push clobbers `text` away from
`savedDraft`), the user can be permanently in a "dirty but unsaveable" state
with no guard.

**Fix:** Add `useBlocker` when `dirty && !savePending`, and a `beforeunload`
listener that calls `e.preventDefault()` when dirty. TanStack Router:

```tsx
useBlocker({
  shouldBlockFn: () => dirty && !savePending,
  // …
});
```

---

### [SEV: P1] #3 — Server-rejected draft triggers an infinite autosave retry loop (2s cadence) with toast spam and backend load

**Location:** `spec-workspace.tsx:210-222` (autosave effect) +
`spec-workspace.tsx:187-203` (`saveDraft` onSuccess rejected branch)

```tsx
// autosave effect
useEffect(() => {
  if (!dirty || hasClientErrors || savePending) return;
  const handle = setTimeout(() => {
    const current = textRef.current;
    if (current === savedDraft) return;
    if (current.trim() !== "") {
      const issues = collectOpenApiSpecIssues(current);
      if (issues.some((i) => i.level === "error")) return;
    }
    saveDraft(current);     // ← fires even when server previously rejected this exact text
  }, AUTOSAVE_MS);
  return () => clearTimeout(handle);
}, [text, dirty, hasClientErrors, savePending, savedDraft, saveDraft]);
```

```tsx
onSuccess: async (result) => {
  setServerIssues(result.issues);
  if (!result.ok) {
    toast.error("Draft has errors — fix issues before saving");
    return;                  // ← skipRemoteSync NOT set; savedDraft UNCHANGED
  }
  …
}
```

**Verified against backend** (`convex/specs.ts:30-84`): `saveDraft` returns
`{ ok: false, issues, draft: args.spec, lastSavedAt: 0 }` and **does not persist**
when validation fails. So after a server rejection: `savedDraft` prop is
unchanged (no realtime push), `skipRemoteSync` is never set, `text` still
differs from `savedDraft` → `dirty` stays `true`, `hasClientErrors` stays
`false` (the client's `collectOpenApiSpecIssues` is more permissive than the
server's validator, otherwise the autosave gate would have blocked the first
attempt). When `savePending` flips `true → false` the effect re-runs, schedules
a fresh 2s timer, and re-submits the SAME text the server just rejected.
Backend rejects again, toast fires again, forever.

**Impact:**
1. Toast storm — a new `toast.error("Draft has errors — fix issues before saving")`
   every 2s until the user intervenes. Sonner will stack/replace but the UX is
   broken.
2. Backend load — one wasted `saveDraft` mutation per 2s per open editor tab,
   per project, per user. For an org with N editors this is N × 0.5 QPS of
   guaranteed-rejected writes hitting Convex, plus the OpenAPI re-validation
   work server-side.
3. The `setServerIssues(result.issues)` on each retry is the ONLY signal —
   mergedIssues flicker but the user has no "stop retrying" affordance. No
   backoff, no circuit breaker, no "last save failed" sticky state.

**Fix:** Track the last-submitted text and the last-rejection; do not resubmit
identical text. Add a circuit breaker on consecutive failures:

```tsx
const lastSubmittedRef = useRef<string | null>(null);
const consecutiveFailuresRef = useRef(0);

// in autosave timer:
if (current === lastSubmittedRef.current) return;          // don't retry identical
if (consecutiveFailuresRef.current >= 3) return;           // circuit breaker

// in onSuccess (!ok) and onError:
consecutiveFailuresRef.current += 1;
// in onSuccess (ok):
consecutiveFailuresRef.current = 0;
lastSubmittedRef.current = null;
```

Exponential backoff (`2s → 4s → 8s → 30s cap`) would be better still. And show a
sticky "Save failed — click to retry" banner instead of repeated toasts.

---

### [SEV: P2] #4 — `VersionDialog` diffs `savedDraft`, not live editor text — "Diff vs draft" is misleading when `dirty`

**Location:** `version-dialog.tsx:57-63`, `version-dialog.tsx:86-88`

```tsx
const diff = useMemo<DiffLine[] | null>(
  () => (data ? lineDiff(data.spec, savedDraft) : null),
  [data, savedDraft],
);
```

```tsx
<DialogDescription>Diff vs draft</DialogDescription>
```

**Problem:** The diff baseline is `savedDraft` (the persisted draft), but the
editor's live text is `text` (which may have unsaved edits — `dirty`). The
`dirty` prop only gates a restore-confirmation step; it does NOT change the
diff baseline. So a user with unsaved edits sees a diff against a baseline that
does not match what is currently in their editor. The tab label "Diff vs draft"
is ambiguous — it should be "Diff vs saved draft" at minimum, or (better) diff
against the live `text` so the user can see "if I publish, here's what changes
vs my current editor buffer."

**Impact:** User makes a decision to restore/publish based on a diff that does
not reflect their current state. Can lead to "I didn't expect that" restores.

**Fix:** Pass `text` (live) as the diff baseline, or pass both and let the user
toggle. At minimum rename the tab to "Diff vs saved draft" and add a hint when
`dirty`.

---

### [SEV: P2] #5 — Cross-tab publish snapshots the server's draft, not necessarily what the user sees — `skipRemoteSync` race + silent text replacement

**Location:** `spec-workspace.tsx:155-172` (publish mutation) +
`spec-workspace.tsx:135-141` (sync effect)

**Problem:** `publishFn({ projectId, version })` sends NO spec content — the
server snapshots whatever draft row is currently persisted. The Publish button
is disabled when `dirty` (so the local "I have unsaved edits" case is covered).
BUT: due to #1, a remote push from another tab silently `setText`s this tab's
editor to the remote draft. The user could be staring at draft "X", click
Publish, and actually publish draft "Y" that another tab slipped in via the
sync effect between their glance and their click. There is no
"this is what you're about to publish" confirmation showing the exact bytes
the server will snapshot.

**Impact:** TOCTOU on the published artifact. Published versions are immutable
per `DialogDescription` ("Published versions are immutable"), so a wrong
snapshot is permanent (can only be deprecated, not deleted).

**Fix:** Show the exact `savedDraft` content (or a summary diff vs `text`) in
the publish dialog before the Publish button, and disable Publish whenever
`text !== savedDraft` OR a remote conflict is pending (see #1).

---

### [SEV: P2] #6 — `serverIssues` never cleared on text change or on restore — `mergedIssues` shows phantom errors

**Location:** `spec-workspace.tsx:118` (state), `spec-workspace.tsx:148-151`
(`mergedIssues`), `spec-workspace.tsx:380` (`onRestore`)

```tsx
const [serverIssues, setServerIssues] = useState<SpecIssue[]>([]);
…
const mergedIssues = useMemo(
  () => mergeIssues(clientIssues, serverIssues),
  [clientIssues, serverIssues],
);
…
<VersionDialog
  …
  onRestore={(spec) => setText(spec)}    // ← no setServerIssues([])
  …
/>
```

**Problem:** `serverIssues` is set ONLY inside `saveDraft`/`publish` `onSuccess`.
It is never cleared when:
- the user edits text (the server's last-known issues now refer to a stale
  draft, but `mergeIssues` keeps showing them appended to the new client issues);
- the user restores a published version via `onRestore` (the restored spec is
  a different document entirely, but the previous draft's server issues
  persist in `mergedIssues` until the next autosave fires 2s later — and if
  autosave is in the rejected-loop state from #3, they persist indefinitely).

**Impact:** The Validation rail shows errors that do not correspond to the
current editor content. Users chase phantom issues. Also blocks #3's recovery:
even if the user fixes the server-flagged error locally, `mergedIssues`
continues to show it, so the user can't tell whether they've actually resolved
it.

**Fix:** Clear `serverIssues` whenever `text` changes (or tag each server issue
with the `text` it was computed against and filter stale ones in `mergedIssues`).
Explicitly clear on `onRestore`:

```tsx
onRestore={(spec) => {
  setText(spec);
  setServerIssues([]);
}}
```

---

### [SEV: P2] #7 — Hardcoded `#ef4444` in CodeMirror lint squiggle SVG — violates semantic-token rule; file's own docstring is false

**Location:** `codemirror-theme.ts:75-77`

```ts
".cm-lintRange-error": {
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='3'%3E%3Cpath d='M0 3 L3 0 L6 3' fill='none' stroke='%23ef4444' stroke-width='1'/%3E%3C/svg%3E\")",
},
```

And the file header (`codemirror-theme.ts:5-8`):

```ts
/**
 * CodeMirror theme from shadcn CSS vars — native light + dark.
 * Colors resolve at paint via var(); no hardcoded hex.
 */
```

**Problem:** `%23ef4444` is URL-encoded `#ef4444` — a raw Tailwind red-500
hardcoded into an inline SVG data URL. This is exactly what the project's
"semantic color tokens only (bg-primary) — raw Tailwind colors rejected" rule
forbids. The same file uses `var(--destructive)` for `.cm-diagnostic-error`'s
border (line 64) — the inconsistency is in the same file. The docstring claim
"no hardcoded hex" is false and will mislead future reviewers. SVG data URLs
cannot reference `var(…)` for `stroke` (CSS vars don't propagate into encoded
SVG backgrounds in all browsers without `url("data:…#root")` + `<style>` tricks),
so the proper fix is to drop the custom squiggle and use CodeMirror's default
underline, or inject the SVG via a CSS rule that uses `currentColor`/`var()`.

**Impact:** Lint error squiggle is always red-500 regardless of theme; in dark
mode or a custom destructive token it clashes. Rule violation.

**Fix:** Replace with a CSS-only underline:

```ts
".cm-lintRange-error": {
  backgroundImage: "none",
  textDecoration: "underline wavy var(--destructive)",
  textUnderlineOffset: "2px",
},
```

And fix the docstring to not lie.

---

### [SEV: P2] #8 — 1-second `now` interval re-renders the entire component tree (including `JsonCodeEditor`) every second

**Location:** `spec-workspace.tsx:143-145`, `spec-workspace.tsx:223-229`

```tsx
useEffect(() => {
  const id = setInterval(() => setNow(Date.now()), STATUS_TICK_MS);
  return () => clearInterval(id);
}, []);
…
const status = deriveSaveStatus({ dirty, saving: savePending, hasClientErrors,
  lastSavedAt, now });
```

**Problem:** `STATUS_TICK_MS = 1000`. Every second, `setNow` triggers a full
re-render of `SpecWorkspace`, which re-renders `EditorToolbar`, `JsonCodeEditor`,
`SpecRailEndpoints`, `SpecRailValidation`, `SpecRailVersions`, `VersionDialog`.
None of these are memoized. `JsonCodeEditor` is a controlled CodeMirror wrapper
— `@uiw/react-codemirror` does prop-diffing but still runs reconciliation every
second even when nothing relevant changed. `SpecRailEndpoints` re-runs its
resync effect's `setValues` reducer on every parent render because the
`endpoints` prop identity may be stable but the component itself isn't memoized.
For a large spec (the editor holds the entire OpenAPI doc), this is measurable
jank on low-end devices and burns battery on laptops.

The only consumer of `now` is `formatSavedAgo(lastSavedAt, now)` for the
"saved 3s ago" label. That label only needs to update at most once per second
WHEN `lastSavedAt !== null` AND the status is "saved". When `dirty` or `saving`,
`now` is unused.

**Impact:** Continuous 1Hz re-renders of a heavy editor subtree for a status
label that's only meaningful in the "saved" state.

**Fix:** Isolate the "saved Xs ago" label into its own `<SaveStatusAgo
lastSavedAt={lastSavedAt} />` component that owns its own interval and only
ticks when `lastSavedAt !== null`. Or gate the interval on `lastSavedAt !==
null && !dirty`. Better: derive `now` only when needed.

---

### [SEV: P2] #9 — `onEditorChange` runs `convertSpecInputToJson` on every keystroke for any doc not starting with `{` or `[`

**Location:** `spec-workspace.tsx:243-260`

```tsx
function onEditorChange(next: string) {
  if (
    next.trim() !== "" &&
    !next.trimStart().startsWith("{") &&
    !next.trimStart().startsWith("[")
  ) {
    const converted = convertSpecInputToJson(next);   // ← runs every keystroke
    if (converted.ok && converted.convertedFromYaml) {
      setText(converted.json);
      toast.success("Converted YAML to JSON");
      return;
    }
  }
  setText(next);
}
```

**Problem:** The comment says "Full convert on each keystroke would thrash" —
and then the code does exactly that for any document whose first non-whitespace
char is not `{` or `[`. That includes: a JSON doc with a leading comment, a
doc that starts with a string key without braces (invalid JSON anyway), a doc
the user is in the middle of typing (e.g., they deleted the leading `{` and
are retyping). `convertSpecInputToJson` parses the full document on every
keystroke, which for a large spec is a full YAML→JSON conversion + parse per
keystroke. This will lag the editor on sizable specs.

Additionally, the YAML-detection heuristic (`!startsWith("{") && !startsWith("[")`)
will misfire on any JSON document whose first token is neither of those — e.g.
a bare string, a number, or whitespace-prefixed JSON. The conversion path
fires a `toast.success("Converted YAML to JSON")` per misfire, which is spam.

**Impact:** Editor input lag on large specs in the YAML-ish branch; spurious
"Converted YAML to JSON" toasts when the user is editing JSON that happens to
not start with `{`/`[` momentarily.

**Fix:** Debounce the YAML detection (e.g., only run on paste events
`e.originalEvent instanceof ClipboardEvent`, or after a 300ms idle), or detect
YAML structurally (e.g., contains `:\n` with no surrounding braces) rather than
by the absence of a leading brace.

---

### [SEV: P2] #10 — `issuesToDiagnostics` maps every issue to `from:0, to:end` — the entire document is highlighted per error

**Location:** `json-code-editor.tsx:31-38`

```tsx
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

**Problem:** Every diagnostic spans `[0, doc.length]`. With N errors, the entire
document is underlined N times. CodeMirror will paint N overlapping squiggles
over the whole buffer. The `SpecIssue` type carries a `path` (e.g.
`paths./users.get.responses.200`) — the diagnostic could resolve that path to a
document range and highlight just the offending node. Even a naive
`from = indexOf(path)` would be better than `0..end`.

Also `Math.min(end, Math.max(1, end))` simplifies to `end` when `end >= 1` and
`1` when `end === 0` — but the `Math.max(1, end)` is dead because `end` is
already `>= 0` and the `Math.min(end, …)` caps it back. The expression is
confused.

**Impact:** Useless lint markers — every error highlights everything, so the
user gets no spatial signal about where to fix. The Validation rail lists
issues by path, but the editor itself gives no positioning.

**Fix:** Resolve `issue.path` to a document range (CodeMirror has
`jsonLanguage.parser` available via `@codemirror/lang-json` — parse and walk to
the path). At minimum, highlight the line containing the first path segment.

---

### [SEV: P2] #11 — `goodEndpoints` / `endpointsStale` derived via `useEffect` + `setState` instead of `useMemo` — extra render cycle per edit

**Location:** `spec-workspace.tsx:146-152`

```tsx
const [goodEndpoints, setGoodEndpoints] = useState(
  () => listSpecEndpoints(savedDraft) ?? [],
);
const [endpointsStale, setEndpointsStale] = useState(false);
…
useEffect(() => {
  const rows = listSpecEndpoints(text);
  if (rows === null) {
    setEndpointsStale(true);
    return;
  }
  setGoodEndpoints(rows);
  setEndpointsStale(false);
}, [text]);
```

**Problem:** This is a pure derivation of `text` — exactly what `useMemo` is for.
The effect pattern causes: `text` changes → render (uses STALE
`goodEndpoints`) → effect runs → `setState` → re-render (uses fresh
`goodEndpoints`). One wasted render per keystroke, and the rail briefly shows
stale endpoints after every edit. Also `listSpecEndpoints(text)` returns `null`
on invalid JSON — the same invalidity is already captured by
`clientIssues`/`hasClientErrors`, so `endpointsStale` is redundant state.

`pricing` (line 153) and `clientIssues` (line 116) are correctly memoized —
this one is the odd one out.

**Impact:** Double render per keystroke; rail flicker; redundant state to keep
in sync.

**Fix:**

```tsx
const endpoints = useMemo(() => listSpecEndpoints(text), [text]);
const goodEndpoints = endpoints ?? [];
const endpointsStale = endpoints === null;
```

---

### [SEV: P2] #12 — `skipRemoteSync` is consumed by the NEXT `savedDraft` change regardless of source — race can clobber local edits

**Location:** `spec-workspace.tsx:133`, `spec-workspace.tsx:204-210`

```tsx
const skipRemoteSync = useRef(false);
…
onSuccess: async (result) => {
  setServerIssues(result.issues);
  if (!result.ok) { …return; }
  skipRemoteSync.current = true;          // ← set
  setLastSavedAt(result.lastSavedAt);
  toast.success("Draft saved");
  await queryClient.invalidateQueries({   // ← async; refetch fires here
    queryKey: convexQuery(api.specs.getDraft, { projectId }).queryKey,
  });
}
```

**Problem:** Between `skipRemoteSync.current = true` and the
`invalidateQueries` resolving, a realtime Convex push from ANOTHER tab saving
the draft can arrive and flip `savedDraft`. That push triggers the sync effect,
which consumes `skipRemoteSync` (sets it false) and SKIPS — leaving the remote
draft UN-applied. Then our own `invalidateQueries` resolves with the OTHER
tab's draft (which is what the server now holds), the sync effect fires again,
`skipRemoteSync` is now false, and `setText(otherTabDraft)` runs — clobbering
our local edits that we never saved. Wait, actually worse: our save persisted
`text` as we knew it, but the other tab overwrote it server-side, so the
server's truth is the other tab's draft. Our local `text` matches what WE
saved, which is no longer the server truth. The sync effect then forcibly
replaces our buffer with the other tab's draft — but only after a realtime
push that may or may not have arrived.

The flag is a single boolean with no association to a specific update. It
cannot distinguish "the echo of my own save" from "a remote tab's save that
happened to land right after mine."

**Impact:** Unpredictable buffer state under concurrent multi-tab saves. The
user's local edits can be silently replaced by another tab's draft with no
prompt. Compounds #1.

**Fix:** Track the last-saved spec content and only skip the sync effect when
the incoming `savedDraft` equals the content we just saved:

```tsx
const lastSavedTextRef = useRef<string | null>(null);
// in onSuccess (ok path):
lastSavedTextRef.current = textRef.current;
// in sync effect:
if (savedDraft === lastSavedTextRef.current) {
  lastSavedTextRef.current = null;
  return;
}
```

Or, better, always trust the server: `setText(savedDraft)` ONLY when not dirty,
and surface conflicts when dirty (see #1).

---

### [SEV: P2] #13 — Publish button enabled despite server having rejected the draft on the last save — server re-validates but UX misleads

**Location:** `spec-workspace.tsx:283-289`

```tsx
<DialogTrigger asChild>
  <Button
    className="w-full"
    disabled={dirty || savePending || hasClientErrors}
  >
    Publish
  </Button>
</DialogTrigger>
```

**Problem:** `hasClientErrors` only checks the CLIENT's
`collectOpenApiSpecIssues` result. The server's `result.issues` from the last
`saveDraft`/`publish` call lives in `serverIssues`, which is NOT consulted by
the Publish gate. If the server's validator is stricter than the client's
(which is the exact precondition for #3's infinite loop), the user can have
`dirty=false` (text matches savedDraft, which the server refused to persist —
so actually `dirty` would be `true` here because savedDraft didn't update;
confirmed by reading `convex/specs.ts:52-57` which returns without persisting
on `ok:false`). So in the strict rejection case the Publish button IS disabled
via `dirty`. BUT in the partial case — server returns `ok:true` with WARNING
issues, or the last save was ok but a subsequent server-side state change
(e.g. a referenced catalogue entry was removed) made the draft invalid —
`serverIssues` could contain errors that `hasClientErrors` doesn't reflect,
and Publish would be enabled.

**Verified:** `convex/specs.ts:79-84` returns `ok:true, issues` even when only
warnings are present. So `serverIssues` can contain warnings without an `ok:false`
state. The Publish button then allows clicking, server re-validates and rejects,
user sees a toast. No data integrity issue (server is the gate), but the UX
allows a click the client could have predicted would fail.

**Impact:** Misleading Publish button state. Server catches it, so not a
correctness issue, but the user wastes a round-trip and gets a confusing
"Publish failed — check issues" toast when the rail already showed the issue.

**Fix:** Gate Publish on `mergedIssues` (or at least `serverIssues`) containing
no errors:

```tsx
disabled={dirty || savePending || hasClientErrors ||
  serverIssues.some((i) => i.level === "error")}
```

---

### [SEV: P3] #14 — `textRef.current = text` mutated during render

**Location:** `spec-workspace.tsx:131-132`

```tsx
const textRef = useRef(text);
textRef.current = text;        // ← side effect during render
```

**Problem:** Mutating a ref during render is a React anti-pattern. Under
Strict Mode (dev) and concurrent rendering, the component may render twice or
be discarded, and the ref write is not guarded. The pattern works in practice
for "latest value" refs but the canonical form is a layout effect or an effect.

**Impact:** Functionally fine today; brittle under future React versions or
Strict Mode double-render quirks.

**Fix:**

```tsx
const textRef = useRef(text);
useEffect(() => { textRef.current = text; }, [text]);
```

---

### [SEV: P3] #15 — `defaultNextVersion` silently drops 4-part versions and ignores prerelease semantics

**Location:** `spec-workspace.tsx:53-73`

```tsx
const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
```

**Problem:** The regex matches the first three numeric segments and ignores
the rest. For a prerelease like `1.0.0-rc.1` it returns `1.0.1` (increments
patch past a prerelease — semver says prereleases of the same `1.0.0` should
compare BEFORE the release, so the next version should often be `1.0.0` itself
if unreleased, or `1.1.0` etc.). For a 4-part `1.2.3.4` it returns `1.2.4`,
silently dropping the `.4`. The "best" selection also uses naive tuple
comparison, so `1.0.0-alpha` and `1.0.0` both parse to `[1,0,0]` and the
first-seen wins — order-dependent.

**Impact:** Suggested next version is occasionally wrong for prerelease or
non-standard version strings. User can override in the input, so impact is
limited to mild surprise.

**Fix:** Use a real semver comparison (`semver` npm package or
`compareVersions`), or at minimum anchor the regex with `$` and reject
non-triple versions explicitly.

---

### [SEV: P3] #16 — `mergeIssues` dedup by `level|path|message` collapses distinct issues that differ only by line number

**Location:** `spec-workspace.tsx:82-92`

```tsx
const key = (i: SpecIssue) => `${i.level}|${i.path}|${i.message}`;
```

**Problem:** If two server issues share `level`, `path`, and `message` but
refer to different occurrences (e.g. two identical validation problems at
different lines within the same path), the second is dropped. The `SpecIssue`
type doesn't carry a line number, so this is currently unavoidable with the
type as-is, but the dedup is lossy.

**Impact:** User sees N-1 issues when there are N. Minor.

**Fix:** If the type gains a `line`/`range` field, include it in the key. Or
don't dedup server issues (only dedup client-vs-server overlap).

---

### [SEV: P3] #17 — No `Cmd/Ctrl+S` keyboard shortcut for Save

**Location:** `spec-workspace.tsx` — no `keydown` listener anywhere.

**Problem:** A spec editor is exactly the kind of component users
muscle-memory `Cmd+S` on. The only save paths are the 2s autosave and the
"Save draft" button. A `Cmd+S` would also help mitigate #2 (nav-away loss) by
giving the user a fast explicit save.

**Impact:** Minor UX gap; users who instinctively `Cmd+S` get the browser
save-dialog (or nothing in modern browsers) instead of a draft save.

**Fix:** Add a `useEffect` that listens for `keydown` `Cmd/Ctrl+S`,
`preventDefault()`, and calls `saveDraft(text)` when not disabled.

---

### [SEV: P3] #18 — `VersionDialog` `DiffView` uses index `key={i}` — fine here but fragile

**Location:** `version-dialog.tsx:159`

```tsx
{lines.map((line, i) => {
  …
  return (
    <div key={i} …>
```

**Problem:** Index keys are fine for a purely positional static list (which
`DiffLine[]` is), but if `DiffView` ever gains interactive children (collapse,
copy-line, etc.) the index keys will break state preservation on reorder. Low
risk today.

**Impact:** Negligible now; latent footgun.

**Fix:** Use `${line.type}:${i}` or a content hash if interactivity is added.

---

### [SEV: P3] #19 — `JsonCodeEditor` is not memoized — re-renders on every parent render (1Hz from #8)

**Location:** `json-code-editor.tsx:80-121` (no `React.memo`)

**Problem:** The component takes `value`, `onChange`, `placeholder`,
`className`, `readOnly`, `editorRef` — all stable-or-string props in practice.
Without `React.memo`, every parent re-render (including the 1Hz `now` tick
from #8) reconciles this component. `@uiw/react-codemirror` does internal
diffing so the CodeMirror instance isn't recreated, but the React reconciliation
cost is non-trivial for a 14KB subtree.

**Impact:** Compounds #8's perf cost.

**Fix:** Wrap `JsonCodeEditor` in `React.memo` (props are stable). Better:
solve #8 so the parent stops re-rendering every second.

---

### [SEV: P3] #20 — `SpecRailEndpoints` `pendingEdits` / `pendingKeys` refs never pruned of deleted-endpoint keys

**Location:** `spec-rail.tsx:54-55`, `spec-rail.tsx:124-170`

```tsx
const pendingEdits = useRef<Map<string, PricingEdit>>(new Map());
const pendingKeys = useRef<Set<string>>(new Set());
```

**Problem:** When a user deletes an endpoint from the spec (path removed or
method changed), the `values` map drops that key via the resync effect, but
`pendingEdits` and `pendingKeys` are only cleared by the flush timer (which
fires after `PRICING_DEBOUNCE_MS`). If the endpoint is deleted AND the
component unmounts before the timer fires (or if the timer is cleared on
unmount via the cleanup on line 88-90), the refs leak. Within a single mount,
deleted-endpoint keys accumulate until the next flush. Not a real memory leak
within a session (flush clears them), but if the debounce is somehow never
flushed (e.g. continuous editing), the maps grow.

**Impact:** Negligible in practice; latent.

**Fix:** Prune keys not present in `endpoints` during the resync effect.

---

### [SEV: P3] #21 — `<Input id="semver">` has no client-side semver validation — any non-empty string is submitted

**Location:** `spec-workspace.tsx:296-304`

```tsx
<Input
  id="semver"
  value={version}
  onChange={(e) => setVersion(e.target.value)}
  placeholder="0.1.0"
  className="font-mono"
  disabled={publishPending}
/>
…
<Button
  onClick={() => publish()}
  disabled={publishPending || version.trim() === ""}
>
```

**Problem:** The Publish button only checks `version.trim() === ""`. The user
can type `1.2`, `abc`, `v1.0.0`, `latest` and submit. Server re-validates
(`convex/specs.ts:106-157` returns `ok:false` for non-unique or non-semver
versions) but the client gives no live feedback.

**Impact:** Wasted round-trip; mild UX gap.

**Fix:** Validate semver client-side (`/^\\d+\\.\\d+\\.\\d+(-[\\w.]+)?$/`) and
show an inline error; disable Publish on invalid.

---

### [SEV: P3] #22 — Autosave status `<span>` has no `aria-live` — screen readers don't announce save state changes

**Location:** `spec-workspace.tsx:269-271`

```tsx
<span className="text-xs text-muted-foreground">
  {status.label}
</span>
```

**Problem:** The status transitions `unsaved → saving… → saved 3s ago`. None
of these are announced to assistive technology. A screen-reader user editing a
spec has no non-visual signal that their draft was saved.

**Impact:** A11y gap; minor.

**Fix:** Add `role="status"` and `aria-live="polite"` to the span.

---

### [SEV: P3] #23 — `lintSource` confusingly lints stale `lintDoc` when it differs from the live doc

**Location:** `json-code-editor.tsx:55-62`

```tsx
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

**Problem:** When the live `view.state.doc` differs from the debounced
`lintDoc` (i.e. during the 300ms debounce window), the linter lints `lintDoc`
(stale) rather than the live doc. The intent is presumably "don't lint
partial input" but the effect is: lint markers lag the user's typing by
~300ms AND are computed against a snapshot that may no longer match what's on
screen. Also the `lintDoc === ""` branch falls through to linting live text
(empty), so the empty-doc case lints live — inconsistent with the non-empty
case.

**Impact:** Lint markers lag typing; minor confusion when markers refer to
text the user has already moved past.

**Fix:** Just lint `view.state.doc.toString()` directly; CodeMirror's `linter`
already accepts a `delay` option (passed as `LINT_DEBOUNCE_MS` on line 73) so
the debounce is handled. Drop the `lintDoc` state entirely.

---

### [SEV: P3] #24 — `Save draft` button's `text.trim() !== ""` check is redundant

**Location:** `spec-workspace.tsx:251-258`

```tsx
<Button
  variant="outline"
  disabled={
    !dirty ||
    savePending ||
    (hasClientErrors && text.trim() !== "")
  }
  onClick={() => saveDraft(text)}
>
```

**Problem:** `hasClientErrors` is `clientErrors.length > 0`, and `clientIssues`
is `[]` when `text.trim() === ""` (see `spec-workspace.tsx:115-117`). So
`hasClientErrors` already implies `text.trim() !== ""`. The `&& text.trim()
!== ""` is dead code.

**Impact:** Confusing; future reader wonders why the empty case is special.

**Fix:** Drop the redundant check: `disabled={!dirty || savePending ||
hasClientErrors}`.

---

### [SEV: P3] #25 — Manual "Save draft" click + pending autosave timer fires two mutations → double toast

**Location:** `spec-workspace.tsx:210-222` + `spec-workspace.tsx:248-260`

**Problem:** If the user clicks "Save draft" while the autosave `setTimeout`
is pending, both fire `saveDraft(text)`. `useMutation`'s `mutate` does not
dedup concurrent calls — two mutations run, two `onSuccess` callbacks fire,
two "Draft saved" toasts appear, and `skipRemoteSync` is set twice (harmless
on the second set since it's already true, but the second invalidation runs
unnecessarily). Convex's `saveDraft` is idempotent (overwrite), so no data
issue, just UX noise + wasted work.

**Impact:** Double toast; double backend write.

**Fix:** Clear the autosave timer when the manual save fires, or guard with a
`savePending` check before the button's `saveDraft(text)` call (the button is
already disabled when `savePending`, so this only fires if the user clicks in
the ~0ms window before `savePending` flips — extremely rare, hence P3).

---

## Summary

- **P0:** 0
- **P1:** 3 (multi-tab clobber; no nav guard; server-rejected autosave loop)
- **P2:** 10 (version-dialog diff baseline; cross-tab publish TOCTOU; stale
  serverIssues; hardcoded `#ef4444` + false docstring; 1Hz re-render; per-keystroke
  YAML convert; whole-doc lint highlighting; endpoints via effect not memo;
  skipRemoteSync race; publish ignores serverIssues)
- **P3:** 12 (ref-during-render; semver regex; mergeIssues dedup; no Cmd+S;
  index keys; JsonCodeEditor not memoized; pendingEdits leak; no semver
  validation; no aria-live; lintSource stale; redundant Save check; double-save
  toast)
- **Total:** 25 findings

**Top 3 to fix before ship:**

1. **P1 #1 + P1 #12 together** — Rewrite the remote-sync effect to never
   `setText(savedDraft)` when the local buffer is dirty; track the
   last-saved content rather than a boolean `skipRemoteSync` flag; surface a
   conflict UI when a remote push arrives during local edits. This kills the
   multi-tab data-loss path AND the race in one stroke.
2. **P1 #3** — Add a "don't resubmit identical text" guard plus a consecutive-
   failure circuit breaker and a sticky "save failed — retry" banner instead
   of repeated toasts. Stops the infinite retry loop and backend load.
3. **P1 #2** — Add `useBlocker` + `beforeunload` gated on `dirty &&
   !savePending`. Cheapest fix, highest coverage for the nav-away loss path.

**Verified-against-backend notes:**
- `convex/specs.ts:30-84` `saveDraft` does NOT persist on `ok:false` (returns
  `lastSavedAt:0`), confirming the autosave retry loop in #3.
- `convex/specs.ts:79-84` returns `ok:true` with warnings, confirming #13's
  server-can-have-issues-while-ok-true path.
- `convex/specs.ts:96-194` `publish` re-validates server-side, so #13 is a UX
  issue not a correctness issue.
- `apps/web/src/lib/spec-pricing.ts:12-15` `summarizeDraftPricing("")` returns
  a valid object (not null), so the "Invalid JSON" badge only shows for
  genuinely unparseable JSON — that prior-review hypothesis is NOT a bug;
  not counted above.
- Route caller `routes/app/projects/$projectSlug/spec.tsx:115-118` confirms
  `savedDraft` is a live Convex subscription, confirming the realtime-clobber
  path in #1.
