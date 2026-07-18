# Tiger-Style Review — `convex/users.ts`

## Verdict

**Incorrect.** No P0 and no cross-user-edit or role-escalation surface exists (the `users` table carries no role/admin field; `ensureUser` keys off the verified JWT `subject`; `upsertFromClerk` is `internalMutation`-gated behind the svix-verified webhook). However the file is missing the Clerk-delete mirror entirely (PII retained indefinitely after account deletion), and shares the same duplicate-insert race that bricks the orgs mirror — both are real, reachable defects, not theoretical. Plus two write-correctness issues (write-amplification + stale-JWT last-write-wins) that the file's own docstring ("Safe to call on every app boot") actively obscures.

## File Stats

- **File:** `convex/users.ts`
- **LOC:** ~90
- **Exports:** 2 (`upsertFromClerk` internalMutation, `ensureUser` public mutation)
- **Role:** Mirrors Clerk users into Convex. `upsertFromClerk` is the Clerk-webhook-driven sync primitive (called from `convex/http.ts:94`); `ensureUser` is the web-app-driven mirror-on-boot (called from `apps/web/src/hooks/use-ensure-mirror.ts:28` and `apps/web/src/lib/ensure-mirror.ts:68`). The `users` table is read by **no other module** — only by the two functions in this file — so duplicate-row corruption localizes to this file's read paths (but still bricks `ensureUser` for the affected user).
- **Auth model:** Clerk is source of truth; Convex mirrors. Admin gating is via `ADMIN_USER_IDS` env in `convex/lib/auth.ts` (not via a column on `users`), so there is no role-tampering or admin-self-promotion surface in this file. Confirmed clean on that axis.

## Findings

### [SEV: P1] `user.deleted` Clerk webhook is silently dropped — no `deleteFromClerk` mutation, orphaned PII retained indefinitely (GDPR/CCPA right-to-erasure violation)

**Location:** `convex/users.ts` (whole file — `deleteFromClerk` is absent); dispatch point `convex/http.ts:104` (`default: break;`).

```ts
// convex/http.ts — the webhook switch
case "user.created":
case "user.updated": {
  const data = event.data as ClerkUserEventData;
  // …
  await ctx.runMutation(internal.users.upsertFromClerk, {
    clerkUserId: data.id,
    name,
    email,
  });
  break;
}
default:
  break;   // ← user.deleted lands here, silently discarded
```

**Problem:** `http.ts` handles `organization.created/updated/deleted` (the delete path calls `internal.organizations.deleteFromClerk`), but for users it handles only `user.created` and `user.updated`. There is **no** `case "user.deleted":` branch, and `users.ts` exports **no** `deleteFromClerk` mutation (compare `organizations.ts:88`). When a user deletes their Clerk account (GDPR erasure request, account closure, admin purge), the `user.deleted` webhook fires, falls through to `default: break;`, and the Convex mirror row — including `email` PII — is retained forever.

**Impact:** PII retention beyond the lawful basis for which it was collected. A user who deletes their Clerk account reasonably expects their email and profile to be purged from downstream systems; here they are not. Orphaned rows also accumulate: the schema has no foreign-key references to `users._id` (notifications key off `clerkOrgId`, usage off `organizationId`), so a hard delete is safe and there is no integrity excuse for leaving the row. This is an asymmetry the orgs mirror already got right — the users mirror was simply never finished.

**Fix:** Add the case to `http.ts` and the mutation to `users.ts`:
```ts
// convex/users.ts
export const deleteFromClerk = internalMutation({
  args: { clerkUserId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();
    if (existing !== null) {
      await ctx.db.delete(existing._id);
    }
  },
});
```
```ts
// convex/http.ts — add to the switch
case "user.deleted":
  await ctx.runMutation(internal.users.deleteFromClerk, {
    clerkUserId: (event.data as ClerkUserEventData).id,
  });
  break;
```

---

### [SEV: P1] Concurrent insert in `ensureUser` / `upsertFromClerk` creates duplicate `clerkUserId` rows — `.unique()` then throws on every subsequent read, permanently bricking the user mirror for that user

**Location:** `convex/users.ts:12-23` (`upsertFromClerk` insert path) and `57-66` (`ensureUser` insert path); schema index `by_clerk_user` (`convex/schema.ts:20`) is **not** a unique constraint.

```ts
const existing = await ctx.db
  .query("users")
  .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", args.clerkUserId))
  .unique();

if (existing === null) {
  return await ctx.db.insert("users", {   // ← second concurrent caller also observes null
    clerkUserId: args.clerkUserId,        //   and also inserts → duplicate rows
    name: args.name,
    email: args.email,
  });
}
```

**Problem:** Both the webhook sync (`upsertFromClerk`) and the app-boot sync (`ensureUser`) use a read-then-insert "get or create" pattern. The `by_clerk_user` index is a non-unique Convex index (Convex has no schema-level unique constraint; `.unique()` only *throws* on duplicates, it does not *prevent* them). Two concurrent transactions each observe `existing === null` and both insert, producing two `users` rows with the same `clerkUserId`. From that point on, every `.unique()` read in this file throws `NonUniqueResponseError` — `ensureUser` and `upsertFromClerk` both fail permanently for that user. No self-healing path exists; recovery requires manual DB surgery.

