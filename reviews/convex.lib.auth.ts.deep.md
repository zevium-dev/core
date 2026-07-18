# Tiger Deep-Dive Review — `convex/lib/auth.ts`

Authorization foundation for the entire Zevium control plane. Every
org-scoped query/mutation in `convex/` (`projects`, `wallets`, `specs`,
`webhooks`, `notifications`, `analytics`, `earnings`, `usage`, `billing`,
`payouts`, `keySettings`, `catalogue`, `admin`) ultimately routes through
`requireIdentity` / `requireOrgMemberBySlug` / `requireProjectMember` /
`requireAdmin` / `isAdmin` / `getOrgBySlug`. A bug here compromises every
protected function. Read in full + `auth.config.ts`, `users.ts`,
`organizations.ts`, `projects.ts`, `wallets.ts`, `schema.ts`, and grepped
every convex/ consumer of each export.

## Verdict

**Incorrect — one P1 and several P2 correctness gaps.** The core membership
binding (`org.clerkOrgId === claims.orgId`) is sound, and the admin gate
fails closed. But the role claim is parsed and threaded through the entire
claims surface yet never enforced anywhere, so every org-scoped operation —
including destructive ones (project delete, spec version deprecation,
webhook endpoint registration, org slug rename) — is gated by **membership
alone**, not role. Combined with an empty-string orgId gap, duplicated
claim-extraction logic that has already drifted across three modules, and
resource-existence oracles, this is not a foundation to build further
authz on without changes.

## File Stats

- File under review: `convex/lib/auth.ts` (152 lines, 6 exports)
- Cross-read in full: `convex/auth.config.ts`, `convex/users.ts`,
  `convex/organizations.ts`, `convex/projects.ts`, `convex/wallets.ts`,
  `convex/schema.ts`, `convex/keySettings.ts`, `convex/notifications.ts`,
  `convex/billing.ts` (claim extraction), `convex/payouts.ts` (claim
  extraction), `convex/admin.ts` (admin-in-action).
- Export consumers grepped: `requireIdentity` (9 callers),
  `requireOrgMemberBySlug` (10 callers), `requireProjectMember` (9 callers),
  `requireAdmin` (5 callers), `isAdmin` (1 caller), `getOrgBySlug` (2
  callers), `OrgIdentityClaims` (type only).

## Findings

---

### [SEV: P1] Destructive + privilege-escalating operations gated by membership only — `orgRole` available but never enforced

**Location:** `convex/lib/auth.ts:63-110` (`requireOrgMemberBySlug`,
`requireProjectMember`); downstream callers `convex/projects.ts:41-97,111-200,202-227`, `convex/organizations.ts:123-186`, `convex/webhooks.ts:102-180`, `convex/specs.ts:101-150,310-400`.

```ts
// requireOrgMemberBySlug — the only membership test
if (org.clerkOrgId !== claims.orgId) {
  throw new Error("Not a member of this organization");
}
// requireProjectMember — the only membership test
if (org.clerkOrgId !== claims.orgId) {
  throw new Error("Not a member of this organization");
}
```

**Problem.** `OrgIdentityClaims.orgRole` is parsed from the Clerk
`org_role` claim (snake + camel fallback) and returned by every
`require*` helper, but a codebase-wide grep for `claims.orgRole` /
`.orgRole` outside `auth.ts` returns **zero** consumers. No caller gates on
role. Consequently an `org:member` can perform every operation an
`org:admin` can, including:

- `projects.remove` — **deletes a project and all its specVersions**
  (`projects.ts:202-227`) with only `requireProjectMember`.
- `projects.update` with `visibility: "public"` — **flips a private
  project to the public catalogue** (`projects.ts:111-150`), exposing
  previously private spec content to anonymous catalogue consumers.
- `organizations.ensureOrganization` — any member can **rename the org**
  and, critically, **change its `slug`** (`organizations.ts:123-186`),
  which is the public catalogue handle. See P2 finding below.
- `webhooks.upsertEndpoint` — any member registers an attacker-controlled
  URL that receives org event payloads (`webhooks.ts:102-140`).
- `specs.publishVersion` / `specs.deprecateVersion` / `specs.sunsetVersion`
  — any member publishes, deprecates, or sunsets spec versions.

