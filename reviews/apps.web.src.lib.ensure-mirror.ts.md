# Tiger Review: `apps/web/src/lib/ensure-mirror.ts` + `apps/web/src/hooks/use-ensure-mirror.ts`

Reviewed together with `convex/users.ts`, `convex/organizations.ts`, `convex/lib/auth.ts`, `convex/http.ts` (Clerk webhook), and the only caller of the server fn (`apps/web/src/routes/app/projects/index.tsx`).

## Verdict

**Incorrect.** The mirror is correct on the happy path but carries a real P1 duplicate-row race between SSR ensure and client ensure, plus systematic write-amplification and JWT-over-webhook drift on every navigation. Several fields/types are dead. Ship-blockers exist; the rest are next-cycle.

## File Stats

- `apps/web/src/lib/ensure-mirror.ts` — 133 lines, 1 export
- `apps/web/src/hooks/use-ensure-mirror.ts` — 51 lines, 1 export
- Cross-cutting surfaces: `convex/users.ts`, `convex/organizations.ts`, `convex/http.ts`, `convex/schema.ts` (indexes are non-unique)

---

## Findings

### [SEV: P1] Concurrent SSR ensure + client ensure can create duplicate `users`/`organizations` rows, breaking `.unique()` queries

**Location:** `apps/web/src/lib/ensure-mirror.ts:84` (`client.mutation(api.users.ensureUser, {})`) + `apps/web/src/hooks/use-ensure-mirror.ts:30` (same mutation on the client); same pattern for `ensureOrganization` at `ensure-mirror.ts:111` and `use-ensure-mirror.ts:42`.

**Problem:** On a cold load of `/app/projects` (and any SSR navigation to a route that calls `ensureMirrorOnServer`), two concurrent mirrors fire with no cross-layer coordination:

1. The projects loader runs `ensureMirrorOnServer()` server-side → issues `ensureUser` + `ensureOrganization` via a fresh `ConvexHttpClient`.
2. The browser hydrates, `AppLayout` mounts, `useEnsureMirror()` fires `ensureUser` + `ensureOrganization` via the live `useConvex()` client.

Both `ensureUser` and `ensureOrganization` are read-then-write: query by `clerkUserId`/`clerkOrgId`; if `null`, insert. Convex serializes writes per document, but the two transactions execute against the *pre-insert* state in both cases — neither sees the other's uncommitted insert. Both insert.

The schema indexes (`convex/schema.ts:12` `by_clerk_org`, `:20` `by_clerk_user`) are plain `.index(...)` calls, **not** unique constraints — Convex only enforces uniqueness at `.unique()` *query* time, not at insert. So both inserts succeed. From that point on, every `withIndex(...).unique()` call in `ensureUser`, `ensureOrganization`, `upsertFromClerk`, `listMine`, `getBySlug`, and `requireOrgMemberBySlug` throws `IndexedQueryNonUniqueError`. The mirror is bricked for that user/org until manual dedup.

**Trigger condition:** First authed navigation after sign-in (or after clearing Convex cache) when the org/user row does not yet exist on the mirror. This is the exact "first SSR doesn't 500" scenario the loader comment claims to handle.

**Impact:** Permanent 500s on every authed query for the affected user/org until an operator deletes the duplicate row. `projects.list` becomes `InternalServerError`; the loader's `try { ensureQueryData } catch {}` swallows it and the client retries against the same broken state.

**Fix:** Make the server fn authoritative for SSR and have the client hook skip its mutation when the server already mirrored in this load. At minimum, gate the client hook on a sentinel (e.g., a `data-mirrored` attribute or a router-context flag set by the loader) so the two layers never race. The deeper fix is to make the Convex mutations idempotent under concurrency — e.g., `ensureUser`/`ensureOrganization` should be `internalMutation`s wrapped so insert-or-patch is atomic, or the duplicate-insert path should detect-and-merge. The simplest hardening is to not run the client hook on the first effect after SSR (use a `useRef` hydrated from the loader result).

---

### [SEV: P1] Write amplification: `ensureUser` and `ensureOrganization` unconditionally `patch` on every call, every navigation

**Location:** `convex/users.ts:55` (`await ctx.db.patch(existing._id, { name, email });`), `convex/organizations.ts:148` (`await ctx.db.patch(existing._id, { name, slug, imageUrl });`).

