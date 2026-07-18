# Tiger Deep Review — Auth/Bootstrap Trio + Hooks

**Scope:** `apps/web/src/hooks/use-active-org-slug.ts`, `apps/web/src/hooks/use-mobile.ts`, `apps/web/src/hooks/use-ensure-mirror.ts`, `apps/web/src/lib/ensure-mirror.ts`, `apps/web/src/lib/clerk-client.ts`, `apps/web/src/lib/convex-api.ts`, `apps/web/src/lib/auth-session.ts` — plus the backing Convex modules `convex/users.ts` and `convex/organizations.ts` (and `convex/lib/auth.ts` for context).

**Prior reviews:** hooks (2 P2 + 1 P3), ensure-mirror (2 P1 + 4 P2 + 4 P3), clerk-client (1 P1 + 3 P3). **Verified and expanded below.** No praise.

---

## Verdict

**FAIL.** The auth/bootstrap surface has one systemic defect — **non-atomic read-then-write "ensure" mirrors on non-unique Convex indexes** — that is reachable from three independent call-paths (SSR `ensureMirrorOnServer`, client `useEnsureMirror`, Clerk webhook `upsertFromClerk`) and, once triggered, **permanently breaks** the mirror for that user/org (`.unique()` throws `NonUniqueError` on every subsequent call) until manual DB cleanup. Layered on top: a stale-auth window in the client Clerk reader that can report a signed-out user as authenticated, two `method: "GET"` server fns returning authenticated identity with no `Cache-Control`, a redirect-on-any-failure pattern that boots every user during a Clerk blip, client-supplied org slugs persisted without JWT-claim validation (cross-tenant `by_slug` collision), and pervasive write-amplification (every SSR load + every Clerk org-object refresh = patch writes on user + org + wallet-ensure). Ship-blocker for any multi-tenant production rollout.

---

## File Stats

| File | LoC | Findings |
|---|---|---|
| `apps/web/src/hooks/use-active-org-slug.ts` | 22 | 3 |
| `apps/web/src/hooks/use-mobile.ts` | 23 | 3 |
| `apps/web/src/hooks/use-ensure-mirror.ts` | 53 | 6 |
| `apps/web/src/lib/ensure-mirror.ts` | 116 | 9 |
| `apps/web/src/lib/clerk-client.ts` | 70 | 6 |
| `apps/web/src/lib/convex-api.ts` | 6 | 2 |
| `apps/web/src/lib/auth-session.ts` | 36 | 6 |
| `convex/users.ts` | 76 | 5 |
| `convex/organizations.ts` | 142 | 8 |
| **Total** | | **48** |

---

## Findings

### `apps/web/src/hooks/use-active-org-slug.ts`

#### [P2] Mutable slug used as canonical org key — drift window breaks org-scoped queries
```ts
const orgSlug =
  organization && typeof organization.slug === "string"
    ? organization.slug
    : null;
```
`organization.slug` is **mutable** in Clerk (org admins can rename the slug). The Convex `organizations` table uses `by_slug` as the primary lookup index for every org-scoped query (`getOrgBySlug`, `requireOrgMemberBySlug`, notification-bell, projects list). Between a Clerk slug change and the next `ensureOrganization` patch run (which only fires from `useEnsureMirror` on org-object reference change or from the SSR `ensureMirrorOnServer` on `/app/projects` full load), the live Clerk slug ≠ stored Convex slug → every `by_slug` query silently returns null → empty UI / "Organization not found". On routes that don't run `ensureMirrorOnServer`, the drift persists until the user navigates to `/app/projects` (SSR) or the org object refreshes enough to re-fire the hook.
**Impact:** Silent data disappearance org-wide after any Clerk slug rename; no detection.
**Fix:** Either drive org lookups by `clerkOrgId` (immutable) instead of slug, or make the slug-change path explicitly trigger a mirror patch (webhook `organization.updated` → `upsertFromClerk`).

#### [P3] Returns a fresh object literal every call — breaks consumer memoization
```ts
return { orgSlug, isLoaded };
```
No `useMemo`. Any consumer wrapped in `React.memo` that receives this as a prop re-renders every parent render. `notification-bell.tsx:75` destructures inline so it's fine there, but the hook's contract is "stable selector output" and it isn't.
**Fix:** `useMemo(() => ({ orgSlug, isLoaded }), [orgSlug, isLoaded])` or migrate to `useMemo`/`useSyncExternalStore` selector pattern.

