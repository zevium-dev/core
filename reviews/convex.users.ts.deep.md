# Tiger-Style Deep Review — `convex/users.ts`

> Deep-dive. Cross-reads: `convex/schema.ts`, `convex/auth.config.ts`, `convex/lib/auth.ts`, `convex/admin.ts`, `convex/http.ts`, `convex/organizations.ts`, plus callers `apps/web/src/hooks/use-ensure-mirror.ts`, `apps/web/src/lib/ensure-mirror.ts`. Prior shallow review: `reviews/convex.users.ts.md`. This pass verifies the two prior P1s against current source and expands.

## Verdict

**Incorrect + incomplete.** The two prior P1s are **confirmed live** against current source — `user.deleted` is still silently dropped (`http.ts` switch has no case; `users.ts` exports no `deleteFromClerk`; `organizations.ts:88` proves the pattern exists and was simply not ported to users), and the `by_clerk_user` index is still a plain non-unique `.index(...)` (`schema.ts:20`) while both writers (`upsertFromClerk` + `ensureUser`) use read-then-insert — the duplicate-`clerkUserId` race is reachable from at least four realistic concurrent-caller patterns and is **self-perpetuating**: once a duplicate exists, `.unique()` throws on every read in *both* writers, and the Clerk webhook then 500s on every `user.updated` retry because `http.ts:94` is unwrapped. No P0 (no cross-user edit, no role/admin column, `identity.subject` is cryptographically verified by `auth.config.ts`, `upsertFromClerk` is `internalMutation`-gated behind svix). Beyond the two P1s, the deep pass surfaces a divergent name-derivation bug (webhook and JWT writers compute *different* names from the *same* fresh data — distinct from the stale-JWT timing issue already filed), an email-blanking data-loss path, unbounded input with no length cap, missing `updatedAt`/audit, and a docstring that actively lies about the safety of `ensureUser` on every boot.

## File Stats

- **File:** `convex/users.ts` — 90 LOC, 2 exports.
- **Exports:** `upsertFromClerk` (`internalMutation`, called only from `convex/http.ts:94` behind svix verification), `ensureUser` (`mutation`, public, called from `apps/web/src/hooks/use-ensure-mirror.ts:28` and `apps/web/src/lib/ensure-mirror.ts:68`).
- **Schema:** `users: defineTable({ clerkUserId, name, email }).index("by_clerk_user", ["clerkUserId"])` — `schema.ts:16-20`. **No unique constraint** (Convex has none; `.unique()` is a query-time throw, not an insert-time guard).
- **Readers of the `users` table:** only the two functions in this file. `grep` for `query("users")` across `convex/` returns exactly `users.ts:13` and `users.ts:58`. No FK references to `users._id` anywhere (`notifications`, `keySettings`, `usageEvents` all key off `clerkOrgId`, not user id). → A hard delete is safe; there is no integrity excuse for the missing `deleteFromClerk`.
- **Auth model:** Clerk is source of truth; Convex mirrors. Admin gating is `ADMIN_USER_IDS` env in `lib/auth.ts:104-117` — not a column on `users`. No role-tampering / admin-self-promotion surface in this file. **Clean on that axis.**
- **Type verification:** `auth.config.ts` requires `CLERK_JWT_ISSUER_DOMAIN` (throws at module load if unset) and registers `applicationID: "convex"`. `ctx.auth.getUserIdentity()` therefore returns a subject whose issuer is cryptographically bound. `ensureUser` keys the row off `identity.subject` — no client-supplied id, no cross-user edit. **Clean.**

## Findings

### [SEV: P1] `user.deleted` Clerk webhook silently dropped — no `deleteFromClerk` mutation, PII (`name`, `email`) retained indefinitely (GDPR/CCPA right-to-erasure violation) — VERIFIED LIVE

**Location:** `convex/users.ts` (whole file — `deleteFromClerk` is absent); dispatch point `convex/http.ts:53-105` (`default: break;` at `:101`).

```ts
// convex/http.ts:53-101 — the webhook switch
switch (event.type) {
  case "organization.created":
  case "organization.updated": { … await ctx.runMutation(internal.organizations.upsertFromClerk, …); break; }
  case "organization.deleted":
    await ctx.runMutation(internal.organizations.deleteFromClerk, { clerkOrgId: … });   // ← orgs: handled
    break;
  case "user.created":
  case "user.updated": {
    const data = event.data as ClerkUserEventData;
    …
    await ctx.runMutation(internal.users.upsertFromClerk, { clerkUserId: data.id, name, email });
    break;
  }
  default:
    break;   // ← user.deleted lands here → 200 OK, no-op, PII retained forever
}
```

