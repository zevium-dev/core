# Tiger Review — `apps/web/src/routes/catalogue/$orgSlug.$projectSlug.tsx`

## Verdict

**Incorrect** — multiple correctness and design defects: no error boundary despite a `useSuspenseQuery` that throws on Convex failure (directly contradicting the loader's stated "don't leak raw errors" intent), stale `TryItPanel` state across project navigation, unbounded response body rendered into the DOM, and an incomplete list→detail view-transition morph.

## File Stats

| metric | value |
|---|---|
| lines | 987 |
| functions | 14 (`gatewayBaseUrl`, `listEndpoints`, `buildRequestPath`, `parseExtraHeaders`, `shellQuote`, `buildCurl`, `copyText`, `ApiDetailPage`, `ApiDetailBody`, `PricingTable`, `EndpointDocs`, `MethodBadge`, `TryItPanel`, `ConnectAgentPanel`, `ApiNotFound`, `ApiDetailBodySkeleton`, `ApiDetailSkeleton`) |
| convex deps | `catalogue.getPublicDetail` |
| shared deps | `@zevium/shared` (`parseSpec`, `extractPricing`, `HttpMethod`, `OpenApiOperation`) |

## Findings

---

### [P1] No error boundary — `useSuspenseQuery` errors leak the raw TanStack error page

**Location** — `loader` (lines 54–72) + `ApiDetailBody` (lines 210–218)

```tsx
  loader: async ({ context, params }) => {
    ...
    try {
      await queryClient.ensureQueryData(queryOpts);
    } catch {
      // Keep transient Convex failures inside product UI instead of leaking
      // TanStack's raw server error page.
    }
  },
  ...
  component: ApiDetailPage,
  pendingComponent: ApiDetailSkeleton,
  // ← no errorComponent
```

```tsx
  const { data } = useSuspenseQuery(
    convexQuery(api.catalogue.getPublicDetail, { orgSlug, projectSlug }),
  );
```

**Problem** — The loader swallows `ensureQueryData` errors (comment explicitly says "instead of leaking TanStack's raw server error page"), but the component calls `useSuspenseQuery`, which **re-throws** any query error to the nearest React error boundary. The route defines no `errorComponent` and wraps `ApiDetailBody` only in `<Suspense>` (pending-only, not errors). The parent `catalogue.tsx` and `__root.tsx` define no `errorComponent` either. Net effect: a persistent Convex failure (rate limit, deploy gap, network) on the client path → `prefetchQuery` is fire-and-forget (`void`, line 64) → component mounts → `useSuspenseQuery` throws → propagates to the root default error component, which renders the raw error message/stack.

**Impact** — Internal Convex error text (which can include function names, internal messages) is shown to anonymous catalogue visitors. The loader's try/catch is dead with respect to its stated purpose: swallowing the loader error makes no observable difference because the component re-throws identically. The "never leak internal errors" project contract is violated.

**Fix** — Add an `errorComponent` to the route (rendering `ApiNotFound` or a friendly retry card), or wrap `ApiDetailBody` in an `ErrorBoundary` that degrades to a skeleton + retry. At minimum the loader's misleading comment must match reality.

---

### [P2] Stale `TryItPanel` state across project navigation

**Location** — `ApiDetailPage` (lines 197–205) → `ApiDetailBody` (lines 207–355) → `TryItPanel` (lines 364–762)

```tsx
function ApiDetailPage() {
  const { orgSlug, projectSlug } = Route.useParams();
  return (
    ...
        <Suspense fallback={<ApiDetailBodySkeleton />}>
          <ApiDetailBody orgSlug={orgSlug} projectSlug={projectSlug} />
        </Suspense>
    ...
  );
}
```

```tsx
  const [result, setResult] = useState<PlayResult | null>(null);
  ...
  const [bodyText, setBodyText] = useState("{\n  \n}");
  const [headersText, setHeadersText] = useState("");
```

**Problem** — TanStack Router reuses the same route component instance across param changes (no remount). `ApiDetailBody` refetches via `useSuspenseQuery` and `endpoints` recomputes, but `TryItPanel`'s internal state — `result`, `bodyText`, `headersText`, `endpointId`, `mock` — is **never reset** when `orgSlug`/`projectSlug` change. Navigating from project A's detail to project B's detail (client-side) displays project A's last response body, headers, and body text on project B's page.

**Impact** — A visitor who sent a request to API A, then clicks through to API B, sees A's response under B's "Try it" tab. Confusing at best; misleading if the response looks like it came from B. The `endpointId` self-heals via the `endpoints.find(...) ?? endpoints[0]` fallback, but `result` and `bodyText` do not.

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

---

### [P2] Unbounded `result.body` rendered verbatim — tab freeze + internal leak

**Location** — `onSend` (lines 588–625) + result render (lines 717–722)

```tsx
      const res = await fetch(requestUrl, init);
      const text = await res.text();
      ...
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

**Problem** — `await res.text()` reads the entire response into a string with no size cap. The body is then stored in React state and rendered as a text child of `<pre>`. A multi-megabyte response (e.g., an upstream API returning a large JSON dump, or a misbehaving gateway returning a huge HTML error page) is fully allocated and committed to the DOM, which can freeze or crash the tab. Additionally, non-2xx gateway/upstream error bodies (which may contain internal paths, hostnames, or stack traces) are displayed verbatim — the route sanitizes network errors via `humanError` but shows the response body raw.

**Impact** — Playground self-DoS on large responses; potential internal-info leak when the gateway/upstream returns an error body with internals.

**Fix** — Truncate before storing:

```suggestion
      const text = await res.text();
      const MAX_BODY = 65_536;
      const body =
        text.length > MAX_BODY
          ? `${text.slice(0, MAX_BODY)}\n… (${text.length} bytes, truncated)`
          : text;
      setResult({
        status: res.status,
        statusText: res.statusText,
        ms,
        body,
        mock,
      });
```

---

### [P2] Incomplete list→detail view-transition morph — price chip is one-sided

**Location** — `ApiDetailBody` price span (lines 295–303) vs. list card `apps/web/src/routes/catalogue/index.tsx:488–493`

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

List side (separate file, for reference):
```tsx
              {priceLabel ? (
                <Badge
                  variant="outline"
                  className="font-mono"
                  style={{
                    viewTransitionName: `api-price-${item.slug}`,
                  }}
                >
                  {priceLabel}
                </Badge>
              ) : null}
```

**Problem** — The list card declares `viewTransitionName: api-price-${item.slug}` on the price badge, but the detail page's price span has **no matching `viewTransitionName`**. The title morphs correctly (`api-title-${slug}` exists on both sides), but the price element is orphaned. Per the project UI rule ("every list→detail nav ships view-transition morph or written reason"), this morph is half-shipped. During navigation the browser animates the list badge out with no target to morph into, producing a visible snap/fade glitch.

**Impact** — Broken/partial view transition on every list→detail navigation; violates the documented UI contract.

**Fix** — Add the matching name to the detail's price span:

```suggestion
                  <span
                    className="tabular-nums text-foreground"
                    style={{
                      viewTransitionName: `api-price-${data.project.slug}`,
                    }}
                  >
                    {priceRange}
                  </span>
```

---

### [P2] `view-transition-name` key not globally unique — collision across orgs

**Location** — `ApiDetailBody` h1 (lines 264–269)

```tsx
            <h1
              className="text-3xl font-semibold tracking-tight"
              style={{
                viewTransitionName: `api-title-${data.project.slug}`,
              }}
            >
              {data.project.name}
            </h1>
```

**Problem** — Project slugs are unique **per org** (schema index `by_org_slug` on `organizationId` + `slug` in `convex/catalogue.ts:236–240`), not globally. The VT name `api-title-${data.project.slug}` (and the matching `api-title-${item.slug}` on the list card) uses the project slug alone. When the catalogue list contains two projects with the same slug from different orgs, **both list cards get the same `view-transition-name`**, which violates the View Transition API's uniqueness requirement — the browser drops the transition for that name and logs a `TypeError`. The morph from list→detail then snaps instead of animating for any duplicate-slugged project.

**Impact** — View-transition morph silently breaks whenever duplicate project slugs co-exist on the list page. No functional data loss, but the UX contract is violated and the failure is silent.

**Fix** — Include the org slug in the VT name on both sides:

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

(The list card in `index.tsx` must use the same key — cross-file change.)

---

### [P3] Hardcoded `1500ms` timeout instead of motion tokens

**Location** — `onCopyCurl` (line 622)

```tsx
      window.setTimeout(() => setCopiedCurl(false), 1500);
```

**Problem** — The copy-feedback reset uses a magic `1500ms`. The project rule says all animation/timing values live in `src/lib/motion.ts`; `DUR` already exports `instant` (150ms), `fast` (250ms), `base` (350ms). A 1500ms reset has no token and is the only place this value appears.

**Impact** — Drift risk; no single source of truth for feedback timing.

**Fix** — Use a token (e.g., define a `feedback` duration in `motion.ts` or reuse an existing one).

---

### [P3] Raw `<textarea>` / `<select>` instead of shadcn `Textarea` / `Select`

**Location** — `TEXTAREA_CLASS` constant (lines 19–21), headers/body textareas (lines 698–712, 722–732), endpoint `<select>` (lines 663–679)

```tsx
const TEXTAREA_CLASS =
  "flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";
```

**Problem** — `apps/web/src/components/ui/textarea.tsx` and `select.tsx` both exist, and the sibling catalogue index route (`index.tsx:26`) imports shadcn `Select`. This detail route bypasses both, hand-rolling a `TEXTAREA_CLASS` constant and a raw `<select>` with inline class strings. The project UI rule mandates stock shadcn unmodified; the hand-rolled textarea class will drift from `Textarea`'s base styles whenever the design token changes.

**Impact** — Style drift; two textarea implementations in the same feature area.

**Fix** — Replace raw `<textarea>` with `<Textarea>` and the raw `<select>` with shadcn `<Select>`.

---

### [P3] `head` title uses URL slug, not the project display name

**Location** — `head` (lines 73–84)

```tsx
  head: ({ params }) => ({
    meta: [
      {
        title: `${params.projectSlug} · Catalogue · Zevium`,
      },
```

**Problem** — The loader fetches the project but returns `undefined` (it only calls `ensureQueryData`/`prefetchQuery` and returns nothing), so `head` cannot access `loaderData`. The browser tab and SEO title show the kebab-case slug (`weather-api`) instead of the display name (`Weather API`). The data is one `await` away but never surfaced to `head`.

**Impact** — Suboptimal SEO/social-share title for every catalogue detail page.

**Fix** — Return the fetched project name from the loader (at least on SSR) and reference it via `loaderData` in `head`.

---

### [P3] Duplicated gateway-base resolution — `DEFAULT_GATEWAY` / `gatewayBaseUrl()` shadows the lib helper

**Location** — `DEFAULT_GATEWAY` + `gatewayBaseUrl()` (lines 14, 85–91) vs. `resolveGatewayOrigin` in `#/lib/landing`

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

**Problem** — `gatewayBaseUrl()` reimplements the same env-read + trailing-slash-strip logic as `resolveGatewayOrigin` in `#/lib/landing`, but with a different fallback (`.../gateway` vs. bare origin). Two constants, two fallbacks, one env var — if one fallback drifts, the try-it URL and the MCP config silently disagree. Also: if `VITE_GATEWAY_URL` is unset in production, both silently fall back to `http://localhost:8787`, which is never correct for a deployed environment and fails with no diagnostic.

**Impact** — Configuration fragility; silent breakage on misconfigured production deploys.

**Fix** — Consolidate into a single lib helper that returns both the origin and the gateway base; fail loud (or surface a UI banner) when the env var is missing in a production build.

---

## Summary

| sev | count |
|---|---|
| P0 | 0 |
| P1 | 1 |
| P2 | 4 |
| P3 | 4 |

**Top 3:**

1. **No error boundary** (P1) — `useSuspenseQuery` errors reach the root default error component, leaking internal Convex error text to anonymous visitors; the loader's "don't leak raw errors" comment is unfulfilled.
2. **Stale `TryItPanel` state across navigation** (P2) — navigating between detail pages reuses the component instance; the previous project's response body, headers, and body text persist into the next project's view.
3. **Unbounded `result.body`** (P2) — `res.text()` with no cap allocates and renders arbitrarily large response bodies, enabling self-DoS and leaking gateway/upstream error internals verbatim.

No XSS found: all spec-sourced content (`path`, `summary`, `method`, `description`, `tags`, `deprecationMessage`) and all response bodies are rendered as React text children (auto-escaped); no `dangerouslySetInnerHTML`. No raw Tailwind colors — all classes use semantic tokens (`bg-background`, `text-muted-foreground`, `border-warning/40`, `bg-destructive/10`). No slug injection — URL params are validated against the `by_org_slug` Convex index before use in gateway URLs; child components receive DB-validated `data.org.slug`/`data.project.slug`, not raw route params.
