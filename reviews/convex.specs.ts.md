# Tiger-Style Review — `convex/specs.ts`

## Verdict

**Incorrect.** The spec storage layer has two genuine defects that violate the
file's own contracts (pricing source-of-truth, org-scoped visibility) plus a
handful of fragility and integrity gaps around immutability, validation, and
side-effect coupling. Immutability of the published `spec` body itself holds
(no mutation path writes `specVersions.spec`), but the surrounding surface is
leaky.

## File Stats

- **Lines reviewed:** 387
- **Exports:** 8 (`getDraft`, `saveDraft`, `publish`, `listVersions`,
  `getVersion`, `getPublishedForGateway`, `deprecateVersion`,
  `undeprecateVersion`)
- **Tables touched:** `specs`, `specVersions`, `projects`, `organizations`,
  `notifications`, `webhookEndpoints`, `webhookDeliveries`
- **Findings:** 13 (P1: 2, P2: 4, P3: 7)

---

## Findings

### [SEV: P1] `getPublishedForGateway` leaks private published specs + `clerkOrgId` to unauthenticated callers

**Location:** `convex/specs.ts:254-302` (handler body), specifically the
visibility check at `convex/specs.ts:289-290`.

**Problem:** The query is documented as "Public (no-auth) query for the gateway
data plane" and performs **no `ctx.auth` check and no `visibility` enforcement**:

```ts
if (project === null) return null;
if (project.status !== "published") return null;   // <-- only status checked
...
return {
  spec: latest.spec,            // full OpenAPI body
  ...
  clerkOrgId: org.clerkOrgId,  // internal Clerk org id
  visibility: project.visibility,
  ...
};
```

A project can legitimately be `status: "published"` **and**
`visibility: "private"` (the catalogue hides it; the gateway serves it only to
keys whose org owns the project — see `apps/gateway/src/pipeline.ts:88-95`).
The gateway enforces visibility at the **edge**, but the Convex query that feeds
the gateway is itself publicly callable. The gateway's
`ConvexSpecSource` (`apps/gateway/src/spec-source.ts:120-140`) calls this query
with a bare `ConvexHttpClient` and **no auth token**, which proves the query is
intended to be reachable without identity.

**Impact:** Anyone who can reach the Convex deployment URL (which is not a
secret — it is shipped to the browser for the web app) and who can guess or
discover an `orgSlug`/`projectSlug` pair can read the **full OpenAPI body**
(endpoints, upstream URL `servers[0].url`, param shapes, x-zevium pricing) of
any **private** published project, plus the owning org's internal `clerkOrgId`.
The gateway's 404-not-leak guarantee (`pipeline.ts:88-95`) is fully bypassable
by querying Convex directly. This is a server-side authorization gap; the
data-plane enforcement is meaningless when the control-plane read is open.

**Fix:** Require the gateway to authenticate to Convex (service token /
admin-key query) and gate `getPublishedForGateway` on that principal; or split
into a public variant that returns `null` for `visibility !== "public"` and a
separate gateway-authenticated internal query. Do not return `spec` or
`clerkOrgId` for private projects to unauthenticated callers.

---

### [SEV: P1] `x-zevium-cost: 0` is accepted at publish but silently charged as 1 credit at the gateway

**Location:** `convex/specs.ts:127` (publish-time validation via
`validateOpenApiSpec`) combined with `packages/shared/src/openapi.ts:147`
(`extractPricing`).

**Problem:** The spec is documented as the **pricing source of truth**
(`x-zevium-cost`). `validateOpenApiSpec` (`packages/shared/src/validate.ts`)
treats `x-zevium-cost` as valid when it is a finite `number >= 0`:

```ts
} else if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
  // error
}
```

So `x-zevium-cost: 0` (a publisher expressing a **free** endpoint) passes
`saveDraft` and `publish` validation and is stored immutably in
`specVersions.spec`. At gateway time, however, `extractPricing` does:

```ts
const cost = costRaw !== undefined && costRaw > 0 ? Math.floor(costRaw) : 1;
```

`0 > 0` is `false`, so `cost` falls through to the default `1`. A publisher who
publishes a free endpoint silently charges every consumer **1 credit per call**,
and the published spec — the source of truth — claims `0`. There is no signal
to either party that the contract is being violated.

**Impact:** Silent pricing divergence between the stored source of truth and
the metered charge. Free-tier/freemium publisher offerings bill consumers
incorrectly; refunds and trust erosion follow. This is exactly the class of bug
the "spec is the pricing source of truth" rule exists to prevent.

**Fix:** Decide the semantics of `0` deliberately. If `0` means free,
`extractPricing` must return `cost: 0` (and `consumeFreeTier`/wallet path must
handle a zero-credit charge). If `0` is invalid, `validateOpenApiSpec` must
reject it with an error so publish blocks. Today the two halves disagree.