**Verification (current source):**
- `grep -n 'deleteFromClerk' convex/users.ts` → 0 matches.
- `grep -n 'user\.deleted' convex/http.ts` → 0 matches.
- `convex/organizations.ts:88` exports `deleteFromClerk` and cascades `wallets` + `walletEntries`. The pattern exists; users were never wired up.

**Problem:** When a user deletes their Clerk account (GDPR erasure request, account closure, admin purge, spam purge), Clerk emits `user.deleted`. The Convex webhook receives it, the `switch` falls through to `default: break;`, Convex returns 200, and the `users` row — containing `name` and `email` PII — is retained forever. Clerk sees a 200 and does not retry; the deletion is ack'd as processed.

**Impact:**
- **PII retention beyond lawful basis.** A user who deletes their Clerk account reasonably expects their email and profile to be purged from downstream systems. Here they are not, with no expiry, no TTL, no reconciliation job. This is a GDPR Art. 17 / CCPA right-to-erasure violation, not a theoretical risk — the deletion event is ack'd as handled.
- **Orphan accumulation.** The schema has no FK references to `users._id` (confirmed by `grep` across `convex/schema.ts`), so a hard delete is safe; there is no integrity excuse. The orgs mirror already does the right thing (`organizations.ts:88-121` cascades wallet + entries). The users mirror was simply never finished.
- **Asymmetry with orgs.** `organization.deleted` is handled and cascades; `user.deleted` is dropped. The codebase proves the project knows how to do this.

**Fix:** Port the org pattern to users. Add the case to `http.ts` and the mutation to `users.ts`:

```ts
// convex/users.ts
export const deleteFromClerk = internalMutation({
  args: { clerkUserId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    // Use .take(2) + manual loop, NOT .unique() — see P1 #2 below.
    // Once a duplicate clerkUserId exists, .unique() throws and the delete
    // path itself bricks, defeating erasure.
    const rows = await ctx.db
      .query("users")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", args.clerkUserId))
      .take(2);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
  },
});
```
```ts
// convex/http.ts — add to the switch, before default
case "user.deleted":
  await ctx.runMutation(internal.users.deleteFromClerk, {
    clerkUserId: (event.data as ClerkUserEventData).id,
  });
  break;
```

**Caveat (Convex history):** `db.delete()` removes the live document but Convex retains document history for snapshot/backup purposes. A full historical purge requires Convex's data-deletion API, not just `db.delete()`. The fix above satisfies the row-level erasure obligation (the live queryable PII is gone) but the privacy officer should be aware that point-in-time backups may still contain the row until they age out. Flagging because this file is the entirety of the user-PII surface in Convex.

---

### [SEV: P1] Duplicate-`clerkUserId` insert race in both `ensureUser` and `upsertFromClerk` — `by_clerk_user` is non-unique, `.unique()` then throws on every subsequent read, permanently bricking the user mirror AND the webhook path — VERIFIED LIVE, EXPANDED

**Location:** `convex/users.ts:12-23` (`upsertFromClerk` insert path), `convex/users.ts:57-66` (`ensureUser` insert path); schema `convex/schema.ts:20` — **not** a unique constraint.

```ts
// convex/users.ts:12-23 — upsertFromClerk
const existing = await ctx.db
  .query("users")
  .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", args.clerkUserId))
  .unique();                              // ← throws NonUniqueResponseError if a dup already exists

if (existing === null) {
  return await ctx.db.insert("users", {   // ← concurrent caller also observed null, also inserts
    clerkUserId: args.clerkUserId,        //   → two rows with identical clerkUserId
    name: args.name,
    email: args.email,
  });
}
```

```ts
// convex/schema.ts:16-20 — the index
users: defineTable({
  clerkUserId: v.string(),
  name: v.string(),
  email: v.string(),
}).index("by_clerk_user", ["clerkUserId"]),   // ← plain index, NOT unique
```

**Verification (current source):**
- `schema.ts:20` is `.index(...)`, not a unique constraint. Convex has **no** schema-level unique constraint primitive; `.unique()` on a query is a query-time throw, not an insert-time guard. Confirmed against current Convex semantics.
- Both writers (`upsertFromClerk:12-23`, `ensureUser:57-66`) use the identical read-then-insert get-or-create pattern with `.unique()` on read.

