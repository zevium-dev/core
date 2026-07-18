# Tiger Deep Review — `convex/projects.ts`

**Scope:** `convex/projects.ts` deep-dive, read against `convex/schema.ts`,
`convex/specs.ts`, `convex/organizations.ts`, `convex/catalogue.ts`,
`convex/keySettings.ts`, `convex/webhooks.ts`, `convex/search.ts`,
`convex/admin.ts`, `convex/lib/auth.ts`, `convex/lib/validate.ts`,
`packages/shared/src/validate.ts`, and `convex/dev.ts`.

This deep pass **verifies** the 13 prior findings (`reviews/convex.projects.ts.md`)
and **expands** with 9 new ones. One prior P1 is **downgraded** after
verification against Convex's concurrency model; one new P1 (cross-file
private-spec leak via the gateway query) is added.

---

## Verdict

**Incorrect + leaky.** Org-scoping on the read/write surface is sound
(`requireOrgMemberBySlug` / `requireProjectMember` gate every export, JWT
`org_id` matched against the mirrored org's `clerkOrgId` — no cross-org
read/edit/delete). But the project lifecycle carries real defects:

- a **deletion cascade that orphans 3 tables and leaves live webhook signing
  secrets behind** (the in-repo `dev:cleanupTestProjects` already implements
  the correct 5-table cascade — `remove` is a strict subset);
- a **public gateway query that hands the full OpenAPI spec of any *private*
  project to unauthenticated callers** who know the org/project slugs
  (cross-file, `specs.ts`, but it is the visibility contract `projects.ts`
  owns);
- a **silent self-service visibility path** that emits no event while the
  admin path fires both a notification and a webhook for the same semantic
  event;
- **no role-based authorization** — `claims.orgRole` is captured and then
  discarded everywhere; any `org:member` can delete any project in the org,
  including ones an `org:admin` owns.

Not a blocker: the slug TOCTOU flagged as P1 in the prior review is mitigated
by Convex's serializable OCC (verified below) — downgraded to P2, with the
residual `.unique()`-crash fragility called out.

---

## File Stats

- **Exports:** 5 (`list`, `get`, `create`, `update`, `remove`)
- **Lines:** 209
- **Authz:** `requireOrgMemberBySlug` (list/get/create),
  `requireProjectMember` (update/remove) — org-scoped, correct.
- **Indexes used:** `projects.by_org`, `projects.by_org_slug`,
  `projects.by_visibility_status`, `specs.by_project`,
  `specVersions.by_project`.
- **Tables mutated:** `projects`, `specs`, `specVersions`. *Should* also
  mutate `specEmbeddings`, `webhookEndpoints`, `webhookDeliveries` on
  `remove` — does not (P1).
- **Cross-file contracts:** `catalogue.getPublicDetail` / `listPublic` /
  `search.fetchSearchListings` all re-check `visibility==="public" &&
  status==="published"` (good — no catalogue leak); `specs.getPublishedForGateway`
  does **not** gate on visibility (P1, specs.ts).

---

## Verification of Prior Findings

| # | Prior sev | Verdict | Note |
|---|---|---|---|
| 1 | P1 slug TOCTOU | **↓ P2** | Convex serializable OCC invalidates the second tx's `by_org_slug` range read on the first's insert → retry → throws. Race is *mitigated*, not exploitable. Residual risk: no DB-level unique constraint; `.unique()` 500s forever if a duplicate ever arises via another path. |
| 2 | P1 cascade gaps | **✓ P1** | Verified: `remove` deletes only `specs` + `specVersions` + project. `dev.ts:cleanupTestProjects:38-98` deletes all 5 tables — proving the intended cascade. |
| 3 | P2 no `project.deleted` event | **✓ P2** | Verified: no `project.deleted` anywhere in `convex/`. |
| 4 | P2 `update` visibility silent | **✓ P2** | Verified: `admin.setProjectVisibility` fires `visibility_changed` + `project.visibility_changed`; `update` fires neither. |
| 5 | P2 `remove` hard-deletes live projects | **✓ P2** | Verified: no status/visibility gate. |
| 6 | P2 case-sensitive slug read | **✓ P2** | Verified: `create` lowercases, `get` does not. Same in `specs.getPublishedForGateway` + `catalogue.getPublicDetail`. |
| 7 | P3 tags no per-tag cap/charset | **✓ P3** | Verified: `v.array(v.string())` unbounded; only count≤32 after dedup. |
| 8 | P3 `list` unbounded `.collect()` | **✓ P3** | Verified: no `paginationOpts`. |
| 9 | P3 `visibility:public` on draft | **✓ P3** | Verified: no coherence check. |
| 10 | P3 length check only after trim | **✓ P3** | Verified. |
| 11 | P3 `requireProjectMember` existence oracle | **✓ P3** | Verified: distinct errors for missing vs. out-of-org. |
| 12 | P3 `remove` `.unique()` on specs draft | **✓ P3** | Verified. |
| 13 | P3 no `project.created` event | **✓ P3** | Verified. |

