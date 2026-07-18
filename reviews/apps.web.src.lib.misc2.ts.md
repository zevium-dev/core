# Tiger Review — `apps/web/src/lib/` misc batch 2

Files reviewed (full read + tests):
- `apps/web/src/lib/spec-endpoints.ts` (+ `.test.ts`)
- `apps/web/src/lib/spec-pricing.ts` (no test; exercised via `spec-workspace.tsx`)
- `apps/web/src/lib/spec-save-status.ts` (+ `.test.ts`)
- `apps/web/src/lib/webhook-delivery.ts` (+ `.test.ts`)
- `apps/web/src/lib/convex-data-model.ts` (re-export, no test)
- `apps/web/src/lib/convex-api.ts` (re-export, no test)
- `apps/web/src/lib/spec-import.ts` (+ `.test.ts`)

## Verdict

**Incorrect** — `spec-import.ts` ships a server-side `fetch` with no SSRF
protection and an unbounded body read that defeats its own 2 MB cap. The
pricing/save-status/webhook-delivery helpers are otherwise tight; the few
remaining nits are cosmetic. No integer-cent or float-precision defects
(credits are always integer-floored via shared `extractPricing`); no
client-side pricing drift from the gateway (both paths call the same shared
`extractPricing`).

## File Stats

| File | Lines | Status |
|---|---|---|
| `spec-endpoints.ts` | 56 | clean |
| `spec-pricing.ts` | 55 | 1 nit |
| `spec-save-status.ts` | 48 | clean |
| `webhook-delivery.ts` | 66 | clean |
| `convex-data-model.ts` | 1 | clean (re-export, used) |
| `convex-api.ts` | 4 | clean (re-export, used) |
| `spec-import.ts` | 96 | **2 P1, 1 P2, 1 P3** |

## Findings

### [P1] `fetchSpecFromUrl` is an unrestricted SSRF — response body returned to caller

`apps/web/src/lib/spec-import.ts:43-96` runs `fetch(data.url, …)` server-side
where `data.url` is validated **only** by `importSpecUrlSchema` to be an
`http:`/`https:` URL. There is no private-address / link-local / loopback /
metadata-endpoint blocklist, and the response body is returned verbatim as
`text` to the caller:

```ts
response = await fetch(data.url, {
  method: "GET",
  redirect: "follow",
  headers: { Accept: "application/json, application/yaml, text/yaml, text/plain, */*" },
});
// …
const buf = await response.arrayBuffer();
// …
const text = new TextDecoder("utf-8").decode(buf);
if (text.trim() === "") {
  throw new Error("URL returned empty body");
}
return { text, contentType };
```

The handler performs **no auth check**; the sole caller
(`components/spec-editor/editor-toolbar.tsx:74`, `onImportUrl`) is reachable
from the authed editor, but the server-fn itself has no in-handler identity
gate and there is no global server-fn auth middleware in `src/router.ts` /
`__root.tsx`. Reachability of the RPC endpoint therefore reduces to however
the deployment exposes TanStack Start server functions.

Concrete exploits (no speculation — the code path is unconditional):
- `http://169.254.169.254/latest/meta-data/iam/security-credentials/<role>`
  (AWS IMDSv1) → temporary access keys returned to the caller.
- `http://127.0.0.1:<port>/`, `http://localhost:<port>/`,
  `http://10.0.0.1/`, `http://192.168.1.1/` → internal service responses
  (admin consoles, DBs, metrics) exfiltrated.
- `redirect: "follow"` means even a public-looking URL can 302 to any of the
  above, bypassing any future input-side protocol/host check.

Impact: server-side request forgery with full response-body disclosure. This is
the classic "leaked secrets via SSRF" class called out in the review brief.

Fix: resolve the URL host, reject non-public IPs (loopback, link-local
`169.254.0.0/16`, private `10/8`/`172.16/12`/`192.168/16`, IPv6 `::1`/`fc00::/7`),
disable redirects or re-validate each hop, and add an auth check inside the
handler (or via a `beforeAll` server-fn middleware). Use `undici`'s
`Agent`/global dispatcher with an IP-blocklist for DNS-rebinding-safe
enforcement.

```suggestion
const BLOCKED_HOSTNAMES = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|::1|fc|fd)/i;

function assertPublicUrl(raw: string): void {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("URL must be http(s)");
  }
  if (BLOCKED_HOSTNAMES.test(u.hostname)) {
    throw new Error("URLs pointing to private or local addresses are not allowed");
  }
}
```
…and call `assertPublicUrl(data.url)` before `fetch`, set `redirect: "manual"`
and re-`assertPublicUrl` each `Location`, and add a `requireAuth()`-style
identity check at the top of the handler.

### [P1] Response body is buffered in full before the 2 MB cap is enforced — DoS/OOM

Same handler, `spec-import.ts:71-84`:

```ts
const lengthHeader = response.headers.get("content-length");
if (lengthHeader !== null) {
  const n = Number(lengthHeader);
  if (Number.isFinite(n) && n > MAX_SPEC_IMPORT_BYTES) {
    throw new Error("Spec is larger than 2MB");
  }
}

const buf = await response.arrayBuffer();
if (buf.byteLength > MAX_SPEC_IMPORT_BYTES) {
  throw new Error("Spec is larger than 2MB");
}
```