#### [P3] Conflates "no org selected" with "org has no slug yet"
Both states return `{ orgSlug: null, isLoaded: true }`. A freshly-created Clerk org can briefly have `slug === null` while Clerk generates it. Consumers (`NotificationBell`) render the "Select an organization" disabled state for both, wrongly telling a user who *has* an org (slug pending) to select one.
**Fix:** Surface a third state (`slug: null, slugPending: true`) or distinguish via `organization` presence.

---

### `apps/web/src/hooks/use-mobile.ts`

#### [P3] `onChange` reads `window.innerWidth` instead of `mql.matches` — divergent truth source
```ts
const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
const onChange = () => {
  setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
};
```
The media query string (`max-width: 767px`) and the JS comparison (`innerWidth < 768`) are two separate expressions of the same breakpoint. They agree today, but editing one without the other silently drifts. `mql.matches` is the single source of truth the listener was registered against.
**Fix:** `setIsMobile(mql.matches)`.

#### [P3] Initial `undefined` collapsed to `false` — desktop layout flash on mobile
```ts
const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);
...
return !!isMobile;
```
First render (SSR + client hydration) returns `false`. The `setIsMobile` in the effect runs *after* paint. On an actual mobile device, the first committed frame renders the desktop sidebar layout, then flips to mobile on the next tick. The `undefined` sentinel (intended to mean "not yet measured") is destroyed by `!!` before callers can use it to render a layout-stable skeleton — violating the project rule "loading = layout-stable skeletons".
**Fix:** Expose a tri-state (`true | false | undefined`) and let `SidebarProvider` render a stable skeleton during `undefined`, or initialize from a CSS-media-query-derived value via `useSyncExternalStore` with a server snapshot of `false`.

#### [P3] `MOBILE_BREAKPOINT = 768` magic number duplicates shadcn sidebar's internal constant
Not imported/shared; if shadcn's sidebar breakpoint or this constant diverges, the hook's `isMobile` will disagree with the sidebar's own mobile detection (`sidebar.tsx:69` uses `useIsMobile()` to drive `openMobile`), causing the provider state and CSS media queries to disagree.
**Fix:** Import from a shared `lib/breakpoints.ts` or read from shadcn's exported constant.

---

### `apps/web/src/hooks/use-ensure-mirror.ts`

#### [P2] `ranFor.current = null` on failure cannot trigger retry — confirmed and expanded
```ts
ranFor.current = key;          // set BEFORE async
...
} catch (err) {
  console.warn("[ensureUser] failed:", err);
  ranFor.current = null;        // ref mutation
  return;
}
```
`ranFor` is a `useRef`; mutating it does not change any effect dependency. The "Allow retry on next effect" comment is a **contract that cannot fire** — retry only happens if `isSignedIn`, `userId`, `organization`, `convexAuthLoading`, or `isAuthenticated` changes. A transient Convex blip during `ensureUser` leaves `ranFor.current = null` and the effect never re-runs; the user stays un-mirrored until they switch org or reload. Prior review flagged this; confirming and noting the same bug recurs in the `ensureOrganization` catch block.

#### [P2] Sole mirror path for non-`/app/projects` routes — transient failure = un-mirrored user
`ensureMirrorOnServer` is only called from `routes/app/projects/index.tsx:40` (SSR branch). Every other `/app/*` route relies **solely** on this client hook for mirroring. A transient `ensureUser` or `ensureOrganization` failure (network, Convex 5xx, JWT not yet valid) → org row never created → all org-scoped Convex queries on that route throw "Organization not found" / "Not authenticated" → InternalServerError UI with no recovery path. The soft-fail design has no escalation.

#### [P2] `organization` whole-object in dep array → write-amplification on every Clerk org refresh
```ts
}, [convex, isSignedIn, userId, organization, convexAuthLoading, isAuthenticated]);
```
Clerk's `useOrganization()` returns a new `organization` object reference whenever **any** field changes (`membersCount`, `name`, `imageUrl`, `slug`, pending invites, etc.). Each reference change re-fires the effect → re-calls `ensureUser` (patch) + `ensureOrganization` (patch + `ensureWallet` no-op). On an active team, this is continuous patch writes to Convex for unchanged data. Dep should be the identity primitives only: `[organization?.id, organization?.slug, organization?.name, organization?.imageUrl]`.

