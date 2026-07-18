# Tiger Review — `convex/projects.ts`

## Verdict

**Incorrect.** The file is org-scoped correctly (no cross-org read/edit/delete —
`requireOrgMemberBySlug` / `requireProjectMember` gate every export), but it
carries a real P1 data-integrity race on slug uniqueness, a P1 deletion-cascade
gap that leaves orphaned rows + live webhook secrets behind, and several
contract gaps where self-service mutations stay silent while the admin path
fires notifications/webhooks for the same semantic event. Ship-blockers for a
resource that backs URL slugs and publisher webhook contracts.

## File Stats

- **Exports:** 5 (`list`, `get`, `create`, `update`, `remove`)
- **Lines:** 209
- **Authz:** `requireOrgMemberBySlug` (list/get/create), `requireProjectMember`
  (update/remove) — org-scoped, correct.
- **Indexes used:** `projects.by_org`, `projects.by_org_slug`,
  `projects.by_visibility_status`, `specs.by_project`, `specVersions.by_project`.
- **Tables mutated:** `projects`, `specs`.

## Findings

---

### [P1] Slug uniqueness check is TOCTOU — concurrent `create` produces duplicate slugs

`convex/projects.ts:61-79`

```ts
const existing = await ctx.db
  .query("projects")
  .withIndex("by_org_slug", (q) =>
    q.eq("organizationId", org._id).eq("slug", slug),
  )
  .unique();
if (existing !== null) {
  throw new Error("Project slug already exists in this organization");
}
const projectId = await ctx.db.insert("projects", { ... slug, ... });
```

**Problem.** Convex indexes are **not** unique-constrained. The
`by_org_slug` index in `schema.ts` is a plain compound index; `.unique()` is a
runtime query assertion, not a DB invariant. Two concurrent `create`
mutations (two clients, or a double-submit) each read "no existing row", each
insert, both commit. There is no application-level guard (no conditional
insert, no scheduler serialization) and no DB-level guard.

**Impact.** Duplicate `(organizationId, slug)` rows. After that:
- `get` (line 22) calls `.unique()` on `by_org_slug` — Convex throws
  `ConvexMultiDocumentError` on a duplicate, so the project detail page
  (`/app/projects/$projectSlug`) **crashes for that slug forever** until an
  admin manually deletes one row.
- `specs.getPublishedForGateway` (gateway data plane) and
  `catalogue.getPublicDetail` use the same `.unique()` lookup — the gateway
  500s for that project, breaking live consumer traffic.
- The `create` UI flow does `list → create → navigate to detail`, so the
  winning client immediately hits the crash page once the duplicate commits.

**Fix.** Convex has no native unique index. Either (a) serialize project
creation per-org via a scheduler/envelope mutation, or (b) accept the race
and make `get`/`getPublishedForGateway`/`getPublicDetail` use `.first()`
instead of `.unique()` and document duplicate slugs as impossible-by-convention
(risky), or (c) use a separate `projectSlugs` table keyed by
`${orgId}:${slug}` as an insert-time uniqueness token (insert token first;
the token insert is idempotent-by-key).

---

### [P1] `remove` leaves orphaned `specEmbeddings`, `webhookEndpoints`, and `webhookDeliveries`

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

**Problem.** `remove` deletes `specs` + `specVersions` + the project row, but
leaves every other project-scoped row dangling:

| Table | Orphaned rows | Consequence |
|---|---|---|
| `specEmbeddings` | one per project | vector index polluted forever; `vectorSearch` returns stale ids, consuming result budget and downranking live projects. `search.fetchSearchListings` re-checks project existence and skips (no leak), but the row never gets reaped. |
| `webhookEndpoints` | one per project | **Signing secret persists for a deleted project.** Dead secrets accumulate; also the endpoint is still queryable by `by_project`. |
| `webhookDeliveries` | many per endpoint | orphaned via `endpointId`; `webhooks.listDeliveries` would 404 the endpoint lookup but rows remain. |

