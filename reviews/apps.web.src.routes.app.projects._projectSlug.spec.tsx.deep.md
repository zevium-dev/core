# Tiger Deep Review — `apps/web/src/routes/app/projects/$projectSlug/spec.tsx` + spec-editor surface

**Scope:** the route shell + `spec-workspace.tsx`, `spec-rail.tsx`, `version-dialog.tsx`, `editor-toolbar.tsx`, `json-code-editor.tsx`, `lib/spec-save-status.ts`, `lib/spec-import.ts`. Backend cross-checked against `convex/specs.ts` (`saveDraft`, `publish`, `deprecateVersion`, `undeprecateVersion`, `getVersion`, `getDraft`, `listVersions`) to verify client/server contracts.

**Prior review (`.md` sibling)** found 3 P1 + 3 P2 + 3 P3. This deep pass **confirms all 9** and **expands to 20 findings** (1 P0, 3 P1, 8 P2, 8 P3), including a severity escalation on the SSRF and three new data-loss / UX defects not previously flagged.

---

## Verdict

**Incorrect / insecure.** The autosave surface has two genuine data-loss vectors (empty-draft wipe + cross-tab clobber), the URL import is an authenticated SSRF with full response-body exfiltration that can reach cloud metadata, and the validation rail silently lies about fixed issues. The route shell, skeletons, motion tokens, and color tokens are clean — the defects are all behavioral.

---

## File Stats

| File | LOC | Status |
|---|---|---|
| `apps/web/src/routes/app/projects/$projectSlug/spec.tsx` | 194 | OK (thin shell, correct loader/skeleton split) |
| `apps/web/src/components/spec-editor/spec-workspace.tsx` | 473 | Buggy (autosave, clobber, stale issues, perf) |
| `apps/web/src/components/spec-editor/spec-rail.tsx` | 685 | Buggy (busy mis-target, dialog races) |
| `apps/web/src/components/spec-editor/version-dialog.tsx` | 190 | Minor (animation cut, diff mismatch) |
| `apps/web/src/components/spec-editor/editor-toolbar.tsx` | 170 | Buggy (unbounded file import, no replace-confirm) |
| `apps/web/src/components/spec-editor/json-code-editor.tsx` | 121 | Minor (lint spans whole doc) |
| `apps/web/src/lib/spec-save-status.ts` | 60 | OK |
| `apps/web/src/lib/spec-import.ts` | 91 | Insecure (SSRF, no timeout, late body cap) |

---

## Findings

### [SEV: P0] Authenticated SSRF with response-body exfiltration in `fetchSpecFromUrl` (escalated from prior P1)

**Location:** `apps/web/src/lib/spec-import.ts:42-90`

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

**Problem:** `importSpecUrlSchema` only checks `http:`/`https:`. There is **no** loopback / link-local / RFC1918 / cloud-metadata host blocklist, **no** DNS-rebinding pinning, and `redirect: "follow"` chases every 3xx hop — so an attacker URL can redirect into `http://169.254.169.254/latest/meta-data/iam/security-credentials/<role>/` (AWS IMDSv1), `http://localhost:3001/admin`, `http://10.0.0.4:6379/INFO`, `http://[::1]/…`, or the GCP/Azure metadata endpoints (`169.254.169.254`, `metadata.google.internal`). The full response body is decoded and returned to the calling client, then rendered into the editor / toast.

The 2 MB cap and `response.ok` check do nothing — IMDS credential documents are a few KB and return HTTP 200. `createServerFn` runs on the TanStack Start web host (not the Cloudflare data plane), so it can reach whatever the web server can reach: its own Vite internals, the Convex HTTP endpoint, internal admin surfaces, the metadata service in cloud deployments.

This is reachable by **any signed-in Clerk user with any org membership** — `parseImportSpecUrl` does no project-scoped auth, and `fetchSpecFromUrl` itself does no auth at all (no `getProjectMember` check; it is not even a `createServerFn` that validates a project context).

**Impact:** Authenticated SSRF with arbitrary response-body read against the worker host's network. In any AWS/GCP/Azure deployment this leaks short-lived IAM credentials → privilege escalation / lateral movement. This is a textbook blocker; the prior review's P1 rating under-weights the credential-exfiltration outcome.

**Fix:** Resolve and deny private ranges before fetching, pin the resolved IP against re-binding, and use `redirect: "manual"` re-validating each `Location` hop:

```ts
const u = new URL(data.url);
const host = u.hostname.toLowerCase();
if (
  host === "localhost" || host.endsWith(".localhost") ||
  /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
  host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")
) {
  throw new Error("URLs pointing to private networks are not allowed");
}
// fetch with redirect: "manual"; for each 3xx, re-resolve Location and re-check.
```