#### [P2] `ensureOrganization` failure resets `ranFor.current = null` → next run re-mirrors the already-mirrored user
```ts
} catch (err) {
  console.warn("[ensureOrganization] failed:", err);
  ranFor.current = null;
}
```
By the time `ensureOrganization` runs, `ensureUser` has already succeeded. Resetting the shared dedup key conflates user-mirror state with org-mirror state — the next effect run re-calls `ensureUser` (redundant patch write amplification) even though the user row is current. Should use two independent refs (`ranUserFor`, `ranOrgFor`) keyed on `userId` and `orgId` respectively.

#### [P3] Closure-captured `organization` is stale if org switches mid-mutation
The async IIFE captures `organization` at effect-fire time. If the user switches org A→B while `ensureUser` is in flight, the in-flight chain still calls `ensureOrganization` with org A's id/name/slug after the user has already moved to B. Harmless for A (it gets mirrored) but B's mirror is delayed until the effect re-fires under the new `organization` reference. No cancellation/AbortController.

#### [P3] `console.warn` leaks to production console
`[ensureUser] failed:` / `[ensureOrganization] failed:` ship to browser console in prod. Should route through `humanError` or a gated logger.

---

### `apps/web/src/lib/ensure-mirror.ts`

#### [P1] SSR + client concurrent ensure → duplicate rows on non-unique Convex indexes → permanent mirror breakage
```ts
// SSR loader (/app/projects SSR branch):
const mirror = await ensureMirrorOnServer();   // calls api.users.ensureUser + api.organizations.ensureOrganization
// Concurrently on client mount:
useEnsureMirror();                              // calls the SAME mutations
```
Both `ensureUser` and `ensureOrganization` do read-then-write:
```ts
const existing = await ctx.db.query("users").withIndex("by_clerk_user", ...).unique();
if (existing === null) { return await ctx.db.insert("users", { ... }); }
```
Convex `unique()` is a **query helper**, not a DB-level unique constraint. Two concurrent calls (SSR loader + client mount hook fire near-simultaneously on first load) both observe `existing === null` and both `insert`. The `by_clerk_user` / `by_clerk_org` indexes are plain indexes — duplicates persist. **After duplication, every subsequent `.unique()` call throws `NonUniqueError`** → `ensureUser`/`ensureOrganization` throw permanently → the mirror is broken for that user/org until manual DB cleanup. The same race exists between the Clerk webhook (`upsertFromClerk`) and the client/SSR ensure paths. This is the root-cause P1; the per-layer duplicates in `convex/users.ts` and `convex/organizations.ts` are the same bug at the storage layer.
**Impact:** One-time race → permanent data-loss-shaped breakage for the affected user/org; requires Convex dashboard cleanup.
**Fix:** Convex has no native unique indexes. Either (a) serialize ensures via a single owner (e.g. drop the SSR path and rely solely on `useEnsureMirror` with a mutex, or vice-versa), or (b) use a Convex action with an idempotency row + `insertIfAbsent` pattern, or (c) make `ensureUser`/`ensureOrganization` tolerant of duplicates (use `.take(1)` instead of `.unique()` and patch the first).

#### [P1] Unconditional patch write-amplification on every SSR load
```ts
await client.mutation(api.users.ensureUser, {});          // patches name/email even if unchanged
...
await client.mutation(api.organizations.ensureOrganization, { ... });  // patches name/slug/imageUrl every call
```
Every SSR navigation to `/app/projects` (full page load) fires both mutations, each of which **always patches** the existing row with JWT-derived values regardless of whether anything changed. Convex write quota + reactive query invalidation (every patch triggers all `users`/`organizations` subscribers) on every page load. Prior review flagged this; confirming and noting the cost compounds with the `organization`-object dep issue in the hook (client side also re-patches on every Clerk org refresh).

#### [P2] `name = orgSlug` on Clerk API failure — silent data corruption
```ts
let name = orgSlug;
try {
  const org = await (await clerkClient()).organizations.getOrganization({ organizationId: orgId });
  if (typeof org.name === "string" && org.name.length > 0) { name = org.name; }
  ...
} catch {
  // Clerk lookup optional — slug is enough for mirror row.
}
await client.mutation(api.organizations.ensureOrganization, { clerkOrgId: orgId, name, slug: orgSlug, imageUrl });
```
On any Clerk Backend API failure (5xx, rate-limit `429`, network blip, transient auth), `name` persists as the **slug** — corrupting the org's display name in Convex on both the insert AND the patch path. The webhook `upsertFromClerk` would eventually correct it, but only if a Clerk org event fires afterward; until then every UI surface showing `org.name` displays the slug. The comment "slug is enough for mirror row" conflates row existence with row correctness.
**Fix:** On Clerk lookup failure, either skip the `ensureOrganization` call entirely (leave the row to be created by the webhook) or omit `name` from the patch (patch only `clerkOrgId`+`slug`), or `name: existing?.name ?? orgSlug` (only use slug as a last-resort seed for NEW rows, never as a patch overwrite).

