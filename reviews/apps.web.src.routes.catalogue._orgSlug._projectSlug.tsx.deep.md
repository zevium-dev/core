# Tiger Deep Review — `apps/web/src/routes/catalogue/$orgSlug.$projectSlug.tsx`

Scope: the route file plus its load-bearing dependencies (`convex/catalogue.ts` `getPublicDetail`, `packages/shared/src/openapi.ts` `parseSpec`/`extractPricing`, `apps/web/src/lib/landing.ts` gateway helpers, `apps/web/src/lib/human-error.ts`, `apps/web/src/lib/credits-label.ts`, sibling list route `apps/web/src/routes/catalogue/index.tsx` for VT-name parity). All 9 prior findings were re-verified against current source and expanded; 7 additional defects are reported below. No praise.

## Verdict

**Incorrect** — the public catalogue detail page ships with one correctness blocker (no error boundary on a throwing `useSuspenseQuery`, directly contradicting the loader's documented intent), four correctness/design defects (stale playground state across navigation, unbounded response body in the DOM, broken/one-sided view-transition morph, non-unique VT names that throw on duplicate slugs), and a cluster of smaller playground-UX, accessibility, and configuration-consistency defects. The file is reachable by anonymous visitors and is the primary conversion surface for the marketplace; several defects surface internal error text or freeze the tab.

## File Stats

| metric | value |
|---|---|
| lines | 987 |
| route-level exports | 1 (`Route`) |
| local functions | 16 (`gatewayBaseUrl`, `listEndpoints`, `buildRequestPath`, `parseExtraHeaders`, `shellQuote`, `buildCurl`, `copyText`, `ApiDetailPage`, `ApiDetailBody`, `PricingTable`, `EndpointDocs`, `MethodBadge`, `TryItPanel`, `ConnectAgentPanel`, `ApiNotFound`, `ApiDetailBodySkeleton`, `ApiDetailSkeleton`) |
| convex deps | `api.catalogue.getPublicDetail` (single `useSuspenseQuery`) |
| shared deps | `@zevium/shared` (`parseSpec`, `extractPricing`, `HttpMethod`, `OpenApiOperation`) |
| landing-lib deps | `buildMcpConfigSnippet`, `mcpEndpointUrl`, `resolveGatewayOrigin`, `tryItBaseUrl` |
| sibling-file coupling | `apps/web/src/routes/catalogue/index.tsx` (shared VT-name contract for `api-title-*` / `api-price-*`) |

---

## Findings

### [P1] No error boundary — `useSuspenseQuery` errors leak the raw TanStack error page, contradicting the loader's stated intent

**Location** — `Route.loader` (lines 47–66), `Route` options (line 67–84: `component`, `pendingComponent`, **no `errorComponent`**), `ApiDetailBody` (lines ~218–221).

```tsx
  loader: async ({ context, params }) => {
    const { queryClient } = context;
    const queryOpts = convexQuery(api.catalogue.getPublicDetail, { … });
    if (typeof window !== "undefined") {
      void queryClient.prefetchQuery(queryOpts);   // ← fire-and-forget, no await
      return;
    }
    try {
      await queryClient.ensureQueryData(queryOpts);
    } catch {
      // Keep transient Convex failures inside product UI instead of leaking
      // TanStack's raw server error page.
    }
  },
  component: ApiDetailPage,
  pendingComponent: ApiDetailSkeleton,
  // ← no errorComponent
```

```tsx
  const { data } = useSuspenseQuery(
    convexQuery(api.catalogue.getPublicDetail, { orgSlug, projectSlug }),
  );
```

**Problem (verified + expanded)** — The loader's try/catch only runs on the SSR branch (`typeof window === "undefined"`). On the client navigation branch it does `void queryClient.prefetchQuery(queryOpts); return;` — fire-and-forget, *not* awaited, so any prefetch rejection is unhandled and unobserved. The component then mounts and calls `useSuspenseQuery`, which **re-throws** any query error to the nearest React error boundary. There is no `errorComponent` on this route, on the `catalogue` parent layout, or on `__root.tsx` (grep for `errorComponent|ErrorBoundary` across `apps/web/src` returns zero matches). The only wrapper around `ApiDetailBody` is `<Suspense fallback={<ApiDetailBodySkeleton />}>` (line ~204) — `Suspense` catches *pending*, not *errors*.

Net effect on any persistent Convex failure (rate limit, deploy gap, network drop, `getPublicDetail` throwing on a malformed `specVersions` row): the error propagates to TanStack Router's default error renderer, which prints the raw error message — and Convex client errors routinely embed function names and internal messages. The loader's comment ("instead of leaking TanStack's raw server error page") is unfulfilled by construction: the SSR swallow is dead with respect to the client path, which is the dominant path for an in-app navigation from the catalogue list.

**Impact** — Internal Convex error text exposed to anonymous catalogue visitors; the "never leak internal errors" project contract is violated. The loader's comment actively misleads future maintainers about the safety of the error path.

**Fix** — Add an `errorComponent` to the route that renders a friendly retry card (or `ApiNotFound` for 404-shaped errors), and either (a) await `prefetchQuery` on the client branch too and swallow there, or (b) wrap `ApiDetailBody` in an explicit `<ErrorBoundary>` that degrades to skeleton + retry. At minimum, delete or rewrite the misleading comment.

---

### [P2] Stale `TryItPanel` state across project navigation (no `key`/remount)

**Location** — `ApiDetailPage` (lines ~197–210) → `ApiDetailBody` (lines ~212–353) → `TryItPanel` (lines ~410–762). `TryItPanel` `useState` seeds (lines ~419–427):

```tsx
  const [endpointId, setEndpointId] = useState(endpoints[0]?.id ?? "");
  const [pathParams, setPathParams] = useState<Record<string, string>>({});
  const [headersText, setHeadersText] = useState("");
  const [bodyText, setBodyText] = useState("{\n  \n}");
  const [apiKey, setApiKey] = useState("");
  const [mock, setMock] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<PlayResult | null>(null);
  const [copiedCurl, setCopiedCurl] = useState(false);
```

```tsx
        <Suspense fallback={<ApiDetailBodySkeleton />}>
          <ApiDetailBody orgSlug={orgSlug} projectSlug={projectSlug} />
        </Suspense>
```

**Problem (verified + expanded)** — TanStack Router reuses the route component instance across param changes; `ApiDetailBody` is rendered without a `key`, so React reconciles it in place. `useSuspenseQuery` refetches and `endpoints` recomputes via `useMemo`, but `TryItPanel`'s internal state is **never reset** when `orgSlug`/`projectSlug` change. The `endpointId` self-heals through `endpoints.find((e) => e.id === endpointId) ?? endpoints[0] ?? null` (line ~422), but `result`, `bodyText`, `headersText`, `mock`, `copiedCurl`, and `apiKey` all persist verbatim.

The `Tabs` component (`defaultValue="docs"`, line ~355) is **uncontrolled** and also not keyed, so the active tab selection persists across navigation too — a visitor on the "Try it" tab of project A lands on the "Try it" tab of project B staring at A's last response.

The `useEffect` that hydrates `apiKey` from `sessionStorage` (lines ~429–435, dep array `[]`) only runs on mount; without a remount it never re-reads when the user navigates between projects. The stored key is global (`zevium:playground-api-key`), so this is arguably fine for a single-user session, but the *result* and *body* contamination is not.

**Impact** — A visitor who sent a request to API A, then clicks through to API B, sees A's response body, headers, and request body pre-filled under B's "Try it" tab. Misleading at best; if the response looks plausible for B it is actively deceptive. Combined with the missing `AbortController` (see P3 below), a response from A can land *after* the navigation to B and overwrite B's panel.

**Fix** — Force remount on slug change:

```suggestion
        <Suspense fallback={<ApiDetailBodySkeleton />}>
          <ApiDetailBody
            key={`${orgSlug}/${projectSlug}`}
            orgSlug={orgSlug}
            projectSlug={projectSlug}
          />
        </Suspense>
```

(Equivalently, push the `key` down to `TryItPanel` if the spec/pricing sections should stay mounted for transition purposes — but the simplest correct fix is at the `ApiDetailBody` boundary.)

---

### [P2] Unbounded `result.body` rendered verbatim — self-DoS + internal leak

**Location** — `onSend` (lines ~588–625) + result render (lines ~717–722).

```tsx
      const res = await fetch(requestUrl, init);
      const text = await res.text();
      const ms = Math.round(performance.now() - t0);
      setResult({
        status: res.status,
        statusText: res.statusText,
        ms,
        body: text,
        mock,
      });
```

```tsx
              <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-all">
                {result.body || "(empty body)"}
              </pre>
```

**Problem (verified + expanded)** — `await res.text()` reads the entire response body into a single string with no `Content-Length` check, no streaming cap, no truncation. The string is stored in React state and rendered as a text child of a `<pre>`. Three distinct failure modes:

1. **Self-DoS** — a multi-megabyte response (an upstream API returning a large JSON dump, a paginated collection, or a misbehaving gateway returning a huge HTML error page) is fully allocated and committed to the DOM in one text node. `max-h-80 overflow-auto` caps the *box* but not the *content*; the browser still lays out the entire string before clipping. A 50 MB body will freeze the tab for seconds.
2. **Internal leak** — non-2xx gateway/upstream error bodies (which may contain internal hostnames, file paths, or stack traces from the Cloudflare Worker or upstream) are displayed verbatim. The route sanitizes *network* errors via `humanError` (line ~620) but renders the *response body* raw — including HTML error pages from the upstream that the gateway proxies through.
3. **Re-render amplification** — `result.body` lives in component state, so every parent re-render (e.g., the `Tabs` value change, the `copiedCurl` toggle) re-renders the giant `<pre>` text node. There is no `useMemo`/substring gate.

**Impact** — Playground self-DoS on large responses (a visitor can point the playground at an endpoint that returns a large payload and freeze their own tab); internal-info leak when the gateway/upstream returns an error body with internals.

**Fix** — Truncate before storing, and sniff the content type:

```suggestion
      const text = await res.text();
      const MAX_BODY = 65_536;
      const truncated = text.length > MAX_BODY;
      const body = truncated
        ? `${text.slice(0, MAX_BODY)}\n… (${text.length} bytes, truncated)`
        : text;
      setResult({
        status: res.status,
        statusText: res.statusText,
        ms,
        body,
        mock,
        truncated,
      });
```

For the leak concern, consider gating non-2xx bodies behind a "show raw error body" disclosure rather than rendering them by default, or running them through `humanError` when `res.status >= 500`.

---

### [P2] Incomplete list→detail view-transition morph — `api-price` is one-sided

**Location** — `ApiDetailBody` price span (lines ~295–303) vs. list card `apps/web/src/routes/catalogue/index.tsx:488–493`.

Detail side (this file):
```tsx
              {priceRange ? (
                <>
                  {" "}
                  ·{" "}
                  <span className="tabular-nums text-foreground">
                    {priceRange}
                  </span>
                </>
              ) : null}
```

List side (sibling file, for reference):
```tsx
              {priceLabel ? (
                <Badge variant="outline" className="font-mono"
                  style={{ viewTransitionName: `api-price-${item.slug}` }}>
                  {priceLabel}
                </Badge>
              ) : null}
```

**Problem (verified)** — The list card declares `viewTransitionName: api-price-${item.slug}` on the price badge, but the detail page's price span has **no matching `viewTransitionName`**. The title morph works (`api-title-${slug}` exists on both sides — see next finding), but the price element is orphaned. The project UI rule explicitly requires "every list→detail nav ships view-transition morph or written reason"; this morph is half-shipped with no documented reason. During navigation the browser animates the list badge out with no target to morph into, producing a visible snap/fade glitch.

**Impact** — Broken/partial view transition on every list→detail navigation; violates the documented UI contract.

**Fix** — Add the matching name to the detail's price span (and gate it on `priceRange` being non-null so an unpriced detail doesn't claim the name):