Also drop `redirect: "follow"` and add an `AbortSignal.timeout(10_000)` (see P2 #11).

---

### [SEV: P1] Autosave persists empty draft — clearing the editor wipes the saved draft

**Location:** `apps/web/src/components/spec-editor/spec-workspace.tsx:271-285` + `convex/specs.ts:42-46`

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
    saveDraft(current);   // ← fires even when current.trim() === ""
  }, AUTOSAVE_MS);
  return () => clearTimeout(handle);
}, [text, dirty, hasClientErrors, savePending, savedDraft, saveDraft]);
```

Backend (`convex/specs.ts:42`):
```ts
const effectiveIssues = args.spec.trim() === "" ? [] : issues;
const hasError = effectiveIssues.some((i) => i.level === "error");
if (hasError) { return { ok: false, ... }; }
...
await ctx.db.patch(existing._id, { draft: args.spec, lastSavedAt: now });
```

**Problem:** The autosave timer's error-check is *inside* `if (current.trim() !== "")` — so when the editor is empty, the guard is skipped entirely and `saveDraft("")` is called. The server explicitly allows empty drafts (`effectiveIssues = []` when `spec.trim() === ""`), so the patch succeeds and **overwrites the saved draft with an empty string**. `skipRemoteSync` is then set in `onSuccess`, `lastSavedAt` updates, the query invalidates, and `savedDraft` becomes `""`.

Reproduction: user selects-all + delete (or `Cmd-A` + Backspace) to clear the editor while reorganizing, pauses 2 seconds, and the entire saved spec is gone — both locally and on the server. No undo, no confirm, no tombstone. The rail then shows "No endpoints yet" and the publish button is disabled (no draft to snapshot). The user has to know to hit the browser's restore-last-version dialog to recover.

**Impact:** Silent, irreversible data loss from a routine editing gesture (select-all + delete + pause). The empty-draft-allowed server semantics were intended for "clear editor to start fresh" but the autosave turns them into a footgun.

**Fix:** Either (a) never autosave an empty draft (treat empty as a deliberate clear that requires an explicit "Clear draft" button), or (b) gate the autosave against empty text:

```ts
if (current.trim() === "") return;           // don't autosave empty drafts
if (current === savedDraft) return;
const issues = collectOpenApiSpecIssues(current);
if (issues.some((i) => i.level === "error")) return;
saveDraft(current);
```

And if clearing is a supported action, give it its own button with a confirm dialog.

---

### [SEV: P1] Concurrent-edit race: realtime draft push clobbers unsaved local edits in another tab

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

**Problem:** `getDraft` is a Convex realtime subscription. When Tab A autosaves, Tab B's `savedDraft` prop updates and this effect unconditionally calls `setText(savedDraft)`. The only escape hatch is `skipRemoteSync`, which is set **exclusively by this tab's own `saveDraft.onSuccess`** — it cannot detect a foreign save. So if Tab B has unsaved keystrokes (`dirty === true`) when Tab A's save lands, Tab B's local `text` is overwritten with Tab A's draft with **no prompt, no merge, no diff**. The unsaved edits are gone and the autosave timer is now armed against the foreign text (so Tab B will also re-persist Tab A's content, locking in the loss).

`skipRemoteSync` is also a **single-shot** flag. If two `savedDraft` updates arrive close together (this tab's own invalidation + a foreign realtime push), the first consumes the flag and the second clobbers. The flag also races against React 18 batching: `onSuccess` sets the ref, then `await invalidateQueries` resolves on a later tick — any `savedDraft` change that arrives between `setText` (user typing) and the invalidation landing will also see `skipRemoteSync === false` and clobber.

**Publish variant of the same race:** the `Publish` button is gated on `!dirty`, but the `publish` mutation snapshots `draftRow.draft` **server-side**. Between the user clicking Publish and the mutation executing, another tab can save a different draft — the publishing user thinks they're snapshotting their own edits but actually snapshots the other tab's content. No conflict detection.

**Impact:** Silent data loss in any multi-tab / multi-device editing session — exactly the scenario the realtime subscription invites. Plus the publish race silently publishes the wrong content.

**Fix:** Guard the remote-sync against dirty local state and surface a conflict:

```ts
useEffect(() => {
  if (skipRemoteSync.current) { skipRemoteSync.current = false; return; }
  if (textRef.current !== savedDraft && textRef.current !== "" && textRef.current !== savedDraft) {
    setConflict({ remote: savedDraft, local: textRef.current });
    return;
  }
  setText(savedDraft);
  setLastSavedAt(initialLastSavedAt);
}, [savedDraft, initialLastSavedAt]);
```

For publish, re-check `dirty` inside `publish()`'s `mutationFn` and reject if the draft has drifted, or pass the expected `savedDraft` hash to the server and have `publish` 409 on mismatch.

---

### [SEV: P1] No `useBlocker` / `beforeunload` guard on unsaved edits

**Location:** `apps/web/src/components/spec-editor/spec-workspace.tsx` (entire component — no router block, no unload listener)

**Problem:** The 2-second autosave window is the only thing between keystrokes and persistence. There is no `beforeunload` handler and no TanStack Router `useBlocker`. The component itself embeds an in-app navigation:

```tsx
<Link to="/app/projects/$projectSlug" params={{ projectSlug }} ...>
  Add one in Settings
