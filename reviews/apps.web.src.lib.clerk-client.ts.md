# Tiger Review — `apps/web/src/lib/clerk-client.ts` + `convex-api.ts` + `auth-session.ts`

Reviewed together: the three files form the web app's auth-reading layer
(client-side sync read of `window.Clerk`, the Convex `api` re-export, and the
server-fn auth guards). All three files read in full; call-sites in
`routes/__root.tsx`, `routes/app.tsx`, `routes/admin.tsx` cross-checked.

---

## Verdict

Ship-blocking: no. But the layer is leakier than it looks. One piece of dead
code (`getAuthOrg` + `AuthOrgSession`), one dead interface field
(`ClientClerk.session`), error handling in the route call-sites that converts
*every* `auth()` failure into a sign-in redirect, and a workspace-boundary
crossing via a brittle four-level relative path. No secret-key leakage into the
client bundle was found (verified — see Findings P0 block).

---

## File Stats

| File | LoC | Findings |
|---|---|---|
| `apps/web/src/lib/clerk-client.ts` | 67 | 4 |
| `apps/web/src/lib/convex-api.ts` | 5 | 1 |
| `apps/web/src/lib/auth-session.ts` | 38 | 3 |

Total: 8 findings — P0: 0 · P1: 0 · P2: 3 · P3: 5

---

## Findings

### [SEV: P0] — None

**Secret-key leakage audit (explicit).** None of the three files imports
`CLERK_SECRET_KEY`, `VITE_CONVEX_URL` secrets, or any server env into client
code. `auth-session.ts` imports `auth` from `@clerk/tanstack-react-start/server`
and runs inside `createServerFn` (server-only). `__root.tsx`'s
`session.getToken({ template: "convex" })` returns a short-lived Convex JWT,
not the Clerk secret; that JWT is forwarded only to `serverHttpClient.setAuth`
on the SSR branch and never serialized into the client bundle (client branch
hardcodes `token: null`). `convex-api.ts` re-exports `api`, which is a tree of
function *references* (names + arity), not function implementations or keys.
**Clean.**

---

### [SEV: P2] — `getAuthOrg` / `AuthOrgSession` are dead code

**File:** `apps/web/src/lib/auth-session.ts:9-12, 25-38`

```ts
export interface AuthOrgSession {
  userId: string;
  orgSlug: string | null;
  orgId: string | null;
}
// ...
export const getAuthOrg = createServerFn({ method: "GET" }).handler(
  async (): Promise<AuthOrgSession> => { ... },
);
```

**Problem.** Repo-wide grep for `getAuthOrg` returns exactly one hit — its own
definition. Zero import sites. `AuthOrgSession` likewise has only its definition
hit. The org data it would return (`orgSlug`, `orgId`) is instead read on the
client via `readClientClerkAuth` and on the server via `__root.tsx`'s
`fetchConvexAuth` (which calls `auth()` directly, not `getAuthOrg`).

**Impact.** Two exported symbols with no consumers. Future readers will assume
`getAuthOrg` is the canonical server-side org reader and either (a) start using
it, creating a second code path, or (b) waste time tracing why it's "not wired
up." Either way it rots the contract.

**Fix.** Delete `getAuthOrg`, `AuthOrgSession`, and the
`/** Auth + optional active org (null when none selected). */` comment. If org
data is needed server-side later, `fetchConvexAuth` in `__root.tsx` already
proves the pattern; resurrect then.

---

### [SEV: P2] — Route call-sites mask real `auth()` errors as sign-in redirects

**File:** `apps/web/src/lib/auth-session.ts:15-23` (and consumers
`routes/app.tsx:35-46`, `routes/admin.tsx:27-38`)

```ts
// auth-session.ts
export const requireAuth = createServerFn({ method: "GET" }).handler(
  async (): Promise<AuthSession> => {
    const session = await auth();
    if (!session.userId) {
      throw redirect({ to: "/sign-in/$" });
    }
    return { userId: session.userId };
  },
);
```

```ts
// routes/app.tsx (and admin.tsx, identical shape)
try {
  await requireAuth();
} catch (err) {
  if (err && typeof err === "object" && "to" in err) {
    throw err;
  }
  throw redirect({ to: "/sign-in/$" });
}
```

**Problem.** `auth()` is a network call to Clerk. If Clerk is down, the JWKS
endpoint times out, or the Worker/edge throws, `auth()` rejects with a real
error (not a redirect). The `catch` then converts *any* non-redirect throw into
`redirect({ to: "/sign-in/$" })`. A signed-in user hitting a transient Clerk
outage is silently bounced to sign-in mid-session — and worse, the real error
(JWT verification failure, clock skew, network) is swallowed, so observability
is zero.

**Impact.** (1) Incorrect auth UX during outages: logged-in users see sign-in.
(2) Silent failure: no Sentry/log captures the underlying `auth()` rejection.
(3) The `if ("to" in err)` check is the only discriminator and it's a duck-type
smell — `requireAuth` already throws a `redirect`, so the catch's only real job
is the fallback branch, which is the wrong fallback.

