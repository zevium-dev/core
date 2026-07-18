# Tiger Review — `apps/gateway/src/errors.ts` + `apps/gateway/src/headers.ts`

## Verdict

**Incorrect.** Both files have real defects. `headers.ts` forwards consumer
credentials (`Cookie`) to upstreams and reflects upstream `Set-Cookie` back to
clients — a credential-leak / session-fixation surface. `filterRequestHeaders`
also ignores the RFC 7230 §6.1 `Connection:` header-list, enabling per-hop
header smuggling, and passes client-controlled `X-Forwarded-*` straight
through. `errors.ts` advertises a "Never leaks internals" safety contract it
cannot enforce; its single 502 call site (`pipeline.ts:277`) feeds the raw
`Error.message` from an upstream `fetch` failure straight into the client
response body, which routinely contains internal hostnames, ports, and
network-layer diagnostics. The `extra` parameter on `jsonError` is dead code
— no caller in the gateway ever passes it.

## File Stats

- `apps/gateway/src/errors.ts` — 22 lines, 1 exported function (`jsonError`).
- `apps/gateway/src/headers.ts` — 56 lines, 2 exported functions
  (`filterRequestHeaders`, `filterResponseHeaders`) + `HOP_BY_HOP` table.
- Call sites: `errors.ts` → `pipeline.ts` (9), `mock.ts` (4); `headers.ts`
  → `pipeline.ts:240`, `pipeline.ts:370`.

## Findings

### [P1] `filterRequestHeaders` forwards `Cookie` to upstream APIs

```ts
// headers.ts:29-40
export function filterRequestHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower in HOP_BY_HOP) return;
    if (lower === "host") return;
    if (lower === "content-length") return;
    out.append(key, value);
  });
  return out;
}
```

**Problem.** `Cookie` is not in `HOP_BY_HOP` and is not stripped elsewhere.
The gateway runs under `*.zevium.dev` (or the worker route) and the consumer's
browser holds session cookies for that origin. When a consumer calls
`/gateway/:org/:project/*`, the request reaches the Worker carrying the
zevium session cookie; `filterRequestHeaders` then copies that `Cookie`
header verbatim into the upstream request and `fetch` delivers it to the
publisher's third-party API.

**Impact.** Credential leak of the consumer's zevium session to arbitrary
publisher upstreams. Enables a malicious or compromised publisher to
hijack/replay the consumer's zevium session (the `authorization`/`x-api-key`
strip in `HOP_BY_HOP` shows the author already understood "request auth must
not leak to upstream; gateway authenticates itself later" — `Cookie` is the
same class of credential and was missed). Cross-origin `Cookie` forwarding
also exposes the consumer to CSRF-style attacks against the upstream.

**Fix.** Add `cookie` (and `set-cookie`) to the request strip path; better,
maintain an allow-list rather than a deny-list for hop-by-hop.

```suggestion
const HOP_BY_HOP: Record<string, true> = {
  connection: true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
  authorization: true,
  "x-api-key": true,
  cookie: true,
  "set-cookie": true,
  "cf-connecting-ip": true,
  "cf-ipcountry": true,
  "cf-ray": true,
  "cf-visitor": true,
  "cdn-loop": true,
};
```

---

### [P1] `filterResponseHeaders` forwards upstream `Set-Cookie` to clients

```ts
// headers.ts:44-54
export function filterResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower in HOP_BY_HOP) return;
    if (lower === "content-length") return;
    out.append(key, value);
  });
  return out;
}
```

**Problem.** `Set-Cookie` is not in `HOP_BY_HOP`. An upstream API can return
`Set-Cookie` headers that the gateway appends to the client response. On the
gateway host (or any domain-match), those cookies land in the consumer's
browser. Combined with the `Cookie` leak above, this is a full
session-fixation path: upstream sets a known `session=evil` cookie on the
gateway domain, the next proxied request forwards it back to upstream, and
upstream can correlate/impersonate.

**Impact.** Publisher-controlled cookies injected into the gateway origin in
the consumer's browser; session fixation; CSRF-token clobbering. Even without
the request-side leak, reflecting arbitrary `Set-Cookie` from a third-party
upstream into a first-party response is a defect for any metered proxy.

**Fix.** Strip `set-cookie` on the response path (the `HOP_BY_HOP` addition
above covers it once both filters consult the same table).

---

### [P1] `jsonError` docstring claims "Never leaks internals" — unenforced, and violated at the only 502 call site

```ts
// errors.ts:1-4
/**
 * Shared JSON error envelope for /gateway and /mock. Never leaks internals —
 * `message` is always a short, human-safe string.
 */
```