**Problem:** Two concurrent transactions each observe `existing === null` and both insert. The `by_clerk_user` index does not reject the second insert. Two `users` rows with the same `clerkUserId` now exist. From that point on:
1. Every `.unique()` read in `users.ts` throws `IndexedQueryNonUniqueError` — both `ensureUser` and `upsertFromClerk` fail permanently for that user.
2. **Expanded:** `http.ts:94` calls `ctx.runMutation(internal.users.upsertFromClerk, …)` **without a try/catch** (verified — `http.ts:88-99` has no wrapper). So a `user.updated` webhook for the affected user throws out of the httpAction, Convex returns 500, and **Clerk retries the same event forever** until its retry budget exhausts, at which point all further profile updates for that user are silently lost. The duplicate-row bug does not just brick `ensureUser` — it bricks the *webhook sync path* too and produces infinite retries that pollute Clerk's webhook delivery logs.
3. **No self-healing path.** No admin mutation in `admin.ts` touches `users` (verified — `admin.ts` operates on `organizations`, `projects`, `usageEvents`, `publisherTransfers` only). Recovery requires Convex dashboard access to manually delete the loser row.

**Realistic concurrent-caller patterns (all reachable on first authed boot for a brand-new Clerk user):**
- Clerk `user.created` webhook → `upsertFromClerk`, racing with the user's first `ensureUser` from `useEnsureMirror` (`apps/web/src/hooks/use-ensure-mirror.ts:28`) or `ensureMirrorOnServer` (`apps/web/src/lib/ensure-mirror.ts:68`). This is the *expected* first-load sequence — the webhook and the app-boot race by design.
- Two browser tabs / two devices loading `/app` simultaneously — `useEnsureMirror` fires for both.
- Svix retry of `user.created` racing the original delivery (svix retries are common on any transient 5xx).
- `ensureMirrorOnServer` (SSR, `apps/web/src/lib/ensure-mirror.ts:68`) racing `useEnsureMirror` (client hydrate) — already documented as P1 in `reviews/apps.web.src.lib.ensure-mirror.ts.md:28`.

**Impact:** For the affected user, `ensureUser` throws on every boot (broken app shell), `upsertFromClerk` throws on every webhook (infinite Clerk retries → eventual silent drift), and there is no automated recovery. Blast radius is contained to user-mirroring (no other module reads `users`), but for the affected user it is total. This is the exact defect class already documented P1 in `reviews/convex.organizations.ts.md` — the orgs file has it, the users file has it, and the schema fix (unique constraint) would need to be applied to both `by_clerk_user` and `by_clerk_org`.

**Fix (pick one, in order of preference):**

1. **Single authoritative writer.** Route all creation through the `user.created` webhook (`upsertFromClerk`). Make `ensureUser` a pure get-or-throw that does **not** insert — return the row if present, else throw (or return null and let the web app show a "profile not yet synced" state). This kills the race at the source, kills the write-amplification P2, and kills the stale-JWT P2 in one change. The webhook is the sole writer; the JWT-driven `ensureUser` is the sole reader.

2. **Reconcile-after-insert.** If you must keep `ensureUser` as a creator, after insert re-query `by_clerk_user` and delete losers within the same transaction:
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
     …
   }
   ```
   Note: `.collect()` not `.unique()` — `.unique()` would itself throw on the duplicate we are trying to clean up.

3. **Convex unique index (when available).** Track Convex's unique-index feature and apply it to `by_clerk_user` (and `by_clerk_org`). Until then, option 1 or 2 is mandatory.

**Both writers must be fixed in the same change** — fixing only `ensureUser` leaves `upsertFromClerk` racing itself across svix retries.

---

### [SEV: P2] Divergent name-derivation between `upsertFromClerk` (webhook) and `ensureUser` (JWT) — same fresh data produces *different* stored names, flip-flopping on every boot — NEW (distinct from the stale-JWT timing issue)

**Location:** `convex/users.ts:46-52` (`ensureUser` derivation) vs `convex/http.ts:83-92` (`upsertFromClerk` derivation, called from the webhook).

```ts
// convex/users.ts:46-52 — ensureUser, from the JWT identity
const joinedName = [identity.givenName, identity.familyName].filter(Boolean).join(" ");
const name =
  identity.name ||        // JWT "name" claim
  joinedName ||            // givenName + " " + familyName
  identity.nickname ||     // JWT "nickname"
  identity.email ||        // ← falls back to EMAIL
  "User";

// convex/http.ts:83-92 — upsertFromClerk, from the webhook payload
const name =
  [data.first_name, data.last_name]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ") ||
  data.username ||         // ← webhook falls back to USERNAME
  email ||
  "User";
