# Tiger Review — `apps/web/src/lib/spec-yaml.ts`

## Verdict

**Ship-blocking issues in input-validation discipline.** The converter is the
single chokepoint through which every pasted / imported / URL-fetched spec
enters the editor (`editor-toolbar.tsx:40`, `spec-workspace.tsx:294,315`). It
currently has an asymmetric object-root invariant: enforced on the YAML path,
silently skipped on the JSON path, and trivially defeated on the YAML path by an
array root. Combined with a raw `err.message` leak into a user-facing toast and
zero input-size bound, this is not a safe trust boundary. Needs hardening before
it can be considered production-grade.

## File Stats

- File: `apps/web/src/lib/spec-yaml.ts`
- LOC: ~55 (exported surface: `convertSpecInputToJson`, `looksLikeYaml`, `YamlConvertResult`)
- Deps: `yaml@2.9.0` (verified `node_modules/.pnpm/yaml@2.9.0`)
- Callers: `apps/web/src/components/spec-editor/editor-toolbar.tsx:40,42`, `apps/web/src/components/spec-editor/spec-workspace.tsx:294,315`
- Tests: `apps/web/src/lib/spec-yaml.test.ts` (4 cases — coverage gaps documented below)

## Findings

### [P2-1] Array root bypasses the YAML object guard

**Location:** `spec-yaml.ts:24-29`

```ts
const doc = parseYaml(trimmed) as unknown;
if (doc === null || typeof doc !== "object") {
  return { ok: false, error: "YAML root must be an object" };
}
```

**Problem:** `typeof [] === "object"` and `[] !== null`, so a YAML document with
an array root — e.g. `- openapi: "3.1.0"` or `- a\n- b` — sails through the
guard. Verified at runtime: `parseYaml("- a\n- b")` → `["a","b"]`, which passes
the check and is returned as `{ ok: true, json: "[\n  \"a\",\n  \"b\"\n]\n",
convertedFromYaml: true }`. The function then hands an array to callers that
assume an object root (OpenAPI specs are objects).

**Impact:** A user pasting a YAML list (or a mis-pasted `paths:` array) gets a
green "Converted YAML to JSON" toast (`spec-workspace.tsx:317`) and the editor is
populated with a JSON array. Downstream consumers (`collectOpenApiSpecIssues`,
`listSpecEndpoints`, `applyPricingEdit`) all dereference `.paths`, `.info`, etc.
on the assumed object — they will throw or silently produce empty validation,
and autosave will persist a non-spec array as the project's draft. The error
surface moves from "clean rejection at the boundary" to "cryptic failure three
layers deep in the editor / on save".

**Fix:**
```ts
if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
  return { ok: false, error: "Spec root must be a YAML mapping (object)." };
}
```
Add a regression test mirroring the JSON-branch object check below.

---

### [P2-2] JSON branch accepts scalars, arrays, and `null`

**Location:** `spec-yaml.ts:17-21`

```ts
try {
  JSON.parse(trimmed);
  // Already JSON — pretty-print only when it was compact/messy? Keep as-is for editor.
  return { ok: true, json: text, convertedFromYaml: false };
} catch {
  // fall through to YAML
}
```

**Problem:** `JSON.parse` succeeds for `123`, `"hello"`, `true`, `null`, and
`[1,2,3]`. All of these are returned as `{ ok: true, json: <raw>, convertedFromYaml:
false }` even though none is a valid OpenAPI root. The YAML branch enforces an
object root; the JSON branch does not — the invariant is asymmetric. Verified:
`convertSpecInputToJson("null")` → `{ ok: true, json: "null", ... }`;
`convertSpecInputToJson("[1,2,3]")` → `{ ok: true, json: "[1,2,3]", ... }`.

**Impact:** Same blast radius as P2-1: a JSON array or scalar is accepted at the
boundary and only fails when downstream code indexes into `.paths`. Worse, the
JSON branch returns `text` (untrimmed, see P3-5) so even
`convertSpecInputToJson('   null   ')` returns `{ ok: true, json: '   null   '
}`, which is not even valid for round-tripping.

**Fix:** After `JSON.parse`, validate the root is a non-null object:
```ts
const parsed = JSON.parse(trimmed);
if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
  return { ok: false, error: "Spec root must be a JSON object." };
}
return { ok: true, json: JSON.stringify(parsed, null, 2) + "\n", convertedFromYaml: false };
```
This also fixes P3-4 and P3-5 in the same stroke.