</Link>
```

Clicking it unmounts `SpecWorkspace`, the autosave effect cleanup clears the pending timer, and any edits typed in the last <2s vanish. Same for any left-nav route change, browser back, refresh, or tab close. The "Save draft before publishing" hint only covers the Publish button — nothing guards navigation. The restore-to-draft flow in `VersionDialog` (`onRestore={(spec) => setText(spec)}`) makes `text` dirty and then relies on the same 2s window — navigate within that window and the restore is lost too.

**Impact:** Any navigation faster than `AUTOSAVE_MS` (2s) loses work. The Settings link is rendered inside the very component that holds the unsaved state.

**Fix:** Add `useBlocker` keyed on `dirty && !savePending` (TanStack Router) plus a `beforeunload` listener that flips on while dirty. On block, prompt "Save / Discard / Stay"; on Save, `await saveDraft(text)` then release.

---

### [SEV: P2] Autosave loops every 2s on server-rejected drafts — toast spam + wasted mutations

**Location:** `apps/web/src/components/spec-editor/spec-workspace.tsx:271-285` (autosave effect) + `:191-202` (`onSuccess`)

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

```ts
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

**Problem:** The autosave gate consults only `hasClientErrors` (client-side `collectOpenApiSpecIssues`). When the server rejects a draft the client thinks is clean (`result.ok === false`), `onSuccess` sets `serverIssues` and toasts — but does **not** clear `dirty` (nothing was saved), does **not** set `skipRemoteSync`, and `serverIssues` is **not** in the autosave effect's dependency list or guard. So 2s later the effect fires again against the same text, calls `saveDraft` again, the server rejects again, and another `toast.error("Draft has errors — fix issues before saving")` fires. This continues every 2s until the user edits the text or navigates away.