---

### [SEV: P2] `undeprecateVersion` uses `replace` with a hand-listed field set — silently drops future optional fields

**Location:** `convex/specs.ts:364-370`.

**Problem:**

```ts
await ctx.db.replace(args.versionId, {
  projectId: version.projectId,
  version: version.version,
  spec: version.spec,
  publishedAt: version.publishedAt,
});
```

`replace` overwrites the entire document with exactly the fields supplied. The
comment says "patch cannot delete them," which is true for the three current
deprecation fields. But the hardcoded field list means any **future** optional
field added to `specVersions` (e.g. `archivedAt`, `yankedAt`, `publishedBy`)
will be **silently wiped** by an undeprecate call, with no type error at the
call site (the object literal is structurally a valid partial). The pattern is
brittle by construction: it couples "clear deprecation" to "the full set of
fields on the table."

**Impact:** Future schema additions are a footgun. Any optional metadata field
co-authored elsewhere on `specVersions` is destroyed the first time a publisher
un-deprecates. Immutability of `spec` is preserved, but other metadata is not.

**Fix:** Use `ctx.db.patch(args.versionId, { deprecatedAt: undefined,
sunsetAt: undefined, deprecationMessage: undefined })` — Convex `patch`
**does** support unsetting optional fields by passing `undefined` (this is the
documented behavior), so the `replace` is unnecessary. If a true full-rewrite
semantics is desired, spread `version` and override only the deprecation keys:
`{ ...version, deprecatedAt: undefined, sunsetAt: undefined,
deprecationMessage: undefined }`.

---

### [SEV: P2] `undeprecateVersion` fires no webhook or notification — asymmetric with `deprecateVersion`

**Location:** `convex/specs.ts:355-373` (entire handler).

**Problem:** `deprecateVersion` (`convex/specs.ts:317-348`) creates a
`version_deprecated` notification and fires a `spec.deprecated` webhook.
`undeprecateVersion` clears the deprecation metadata but emits **nothing**.
Subscribers (publisher-side automations, consumer-side sunset trackers) that
acted on `spec.deprecated` are never told the deprecation was lifted. The
catalogue and gateway will resume serving the version as active, but every
downstream consumer that recorded "sunset pending" continues to believe it.

**Impact:** Divergent state between the control plane (active again) and every
webhook/integration consumer (still deprecated). For a marketplace where
consumers pin versions and schedule migrations off deprecated APIs, this is a
real correctness gap in the event contract.

**Fix:** Emit a `spec.undeprecated` (or `spec.deprecated` with a `false` flag)
webhook + a notification on the undeprecate path, mirroring the deprecate path.

---

### [SEV: P2] `publish` couples immutable spec insert to notification insert and webhook scheduling in one transaction

**Location:** `convex/specs.ts:140-175` (post-insert side effects).

**Problem:** After `ctx.db.insert("specVersions", ...)` and the project
`status` patch, `publish` does, all inside the same mutation transaction:

1. `createNotification(...)` — a DB insert into `notifications`.
2. `fireWebhookEvent(...)` — a DB insert into `webhookDeliveries` **plus**
   `ctx.scheduler.runAfter(0, internal.webhooks.deliverWebhook, ...)`.
3. `ctx.scheduler.runAfter(0, internal.search.embedProject, ...)`.

If any of these throw (a transient scheduler error, a constraint violation on
`webhookDeliveries`, an OOM in `JSON.stringify` of an attacker-shaped payload),
Convex rolls back the **entire** transaction, including the `specVersions`
insert and the project status patch. The publish silently fails for a reason
that has nothing to do with spec validity. `fireWebhookEvent` is *not* pure
no-op-on-error: it inserts a `webhookDeliveries` row and calls the scheduler,
both of which can throw.

Note `fireWebhookEvent`'s own doc says it is "No-op when endpoint missing or
inactive" — but when an endpoint **exists**, it does real transactional work
inside the caller's transaction.

**Impact:** A publisher cannot reliably publish a version if their webhook
endpoint is configured; transient webhook-queue failures block the immutable
publish. The side effects are not appropriately decoupled from the source-of-
truth write.

**Fix:** Either move `fireWebhookEvent` and `createNotification` to a
post-commit scheduled internal mutation (`ctx.scheduler.runAfter(0,
internal.specs.afterPublish, { versionId })`) so they cannot roll back the
publish, or wrap them in try/catch that logs and continues. The spec insert +
project status patch should be the transactional unit; notifications and
webhook queueing are best-effort.

---

### [SEV: P2] `deprecateVersion` performs no validation of `sunsetAt` or `message`

**Location:** `convex/specs.ts:311-315` (args) and `convex/specs.ts:325-328`
(patch).