**Net prior: 1 P1 + 4 P2 + 7 P3 hold; 1 P1 downgraded to P2.**

---

## Findings

### [P1] `remove` orphans `specEmbeddings`, `webhookEndpoints`, `webhookDeliveries` — dead signing secrets retained

`convex/projects.ts:180-208`

```ts
const draft = await ctx.db.query("specs")...unique();
if (draft !== null) { await ctx.db.delete(draft._id); }
const versions = await ctx.db.query("specVersions")...collect();
for (const version of versions) { await ctx.db.delete(version._id); }
// Usage events stay for analytics integrity; they still reference projectId.
await ctx.db.delete(args.projectId);
return { deleted: args.projectId };
```

**Problem.** `remove` deletes `specs` + `specVersions` + the project row and
stops. Three project-scoped tables are left dangling:

| Table | Orphaned | Consequence |
|---|---|---|
| `specEmbeddings` | 1 row/project | vector index polluted; `vectorSearch` returns stale ids consuming result budget and downranking live projects. `search.fetchSearchListings:296-298` re-checks existence + `public`+`published` and skips (no leak), but the row is never reaped. |
| `webhookEndpoints` | 1 row/project | **Signing secret persists for a deleted project.** Endpoint still queryable via `by_project`; `webhooks.getEndpoint` / `upsertEndpoint` would resurrect it. |
| `webhookDeliveries` | many/endpoint | orphaned via `endpointId`; pending scheduled `deliverWebhook` actions still run (endpoint not deleted → `getDeliveryForAction` returns non-null → POST fires for a deleted project). |

**Impact.** Unbounded orphan growth; dead webhook secrets retained
indefinitely (secret-hygiene violation); vector-search quality degrades as
deleted-project embeddings consume `limit` slots; post-deletion
`spec.published`/`spec.deprecated` deliveries fire for a project that no
longer exists. `convex/dev.ts:cleanupTestProjects:38-98` deletes **all five**
tables — proving the intended production cascade. `remove` implements a
strict subset.

**Fix.** Mirror `dev.ts:cleanupTestProjects` before the project-row delete:

```ts
const embeddings = await ctx.db.query("specEmbeddings")
  .withIndex("by_project", q => q.eq("projectId", args.projectId)).collect();
for (const e of embeddings) await ctx.db.delete(e._id);

const endpoints = await ctx.db.query("webhookEndpoints")
  .withIndex("by_project", q => q.eq("projectId", args.projectId)).collect();
for (const ep of endpoints) {
  const deliveries = await ctx.db.query("webhookDeliveries")
    .withIndex("by_endpoint", q => q.eq("endpointId", ep._id)).collect();
  for (const d of deliveries) await ctx.db.delete(d._id);
  await ctx.db.delete(ep._id);
}
```

---

### [P1] `specs.getPublishedForGateway` leaks the full spec of private projects to unauthenticated callers

`convex/specs.ts:263-310` (cross-file — visibility contract owned by `projects.ts`)

```ts
export const getPublishedForGateway = query({
  args: { orgSlug: v.string(), projectSlug: v.string() },
  handler: async (ctx, args) => {
    const org = await getOrgBySlug(ctx, args.orgSlug);
    if (org === null) return null;
    const project = await ctx.db.query("projects")
      .withIndex("by_org_slug", q => q.eq("organizationId", org._id).eq("slug", args.projectSlug))
      .unique();
    if (project === null) return null;
    if (project.status !== "published") return null;   // ← no visibility check
    const latest = await ctx.db.query("specVersions")...first();
    ...
    return { spec: latest.spec, version, projectId, organizationId, clerkOrgId, visibility: project.visibility, ... };
  },
});
```

**Problem.** This is a **public** query (no `requireIdentity`). It returns
the full OpenAPI JSON body of the latest published version for any project
whose `(orgSlug, projectSlug)` pair is known — **regardless of `visibility`**.
The `visibility` field is returned in the response but is never a gate. A
`private` project is hidden from `catalogue.listPublic` / `getPublicDetail`
/ `search` (all three re-check), but its entire spec — endpoint paths,
request/response schemas, `x-zevium-cost` chips, vendor extensions — is
hand-retrievable by any unauthenticated caller who knows or guesses the two
kebab-case slugs.

The gateway (Cloudflare Worker) does need this query to route inbound API
calls, and it has no Convex user identity to authenticate with. That is the
justification for the query being public. But "the gateway needs it" does
not imply "anyone on the internet may fetch the full spec of a private
project." Slugs are human-readable, low-entropy, and shared with every
collaborator who ever opened the project page — they are not secrets.