```

**Problem:** The two writers use **different fallback chains** for the same logical field. They are not just racing on timing (the stale-JWT P2 already filed); they compute *different values* from the *same current* Clerk data. Concrete trace for a username-only user (no `first_name`/`last_name`, `username: "alice"`, `email: "a@b.com"`):

| Event | Writer | `name` computed | Stored |
|---|---|---|---|
| `user.created` webhook | `upsertFromClerk` | `"" || "alice"` → `"alice"` | `alice` |
| User loads `/app` (fresh JWT, same data) | `ensureUser` | `undefined \|\| "" \|\| undefined \|\| "a@b.com"` → `"a@b.com"` | `a@b.com` |
| `user.updated` webhook | `upsertFromClerk` | `"alice"` | `alice` |
| User reloads `/app` | `ensureUser` | `"a@b.com"` | `a@b.com` |

The two writers never converge. Clerk's JWT `name` claim is not guaranteed to be populated for username-only users (it is derived from `first_name`/`last_name`), and `identity.nickname` is not a standard Clerk JWT claim — Clerk's JWT template must explicitly include it. The webhook, by contrast, always has `data.username` available. So for any user whose display name relies on `username`, `ensureUser` will *always* overwrite the correct webhook-derived name with the user's email address, and the next webhook will overwrite it back.

**Impact:** Persistent flip-flop of the `name` column on every boot and every webhook, visible to any future consumer of `users.name`. Combined with the write-amplification P2 (unconditional patch), this means a write on every single boot that *also* corrupts the value. Distinct from the stale-JWT issue (which is about claim *recency*); this is about derivation *logic divergence* and reproduces with perfectly fresh, synchronized data.

**Fix:** Unify the fallback chain. Either (a) make `ensureUser` a pure get-or-create that never writes `name` (the webhook owns it — kills this bug, the stale-JWT bug, and the write-amplification bug in one change), or (b) extract a single `deriveName(...)` helper shared by both call sites and feed it the same inputs. Option (a) is strongly preferred — see P1 #2 fix.

---

### [SEV: P2] `email = identity.email ?? ""` overwrites a real email with `""` when a JWT omits the email claim — data-loss for the mirror

**Location:** `convex/users.ts:53`.

```ts
const email = identity.email ?? "";
// …
await ctx.db.patch(existing._id, { name, email });   // ← patches email to "" if JWT omitted it
```

**Problem:** The Clerk JWT `email` claim is populated *only if* the JWT template is configured to include it AND the user has a verified primary email. A JWT issued to a phone-only user, a user mid-email-verification, a user whose email was just removed, or — critically — a JWT template that drops the `email` claim entirely, will have `identity.email === undefined`. `ensureUser` coerces this to `""` and then **unconditionally patches** it over whatever the webhook stored. A user with a perfectly good `email: "a@b.com"` (set by `upsertFromClerk`) gets their mirror email blanked on the next boot if their JWT happens to omit the claim.

This is not theoretical: the JWT template (`jtmp_…` referenced in `.project/findings/wave1-convex.txt:3`) is a separate config surface from the webhook payload. Any template edit that drops `email` (or a Clerk-side regression) immediately blanks every user's mirror email on next boot, with no detection — the schema accepts `""` (`email: v.string()`), the patch succeeds, and `upsertFromClerk` will restore it only on the next `user.updated` event (which may not come for the user's lifetime if they never edit their profile).

**Impact:** Silent email data loss in the mirror, recoverable only by a future `user.updated` webhook. Any downstream consumer trusting `users.email` (none today, but the schema exposes it) will see empty strings. Compounds with the divergent-name P2 above — both are symptoms of `ensureUser` writing fields it cannot authoritatively derive.

**Fix:** Do not coerce undefined → "". Either (a) make `ensureUser` a pure get-or-create (preferred — see P1 #2), or (b) skip the patch when the JWT cannot authoritatively fill the field:
```ts
const patch: Partial<Doc<"users">> = {};
if (typeof identity.email === "string" && identity.email.length > 0) patch.email = identity.email;
// only patch fields that are authoritatively present
if (Object.keys(patch).length > 0) await ctx.db.patch(existing._id, patch);
```
Better: make the schema field optional (`v.optional(v.string())`) and store `undefined` when absent, so "no email known" is distinguishable from "email is empty string" (also filed as P3 in the shallow review).

---

### [SEV: P2] `upsertFromClerk` patches `name`/`email` unconditionally on every `user.updated` — same write-amplification as `ensureUser`, but driven by Clerk's webhook frequency

**Location:** `convex/users.ts:25-30`.

```ts
await ctx.db.patch(existing._id, {
  name: args.name,
  email: args.email,
});
```

**Problem:** The shallow review filed write-amplification against `ensureUser` (`users.ts:67-70`). The same defect exists in `upsertFromClerk` (`users.ts:25-30`): every `user.updated` webhook patches `name` and `email` regardless of whether either field changed. Clerk fires `user.updated` on a broad set of triggers — sign-in events in some configurations, MFA enrollment, email verification, profile edits, session extension. Each one produces a Convex mutation write, a `_revision` bump, and a realtime fan-out to any subscriber of the `users` table — even when the row content is byte-identical.

**Impact:** Mutation-log bloat, spurious realtime fan-out, per-webhook mutation cost. Compounds with P1 #2 (the race) because every webhook is also a potential racing inserter. The docstring at `users.ts:35` ("Safe to call on every app boot") applies to `ensureUser`; `upsertFromClerk` has no such docstring blessing frequent no-op writes, but the code structure imposes them.

**Fix:** Compare before patching, in both writers:
```ts
if (existing.name !== args.name || existing.email !== args.email) {
  await ctx.db.patch(existing._id, { name: args.name, email: args.email });
}
```
Or, more cleanly, route all writes through the webhook and make `ensureUser` non-writing (P1 #2 fix option 1) — then only `upsertFromClerk` needs the compare guard.

---

### [SEV: P2] `http.ts:94` calls `upsertFromClerk` without try/catch — webhook mutation failures leak internal errors to Clerk and trigger infinite retry

**Location:** `convex/http.ts:88-99` (the `user.created`/`user.updated` branch).

```ts
case "user.created":
case "user.updated": {
  const data = event.data as ClerkUserEventData;
  const primary = data.email_addresses?.find((entry) => entry.id === data.primary_email_address_id);
  const email = primary?.email_address ?? data.email_addresses?.[0]?.email_address ?? "";
  const name = [data.first_name, data.last_name].filter(…).join(" ") || data.username || email || "User";
  await ctx.runMutation(internal.users.upsertFromClerk, {   // ← unwrapped
    clerkUserId: data.id,
    name,
    email,
  });
  break;
}
```

**Verification:** The Svix `verify` is wrapped (`http.ts:44-49`), but none of the three `ctx.runMutation` calls in the Clerk handler (`organizations.upsertFromClerk:61`, `organizations.deleteFromClerk:70`, `users.upsertFromClerk:94`) are wrapped in try/catch. Confirmed by reading `http.ts:38-103`.

**Problem:** If `upsertFromClerk` throws — arg-validation failure (`email` undefined → Convex rejects because `v.string()` requires a string, but the `?? ""` fallback masks this; however `name` could be a non-string if Clerk's shape changes), a `NonUniqueResponseError` from a pre-existing duplicate (see P1 #2 — once a duplicate exists, *every* webhook for that user throws here), or any Convex transient — the uncaught error propagates out of the httpAction. Convex returns the raw error message in a 500 body to Clerk, which then retries the same event on its exponential backoff schedule. Permanent failures (the duplicate-row case) retry until Clerk's retry budget exhausts, then the sync is silently lost.

This is cross-cutting with `users.ts` because `upsertFromClerk` is the user-facing half of this contract: a duplicate-row bug in `users.ts` (P1 #2) manifests here as an infinite-retry bug in `http.ts`. The two files fail together.

**Impact:** (1) Internal error strings (table names, validator messages, `NonUniqueResponseError` class names) leak to the webhook sender in the 500 body. (2) Permanent mutation failures produce infinite Clerk retries, polluting Clerk's delivery logs and eventually exhausting the retry budget → silent permanent drift. (3) The duplicate-row P1 #2 becomes a *visibility* problem here — the operator sees a flapping webhook but the root cause is in `users.ts` schema/mutation design.

**Fix:** Wrap the mutation in try/catch; on `NonUniqueResponseError` (or any error class indicating a pre-existing duplicate), run a one-shot reconcile mutation and retry; on other errors, return a structured 500 with a generic message (no internals) and let Clerk retry. Log the full error server-side for operator visibility:
```ts
try {
  await ctx.runMutation(internal.users.upsertFromClerk, { clerkUserId: data.id, name, email });
} catch (error) {
  console.error("users.upsertFromClerk failed", { clerkUserId: data.id, message: error instanceof Error ? error.message : String(error) });
  // TODO: if NonUniqueResponseError, run reconcile mutation; else let Clerk retry
  return new Response("user sync failed", { status: 500 });
}
```
(The same applies to the two org mutations at `http.ts:61` and `:70` — file a parallel finding in `http.ts` review.)

---

### [SEV: P2] No input length / size validation on `name` or `email` in either writer — unbounded webhook payload → Convex document-size limits / mutation-log bloat

**Location:** `convex/users.ts:6-10` (`upsertFromClerk` args), `convex/users.ts:37-39` (`ensureUser` takes no args but derives from `identity`); schema `convex/schema.ts:16-20` (`name: v.string()`, `email: v.string()` — no max length).

**Problem:** Neither writer validates the length of `name` or `email`. The schema declares them as bare `v.string()` with no upper bound. Clerk's webhook payload is svix-verified (so trust is high), but:
- Clerk does not enforce a documented max length on `first_name` / `last_name` / `username` at the API contract level — they are bounded in the dashboard UI but the API accepts longer strings.
- A `name` derived from `data.first_name + " " + data.last_name` could in principle be large; the webhook `name` arg flows straight into a Convex document field with no cap.
- Convex documents have a 1 MB limit; while a single `name`/`email` won't hit that, the absence of any validation is a defense-in-depth gap. More realistically, an unusually long `username` (Clerk allows up to ~100 chars, but third-party SSO providers feeding into Clerk may not cap) becomes a multi-KB row that bloats the mutation log on every write (compounded by P2 write-amplification).

**Impact:** Low probability, but unbounded input with no validation is a defense-in-depth gap. Combined with the write-amplification P2, a long `name` is copied on every boot. No correctness break today.

**Fix:** Add a length cap at the validator and derivation layer:
```ts
// users.ts
const MAX_NAME_LEN = 200;
const MAX_EMAIL_LEN = 320;  // RFC 3696
name: v.string(),  // schema unchanged, but validate in handler:
// in upsertFromClerk handler:
const safeName = args.name.slice(0, MAX_NAME_LEN);
const safeEmail = args.email.slice(0, MAX_EMAIL_LEN);
```
Or use `v.string().trim()` patterns where Convex supports them.

---

### [SEV: P3] `ensureUser` returns full `Doc<"users">` (incl. `email`, `clerkUserId`, `_id`, `_creationTime`, `_revision`) — no caller uses the return value; PII and Convex metadata cross the wire for no benefit

**Location:** `convex/users.ts:39` (signature) and return statements at `:65`, `:74`.

```ts
handler: async (ctx): Promise<Doc<"users">> => { … }
```

**Verification:** Both call sites discard the result:
- `apps/web/src/hooks/use-ensure-mirror.ts:28` — `await convex.mutation(api.users.ensureUser, {});` (return unused)
- `apps/web/src/lib/ensure-mirror.ts:68` — `await client.mutation(api.users.ensureUser, {});` (return unused)

`grep` for `mirror.userId`, `mirror.orgId`, `mirror.orgSlug`, `ensureUser` return consumers → no caller reads the return.

**Problem:** The return payload includes `email` (PII), `clerkUserId` (correlatable identifier), and Convex internals (`_id`, `_creationTime`, `_revision`). All of it crosses the wire to a client that discards it. The shallow review filed this as P3; this pass confirms both call sites still ignore the return and adds the `_creationTime` / `_revision` metadata leak to the PII surface.

**Impact:** Minor PII / metadata over-transmission. The user's own data echoing back to themselves is low risk, but `_revision` and `_creationTime` leak Convex-internal document metadata that a client has no business reading, and the payload size is wasted bandwidth on every boot.

**Fix:** Return `null` (or `Id<"users">` if a future caller needs the id):
```ts
handler: async (ctx): Promise<null> => { … return null; };
```

---

### [SEV: P3] `ensureUser` does a redundant `db.get` after `patch` — wasted read on every boot

**Location:** `convex/users.ts:71-74`.

```ts
await ctx.db.patch(existing._id, { name, email });
const updated = await ctx.db.get(existing._id);   // ← redundant
if (updated === null) {
  throw new Error("Failed to load updated user");   // ← dead branch
}
return updated;
```

**Problem:** After `patch`, the function re-reads the doc solely to return it. The returned `Doc<"users">` is fully determined by `existing` plus the just-patched `name`/`email`. The extra `db.get` is a wasted round-trip on every boot. The null-check is dead — `existing` was just fetched in the same transaction; it cannot be null unless a concurrent delete ran, which the `user.deleted` webhook *would* do if it existed (see P1 #1) — so this dead branch would mask a real concurrent-delete scenario if the webhook were wired up. Today it's just dead code; if P1 #1 is fixed without fixing this, the branch becomes a silent-swallow of a real race.

**Impact:** One extra read per `/app` mount per user. Negligible per call but compounds with P2 write-amplification into per-boot read+write overhead scaling with MAU. The dead null-check is a latent footgun if P1 #1 is fixed in isolation.

**Fix:** Construct the return value locally:
```ts
await ctx.db.patch(existing._id, { name, email });
return { ...existing, name, email };
```
(The insert branch's `db.get` at `:64-66` is more defensible — `insert` returns only an `Id`, not a doc — but can also be replaced by constructing the doc from the known insert args plus a `_creationTime: Date.now()` approximation if exactness isn't required. Leaving that as-is is acceptable; the patch branch is the clear waste.)

---

### [SEV: P3] No `updatedAt` / `createdAt` / `mirroredAt` column on `users` — no audit trail, no stale-mirror detection, no operator visibility into sync health

**Location:** `convex/schema.ts:16-20`.

```ts
users: defineTable({
  clerkUserId: v.string(),
  name: v.string(),
  email: v.string(),
}).index("by_clerk_user", ["clerkUserId"]);
```

**Problem:** Every other mutable mirror table in the schema carries an `updatedAt` timestamp: `organizationPayments.updatedAt`, `keySettings.updatedAt`, `publisherEarnings.updatedAt`, `publisherTransfers.updatedAt`, `connectedPayouts.updatedAt`, `checkoutIntents.updatedAt`/`createdAt`, `paymentEvents.receivedAt`/`processedAt`, `payments.updatedAt`/`createdAt`. The `users` table — the PII-bearing mirror of Clerk's auth truth — has none. There is no way for an operator to answer "when was this user's mirror last synced?" or "is this user's mirror stale relative to Clerk?" from the data alone. The `organizations` table (the sibling mirror) also lacks `updatedAt`, so this is a cross-cutting schema asymmetry, but `users` is the one with PII-retention obligations (P1 #1) where audit visibility matters most.

**Impact:** No operator visibility into mirror sync health. If the webhook silently stops delivering for a user (the P2 infinite-retry-then-drop path), there is no in-data signal that the mirror is stale. The GDPR erasure obligation (P1 #1) is harder to audit without a `mirroredAt` column to compare against deletion timestamps.

**Fix:** Add `updatedAt` and `createdAt` to the `users` schema; set them in both writers:
```ts
users: defineTable({
  clerkUserId: v.string(),
  name: v.string(),
  email: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
}).index("by_clerk_user", ["clerkUserId"]);
```
```ts
// in upsertFromClerk insert:
await ctx.db.insert("users", { …, createdAt: Date.now(), updatedAt: Date.now() });
// in patch:
await ctx.db.patch(existing._id, { …, updatedAt: Date.now() });
```

---

### [SEV: P3] No `by_email` index — any future support / dedup / lookup by email would table-scan

**Location:** `convex/schema.ts:16-20`.

**Problem:** The `users` table has only `by_clerk_user`. There is no index on `email`. No current caller queries by email (verified by `grep`), so this is not a live performance bug. But the moment a support tool, dedup job, or "find user by email" lookup is added, it will table-scan. Given the table also lacks `updatedAt` (P3 above) and has no unique constraint (P1 #2), the schema is the weakest mirror in the codebase.

**Impact:** Latent. No current caller is affected. Flagging because the schema is the right place to fix this proactively alongside the unique-constraint work in P1 #2.

**Fix:** Add `.index("by_email", ["email"])` if/when an email-lookup consumer is introduced. Not worth adding speculatively — but worth noting in the schema-hardening ticket that comes out of P1 #2.

---

### [SEV: P3] `ensureUser` docstring ("Safe to call on every app boot; returns the canonical row") is actively false — it is unsafe on every boot (write-amplification + stale-JWT + divergent-name + email-blanking + race)

**Location:** `convex/users.ts:33-36`.

```ts
/**
 * Mirror the authenticated Clerk identity into the users table.
 * Safe to call on every app boot; returns the canonical row.
 */