**Impact.** Unbounded orphan growth; dead webhook secrets retained
indefinitely; vector search quality degrades as deleted-project embeddings
consume `limit` slots. `convex/dev.ts:cleanupTestProjects` deletes **all five**
tables (`specs`, `specVersions`, `specEmbeddings`, `webhookEndpoints`,
`webhookDeliveries`) — proving the intended production cascade. `remove`
implements a strict subset.

**Fix.** Mirror `dev.ts:cleanupTestProjects`:

```ts
const embeddings = await ctx.db
  .query("specEmbeddings")
  .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
  .collect();
for (const e of embeddings) await ctx.db.delete(e._id);

const endpoints = await ctx.db
  .query("webhookEndpoints")
  .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
  .collect();
for (const ep of endpoints) {
  const deliveries = await ctx.db
    .query("webhookDeliveries")
    .withIndex("by_endpoint", (q) => q.eq("endpointId", ep._id))
    .collect();
  for (const d of deliveries) await ctx.db.delete(d._id);
  await ctx.db.delete(ep._id);
}
```

---

### [P2] `remove` fires no `project.deleted` webhook or notification

`convex/projects.ts:202-204`

```ts
// Usage events stay for analytics integrity; they still reference projectId.
await ctx.db.delete(args.projectId);
return { deleted: args.projectId };
```

**Problem.** Project deletion is the most destructive irreversible action in
this module, yet it emits zero events. Compare the rest of the contract:
`specs.publish` → `spec.published` + `spec_published` notification;
`specs.deprecateVersion` → `spec.deprecated` + `version_deprecated`;
`admin.setProjectVisibility` → `project.visibility_changed` +
`visibility_changed`. Deletion fires nothing.

**Impact.** Publisher webhook subscribers receive no signal that a project
(and thus its published spec versions) is gone; consumer integrations
discovering via webhook see silent disappearance. Also: scheduled
`deliverWebhook` actions already in-flight when `remove` runs will still
execute (the endpoint is **not** deleted per the P1 above), so the publisher
receives post-deletion `spec.published`/`spec.deprecated` deliveries for a
project that no longer exists — inconsistent state.

**Fix.** Before deleting, fire `fireWebhookEvent(ctx, args.projectId,
"project.deleted", { projectId: args.projectId })` and a `createNotification`
of an appropriate `kind` (the `notifications.kind` union would need a new
variant — coordinate with `schema.ts`). Cancel pending scheduled
`deliverWebhook` runs, or delete endpoints first so `getDeliveryForAction`
returns null and the action no-ops.

---

### [P2] `update` visibility change emits no `visibility_changed` notification or webhook

`convex/projects.ts:124-126`

```ts
if (args.patch.visibility !== undefined) {
  visibility = args.patch.visibility;
}
```

**Problem.** This is the self-service visibility path — the web UI's "Make
Public/Private" dialog calls `api.projects.update` with `{ visibility }`
(`apps/web/src/routes/app/projects/$projectSlug.tsx:141`). It silently writes
the field. The admin path, `admin.setProjectVisibility`
(`convex/admin.ts:216-245`), fires **both** a `visibility_changed`
notification and a `project.visibility_changed` webhook for the same semantic
event. Same field, two code paths, only one emits.