**Impact.** A low-privilege org member (the default Clerk role for invited
users) can permanently destroy projects, exfiltrate private spec content to
the public catalogue, point webhooks at attacker infrastructure, and
rename the org's public identity. For a marketplace holding prepaid
org-scoped credits and running payouts, the webhook endpoint alone is a
data-exfiltration primitive; the slug rename is a denial-of-service /
squatting primitive against the public catalogue. This is the single most
consequential gap in the authz foundation.

**Fix.** Consume `orgRole`: gate destructive and org-identity-mutating
operations on `org:admin` (or an explicit allow-list per operation). At
minimum:

```ts
export function requireOrgAdmin(claims: OrgIdentityClaims): void {
  if (claims.orgRole !== "org:admin") {
    throw new Error("Org admin role required");
  }
}
// projects.remove / projects.update(visibility) / ensureOrganization /
// webhooks.upsertEndpoint / specs.publishVersion / specs.deprecateVersion
```

If the flat-membership model is genuinely intended, **drop `orgRole` from
`OrgIdentityClaims`** so future code does not assume enforcement that
does not exist. As written, the field is a footgun: it advertises a
capability the system does not provide.

---

### [SEV: P2] `orgRole` parsed + threaded + typed but never read — dead data that misleads future maintainers

**Location:** `convex/lib/auth.ts:4-9,34-39,42-47,88-93,116-121`.

```ts
export type OrgIdentityClaims = {
  subject: string;
  orgId: string | undefined;
  orgSlug: string | undefined;
  orgRole: string | undefined;     // ← parsed, returned, never read
};
// …
const orgRole =
  typeof raw.org_role === "string"
    ? raw.org_role
    : typeof raw.orgRole === "string"   // ← dead fallback
      ? raw.orgRole
      : undefined;
```

**Problem.** `orgRole` is extracted, carried through every `require*`
return type, and surfaced to every caller — yet no caller inspects it
(verified by grep across all of `convex/`). This is the root cause of the
P1 above: the type system suggests role-aware authz is wired up when it
is not. A maintainer adding a new mutation will reach for
`claims.orgRole` believing it is enforced, or — worse — will not add a
role check because the existing code "already threads role."

**Impact.** Latent authorization regressions on every future org-scoped
mutation. The field's presence in the public `OrgIdentityClaims` type is
an implicit contract that is not honored.

**Fix.** Either enforce it (see P1 fix) or delete the field and its
extraction. Do not leave it half-alive.

---

### [SEV: P2] `requireIdentity` accepts empty-string `orgId` — downstream `!== undefined` checks pass

**Location:** `convex/lib/auth.ts:13-47,68,94,132` and consumers
`convex/organizations.ts:42-51,131-134`, `convex/billing.ts:917-924`,
`convex/payouts.ts:643-648`, `convex/notifications.ts:73-83`.

```ts
const orgId =
  typeof raw.org_id === "string"
    ? raw.org_id            // ← "" passes: typeof "" === "string"
    : typeof raw.orgId === "string"
      ? raw.orgId
      : undefined;
// …
if (claims.orgId === undefined) {   // ← "" is not undefined → proceeds
  throw new Error("No active organization on identity");
}
```

**Problem.** The guard rejects `undefined` only. An empty-string
`org_id` claim passes every downstream `!== undefined` membership gate.
The two duplicate implementations in `billing.ts:155-166` and
`payouts.ts:24-35` (`activeClerkOrgId`) **do** add `orgId.trim() === ""`
rejection — proving the canonical helper is the one with the gap, and the
copies have already drifted to fix it.

Concrete blast radius if a JWT template misconfiguration ever emits an
empty `org_id`:

- `organizations.ensureOrganization` with `clerkOrgId: ""`:
  `claims.orgId === undefined` is false and `claims.orgId !==
  args.clerkOrgId` is `"" !== ""` → false → **passes**, inserting or
  patching an org row whose `clerkOrgId` is `""` (`organizations.ts:131-134`).
- `organizations.listMine` queries `by_clerk_org` eq `""` and returns
  whatever row has that value.
- `billing.ts`/`payouts.ts` go through the trimmed duplicate, so they
  reject — but `requireIdentity`-based paths (`notifications.markRead`,
  `organizations.ensureOrganization`, `organizations.listMine`) do not.