**Impact.** Direct, pre-auth disclosure of proprietary API definitions for
every private project on the platform. The "private" visibility setting is
a catalogue-hiding hint, not an access-control gate — contradicts the
documented visibility model that `projects.ts` establishes and `catalogue.ts`
/ `search.ts` faithfully enforce elsewhere. A publisher who sets
`visibility: "private"` reasonably believes the spec is not publicly
fetchable; it is.

**Fix.** Decouple gateway routing from spec disclosure. Options:
1. Make the query require a gateway-shared secret (Convex function-level auth
   or a signed routing token the gateway presents) and gate private projects
   on that identity.
2. Split the query: a public `getProjectRoutingInfo` returning only
   `{ projectId, organizationId, clerkOrgId, visibility, version, deprecatedAt,
   sunsetAt }` (what the gateway needs to route + enforce), and an
   *authenticated* `getPublishedSpec` returning the spec body only when the
   caller is an org member *or* the project is `public`.
3. At minimum, gate on visibility: `if (project.visibility !== "public") return null;`
   and have the gateway resolve the spec through a different, authenticated
   path for private projects.

---

### [P2] No DB-level unique constraint on `(organizationId, slug)`; `.unique()` lookups 500 forever if a duplicate ever arises

`convex/projects.ts:61-79` (create check), `:22-30` (get), `convex/specs.ts:283-291`,
`convex/catalogue.ts:283-288` *(prior P1, downgraded after verification)*

```ts
// create:
const existing = await ctx.db.query("projects")
  .withIndex("by_org_slug", q => q.eq("organizationId", org._id).eq("slug", slug))
  .unique();
if (existing !== null) { throw new Error("Project slug already exists in this organization"); }
```

**Problem (verified).** The prior review flagged this as an exploitable
TOCTOU race. Convex mutations run under **serializable isolation with
optimistic concurrency control**: at commit, every read — including the
empty `by_org_slug` range scan returning null — is re-validated. Two
concurrent `create`s with the same slug: the second tx's range read is
invalidated by the first's insert into that range → OCC retry → on retry
the read returns the existing row → throws. **The race is mitigated, not
exploitable.** Downgrade to P2.

The residual defect is the **lack of a DB-level invariant**. Uniqueness is
enforced purely by application logic + OCC. Any code path that inserts a
project *without* this pre-check — a backfill script, a migration, an admin
tool, a future refactor that adds a second `create` entrypoint — produces a
duplicate. Once a duplicate `(organizationId, slug)` row exists:

- `get` (line 22) calls `.unique()` → throws `ConvexMultiDocumentError` →
  **the project detail page 500s forever** for that slug.
- `specs.getPublishedForGateway` (gateway data plane) and
  `catalogue.getPublicDetail` use the same `.unique()` lookup → gateway 500s
  for that project, breaking live consumer traffic.
- `create`'s *own* collision check (line 65) calls `.unique()` → any further
  attempt to create a project with that slug **500s instead of returning the
  friendly "already exists" error** — the friendly-error path is unreachable
  once corruption exists.

**Impact.** No live exploit today; brittle invariant. A single duplicate
(corruption, script, refactor) permanently bricks the slug for every read
path with no self-healing.

**Fix.** Convex has no native unique index. Add a `projectSlugs` token table
keyed by `${orgId}:${slug}` and insert the token *first* (the token insert is
the atomic uniqueness point); only on token-insert success proceed to
insert the project. Or, less invasively, switch all read-side `.unique()` to
`.first()` and treat duplicate slugs as a never-happens-by-convention
invariant — but that hides corruption instead of surfacing it. Prefer the
token table.

---

### [P2] `create` accepts the reserved route segment `"create"` — project becomes unreachable at its canonical URL

`convex/projects.ts:48-58`, `packages/shared/src/validate.ts:11-13`

```ts
const slug = args.slug.trim().toLowerCase();
if (!isValidSlug(slug)) { throw new Error("Slug must be kebab-case ..."); }
// isValidSlug: /^[a-z0-9]+(?:-[a-z0-9]+)$/  — no reserved-word list
```

**Problem.** `isValidSlug` validates only kebab-case shape + length ≤64. It
does not reject route-reserved slugs. The web route tree under
`apps/web/src/routes/app/projects/` is:

```
create.tsx          → /app/projects/create        (static)
$projectSlug.tsx    → /app/projects/$projectSlug  (dynamic)
$projectSlug/spec.tsx
```

TanStack Router prioritizes static segments over dynamic ones, so a project
with `slug: "create"` resolves `/app/projects/create` to the **create**
route, not to `$projectSlug`. The project is created successfully, listed in
the index, and the user is navigated to `/app/projects/create` — which lands
them on the "new project" form instead of their just-created project. The
project is then unreachable from the UI at its canonical URL forever; it can
only be opened by slug-editing or via the settings panel if it surfaces a
deep link.