Realistic concurrent callers for a brand-new Clerk user:
- Clerk `user.created` webhook → `upsertFromClerk`, racing with the user's first `ensureUser` from `useEnsureMirror` (`apps/web/src/hooks/use-ensure-mirror.ts:28`) or `ensureMirrorOnServer` (`apps/web/src/lib/ensure-mirror.ts:68`).
- Two browser tabs / two devices loading `/app` simultaneously — `useEnsureMirror` fires for both.
- Svix retry of `user.created` racing the original delivery.

**Impact:** The affected user can never mirror again; `ensureUser` throws on every boot, surfacing as a broken app shell for that user. Because `users` is read only by this file, the blast radius is contained to user-mirroring, but for the affected user it is total. This is the exact defect class already documented as P1 in `reviews/convex.organizations.ts.md` (finding "[SEV: P1] ensureOrganization and upsertFromClerk insert-path race creates duplicate clerkOrgId rows").

**Fix:** Make the insert path survive concurrency. Options: (a) insert unconditionally, then re-query `by_clerk_user` and reconcile duplicates (delete the newer by `_creationTime`) within the same transaction; (b) route all creation through a single authoritative `internalMutation` (the `user.created` webhook) and make `ensureUser` a pure get-or-throw that does not insert. At minimum, after insert, re-query and delete losers:
```ts
if (existing === null) {
  const userId = await ctx.db.insert("users", { clerkUserId, name, email });
  const dupes = await ctx.db
    .query("users")
    .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", clerkUserId))
    .collect();
  for (const d of dupes) {
    if (d._id !== userId) await ctx.db.delete(d._id);
  }
  // …
}
```

---

### [SEV: P2] `ensureUser` writes `name`/`email` on every app boot regardless of change — write-amplification, spurious realtime fan-out, mutation-log bloat

**Location:** `convex/users.ts:67-70` (`ensureUser` patch path).

```ts
await ctx.db.patch(existing._id, { name, email });
```

**Problem:** `ensureUser` unconditionally patches `name` and `email` even when both are byte-identical to the stored values. The caller `useEnsureMirror` (`apps/web/src/hooks/use-ensure-mirror.ts:11`) explicitly fires "on every `/app` mount", and the docstring at `convex/users.ts:35` blesses this as "Safe to call on every app boot". So every page load writes a row that almost never changes.

**Impact:** (1) Mutation-log bloat — Convex retains every mutation's writes; an unchanged `patch` is still a documented write. (2) Spurious realtime updates — any subscriber of a `users`-table query re-receives the doc on every boot, causing needless re-renders/re-fetches across clients. (3) Cost — Convex bills per mutation write; a per-boot write for a stable field is pure waste. The docstring's "safe to call on every app boot" is misleading because it conflates *correctness* safety with *cost* safety.

**Fix:** Compare before patching:
```ts
if (existing.name !== name || existing.email !== email) {
  await ctx.db.patch(existing._id, { name, email });
}
```

---

### [SEV: P2] Stale-JWT-vs-fresh-webhook last-write-wins reverts correct `name`/`email` after a Clerk profile change

**Location:** `convex/users.ts:44-48` (derivation in `ensureUser`) vs `25-29` (patch in `upsertFromClerk`); webhook source `convex/http.ts:78-98`; client source `apps/web/src/hooks/use-ensure-mirror.ts:28` and `apps/web/src/lib/ensure-mirror.ts:68`.

```ts
// ensureUser derives name/email from the *cached* JWT identity:
const name = identity.name || joinedName || identity.nickname || identity.email || "User";
const email = identity.email ?? "";
// …then unconditionally patches:
await ctx.db.patch(existing._id, { name, email });
```

**Problem:** Both the Clerk webhook (`user.updated` → `upsertFromClerk`) and the web app (`ensureUser` with `identity` from the JWT) write `name`/`email` to the same row with no versioning and no claim-recency guard. When a user updates their name or email in Clerk, the webhook fires `upsertFromClerk` with the fresh value, but a member's browser may still hold a JWT whose `name`/`email` claims predate the change (Clerk JWTs are issued at sign-in and refreshed on a fixed schedule). The member's next `ensureUser` call patches the **stale** JWT-derived value back over the webhook's correct value. Last write wins; there is no `updatedAt`/version guard to reject the regression.

**Impact:** Mirror drift in the window between a Clerk profile change and the slowest member's JWT refresh. Self-heals only when that member's JWT finally refreshes and they reboot. This is the same defect class documented as P2 in `reviews/convex.organizations.ts.md` ("upsertFromClerk (rename) races with stale client ensureOrganization").

**Fix:** Either (a) make `ensureUser` a pure get-or-create that never overwrites existing content (the webhook is the sole writer — the file already says Clerk is source of truth), or (b) add a monotonic `updatedAt`/claim-issued-at field and reject patches whose claim is older than the stored value. The cleanest fix is (a): once the row exists, `ensureUser` returns it without patching, leaving all writes to `upsertFromClerk`.

