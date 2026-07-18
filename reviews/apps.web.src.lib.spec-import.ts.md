# Tiger Review — `apps/web/src/lib/spec-import.ts`

## Verdict

**Incorrect.** The server-side `fetchSpecFromUrl` is an unrestricted SSRF oracle with no host allowlist, no fetch timeout, and a size cap that is bypassable via streaming bodies (no `content-length`). The status-code error message turns the SSRF from blind to informative. `parseImportSpecUrl` is fine; the server function is not. `fetchSpecFromUrl` has zero test coverage.

## File Stats

| Metric | Value |
|---|---|
| File | `apps/web/src/lib/spec-import.ts` |
| Lines | 92 |
| Exports | 4 (`MAX_SPEC_IMPORT_BYTES`, `importSpecUrlSchema`, `parseImportSpecUrl`, `fetchSpecFromUrl`) |
| Test coverage | `parseImportSpecUrl` only; `fetchSpecFromUrl` untested |
| Findings | 7 (P0: 0, P1: 2, P2: 3, P3: 2) |

## Findings

---

### [P1] SSRF: `fetchSpecFromUrl` fetches arbitrary attacker-supplied `http(s)` URLs server-side with no private/loopback/metadata filtering

**Location:** `spec-import.ts:43-92` (validator at 44-50, `fetch(data.url, …)` at 55-62)

**Problem.** `fetchSpecFromUrl` is a `createServerFn` (runs on the server, not the browser). The validator (`importSpecUrlSchema`, lines 6-22) only checks that the scheme is `http:` or `https:`. There is **no** block on loopback (`127.0.0.1`, `localhost`, `[::1]`), link-local (`169.254.169.254`), RFC1918 private ranges (`10/8`, `172.16/12`, `192.168/16`), `0.0.0.0`, or internal hostnames. The test suite even explicitly blesses `http://localhost:3000/spec.yaml` as valid (`spec-import.test.ts:13`), so the gap is intentional for dev convenience and ships to production.

Any authenticated user with access to the spec editor can submit e.g. `http://169.254.169.254/latest/meta-data/iam/security-credentials/` (cloud metadata), `http://localhost:PORT/internal-admin`, or `http://10.0.0.5:9090/` and read the response body back through the returned `text`.

**Impact.** Full SSRF → internal network mapping, credential exfiltration from cloud metadata, and reading of internal/unauthenticated admin endpoints. Body content is returned to the caller, so this is a non-blind SSRF (data returned via the resolved spec text / error).