```suggestion
                  <span
                    className="tabular-nums text-foreground"
                    style={{
                      viewTransitionName:
                        priceRange ? `api-price-${data.project.slug}` : undefined,
                    }}
                  >
                    {priceRange}
                  </span>
```

(Also adopt the org-scoped key from the next finding to avoid the collision.)

---

### [P2] `view-transition-name` key not globally unique — collision across orgs throws `TypeError`

**Location** — `ApiDetailBody` h1 (lines 264–269) and sibling list card `apps/web/src/routes/catalogue/index.tsx:454–456`.

```tsx
            <h1
              className="text-3xl font-semibold tracking-tight"
              style={{ viewTransitionName: `api-title-${data.project.slug}` }}
            >
              {data.project.name}
            </h1>
```

**Problem (verified + expanded)** — Project slugs are unique **per org** (Convex index `by_org_slug` on `organizationId` + `slug`, `convex/catalogue.ts:236–240`), not globally. The VT name `api-title-${data.project.slug}` (and the matching `api-title-${item.slug}` on the list card, plus `api-price-${item.slug}`) uses the project slug alone. When the catalogue list renders two projects with the same slug from different orgs (entirely legal per the schema), **both list cards get the same `view-transition-name`**.

The View Transition API requires `view-transition-name` to be unique across the document at the moment a transition starts; duplicates cause the browser to throw `TypeError: duplicate view-transition-name` and **abort the entire transition for the page** — not just the colliding element. So one duplicate slug on the list page breaks the morph for *every* card, not just the colliding pair. The failure is silent (console-only) and the page snaps instead of animating.