---

### [SEV: P3] `ensureUser` returns full `Doc<"users">` (including `email` PII) though no caller uses the return value

**Location:** `convex/users.ts:39` (signature) and the two return statements at `65` and `74`.

```ts
handler: async (ctx): Promise<Doc<"users">> => { … }
```

**Problem:** The return type exposes `email` (and `clerkUserId`) to the client. Both call sites discard the result:
- `apps/web/src/hooks/use-ensure-mirror.ts:28` — `await convex.mutation(api.users.ensureUser, {});` (return value unused)
- `apps/web/src/lib/ensure-mirror.ts:68` — `await client.mutation(api.users.ensureUser, {});` (return value unused)

So the PII in the response payload crosses the wire for no benefit.

**Impact:** Minor PII exposure — the user's own email is echoed back in a response they never read. Low risk because it is the user's own data, but it needlessly enlarges the PII surface and violates least-transmission.

**Fix:** Return `null` (or `Id<"users">`) from `ensureUser`:
```ts
handler: async (ctx): Promise<null> => {
  // … mirror logic …
  return null;
};
```

---

### [SEV: P3] `ensureUser` does a redundant `db.get` after `patch`

**Location:** `convex/users.ts:71-74`.

```ts
await ctx.db.patch(existing._id, { name, email });
const updated = await ctx.db.get(existing._id);   // ← redundant read
if (updated === null) {
  throw new Error("Failed to load updated user");
}
return updated;
```

**Problem:** After `patch`, the function re-reads the doc solely to return it. The returned `Doc<"users">` is fully determined by `existing` plus the just-patched `name`/`email` fields; the extra `db.get` is a wasted round-trip on every boot. The null-check is also dead — `existing` was just fetched and patched in the same transaction; it cannot be null.

**Impact:** One extra read per `/app` mount per user. Negligible per call, but it compounds with the write-amplification finding (P2 #3) into per-boot read+write overhead that scales with MAU.

**Fix:** Construct the return value from `existing` + the patched fields:
```ts
await ctx.db.patch(existing._id, { name, email });
return { ...existing, name, email };
```
(The same applies to the insert branch's `db.get` at `64-66`, though there at least the doc fields are not all locally known because `insert` returns only an `Id`.)

---

### [SEV: P3] `email = identity.email ?? ""` stores empty string for users whose JWT omits email — ambiguous and untypeable as "no email known"

**Location:** `convex/users.ts:47`.

```ts
const email = identity.email ?? "";
```

**Problem:** The schema declares `email: v.string()` (required, non-optional). When a Clerk JWT legitimately omits `email` (rare but possible — e.g., a phone-only user, or a JWT issued before email verification), `ensureUser` persists `""`. The empty string is indistinguishable from "we have no email on file", and the same `""` flows back through `upsertFromClerk`'s fallback at `http.ts:90` (`?? ""`). Two semantically distinct states collapse into one.

**Impact:** Downstream consumers cannot tell "user has no email" from "user's email is empty". Minor data-quality defect; no correctness break today since no other module reads `users.email`, but it bakes an ambiguity into the mirror that will bite the first consumer.

**Fix:** Make the schema field optional and store `undefined` when absent:
```ts
// schema.ts
users: defineTable({
  clerkUserId: v.string(),
  name: v.string(),
  email: v.optional(v.string()),
}).index("by_clerk_user", ["clerkUserId"]);
```
```ts
// users.ts
const email = identity.email;  // undefined when absent
```

---

## Summary

**Counts:** 7 findings — P0: 0, P1: 2, P2: 2, P3: 3.

**Top 3 to fix first:**

1. **P1 — Missing `user.deleted` handling.** Add `deleteFromClerk` to `users.ts` and a `case "user.deleted":` branch to `http.ts`. Closes a PII-retention / right-to-erasure hole and finishes the mirror symmetry the orgs file already has. ~10 lines.

2. **P1 — Duplicate-`clerkUserId` insert race.** Same class as the orgs P1. Pick one of: (a) reconcile-after-insert, or (b) make `ensureUser` get-or-throw and route all creation through the `user.created` webhook. The latter also kills P2 #4 (stale-JWT revert) for free, since `ensureUser` would stop writing.

3. **P2 — `ensureUser` write-amplification + stale-JWT last-write-wins.** Both stem from `ensureUser` unconditionally patching on every boot. Making `ensureUser` a pure get-or-create (fix #2 option b) eliminates both the write-amplification and the revert race in one change; the explicit "compare before patch" guard is the smaller fallback.

**Clean axes (no findings):** No cross-user edit surface (`ensureUser` keys off verified JWT `subject`, no client-supplied id); no role/admin field → no escalation or self-promotion surface; no table scans (both reads use the `by_clerk_user` index); `upsertFromClerk` is `internalMutation`-gated behind svix verification; error messages do not leak internal state.