**Fix.** In `auth-session.ts`, let `auth()` rejections propagate — only throw
`redirect` on the explicit `!session.userId` path (which is already the case
inside `requireAuth`). Then the route call-sites need **no** try/catch at all:
`await requireAuth();` and let TanStack's redirect pass through. If a catch is
truly needed for resilience, rethrow non-redirect errors verbatim instead of
mutating them into redirects:

```ts
try {
  await requireAuth();
} catch (err) {
  if (err && typeof err === "object" && "to" in err) throw err;
  // log + rethrow; do NOT redirect — that hides the failure
  console.error("requireAuth failed", err);
  throw err;
}
```

---

### [SEV: P2] — `getAuthOrg`/`requireAuth` as `method: "GET"` server fns may be cacheable by proxies

**File:** `apps/web/src/lib/auth-session.ts:15, 26`

```ts
export const requireAuth = createServerFn({ method: "GET" }).handler(...)
export const getAuthOrg = createServerFn({ method: "GET" }).handler(...)
```

**Problem.** `method: "GET"` exposes the server fn as a GET RPC endpoint
[INFERENCE: per TanStack Start's `createServerFn` contract — GET fns are
serialized as URL query calls, POST fns as bodies]. Authenticated GET responses
that return user identity (`userId`, `orgId`, `orgSlug`) without an explicit
`Cache-Control: private, no-store` + `Vary: Cookie` are eligible for caching by
shared/intermediate proxies. Neither file sets response headers.

**Impact.** Under a misconfigured CDN or forward proxy, one user's identity
snapshot could be served to another. Low probability in this stack (Vinxi/Nitro
in front), but the blast radius (identity cross-contamination) is high enough
to flag. Cannot confirm without inspecting the deployed Nitro response headers
— calling out for verification.

**Fix.** Either (a) switch to `method: "POST"` (these fns take no args and
return identity — POST is the conservative choice for authenticated returns),
or (b) set `headers: () => ({ "Cache-Control": "private, no-store",
"Vary": "Cookie" })` on the handler. (a) is simpler and removes the question
entirely.

---

### [SEV: P3] — Brittle four-level relative path crosses the workspace boundary

**File:** `apps/web/src/lib/convex-api.ts:5`

```ts
export { api } from "../../../../convex/_generated/api";
```

**Problem.** `../../../../convex/_generated/api` resolves `lib → src → web →
apps → repo-root → convex/_generated/api`. Four `..` segments, crossing from
the `apps/web` package into the root-level `convex/` package. Every other
cross-file import in `apps/web/src/lib/*` uses the `#/...` path alias (e.g.
`#/lib/convex-data-model`, `#/lib/human-error`). This is the only file that
escapes the package via a deep relative path.

**Impact.** Fragile: rename `apps/web` → `apps/dashboard` and this silently
breaks. A reader must count `..` to know where it lands. No path-alias coverage
for the workspace boundary.

**Fix.** Add a tsconfig path alias (`@convex/api` or `#convex/api`) pointing at
`../../convex/_generated/api`, then `export { api } from "@convex/api";`. Or
keep the relative path but add a comment documenting the workspace crossing.
The alias is the better fix since `convex-data-model` already needs the same
treatment.

---

### [SEV: P3] — `ClientClerk.session: unknown` is a dead field

**File:** `apps/web/src/lib/clerk-client.ts:16-20`

```ts
export interface ClientClerk {
  user: ClientClerkUser | null | undefined;
  organization: ClientClerkOrganization | null | undefined;
  session: unknown;
}
```

**Problem.** Grep for `.session` against `ClientClerk`/`window.Clerk` usage in
`apps/web/src`: zero reads of `clerk.session` or `window.Clerk.session`. The
field is declared "minimal Clerk browser surface — only fields we touch" but
`session` is not touched anywhere.

**Impact.** Minor confusion: a reader thinks the session object is consumed
somewhere. The `unknown` type also weakens the "minimal *typed* surface" claim
— it's a hole in the type.

**Fix.** Delete the `session: unknown;` line.

---

### [SEV: P3] — Inconsistent empty-string guard between `orgSlug` and `userId`/`orgId`

**File:** `apps/web/src/lib/clerk-client.ts:49-66`

```ts
const userId =
  (typeof clerk?.user?.id === "string" ? clerk.user.id : null) ??
  fallback.userId ?? null;

const orgId =
  (typeof clerk?.organization?.id === "string" ? clerk.organization.id : null) ??
  fallback.orgId ?? null;

const liveSlug = clerk?.organization?.slug;
const orgSlug =
  (typeof liveSlug === "string" && liveSlug.length > 0 ? liveSlug : null) ??
  (typeof fallback.orgSlug === "string" && fallback.orgSlug.length > 0
    ? fallback.orgSlug
    : null);
```