**Impact** — View-transition morph silently breaks for the whole list page whenever duplicate project slugs co-exist. No functional data loss, but the UX contract is violated and the failure mode (whole-page snap) is disproportionate to the trigger.

**Fix** — Include the org slug in the VT name on both sides (detail + list card):

```suggestion
            <h1
              className="text-3xl font-semibold tracking-tight"
              style={{
                viewTransitionName: `api-title-${data.org.slug}-${data.project.slug}`,
              }}
            >
              {data.project.name}
            </h1>
```

`apps/web/src/routes/catalogue/index.tsx` lines 454–456 and 490–492 must use the same `api-title-${item.orgSlug}-${item.slug}` / `api-price-${item.orgSlug}-${item.slug}` key — cross-file change. `SearchListing extends PublicListing` which already carries `orgSlug` (`convex/search.ts:269`), so the data is available.

---

### [P2] `copyText` swallows failures; `onCopyCurl` shows the green check on copy failure

**Location** — `copyText` (lines ~186–195) + `onCopyCurl` (lines ~612–625).

```tsx
async function copyText(text: string, okMsg: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(okMsg);
  } catch {
    toast.error("Could not copy to clipboard");
  }
}
```

```tsx
    void copyText(curl, "curl copied").then(() => {
      setCopiedCurl(true);
      window.setTimeout(() => setCopiedCurl(false), 1500);
    });
```