**Problem:** Args are `sunsetAt: v.optional(v.number())` and
`message: v.optional(v.string())` with no range/length constraints and no
semantic checks:

- `sunsetAt` can be in the past, before `deprecatedAt` (which is `now`), or
  billions of years in the future. The gateway emits a `Sunset:` HTTP-date
  header from this (`apps/gateway/src/` per `wave8-gateway-deprecation.md`),
  so a past `sunsetAt` produces a nonsensical header advertising a sunset that
  already happened.
- `message` is unbounded — a publisher can store a multi-megabyte deprecation
  message that is returned verbatim by `getPublishedForGateway` and rendered
  into consumer-facing banners.
- `deprecateVersion` can be called on a version that is **already
  deprecated**, overwriting `deprecatedAt` with a new `now` and silently
  discarding the original deprecation timestamp (which may have legal/contractual
  meaning for consumers who already saw the first banner).

**Impact:** Malformed deprecation metadata reaches consumers via the public
gateway query; lost `deprecatedAt` history; unbounded storage in
`specVersions`.

**Fix:** Validate `sunsetAt > now` (and `sunsetAt > deprecatedAt`); cap
`message` length (e.g. 2000 chars, matching `projects.description`); if the
version is already deprecated, either reject or require an explicit
"re-deprecate" intent that preserves the original `deprecatedAt`.

---

### [SEV: P3] No explicit spec-size guardrail on `saveDraft` / `publish`; relies entirely on Convex platform limits

**Location:** `convex/specs.ts:36-38` (`saveDraft` args), `convex/specs.ts:99`
(`publish` args), `convex/specs.ts:75` and `convex/specs.ts:127` (validation).

**Problem:** `spec: v.string()` accepts any length. The only guard is
`validateOpenApiSpec`, whose first action is `JSON.parse(specText)` — a full
in-memory parse with no length pre-check. Convex enforces platform-level arg
and document limits, but the layer itself performs no defense: an
attacker-controlled ~900KB JSON (under the doc limit) is parsed on every
autosave and every publish, and the parse result is iterated. Deeply nested
JSON will throw inside `JSON.parse` (caught → validation error, fine), but a
wide, shallow document with millions of path keys is accepted and stored.

**Impact:** CPU/memory amplification on the control plane; the only backstop is
Convex's 1MB doc limit, which produces an opaque error leaked to the client.

**Fix:** Add an explicit `if (args.spec.length > MAX_SPEC_BYTES)` guard (e.g.
256KB) before `validateOpenApiSpec` in both `saveDraft` and `publish`, with a
clear error issue.

---

### [SEV: P3] `getPublishedForGateway` `.first()` is ambiguous when two versions share `publishedAt`

**Location:** `convex/specs.ts:294-298`.

**Problem:** `publishedAt = Date.now()` (ms epoch). Two publishes in the same
millisecond (e.g. a fast re-publish of a hotfix, or two org members publishing
different versions concurrently) produce identical `publishedAt`. The
`by_project_published` index is ordered by `publishedAt` only, so `.first()`
returns a non-deterministic one of the two. The same ambiguity affects
`listVersions` ordering (`convex/specs.ts:188-194`).

**Impact:** The "latest published version" served to the gateway can flip
between two versions non-deterministically; the catalogue price chip and the
served spec can disagree on subsequent calls (within the 30s gateway TTL).

**Fix:** Add a tiebreaker to the index (e.g. `by_project_published` →
`["projectId", "publishedAt", "_id"]` or use `_creationTime`), or fetch all and
sort by `publishedAt` then `_id` desc in the handler.

---

### [SEV: P3] `getVersion` return shape omits deprecation metadata, inconsistent with `listVersions`

**Location:** `convex/specs.ts:256-262` (return type).

**Problem:** `getVersion` returns `{ version, spec, publishedAt }` only. The
version dialog (`apps/web/src/components/spec-editor/version-dialog.tsx:72-74`)
fetches this for the spec body, and separately fetches `listVersions` for
deprecation state. But `getVersion` already loads the full `row` — the
deprecation fields are right there and simply not returned. A version viewed in
isolation cannot tell the user it is deprecated.

**Impact:** Extra round-trip and potential staleness between the two queries;
the version dialog can show a deprecated version without a banner if the
`listVersions` cache lags.

**Fix:** Include `deprecatedAt`, `sunsetAt`, `deprecationMessage` in the
`getVersion` return.

---

### [SEV: P3] `deprecateVersion` webhook payload omits the deprecation `message`

**Location:** `convex/specs.ts:341-345`.

**Problem:**

```ts
await fireWebhookEvent(ctx, version.projectId, "spec.deprecated", {
  projectId: version.projectId,
  version: version.version,
  sunsetAt: args.sunsetAt,    // <-- no `message`
});
```

