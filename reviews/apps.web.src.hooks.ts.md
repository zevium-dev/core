# Tiger Review: `apps/web/src/hooks/*` (use-active-org-slug, use-mobile, use-ensure-mirror)

Reviewed together with their only consumers: `apps/web/src/components/notification-bell.tsx` (`useActiveOrgSlug`), `apps/web/src/components/ui/sidebar.tsx` (`useIsMobile`), and `apps/web/src/routes/app.tsx` + `apps/web/src/lib/ensure-mirror.ts` (`useEnsureMirror`).

## Verdict

**Incorrect.** `useActiveOrgSlug` and `useIsMobile` are correct under the lenses called out (no stale-slug query keying; no SSR/CSR hydration mismatch). `useEnsureMirror` carries two real correctness defects in its `ranFor` ref bookkeeping: an async-failure clobber that defeats the "once per user/org pair" invariant under org switches, and a stated retry contract that cannot fire. Both are patch-anchored and provable.

## File Stats

- `apps/web/src/hooks/use-active-org-slug.ts` — 16 lines, 1 export
- `apps/web/src/hooks/use-mobile.ts` — 22 lines, 1 export
- `apps/web/src/hooks/use-ensure-mirror.ts` — 51 lines, 1 export
- Cross-cutting surfaces: `apps/web/src/components/notification-bell.tsx`, `apps/web/src/components/ui/sidebar.tsx`, `apps/web/src/routes/app.tsx`, `apps/web/src/lib/ensure-mirror.ts`

---

## Findings

### [SEV: P2] `useEnsureMirror` `ranFor.current = null` in async failure handlers clobbers the dedup key of a concurrent effect run

**Location:** `apps/web/src/hooks/use-ensure-mirror.ts:16` (`ranFor.current = key;`), `:22` (`ranFor.current = null;` on `ensureUser` failure), `:42` (`ranFor.current = null;` on `ensureOrganization` failure); dep array at `:43-50`.

**Problem:** `ranFor` is a single shared ref mutated from two places: synchronously when an effect run starts (`ranFor.current = key`), and asynchronously inside the fire-and-forget IIFE's `catch` blocks. The effect has no cleanup, and `organization` is in the dep array, so a mid-flight org switch schedules a second effect run with a different key while the first run's `ensureUser` is still awaiting.

Concrete race:

1. User in org A, Convex authed. Effect runs: `key="u:A"`, `ranFor.current="u:A"`, starts `ensureUser({})` (run A).
2. User switches to org B. `organization` reference changes → effect re-runs: `key="u:B"`, `ranFor.current="u:B"`, starts a second `ensureUser({})` (run B). **Two concurrent `ensureUser` mutations for the same `userId` are now in flight.**
3. Run A's `ensureUser` rejects (transient). Its `catch` executes `ranFor.current = null` — **clobbering the `"u:B"` key that run B just wrote.**
4. Run B's `ensureUser` resolves; `ensureOrganization` for B proceeds and succeeds. `ranFor.current` is now `null`.
5. The next time *any* dep changes (a `convexAuthLoading` tick, a Clerk re-emit of `organization` with a new reference, another org switch), the effect re-runs for B: `key="u:B"`, `ranFor.current` (null) !== "u:B", so it **re-runs `ensureUser` + `ensureOrganization` for an already-mirrored user/org** — redundant writes that (per the existing review of `lib/ensure-mirror.ts`) unconditionally `patch` and bump `_revision`.

The `ranFor` ref is the only dedup mechanism; it is written from a synchronous site and overwritten from async sites with no coordination, so the invariant the JSDoc promises ("once per user/org pair") is violated whenever a failure and a key-change interleave.

**Trigger condition:** Org switch that overlaps a transient `ensureUser`/`ensureOrganization` failure. Org switches are the explicit reason the key includes `organization?.id` (`:14`), so this is on the intended code path, not an edge case.

**Impact:** Defeated dedup → redundant Convex mutations (write amplification + realtime re-fire on identical rows) on every subsequent dep change after a failure; two concurrent `ensureUser({})` calls for the same user during the race window. No data corruption (mutations are idempotent), but the "once per pair" contract is broken and the post-failure state is permanently re-runnable.