```ts
// pipeline.ts:273-277
  } catch (err) {
    ...
    const message = err instanceof Error ? err.message : "upstream error";
    ...
    return jsonError(502, "upstream_error", message, requestId);
  }
```

**Problem.** The docstring asserts `message` is always human-safe, but
`jsonError` does nothing to enforce that — it trusts every caller. The 502
call site in `pipeline.ts` passes `err.message` from an upstream `fetch`
failure directly into the response body. Cloudflare Workers / undici `fetch`
errors carry messages like `fetch failed: connect ECONNREFUSED 10.0.x.y:443`,
`getaddrinfo ENOTFOUND internal-host.local`, TLS/SSV handshake strings, or
chunks of stack-adjacent text. Those land in the JSON body the consumer (or
an agent) sees.

**Impact.** Internal network topology, hostnames, ports, and transport-layer
diagnostics leak to clients. This is precisely the class of leak the
function's contract claims to prevent; the contract is a lie the type
signature cannot back.

**Fix.** Either (a) make `jsonError` accept only a closed set of `code`
values and look the human message up from a table so callers can never pass
free-form text, or (b) at minimum stop claiming the safety property and fix
the `pipeline.ts:277` caller to map `upstream_error` to a fixed string
(`"Upstream service unavailable"`) and log `err` server-side only. The
function under review should not advertise a guarantee it does not provide.

---

### [P2] `filterRequestHeaders` ignores the `Connection:` header-list (RFC 7230 §6.1)

```ts
// headers.ts:29-40 (filterRequestHeaders)
```

**Problem.** RFC 7230 §6.1 specifies that a proxy MUST remove not only the
hop-by-hop headers in the fixed set, but also any header named in the
`Connection` header field-value (e.g. `Connection: foo, bar` obliges the
proxy to strip `Foo` and `Bar`). The implementation strips the fixed
`HOP_BY_HOP` set plus `connection` itself, but never parses the `Connection`
value to find per-hop headers. A downstream/upstream that relies on this can
see headers the upstream proxy chain intended to discard.

**Impact.** Per-hop header smuggling past the gateway; potential for
request-smuggling-adjacent confusion against upstreams that honor
`Connection`-listed custom headers. Standards-non-compliant proxy behavior.

**Fix.** Before the `forEach`, read `source.get("connection")`, split on
`,`, trim/lowercase each token, union those names into the strip set for
this call.

---

### [P2] `filterRequestHeaders` forwards client-controlled `X-Forwarded-*` / `Forwarded` to upstream

```ts
// headers.ts:29-40 (filterRequestHeaders)
```

**Problem.** `x-forwarded-for`, `x-forwarded-host`, `x-forwarded-proto`,
`x-forwarded-port`, `x-real-ip`, and `forwarded` are not stripped. A client
can send `X-Forwarded-For: 1.2.3.4` and the gateway will deliver it to the
upstream publisher API as if it were a trusted proxy chain. Upstreams that
rate-limit, geofence, or attribute traffic by `X-Forwarded-For` (common for
API gateways behind a CDN) become spoofable by any consumer.

**Impact.** Client-controlled spoofing of client identity, host, and scheme
at the publisher upstream. Defeats upstream trust boundaries that assume
`X-Forwarded-*` is set by an honest proxy.

**Fix.** Either drop these headers entirely, or overwrite them with the
gateway's own view (`cf-connecting-ip` is already available and stripped from
inbound — feed it back as `X-Forwarded-For` only after sanitizing).

---

### [P2] `extra` parameter on `jsonError` is dead code

```ts
// errors.ts:5-19
export function jsonError(
  status: number,
  code: string,
  message: string,
  requestId: string,
  extra?: Record<string, unknown>,
): Response {
  const body: Record<string, unknown> = { error: code, message, requestId };
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      body[k] = v;
    }
  }
  ...
}
```

**Problem.** Every call site in `apps/gateway/src` (`pipeline.ts` × 9,
`mock.ts` × 4) passes exactly four arguments; none ever supplies `extra`.
The `if (extra)` branch is unreachable in production. Worse, the branch
blindly writes caller-supplied keys into the envelope with no
reserved-name guard, so a future caller doing `jsonError(…, { message: x })`
would silently overwrite the human message and break the contract
documented at the top of the file.

**Impact.** Dead surface that invites a future contract violation; the
`paymentRequiredResponse` envelope in `x402.ts` already exists for the
machine-readable `extra` case, so this path has no reason to exist.

