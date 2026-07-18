# Tiger Review — `apps/web/src/routes/app/projects/$projectSlug/spec.tsx` + spec-editor surface

## Verdict

**Incorrect.** Multiple data-loss and security defects across the autosave, concurrent-edit, and import paths. The autosave loop on server-rejected drafts and the cross-tab clobber both silently destroy user input.

## File Stats

| File | LOC | Status |
|---|---|---|
| `apps/web/src/routes/app/projects/$projectSlug/spec.tsx` | 194 | OK (thin shell) |
| `apps/web/src/components/spec-editor/spec-workspace.tsx` | 473 | Buggy |
| `apps/web/src/components/spec-editor/spec-rail.tsx` | 685 | Buggy |
| `apps/web/src/components/spec-editor/version-dialog.tsx` | ~190 | OK |
| `apps/web/src/components/spec-editor/editor-toolbar.tsx` | 170 | Buggy |
| `apps/web/src/components/spec-editor/json-code-editor.tsx` | ~120 | Minor |
| `apps/web/src/lib/spec-save-status.ts` | ~60 | OK |
| `apps/web/src/lib/spec-import.ts` | ~90 | Buggy |

---

## Findings

### [SEV: P1] Concurrent-edit race: server-pushed draft clobbers unsaved local edits in another tab

**Location:** `apps/web/src/components/spec-editor/spec-workspace.tsx:135-142`

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

**Problem:** `getDraft` is a Convex realtime subscription. When Tab A autosaves, Tab B's `savedDraft` prop updates and this effect unconditionally calls `setText(savedDraft)` — the only escape hatch is `skipRemoteSync`, which is set exclusively by *this tab's own* `saveDraft.onSuccess`. So if Tab B has unsaved keystrokes (`dirty === true`) when Tab A's save lands, Tab B's local `text` is overwritten with Tab A's draft with no prompt, no merge, no diff. The unsaved edits are gone and the autosave timer (which would have persisted them) is now armed against the foreign text.

**Impact:** Silent data loss in any multi-tab / multi-device editing session — exactly the scenario the realtime subscription invites.

**Fix:** Guard the remote-sync against dirty local state. Either block the clobber when `textRef.current !== savedDraft` (old) and surface a conflict banner, or (cheaper) only resync when the editor is clean:

```ts
useEffect(() => {
  if (skipRemoteSync.current) {
    skipRemoteSync.current = false;
    return;
  }
  // Don't blow away unsaved local edits when the server pushes a newer draft.
  if (textRef.current !== savedDraft && textRef.current !== "") {
    setConflict({ remote: savedDraft, local: textRef.current });
    return;
  }
  setText(savedDraft);
  setLastSavedAt(initialLastSavedAt);
}, [savedDraft, initialLastSavedAt]);
```

---

### [SEV: P1] Unsaved changes lost on in-app navigation and tab close

**Location:** `apps/web/src/components/spec-editor/spec-workspace.tsx` (entire component — no `useBlocker`, no `beforeunload`)

```tsx
// Autosave: 2s after last keystroke; never with client errors.
useEffect(() => {
  if (!dirty || hasClientErrors || savePending) return;
  const handle = setTimeout(() => {
    ...
    saveDraft(current);
  }, AUTOSAVE_MS);
  return () => clearTimeout(handle);
}, [text, dirty, hasClientErrors, savePending, savedDraft, saveDraft]);
```

**Problem:** The 2-second autosave window is the only thing between the user's keystrokes and persistence. There is no `beforeunload` handler and no TanStack Router `useBlocker`. The component itself embeds an in-app `<Link to="/app/projects/$projectSlug" …>Add one in Settings</Link>` inside `publishSlot`. Clicking it unmounts `SpecWorkspace`, the cleanup clears the pending autosave timer, and any edits typed in the last <2s vanish. Same for any left-nav route change, browser back, refresh, or tab close. The "Save draft before publishing" hint only covers the Publish button — nothing guards navigation.

**Impact:** Any navigation faster than `AUTOSAVE_MS` (2s) loses work. The Settings link is rendered inside the same component that holds the unsaved state.

**Fix:** Add a `useBlocker` keyed on `dirty && !savePending` (TanStack Router) plus a `beforeunload` listener that flips on while dirty. On block, prompt to "Save / Discard / Stay"; on Save, await `saveDraft(text)` then release.

---