---

### [P3-1] `looksLikeYaml` is dead code

**Location:** `spec-yaml.ts:47-53`

**Problem:** `looksLikeYaml` is exported and unit-tested (`spec-yaml.test.ts:4-13`)
but has **zero production callers**. Verified via repo-wide grep: the only
references are the definition site and the test file. The one place that should
have used it — `spec-workspace.tsx:303-309` `onEditorChange` — reimplements the
identical check inline (`!next.trimStart().startsWith("{") && !next.trimStart().startsWith("[")`),
diverging from `looksLikeYaml`'s `trim()` + `startsWith` implementation. Two
sources of truth for "is this YAML?" will drift.

**Impact:** Maintenance hazard. Any future refinement to the heuristic (e.g.
handling BOM, leading comments `#`, flow indicators, document markers `---`)
must be applied in two places, and the test suite only covers the unused copy.

**Fix:** Either (a) delete `looksLikeYaml` and its tests, or (b) make
`spec-workspace.tsx:303-309` call `looksLikeYaml(next)` and delete the inline
reimplementation. Prefer (b) — the function is genuinely useful, it just isn't
wired up.

---

### [P3-2] No paste / import size cap

**Location:** `spec-yaml.ts:12` (entry), callers at `editor-toolbar.tsx:40`,
`spec-workspace.tsx:294,315`

**Problem:** `convertSpecInputToJson` accepts unbounded `text`. There is no
length guard before `JSON.parse(trimmed)` or `parseYaml(trimmed)`. Both parse
synchronously on the UI thread. The amplification in `spec-workspace.tsx:302-313`
(`onEditorChange`) is worse: it calls `convertSpecInputToJson(next)` on **every
keystroke** whenever the buffer doesn't start with `{` or `[`, so a user typing
a 500 KB YAML spec pays a full `parseYaml` + `JSON.stringify(doc, null, 2)` on
every character. URL/file imports (`editor-toolbar.tsx:40`) parse whatever
`fetchSpecFromUrl` returns with no upper bound either.

**Impact:** Realistic paste of a large provider's OpenAPI YAML (Stripe, GitHub,
etc. routinely ship multi-MB specs) will freeze the editor main thread for
hundreds of ms to seconds per keystroke, and a single paste of a ~10 MB document
can stall the tab for seconds. No DoS protection on the import path.

**Fix:** Add a hard ceiling at the boundary, e.g.
```ts
const MAX_SPEC_BYTES = 2_000_000;
if (text.length > MAX_SPEC_BYTES) {
  return { ok: false, error: `Spec is too large (${text.length.toLocaleString()} chars).` };
}
```
Consider debouncing the per-keystroke `convertSpecInputToJson` call in
`spec-workspace.tsx` or gating it on a paste/blur event rather than every
`onChange`.

---

### [P3-3] Raw `err.message` leaked to the toast

**Location:** `spec-yaml.ts:33-36`, surfaced at `editor-toolbar.tsx:42`

```ts
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    error: `Could not parse as JSON or YAML: ${message}`,
  };
}
```

**Problem:** The raw underlying parser message is interpolated verbatim into the
returned error string and rendered directly via `toast.error(converted.error)`
(`editor-toolbar.tsx:42`). The project explicitly ships a `humanError` helper
(`apps/web/src/lib/human-error.ts`) whose contract is *"Map unknown
mutation/query errors to short human copy. **Never leak internals.**"* — and this
is precisely the case it was built for, yet it isn't used. yaml@2.9.0 error
messages include parser internals (line/column anchors, tag-resolution paths,
YAML AST terms) that are (a) meaningless to users and (b) the kind of internals
leak the project rule forbids.

**Impact:** Users see messages like
`Could not parse as JSON or YAML: Bad YAML directive: %TAG at line 1, column 3:`
or stack-anchored parse diagnostics. Confusing UX + internal-leak policy
violation. Note `spec-workspace.tsx:294-298` silently swallows the error (`setText(next)`)
so the toast leak only fires on the import path — but that's the path most
likely to receive malformed external content.

**Fix:** Route through `humanError` (or hand-roll a fixed string):
```ts
return { ok: false, error: "Couldn't read that spec — paste valid JSON or YAML." };
```
Preserve the detailed message only in `console.warn` for debugging, never in
the returned string.

---