**Impact.** Defense-in-depth hole. Clerk does not issue empty `org_id`
under normal operation, but a misconfigured JWT template, a future
non-Clerk issuer, or a test fixture with an empty claim silently grants
access to the empty-org row rather than failing closed.

**Fix.** Reject empty/whitespace orgId at the canonical source:

```ts
const orgId = typeof raw.org_id === "string" && raw.org_id.trim() !== ""
  ? raw.org_id
  : typeof raw.orgId === "string" && raw.orgId.trim() !== ""
    ? raw.orgId
    : undefined;
```

Then delete the duplicated `activeClerkOrgId` helpers in `billing.ts`
and `payouts.ts` and have them call `requireIdentity` instead — the
canonical helper should be the single source of claim parsing.

---

### [SEV: P2] `organizations.ensureOrganization` lets any member rename the org + change its public slug — no role gate, no slug-uniqueness enforcement on patch

**Location:** `convex/organizations.ts:123-186` (gated only by
`requireIdentity` + `claims.orgId === args.clerkOrgId`); schema
`convex/schema.ts:10-13`.

```ts
const claims = await requireIdentity(ctx);
if (claims.orgId === undefined || claims.orgId !== args.clerkOrgId) {
  throw new Error("Organization does not match authenticated identity");
}
// … existing branch:
await ctx.db.patch(existing._id, {
  name: args.name,
  slug: args.slug,        // ← any member overwrites the public catalogue handle
  imageUrl: args.imageUrl,
});
```

**Problem.** Two compounding defects:

1. **No role gate.** The membership check (`claims.orgId ===
   args.clerkOrgId`) confirms only that the caller's active org matches
   the target org. Any `org:member` can call this with a new `slug` /
   `name` and the row is patched. The slug is the org's public catalogue
   identity (`getOrgBySlug`, catalogue listings, `specs.getPublishedForGateway`
   all key off it).

2. **No slug-uniqueness enforcement.** The schema declares
   `.index("by_slug", ["slug"])` — a plain index, **not** a unique
   constraint. Convex indexes are not uniqueness constraints; only the
   `.unique()` *query* method enforces at read time. So
   `ensureOrganization` can patch `existing.slug` to a value already
   owned by a different org row. After that, `getOrgBySlug` (which uses
   `.unique()`) **throws** a raw Convex "Multiple rows" error for that
   slug, breaking the catalogue for both orgs.

**Impact.** A non-admin member can (a) rename the org's public identity,
breaking every deep link / bookmark / external catalogue reference, and
(b) collide its slug with another org, breaking `getOrgBySlug`-based
reads for both. Combined with the P1 role gap, this is a
denial-of-service + brand-impersonation primitive available to any
invited member.

**Fix.** Gate `ensureOrganization` on `org:admin` (see P1). Separately,
either enforce slug uniqueness at the DB layer (Convex does not support
unique constraints directly — guard with a `by_slug` uniqueness check
inside the same transaction and throw a clean error on collision) or
disallow slug changes on the patch path (slug immutable post-creation).

---

### [SEV: P2] Resource-existence oracle — `requireOrgMemberBySlug` and `requireProjectMember` distinguish "not found" from "not a member"

**Location:** `convex/lib/auth.ts:71-79,98-108`.

```ts
// requireOrgMemberBySlug
const org = await getOrgBySlug(ctx, orgSlug);
if (org === null) {
  throw new Error("Organization not found");        // ← reveals: no such slug
}
if (org.clerkOrgId !== claims.orgId) {
  throw new Error("Not a member of this organization"); // ← reveals: slug exists
}
// requireProjectMember
const project = await ctx.db.get(projectId);
if (project === null) {
  throw new Error("Project not found");             // ← reveals: no such id
}
// …
if (org.clerkOrgId !== claims.orgId) {
  throw new Error("Not a member of this organization"); // ← reveals: id exists
}
```

**Problem.** The two error paths leak resource existence. An authenticated
caller (any org) can enumerate which org slugs and which project ids
exist by distinguishing the two messages. `keySettings.getOwnedRow`
(`keySettings.ts:104-112`) already does this correctly — it throws
`"Key not found"` for both null and cross-org cases specifically to
"not leak existence." The canonical helpers do not follow the same
discipline, and the inconsistency is itself a signal that the pattern is
known.