**Problem (verified)** — `copyText` never rejects: it catches `navigator.clipboard.writeText` failures and surfaces them via `toast.error`, then resolves normally. `onCopyCurl`'s `.then()` therefore always runs, flipping `copiedCurl(true)` and showing the green `Check` icon (line ~703) regardless of whether the clipboard write succeeded. The user sees both an error toast ("Could not copy to clipboard") *and* a green check on the button — contradictory feedback. The clipboard can fail for several reasons on the public catalogue (insecure context on non-localhost HTTP, permissions policy denial, embedded iframe without `clipboard-write`), so this is not a theoretical path.

**Impact** — Misleading UI: the button claims success while the toast reports failure. A visitor who dismisses the toast and trusts the check will paste stale clipboard contents.

**Fix** — Have `copyText` return a boolean (or rethrow) so `onCopyCurl` can gate the icon swap:

```suggestion
async function copyText(text: string, okMsg: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(okMsg);
    return true;
  } catch {
    toast.error("Could not copy to clipboard");
    return false;
  }
}
```

```suggestion
    void copyText(curl, "curl copied").then((ok) => {
      if (!ok) return;
      setCopiedCurl(true);
      window.setTimeout(() => setCopiedCurl(false), 1500);
    });
```

---

### [P3] Hardcoded `1500ms` timeout instead of motion tokens

**Location** — `onCopyCurl` (line ~622).

```tsx
      window.setTimeout(() => setCopiedCurl(false), 1500);
```

**Problem (verified)** — The copy-feedback reset uses a magic `1500ms`. The project's `styles.css` defines `--dur-instant: 150ms`, `--dur-fast: 250ms`, `--dur-base: 350ms`, `--dur-page: 400ms`, `--dur-slow: 600ms` (lines 48–53), and every other timing-bearing component in `apps/web/src` references these tokens via `duration-[var(--dur-*)]` (grep confirms ~30 call sites). `1500ms` matches none of them and is the only literal timeout in the route. (The prior review referenced `src/lib/motion.ts`; the actual tokens live in `styles.css` as CSS custom properties — same intent, same drift risk.)

**Impact** — Drift risk; no single source of truth for feedback timing. The 1500 ms also feels long next to the 150 ms `--dur-instant` used for the surrounding button hover transitions.