**Fix:** Don't reset a shared ref from async catch blocks that may outlive their effect run. Track succeeded keys in a `Set<string>` and only gate forward progress; let failures retry via a state tick (see next finding), or scope the reset to the *current* key only:

```suggestion
  const ranFor = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!isSignedIn || !userId) return;
    if (convexAuthLoading || !isAuthenticated) return;

    const key = `${userId}:${organization?.id ?? "none"}`;
    if (ranFor.current.has(key)) return;

    void (async () => {
      try {
        await convex.mutation(api.users.ensureUser, {});
      } catch (err) {
        console.warn("[ensureUser] failed:", err);
        return;
      }
      ranFor.current.add(key);
      if (!organization?.id) return;
      const slug = organization.slug;
      if (!slug) {
        console.warn("[ensureOrganization] active org missing slug");
        return;
      }
      try {
        await convex.mutation(api.organizations.ensureOrganization, {
          clerkOrgId: organization.id,
          name: organization.name,
          slug,
          imageUrl: organization.imageUrl,
        });
      } catch (err) {
        console.warn("[ensureOrganization] failed:", err);
        ranFor.current.delete(key);
      }
    })();
  }, [
    convex,
    isSignedIn,
    userId,
    organization,
    convexAuthLoading,
    isAuthenticated,
  ]);
```

(Marking `ranFor` only after `ensureUser` succeeds means a failed `ensureUser` naturally retries on the next dep change without any clobber; `delete` on `ensureOrganization` failure scopes the reset to this run's own key, so it can never wipe a sibling run's key.)

---

### [SEV: P2] `useEnsureMirror` retry-on-failure never fires — `ranFor.current = null` does not re-trigger the effect

**Location:** `apps/web/src/hooks/use-ensure-mirror.ts:20-23` (`ensureUser` catch with comment "Allow retry on next effect if mutation failed before mirror.") and `:40-42` (`ensureOrganization` catch).

**Problem:** Both `catch` blocks set `ranFor.current = null` and rely on "the next effect" to retry. But mutating a `useRef` does not schedule a re-render and does not change any value in the effect's dependency array (`convex`, `isSignedIn`, `userId`, `organization`, `convexAuthLoading`, `isAuthenticated`). React only re-runs the effect when one of those deps changes. So after a transient failure on mount, the mirror is not retried until an *unrelated* state change happens to fire the effect again — and if that change is an org switch, the key would have moved anyway and the failed org stays un-mirrored.

This matters because the client hook is the **sole** mirror path for most of the app. `ensureMirrorOnServer` is invoked only in `apps/web/src/routes/app/projects/index.tsx:40`; the `/app` layout's `beforeLoad` (`apps/web/src/routes/app.tsx:24-42`) does `requireAuth()` on SSR but never calls `ensureMirrorOnServer`. So for any `/app/*` route that is not `/app/projects` (settings, keys, billing, activity, catalogue, earnings, …), `useEnsureMirror` in `AppLayout` is the only thing ensuring the Convex `users`/`organizations` rows exist. A transient Convex error (network blip, brief auth mismatch during org switch) on mount of those routes leaves the user un-mirrored until the user manually reloads or switches orgs — org-scoped queries (`notifications.listForOrg`, etc.) then return empty/throw against a non-existent org row.

The inline comment (`:21` "Allow retry on next effect if mutation failed before mirror.") documents an intent that the code does not implement.

**Trigger condition:** Any transient `ensureUser`/`ensureOrganization` failure on `AppLayout` mount for a user navigating to a non-`/app/projects` route.

**Impact:** Silent mirror gap → org-scoped Convex queries return empty or 500 against the missing mirror row; the "failures logged; never block shell" design hides the gap from the user. The soft-failure contract is only correct if retry actually happens, and it doesn't.

**Fix:** Drive retry off state, not a ref mutation. Add a `retryTick` state and include it in the dep array; bump it in the catches:

```suggestion
  const ranFor = useRef<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (!isSignedIn || !userId) return;
    if (convexAuthLoading || !isAuthenticated) return;

    const key = `${userId}:${organization?.id ?? "none"}`;
    if (ranFor.current === key) return;
    ranFor.current = key;

    void (async () => {
      try {
        await convex.mutation(api.users.ensureUser, {});
      } catch (err) {
        console.warn("[ensureUser] failed:", err);
        ranFor.current = null;
        setRetryTick((t) => t + 1);
        return;
      }
      if (!organization?.id) return;
      const slug = organization.slug;
      if (!slug) {
        console.warn("[ensureOrganization] active org missing slug");
        return;
      }
      try {
        await convex.mutation(api.organizations.ensureOrganization, {
          clerkOrgId: organization.id,
          name: organization.name,
          slug,
          imageUrl: organization.imageUrl,
        });
      } catch (err) {
        console.warn("[ensureOrganization] failed:", err);
        ranFor.current = null;
        setRetryTick((t) => t + 1);
      }
    })();
  }, [
    convex,
    isSignedIn,
    userId,
    organization,
    convexAuthLoading,
    isAuthenticated,
    retryTick,
  ]);
```

(Add backoff if desired, but even a single immediate retry covers the transient-blip case. Pair with the `Set`-based dedup from the prior finding so retry can't clobber a sibling run.)

---

### [SEV: P3] `useEnsureMirror` effect depends on the whole `organization` object — spurious re-runs on Clerk reference churn

**Location:** `apps/web/src/hooks/use-ensure-mirror.ts:43-50` (dep array includes `organization`).

**Problem:** `useOrganization()` returns a new `organization` object reference on Clerk re-fetches and auth revalidations even when the underlying `id`/`slug`/`name`/`imageUrl` are unchanged. Each such reference change re-invokes the effect. The `ranFor.current === key` guard (keyed only on `organization?.id`) short-circuits before any mutation fires, so there is no duplicate write — but the effect body still runs its early returns and key computation on every reference churn, and the dep comparison itself is a wasted cycle per re-render where only the reference moved.

**Impact:** No functional bug (the ref guard catches it). Wasted effect invocations on every Clerk org-data refresh; noise in React DevTools profiling that suggests the mirror is re-attempting when it isn't.

**Fix:** Depend on the primitive fields the effect actually reads inside the IIFE, not the container object:

```suggestion
  }, [
    convex,
    isSignedIn,
    userId,
    organization?.id,
    organization?.slug,
    organization?.name,
    organization?.imageUrl,
    convexAuthLoading,
    isAuthenticated,
  ]);
```

---

## Summary

**Counts:** 0 × P0, 0 × P1, 2 × P2, 1 × P3. 3 findings total.

**Top 3:**

1. **P2 — `ranFor` clobber race.** Setting `ranFor.current = null` from async `catch` blocks wipes the dedup key written by a later concurrent effect run (org switch mid-`ensureUser`-await), defeating the "once per user/org pair" invariant and producing redundant mirror writes on every subsequent dep change. Fix by moving dedup to a `Set<string>` and only ever deleting the current run's own key.
2. **P2 — Stated retry contract is unfulfilled.** `ranFor.current = null` does not change any dep, so the effect never re-runs after a transient failure; the comment promising "retry on next effect" documents an intent the code doesn't implement. For non-`/app/projects` routes — where the client hook is the sole mirror path — a transient mount failure leaves the user un-mirrored until manual reload. Fix by driving retry off a `retryTick` state in the dep array.
3. **P3 — Whole-`organization` dep.** Effect re-runs on Clerk reference churn with no behavioral change; mitigated by the `ranFor` guard but wasteful. Depend on the primitive fields read inside the IIFE.

**Hooks reviewed with no findings:** `use-active-org-slug.ts` (the only consumer, `NotificationBell`, keys `convexQuery` by the `orgSlug` primitive which updates reactively on org switch — no stale-slug query keying; `isLoaded`/`organization` null-guards match Clerk's types); `use-mobile.ts` (initial state `undefined` → `!!isMobile` yields `false` identically on SSR and first client render, so no hydration mismatch; effect cleanup correctly removes the `matchMedia` listener with no leak).