For org slugs the exposure is limited (slugs are public catalogue
handles). For **project ids** (`v.id("projects")`) the exposure is
meaningful: a caller who obtains or guesses a `projectId` can confirm
its existence even if their org does not own it, which is useful
reconnaissance ahead of a targeted attack on the owning org.

**Impact.** Information disclosure of project existence by id, and
inconsistent error discipline that makes the authz surface harder to
audit. Severity is bounded because project ids are 128-bit Convex ids
(not guessable) and the next gate (membership) still denies access.

**Fix.** Collapse the two branches into one message:

```ts
if (org === null || org.clerkOrgId !== claims.orgId) {
  throw new Error("Organization not found");
}
```

Apply the same to `requireProjectMember`. Match the `keySettings`
discipline.

---

### [SEV: P2] Duplicated claim-extraction + admin-gate logic across four modules — already drifted

**Location:** `convex/lib/auth.ts:13-47` (`requireIdentity`) vs
`convex/billing.ts:140-166` (`activeClerkOrgId` +
`requireActiveClerkOrgInAction`) vs `convex/payouts.ts:24-35` (identical
copy) vs `convex/admin.ts:321-341` (`requireAdminInAction` — a third
copy of the admin logic in `requireAdmin`/`isAdmin`).

```ts
// billing.ts:155-166 and payouts.ts:24-35 — same body, copied twice
function activeClerkOrgId(identity: unknown): string {
  // … same org_id/orgId extraction as requireIdentity, but adds:
  if (orgId === undefined || orgId.trim() === "") {   // ← trim guard auth.ts lacks
    throw new Error("Active organization required");
  }
  return orgId;
}
// admin.ts:321-341 — re-implements requireAdmin for ActionCtx
async function requireAdminInAction(ctx: ActionCtx): Promise<void> {
  // … same env-parse + includes(subject) as requireAdmin, returns void
}
```

**Problem.** The claim-extraction logic exists in **three** copies
(auth.ts, billing.ts, payouts.ts) and the admin-gate logic in **three**
copies (`requireAdmin`, `isAdmin`, `requireAdminInAction`). They have
**already drifted**: the billing/payouts copies added the `.trim()`
empty-string guard that the canonical `requireIdentity` lacks (see the
P2 above). `requireAdminInAction` returns `void` while `requireAdmin`
returns `OrgIdentityClaims` — so an action that needs the subject must
re-extract it. There is no shared seam; a future fix to claim parsing
must be applied in N places and will inevitably miss one.

**Impact.** The empty-string orgId gap in the canonical helper already
exists *because* the fix was applied to the copies and not upstream.
Each additional copy is a future drift point. This is exactly the kind
of inconsistency that produces the next authz bug.

**Fix.** Extract claim parsing into one place. `requireIdentity` (and an
`actionCtx` variant) should be the sole authority; `billing.ts` and
`payouts.ts` should call `requireIdentity` and drop their copies.
`requireAdminInAction` should delegate to a shared `assertAdminFromSubject`
that both `requireAdmin` and the action variant call.

---

### [SEV: P3] camelCase claim fallbacks (`orgId` / `orgSlug` / `orgRole`) are dead branches

**Location:** `convex/lib/auth.ts:21-39`.

```ts
const orgId =
  typeof raw.org_id === "string"
    ? raw.org_id
    : typeof raw.orgId === "string"      // ← never taken
      ? raw.orgId
      : undefined;
```

**Problem.** Clerk's "convex" JWT template emits snake_case claims
(`org_id` / `org_slug` / `org_role`). Every test fixture in the repo
(`deprecation.test.ts:66-68`, `keySettings.test.ts:38-41`,
`notifications.test.ts:18-21`, `earnings.test.ts:56-58`,
`ingest-usage.test.ts`) sets only the snake_case form. The camelCase
fallbacks are unreachable dead code that gives a false impression of
multi-provider support (the codebase is Clerk-only, enforced by
`auth.config.ts`).

**Impact.** No runtime effect. Maintenance hazard: a reader may believe a
second issuer is supported and write code assuming camelCase claims.

**Fix.** Drop the camelCase branches:

```ts
const orgId = typeof raw.org_id === "string" ? raw.org_id : undefined;
const orgSlug = typeof raw.org_slug === "string" ? raw.org_slug : undefined;
const orgRole = typeof raw.org_role === "string" ? raw.org_role : undefined;
```

---

### [SEV: P3] Type-unsafe `identity as Record<string, unknown>` cast — no runtime shape validation