`"index"` is safe (`index.tsx` is the directory index route, not
`/app/projects/index`). `"spec"` is safe at the project-slug level (it is a
*child* route of `$projectSlug`). `"create"` is the only current collision,
but any future static sibling (`new`, `import`, `templates`) would collide
too.

**Impact.** A user can name a project `"Create"` (→ slug `create`) and
immediately hit a dead-end navigation that loops them back to the create
form. No error, no recovery — the project exists but is unreachable at its
own URL. Mild data-integrity / UX defect on a URL-backed resource.

**Fix.** Maintain a reserved-segment denylist in `packages/shared/src/validate.ts`
(or pass an org-scoped `reservedSlugs` set to `isValidSlug`):

```ts
const RESERVED_PROJECT_SLUGS = new Set(["create", "new", "import", "templates", "settings"]);
export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 64 && SLUG_RE.test(slug) && !RESERVED_PROJECT_SLUGS.has(slug);
}
```

---

### [P2] No role-based authorization — `claims.orgRole` captured and discarded; any `org:member` can delete any project in the org

`convex/lib/auth.ts:8,34-45`, `convex/projects.ts:99-104,180-186`

```ts
// lib/auth.ts — orgRole is parsed off the JWT and returned...
export type OrgIdentityClaims = {
  subject: string; orgId: string | undefined;
  orgSlug: string | undefined; orgRole: string | undefined;  // ← captured
};
...
// projects.ts — never destructured, never checked
await requireProjectMember(ctx, args.projectId);
```

**Problem.** `requireIdentity` parses `org_role` off the Clerk JWT template
into `claims.orgRole` (Clerk exposes `org:admin` vs `org:member`). A
`grep` of `convex/` for `orgRole` / `claims.orgRole` finds **zero** consumers
— the claim is fetched on every request and discarded everywhere. In
particular `projects.update` and `projects.remove` gate only on org
membership, not role. Any `org:member` can:

- `update` any project in the org — rename it, flip visibility
  (`private`→`public` exposes the spec to the catalogue), rewrite tags,
  clear description;
- `remove` any project in the org — hard-delete a `published` + `public`
  project serving live gateway traffic, including projects an `org:admin`
  or another member owns.

`create` is arguably fine for any member. `update` of metadata is
defensible. **`remove` of a published project is not.**

**Impact.** A low-privileged org member (or a compromised `org:member`
token) can irrevocably delete every public/published project the org owns,
with no `project.deleted` event (see prior P2) and no soft-delete recovery.
The `orgRole` claim exists in the JWT precisely so this can be gated; it is
not.

**Fix.** For destructive operations at minimum, check `orgRole`:

