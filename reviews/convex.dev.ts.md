# Tiger Review — `convex/dev.ts`

## Verdict

**Incorrect.** The module ships two real correctness/integrity defects on top of
an operator-safety gap. `seedDemoProjects` violates the project's
"published spec versions are immutable" invariant by patching the `spec` body
of an existing published `specVersions` row in place; `cleanupTestProjects`
orphans `usageEvents` and `publisherEarnings` rows that reference the deleted
junk projects; and neither dev function carries any production guard, so a
mis-targeted `npx convex run` against the prod deployment can pollute the
public catalogue or delete real projects whose slugs collide with the generic
junk patterns.

## File Stats

- File: `convex/dev.ts`
- Lines reviewed: 1–342 (full)
- Functions: `cleanupTestProjects` (internalMutation), `seedDemoProjects` (internalMutation)
- Exposed via HTTP / cron / scheduler: **no** (verified `convex/http.ts` and grep for `internal.dev` — zero callers). Callable only via `npx convex run dev:*` (requires deploy-token auth) or from other Convex internals.
- Callers found in repo: **0** (only self-references in the header comment).

## Findings

### [P1] `seedDemoProjects` mutates the body of an already-published `specVersions` row

**Location:** `convex/dev.ts:285–293`

```ts
const versions = await ctx.db
  .query("specVersions")
  .withIndex("by_project", (q) => q.eq("projectId", existing._id))
  .collect();
for (const v of versions) {
  if (v.version === DEMO_VERSION) {
    await ctx.db.patch(v._id, { spec: specJson });
  }
}
```

**Problem.** The re-run/"update" branch of `seedDemoProjects` overwrites the
`spec` field of an existing published version document. This directly violates
an explicit, load-bearing project invariant — `convex/schema.ts` documents
`specVersions` as *"Immutable published OpenAPI versions"*, and the only
patches the real publish flow (`convex/specs.ts:332` / `:374`) ever applies to
a `specVersions` row touch **metadata only** (`deprecatedAt`, `sunsetAt`,
`deprecationMessage`); the `spec` body is written once at
`specs.ts:160` (`insert`) and never modified. The dev seed is the only code
path in the repo that mutates a published spec body.

**Impact.** Two concrete consequences:

1. **Gateway cache incoherence.** `apps/gateway/src/spec-source.ts:66–96`
   (`CachedSpecSource`) caches the published spec keyed by `orgSlug/projectSlug`
   with a TTL. Mutating the spec body in Convex after it was already served
   means every gateway edge instance returns the *old* body until its TTL
   expires — consumers see a spec that disagrees with the (allegedly
   immutable) version they fetched moments earlier. The immutability
   invariant is precisely what makes the gateway's TTL cache safe; this
   branch silently invalidates that assumption.
2. **Broken audit/history contract.** `specVersions` is the append-only
   history of what each published version contained. In-place `spec` patching
   destroys the prior body with no deprecation record, no new version row,
   no `publishedAt` bump — a publisher comparing "what did version 1.0.0
   contain on day N" gets the latest body, not the originally published one.

This is dev-only tooling and scoped to `test-org`, but the invariant it
breaks is load-bearing and the gateway reads the very rows it mutates.

**Fix.** On re-run, either (a) treat the existing version as immutable and
publish a new version (deprecate the old, insert a fresh `specVersions`
row with a bumped version), or (b) — simpler and appropriate for demo
seed — refuse to mutate the published body and only refresh the *draft*
(`specs.draft`), leaving `specVersions` untouched:

```ts
if (draft !== null && draft.draft !== specJson) {
  await ctx.db.patch(draft._id, {
    draft: specJson,
    lastSavedAt: Date.now(),
  });
  result.updated.push(def.slug);
} else {
  result.skipped.push(def.slug);
}
// Do NOT patch specVersions.spec — published versions are immutable.
```

---

### [P2] No production guard on either dev function — prod catalogue pollution / data loss on mis-targeted `npx convex run`

**Location:** `convex/dev.ts:38–39` (`cleanupTestProjects` args/handler open), `convex/dev.ts:248–249` (`seedDemoProjects` args/handler open)

**Problem.** Neither function inspects the deployment kind. Both are
`internalMutation` with `args: {}` and no auth check. They are invocable
against **any** deployment — including production — via
`npx convex run dev:cleanupTestProjects` / `dev:seedDemoProjects` with nothing
more than a deploy token. The header comment promises "never client-exposed,
never imported by app code" — true — but client-exposure is not the only
risk vector for dev tooling; operator error is.

**Impact.**

- `seedDemoProjects` inserts three `status: "published"`, `visibility: "public"`
  projects owned by whatever org has slug `test-org` into the **public
  catalogue**. If run against prod, every consumer sees
  `weather-forecast` / `random-user` / `http-echo` as real catalogue entries,
  and the scheduler fires `internal.search.embedProject` so they are
  immediately embedded and searchable. `test-org` is a generic slug; a real
  customer org could own it.
- `cleanupTestProjects` deletes by slug match. The prefix `e2e-weather-` is
  unlikely for a real customer, but `scroll-test-1` (exact match) is a
  perfectly plausible real project slug, and `manual-repro-1628` is generic
  enough to be re-used. Running cleanup against prod would hard-delete any
  real project whose slug collides — and, per the next finding, orphans its
  dependent rows rather than cascading.

