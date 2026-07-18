# Tiger Review — `apps/gateway/src/cors.ts`

## Verdict

Incorrect — small but real defects in preflight scope and header hygiene. No credentialed-wildcard or reflected-origin misconfiguration (the scary class); `access-control-allow-credentials` is never set and origin is a static `*`, so the wildcard is genuinely safe given bearer-key auth. The problems are in *which paths* the preflight answers, *which headers* it advertises, and *how `withCors` munges* inner headers.

## File Stats

- File: `apps/gateway/src/cors.ts`
- Lines: 35
- Functions: `corsPreflight`, `withCors`
- Caller: `apps/gateway/src/index.ts` (global OPTIONS handler at L165-167; `withCors` wraps `/`, `/health`, `/discovery`, `/mcp`, `/gateway/*`, `/mock/*`, and the 404 fallthrough; NOT applied to `/internal/grant` or `/internal/sync`).

## Findings

### [P2] Global OPTIONS preflight advertises CORS surface on secret-gated `/internal/*` and 404 paths

`index.ts` L165-167 runs `corsPreflight()` for **every** path before route dispatch:

```ts
// Public API: browsers preflight cross-origin calls with Authorization.
if (request.method === "OPTIONS") {
  return corsPreflight();
}
```

But `corsPreflight()` returns the full CORS advertisement unconditionally:

```ts
// cors.ts
export function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": ALLOW_HEADERS,           // authorization, x-api-key, content-type, accept
      "access-control-max-age": "86400",
    },
  });
}
```

The module's own header comment scopes CORS to "browser callers ... reach `/gateway`, `/mock`, `/discovery`, and `/mcp`". The implementation does not honor that scope:

- `OPTIONS /internal/grant`, `OPTIONS /internal/sync`, `OPTIONS /this-route-does-not-exist` all return `204` with `access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS` and `access-control-allow-headers: authorization, x-api-key, content-type, accept`. An anonymous cross-origin attacker learns the method set and that `authorization`/`x-api-key` are accepted request headers — exactly the surface reconnaissance a CORS preflight is designed to disclose.
- The preflight is also *lying*: the actual `POST /internal/grant` response (L173-184, `handleInternalGrant`) is returned bare — no `withCors` wrap — so it carries no `access-control-allow-origin`. A browser that preflights successfully will then block the real response. The promise the preflight makes is broken for these routes.

Impact: information disclosure of the request-header surface on shared-secret-protected admin endpoints, plus a behavioral inconsistency between preflight and actual response on `/internal/*`. Not exploitable for CSRF because `x-gateway-secret`/`Authorization` are client-set headers that browsers never auto-attach cross-origin, but it contradicts the documented scope and is the kind of "preflight answers for routes that shouldn't be CORS-public" defect that gets flagged in every audit.

Fix: scope the preflight to the public surfaces listed in the comment, and let OPTIONS fall through to a 405 on `/internal/*` and unknown paths.

```suggestion
// index.ts
if (request.method === "OPTIONS") {
  const first = parts[0];
  if (first === "gateway" || first === "mock" || first === "discovery" || first === "mcp" || first === undefined || first === "health") {
    return corsPreflight();
  }
  return new Response(null, { status: 405 });
}
```

### [P3] Static `access-control-allow-headers` does not echo `Access-Control-Request-Headers`

```ts
const ALLOW_HEADERS = "authorization, x-api-key, content-type, accept";
...
"access-control-allow-headers": ALLOW_HEADERS,
```

The preflight returns a fixed allow-list and ignores the request's `access-control-request-headers` value. Any browser that preflights with an additional header (e.g. `x-trace-id`, `x-request-id`, `x-zevium-client`) will be rejected at preflight because that header is not in the static set, even though the gateway wouldn't actually care. The canonical pattern is to echo `access-control-request-headers` (filtered against an allow-list) so legitimate client headers pass while arbitrary ones are still bounded.

Fix:

```suggestion
export function corsPreflight(request: Request): Response {
  const requested = request.headers.get("access-control-request-headers");
  const allowHeaders = requested
    ? requested
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter((h) => ALLOW_HEADERS.split(", ").includes(h))
        .join(", ")
    : ALLOW_HEADERS;
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": allowHeaders || ALLOW_HEADERS,
      "access-control-max-age": "86400",
    },
  });
}
```

(Callers in `index.ts` L166 must pass `request`.)

### [P3] `withCors` silently overwrites inner `access-control-allow-origin` and `access-control-expose-headers`

```ts
export function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", EXPOSE_HEADERS);
  return new Response(res.body, { ... });
}
```

`Headers#set` replaces rather than merges. If any inner handler (`handleDiscoveryRequest`, `handleMcpRequest`, `handleGatewayRequest`, `handleMockRequest`) ever sets its own `access-control-expose-headers` (e.g. to add a route-specific header), `withCors` will silently drop it. Today no inner handler sets CORS headers (confirmed via grep across `apps/gateway/src`), so this is latent — but the function's contract ("add CORS headers") implies merging, and the first inner handler that sets `access-control-expose-headers` will lose headers with no error.