### [P3-4] JSDoc promises "pretty JSON" but the JSON branch returns raw text

**Location:** `spec-yaml.ts:7-9` (JSDoc) vs `spec-yaml.ts:17-21` (impl)

```ts
/**
 * Detect non-JSON OpenAPI paste/import, parse YAML, emit pretty JSON.
 * Storage stays canonical JSON.
 */
```
```ts
JSON.parse(trimmed);
// Already JSON — pretty-print only when it was compact/messy? Keep as-is for editor.
return { ok: true, json: text, convertedFromYaml: false };
```

**Problem:** The JSDoc contract is "emit pretty JSON". The YAML branch honors it
(`JSON.stringify(doc, null, 2) + "\n"`). The JSON branch does not — it returns
the original `text` byte-for-byte, even if compact (`{"a":1}`), single-line,
trailing-whitespace-laden, or mixed indentation. The inline comment even
self-flags the contradiction ("Keep as-is for editor") without resolving it.
"Storage stays canonical JSON" is also false: `spec-workspace.tsx` passes the
return value straight to `setText`, which becomes the autosaved draft, so
non-canonical JSON is what gets persisted.

**Impact:** The "canonical JSON" invariant advertised by the module is
unenforced. Mixed indentation / compact JSON from different paste sources
accumulates in the draft and is shown verbatim in the editor, defeating the
purpose of a canonicalization chokepoint.

**Fix:** Make the JSON branch emit canonical pretty JSON (fix from P2-2 does
this). Either delete the misleading JSDoc claim or honor it.

---

### [P3-5] JSON branch returns untrimmed `text`

**Location:** `spec-yaml.ts:20`

```ts
const trimmed = text.trim();
...
JSON.parse(trimmed);
return { ok: true, json: text, convertedFromYaml: false };
```

**Problem:** Parsing uses `trimmed`, but the returned `json` is the original
untrimmed `text`. So `convertSpecInputToJson('   {"openapi":"3.1.0"}   ')`
returns `{ ok: true, json: '   {"openapi":"3.1.0"}   ', ... }` — leading and
trailing whitespace propagated into the editor buffer and autosaved draft. The
YAML branch uses `JSON.stringify(doc, null, 2) + "\n"` (clean), so the asymmetry
is visible per-branch.

**Impact:** Cosmetic corruption of the draft; the editor shows a spec with stray
leading spaces. Downstream line/col error reporting from `collectOpenApiSpecIssues`
will also be offset by the leading whitespace, pointing users at the wrong line.

**Fix:** Return canonical JSON from the parsed value (same fix as P2-2 / P3-4),
which eliminates `text` from the return path entirely.

---

### [P3-6] YAML branch can emit non-JSON-serializable values silently

**Location:** `spec-yaml.ts:25-30`

**Problem:** yaml@2.9.0 resolves built-in tags like `!!timestamp` → `Date`,
`!!binary` → `Uint8Array`, and bare scalars like `Infinity` / `.nan` → JS
`Infinity` / `NaN`. `JSON.stringify` of a `Uint8Array` returns `"{}"`;
`Infinity`/`NaN` serialize to `null`; `Date` serializes to an ISO string. A YAML
spec containing any of these (rare for OpenAPI, but legal YAML) produces a JSON
string that is either lossy or semantically different from the input, with no
warning. The function reports `ok: true`.

**Impact:** Silent data loss on the import path for edge-case YAML. Low
likelihood for OpenAPI specs but the silent-success path is the wrong default.

**Fix:** After `parseYaml`, round-trip-validate with a reviver-aware check, or
stringify with a replacer that throws on `undefined` / non-plain objects. At
minimum, document the supported YAML subset.

---

### [P3-7] `as unknown` cast discards the parser's real return type

**Location:** `spec-yaml.ts:24`

```ts
const doc = parseYaml(trimmed) as unknown;
```

**Problem:** `parseYaml` returns `unknown` already (yaml@2.9.0's signature is
`parse(str: string): unknown`). The `as unknown` is a no-op cast that signals
nothing and slightly misleads readers into thinking the type was narrowed and
then widened. Purely cosmetic but it's the kind of noise that obscures intent
in a 55-line file.

**Fix:** Drop the cast: `const doc = parseYaml(trimmed);`

---

### [P3-8] `YamlConvertResult` discriminated union has no JSDoc and a misleading field name

**Location:** `spec-yaml.ts:3-6`