```ts
// in requireProjectMember (or a stricter sibling):
if (claims.orgRole !== "org:admin" && claims.orgRole !== "admin") {
  throw new Error("Project not found"); // collapse with not-found to avoid oracle
}
```
Apply to `remove` (and consider for `update`'s `visibility` flip). Document
whether `create` is member-allowed (current behavior) or admin-only.

---

### [P2] `update`'s full-`replace` on description-clear is fragile and unnecessary — Convex `patch` already supports `undefined` deletion

`convex/projects.ts:145-167`

```ts
if (descriptionCleared) {
  // Optional field clear needs replace — patch cannot unset.
  await ctx.db.replace(args.projectId, {
    organizationId: current.organizationId,
    name, slug: current.slug, description: undefined,
    status: current.status, visibility, tags,
  });
} else {
  await ctx.db.patch(args.projectId, { name, description, visibility, tags });
}
```

**Problem.** Two defects in one block:

1. **The comment is wrong.** Convex `db.patch(id, { field: undefined })`
   **does** delete an optional field — setting a field to `undefined` in a
   patch is the documented deletion primitive. The `replace` is not needed;
   `await ctx.db.patch(args.projectId, { name, description: undefined, visibility, tags })`
   would clear the field correctly. The same misconception is repeated in
   `specs.undeprecateVersion:370-377` ("Replace to unset optional fields —
   patch cannot delete them") — a codebase-wide belief that is false.

2. **The replace is a maintenance hazard.** `replace` rewrites the entire
   document with exactly the fields enumerated in the call. If the
   `projects` schema later gains a field — `ownerUserId`, `iconUrl`,
   `archivedAt`, `billingPlan` — the replace silently **drops it** the first
   time any user clears a project description. `patch` only touches the
   named fields and leaves others intact; `replace` does not.

**Impact.** Today: a heavier-than-needed write on every description-clear.
Tomorrow: silent data loss on the next schema addition that ships without
updating this `replace` payload. The fragility is invisible until it bites.

**Fix.** Drop the `replace` branch entirely; clear via `patch`:

```ts
await ctx.db.patch(args.projectId, {
  name,
  description,   // undefined when cleared — patch deletes the field
  visibility,
  tags,
});
```
Fix `specs.undeprecateVersion` the same way (`patch` with the three
`undefined` deprecation fields instead of `replace`).

---

### [P2] `remove` sequentially deletes all `specVersions` in one transaction — unbounded loop risks Convex transaction limits

`convex/projects.ts:194-200`

```ts
const versions = await ctx.db
  .query("specVersions")
  .withIndex("by_project", q => q.eq("projectId", args.projectId))
  .collect();
for (const version of versions) {
  await ctx.db.delete(version._id);
}
```

**Problem.** A prolific publisher can accumulate hundreds of immutable
`specVersions` (every `specs.publish` inserts one; they are never deleted
except here). `remove` issues one `ctx.db.delete` per version inside a
single mutation transaction. Convex mutations are bounded by transaction
time and document-write count; a project with N versions performs N+1
sequential deletes (plus the orphaned-tables cascade the P1 fix would add —
embeddings + endpoints + deliveries, the latter potentially unbounded per
endpoint). For large N this hits Convex's mutation limits and the whole
delete aborts midway, leaving the project in a half-deleted state (some
versions gone, project row present, endpoints + deliveries orphaned).

**Impact.** `remove` can fail irreversibly for mature projects — the exact
case where deletion matters most (an org winding down a long-lived API).
No partial-rollback recovery path.

**Fix.** Batch the cascade through a scheduler: `remove` deletes the
project row + the single `specs` draft immediately (so reads immediately
404), then schedules an `internalMutation` that pages through
`specVersions` / `specEmbeddings` / `webhookEndpoints` /
`webhookDeliveries` in `.take(100)` batches, deleting each batch in its own
transaction. Mark the project row with a `deletingAt` tombstone first so
concurrent `update` / `publish` reject during teardown.

---

### [P2] `remove` fires no `project.deleted` webhook or notification (verified)

`convex/projects.ts:202-204`

```ts
// Usage events stay for analytics integrity; they still reference projectId.
await ctx.db.delete(args.projectId);
return { deleted: args.projectId };
```

**Problem (verified).** `grep` of `convex/` for `project.deleted` /
`project.created` finds zero emitters. Deletion is the most destructive
irreversible action in this module, yet it emits no event. The contract
elsewhere: `specs.publish` → `spec.published` + `spec_published`;
`specs.deprecateVersion` → `spec.deprecated` + `version_deprecated`;
`admin.setProjectVisibility` → `project.visibility_changed` +
`visibility_changed`. Deletion fires nothing.

Compounding the P1 cascade gap: because `webhookEndpoints` are *not*
deleted, scheduled `deliverWebhook` actions already in-flight when `remove`
runs still execute — the publisher receives post-deletion
`spec.published` / `spec.deprecated` deliveries for a project that no longer
exists, with no `project.deleted` to bookend the stream.

**Impact.** Publisher webhook subscribers receive no signal that a project
(and its published versions) is gone; consumer integrations discovering via
webhook see silent disappearance. Inconsistent with the rest of the
event-driven contract.

**Fix.** Before deleting (and after deleting endpoints, so no in-flight
delivery races the event), fire
`fireWebhookEvent(ctx, args.projectId, "project.deleted", { projectId: args.projectId })`
and add a `project_deleted` variant to the `notifications.kind` union in
`schema.ts`. Coordinate the kind addition with `lib/notifications.ts`.

---

### [P2] `update` visibility change emits no `visibility_changed` notification or webhook (verified)

`convex/projects.ts:124-126`

```ts
if (args.patch.visibility !== undefined) {
  visibility = args.patch.visibility;
}
```

**Problem (verified).** This is the self-service visibility path — the web
UI's "Make Public/Private" dialog calls `api.projects.update` with
`{ visibility }`. It silently writes the field. The admin path
`admin.setProjectVisibility` (`convex/admin.ts:216-245`) fires **both** a
`visibility_changed` notification and a `project.visibility_changed`
webhook for the same semantic event. Same field, two code paths, only one
emits — the exact *opposite* of what an event-driven contract implies: the
publisher's own flip is silent, the admin override is loud.

**Impact.** Consumers cached the project as public; publisher flips it
private; no `project.visibility_changed` fires; consumers keep calling
until they hit the gateway. (Separately, `specs.getPublishedForGateway`
does not gate on `visibility` at all — see P1.)

**Fix.** In `update`, when `args.patch.visibility !== undefined &&
args.patch.visibility !== current.visibility`, mirror
`admin.setProjectVisibility` — fire `createNotification({ kind:
"visibility_changed", ... })` + `fireWebhookEvent(ctx, args.projectId,
"project.visibility_changed", { projectId, visibility })`. `update`
currently does not even destructure `org` from `requireProjectMember`; it
needs `const { org } = await requireProjectMember(...)`.

---

### [P2] `remove` hard-deletes published/public projects with no coherence check (verified)

`convex/projects.ts:180-186`

```ts
export const remove = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<{ deleted: Id<"projects"> }> => {
    await requireProjectMember(ctx, args.projectId);
    // no status/visibility gate
```

**Problem (verified).** No status/visibility gate. A `published` +
`public` project serving live gateway traffic is hard-deleted in one call
with no confirmation that the project is in a safe state. Combined with the
missing `project.deleted` webhook (P2 above) and
`specs.getPublishedForGateway` returning the spec for any published
project, gateway requests for the just-deleted project go from 200 to 404
with no consumer notification, no grace period, and no soft-delete recovery
path.

**Impact.** Irreversible breakage of consumer integrations and catalogue
URLs (`/catalogue/$orgSlug/$projectSlug`) for any project that was live.

**Fix.** At minimum require `status === "draft"` (reject deletion of a
published project unless first reverted to draft / unpublished), or gate on
`visibility === "private"`. If hard-delete of live projects is intended,
fire the deletion webhook first (P2 above) and document the gateway's
degraded path.

---

### [P2] Read path is case-sensitive on `projectSlug` while `create` lowercases (verified)

`convex/projects.ts:22-30` (get) vs `:48-53` (create normalization)

```ts
// create:    const slug = args.slug.trim().toLowerCase();
// get:       .eq("slug", args.projectSlug)   // raw, not normalized
```

**Problem (verified).** `create` normalizes to lowercase before storing;
`get` queries `by_org_slug` with the raw `args.projectSlug`. Stored slugs
are always lowercase, so any lookup with an uppercase char returns `null`.
The web route passes `params.projectSlug` straight through. Same
non-normalization in `specs.getPublishedForGateway` and
`catalogue.getPublicDetail` / `getPublicDetail`.

**Impact.** `/app/projects/My-Api` and `/catalogue/Acme/My-Api` 404 even
though `/acme/my-api` works. Write side and read side disagree on slug
canonicalization — contract defect on a URL-backed resource, not cosmetic.

**Fix.** `const projectSlug = args.projectSlug.trim().toLowerCase();` in
`get` (and the sibling gateway/catalogue queries).

---

### [P3] `update` re-fetches the project that `requireProjectMember` already loaded

`convex/projects.ts:99-104`

```ts
await requireProjectMember(ctx, args.projectId);   // loads project + org
const current = await ctx.db.get(args.projectId);  // loads project again
```

**Problem.** `requireProjectMember` already did `ctx.db.get(projectId)`
internally (`lib/auth.ts:requireProjectMember`) and returns `{ claims, org,
project }` in its result. `update` ignores the return and re-fetches the
same doc. One extra indexed point-read per update call.

**Impact.** Wasted read on every `update`. Cheap individually, but
`update` is the hot path for the spec-editor's metadata save.

**Fix.** `const { org, project: current } = await requireProjectMember(ctx,
args.projectId);` — drop the second `ctx.db.get`.

---

### [P3] `create` re-fetches the just-inserted project via `ctx.db.get` instead of constructing the doc

`convex/projects.ts:71-86`

```ts
const projectId = await ctx.db.insert("projects", { ... });
await ctx.db.insert("specs", { projectId, draft: "", lastSavedAt: Date.now() });
const created = await ctx.db.get(projectId);   // ← re-fetch
if (created === null) { throw new Error("Failed to load created project"); }
return created;
```

**Problem.** Every value of the returned `Doc<"projects">` is already known
at insert time (`_id` = `projectId`, `_creationTime` injected by Convex, and
the literal fields just inserted). The `ctx.db.get` is an extra round-trip
that can only ever return the doc that was just written. The null check is
dead — `db.insert` returning an id means the doc exists.

**Impact.** One extra read per create. Minor.

**Fix.** Construct the return value inline:

```ts
const now = Date.now();
const projectId = await ctx.db.insert("projects", {
  organizationId: org._id, name, slug,
  description: description === "" ? undefined : description,
  status: "draft", visibility: "private", tags: [],
});
await ctx.db.insert("specs", { projectId, draft: "", lastSavedAt: now });
return {
  _id: projectId, _creationTime: now,
  organizationId: org._id, name, slug,
  description: description === "" ? undefined : description,
  status: "draft" as const, visibility: "private" as const, tags: [],
} satisfies Doc<"projects">;
```

---

### [P3] Slug is immutable post-`create` with no rename/transfer operation

`convex/projects.ts:99-167` (`update` patch object)

```ts
patch: v.object({
  name: v.optional(v.string()),
  description: v.optional(v.union(v.string(), v.null())),
  visibility: v.optional(v.union(v.literal("private"), v.literal("public"))),
  tags: v.optional(v.array(v.string())),
  // ← no `slug` field
}),
```

**Problem.** `slug` is intentionally not in the `update` patch — good for
URL stability. But there is *no* rename/transfer mutation anywhere in the
module. A publisher who wants to rename a project's slug must `remove` +
`create`, losing all published `specVersions` (immutable history) and the
`specs` draft. There is no migration path that preserves version history.

**Impact.** Permanent slug lock-in. Publishers who rebrand cannot update
their URL without nuking their publish history.

**Fix.** Add a `renameSlug` mutation that, within the same OCC transaction,
verifies the new slug is unique in the org (`by_org_slug`), validates with
`isValidSlug`, rejects reserved slugs (P2 above), and `patch`es the project
row. Version history is untouched (it's keyed by `projectId`, not slug).

---

### [P3] `create`'s own collision check uses `.unique()` — 500s instead of friendly error once a duplicate exists

`convex/projects.ts:65-79`

```ts
const existing = await ctx.db
  .query("projects")
  .withIndex("by_org_slug", q => q.eq("organizationId", org._id).eq("slug", slug))
  .unique();   // ← throws ConvexMultiDocumentError if a duplicate already exists
if (existing !== null) { throw new Error("Project slug already exists in this organization"); }
```

**Problem.** Tied to the P2 uniqueness finding. If a duplicate `(orgId,
slug)` row ever arises (corruption, script, refactor that bypasses this
check), this `.unique()` throws `ConvexMultiDocumentError` *before* the
`if (existing !== null)` friendly-error branch is reached. So the
user-facing "slug already exists" message becomes unreachable for that
slug — the UI shows a 500 instead.

**Impact.** Defensive only — triggers on pre-existing corruption. But it
makes `create` brittle exactly when the system is already in a bad state,
and the friendly-error contract silently breaks.

**Fix.** Use `.first()` here and let the `if (existing !== null)` branch
handle both "single existing" and "duplicate corruption" with the same
friendly error. Reserve `.unique()` for read paths where a duplicate is a
hard error worth surfacing.

---

### [P3] `update` tags: no per-tag length or character validation; unbounded array pre-dedup (verified)

`convex/projects.ts:128-143`

```ts
const raw = args.patch.tags
  .map(t => t.trim().toLowerCase())
  .filter(t => t.length > 0);
const seen: Record<string, true> = {};
const unique: string[] = [];
for (const tag of raw) { if (seen[tag]) continue; seen[tag] = true; unique.push(tag); }
if (unique.length > 32) { throw new Error("At most 32 tags"); }
```

**Problem (verified).** (a) no per-tag length cap — a single tag can be
100 KB; (b) no character/format validation — tags may contain newlines,
control chars, commas, arbitrary unicode; (c) the `>32` check runs *after*
the full O(n) map+filter+dedup over the input array, and
`v.array(v.string())` imposes no length bound, so a client can submit 100k
tags to force that work.

**Impact.** Tags feed `catalogue.listPublic`'s search haystack
(`${project.tags.join(" ")}`) and the `project.tags.includes(tag)` filter;
oversized/garbage tags bloat the listing payload and degrade substring
search. Mild DoS surface on `update`.

**Fix.** Cap per-tag length and array length at the validator or before
dedup:

```ts
const MAX_TAG_LEN = 48;
if (args.patch.tags.length > 64) throw new Error("Too many tags");
const raw = args.patch.tags
  .map(t => t.trim().toLowerCase().slice(0, MAX_TAG_LEN))
  .filter(t => t.length > 0);
```

---

### [P3] `list` uses unbounded `.collect()` with no pagination (verified)

`convex/projects.ts:7-15`

```ts
return await ctx.db
  .query("projects")
  .withIndex("by_org", q => q.eq("organizationId", org._id))
  .collect();
```

**Problem (verified).** Returns every project in the org. Sibling queries
(`webhooks.listDeliveries`, `usage.listForOrg`) paginate via
`paginationOptsValidator`. An org that publishes many APIs over time loads
the full set on every route entry.

**Impact.** Unbounded response size + wasted CPU/bandwidth for mature orgs.
Not a correctness bug today; becomes one as the catalogue grows.

**Fix.** Accept `paginationOpts` and return `{ page, isDone, continueCursor }`,
or cap with `.take(N)` + a `hasMore` flag.

---

### [P3] `update` permits `visibility: "public"` on a `status: "draft"` project (verified)

`convex/projects.ts:124-126`

**Problem (verified).** `visibility` and `status` are independently mutable
with no coherence check. A draft project (no published `specVersions` row)
can be marked `visibility: "public"`. The catalogue hides it
(`by_visibility_status` requires `public` + `published`), so there's no
immediate leak — but the state is incoherent, and the next `specs.publish`
instantly exposes the project to the public catalogue without any separate
visibility decision.

**Impact.** The publisher can accidentally publish to the public catalogue
in one step (`publish`) when they believed visibility was already gated.
Confusing failure mode, not a leak today.

**Fix.** In `update`, if `args.patch.visibility === "public"` and
`current.status !== "published"`, reject or no-op with a clear error.

---

### [P3] `create` validates name/description length only after trim; validator accepts arbitrary length (verified)

`convex/projects.ts:39-59`

**Problem (verified).** `v.string()` imposes no max length, so a 10 MB
`name` payload is fully deserialized, trimmed, then length-checked. Same
for `description` (capped at 2000 only after trim).

**Impact.** Mild DoS: oversized payloads pass the validator and only fail at
the handler. Convex request-size limits catch the extreme case, but a
256 KB name is accepted and processed.

**Fix.** Bound at the validator (`v.string()` + manual check before
`.trim()`, or a custom max-length validator) so oversized payloads reject
at the boundary.

---

### [P3] `requireProjectMember` discloses project existence to any authenticated user (verified)

`convex/projects.ts:99-104` (update), `:180-186` (remove), via `convex/lib/auth.ts:requireProjectMember`

**Problem (verified).** `update` and `remove` take a raw `projectId`
(`v.id("projects")`). Any authenticated user can probe any project id and
distinguish "Project not found" (doesn't exist) from "Not a member of this
organization" (exists, owned by another org).

**Impact.** Existence oracle. Low severity (Convex ids are non-enumerable
random ids), but a measurable information leak on the mutate surface.

**Fix.** Collapse both errors into a single generic `"Project not found"`
for non-members — the caller cannot act on the distinction anyway.

---

### [P3] `remove`'s `.unique()` on the specs draft throws on a duplicate row (verified)

`convex/projects.ts:187-192`

```ts
const draft = await ctx.db
  .query("specs")
  .withIndex("by_project", q => q.eq("projectId", args.projectId))
  .unique();
```

**Problem (verified).** `specs.by_project` is a non-unique index. If
corrupt state ever produces two `specs` rows for one project, `.unique()`
throws `ConvexMultiDocumentError` and `remove` aborts, leaving the project
undeletable from the UI. Same pattern in `specs.getDraft` / `specs.saveDraft`.

**Impact.** Defensive: only triggers on pre-existing corruption, but makes
`remove` brittle exactly when you need it (manual cleanup).

**Fix.** Use `.collect()` + iterate, matching the `specVersions` deletion
pattern immediately below it.

---

### [P3] `create` emits no `project.created` event (verified)

`convex/projects.ts:71-86`

**Problem (verified).** The event-driven contract fires on
`spec.published`, `spec.deprecated`, `project.visibility_changed` — but
project creation is silent. No `project.created` webhook, no notification.

**Impact.** Publisher integrations that sync project lifecycle via webhook
never see the creation event; they only learn about a project when its
first spec is published. Minor.

**Fix.** Fire `fireWebhookEvent(ctx, projectId, "project.created", {...})`
after the draft row insert. (No-op today — no endpoint exists at create
time — but the contract is in place for pre-configured endpoints.)

---

## Summary

**Counts:** **2 × P1 · 9 × P2 · 11 × P3 — 22 findings total.**
(Prior review: 2 P1 + 4 P2 + 7 P3 = 13. This pass verifies all 13 — downgrading
1 P1→P2 after Convex-OCC verification — and adds 9 new findings: 1 P1, 5 P2,
3 P3.)

**Top 3 (must-fix before merge):**

1. **P1 — `remove` cascade gaps.** Orphans `specEmbeddings` (vector-index
   pollution), `webhookEndpoints` (**dead signing secrets retained**), and
   `webhookDeliveries`. `dev.ts:cleanupTestProjects` already implements the
   correct 5-table cascade — `remove` is a strict subset. In-flight
   `deliverWebhook` actions keep firing for the deleted project because the
   endpoint is never reaped.

2. **P1 — `specs.getPublishedForGateway` leaks private-project specs.**
   Public, no-auth query returns the full OpenAPI JSON for any *private*
   project to anyone who knows the two kebab-case slugs. `visibility` is
   returned but never gated. The catalogue + search paths faithfully enforce
   `public`+`published`; the gateway path does not. Decouple routing info
   from spec body, or gate on visibility + authenticate the gateway.

3. **P2 — `update` visibility flip is silent + no role-based authz.** The
   self-service UI path emits no `visibility_changed` notification and no
   `project.visibility_changed` webhook, while `admin.setProjectVisibility`
   fires both for the same event. Independently, `claims.orgRole` is parsed
   off every JWT and discarded everywhere — any `org:member` can `remove`
   any `published`+`public` project in the org, including ones an
   `org:admin` owns. Mirror the admin event path in `update`; gate
   destructive ops on `orgRole`.