The notification body includes the message, but the webhook payload does not.
Subscribers who drive consumer-facing sunset banners off the webhook cannot
surface the migration guidance; they must call back into Convex to fetch the
message.

**Impact:** Webhook consumers are second-class relative to notification
consumers for the same event.

**Fix:** Add `message: args.message` to the webhook payload.

---

### [SEV: P3] `publish` and `deprecateVersion`/`undeprecateVersion` return the full `Doc<"specVersions">` including the entire `spec` body

**Location:** `convex/specs.ts:117-118` (return type), `convex/specs.ts:171-176`
(returned `version: versionDoc`), `convex/specs.ts:317` and `convex/specs.ts:357`
(deprecate/undeprecate return `Doc<"specVersions">`).

**Problem:** The full OpenAPI JSON string is echoed back in every mutation
response. The client already has the draft text (`saveDraft` just stored it);
`publish` need only return `{ ok, issues, versionId }`. `deprecateVersion`
and `undeprecateVersion` return the full doc including `spec`.

**Impact:** Every publish/deprecate/undeprecate response carries up to ~1MB of
needless payload over the WebSocket/HTTP transport; wastes bandwidth and
Convex serialization CPU on a hot publisher path.

**Fix:** Return a projected shape: `{ _id, version, publishedAt, deprecatedAt,
sunsetAt, deprecationMessage }`.

---

### [SEV: P3] `servers[0].url` accepts `http://` and arbitrary hosts — gateway SSRF surface

**Location:** `convex/specs.ts:127` (validation via `validateOpenApiSpec`) →
`packages/shared/src/validate.ts` URL check.

**Problem:** `validateOpenApiSpec` accepts `http:` and `https:` for
`servers[0].url`. A publisher (authenticated org member) can set
`servers[0].url` to `http://169.254.169.254/...`, `http://localhost:9222`, or
an internal RFC1918 address. The gateway proxies consumer requests to that URL
(`apps/gateway/src/pipeline.ts`). While the publisher is the "owner" of the
upstream, the gateway runs from Cloudflare edge and will issue requests to
whatever the publisher specifies — including internal addresses reachable from
the worker's network position.

**Impact:** A malicious publisher can make the gateway fetch from internal
endpoints (metadata services, internal admin panels) on every consumer request.
This is partly inherent to a "proxy to upstream" marketplace, but allowing
`http://` and not blocklisting link-local/loopback ranges widens the surface.

**Fix:** In production, require `https:` for `servers[0].url` and reject
loopback / link-local / RFC1918 destinations at publish time (or at gateway
fetch time).

---

### [SEV: P3] Draft rows in `specs` are orphaned on project deletion; no audit on `specVersions`

**Location:** `convex/specs.ts` (no delete cascade); `convex/projects.ts:remove`
(also no cascade); `convex/specs.ts:144-146` (publish insert has no
`publishedBy`).

**Problem:**
- `projects.remove` does not delete the `specs` draft row or any
  `specVersions` rows. Deleting a project leaves orphaned drafts and versions
  that still resolve by `projectId` in `getDraft`/`getVersion` (the auth check
  throws "Project not found" first, so they are unreachable, but they persist
  forever in storage).
- `specVersions` has no `publishedBy` / `publishedByUserId` field — there is
  no audit trail of who published (or deprecated) a version. The notification
  records the org, not the user.

**Impact:** Storage leak on project delete; no per-user auditability for the
most sensitive control-plane action (publishing an immutable pricing source of
truth).

**Fix:** Cascade-delete `specs` (and decide a retention policy for
`specVersions`) in `projects.remove`; add `publishedBy`/`deprecatedBy` Clerk
user ids to `specVersions` and populate from `requireProjectMember`'s
`claims.subject`.

---

## Summary

- **P0:** 0
- **P1:** 2 — unauthenticated private-spec leakage via `getPublishedForGateway`;
  silent `cost:0 → 1` pricing divergence
- **P2:** 4 — fragile `replace` in `undeprecateVersion`; missing un-deprecate
  webhook; transactional coupling of side effects to publish; missing
  `deprecateVersion` input validation
- **P3:** 7 — no spec-size guard; ambiguous latest-version tiebreaker;
  `getVersion` missing deprecation fields; webhook payload missing message;
  full-spec echo in mutation responses; `http://` SSRF surface; orphaned drafts
  + no publish audit

**Top 3 to fix before merge:**
1. Gate `getPublishedForGateway` on visibility/auth — private published specs
   must not be readable from an unauthenticated Convex query.
2. Reconcile `x-zevium-cost: 0` between validation and `extractPricing` — the
   source of truth must match the metered charge.
3. Move `fireWebhookEvent` / `createNotification` out of the `publish`
   transaction so transient side-effect failures cannot roll back an immutable
   publish.