### [SEV: P1] SSRF in `fetchSpecFromUrl` — server fn fetches arbitrary user-supplied http(s) URLs with no internal-network blocklist

**Location:** `apps/web/src/lib/spec-import.ts:48-90`

```ts
response = await fetch(data.url, {
  method: "GET",
  redirect: "follow",
  headers: { Accept: "application/json, application/yaml, text/yaml, text/plain, */*" },
});
...
const buf = await response.arrayBuffer();
...
const text = new TextDecoder("utf-8").decode(buf);
...
return { text, contentType };
```

**Problem:** The only validation is `http:`/`https:` protocol. There is no blocklist for loopback / link-local / RFC1918 ranges, no DNS-rebinding pinning, and `redirect: "follow"` will happily chase 3xx hops into internal addresses. A signed-in user (any org member) can pass `http://169.254.169.254/latest/meta-data/iam/security-credentials/…`, `http://localhost:3001/admin`, `http://10.0.0.4:6379/…` etc., and the response body is returned verbatim to the client toast/editor. The 2MB cap and `response.ok` check do nothing to prevent exfiltration of small, high-value payloads (IMDS credentials, internal health endpoints, Redis INFO).

**Impact:** Authenticated SSRF with response-body read against the worker host's network — sufficient to leak cloud IAM credentials in any non-trivial deployment.

**Fix:** Resolve the host client-side-deny list before fetching; pin the resolved IP and disable redirects (or re-validate each hop). A minimum viable guard:

```ts
const u = new URL(data.url);
const host = u.hostname.toLowerCase();
if (
  host === "localhost" ||
  host.endsWith(".localhost") ||
  /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1$|fe80:)/.test(host)
) {
  throw new Error("URLs pointing to private networks are not allowed");
}
// fetch with redirect: "manual" and reject any 3xx whose Location host is private.
```

Also see the related P3 (no fetch timeout) below.

---

### [SEV: P2] Autosave loops every 2s on server-rejected drafts — toast spam + wasted mutations

**Location:** `apps/web/src/components/spec-editor/spec-workspace.tsx:271-285` and `:191-202`

```ts
// Autosave: 2s after last keystroke; never with client errors.
useEffect(() => {
  if (!dirty || hasClientErrors || savePending) return;
  ...
  if (current.trim() !== "") {
    const issues = collectOpenApiSpecIssues(current);
    if (issues.some((i) => i.level === "error")) return;
  }
  saveDraft(current);
}, [text, dirty, hasClientErrors, savePending, savedDraft, saveDraft]);
```

```ts
onSuccess: async (result) => {
  setServerIssues(result.issues);
  if (!result.ok) {
    toast.error("Draft has errors — fix issues before saving");
    return;
  }
  ...
},
```

**Problem:** The autosave gate only consults `hasClientErrors` (client-side `collectOpenApiSpecIssues` errors). When the server rejects a draft the client thinks is clean (`result.ok === false`), `onSuccess` sets `serverIssues` and toasts — but does not clear `dirty` (nothing was saved), does not set `skipRemoteSync`, and `serverIssues` is not in the autosave effect's dependency list or guard. So 2s later the effect fires again against the same text, calls `saveDraft` again, the server rejects again, and another `toast.error("Draft has errors — fix issues before saving")` fires. This continues every 2s until the user edits the text or navigates away.