export const ensureUser = mutation({ … });
```

**Problem:** The docstring blesses the call pattern that drives four of the findings in this review: write-amplification (P2), stale-JWT revert (P2 — filed in shallow review), divergent name derivation (P2 — new in this pass), email blanking (P2 — new in this pass), and the duplicate-row race (P1 #2). "Safe to call on every app boot" is true only in the narrow sense of "does not throw on the happy path"; it is false on correctness (overwrites webhook data with stale/divergent JWT data), false on cost (writes on every boot), and false on concurrency (races with the webhook). The callers (`useEnsureMirror:11` "On /app mount: call … once per user/org pair") rely on this docstring's blessing.

**Impact:** The docstring is a load-bearing lie. Future maintainers will read "safe to call on every boot" and propagate the call pattern into new routes / new callers without reconsidering the cost or the write-correctness hazards. The shallow review already flagged the cost angle; this pass flags the correctness angle as well.

**Fix:** Either fix `ensureUser` to be a true get-or-create (preferred — P1 #2 fix option 1, which makes the docstring true), or rewrite the docstring to reflect reality:
```ts
/**
 * Returns the user's mirror row, creating it if missing. CAUTION: on existing
 * rows this overwrites name/email from the JWT, which may be stale or divergent
 * relative to the webhook's authoritative values — prefer the webhook as the
 * sole writer. Not safe to call on every boot without comparing first.
 */