**Problem:** Both `ensure*` mutations execute a `patch` whenever the row already exists, regardless of whether any field actually changed. `ensureUser` derives `name`/`email` from the JWT identity and writes them back verbatim. `ensureOrganization` writes `name`/`slug`/`imageUrl` back verbatim. These are invoked:

- on every SSR navigation through the projects loader (`ensureMirrorOnServer`),
- on every `AppLayout` mount via `useEnsureMirror`,
- on every org switch (the `ranFor` key changes),
- on every Convex auth re-validation.

Each call is one Convex mutation = one queued transaction + one document revision bump + one scheduler/realtime fan-out. For a user clicking through the dashboard, this is dozens of no-op writes per session. Convex bills per mutation; realtime subscribers (`useQuery` on `users`/`organizations`) re-render on every revision even though the data is identical.

**Impact:** Cost (mutation quota), UI flicker on realtime subscriptions keyed off these tables, log noise, and — because each patch bumps `_revision` — any future diff/audit logic that infers "this row changed" will produce false positives.

**Fix:** Compare before patching. In `ensureUser`, only `patch` if `existing.name !== name || existing.email !== email`. Same for `ensureOrganization` on `name`/`slug`/`imageUrl`. The common case (row exists, JWT unchanged) becomes a single read with zero writes.

```suggestion
    if (existing === null) {
      const userId = await ctx.db.insert("users", {
        clerkUserId,
        name,
        email,
      });
      const created = await ctx.db.get(userId);
      if (created === null) {
        throw new Error("Failed to load created user");
      }
      return created;
    }

    if (existing.name !== name || existing.email !== email) {
      await ctx.db.patch(existing._id, { name, email });
    }
    const updated = await ctx.db.get(existing._id);
    if (updated === null) {
      throw new Error("Failed to load updated user");
    }
    return updated;
```

---

### [SEV: P2] Stale JWT overwrites fresh webhook: name/email/slug mirror drift

**Location:** `convex/users.ts:48-53` (name/email derived from `identity`), `apps/web/src/lib/ensure-mirror.ts:104` (slug from `session.orgSlug`).

**Problem:** The Clerk webhook (`convex/http.ts:94` `user.created/updated`, `:61` `organization.created/updated`) is the authoritative mirror writer — it receives fresh `first_name`/`last_name`/`username`/`email` / `name`/`slug`/`image_url` straight from Clerk. The `ensure*` mutations, however, derive the same fields from the Convex JWT identity (`identity.givenName`, `identity.familyName`, `identity.email`, `session.orgSlug`). The JWT is cached for its template lifetime (typically ~60s) and is reissued asynchronously by Clerk; a user/org that was just renamed in Clerk will have a stale JWT in flight.

Sequence producing drift:
1. T=0: user renames themselves in Clerk.
2. T=1: `user.updated` webhook fires → `upsertFromClerk` patches mirror row to new name.
3. T=2: user's browser still holds a JWT issued before T=0 (old name claim).
4. T=3: user navigates → SSR `ensureUser` derives old name from JWT → patches mirror row **back** to old name.
5. Drift persists until the JWT reissues (≤60s) *and* the user navigates again, or until the next webhook event.

The fallback chains also diverge: `upsertFromClerk` (http.ts:89) falls back `first_name + last_name → username → email → "User"`; `ensureUser` (users.ts:42) falls back `name → givenName+familyName → nickname → email → "User"`. A user whose display name relies on `username` (no `first_name`/`last_name`/`name`) will have their mirror name flip-flop between webhook updates and JWT ensures — every navigation overwrites the webhook's `username`-derived name with `"User"` (since none of `identity.name`/`givenName`/`familyName`/`nickname`/`email` produce the username either, and email may be empty).

The same exists for org slug: `ensureOrganization` accepts `slug` from the caller, the server passes `session.orgSlug` (JWT-baked), the client passes `organization.slug` (Clerk session, also JWT-baked). Neither is validated against `claims.org_slug` in `requireIdentity` — only `orgId` is checked (`organizations.ts:139`). A stale slug silently overwrites a fresh webhook slug.