Fix: merge expose-headers, or document that inner handlers must not set CORS headers.

```suggestion
const innerExpose = headers.get("access-control-expose-headers");
const expose = innerExpose
  ? Array.from(new Set([...innerExpose.split(",").map((h) => h.trim()), ...EXPOSE_HEADERS.split(", ").map((h) => h.trim())])).join(", ")
  : EXPOSE_HEADERS;
headers.set("access-control-expose-headers", expose);
```

### [P3] `withCors` does not strip a stray `access-control-allow-credentials: true` from inner responses

If an inner response ever sets `access-control-allow-credentials: true`, `withCors` keeps it (it never deletes the header) and then sets `access-control-allow-origin: *`. Per the Fetch spec, browsers reject the combination of `*` origin with `allow-credentials: true` when the request is made with `credentials: 'include'` — the response is treated as a CORS failure. So a future inner handler that opts into credentials would silently break all credentialed cross-origin calls instead of producing a clear error. No current inner handler sets this (confirmed via grep), so latent; the defensive fix is one line.

Fix:

```suggestion
headers.delete("access-control-allow-credentials");
headers.set("access-control-allow-origin", "*");
```

### [P3] `access-control-allow-methods` is over-broad and includes `OPTIONS`

```ts
"access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
```

`OPTIONS` never needs to be listed (preflight is not subject to `allow-methods`). `PUT`/`PATCH`/`DELETE` are not accepted by `/discovery` (GET/HEAD only — `discovery.ts` L122) or `/health` (no method restriction but realistically GET). Advertising them globally widens the disclosed surface for no benefit; route-specific preflights would advertise only the methods each route accepts.

Fix:

```suggestion
"access-control-allow-methods": "GET, POST, DELETE",
```

(Adjust to the actual union of methods the public surfaces accept.)

### [P3] `access-control-max-age: 86400` caches preflight for 24 hours

```ts
"access-control-max-age": "86400",
```

A 24h cache means any change to `ALLOW_HEADERS`, `EXPOSE_HEADERS`, or `access-control-allow-methods` will not reach browsers for up to a day per client. For a public API where the allowed-header set is small and stable this is defensible, but combined with the static-allow-headers issue above it means a new client header added to `ALLOW_HEADERS` to unblock a real client will be ineffective for 24h against browsers that have already preflighted. Lower to `600` (10 min) during iteration, or accept the 24h window deliberately.

### [P3] Comment lists four surfaces; `withCors` wraps six

```ts
/**
 * CORS for the public gateway surfaces. ... browsers ... must be able to
 * reach /gateway, /mock, /discovery, and /mcp from any origin. ...
 */
```

`withCors` is also applied to `/` and `/health` (L170) and the 404 fallthrough (L221). The comment's enumeration is incomplete. Either update the comment or narrow `withCors` application to match.

### Dead code check

No dead code. Both exports are consumed in `index.ts`:
- `corsPreflight` → L166
- `withCors` → L170, L186, L194, L202, L216, L221

`ALLOW_HEADERS` and `EXPOSE_HEADERS` are both referenced. No unused symbols.

### Non-issues explicitly cleared

- **Wildcard `*` with credentials**: `access-control-allow-credentials` is never set anywhere in `apps/gateway/src` (grep confirms). `*` is safe given bearer-key auth. Not a defect.
- **Reflected `Origin`**: origin is a static `*`, never reflected. Not a defect.
- **Missing `Vary: Origin`**: with a static `*` and no credentials, `Vary: Origin` is not required by the Fetch spec and would add no value. Not a defect (would become one only if the origin policy ever became dynamic — at which point the `Vary` header must be added in the same change).

## Summary

- **Findings**: 7 (1× P2, 6× P3)
- **P0**: 0 — no credentialed-wildcard, no reflected origin, no auth bypass.
- **P1**: 0 — no correctness bug in the happy path.
- **P2**: 1 — preflight advertises CORS surface on `/internal/*` and unknown paths, contradicting the documented scope and lying about allowed methods on routes whose actual responses carry no CORS headers.
- **P3**: 6 — static allow-headers doesn't echo ACRH; `withCors` overwrites inner CORS headers; `withCors` doesn't strip stray `allow-credentials`; `OPTIONS` listed in allow-methods; 24h preflight cache; comment/route drift.

**Top 3 to fix before merge:**
1. Scope `corsPreflight()` to the public surfaces (`/gateway`, `/mock`, `/discovery`, `/mcp`, `/health`) — return `405` for OPTIONS elsewhere.
2. Echo `access-control-request-headers` (filtered) instead of returning a static allow-list.
3. Make `withCors` merge (not overwrite) `access-control-expose-headers` and strip any stray `access-control-allow-credentials`.