**Problem:** The `ok: true` branch carries `convertedFromYaml: boolean`, but
the `ok: false` branch has no `convertedFromYaml` field. Callers that destructure
`convertedFromYaml` outside a narrowing guard get `undefined` silently. The type
also has no JSDoc explaining when `json` may be `""` (empty input case) vs. a
real value, which `spec-workspace.tsx:303` relies on.

**Impact:** Minor API ergonomics; future callers may treat `json === ""` as a
real spec or reach for `convertedFromYaml` without narrowing.

**Fix:** Add a one-line JSDoc on the union noting the empty-input sentinel
behavior; consider `convertedFromYaml?: never` on the error branch for clarity.

---

### [P3-9] Test suite has zero coverage for the identified boundary cases

**Location:** `spec-yaml.test.ts` (whole file, 4 cases)

**Problem:** The existing tests assert: valid JSON round-trips, valid YAML
converts, garbage errors, empty input passes. None of the boundary conditions
documented above are covered:
- YAML array root (P2-1)
- JSON scalar / array / null root (P2-2)
- Untrimmed JSON input (P3-5)
- Non-pretty JSON output / non-canonical storage (P3-4)
- Over-size input (P3-2)
- Raw error message contents (P3-3)
- `looksLikeYaml` for `# comment`, `---` doc marker, BOM, leading whitespace
  before `{`

**Impact:** Regressions on any of the above ship silently. The P2-1 array
bypass in particular is the kind of defect a single assertion would have caught
years ago.

**Fix:** Add parameterized cases for each finding. For P2-1:
```ts
it("rejects YAML array root", () => {
  const r = convertSpecInputToJson("- a\n- b");
  expect(r.ok).toBe(false);
});
```

---

### [Informational] YAML billion-laughs is mitigated by yaml@2.9.0 defaults

**Location:** `spec-yaml.ts:24` (no `maxAliasCount` override)

**Verification:** Confirmed in `node_modules/.pnpm/yaml@2.9.0/.../nodes/Node.js:28` and
`Document.js:300`: `maxAliasCount: typeof maxAliasCount === 'number' ? maxAliasCount : 100`.
The default of 100 caps alias expansion; the classic billion-laughs payload
(`&a [a, *a, *a, ...]`) exceeds 100 on the second level and throws
`Aliasing anchors is not allowed`. No action needed here, but worth pinning in
case of a future `yaml` upgrade or refactor that passes options. Do **not** add
`maxAliasCount: Infinity` to "fix" a future edge case.

### [Informational] `__proto__` prototype pollution is mitigated by yaml@2.9.0

**Location:** `spec-yaml.ts:24`

**Verification:** `node_modules/.pnpm/yaml@2.9.0/.../nodes/addPairToJSMap.js:27` uses
`Object.defineProperty(map, stringKey, { value, writable: true, enumerable: true,
configurable: true })` whenever `stringKey in map` is true — which is the case for
`__proto__`, `toString`, `hasOwnProperty`, etc. Runtime check confirms: parsing
`__proto__:\n  polluted: yes\nx: 1` yields `{ "__proto__": { polluted: "yes" }, x:
1 }` and `({}).polluted === undefined` — no global pollution. No action needed.
If the dependency is ever upgraded, re-verify this property is preserved.

## Summary

- **P0:** 0
- **P1:** 0
- **P2:** 2 (array-root guard bypass, JSON-branch type asymmetry)
- **P3:** 9 (dead code, no size cap, err leak, JSDoc/impl mismatch, untrimmed
  return, non-JSON-resolvable values, no-op cast, missing union docs, test gaps)
- **Informational:** 2 (billion-laughs mitigated by default `maxAliasCount=100`;
  `__proto__` mitigated by `defineProperty`)
- **Total findings:** 13

**Top 3 to fix first:**
1. **P2-2 → P3-4 → P3-5 in one edit:** make the JSON branch parse, validate
   non-null object, and return `JSON.stringify(parsed, null, 2) + "\n"`. Closes
   three findings, enforces the "canonical JSON" contract, and removes `text`
   from the return path.
2. **P2-1:** add `Array.isArray(doc)` to the YAML-branch guard and ship a
   regression test. One-line fix, large correctness win.
3. **P3-3:** stop leaking `err.message` to the toast — route the import error
   through `humanError` (which already exists for exactly this) or return a
   fixed string. Aligns with the project's "never leak internal errors" rule.