**Fix** — Either add a `--dur-feedback` token (and use it via a CSS class or `style={{ transitionDuration: "var(--dur-feedback)" }}`), or reuse `--dur-slow` (600 ms) if a shorter feel is acceptable. Avoid raw literals.

---

### [P3] Raw `<textarea>` / `<select>` instead of shadcn `Textarea` / `Select`

**Location** — `TEXTAREA_CLASS` constant (lines 19–21), headers/body textareas (lines ~700–712, ~722–732), endpoint `<select>` (lines ~663–679).

```tsx
const TEXTAREA_CLASS =
  "flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";
```

```tsx
              <select
                id="try-endpoint"
                value={endpoint?.id ?? ""}
                onChange={(e) => setEndpointId(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
```

**Problem (verified)** — `apps/web/src/components/ui/textarea.tsx` and `select.tsx` both exist as stock shadcn primitives; the sibling catalogue index route imports and uses the shadcn `Select`. This detail route bypasses both, hand-rolling a `TEXTAREA_CLASS` constant and a raw `<select>` with an inline class string. The hand-rolled textarea class is missing the `transition-[color,box-shadow]` duration tokens (`duration-[var(--dur-instant)] ease-[var(--ease)]`) that the stock `Textarea` carries, and the raw `<select>` cannot be styled consistently with the shadcn select across browsers (native select arrow, focus ring). The project UI rule mandates stock shadcn unmodified; the hand-rolled classes will silently drift from `Textarea`'s base whenever the design tokens change.

**Impact** — Style drift; two textarea/select implementations in the same feature area; missing motion tokens on the textarea focus ring.

**Fix** — Replace raw `<textarea>` with `<Textarea>` (apply `className="font-mono text-xs min-h-24"` for the playground-specific sizing) and the raw `<select>` with shadcn `<Select>` / `<SelectTrigger>` / `<SelectContent>` / `<SelectItem>`.

---

### [P3] `head` title uses URL slug, not the project display name; no 404 title for missing listings

**Location** — `Route.head` (lines 68–83) and `ApiNotFound` (lines ~880–905).

```tsx
  head: ({ params }) => ({
    meta: [
      { title: `${params.projectSlug} · Catalogue · Zevium` },
      { name: "description", content: "API pricing, docs, and try-it playground." },
    ],
  }),
```

**Problem (verified + expanded)** — The loader fetches the project (via `ensureQueryData`/`prefetchQuery`) but returns `undefined` — it never returns `loaderData`, so `head` cannot read the project name. The browser tab and SEO/social-share title show the kebab-case slug (`weather-api`) instead of the display name (`Weather API`). The data is one `await` + one `return` away. Additionally, when `getPublicDetail` returns `null` (missing/private/unpublished), the component renders `ApiNotFound`, but `head` still emits `${params.projectSlug} · Catalogue · Zevium` — so a non-existent listing is indexed with a slug-stuffed title rather than a "Not found" title, which is worse for SEO than a 404 title.

**Impact** — Suboptimal SEO/social-share title for every catalogue detail page; misleading title on not-found pages.

**Fix** — Return the fetched project name from the loader (at least on the SSR branch) and reference it via `loaderData` in `head`; fall back to a "Not found · Catalogue · Zevium" title when `loaderData === null`:

```suggestion
  loader: async ({ context, params }) => {
    const { queryClient } = context;
    const queryOpts = convexQuery(api.catalogue.getPublicDetail, {
      orgSlug: params.orgSlug,
      projectSlug: params.projectSlug,
    });
    if (typeof window !== "undefined") {
      void queryClient.prefetchQuery(queryOpts);
      return null;
    }
    try {
      const data = await queryClient.ensureQueryData(queryOpts);
      return data;
    } catch {
      return null;
    }
  },
  head: ({ loaderData, params }) => ({
    meta: [
      {
        title:
          loaderData?.project.name
            ? `${loaderData.project.name} · Catalogue · Zevium`
            : `${params.projectSlug} · Catalogue · Zevium`,
      },
      …
    ],
  }),
```

(If the not-found title should differ, branch on `loaderData === null`.)

---

### [P3] Duplicated gateway-base resolution — `gatewayBaseUrl()` shadows `resolveGatewayOrigin` with a different fallback; both called in the same render

**Location** — `DEFAULT_GATEWAY` + `gatewayBaseUrl()` (lines 39, ~85–91) vs. `resolveGatewayOrigin` / `tryItBaseUrl` in `#/lib/landing`; `ConnectAgentPanel` (lines ~843–855) calls **both**.