#### [P2] JWT-over-webhook drift — client/SSR patches overwrite webhook-driven source of truth
The webhook path (`upsertFromClerk`) is the authoritative mirror of Clerk state. The client/SSR `ensureOrganization` patches `name`/`slug`/`imageUrl` from the **JWT/session**, which lags Clerk by up to one token lifetime (5 min default) and may carry stale values. If a Clerk admin renames the org, the webhook updates Convex; a subsequent SSR `ensureOrganization` with a stale session name **patches it back**. Two writers, no last-writer-wins discipline.
**Fix:** Either (a) make `ensureOrganization` patch ONLY fields absent from the Convex row (don't overwrite existing non-null values from JWT data), or (b) delete the client/SSR `ensureOrganization` path entirely and rely solely on webhooks + a "create-if-absent" seed.

#### [P2] `ConvexHttpClient` never closed — WebSocket leak per SSR call
```ts
const client = new ConvexHttpClient(convexUrl);
client.setAuth(token);
try { ... } catch { ... }
// no client.close() / void client.close()
```
`ConvexHttpClient` holds a long-lived WebSocket to Convex. The client is created per `ensureMirrorOnServer` call (every SSR `/app/projects` load) and never closed. The underlying WebSocket has open listeners → not GC-eligible → leaks until the Node.js process hits its socket limit. Under SSR traffic this accumulates fast.
**Fix:** `try { ... } finally { void client.close(); }` or reuse a module-level singleton client.

#### [P2] `error` field computed and discarded — dead telemetry, silent failures
```ts
// ensure-mirror.ts returns { ..., error: "ensureUser: ..." }
// caller (projects/index.tsx):
try {
  const mirror = await ensureMirrorOnServer();
  if (!mirror.mirrored) return;
  ...
} catch {
  // Auth redirect or missing org — component handles empty/loading UI.
}
```
The `error` field is computed (with `err.message` from Convex internals), returned, and **never read by any caller** — the loader only checks `mirror.mirrored`. The outer `catch {}` is empty. So every mirror failure is silently dropped with zero logging. No alerting, no debuggability. The "soft-fail — client useEnsureMirror is fallback" design assumes someone notices the failure; nobody can.
**Fix:** Either log `mirror.error` server-side (`console.error` / telemetry) or delete the field and let the error propagate to the loader's catch for structured handling.

#### [P3] `getToken({ template: "convex" })` returning null is a fatal config error treated as soft-fail
```ts
const token = (await session.getToken({ template: "convex" })) ?? null;
if (!token) { return { ..., error: "no convex JWT" }; }
```
A missing `convex` JWT template in Clerk is a **deployment misconfiguration**, not a transient failure. The soft-fail means mirror NEVER happens in that environment, silently — every authed Convex query 500s and nobody knows why. Should be a loud server-side log at minimum.

#### [P3] `(await clerkClient())` per-call — no client reuse
```ts
const org = await (await clerkClient()).organizations.getOrganization({ organizationId: orgId });
```
`clerkClient()` returns a fresh backend API client each call. On every SSR load a new Clerk SDK client is constructed. Minor perf/cost.

#### [P3] `convexUrl` validation is shallow
```ts
if (typeof convexUrl !== "string" || convexUrl.length === 0) { return { ..., error: "missing VITE_CONVEX_URL" }; }
```
A non-URL string (e.g. `"localhost"`) passes this check and fails later inside `ConvexHttpClient` with a less actionable error.

#### [P3] `method: "GET"` server fn performs state-changing mirror mutations as a side-effect
`ensureMirrorOnServer` is declared `createServerFn({ method: "GET" })` but inserts/patches Convex rows. GET-with-side-effects is a REST anti-pattern and the response is cacheable by intermediaries (CDN/browser). Even though the result is currently discarded, the RPC URL is cacheable. Tie into the auth-session.ts P1 about GET caching.

---

### `apps/web/src/lib/clerk-client.ts`

#### [P1] Stale-auth fallback: signed-out user reported as authenticated via SSR context
```ts
const userId =
  (typeof clerk?.user?.id === "string" ? clerk.user.id : null) ??
  fallback.userId ??
  null;
```
After a client-side sign-out, Clerk sets `window.Clerk.user = null` synchronously. But `fallback.userId` is the **SSR-context userId** (set at initial page load via `__root.tsx` `fetchConvexAuth`, then re-circulated through `context.userId` which is itself populated by a prior `readClientClerkAuth` call). So after sign-out: `clerk.user` is null → `?? fallback.userId` → the **old** userId is returned. A signed-out user navigating client-side to `/app` passes the `readClientClerkAuth` guard in `app.tsx:27` and sees the app shell before Convex queries fail. Worse: the root `beforeLoad` re-uses its own prior output as `context`, so the staleness is **self-reinforcing** — once a stale userId enters the context, it persists across navigations.
**Impact:** Stale-auth window; post-sign-out access to the app shell (authed data fetches fail, but UI/flashes expose layout).
**Fix:** When `window.Clerk` is defined, treat its `user: null` as authoritative — do NOT fall back to SSR context for that field. Only fall back when `window.Clerk` is `undefined` (script not yet loaded). Distinguish "Clerk loaded and says signed-out" from "Clerk not yet loaded".

#### [P2] Inconsistent live-vs-fallback field mixing yields impossible auth snapshots
The `??` fallback is applied per-field. If `window.Clerk` exists but `clerk.user` is null (signed out) while `clerk.organization` is still populated (stale org cache), the function returns `userId: fallback.userId` (stale) but `orgId: clerk.organization.id` (live) — a **signed-out user with a live org**. Callers cannot detect this partial-staleness; `app.tsx` and `admin.tsx` only check `userId`. The three fields should be atomically sourced from the same provider.

#### [P3] `session: unknown` dead field
```ts
export interface ClientClerk {
  user: ClientClerkUser | null | undefined;
  organization: ClientClerkOrganization | null | undefined;
  session: unknown;   // never read anywhere
}
```
Grep confirms no `.session` access on a `ClientClerk`-typed value. Delete.

#### [P3] Hand-rolled `ClientClerk` type shadows Clerk SDK types
Clerk ships `@clerk/types` with a `Clerk` interface for `window.Clerk`. This minimal re-definition loses type safety and will silently diverge from the SDK as Clerk evolves. Either `import type { Clerk } from "@clerk/types"` and `declare global { interface Window { Clerk?: Clerk } }`, or confine the narrow read to a helper that casts.

#### [P3] Inconsistent empty-string guard
```ts
// orgSlug: empty string rejected
(typeof liveSlug === "string" && liveSlug.length > 0 ? liveSlug : null)
// userId / orgId: empty string accepted
(typeof clerk?.user?.id === "string" ? clerk.user.id : null)
```
An empty-string `user.id` or `organization.id` (shouldn't happen but defensive code should be consistent) is treated as a valid identity. Pick one rule.

#### [P3] `ClientClerkAuthFallback` types `userId?: string | null` but all callers pass `string | null`
The `?:` implies a third `undefined` state; every call-site (`__root.tsx:58`, `app.tsx:27`, `admin.tsx:19`) passes `context.userId` which is `string | null`. The optional-typing muddies the contract. Make it `userId: string | null` (required) or actually handle `undefined`.

---

### `apps/web/src/lib/convex-api.ts`

#### [P3] Brittle 4-level relative path crossing workspace boundary
```ts
export { api } from "../../../../convex/_generated/api";
```
Crosses from `apps/web/src/lib/` up through `apps/web/src/`, `apps/web/`, `apps/` to repo-root `convex/`. Any monorepo restructure (renaming `apps/web`, moving `convex/`) breaks silently. The repo already has a `#/` alias for `apps/web/src/`; add a `#/convex` or `#convex` alias to the generated api.

#### [P3] Pure re-export indirection adds a file with no value
The file re-exports `api` verbatim. Either the alias above removes the need, or call-sites should import from the generated path directly. The indirection obscures where `api` actually lives.

---

### `apps/web/src/lib/auth-session.ts`

#### [P1] `method: "GET"` server fns returning authenticated identity with no `Cache-Control`
```ts
export const requireAuth = createServerFn({ method: "GET" }).handler(
  async (): Promise<AuthSession> => {
    const session = await auth();
    if (!session.userId) { throw redirect({ to: "/sign-in/$" }); }
    return { userId: session.userId };   // authenticated identity, GET response
  },
);
```
`method: "GET"` opts the server fn into HTTP GET, whose responses are cacheable by intermediaries (CDN, browser, proxy) by default. The payload `{ userId: "user_..." }` is authenticated identity. Without an explicit `Cache-Control: no-store`, a misconfigured CDN or browser cache could serve User A's `userId` to User B. `getAuthOrg` (dead, but same pattern) has the same issue and returns org claims too. Prior review flagged this; confirming and locating the fix here (not in clerk-client.ts).
**Fix:** Either (a) use `method: "POST"` (default — non-cacheable), or (b) set `response.headers.set("Cache-Control", "no-store")` explicitly, or (c) since the return value is discarded by all call-sites, make these `void` guard-only fns.

#### [P1] `requireAuth` converts every `auth()` failure into a sign-in redirect — masks transient Clerk outages
```ts
// requireAuth:
if (!session.userId) { throw redirect({ to: "/sign-in/$" }); }
// call-sites (app.tsx:37-46, admin.tsx:29-36):
try { await requireAuth(); }
catch (err) {
  if (err && typeof err === "object" && "to" in err) { throw err; }
  throw redirect({ to: "/sign-in/$" });   // ANY non-redirect error → force sign-in
}
```
A transient Clerk backend 5xx, network failure, or rate-limit (429) → `auth()` throws or returns a null-session → `requireAuth` throws redirect → call-site's catch-all converts ANY non-redirect error to a redirect. Result: **every user is kicked to sign-in during any Clerk blip**. No retry, no backoff, no "service unavailable" UI. For a product where Clerk is the sole auth, this turns a 30-second Clerk outage into a mass sign-out event.
**Fix:** Distinguish "no session" (redirect to sign-in) from "auth service error" (throw 503 / render a retry UI). At minimum, catch Clerk SDK errors by class and re-throw non-auth errors as 5xx, not redirects.

#### [P2] Duck-type redirect detection `"to" in err` misclassifies arbitrary errors as redirects
```ts
if (err && typeof err === "object" && "to" in err) { throw err; }
```
TanStack Router exports `isRedirect` (and the redirect has a `__type: "redirect"` discriminator). The `"to" in err` heuristic treats ANY thrown object with a `to` property as a redirect — including Convex errors, third-party SDK errors, or `TypeError`s on objects that happen to have a `to` field. Such errors get re-thrown as if they were redirects, masking the real failure.
**Fix:** `import { isRedirect } from "@tanstack/react-router"` and `if (isRedirect(err)) throw err;`.

#### [P2] `requireAuth` doesn't distinguish no-session / expired-session / Clerk-down
All three → redirect. No token-refresh attempt, no transient-error handling. The function is the sole auth guard for `/app` and `/admin` — it should at minimum separate "never signed in" (redirect) from "session expired" (could refresh via Clerk's `session.touch()`) from "Clerk unreachable" (503).

#### [P3] `getAuthOrg` + `AuthOrgSession` are dead code
Grep across `apps/web/src` confirms **zero callers** of `getAuthOrg`; `AuthOrgSession` is only used as its return type. Delete both. Prior review flagged this; confirming via grep.

#### [P3] `requireAuth` returns `userId` but all call-sites discard it
`app.tsx:38` and `admin.tsx:30` call `await requireAuth()` and ignore the return. The function is used purely for its guard side-effect. The returned `userId` is dead — the actual userId/org used downstream comes from `context` (router context from `__root.tsx`). Either drop the return type to `void`, or have call-sites use the returned `userId` instead of re-reading context (single source of truth).

---

### `convex/users.ts`

#### [P1] Non-atomic read-then-write in `ensureUser` — duplicate rows → permanent mirror breakage
```ts
const existing = await ctx.db.query("users").withIndex("by_clerk_user", q => q.eq("clerkUserId", args.clerkUserId)).unique();
if (existing === null) { return await ctx.db.insert("users", { ... }); }
```
This is the **storage-layer root cause** of the `ensure-mirror.ts` P1 race. `by_clerk_user` is a plain index (Convex has no unique indexes); `.unique()` is a query helper that throws `NonUniqueError` on multiple matches. Two concurrent `ensureUser` calls (SSR + client; or webhook `upsertFromClerk` + client) both observe `existing === null` and both insert → duplicate `clerkUserId` rows → every subsequent `.unique()` throws → mirror permanently broken for that user. Same pattern in `upsertFromClerk`.
**Fix:** Replace `.unique()` with `.take(1)` (returns first match, no throw) and patch the first; or add an explicit idempotency table with a single-row-per-clerkUserId invariant enforced via a sentinel row; or accept duplicates and have readers use `.take(1)` everywhere (fragile).

#### [P2] `ensureUser` unconditionally patches `name`/`email` — write-amplification
```ts
await ctx.db.patch(existing._id, { name, email });
```
Every app boot, every SSR load, every org-switch (via the hook's `organization`-dep re-fire) → patch write to the `users` row even when `name`/`email` are unchanged. Each patch invalidates all `users`-table reactive subscribers. Should patch only when values actually differ.

#### [P2] `upsertFromClerk` (webhook) and `ensureUser` (client) both write `name`/`email` — drift
Both paths write the same fields from different sources (webhook payload vs JWT identity). A client `ensureUser` with a stale JWT (name/email lag Clerk by token lifetime) can clobber a webhook-driven update. No last-writer-wins discipline, no field-level merge.

#### [P3] `identity.email ?? ""` stores empty string when email absent
Lossy. Downstream email-driven features (notifications, gravatar, gravatar-based avatars) silently break. Should be `null` or omit the field.

#### [P3] `name` fallback chain ends at the string `"User"`
```ts
const name = identity.name || joinedName || identity.nickname || identity.email || "User";
```
The literal `"User"` leaks into the UI as a placeholder if Clerk has no name. Should be `null` and let the UI render a fallback. Also `identity.email` as a name fallback exposes the email in places where only a display name should show.

---

### `convex/organizations.ts`

#### [P1] `ensureOrganization` persists client-supplied `slug` without JWT-claim validation — cross-tenant `by_slug` collision
```ts
export const ensureOrganization = mutation({
  args: { clerkOrgId: v.string(), name: v.string(), slug: v.string(), imageUrl: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const claims = await requireIdentity(ctx);
    if (claims.orgId === undefined || claims.orgId !== args.clerkOrgId) { throw ... }
    // args.slug is NOT validated against claims.orgSlug
    ...
    await ctx.db.patch(existing._id, { name: args.name, slug: args.slug, imageUrl: args.imageUrl });
```
The `clerkOrgId` check guards org identity, but `args.slug` is accepted verbatim from the client and persisted to the `by_slug` index — the index used by `getOrgBySlug` / `requireOrgMemberBySlug` / `notification-bell` / `projects.list`. A malicious client can pass **another org's slug** → two organizations end up with the same slug → `getOrgBySlug` (which uses `.unique()`!) either throws `NonUniqueError` or returns the wrong org → **cross-tenant data confusion**. The JWT carries `org_slug`; the handler must assert `args.slug === claims.orgSlug`.
**Impact:** Cross-tenant slug collision → wrong-org data served to authenticated users; `by_slug` uniqueness assumption violated org-wide.
**Fix:** Add `if (claims.orgSlug !== undefined && claims.orgSlug !== args.slug) throw new Error("slug mismatch");` and prefer `claims.orgSlug` over `args.slug` for the write.

#### [P2] `ensureOrganization` unconditionally patches `slug` — stale-JWT slug clobbers webhook-driven rename
```ts
await ctx.db.patch(existing._id, { name: args.name, slug: args.slug, imageUrl: args.imageUrl });
```
If a Clerk admin renames the org (slug changes), the webhook `upsertFromClerk` updates Convex with the new slug. A subsequent client `ensureOrganization` carrying a **stale JWT** (old slug) patches the slug **back** to the old value → breaks every `by_slug` lookup org-wide until the webhook fires again. This is the org-layer manifestation of the JWT-over-webhook drift. Should not overwrite a non-null `slug` from JWT data.

#### [P2] `ensureWallet` read-then-write race — duplicate wallets per org
```ts
async function ensureWallet(ctx, organizationId) {
  const existing = await ctx.db.query("wallets").withIndex("by_organization", ...).unique();
  if (existing !== null) return existing._id;
  return await ctx.db.insert("wallets", { organizationId, balance: 0, sequence: 0 });
}
```
Same non-atomic read-then-write pattern. Concurrent `ensureOrganization` calls (SSR + client) both see no wallet, both insert → duplicate wallets. `by_organization` `.unique()` then throws on every subsequent read → wallet/balance queries broken org-wide. Called from both `upsertFromClerk` and `ensureOrganization` (which fire concurrently). Same root cause as the users.ts P1.

#### [P2] `deleteFromClerk` cascade is incomplete — orphans all org-owned data
```ts
// deletes walletEntries + wallet + organization, but NOT:
// - projects, keys, webhooks, specs, specVersions, usageEvents, payouts, notifications, ...
```
Orphans every org-owned table. Also the `for (const entry of entries) await ctx.db.delete(entry._id);` loop is O(n) sequential deletes — Convex mutation size/time limits could be hit for orgs with many wallet entries, leaving the delete half-done (wallet deleted, some entries orphaned, then timeout). Should batch or use a scheduled job.

#### [P2] `listMine` returns at most one org — misleading name + incomplete for multi-org users
```ts
export const listMine = query({ args: {}, handler: async (ctx) => {
  const claims = await requireIdentity(ctx);
  if (claims.orgId === undefined) return [];
  const org = await ctx.db.query("organizations").withIndex("by_clerk_org", q => q.eq("clerkOrgId", claims.orgId!)).unique();
  return org === null ? [] : [org];
}});
```
Returns only the **active** org from the JWT, not the user's memberships. For users in multiple Clerk orgs, only the active one is visible; the name `listMine` implies membership enumeration. Either rename to `getActiveOrg` or actually enumerate via Clerk org memberships (requires a Clerk API call from an action).

#### [P3] `claims.orgId!` non-null assertion is redundant and suppresses TS narrowing
```ts
if (claims.orgId === undefined) return [];
const org = await ctx.db.query("organizations").withIndex("by_clerk_org", q => q.eq("clerkOrgId", claims.orgId!)).unique();
```
After the `undefined` guard, `claims.orgId` is `string`; the `!` is dead and misleading (implies it could be undefined when it can't be).

#### [P3] `getBySlug` has no auth check — org enumeration by slug
```ts
export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.query("organizations").withIndex("by_slug", q => q.eq("slug", args.slug)).unique();
  },
});
```
Any authenticated Convex caller (any user) can look up any org by slug and receive the full `Doc<"organizations">` (name, imageUrl, clerkOrgId). `requireOrgMemberBySlug` wraps this with a membership check, but `getBySlug` is a exported `query` callable directly by any client → org enumeration + existence disclosure. Should require identity and restrict fields, or be unexported (internal helper).

---

## Summary

**Counts:** P0: 0 · P1: 7 · P2: 17 · P3: 24 · **Total: 48**

**Top 3 (must-fix-before-prod):**

1. **Non-atomic ensure mirrors on non-unique Convex indexes (P1, cross-cutting).** `ensureUser`, `ensureOrganization`, and `ensureWallet` all do read-then-write against plain `.unique()` indexes reachable concurrently from SSR `ensureMirrorOnServer`, client `useEnsureMirror`, and the Clerk webhook `upsertFromClerk`. A single race creates duplicate rows; thereafter `.unique()` throws `NonUniqueError` on every call, permanently breaking the mirror for that user/org until manual DB cleanup. Fix at the storage layer (`.take(1)` + patch-first, or an idempotency sentinel) and collapse the ensure call-paths to one owner.

2. **Slug spoofing in `ensureOrganization` enables cross-tenant `by_slug` collision (P1).** `args.slug` is persisted to the `by_slug` index without validation against the JWT `org_slug` claim. A malicious client can collide slugs across orgs → `getOrgBySlug` (which uses `.unique()`) either throws or returns the wrong org → cross-tenant data confusion org-wide. Validate `args.slug === claims.orgSlug`.

3. **Stale-auth window in `readClientClerkAuth` + GET-cached identity in `auth-session.ts` (P1 × 2).** After client-side sign-out, `readClientClerkAuth` falls back to the SSR-context userId and reports a signed-out user as authenticated (self-reinforcing through router context), giving post-sign-out access to the `/app` shell. Separately, `requireAuth`/`getAuthOrg` are `method: "GET"` server fns returning `{ userId }` with no `Cache-Control: no-store` — cacheable identity payloads. And `requireAuth`'s redirect-on-any-failure pattern boots every user to sign-in during any transient Clerk outage, with no 503/retry path. Fix: authoritative live-Clerk read when `window.Clerk` is defined; `method: "POST"` or `no-store`; distinguish no-session from Clerk-down.

**Cross-cutting themes:** (a) three writers (SSR, client, webhook) to the same mirror rows with no concurrency/consistency discipline; (b) JWT/session data treated as authoritative over webhook data, enabling stale-write-back drift on `name`/`slug`/`email`/`imageUrl`; (c) write-amplification on every SSR load and every Clerk org-object refresh; (d) the mutable Clerk `slug` used as a canonical Convex key despite drift and spoofing risks — prefer the immutable `clerkOrgId` for lookups. (e) `method: "GET"` server fns performing state-changing or identity-bearing work without cache headers.