**Impact:** Toast spam and a steady drumbeat of failing mutations whenever the server's validator is stricter than the client's (a very common case — e.g. server enforces unique operationIds, schema `$ref` resolution, or pricing limits the client doesn't check).

**Fix:** Gate autosave on server errors too, and suppress the toast on autosave-triggered rejections:

```ts
const hasErrors = hasClientErrors || serverIssues.some((i) => i.level === "error");
useEffect(() => {
  if (!dirty || hasErrors || savePending) return;
  ...
}, [text, dirty, hasErrors, savePending, savedDraft, saveDraft]);

// and in onSuccess when !result.ok, only toast if the save was user-initiated
// (pass a flag through the mutation variables) — not for autosave retries.
```

---

### [SEV: P2] File import has no size cap — unbounded `file.text()` can freeze the tab

**Location:** `apps/web/src/components/spec-editor/editor-toolbar.tsx:39-49`

```ts
async function onFileChange(fileList: FileList | null) {
  const file = fileList?.[0];
  if (!file) return;
  try {
    const raw = await file.text();
    applyImportedRaw(raw);
  } catch (err) {
    toast.error(humanError(err, "Could not read file"));
  } finally {
    if (fileRef.current) fileRef.current.value = "";
  }
}
```

**Problem:** The URL import path enforces `MAX_SPEC_IMPORT_BYTES = 2 * 1024 * 1024`, but the file picker reads `file.text()` with no size check. A 100 MB file is slurped into a JS string, handed to `convertSpecInputToJson` → `JSON.parse`, and then loaded into CodeMirror. The parse alone can lock the main thread for seconds; the editor will then try to lint and diff a 100 MB document on every keystroke.

**Impact:** Easy client-side DoS (self-inflicted or via a shared project). The asymmetry with the URL path (2 MB cap) shows this was intended to be bounded.

**Fix:** Check `file.size` before reading:

```ts
if (file.size > MAX_SPEC_IMPORT_BYTES) {
  toast.error("Spec is larger than 2MB");
  return;
}
const raw = await file.text();
```

(import `MAX_SPEC_IMPORT_BYTES` from `#/lib/spec-import`.)

---

### [SEV: P2] Deprecate/Undeprecate `busy` state is mis-targeted when the user switches version rows mid-flight

**Location:** `apps/web/src/components/spec-editor/spec-rail.tsx:402-405`

```tsx
busy={
  (deprecating && deprecateTarget?._id === v._id) ||
  (undeprecating && undeprecateTarget?._id === v._id)
}
```

**Problem:** `busy` keys off the *current* `deprecateTarget`/`undeprecateTarget`, but those targets are mutable shared state. The dropdown triggers on other `VersionRow`s are **not** disabled while a deprecate is in flight (only the targeted row is — and only while the target pointer still points at it). The user can click another row's "Deprecate…" while the first mutation is pending. `setDeprecateTarget(newRow)` then (a) repoints the still-open `DeprecateDialog` to the new row, (b) clears `busy` on the row whose mutation is actually still running, and (c) sets `busy` on the new row whose mutation hasn't started. The `DeprecateDialog`'s `onOpenChange` guard (`if (!open && !pending)`) traps the user in the dialog pointed at the wrong row until the first mutation settles. The `useEffect` that resets `sunsetDate`/`message` on `target` change also discards any message the user had typed for the original target.

**Impact:** Wrong row shows the spinner, the dialog shows the wrong version, and the user can "confirm" a deprecate for a row whose form was never filled in. Confusing at best; wrong-version deprecate at worst.

**Fix:** Track the in-flight target id separately from the dialog target, and disable all `DropdownMenuTrigger`s while any deprecate/undeprecate is pending:

```ts
const [pendingId, setPendingId] = useState<string | null>(null);
// confirmDeprecate sets pendingId = input.versionId before mutate, clears in onSuccess/onError
// busy = pendingId === v._id
// and gate onDeprecate/onUndeprecate handlers when pendingId !== null
```

---

### [SEV: P3] Publish dialog's inner "Publish" button is not disabled when the editor goes dirty after the dialog opens

**Location:** `apps/web/src/components/spec-editor/spec-workspace.tsx` — `publishSlot` Dialog (around the `<Dialog open={publishOpen} …>` block) vs. the trigger's `disabled={dirty || savePending || hasClientErrors}`

```tsx
<DialogTrigger asChild>
  <Button disabled={dirty || savePending || hasClientErrors}>Publish</Button>
</DialogTrigger>
...
<DialogContent>
  ...
  <Button
    onClick={() => publish()}
    disabled={publishPending || version.trim() === ""}
  >
    {publishPending ? "Publishing…" : "Publish"}
  </Button>
</DialogContent>
```

**Problem:** The trigger is dirty-aware, but the in-dialog Publish button is not. Once the dialog is open, the user can type into the editor (the dialog is non-modal-over-the-editor in practice — the editor remains interactive), making `dirty === true` while the dialog is still open. Clicking the inner Publish button then calls `publish()`, which snapshots the **saved** draft — silently excluding the just-typed edits from the published version. The only signal is the "Save draft before publishing" paragraph, which lives in the Versions card, *not* in the dialog the user is looking at.

**Impact:** User publishes a version that doesn't include their latest edits and doesn't realize it. Not data loss (the edits remain in the draft) but a confusing publish语义.

**Fix:** Mirror the dirty gate onto the in-dialog button: `disabled={publishPending || version.trim() === "" || dirty || savePending || hasClientErrors}`, and surface an inline note inside the dialog when dirty.

---

### [SEV: P3] All CodeMirror lint diagnostics span the entire document

**Location:** `apps/web/src/components/spec-editor/json-code-editor.tsx:31-40`

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

**Problem:** Every diagnostic is anchored to `[0, end]` — the whole document. With N issues, the entire editor is underlined N times and every squiggle tooltip shows on hover over any character. The `issue.path` (e.g. `paths./users.get.parameters[0].schema`) is never used to compute a real `from`/`to` into the doc, even though that's the whole point of `path`. The lint gutter ends up showing N identical full-document spans.

**Impact:** Lint underlines are useless for locating the error; users must read the path string from the tooltip. Functional but defeats the purpose of inline linting.

**Fix:** Resolve `issue.path` to a JSON Pointer into the doc and compute a real `from`/`to` (even a coarse line-based range), or at minimum anchor each diagnostic to a distinct line derived from the path segments.

---

### [SEV: P3] `fetchSpecFromUrl` has no timeout — a slow / hanging upstream stalls the server fn indefinitely

**Location:** `apps/web/src/lib/spec-import.ts:55-70`

```ts
response = await fetch(data.url, { method: "GET", redirect: "follow", ... });
...
const buf = await response.arrayBuffer();
```

**Problem:** No `AbortController` / `AbortSignal.timeout(...)`. A URL that accepts the connection but never closes the body (or drips bytes) holds the server fn — and the user's "Fetching…" spinner — open with no upper bound. Combined with the SSRF above, this also makes the server fn an amplifier for slow-loris-style upstreams.

**Impact:** UI stuck on "Fetching…" indefinitely; server connection held.

**Fix:** `fetch(data.url, { ..., signal: AbortSignal.timeout(10_000) })` and map the `TimeoutError` to a user-facing message.

---

### [SEV: P3] Duplicate-save race when `getDraft` refetch is slow

**Location:** `apps/web/src/components/spec-editor/spec-workspace.tsx:204-213` + `:271-285`

**Problem:** On `saveDraft.onSuccess`, `skipRemoteSync.current = true` is set and `getDraft` is invalidated. The autosave effect re-runs as soon as `savePending` flips false (its dependency). In the window before the refetch lands and updates `savedDraft`, `dirty` is still `true` (because `savedDraft` still holds the pre-save value), `hasClientErrors` is false, `savePending` is false — so the effect arms a fresh 2s timer. If the refetch takes longer than 2s, `textRef.current === savedDraft` is still false (stale prop), the `collectOpenApiSpecIssues` check passes, and `saveDraft` fires again with identical content. Idempotent on the server, but it's a redundant mutation and a second `toast.success("Draft saved")`.

**Impact:** Minor — duplicate toast and an extra mutation under slow networks.

**Fix:** Clear `dirty` optimistically in `onSuccess` (e.g. track a local `savedText` ref equal to `textRef.current` at save time, and have the autosave effect compare against that ref rather than the prop until the refetch lands), or extend `skipRemoteSync` to cover the refetch window.

---

## Summary

- **9 findings:** 0 P0, 3 P1, 3 P2, 3 P3.
- **Top 3:**
  1. **P1 — Concurrent-edit race clobbers unsaved edits** (`spec-workspace.tsx:135-142`). The realtime subscription + unconditional `setText(savedDraft)` is a footgun. Needs a dirty-guard / conflict surface.
  2. **P1 — No unsaved-changes guard on navigation or tab close** (`spec-workspace.tsx`). The in-component Settings link unmounts the workspace inside the 2s autosave window. Needs `useBlocker` + `beforeunload`.
  3. **P1 — SSRF in `fetchSpecFromUrl`** (`spec-import.ts:55-70`). Authenticated users can read internal network services / cloud metadata via the server-side fetch. Needs a private-range blocklist and `redirect: "manual"`.

**Cross-cutting note:** The autosave/server-issue interaction (#4) and the missing navigation guard (#2) compound — a server-rejected draft keeps the editor dirty, which is exactly the state that gets clobbered by both cross-tab updates (#1) and navigation. Fixing the dirty-guard on the remote-sync effect is the highest-leverage change.

No raw Tailwind colors, no hardcoded `duration-300 ease-in-out` (all motion uses `--dur-*` / `--ease` vars), no `isLoading` misuse (all `isPending`), no missing skeletons on this route — the issues are behavioral, not stylistic.