The repo has no `isProduction` / deployment-kind guard pattern elsewhere
(verified: `process.env` usage in `convex/` is limited to secrets/config, no
`NODE_ENV`/deployment-kind checks), so this is a net-new gap rather than a
missed convention.

**Fix.** Gate both handlers on a dev-only env flag that is unset in prod
deployments, and fail closed:

```ts
handler: async (ctx): Promise<...> => {
  if (process.env.DEV_TOOLING_ENABLED !== "1") {
    throw new Error("dev tooling is disabled on this deployment");
  }
  // ...
}
```

---

### [P2] `cleanupTestProjects` orphans `usageEvents` and `publisherEarnings` rows referencing deleted junk projects

**Location:** `convex/dev.ts:55–99` (the per-project deletion loop)

**Problem.** The cleanup cascade deletes `specs`, `specVersions`,
`specEmbeddings`, `webhookEndpoints` + `webhookDeliveries`, then the
`projects` row itself. It never touches `usageEvents` or `publisherEarnings`,
both of which carry a `projectId` referencing the deleted project:

- `usageEvents` (`schema.ts`): `projectId: v.id("projects")`, indexed
  `by_project` / `by_project_at`.
- `publisherEarnings` (`schema.ts:301`): `projectId: v.optional(v.id("projects"))`,
  indexed `by_publisher`.

**Impact.** The junk slugs are exactly the projects that accrue paid calls:
`e2e/03-consumer.sh:60` runs a metered gateway call
(`curl …/gateway/test-org/e2e-weather-<stamp>/get`), which writes a
`usageEvents` row keyed to that `e2e-weather-*` project. After cleanup, those
`usageEvents` rows dangle forever — `organizationId` is still valid but
`projectId` now points at a deleted doc. Any analytics/earnings query that
joins `usageEvents` → `projects` (or `publisherEarnings` → `projects`) gets
`null` for the project and either silently drops the row or crashes, and the
`by_project` / `by_project_at` indexes now index tombstoned ids. This is
precisely the "corrupts ledger / orphaned references" class the brief asks
about — not the wallet ledger itself (that is untouched, good), but the
metering/earnings tables that feed it.

**Fix.** Extend the cascade to delete (or explicitly detach) the two
remaining dependent tables inside the per-project loop:

```ts
const usageEvents = await ctx.db
  .query("usageEvents")
  .withIndex("by_project", (q) => q.eq("projectId", project._id))
  .collect();
for (const ue of usageEvents) {
  await ctx.db.delete(ue._id);
}

const earnings = await ctx.db
  .query("publisherEarnings")
  .filter((q) => q.eq(q.field("projectId"), project._id))
  .collect();
for (const e of earnings) {
  await ctx.db.delete(e._id);
}
```

(Or null out `projectId` on `publisherEarnings` if earnings history must be
retained — but deleting is consistent with the rest of the cascade.)

---

### [P3] `seedDemoProjects` update path skips spec validation and re-embedding

**Location:** `convex/dev.ts:280–298` (update branch) vs `:300` (validation, create-only) and `:332` (embed scheduling, create-only)

**Problem.** The create branch validates every demo spec with
`validateOpenApiSpec(specJson)` (`:300`) and schedules
`internal.search.embedProject` (`:332`). The update branch does neither — it
patches `specs.draft` (and, per finding #1, the published `specVersions.spec`)
directly from `specJson` with no validation, and never re-schedules embedding.

**Impact.** If a future edit to `DEMO_PROJECTS` introduces an invalid spec
shape, re-running the seed on an existing `test-org` will silently write the
invalid spec into both the draft and the published version, and the
`specEmbeddings` row (whose `text` is derived from name + description +
tags + endpoint summaries per `convex/search.ts`) will go stale if any
endpoint `summary` changed — catalogue search returns stale hits until the
project is re-embedded by some other path.

**Fix.** Hoist validation above the create/update split, and schedule
re-embedding on the update branch as well:

```ts
const issues = validateOpenApiSpec(specJson);
const hasError = issues.some((i) => i.level === "error");
if (hasError) {
  throw new Error(`Demo spec "${def.slug}" failed validation: ${JSON.stringify(issues)}`);
}

if (existing !== null) {
  // ... patch draft / version ...
  await ctx.scheduler.runAfter(0, internal.search.embedProject, {
    projectId: existing._id,
  });
  result.updated.push(def.slug);
  continue;
}
// ... create path ...
```

## Summary

- **Findings:** 4 (P1: 1, P2: 2, P3: 1)
- **Top 3:**
  1. **[P1]** Published `specVersions.spec` body mutated in place by the seed
     update path — violates the immutability invariant and breaks gateway
     TTL-cache coherence (`dev.ts:291`).
  2. **[P2]** No production guard on either dev function — mis-targeted
     `npx convex run` against prod pollutes the public catalogue or deletes
     real projects whose slugs match generic junk patterns (`dev.ts:38`,
     `dev.ts:248`).
  3. **[P2]** `cleanupTestProjects` orphans `usageEvents` and
     `publisherEarnings` rows keyed to deleted junk projects — exactly the
     e2e projects that accrue metered calls (`dev.ts:55–99`).