```tsx
const DEFAULT_GATEWAY = "http://localhost:8787/gateway";

function gatewayBaseUrl(): string {
  const env = import.meta.env.VITE_GATEWAY_URL;
  if (typeof env === "string" && env.trim().length > 0) {
    return env.replace(/\/+$/, "");
  }
  return DEFAULT_GATEWAY;
}
```

```tsx
function ConnectAgentPanel({ orgSlug, projectSlug }: { … }) {
  const gatewayOrigin = resolveGatewayOrigin(
    import.meta.env.VITE_GATEWAY_URL as string | undefined,
  );
  const mcpUrl = mcpEndpointUrl(gatewayOrigin);
  const snippet = buildMcpConfigSnippet(mcpUrl);
  const notes = `…
// Gateway base: ${gatewayBaseUrl()}/${orgSlug}/${projectSlug}`;
```

**Problem (verified + expanded)** — `gatewayBaseUrl()` reimplements the same env-read + trailing-slash-strip logic as `resolveGatewayOrigin` in `#/lib/landing`, but with a different fallback (`.../gateway` vs. bare origin). `ConnectAgentPanel` invokes **both** in the same render: `resolveGatewayOrigin(env)` for the MCP URL (strips `/gateway`, appends `/mcp`), and `gatewayBaseUrl()` for the "Gateway base" line in the notes (keeps `/gateway`). So the same panel prints two inconsistent "gateway base" representations:

- MCP config: `http://localhost:8787/mcp` (origin + `/mcp`)
- Notes "Gateway base": `http://localhost:8787/gateway/org/proj` (origin + `/gateway` + path)

Both are arguably correct for their respective endpoints, but they are derived from two different code paths with two different fallbacks; if `VITE_GATEWAY_URL` is set with a trailing `/gateway` in one consumer's mental model and bare origin in another's, they will silently disagree. Also: if `VITE_GATEWAY_URL` is unset in a production build, both fall back to `http://localhost:8787`, which is never correct for a deployed environment and fails with no diagnostic.

**Impact** — Configuration fragility; silent breakage on misconfigured production deploys; two code paths for the same env var invite drift.

**Fix** — Consolidate into a single lib helper (e.g., `resolveGatewayBase(env)` returning `{ origin, gatewayPath }` or a single URL), and use it in both `TryItPanel` (via `tryItBaseUrl`) and `ConnectAgentPanel`. Fail loud — or surface a UI banner — when the env var is missing in a production build.

---

### [P3] No `AbortController` on the try-it `fetch` — stale responses can overwrite state after navigation/endpoint switch

**Location** — `onSend` (lines ~588–625).

```tsx
    setSending(true);
    setResult(null);
    const t0 = performance.now();
    try {
      const res = await fetch(requestUrl, init);
      const text = await res.text();
      …
      setResult({ … });
```

**Problem (verified)** — The `fetch` is issued without an `AbortController`, and there is no `useEffect` cleanup that aborts an in-flight request on unmount or on `endpoint`/`requestUrl` change. Three concrete consequences:

1. Navigating away from the detail page while a request is in flight: the response lands, `setResult` fires on the (now-stale, pre-remount-fix) component instance, contributing to the cross-project contamination in the P2 stale-state finding. Even after the remount fix, the fetch continues consuming network/CPU until it resolves.
2. Switching the endpoint or toggling `mock` while a request is in flight: the late response overwrites the `result` for the *new* endpoint selection, showing a response that does not match the currently-selected endpoint.
3. Double-clicking Send: guarded by `sending` (line ~591 `if (!endpoint || sending) return;`), so this particular race is handled — but only because of the boolean guard, not request cancellation.

**Impact** — Stale-response contamination within the same project; wasted network on navigation; minor footgun for future maintainers who might relax the `sending` guard.

**Fix** — Hold an `AbortController` ref, abort on unmount and before each new request:

```suggestion
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  async function onSend(e: FormEvent) {
    e.preventDefault();
    if (!endpoint || sending) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    …
    try {
      const res = await fetch(requestUrl, { ...init, signal: ac.signal });
      …
    } catch (err) {
      if (ac.signal.aborted) return;   // superseded, don't surface
      …
    }
```

---

### [P3] Redundant dual API-key headers; key still attached on `mock` calls

**Location** — `onSend` (lines ~595–602) and `onCopyCurl` (lines ~614–618).