**Fix.** Remove the `extra` parameter and its branch. If a caller ever
needs extra machine fields, route through `paymentRequiredResponse` or add
a dedicated, reserved-key-safe helper.

---

### [P2] `jsonError` spreads `extra` keys with no reserved-name guard

```ts
// errors.ts:13-16
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      body[k] = v;
    }
  }
```

**Problem.** Should any caller pass `extra: { error: … }`, `{ message: … }`,
or `{ requestId: … }`, the envelope's reserved fields get silently
overwritten. There is no `hasOwnProperty` / reserved-name check. Combined
with the dead-code finding above this is latent, but it is an active defect
in the function's contract.

**Impact.** Envelope shape can be corrupted by any caller; downstream
agents/clients parsing `error`/`message`/`requestId` get inconsistent
values.

**Fix.** If `extra` is retained, skip reserved keys:
`if (k !== "error" && k !== "message" && k !== "requestId") body[k] = v;`

---

### [P2] Neither filter strips `x-zevium-*` client-supplied headers / `via` / `server` / `x-powered-by`

```ts
// headers.ts:29-40, 44-54
```

**Problem.** A client can set `x-zevium-request-id`, `x-zevium-cost`,
`x-zevium-free-tier`, `x-zevium-mock`, or any `x-zevium-*` header on its
inbound request and `filterRequestHeaders` will forward it to the upstream
unchanged — polluting the publisher's view with gateway-internal metadata
that the gateway later sets itself on the response. On the response path,
`filterResponseHeaders` forwards upstream `Server`, `Via`, `X-Powered-By`,
and similar fingerprint headers to the consumer, leaking upstream stack
details.

**Impact.** Client-supplied gateway metadata reaches the upstream;
publisher stack fingerprint reaches the consumer. Minor information leak
both directions; breaks the "gateway is transparent about its own headers"
property.

**Fix.** Strip `x-zevium-*` on the request path (prefix match) and strip
`server`, `via`, `x-powered-by` on the response path (or overwrite `server`
with `zevium-gateway`).

---

### [P2] `requestId` is placed into a header with no validation

```ts
// errors.ts:18-21
    headers: {
      "content-type": "application/json",
      "x-zevium-request-id": requestId,
    },
```

**Problem.** `requestId` is parameterized. In production it comes from
`crypto.randomUUID()` (safe), but the function signature accepts any string
and the `idGenerator` injection seam in `pipeline.ts`/`mock.ts` allows test
or future callers to supply arbitrary values. If `requestId` ever contains
`\r\n` or other control chars, the `Headers` constructor throws a
`TypeError`, which means the *error response itself* throws — the gateway
then returns the Workers default opaque 500 instead of the structured
error. The error-handling path is the worst place to throw.

**Impact.** Adversarial or buggy id generation turns a recoverable error
into an opaque 500 with no request id, defeating observability exactly
when it is needed.

**Fix.** Validate/sanitize `requestId` before placing it in the header
(e.g. truncate to a max length, strip control chars, fall back to a fresh
`crypto.randomUUID()` on invalid input).

---

### [P3] `jsonError` sets no `cache-control` on error responses

```ts
// errors.ts:17-21
```

**Problem.** 4xx/5xx responses are emitted with only `content-type` and
`x-zevium-request-id`. Edge caches may, depending on config, cache
cacheable-status 4xx responses (some CDNs cache 404s aggressively). Error
responses with a per-request `requestId` should never be cached.

**Impact.** Possible stale error caching at intermediaries.

**Fix.** Add `"cache-control": "no-store"` to the error header set.

---

### [P3] `HOP_BY_HOP` is a `Record<string, true>` — lookup `in` works but the type is wasteful

```ts
// headers.ts:7-25
const HOP_BY_HOP: Record<string, true> = {
```

**Problem.** A `Set<string>` expresses the intent ("membership test") more
directly and avoids the `true` placeholder values. Current code works, but
the type communicates "map" when the structure is a set.

**Impact.** Style/clarity only.

**Fix.**
```suggestion
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cdn-loop",
]);
```
(and switch `lower in HOP_BY_HOP` → `HOP_BY_HOP.has(lower)`).

---

## Summary

- **Findings:** 10 (P1: 3, P2: 5, P3: 2)
- **Top 3:**
  1. `Cookie` forwarded to upstream APIs — consumer session credential leak (P1).
  2. Upstream `Set-Cookie` reflected to clients — session-fixation path (P1).
  3. `jsonError` advertises "Never leaks internals" but pipeline.ts:277 pipes raw
     `Error.message` from upstream `fetch` failures into the client body (P1).