**Impact:** Mirror row holds stale name/email/slug for up to JWT lifetime × number of navigations; for username-derived names, the drift is permanent until the user edits their Clerk profile again. Anywhere the mirror's `name`/`slug` is shown to other users (publisher display, org listing) renders stale or wrong data.

**Fix:** Treat the webhook as authoritative. The `ensure*` mutations should only insert if missing; on existing rows they should either (a) skip the patch entirely and let the webhook own updates, or (b) only patch fields the JWT can authoritatively fill (email is verifiable from the identity; name/slug/image are not, since the JWT's name claim is not a reliable display-name source). At minimum, unify the fallback chain between `upsertFromClerk` and `ensureUser` so they can't disagree.

---

### [SEV: P2] `ensureOrganization` server fallback writes `slug` as `name` on any Clerk API error — permanent name corruption

**Location:** `apps/web/src/lib/ensure-mirror.ts:103-115`.

**Problem:** When the Clerk `organizations.getOrganization` lookup throws (any 4xx/5xx, network blip, rate limit), the catch swallows it and `name` stays at its initializer `let name = orgSlug`. The mutation then patches the org row's `name` to the **slug**. This is not a transient in-memory value — it is persisted to Convex via `ensureOrganization`'s unconditional `patch` (see P1 write-amplification finding). The org's real name ("Acme Corporation") is overwritten with "acme-corporation" and stays that way until the next `organization.updated` webhook or the next successful SSR ensure where Clerk's API is reachable.

**Trigger condition:** Any transient Clerk API failure during an SSR navigation. Clerk API rate limits (100 req/min on the dev instance, higher on prod) are easy to hit when multiple concurrent SSR loads each call `getOrganization`.

**Impact:** Persistent data-quality corruption of org display names. Users see slug-as-name in publisher listings, sidebar, etc. The fact that the catch is silent means there is no log, alert, or metric.

**Fix:** Do not write `name` when the Clerk lookup fails — only write `slug`/`imageUrl` if you must, or skip the patch entirely and let the webhook fill `name` later. Alternatively, only patch `name` when `org.name` was successfully fetched and differs from the existing row.

```suggestion
      let name: string | undefined;
      let imageUrl: string | undefined;
      try {
        const org = await (
          await clerkClient()
        ).organizations.getOrganization({ organizationId: orgId });
        if (typeof org.name === "string" && org.name.length > 0) {
          name = org.name;
        }
        if (typeof org.imageUrl === "string" && org.imageUrl.length > 0) {
          imageUrl = org.imageUrl;
        }
      } catch {
        // Clerk lookup optional — skip name/imageUrl, keep slug-only mirror.
      }

      await client.mutation(api.organizations.ensureOrganization, {
        clerkOrgId: orgId,
        name: name ?? orgSlug,
        slug: orgSlug,
        imageUrl,
      });
```

(The above still has the slug-as-name issue; the proper fix is to make `name` optional in the mutation and skip the patch when undefined.)

---

### [SEV: P2] Per-SSR-navigation `clerkClient().organizations.getOrganization` call amplifies Clerk API usage and adds latency

**Location:** `apps/web/src/lib/ensure-mirror.ts:106-108`.

**Problem:** Every SSR run of `ensureMirrorOnServer` (i.e., every server-side navigation to `/app/projects`) instantiates `clerkClient()` and calls `organizations.getOrganization`. This is a network round-trip to Clerk on the critical path of the loader, before the projects list query can run. Under concurrent SSR (multiple users navigating) this directly hits Clerk's backend API rate limits and adds hundreds of ms to first paint.

The data being fetched (`name`, `imageUrl`) is already available in the JWT claims (`session.orgSlug`, and Clerk's session has `orgName`/`orgImageUrl` on the session object in most versions) or is owned by the webhook. The Clerk API call is only "needed" if the JWT doesn't carry the org name — and even then, the webhook is the right writer, not the SSR loader.

**Impact:** Latency on every SSR navigation; Clerk API quota burn; silent failure → name corruption (per P2 above).

**Fix:** Drop the `clerkClient()` call entirely from the loader path. Read org name/image from `session` claims if present; otherwise leave them for the webhook to populate. If a synchronous name is required for SSR rendering, pass `undefined` and let the component read from `useOrganization()` on the client (which already happens via `organization.name`).

---

### [SEV: P2] `ConvexHttpClient` instantiated per call, never closed

**Location:** `apps/web/src/lib/ensure-mirror.ts:69-70`.

**Problem:** `new ConvexHttpClient(convexUrl)` is created on every invocation of `ensureMirrorOnServer` (every SSR navigation through the projects loader) and never `close()`d. Each instance holds a WebSocket connection to the Convex backend (for auth revalidation and query subscriptions) and internal buffers. On a busy SSR server this leaks connections until GC, which on Node is non-deterministic.

**Impact:** Under sustained SSR traffic, file-descriptor / WebSocket exhaustion is plausible; on Convex's side, connection churn counts against concurrent-connection quotas.

**Fix:** Either reuse a module-scoped client (with `setAuth` refreshed per call — but `setAuth` is per-client, so this is only safe if the server is single-tenant per process, which it is not in SSR with multiple users), or explicitly `client.close()` in a `finally` block after the mutations complete. Given the per-request auth, the `finally`-close pattern is correct here.

```suggestion
    const client = new ConvexHttpClient(convexUrl);
    try {
      client.setAuth(token);
      try {
        await client.mutation(api.users.ensureUser, {});
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          userId,
          orgId,
          orgSlug,
          mirrored: false,
          error: `ensureUser: ${message}`,
        };
      }
```
…and the matching `finally { void client.close(); }` around the whole post-creation block.

---

### [SEV: P2] `useEnsureMirror` retry-on-failure is broken: `ranFor.current = null` in catch does not re-trigger the effect

**Location:** `apps/web/src/hooks/use-ensure-mirror.ts:38-46` and `:48-51`.

**Problem:** On `ensureUser` failure, the catch sets `ranFor.current = null` and returns, with the comment "Allow retry on next effect if mutation failed before mirror." But the effect's dependency array (`convex`, `isSignedIn`, `userId`, `organization`, `convexAuthLoading`, `isAuthenticated`) has not changed, so React does **not** re-run the effect. `ranFor.current = null` sits idle. The retry only happens if one of those deps changes (e.g., the user switches org or Clerk re-emits an auth state change) — and in that case, the key would have changed anyway and `ranFor.current` would already be stale.

The same broken-retry pattern repeats in the `ensureOrganization` catch (`:48-51`): setting `ranFor.current = null` after `ensureUser` already succeeded means a *successful* `ensureUser` followed by a *failed* `ensureOrganization` will, on the next legitimate effect run, re-fire `ensureUser` unnecessarily — but only if a dep changes, which is also the only path to actually retrying `ensureOrganization`.

**Impact:** Transient Convex failures (network blip, brief auth mismatch during org switch) leave the org un-mirrored until the user takes an action that changes Clerk auth state. The server-side `ensureMirrorOnServer` is the only fallback, and only fires on SSR navigations to `/app/projects` — client-side navigations to other `/app/*` routes have no fallback.

**Fix:** Drive retry off a state tick, not a ref mutation. Add a `const [retryTick, setRetryTick] = useState(0)` and include it in deps; in the catch, `setRetryTick(t => t + 1)`. The effect re-runs, the key still matches (so dedup holds), and you can bypass dedup explicitly when retrying. Or simpler: drop the ref-based dedup and use a `useRef<Set<string>>` of *succeeded* keys, so failures naturally retry on the next effect run.

---

### [SEV: P3] `EnsureMirrorResult.error` / `userId` / `orgId` / `orgSlug` fields are dead at every caller

**Location:** `apps/web/src/lib/ensure-mirror.ts:11-18` (type), `:50`/`:58`/`:66`/`:79`/`:96`/`:125` (populated values).

**Problem:** The only caller of `ensureMirrorOnServer` is `apps/web/src/routes/app/projects/index.tsx:40`:

```ts
const mirror = await ensureMirrorOnServer();
if (!mirror.mirrored) return;
```

It reads `mirrored` only. The `error`, `userId`, `orgId`, `orgSlug` fields are populated with care (including error-message formatting like `` `ensureUser: ${message}` ``) but never consumed by any caller. `grep` for `mirror.error` / `mirror.userId` / `mirror.orgId` / `mirror.orgSlug` returns zero usages outside the type definition.

**Impact:** Dead code that implies an observability contract that doesn't exist. The formatted error strings suggest SSR errors are surfaced somewhere; they aren't. Future maintainers will assume the loader logs or reports `error`, and may build on that assumption.

**Fix:** Either consume `error` (log it, or propagate to a Sentry breadcrumb) or drop the fields and return `boolean` / a discriminated union. Given the "failures soft" design intent, the minimal fix is to at minimum `console.error(mirror.error)` in the caller when `!mirror.mirrored`, so soft failures aren't fully silent.

---

### [SEV: P3] `ensureUser` returns `Doc<"users">` but no caller uses the return value

**Location:** `convex/users.ts:51` (returns full doc), `apps/web/src/lib/ensure-mirror.ts:75` (ignores return), `apps/web/src/hooks/use-ensure-mirror.ts:31` (ignores return).

**Problem:** The mutation serializes the full user document (id, clerkUserId, name, email, _creationTime, _revision) back over the wire on every call. Neither the server fn nor the client hook reads the return value. This is per-navigation payload overhead on top of the write amplification (P1).

**Impact:** Small but unnecessary network/serialization cost on every mirror call; misleading API surface (suggests the caller needs the doc).

**Fix:** Change the return type to `Id<"users">` (or `null`/`void`) if the doc is never needed. If kept for future use, document why.

---

### [SEV: P3] `if (!orgId || !orgSlug)` returns `mirrored: true` without mirroring the org

**Location:** `apps/web/src/lib/ensure-mirror.ts:80-87`.

**Problem:** When `orgId` is present but `orgSlug` is missing (or vice versa), the function returns `{ mirrored: true, error: null }` after only mirroring the user. The caller (projects loader) interprets `mirrored: true` as "safe to proceed with authed queries," then calls `ensureQueryData(projects.list, { orgSlug })` using `context.orgSlug` (which may be present even when `session.orgSlug` is absent). If the org row doesn't exist yet (because we skipped the org mirror), `projects.list` throws "Organization not found" → caught + removed, so the user sees a skeleton then empty state. Semantically, `mirrored: true` is a lie here — the org was not mirrored.

**Impact:** Misleading return contract; the caller's error path is hit silently. No user-visible breakage because the downstream catch swallows, but the contract is wrong and will bite if any future caller trusts `mirrored`.

**Fix:** Return `mirrored: false` with `error: "missing orgSlug"` (or split into `userMirrored`/`orgMirrored`) when the org could not be mirrored.

---

### [SEV: P3] `useEnsureMirror` effect dependency on whole `organization` object — runs on every reference change

**Location:** `apps/web/src/hooks/use-ensure-mirror.ts:24-30`.

**Problem:** The effect depends on `organization` (the whole object from `useOrganization()`). Clerk's `useOrganization()` returns a new object reference on most renders where the org data is re-fetched, even if the underlying fields are unchanged. The `ranFor.current` key check (`${userId}:${organization?.id ?? "none"}`) dedupes execution, so the extra effect runs are harmless, but they still cost a render→effect cycle per spurious reference change.

**Impact:** Wasted effect invocations on every Clerk org-data refresh; no functional bug because the ref guard catches it.

**Fix:** Depend on the primitive fields actually used: `organization?.id`, `organization?.slug`, `organization?.name`, `organization?.imageUrl`. Or memoize the key and depend on that.

---

## Summary

**Counts:** 2 × P1, 4 × P2, 4 × P3. 10 findings total.

**Top 3:**

1. **P1 — Duplicate-row race** between `ensureMirrorOnServer` (SSR) and `useEnsureMirror` (client) on first authed navigation. Convex's `.index()` does not enforce uniqueness at insert, so concurrent read-then-insert creates duplicate `users`/`organizations` rows; every subsequent `.unique()` query throws and the mirror is bricked until manual dedup.
2. **P1 — Write amplification** via unconditional `patch` in `ensureUser`/`ensureOrganization` on every navigation. Costs mutation quota, bumps `_revision` (false "changed" signals), and re-fires realtime subscribers with identical data.
3. **P2 — Stale JWT overwrites fresh webhook**, plus the org-name-falls-back-to-slug path that persists a transient Clerk API failure as a permanent name corruption. The webhook is the authoritative mirror writer; the ensure mutations fight it with stale/derived data and divergent fallback chains.