The `Content-Length` branch is best-effort: it is skipped when the header is
absent, blank, or non-numeric, and a malicious/compromised server can simply
lie about `Content-Length` (send a small header and a multi-GB body). The
**authoritative** check (`buf.byteLength > MAX_SPEC_IMPORT_BYTES`) only runs
**after** `await response.arrayBuffer()` has already buffered the entire body
into the server process's memory. A hostile URL (or a buggy upstream with no
`Content-Length` streaming indefinitely) can OOM the TanStack Start server and
take down every other in-flight request.

Combined with the SSRF above, an unauthenticated/low-privilege caller can
point the fetch at a server that streams 10 GB with no `Content-Length` and
crash the node.

Fix: stream the body with a running byte counter and abort once it exceeds
`MAX_SPEC_IMPORT_BYTES`, before materialising the full buffer. Use
`ReadableStream` reader + `new Response(stream)` / `abort` on an
`AbortController`:

```suggestion
const abort = new AbortController();
const res = await fetch(data.url, { method: "GET", redirect: "manual", signal: abort.signal, headers: { Accept: "…" } });
// …status + content-length pre-check…
const reader = res.body?.getReader();
const chunks: Uint8Array[] = [];
let received = 0;
if (!reader) throw new Error("URL returned no body");
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  received += value.byteLength;
  if (received > MAX_SPEC_IMPORT_BYTES) {
    abort.abort();
    throw new Error("Spec is larger than 2MB");
  }
  chunks.push(value);
}
const buf = new Uint8Array(received);
let off = 0;
for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
```

### [P2] `fetch` has no timeout — slow server hangs the server function indefinitely

`spec-import.ts:48-54` calls `fetch(data.url, { … })` with no `signal` /
`AbortController` and no overall deadline. A server that accepts the TCP
connection and then dribbles one byte per second (or never responds at all)
keeps the server function — and its worker — pinned for as long as the
platform allows, which on Node is effectively until the process exits.

Impact: cheap, low-bandwidth DoS amplified by the SSRF surface (point at a
tarpit host). Fix together with the body-cap streaming reader above by
arming an `AbortController` with a `setTimeout(() => abort.abort(), 10_000)`.

```suggestion
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), 10_000);
try {
  response = await fetch(data.url, {
    method: "GET",
    redirect: "manual",
    signal: abort.signal,
    headers: { Accept: "application/json, application/yaml, text/yaml, text/plain, */*" },
  });
} catch (err) {
  if (abort.signal.aborted) throw new Error("URL took too long to respond");
  throw new Error("Could not reach that URL");
} finally {
  clearTimeout(timer);
}
```

### [P3] `fetchSpecFromUrl` returns `contentType` that no caller reads — dead field

`spec-import.ts:54, 96`:

```ts
const contentType = response.headers.get("content-type");
// …
return { text, contentType };
```

The declared return type is `Promise<{ text: string; contentType: string | null }>`,
but the only call site — `editor-toolbar.tsx:74-75` — destructures nothing and
uses `result.text` exclusively:

```ts
const result = await fetchSpecFromUrl({ data: parsed.data });
applyImportedRaw(result.text);
```

`convertSpecInputToJson` (the actual YAML/JSON discriminator) sniff the text
itself; the server-side `content-type` is computed, shipped across the
serialization boundary, and dropped. Either wire it through (e.g. to skip
the YAML probe when the server swears it is JSON) or drop it from the return
type and the `headers.get` call.

### [P3] `formatPricingSummary` pluralizes credits but not the free-tier endpoint count

`apps/web/src/lib/spec-pricing.ts:50-65`:

```ts
const range =
  summary.minCredits === summary.maxCredits
    ? creditsLabel(summary.minCredits)                       // "1 credit" / "3 credits"
    : `${summary.minCredits}–${summary.maxCredits} credits`; // "1–3 credits"
const free = summary.freeTier > 0 ? `, free tier on ${summary.freeTier}` : "";
```

The same function is careful to singularize credits via `creditsLabel`, but
the free-tier suffix renders `free tier on 1` / `free tier on 3` — ambiguous
(1 what?) and inconsistent with the singular-aware treatment six lines
above. Render the unit explicitly and singularize:

```suggestion
const free = summary.freeTier > 0
  ? `, free tier on ${summary.freeTier} endpoint${summary.freeTier === 1 ? "" : "s"}`
  : "";
```

## Summary

- **P0:** 0
- **P1:** 2 — SSRF in `fetchSpecFromUrl`; unbounded body buffering before size cap
- **P2:** 1 — no fetch timeout
- **P3:** 2 — dead `contentType` return; free-tier count not singularized

**Top 3:**
1. SSRF: server-side `fetch` of any http(s) URL with no private-host blocklist
   and no in-handler auth gate; body returned to caller (secret exfiltration).
2. DoS: `arrayBuffer()` buffers the full response before the 2 MB check, so a
   missing/lying `Content-Length` lets a caller OOM the node.
3. No fetch timeout: a slow/tarpit URL pins the server function indefinitely.

The pricing/save-status/webhook-delivery/endpoint-extraction code is correct:
pricing mirrors the gateway because both consume the shared `extractPricing`
(floors cost, defaults to 1 when ≤ 0); `summarizeDraftPricing` and
`listSpecEndpoints` iterate the same method-filtered pathItems; the save-status
state machine precedence (`saving` → `fix-errors` ⟂ `dirty` → `unsaved` →
`saved` → `idle`) is consistent and clock-skew-safe via `Math.max(0, …)`;
`deliveryStatusView` covers every schema status (`ok`/`failed`/`pending`,
matching `convex/schema.ts:147`) with semantic tokens and no raw colors.