**Location:** `convex/lib/auth.ts:21`.

```ts
const raw = identity as Record<string, unknown>;
```

**Problem.** The `UserIdentity` object is cast to `Record<string,
unknown>` and then probed with `typeof raw.org_id === "string"`. There is
no assertion that the identity object is non-null at the claim layer
(`requireIdentity` checks the identity is non-null first, so this is
safe today), and no validation that `org_id` is a *well-formed* Clerk org
id rather than an arbitrary string. If Clerk or Convex changes the
flattening behavior (e.g. nests claims under `o` or `org`), every probe
silently returns `undefined` and every `require*` throws
`"No active organization on identity"` — a fail-closed but opaque
regression with no diagnostic tying it to the claim shape.

**Impact.** Opaque failure mode under upstream contract change. No
current correctness impact.

**Fix.** Optionally validate the claim shape with a small runtime check
and throw a specific error naming the missing claim, or document the
expected JWT template shape in a comment and add a test that asserts the
claim keys.

---

### [SEV: P3] `requireProjectMember` returns the loaded `project`, but callers re-fetch it — double read

**Location:** `convex/lib/auth.ts:86-110` (returns `project`);
`convex/projects.ts:113-116` and `convex/webhooks.ts:103` (re-fetch).

```ts
// requireProjectMember already did:
const project = await ctx.db.get(projectId);   // read 1
// … projects.update handler:
await requireProjectMember(ctx, args.projectId);   // discards the returned project
const current = await ctx.db.get(args.projectId);  // read 2 — same row
```

**Problem.** `requireProjectMember` already loads and returns the
project doc (and the org doc). `projects.update` and `webhooks.*`
discard the return value and immediately re-`ctx.db.get` the same id.
Within a single Convex transaction the second read hits the in-transaction
cache, so the perf cost is low, but the pattern discards typed
information the guard already paid for and is a place where the two
reads can diverge if someone later inserts a write between them.

**Impact.** Minor wasted work + a latent footgun (re-fetch after an
intervening write). No correctness bug today.

**Fix.** Use the returned `project`:

```ts
const { project } = await requireProjectMember(ctx, args.projectId);
// use `project` directly; drop the redundant ctx.db.get
```

---

### [SEV: P3] `listMine` / `billing.ts:923` / `payouts.ts:648` use `claims.orgId!` non-null assertion instead of a narrowed local

**Location:** `convex/organizations.ts:48`, `convex/billing.ts:923`,
`convex/payouts.ts:648`.

```ts
const claims = await requireIdentity(ctx);
if (claims.orgId === undefined) { return []; }
const org = await ctx.db
  .query("organizations")
  .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", claims.orgId!))  // ← !
  .unique();
```

**Problem.** After the `=== undefined` guard, TypeScript narrows
`claims.orgId` to `string` — but only if it is a fresh local. Because
`claims` is an object and `orgId` is `string | undefined`, the `!` is
used to silence a narrowing that TS loses across the closure in
`.withIndex`. It is safe today but is the kind of assertion that hides a
future regression (e.g. if the guard is removed, `!` silently lies).

**Impact.** None today; minor code-smell that weakens the type safety
the rest of the file is careful about.

**Fix.** Bind a narrowed local:

```ts
const { orgId } = claims;
if (orgId === undefined) return [];
// … q.eq("clerkOrgId", orgId)
```

---

### [SEV: P3] `requireAdmin` / `isAdmin` / `requireAdminInAction` — three admin-gate copies with subtly different return contracts

**Location:** `convex/lib/auth.ts:118-135` (`requireAdmin` returns
`OrgIdentityClaims`), `convex/lib/auth.ts:138-148` (`isAdmin` returns
`boolean`, re-reads `identity.subject` directly), `convex/admin.ts:321-341`
(`requireAdminInAction` returns `void`).

**Problem.** Three implementations of "is this subject in
`ADMIN_USER_IDS`", each splitting/trimming/filtering the env independently.
`isAdmin` does not go through `requireIdentity` — it reads
`identity.subject` directly and re-parses env, so it does not benefit
from any future hardening of `requireIdentity` (e.g. the empty-string
fix). `requireAdminInAction` exists only because `requireAdmin` takes a
`QueryCtx | MutationCtx` and actions have `ActionCtx`; the claim-parsing
logic is `ctx.auth.getUserIdentity()`-based and is actually
ctx-agnostic, so the duplication is unnecessary.