**Fix.** Resolve the URL hostname, reject anything that resolves to private/loopback/link-local/`0.0.0.0`/metadata IPs, and either pin a scheme+port or require an explicit allowlist of upstream spec hosts. Use `redirect: "manual"` and re-validate every hop (see finding #2).

```suggestion
// In the validator, after URL parse:
const u = new URL(value);
const host = u.hostname.toLowerCase();
const blocked = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.|169\.254\.|::1|fc|fd)/;
if (blocked.test(host) || host === "localhost") {
  throw new Error("URL must be a public host");
}
```

---

### [P1] No fetch timeout — a slow/hanging upstream exhausts server connections indefinitely

**Location:** `spec-import.ts:55-62`

**Problem.** `fetch(data.url, { method: "GET", redirect: "follow", headers })` has no `AbortController` / `signal` and no overall deadline. A malicious URL (or a deliberately slow server) can hold the server function open for the runtime's default fetch timeout (often minutes in undici, effectively unbounded). Combined with SSRF (an attacker controls the target), this is a cheap server-side resource-exhaustion DoS: each request pins a connection and memory until the body completes or the runtime kills it.

**Impact.** DoS — an authenticated user can spawn many concurrent imports to hanging endpoints and tie up all server fetch slots / memory.

**Fix.** Wrap with an `AbortSignal.timeout(10_000)` (or `AbortController` + `setTimeout`) and abort.

```suggestion
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 10_000);
try {
  response = await fetch(data.url, {
    method: "GET",
    redirect: "error",
    signal: ctrl.signal,
    headers: {
      Accept:
        "application/json, application/yaml, text/yaml, text/plain, */*",
    },
  });
} catch {
  throw new Error("Could not reach that URL");
} finally {
  clearTimeout(timer);
}
```

---

### [P2] Size cap is bypassable: `response.arrayBuffer()` buffers the entire body before the byte-length check when `content-length` is absent or understated

**Location:** `spec-import.ts:72-83` (`arrayBuffer()` at 80, check at 81-82)

**Problem.** The pre-check at 73-78 only fires when a `content-length` header is present and parseable. When the upstream uses chunked transfer-encoding (no `content-length`), or sends more bytes than the declared `content-length` (lying header), the code falls through to `await response.arrayBuffer()` which reads and buffers the **entire** body into memory, then checks `buf.byteLength > MAX_SPEC_IMPORT_BYTES` after the fact. A malicious server can stream gigabytes; peak memory equals the full body size before the rejection fires. The `MAX_SPEC_IMPORT_BYTES` guard therefore bounds the *accepted* size but not the *peak* memory.

**Impact.** Memory-exhaustion DoS via a streaming/chunked response — no `content-length` needed.

**Fix.** Stream the body incrementally and abort once the running byte count exceeds the cap, before allocation grows unbounded.

```suggestion
const buf = await readBounded(response.body, MAX_SPEC_IMPORT_BYTES);
async function readBounded(body: ReadableStream<Uint8Array> | null, max: number) {
  if (!body) throw new Error("URL returned empty body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) throw new Error("Spec is larger than 2MB");
    chunks.push(value);
  }
  return new Uint8Array(total).set.bind(new Uint8Array(total)) && concat(chunks, total);
}
```

(`concat` left as an implementation detail; the point is to bound allocation.)

---

### [P2] `redirect: "follow"` defeats any future host allowlist and enables redirect-based SSRF bypass

**Location:** `spec-import.ts:57`

**Problem.** Even if finding #1's host allowlist were added on the *input* URL, `redirect: "follow"` lets the remote server 30x-redirect to `http://169.254.169.254/…`, `http://localhost/…`, or any internal host, and the fetch silently follows — no re-validation of redirect targets. This is the canonical SSRF-allowlist bypass.

**Impact.** Any host allowlist on the *submitted* URL is ineffective; SSRF remains reachable via a redirector host controlled by the attacker.

**Fix.** Use `redirect: "manual"` and re-run the host validator on each `Location` before following; or use `redirect: "error"` and reject redirects entirely.

```suggestion
          redirect: "error",
```

---

### [P2] `URL returned HTTP ${response.status}` leaks upstream status codes, converting SSRF into an informative network-mapping oracle

**Location:** `spec-import.ts:67-68`

**Problem.** When the upstream responds non-2xx, the thrown error echoes the exact HTTP status back to the client (surfaced via `humanError` → `toast.error` in `editor-toolbar.tsx:81`). During SSRF probing of internal services, the status code distinguishes a live endpoint (200/401/403) from a missing route (404) from an error (500), and even reveals framework behavior. The connection-refused / DNS-failure path is already generic ("Could not reach that URL", line 64), so the status-path leak is the only signal an attacker needs to map internal services.

**Impact.** Amplifies findings #1/#4: blind SSRF becomes an informative internal-network scanner with per-route status feedback.

**Fix.** Genericize the non-OK branch so it does not distinguish reachable-but-erroring from unreachable.

```suggestion
      if (!response.ok) {
        throw new Error("Could not import spec from that URL");
      }
```

---

### [P3] `contentType` is returned but never consumed by any caller — dead output

**Location:** `spec-import.ts:71` (declared), `:90` (returned)

**Problem.** `fetchSpecFromUrl` returns `{ text, contentType }`, but the only caller, `editor-toolbar.tsx:74-75`, reads `result.text` and ignores `result.contentType`. The `Accept` header (line 59-60) also accepts `text/plain, */*`, so `contentType` carries no enforcement value. This is unused surface area on the server-function contract — a reader assumes it gates parsing, but it does nothing.

**Impact.** Dead code / misleading API. No runtime impact.

**Fix.** Either drop `contentType` from the return type and the `Accept` header's catch-all, or actually enforce a content-type allowlist (reject `text/html` etc., which would also harden SSRF against HTML error pages from internal services).

```suggestion
      return { text };
```
(and update the return type at line 52 to `Promise<{ text: string }>`)

---

### [P3] `importSpecUrlSchema` imposes no maximum URL length; `new URL` parses arbitrarily long strings

**Location:** `spec-import.ts:6-22`

**Problem.** The schema does `.string().trim().url().refine(new URL(…))` with no `.max(…)`. An attacker can submit a multi-megabyte URL string; `z.string().trim()` allocates a trimmed copy, then `.url()` and `new URL` parse the whole thing. Combined with the unbounded `fetch` target, this is a minor pre-fetch amplification. Also: `new URL` happily accepts userinfo (`http://user:pass@host/`), which then becomes part of the SSRF request — not exploitable on its own, but unnecessary surface.

**Impact.** Minor DoS on the validator; no security boundary breached.

**Fix.** Bound the URL length.

```suggestion
  url: z
    .string()
    .trim()
    .max(2048, "URL too long")
    .url("Enter a valid URL")
```

---

## Summary

- **Total findings:** 7 — P0: 0, P1: 2, P2: 3, P3: 2
- **Top 3:**
  1. **SSRF** — unrestricted server-side fetch of attacker-supplied `http(s)` URLs to private/loopback/metadata hosts (P1).
  2. **No fetch timeout** — hanging-request resource-exhaustion DoS (P1).
  3. **Size cap bypassable** via streaming/chunked bodies that buffer fully before the `arrayBuffer` byte-length check (P2).

The pure client-side helper `parseImportSpecUrl` and the shared `parseSpec`/`matchOperation` in `packages/shared/src/openapi.ts` are fine. Every defect lives in `fetchSpecFromUrl` and stems from treating an attacker-controlled URL as a trusted fetch target. The 2MB cap and `parseImportSpecUrl` tests give a false sense of coverage; the server function — the part that actually touches the network — has none.

Note: a YAML billion-laughs / deep-nesting DoS exists in the *consumer* (`convertSpecInputToJson` → `parseYaml` in `apps/web/src/lib/spec-yaml.ts`), not in this file, but it is reachable from `fetchSpecFromUrl`'s output via `editor-toolbar.applyImportedRaw`. The byte cap here does **not** bound YAML alias-expansion memory; that fix belongs in `spec-yaml.ts` (pass `maxAliasCount` / nesting limits to `parseYaml`), flagged here for visibility.