```

---

## Summary

**Counts:** 11 findings — **P0: 0**, **P1: 2**, **P2: 5**, **P3: 4**.

**Verified (against current source):**
- ✅ P1 #1 — `user.deleted` dropped, `deleteFromClerk` absent, PII retained. `grep` confirms no case in `http.ts`, no mutation in `users.ts`; `organizations.ts:88` proves the pattern exists.
- ✅ P1 #2 — Duplicate-`clerkUserId` race. `schema.ts:20` is non-unique `.index(...)`; both writers (`users.ts:12-23`, `:57-66`) use read-then-insert with `.unique()` on read. **Expanded:** the race also bricks the webhook path (`http.ts:94` unwrapped) → infinite Clerk retries.

**New (this pass):**
- ➕ P2 — Divergent name-derivation between webhook (`username` fallback) and JWT (`email` fallback) — produces different stored values from the same fresh data; distinct from the stale-JWT timing issue.
- ➕ P2 — `email = identity.email ?? ""` overwrites real emails with `""` when a JWT omits the email claim — silent mirror data loss.
- ➕ P2 — `upsertFromClerk` also patches unconditionally (write-amplification, webhook-driven, not just boot-driven).
- ➕ P2 — `http.ts:94` unwrapped `runMutation` → duplicate-row P1 manifests as infinite Clerk retries + internal-error leak.
- ➕ P2 — No input length validation on `name`/`email`.
- ➕ P3 — No `updatedAt`/`createdAt` on `users` (asymmetric with every other mutable mirror table; hurts erasure audit).
- ➕ P3 — No `by_email` index (latent).
- ➕ P3 — Docstring actively lies about safety of calling on every boot.

**Top 3 to fix first:**

1. **P1 #1 — Add `deleteFromClerk` + `case "user.deleted":`.** Port `organizations.ts:88` to users. Use `.take(2)` + loop (NOT `.unique()`) so the delete path itself survives a pre-existing duplicate. Closes a PII-retention / right-to-erasure hole. ~15 lines across `users.ts` + `http.ts`.

2. **P1 #2 — Kill the duplicate-`clerkUserId` race at the source.** Make `ensureUser` a pure get-or-throw (no insert, no patch); route all creation and updates through the `user.created`/`user.updated` webhook (`upsertFromClerk`). This single change also kills: the divergent-name P2 (webhook becomes sole writer), the email-blanking P2 (JWT no longer writes), the write-amplification P2 (no per-boot writes), the stale-JWT P2 (JWT no longer writes), and the lying docstring (becomes true). It is the highest-leverage fix in this file.

3. **P2 — Wrap `http.ts:94` `runMutation` in try/catch.** Decouples the webhook delivery path from `users.ts` mutation failures; on `NonUniqueResponseError`, run a reconcile mutation; on other errors, return a generic 500 (no internals) and let Clerk retry. Prevents the P1 #2 race from becoming a visible infinite-retry storm and stops internal error strings leaking to Clerk.

**Clean axes (no findings):** No cross-user edit surface (`ensureUser` keys off cryptographically verified `identity.subject`, no client-supplied id); no role/admin column → no escalation or self-promotion surface; `upsertFromClerk` is `internalMutation`-gated behind svix verification; no table scans (both reads use `by_clerk_user` index); no `any` type escapes; no dead imports; `auth.config.ts` correctly fails-closed on missing `CLERK_JWT_ISSUER_DOMAIN`.