**Impact:** Toast spam and a steady drumbeat of failing mutations whenever the server's validator is stricter than the client's — a very common case (server enforces unique operationIds, `$ref` resolution, pricing limits, or schema constraints the client doesn't check). Also pollutes the Convex mutation log.

**Fix:** Gate autosave on merged errors (client + server) and suppress the toast on autosave-triggered rejections:

```ts
const hasErrors = hasClientErrors || serverIssues.some((i) => i.level === "error");
useEffect(() => {
  if (!dirty || hasErrors || savePending) return;
  ...
}, [text, dirty, hasErrors, savePending, savedDraft, saveDraft]);
```

Pass a `{ source: "auto" | "manual" }` flag through the mutation variables and only toast when `source === "manual"`.

---

### [SEV: P2] Stale server issues persist in the Validation rail after the user fixes them

**Location:** `apps/web/src/components/spec-editor/spec-workspace.tsx:124-160` (`mergeIssues`, `serverIssues` state)

```ts
const mergedIssues = useMemo(
  () => mergeIssues(clientIssues, serverIssues),
  [clientIssues, serverIssues],
);
```

**Problem:** `serverIssues` is set only inside `saveDraft`/`publish` `onSuccess` — it is the issue list from the **last** save attempt. Between saves it is never cleared. So:

1. User saves a draft with an error at `paths./x` → `serverIssues = [paths./x error]`.
2. User edits the spec to fix `paths./x`. Client-side validation now passes (`clientIssues = []`).
3. `mergedIssues` still contains the `paths./x` error from `serverIssues`. The Validation rail still shows it. `deriveSaveStatus` says "saved" (it only consults `hasClientErrors`), so the status pill says "saved" while the rail shows a stale error.

The rail and the status pill disagree. The user can't tell whether the error is real or stale, and there is no way to clear it short of re-saving (which — per the previous finding — may loop if the server still rejects, or may succeed and finally clear it).

**Impact:** The validation surface silently lies. Users either trust the stale error and keep poking at a fixed issue, or learn to ignore the rail entirely (defeating its purpose).

**Fix:** Re-validate against the current text on every render and drop server issues whose `path` no longer produces an error, or clear `serverIssues` whenever `text` changes:

```ts
useEffect(() => { setServerIssues([]); }, [text]);
```

and only show server issues that the client validator also reports (or explicitly mark them as "from last save").

---

### [SEV: P2] Import replaces editor with no unsaved-changes confirmation

**Location:** `apps/web/src/components/spec-editor/editor-toolbar.tsx:30-37` + `apps/web/src/components/spec-editor/spec-workspace.tsx:303-313`

```ts
function applyImportedRaw(raw: string) {
  const converted = convertSpecInputToJson(raw);
  if (!converted.ok) { toast.error(converted.error); return; }
  onApplyText(converted.json);
  ...
}
```

```ts
function applyEditorText(next: string) {
  const converted = convertSpecInputToJson(next);
  if (!converted.ok) { setText(next); return; }
  if (converted.convertedFromYaml) { setText(converted.json); toast.success(...); return; }
  setText(converted.json === next ? next : converted.json);
}
```

**Problem:** `applyImportedRaw` → `onApplyText` → `applyEditorText` unconditionally `setText(...)`. There is **no check** against `dirty` (editor has unsaved edits vs the saved draft) before replacing the editor content. If the user has been editing for 1.9s (autosave hasn't fired yet) and clicks "Import from URL" or "Upload .json" or "Start from template", their in-progress edits are replaced wholesale, and 2s later the autosave persists the imported spec over their draft.

The asymmetry with `VersionDialog` (which *does* prompt "Replace current unsaved draft changes?" via the `confirming` gate when `dirty`) shows this was considered elsewhere and forgotten here.

**Impact:** Silent data loss whenever an import / template action collides with unsaved edits. Compounds with P1 #4 (no nav guard): the import acts as an in-component "navigation" that wipes state without a block.

**Fix:** Pass a `dirty` flag into `EditorToolbar` (or hoist the confirm into `applyEditorText`) and show a confirm dialog when `dirty` before applying:

```ts
function applyEditorText(next: string) {
  if (dirty && !window.confirm("Replace your unsaved edits with this spec?")) return;
  ...
}
```

(Use the shadcn `Dialog` rather than `window.confirm` for visual consistency.)

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

**Problem:** The URL import path enforces `MAX_SPEC_IMPORT_BYTES = 2 * 1024 * 1024`, but the file picker reads `file.text()` with no size check. A 100 MB file is slurped into a JS string, handed to `convertSpecInputToJson` → `JSON.parse` (which is synchronous and blocks the main thread), and the result is then loaded into CodeMirror, which will subsequently lint and re-parse it on every keystroke. The parse alone can lock the main thread for seconds; the editor becomes unusable.

**Impact:** Easy client-side DoS (self-inflicted or via a shared malicious file). The asymmetry with the URL path (2 MB cap) shows this was intended to be bounded.

**Fix:** Check `file.size` before reading:

```ts
import { MAX_SPEC_IMPORT_BYTES } from "#/lib/spec-import";
...
if (file.size > MAX_SPEC_IMPORT_BYTES) {
  toast.error("Spec is larger than 2MB");
  return;
}
const raw = await file.text();
```

---

### [SEV: P2] Deprecate/Undeprecate `busy` state is mis-targeted when the user switches version rows mid-flight

**Location:** `apps/web/src/components/spec-editor/spec-rail.tsx:402-405`

```ts
busy={
  (deprecating && deprecateTarget?._id === v._id) ||
  (undeprecating && undeprecateTarget?._id === v._id)
}
```

**Problem:** `busy` keys off the *current* `deprecateTarget` / `undeprecateTarget`, but those targets are mutable shared state. The dropdown triggers on other `VersionRow`s are **not** disabled while a deprecate is in flight (only the targeted row is — and only while the target pointer still points at it). The user can click another row's "Deprecate…" while the first mutation is pending. `setDeprecateTarget(newRow)` then (a) repoints the still-open `DeprecateDialog` to the new row, (b) clears `busy` on the row whose mutation is actually still running, and (c) sets `busy` on the new row whose mutation hasn't started. The `DeprecateDialog`'s `onOpenChange` guard (`if (!open && !pending)`) traps the user in a dialog pointed at the wrong row until the first mutation settles.

Worse: `setDeprecateTarget(null)` runs in `confirmDeprecate.onSuccess` **before** `deprecating` flips false (React batches the mutation state update), so there is a render where `deprecating === true && deprecateTarget === null` → `busy === false` for **every** row, including the one whose mutation just landed. If the user clicks another row's "Deprecate…" in that window, a second concurrent `confirmDeprecate` fires against a fresh `DeprecateDialog` with an empty form (no sunset date / message), because the reset effect (`setSunsetDate(""); setMessage("")` on `target` change) runs against the new target.

**Impact:** Wrong row shows the spinner; the user can confirm a deprecate for a row whose form was never filled in; concurrent `deprecateVersion` mutations are fired against the same backend (last-write-wins on the `deprecatedAt`/`sunsetAt`/`deprecationMessage` patch).

**Fix:** Track the in-flight target id separately from the dialog target, and disable all `DropdownMenuTrigger`s while any deprecate/undeprecate is pending:

```ts
const [pendingId, setPendingId] = useState<string | null>(null);
// confirmDeprecate: setPendingId(input.versionId) before mutate; clear in finally
// busy = pendingId === v._id
// and gate onDeprecate/onUndeprecate when pendingId !== null
```

---

### [SEV: P2] `fetchSpecFromUrl` has no timeout and reads the full body before the size cap when `content-length` is absent

**Location:** `apps/web/src/lib/spec-import.ts:55-82`

```ts
response = await fetch(data.url, { method: "GET", redirect: "follow", ... });
...
const lengthHeader = response.headers.get("content-length");
if (lengthHeader !== null) {
  const n = Number(lengthHeader);
  if (Number.isFinite(n) && n > MAX_SPEC_IMPORT_BYTES) {
    throw new Error("Spec is larger than 2MB");
  }
}
const buf = await response.arrayBuffer();   // ← reads full body
if (buf.byteLength > MAX_SPEC_IMPORT_BYTES) {
  throw new Error("Spec is larger than 2MB");
}
```

**Problem:** Two defects:
1. No `AbortSignal.timeout(...)` — a slow or hanging upstream stalls the server fn indefinitely, tying up a server connection per request. An attacker can hold N connections open with slow-drip responses.
2. When `content-length` is absent (chunked transfer encoding, which any attacker-controlled server can produce), the `lengthHeader` fast-path is skipped and `response.arrayBuffer()` reads the **entire** body into memory before the byte-length check runs. An attacker can stream a 1 GB body; the server allocates 1 GB before rejecting.

**Impact:** Resource exhaustion on the web host (memory + connection pool). Combined with the SSRF (P0), an attacker can DoS the metadata endpoint fetcher by pointing it at an internal slow responder.

**Fix:** Stream the body with a cap:

```ts
const reader = response.body?.getReader();
let received = 0; const chunks: Uint8Array[] = [];
while (reader) {
  const { done, value } = await reader.read();
  if (done) break;
  received += value.byteLength;
  if (received > MAX_SPEC_IMPORT_BYTES) throw new Error("Spec is larger than 2MB");
  chunks.push(value);
}
```

And wrap the fetch in `AbortSignal.timeout(10_000)`.

---

### [SEV: P2] Per-keystroke triple-parse of the editor text — `collectOpenApiSpecIssues` + `summarizeDraftPricing` + `listSpecEndpoints` all run on every `text` change

**Location:** `apps/web/src/components/spec-editor/spec-workspace.tsx:147-167` + `:271-285`

```ts
const clientIssues = useMemo(() => {
  if (text.trim() === "") return [] as SpecIssue[];
  return collectOpenApiSpecIssues(text);     // parse #1
}, [text]);

const pricing = useMemo(() => summarizeDraftPricing(text), [text]);  // parse #2

useEffect(() => {
  const rows = listSpecEndpoints(text);      // parse #3
  ...
}, [text]);
```

Plus `JsonCodeEditor`'s debounced `collectOpenApiSpecIssues` (parse #4, 300ms lagged) and `onEditorChange`'s `convertSpecInputToJson` for non-`{`/`[`-prefixed text (parse #5, YAML). And the autosave timer's `collectOpenApiSpecIssues(current)` (parse #6, on the 2s fire).

**Problem:** Six parses of the same document across overlapping cycles. For a 1 MB spec, `JSON.parse` alone is ~10-50 ms; five of them per keystroke is 50-250 ms of main-thread work per character, plus CodeMirror's own re-render. The `text` state is also a fresh string per keystroke, so every memo/effect re-runs even when the structural change is trivial.

**Impact:** Visible input lag on large specs (approaching the 2 MB cap). The debounced lint (parse #4) was added to avoid exactly this, but the three synchronous parses on the main render path were left in place.

**Fix:** Parse once into a memoized AST and derive issues / pricing / endpoints from it:

```ts
const parsed = useMemo(() => parseSpecDocument(text), [text]);
const clientIssues = useMemo(() => parsed.issues, [parsed]);
const pricing = useMemo(() => parsed.pricing, [parsed]);
const endpoints = useMemo(() => parsed.endpoints, [parsed]);
```

Move the endpoints into state only if you need the `stale` flag, or derive `stale` from `parsed.ok`.

---

### [SEV: P2] `onEditorChange` YAML-detection heuristic thrashes on flow-style YAML and re-parses on every keystroke for YAML specs

**Location:** `apps/web/src/components/spec-editor/spec-workspace.tsx:316-329`

```ts
function onEditorChange(next: string) {
  if (
    next.trim() !== "" &&
    !next.trimStart().startsWith("{") &&
    !next.trimStart().startsWith("[")
  ) {
    const converted = convertSpecInputToJson(next);
    if (converted.ok && converted.convertedFromYaml) {
      setText(converted.json);
      toast.success("Converted YAML to JSON");
      return;
    }
  }
  setText(next);
}
```

**Problem:** For any YAML spec, every keystroke calls `convertSpecInputToJson(next)` which does `JSON.parse` (throws) then `parseYaml` (full YAML parse). If the YAML is complete enough to parse, the editor replaces the user's text with re-serialized JSON — moving the cursor, reformatting, and firing a toast on every keystroke. The `!startsWith("{" / "[")` guard is meant to skip JSON, but flow-style YAML (`{ openapi: 3.0.0 }`) starts with `{` and is misidentified as JSON; conversely, a JSON doc the user is mid-typing (`{` alone) hits the YAML branch because `JSON.parse("{")` throws and `parseYaml("{")` returns `null` → `convertedFromYaml` false → no conversion, so at least it doesn't thrash there, but the parse cost is still paid.

The comment "Full convert on each keystroke would thrash" acknowledges the problem but the implementation thrashes anyway for the YAML case.

**Impact:** Cursor jumps and toast spam while typing YAML; wasted parse on every keystroke for any non-`{`/`[` document.

**Fix:** Only attempt YAML conversion on paste (use CodeMirror's `paste` extension) or on explicit "Convert YAML" action, not on every `onChange`.

---

### [SEV: P3] Publish dialog's inner "Publish" button is not disabled when the editor goes dirty after the dialog opens

**Location:** `apps/web/src/components/spec-editor/spec-workspace.tsx` — `publishSlot` Dialog

```tsx
<DialogTrigger asChild>
  <Button disabled={dirty || savePending || hasClientErrors}>Publish</Button>
</DialogTrigger>
...
<DialogContent>
  ...
  <Button onClick={() => publish()} disabled={publishPending || version.trim() === ""}>
    {publishPending ? "Publishing…" : "Publish"}
  </Button>
</DialogContent>
```

**Problem:** The trigger is dirty-aware, the in-dialog button is not. The dialog is non-modal over the editor (the editor remains interactive), so the user can type while the dialog is open, making `dirty === true`. Clicking the inner Publish calls `publish()`, which snapshots the **saved** draft — silently excluding the just-typed edits from the published version. The only signal ("Save draft before publishing") lives in the Versions card, *not* in the dialog the user is looking at.

**Impact:** User publishes a version that doesn't include their latest edits and doesn't realize it. Not data loss (edits remain in the draft) but a confusing publish semantics.

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

**Problem:** Every diagnostic is anchored to `[0, end]` — the whole document. With N issues, the entire editor is underlined N times and every squiggle tooltip shows on hover over any character. The `issue.path` (e.g. `paths./users.get.parameters[0].schema`) is never used to compute a real `from`/`to`, even though that's the whole point of carrying the path. The lint gutter ends up showing N identical full-document spans.

**Impact:** Lint underlines are useless for locating the error; users must read the path string from the tooltip.

**Fix:** Resolve `issue.path` to a JSON Pointer into the doc and compute a real `from`/`to` (even a coarse line-based range), or at minimum anchor each diagnostic to a distinct line derived from the path segments.

---

### [SEV: P3] `applyEditorText` redundant ternary — dead branch

**Location:** `apps/web/src/components/spec-editor/spec-workspace.tsx:303-313`

```ts
function applyEditorText(next: string) {
  const converted = convertSpecInputToJson(next);
  if (!converted.ok) {
    setText(next);
    return;
  }
  if (converted.convertedFromYaml) {
    setText(converted.json);
    toast.success("Converted YAML to JSON");
    return;
  }
  setText(converted.json === next ? next : converted.json);   // ← dead ternary
}
```

**Problem:** `converted.json === next ? next : converted.json` is a no-op — both branches return the same value (when `converted.json === next`, `next === converted.json`, so the else branch is also `converted.json`). `convertSpecInputToJson` returns `{ ok: true, json: text, convertedFromYaml: false }` verbatim for JSON input (no pretty-print, no normalization), so for the JSON case `converted.json === next` is always true. The ternary is dead code that obscures the intent.

**Impact:** Misleading — implies normalization happens when it doesn't.

**Fix:** `setText(converted.json);`

---

### [SEV: P3] `defaultNextVersion` ignores non-semver / `v`-prefixed versions — suggests "0.1.0" after "v1.2.3" was published

**Location:** `apps/web/src/components/spec-editor/spec-workspace.tsx:74-95`

```ts
function defaultNextVersion(existing: string[]): string {
  if (existing.length === 0) return "0.1.0";
  let best: [number, number, number] | null = null;
  for (const v of existing) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
    if (!m) continue;
    ...
  }
  if (best === null) return "0.1.0";
  return `${best[0]}.${best[1]}.${best[2] + 1}`;
}
```

**Problem:** The regex `^(\d+)\.(\d+)\.(\d+)` requires the version to **start** with digits. A published version like `v1.2.3`, `1.2`, `1.2.3-rc1` (prefix matches, but `1.2` does not), or `2024.01.01` all behave inconsistently:
- `v1.2.3` → no match → `best` stays null → returns `"0.1.0"`. After publishing `v1.2.3`, the next suggested version is `0.1.0` — suggesting the user downgrade.
- `1.2` → no match → same.
- `1.2.3-rc1` → matches `1.2.3` → suggests `1.2.4`. OK-ish but ignores the prerelease tag.

**Impact:** Confusing default version after publishing any `v`-prefixed or non-strict-semver version; the user can accidentally publish `0.1.0` after `1.5.0` if they accept the default.

**Fix:** Strip a leading `v` before matching, and document the prerelease behavior:

```ts
const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
```

---

### [SEV: P3] Publish dialog allows non-semver version strings and publishing an empty draft

**Location:** `apps/web/src/components/spec-editor/spec-workspace.tsx:355-368`

```tsx
<Input
  id="semver"
  value={version}
  onChange={(e) => setVersion(e.target.value)}
  placeholder="0.1.0"
  className="font-mono"
  disabled={publishPending}
/>
...
<Button onClick={() => publish()} disabled={publishPending || version.trim() === ""}>
  {publishPending ? "Publishing…" : "Publish"}
</Button>
```

**Problem:** No client-side semver validation. The only gate is `version.trim() !== ""`. The user can type `abc`, `1`, `latest`, or `1.2.3.4.5` and click Publish. The backend `publish` mutation (`convex/specs.ts:88`) does not validate semver either — it only checks for duplicate versions. So `abc` becomes a published version name forever (published versions are immutable).

Separately: if `savedDraft === ""` (e.g. after the P1 empty-draft wipe, or a fresh project with no draft), `dirty = (text !== savedDraft) = ("" !== "") = false` and `hasClientErrors = false` (empty → no client issues), so the Publish trigger is **enabled**. Clicking it calls `publishFn({ projectId, version })` which snapshots an empty draft. The backend has a guard ("Save a draft spec before publishing" if `draftRow.draft` is empty — `convex/specs.ts:147`), so it returns `{ ok: false }` — but the user reaches the publish dialog with an empty editor and an enabled Publish button, which is a confusing UX.

**Impact:** Permanently-bad version names; misleading enabled state for empty drafts.

**Fix:** Validate semver client-side (zod `z.string().regex(/^v?\d+\.\d+\.\d+/)`) and disable the Publish button when `savedDraft.trim() === ""`.

---

### [SEV: P3] Deprecate sunset date can be in the past with no warning

**Location:** `apps/web/src/components/spec-editor/spec-rail.tsx:502-510`

```ts
const parsedSunset =
  sunsetDate.length > 0 ? Date.parse(`${sunsetDate}T00:00:00Z`) : NaN;
const sunsetAt: number | undefined = Number.isNaN(parsedSunset)
  ? undefined
  : parsedSunset;
const sunsetValid = sunsetDate.length === 0 || !Number.isNaN(parsedSunset);
```

**Problem:** `sunsetValid` only checks that the date parses. A sunset date of yesterday (or 5 years ago) passes validation and is sent to `deprecateVersion`. The backend stores it verbatim. Consumers then see "deprecated, sunsets [past date]" — a version that is already sunset but still served.

**Impact:** Misleading deprecation metadata; consumers can't trust the sunset date.

**Fix:** `const sunsetValid = sunsetDate.length === 0 || (!Number.isNaN(parsedSunset) && parsedSunset > Date.now());`

---

### [SEV: P3] `VersionDialog` unmounts body on close — close animation is cut

**Location:** `apps/web/src/components/spec-editor/version-dialog.tsx:31-35` + `:23`

```tsx
<Dialog open={versionId !== null} onOpenChange={onOpenChange}>
  <DialogContent>
    {versionId !== null ? (
      <VersionDialogBody ... />
    ) : null}
  </DialogContent>
</Dialog>
```

```tsx
onOpenChange={(open) => {
  if (!open) setVersionDialogId(null);
}}
```

**Problem:** Closing the dialog sets `versionDialogId = null`, which makes `open = false` **and** unmounts `VersionDialogBody` (conditional render) on the same render. Radix's exit animation needs the content to stay mounted during the close transition. Because the body unmounts immediately, the dialog disappears with no animation, and the inner `useQuery` is torn down before any cached data can be reused on re-open.

**Impact:** Jarring UX (no close animation); query refetches from scratch on every re-open instead of showing cached data.

**Fix:** Keep the body mounted while the dialog is animating out — either render `VersionDialogBody` whenever `versionId !== null` and let Radix unmount via its own internal `open` state, or use Radix's `forceMount` + animation-driven unmount. At minimum, decouple the query lifecycle from the dialog open state.

---

### [SEV: P3] `DiffView` diffs against saved draft but confirm copy says "current unsaved draft changes"

**Location:** `apps/web/src/components/spec-editor/version-dialog.tsx:103-115`

```tsx
const diff = useMemo<DiffLine[] | null>(
  () => (data ? lineDiff(data.spec, savedDraft) : null),
  [data, savedDraft],
);
...
{confirming ? (
  <>
    <span className="mr-auto text-sm text-muted-foreground">
      Replace current unsaved draft changes?
    </span>
```

**Problem:** The diff is `lineDiff(data.spec, savedDraft)` — version vs **saved** draft. The restore confirmation says "Replace current unsaved draft changes?" — implying the diff reflects the user's **unsaved** edits. If the user has unsaved edits (`dirty === true`), the diff shown does NOT include them, but the confirmation implies it does. The user clicks "Restore" expecting to see what they're discarding, but the diff only shows the delta vs the last saved draft.

**Impact:** Misleading confirmation flow; user can't actually see what unsaved edits they're about to lose.

**Fix:** Either diff against the current editor `text` (requires passing `text` into the dialog), or change the copy to "Replace the saved draft with this version's spec?" and only show the confirm gate when `dirty`.

---

## Summary

**Counts:** 1 P0 · 3 P1 · 8 P2 · 8 P3 · **20 total findings** (prior review had 9; all 9 confirmed, SSRF escalated P1→P0, 11 new findings added).

**Top 3 to fix first:**
1. **P0 SSRF in `fetchSpecFromUrl`** — authenticated, response-body exfiltration, reaches cloud metadata. Block private ranges, disable redirect-follow, add timeout. The single highest-impact defect in this surface.
2. **P1 empty-draft autosave wipe** — `saveDraft(current)` fires on `current.trim() === ""` because the error-check is nested inside the non-empty guard; the backend allows empty drafts, so a select-all+delete+pause destroys the saved spec.
3. **P1 concurrent-edit clobber + publish race** — the realtime `getDraft` subscription silently overwrites unsaved local edits in another tab, and `publish` snapshots whatever the server holds at mutation time, so a cross-tab save can publish the wrong content.

**Compliance note (no defects):** all color tokens are semantic (`bg-primary`, `bg-destructive`, `text-muted-foreground`, `border-warning/40`, etc. — no raw Tailwind palette); all motion uses `--dur-*` / `--ease` CSS vars (no hardcoded `duration-300 ease-in-out`); all async state uses `isPending` (no `isLoading`); the route ships a layout-stable `SpecEditorSkeleton` for both `pendingComponent` and inner `Suspense` fallbacks; `humanError` filters `ConvexError` / `Server Error` / `Uncaught` / `at handler` substrings and caps length, so no internal error leak path was found. The defects are entirely behavioral (data loss, races, SSRF, perf) — not stylistic.