```tsx
    const key = apiKey.trim();
    if (key.length > 0) {
      headers.Authorization = `Bearer ${key}`;
      headers["X-Api-Key"] = key;
    }
```

**Problem (verified)** — Every real call sends the API key in **two** headers (`Authorization: Bearer ${key}` and `X-Api-Key: ${key}`). Whatever the gateway accepts, only one is needed; the redundancy doubles the key's exposure surface in any gateway or upstream access log that captures request headers. Worse, the same block runs unconditionally regardless of the `mock` toggle — but `mock` calls hit `/mock`, which the landing helper documents as "public and keyless" (`apps/web/src/lib/landing.ts:42-49`). So a visitor who toggles Mock on with a key in the field still ships the key to the public mock endpoint for no reason. The `buildCurl` "Copy as curl" output (line ~620) also embeds both headers — and therefore the live key — into the clipboard in plaintext with no warning.

**Impact** — Increased key-exposure surface (dual headers, mock endpoint, clipboard); a user who pastes the curl command into a chat or issue leaks their live key.

**Fix** — Pick one header (the gateway's canonical auth header) and drop the other; skip key attachment entirely when `mock` is true; consider redacting the key in the "Copy as curl" output with a `YOUR_API_KEY` placeholder and a note, the way `ConnectAgentPanel` already does for the MCP config snippet.

---

### [P3] Stale `result` not cleared when endpoint / params / body change

**Location** — `TryItPanel` (lines ~419–435, ~580–625).

```tsx
  const [result, setResult] = useState<PlayResult | null>(null);
  …
  useEffect(() => {
    if (!endpoint) return;
    setPathParams((prev) => { … });
  }, [endpoint]);
```

**Problem (verified)** — The `useEffect` on `[endpoint]` (lines ~437–446) re-seeds `pathParams` when the endpoint changes, but `result` is never cleared. After sending a request to endpoint A, switching to endpoint B leaves A's response body, status, and timing visible above the form until the user sends again. Combined with the uncontrolled `result.body` render, a visitor can easily mistake a stale response for the new endpoint's behavior. The `mock` toggle also doesn't clear `result`, so toggling from real to mock (or vice versa) leaves the previous mode's response visible.

**Impact** — Confusing/misleading playground state; visitors act on stale responses.

**Fix** — Clear `result` when `endpointId`, `mock`, or any path param changes:

```suggestion
  useEffect(() => {
    setResult(null);
  }, [endpointId, mock]);
```

(Or fold this into the remount-based fix from the P2 stale-state finding — remounting also clears `result`.)

---

### [P3] `getPublicDetail` over-fetches — dead fields shipped to every anonymous visitor

**Location** — `convex/catalogue.ts:253–275` (query return shape) consumed by `ApiDetailBody`.

```ts
    org: { …; imageUrl: string | undefined; };
    project: { …; status: …; visibility: …; };
    latestVersion: { …; publishedAt: number; …; } | null;
```

**Problem (verified)** — The route renders `org.name`, `org.slug`, `project.name`, `project.slug`, `project.description`, `project.tags`, and `latestVersion.{version,spec,deprecatedAt,sunsetAt,deprecationMessage}`. The query additionally returns `org.imageUrl`, `project.status`, `project.visibility`, and `latestVersion.publishedAt` — none of which the route renders. `status` and `visibility` are already gated on the server (`if (project.visibility !== "public" || project.status !== "published") return null`) so they are always `"published"`/`"public"` on the client by construction — pure dead bytes. More importantly, `latestVersion.spec` is the **full published OpenAPI JSON string**, shipped to every anonymous visitor, when `listEndpoints` only needs `paths` (method, path, summary, `x-zevium-cost`, `x-zevium-free-tier`); `servers`, `components`, `info`, and any example responses are parsed but unused. For a large spec this is the dominant payload cost of the page.

**Impact** — Wasted bandwidth on every detail page load; the full spec (which may include upstream `servers[0].url` and example payloads) is shipped when a trimmed projection would do. The `servers` URL is already public, so this is a perf concern, not a leak — but for a marketplace conversion surface, the payload size directly affects TTFB and LCP.

**Fix** — Trim the query return shape: drop `org.imageUrl`, `project.status`, `project.visibility`, `latestVersion.publishedAt` (or surface `publishedAt` if it should be displayed). For the spec body, either (a) project only the endpoint list server-side via a dedicated `getPublicEndpoints` query, or (b) accept the full-spec shipping but document why (e.g., the "Try it" panel needs the raw paths for `buildRequestPath`). At minimum, drop the four dead scalar fields.

---

### [P3] Result `<pre>` has no `aria-live` region — screen readers don't announce responses

**Location** — result render (lines ~717–722).

```tsx
              <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-all">
                {result.body || "(empty body)"}
              </pre>
```

**Problem (verified)** — When `onSend` resolves and `result` is set, the status badge and body `<pre>` appear, but the region has no `aria-live` (polite) or `role="status"`. A screen-reader user who clicks Send gets no audible confirmation that a response arrived — the new content appears in the DOM but is not announced. The `mock` toggle's status banner (line ~671) correctly uses `role="status"`, so the inconsistency is within the same component.

**Impact** — Accessibility regression: keyboard/screen-reader users are not informed when a playground response lands.

**Fix** — Add `aria-live="polite"` (or wrap the result block in a `role="status"` region):

```suggestion
              <div aria-live="polite">
                <pre className="…">
                  {result.body || "(empty body)"}
                </pre>
              </div>
```

---

### [P3] Sunset date rendered via `toLocaleDateString()` with no timezone handling

**Location** — deprecation banner (line ~328).

```tsx
              {data.latestVersion.sunsetAt !== undefined
                ? ` — sunset ${new Date(data.latestVersion.sunsetAt).toLocaleDateString()}`
                : ""}
```

**Problem (verified)** — `sunsetAt` is a Convex `number` (epoch ms, UTC). `new Date(ms).toLocaleDateString()` formats in the *visitor's local timezone* with their locale. For a sunset date of `2026-07-18T00:00:00Z`, a visitor in UTC-10 sees `7/17/2026`; a visitor in UTC+14 sees `7/18/2026`. The displayed date can therefore be off by a day from the intended UTC date, and two visitors in different timezones see different sunset dates for the same API. `deprecatedAt` is not displayed as a date (only `deprecatedAt !== undefined` is checked), so the issue is scoped to `sunsetAt`.

**Impact** — Misleading sunset date for off-UTC visitors; a publisher who sets a sunset date of "July 18" may see some visitors shown "July 17".

**Fix** — Format as UTC date explicitly, or render with a stable format:

```suggestion
                ? ` — sunset ${new Date(data.latestVersion.sunsetAt).toLocaleDateString(
                     "en-US",
                     { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" },
                   )}`
```

---

## Summary

| sev | count |
|---|---|
| P0 | 0 |
| P1 | 1 |
| P2 | 5 |
| P3 | 9 |

**Top 3:**

1. **No error boundary** (P1) — `useSuspenseQuery` errors reach the root default error component on the client-nav path (the loader's client branch is fire-and-forget `prefetchQuery`), leaking internal Convex error text to anonymous visitors; the loader's "don't leak raw errors" comment is unfulfilled by construction.
2. **Stale `TryItPanel` state across navigation** (P2) — no `key` on `ApiDetailBody`; the previous project's response body, headers, request body, mock toggle, and tab selection persist into the next project's view, with no `AbortController` to stop late responses from overwriting the new panel.
3. **Unbounded `result.body`** (P2) — `res.text()` with no cap allocates and renders arbitrarily large response bodies into a `<pre>` text node, enabling self-DoS and leaking gateway/upstream error-body internals verbatim.

**Cross-cutting notes** — No XSS found: all spec-sourced content (`path`, `summary`, `method`, `description`, `tags`, `deprecationMessage`) and all response bodies are rendered as React text children (auto-escaped); no `dangerouslySetInnerHTML`. No raw Tailwind colors — all classes use semantic tokens (`bg-background`, `text-muted-foreground`, `border-warning/40`, `bg-destructive/10`). No slug injection — URL params are validated against the `by_org_slug` Convex index before use in gateway URLs; child components receive DB-validated `data.org.slug`/`data.project.slug`, not raw route params. The `parseSpec`/`extractPricing` shared helpers are defensive (invalid JSON → throw → caught by `listEndpoints`'s try/catch → empty endpoint list; missing `x-zevium-cost` → default cost 1), so a malformed published spec degrades gracefully rather than crashing the page. The shared-helper default-cost-1 behavior is a product question (should unpriced endpoints show "1 credit"?), not a defect in this route.