**Impact.** Drift risk only; all three currently behave equivalently for
the admin check. But `isAdmin` bypassing `requireIdentity` means the
empty-string orgId hardening would not apply to it (not relevant for the
boolean admin check, but signals the lack of a seam).

**Fix.** Extract `adminSubjects(): string[]` and
`isSubjectAdmin(subject: string): boolean` helpers; have all three call
them. Make `requireAdmin` accept the broader `QueryCtx | MutationCtx |
ActionCtx` (the `ctx.auth.getUserIdentity()` signature is identical) and
delete `requireAdminInAction`.

---

### [SEV: P3] Generic `throw new Error(...)` for every auth failure — callers cannot distinguish auth from server error; leakage discipline inconsistent across the codebase

**Location:** `convex/lib/auth.ts:15,68,74,79,95,99,105,123,131` and
mirrored messages in `organizations.ts`, `projects.ts`, `notifications.ts`.

**Problem.** Every auth failure throws a bare `Error` with a human-readable
message. Convex surfaces the message to the client (depending on config),
so (a) callers cannot programmatically distinguish "not authenticated"
from "not a member" from "not found" without string-matching, and (b)
the messages are user-facing but were not designed as such — some leak
existence (see P2 oracle finding), others deliberately hide it
(`keySettings` "Key not found"). There is no `AuthError` type, no error
code, no consistent policy.

**Impact.** Clients must string-match to render appropriate UI (the web
app likely shows a generic toast for all). Inconsistent leakage
discipline makes security review harder. No data loss.

**Fix.** Introduce a small `AuthError extends Error` with a `code`
field (`UNAUTHENTICATED` | `NO_ACTIVE_ORG` | `FORBIDDEN` | `NOT_FOUND`)
and throw typed instances. Decide one policy (hide existence) and apply
it uniformly.

---

### [SEV: P3] `OrgIdentityClaims.orgSlug` is parsed + returned but never used for any authz decision

**Location:** `convex/lib/auth.ts:7,28-33,42-47`.

```ts
orgSlug: string | undefined;   // ← parsed, threaded, never read for authz
```

**Problem.** Like `orgRole`, `orgSlug` is extracted from the
`org_slug` claim and carried in `OrgIdentityClaims`, but no consumer
uses it for an authorization decision. `requireOrgMemberBySlug` resolves
the org from the **URL** `orgSlug` argument and binds via `clerkOrgId`;
the **claim** `orgSlug` is never compared to anything. It is pure
dead payload on the claims object.

**Impact.** None functionally. Same maintenance footgun as `orgRole`: a
future caller may trust `claims.orgSlug` as authoritative when it is
just a reflection of what Clerk put in the token.

**Fix.** Drop `orgSlug` from `OrgIdentityClaims` unless a consumer is
added, or assert `claims.orgSlug === org.slug` inside
`requireOrgMemberBySlug` as defense-in-depth (the claim and the DB row
should agree; a mismatch would indicate a stale or mis-issued token).

---

## Summary

- **Findings: 12** — 0×P0, 1×P1, 4×P2, 7×P3.
- **Top 3:**
  1. (P1) Destructive + privilege-escalating org operations
     (`projects.remove`, `visibility→public`, `ensureOrganization`
     slug/name, webhook endpoint CRUD, spec publish/deprecate/sunset)
     gated by membership only — `orgRole` is parsed but never enforced,
     so any `org:member` wields `org:admin` power.
  2. (P2) `requireIdentity` accepts empty-string `orgId` and the
     duplicated copies in `billing.ts`/`payouts.ts` have already drifted
     to fix it — proving the canonical helper is the broken one and the
     duplication is an active hazard.
  3. (P2) `organizations.ensureOrganization` lets any member rename the
     org and change its public catalogue slug with no role gate and no
     slug-uniqueness enforcement on patch — DoS + brand-impersonation
     primitive for any invited member.
- **Cross-cutting theme:** the claims surface (`orgRole`, `orgSlug`)
  advertises capabilities the system does not provide, and the
  claim-parsing/admin-gate logic is duplicated 3× with documented drift.
  Consolidate the canonical helpers, enforce (or delete) `orgRole`, and
  pick one error/leakage policy.