**Impact.** Publisher webhook subscribers get notified when an admin
force-flips visibility but **not** when the publisher themselves flips it via
the UI — the exact opposite of what an event-driven contract implies.
Consumers cached the project as public; the publisher flips it private; no
`project.visibility_changed` fires; consumers keep calling until they hit the
gateway. (Separately, `specs.getPublishedForGateway` does not gate on
`visibility` at all — but that's a specs.ts defect, not this file.)

**Fix.** In `update`, when `args.patch.visibility !== undefined &&
args.patch.visibility !== current.visibility`, mirror `admin.setProjectVisibility`:

```ts
if (args.patch.visibility !== undefined && args.patch.visibility !== current.visibility) {
  await createNotification(ctx, {
    clerkOrgId: org.clerkOrgId,
    kind: "visibility_changed",
    title: "Project visibility changed",
    body: `Your project "${current.name}" is now ${args.patch.visibility}.`,
    refId: `visibility_changed:${args.projectId}:${Date.now()}`,
  });
  await fireWebhookEvent(ctx, args.projectId, "project.visibility_changed", {
    projectId: args.projectId,
    visibility: args.patch.visibility,
  });
}
```

Note `update` currently does not even destructure `org` from
`requireProjectMember` — it would need `const { org } = await
requireProjectMember(...)`.

---

### [P2] `remove` hard-deletes published/public projects with no coherence check

`convex/projects.ts:180-186`

```ts
export const remove = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<{ deleted: Id<"projects"> }> => {
    await requireProjectMember(ctx, args.projectId);

    const draft = await ctx.db
      .query("specs")
```

**Problem.** `remove` performs no status/visibility gate. A `published` +
`public` project serving live gateway traffic is hard-deleted in one call
with no confirmation that the project is in a safe state. Combined with the
missing `project.deleted` webhook (above) and `specs.getPublishedForGateway`
returning the spec for any published project, this means: gateway requests
for the just-deleted project go from 200 to 404 with no consumer notification,
no grace period, and no soft-delete recovery path.

**Impact.** Irreversible breakage of consumer integrations and catalogue
URLs (`/catalogue/$orgSlug/$projectSlug`) for any project that was live.
There is no soft-delete tombstone; the row is gone.

**Fix.** At minimum, require `status === "draft"` (reject deletion of a
published project unless it's first reverted to draft / unpublished), or gate
on `visibility === "private"`. If hard-delete of live projects is intended,
it must fire the deletion webhook first (see P2 above) and the gateway must
have a documented degraded path.

---

### [P2] Read path is case-sensitive on `projectSlug` while `create` lowercases — mixed-case URL slugs 404

`convex/projects.ts:22-30` (and `create` normalization at `:48-53`)

```ts
// create:
const slug = args.slug.trim().toLowerCase();

// get:
.withIndex("by_org_slug", (q) =>
  q.eq("organizationId", org._id).eq("slug", args.projectSlug),
)
.unique();
```

**Problem.** `create` normalizes the slug to lowercase before storing, but
`get` queries `by_org_slug` with the raw `args.projectSlug`. Since stored
slugs are always lowercase, any lookup with an uppercase character returns
`null`. The web route passes `params.projectSlug` straight through
(`apps/web/src/routes/app/projects/$projectSlug.tsx:65-68`). The same
non-normalization exists in `specs.getPublishedForGateway` and
`catalogue.getPublicDetail` / `getPublicDetail`.

**Impact.** A user (or gateway, or external bookmark) hitting
`/app/projects/My-Api` or `/catalogue/Acme/My-Api` gets a 404 even though
`/acme/my-api` works. The write side and read side disagree on slug
canonicalization. For URL-backed resources this is a contract defect, not
a cosmetic issue.

**Fix.** Normalize on read at every slug lookup, or document that callers
must lowercase. Simplest:

```ts
const projectSlug = args.projectSlug.trim().toLowerCase();
```

applied in `get` (and the sibling gateway/catalogue queries, out of scope here
but worth a follow-up).

---

### [P3] `update` tags: no per-tag length or character validation; unbounded array pre-dedup

`convex/projects.ts:128-143`

```ts
if (args.patch.tags !== undefined) {
  const raw = args.patch.tags
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  const seen: Record<string, true> = {};
  const unique: string[] = [];
  for (const tag of raw) {
    if (seen[tag]) continue;
    seen[tag] = true;
    unique.push(tag);
  }
  if (unique.length > 32) {
    throw new Error("At most 32 tags");
  }
  tags = unique;
}
```

**Problem.** Tags are lowercased and deduped, but there is (a) no per-tag
length cap — a single tag can be 100 KB; (b) no character/format validation —
tags may contain newlines, control chars, commas, or arbitrary unicode; (c)
the `>32` check runs **after** the full O(n) map+filter+dedup over the input
array, and the `v.array(v.string())` validator imposes no length bound, so a
client can submit 100k tags to force that work.

**Impact.** Tags feed `catalogue.listPublic`'s search haystack
(`${project.tags.join(" ")}`) and the `project.tags.includes(tag)` filter; an
oversized or garbage tag bloats the listing payload and degrades
substring search. Mild DoS surface on `update`.

**Fix.** Cap per-tag length and total array length at the validator or
before the dedup loop:

```ts
const MAX_TAG_LEN = 48;
const raw = args.patch.tags
  .map((t) => t.trim().toLowerCase().slice(0, MAX_TAG_LEN))
  .filter((t) => t.length > 0);
if (args.patch.tags.length > 64) throw new Error("Too many tags");
```

---

### [P3] `list` uses unbounded `.collect()` with no pagination

`convex/projects.ts:7-15`

```ts
return await ctx.db
  .query("projects")
  .withIndex("by_org", (q) => q.eq("organizationId", org._id))
  .collect();
```

**Problem.** `list` returns every project in the org. Sibling queries
(`webhooks.listDeliveries`, `usage.listForOrg`) paginate via
`paginationOptsValidator`. An org that publishes many APIs over time loads
the full set on every route entry (`useSuspenseQuery` in
`apps/web/src/routes/app/projects/index.tsx:91` and
`settings/activity.tsx:133`).

**Impact.** Unbounded response size and wasted bandwidth/CPU for mature orgs.
Not a correctness bug today; becomes one as the catalogue grows.

**Fix.** Accept `paginationOpts` and return `{ page, isDone, continueCursor }`,
or cap with `.take(N)` + a `hasMore` flag.

---

### [P3] `update` permits `visibility: "public"` on a `status: "draft"` project

`convex/projects.ts:124-126`

**Problem.** `visibility` and `status` are independently mutable with no
coherence check. A draft project (no published `specVersions` row) can be
marked `visibility: "public"`. The catalogue hides it (`by_visibility_status`
requires `public` + `published`), so there's no immediate leak — but the
state is incoherent, and the next `specs.publish` instantly exposes the
project to the public catalogue without any separate visibility decision.

**Impact.** The publisher can accidentally publish to the public catalogue
in one step (publish) when they believed visibility was already gated.
Confusing failure mode, not a leak today.

**Fix.** In `update`, if `args.patch.visibility === "public"` and
`current.status !== "published"`, either reject or no-op with a clear error.
Symmetric: flipping a published project to `private` should require
acknowledgement that gateway consumers will be cut off.

---

### [P3] `create` validates name/description length only after trim; validator accepts arbitrary length

`convex/projects.ts:39-59`

```ts
const name = args.name.trim();
if (name.length === 0) { throw new Error("Name is required"); }
if (name.length > 120) { throw new Error("Name must be at most 120 characters"); }
```

**Problem.** `v.string()` imposes no max length, so a 10 MB `name` payload is
fully deserialized into memory, trimmed, then length-checked. Same for
`description` (capped at 2000 only after trim). The check is correct; the
ordering is wasteful.

**Impact.** Mild DoS: a client can submit oversized strings that pass the
validator and only fail at the handler. Convex's request size limits catch
the extreme case, but a 256 KB name is accepted and processed.

**Fix.** Use `v.string()` with a max-length validator
(`v.string()` + manual check before `.trim()`, or a custom validator) so
oversized payloads reject at the boundary.

---

### [P3] `requireProjectMember` discloses project existence to any authenticated user

`convex/projects.ts:99-104` (update) and `:180-186` (remove), via `convex/lib/auth.ts:requireProjectMember`

```ts
const project = await ctx.db.get(projectId);
if (project === null) { throw new Error("Project not found"); }
const org = await ctx.db.get(project.organizationId);
if (org === null) { throw new Error("Organization not found"); }
if (org.clerkOrgId !== claims.orgId) {
  throw new Error("Not a member of this organization");
}
```

**Problem.** `update` and `remove` take a raw `projectId` (`v.id("projects")`)
typed argument. Any authenticated user can probe any project id and
distinguish "Project not found" (doesn't exist) from "Not a member of this
organization" (exists, owned by another org). The `get`/`list` queries don't
have this issue (they're org-slug-scoped), but the projectId-keyed mutations
do.

**Impact.** Existence oracle. Low severity given Convex ids are
non-enumerable random ids, but it's a measurable information leak on the
mutate surface.

**Fix.** Collapse the two errors into a single generic `"Project not found"`
for non-members (return the same error whether the project is missing or
merely out-of-org). The caller cannot act on the distinction anyway.

---

### [P3] `remove`'s `.unique()` on the specs draft throws on a duplicate row

`convex/projects.ts:187-192`

```ts
const draft = await ctx.db
  .query("specs")
  .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
  .unique();
if (draft !== null) {
  await ctx.db.delete(draft._id);
}
```

**Problem.** `specs.by_project` is a non-unique index (no DB-level unique
constraint — same shape as the projects slug issue). If a corrupt state ever
produces two `specs` rows for one project, `.unique()` throws
`ConvexMultiDocumentError` and `remove` aborts, leaving the project
undeletable from the UI. The same pattern is used in `specs.getDraft` and
`specs.saveDraft`.

**Impact.** Defensive: only triggers on pre-existing corruption, but it
makes `remove` brittle exactly when you need it (manual cleanup).

**Fix.** Use `.collect()` + iterate, matching the `specVersions` deletion
pattern immediately below it (which already uses `.collect()` for exactly
this reason).

---

### [P3] `create` emits no `project.created` event

`convex/projects.ts:71-86`

**Problem.** The event-driven contract fires on `spec.published`,
`spec.deprecated`, `project.visibility_changed` — but project creation is
silent. No `project.created` webhook, no notification. Inconsistent with the
rest of the surface.

**Impact.** Publisher integrations that sync project lifecycle via webhook
never see the creation event; they only learn about a project when its first
spec is published. Minor.

**Fix.** Fire `fireWebhookEvent(ctx, projectId, "project.created", {...})`
after the draft row insert (the webhook endpoint won't exist yet at create
time, so this is effectively a no-op today — but if/when endpoints can be
pre-configured, the contract is in place).

---

## Summary

**Counts:** 2 × P1 · 4 × P2 · 7 × P3 — 13 findings total.

**Top 3 (must-fix before merge):**

1. **P1 — Slug uniqueness TOCTOU.** Concurrent `create` produces duplicate
   slugs; `.unique()` in `get`/`getPublishedForGateway`/`getPublicDetail`
   then crashes the detail page and the gateway for that slug. No DB-level
   unique constraint exists. Needs a serialization envelope or a token table.

2. **P1 — `remove` cascade gaps.** Orphans `specEmbeddings` (vector-index
   pollution), `webhookEndpoints` (dead signing secrets retained), and
   `webhookDeliveries`. `dev.ts:cleanupTestProjects` already implements the
   correct five-table cascade — `remove` is a strict subset.

3. **P2 — `update` visibility flip is silent.** The self-service UI path
   emits no `visibility_changed` notification and no
   `project.visibility_changed` webhook, while the admin path
   (`admin.setProjectVisibility`) fires both for the same semantic event.
   Publisher webhook subscribers are not told when a publisher flips their
   own project's visibility. Mirror the admin path in `update`.