**Problem.** `orgSlug` rejects empty strings (`length > 0`); `userId` and
`orgId` accept them (`typeof === "string"` alone). An empty-string id from a
malformed Clerk state would pass through `readClientClerkAuth` as `userId: ""`.

**Impact.** Low — `""` is falsy, so the route `if (!userId)` gates still catch
it and redirect to sign-in. But the inconsistency is a smell: either all three
fields should reject empty strings, or none should, and the reason for the
difference isn't documented.

**Fix.** Extract a helper and apply uniformly:

```ts
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const userId = str(clerk?.user?.id) ?? fallback.userId ?? null;
const orgId = str(clerk?.organization?.id) ?? fallback.orgId ?? null;
const orgSlug = str(clerk?.organization?.slug) ?? str(fallback.orgSlug) ?? null;
```

---

### [SEV: P3] — Duplicated redirect-on-no-userId logic across `requireAuth` and `getAuthOrg`

**File:** `apps/web/src/lib/auth-session.ts:15-23, 26-38`

```ts
export const requireAuth = createServerFn({ method: "GET" }).handler(
  async (): Promise<AuthSession> => {
    const session = await auth();
    if (!session.userId) {
      throw redirect({ to: "/sign-in/$" });
    }
    return { userId: session.userId };
  },
);

export const getAuthOrg = createServerFn({ method: "GET" }).handler(
  async (): Promise<AuthOrgSession> => {
    const session = await auth();
    if (!session.userId) {
      throw redirect({ to: "/sign-in/$" });
    }
    return { userId: session.userId, orgSlug: session.orgSlug ?? null, orgId: session.orgId ?? null };
  },
);
```

**Problem.** Both fns duplicate `await auth(); if (!session.userId) throw redirect(...)`. (Note: `getAuthOrg` is dead per the P2 finding above — if you delete it, this duplication disappears and this finding is moot. If you keep it, dedupe.)

**Impact.** Two places to update if the sign-in route changes (e.g. `to:
"/login"`). The `"/sign-in/$"` trailing-splat target is also worth confirming
exists as a route — if `$` is dropped, both break identically.

**Fix.** Extract `const requireSession = async () => { const s = await auth();
if (!s.userId) throw redirect({ to: "/sign-in/$" }); return s; };` and call it
from both. (Or delete `getAuthOrg`.)

---

### [SEV: P3] — Hand-rolled `ClientClerk` type shadows Clerk's SDK types; drift is silent

**File:** `apps/web/src/lib/clerk-client.ts:6-26`

```ts
export interface ClientClerk {
  user: ClientClerkUser | null | undefined;
  organization: ClientClerkOrganization | null | undefined;
  session: unknown;
}

declare global {
  interface Window {
    Clerk?: ClientClerk;
  }
}
```

**Problem.** Clerk's browser SDK ships its own `Clerk` type
(`@clerk/types/dist/clerk`). Declaring `Window.Clerk?: ClientClerk` with a
hand-rolled minimal interface overrides/augments that. If Clerk renames
`organization` → `activeOrganization` (they've reshaped org APIs before) or
changes `user` to a getter, this code silently returns `null` forever and the
fallback always wins — no compile error, no runtime error, just auth that
quietly degrades to "always redirect to sign-in" or "always use stale context."

**Impact.** Latent: the next Clerk SDK bump could break org detection with zero
signal. The `typeof === "string"` runtime guards *partially* cover this (a
missing field → `null`), but the symptom (users always bounced to sign-in) is
hard to root-cause.

**Fix.** Either (a) import and use Clerk's real `Clerk` type for the global
augmentation:

```ts
import type { Clerk } from "@clerk/types";
declare global {
  interface Window { Clerk?: Clerk; }
}
```

or (b) keep the minimal interface but add a compile-time check that it's
assignable to a subset of the real type, e.g. `type _Assert =
  Pick<import("@clerk/types").Clerk, "user" | "organization">;` and a
satisfies. (a) is strictly better.

---

## Summary

**Counts:** P0: 0 · P1: 0 · P2: 3 · P3: 5 · **Total: 8**

**Top 3:**
1. **P2 — `getAuthOrg` + `AuthOrgSession` are dead code** (`auth-session.ts`).
   Delete them; `fetchConvexAuth` already owns server-side org reads.
2. **P2 — Route call-sites convert every `auth()` failure into a sign-in
   redirect**, masking transient Clerk outages and swallowing real errors with
   no observability (`auth-session.ts` + `app.tsx`/`admin.tsx`).
3. **P2 — `requireAuth`/`getAuthOrg` as `method: "GET"` server fns return
   authenticated identity with no cache-control headers** [INFERENCE: per
   TanStack Start's GET-fn contract] — switch to POST or add
   `Cache-Control: private, no-store` + `Vary: Cookie`.

**Verified clean:** No `CLERK_SECRET_KEY` or server env leakage into the client
bundle across all three files; the Convex JWT in `__root.tsx` is short-lived,
SSR-only, and never serialized to the client; `convex-api.ts`'s `api` re-export
is function references, not implementations or keys.
