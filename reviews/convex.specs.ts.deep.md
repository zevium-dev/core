# Tiger Review — `convex/specs.ts` (deep-dive)

Scope: `convex/specs.ts`, `convex/schema.ts` (spec-related tables), `convex/projects.ts` (lifecycle),
`convex/catalogue.ts` (spec-consuming public queries), `packages/shared/src/openapi.ts`,
`packages/shared/src/pricing.ts`, `packages/shared/src/validate.ts`, plus callers in
`convex/lib/auth.ts`, `convex/lib/validate.ts`, `convex/webhooks.ts`, `convex/search.ts`,
`apps/gateway/src/{pipeline,spec-source}.ts` for cross-verification.

OpenAPI spec storage is the pricing source of truth; the gateway trusts `x-zevium-cost` /
`x-zevium-free-tier` verbatim. Every integrity gap below is a place where "spec says X, runtime
does Y" with no guard.

---

## Verdict

**BLOCKER-grade integrity gaps in the pricing source of truth.** Three P1 issues silently corrupt
or leak the spec contract: a public Convex query hands out full private published specs, the
validator accepts fractional costs that the gateway floors to 0 (free calls), and an explicit
`cost: 0` is silently rewritten to `1`. The P2 tier is dominated by missing bounds (spec size,
path count, cost upper limit, SSRF) and N+1 / full-scan catalogue hot paths that re-parse every
published spec on every page load. The P3 tier is the long tail of unbounded metadata, missing
audit trails, and over-broad return shapes. Prior review (2 P1 + 4 P2 + 7 P3) undercounted
significantly; this pass confirms the P1s and triples the P2/P3 surface.

---

## File Stats

| Metric | Value |
|---|---|
| File | `convex/specs.ts` |
| Lines | 388 |
| Exports | `getDraft`, `saveDraft`, `publish`, `listVersions`, `getVersion`, `getPublishedForGateway`, `deprecateVersion`, `undeprecateVersion` |
| Auth helpers | `requireProjectMember`, `getOrgBySlug` |
| Tables touched | `specs`, `specVersions`, `projects`, `specEmbeddings` (via scheduler) |
| Public (no-auth) queries | `getPublishedForGateway` |
| Indexes relied on | `specs.by_project`, `specVersions.by_project_version`, `specVersions.by_project_published`, `projects.by_org_slug`, `projects.by_visibility_status` |

---

## Findings

### P1-1 — `getPublishedForGateway` leaks full spec body of **private** published projects to anyone

**Location:** `convex/specs.ts:259-310`

```ts
export const getPublishedForGateway = query({
  args: { orgSlug: v.string(), projectSlug: v.string() },
  handler: async (ctx, args) => {
    const org = await getOrgBySlug(ctx, args.orgSlug);
    if (org === null) return null;
    const project = await ctx.db.query("projects")
      .withIndex("by_org_slug", (q) => q.eq("organizationId", org._id).eq("slug", args.projectSlug))
      .unique();
    if (project === null) return null;
    if (project.status !== "published") return null;   // ← no visibility check
    const latest = await ctx.db.query("specVersions")...
    return {
      spec: latest.spec,            // full OpenAPI body
      version: latest.version,
      projectId: project._id,
      organizationId: org._id,
      clerkOrgId: org.clerkOrgId,   // P2-1
      visibility: project.visibility,
      ...
    };
  },
});
```

**Problem:** This is a `query` (no `ctx.auth` gate). The only access control is `project.status === "published"`. A project with `status: "published"` AND `visibility: "private"` — the documented "publish first, make public later" state (see `.project/findings/spec-editor-report.txt:54` and `prompts/fix-cross-org-metering.md:9-12`) — returns its **full OpenAPI body**, including the upstream `servers[0].url` (which for a private project is typically an internal/staging upstream), every path, every `x-zevium-cost`, and the internal `organizationId` + `clerkOrgId`.

The gateway (`apps/gateway/src/pipeline.ts:88-95`) does gate at request time: foreign keys get `404 project_not_found` for private projects. **But that gate only protects the gateway path.** The Convex query is directly callable by anyone who has the deployment URL (which is shipped in the web bundle as `VITE_CONVEX_URL` and trivially extractable). An attacker enumerates `orgSlug`/`projectSlug` pairs (org slugs are public via `catalogue.listPublic`; project slugs are guessable kebab-case) and reads the full spec of every private published project.

**Impact:** Confidentiality breach of private publisher specs — upstream URLs, internal route
shapes, pricing intent. The spec is the pricing source of truth; leaking it for a private project
defeats the entire "publish privately first" workflow.

**Fix:** Gate the query the same way the gateway does — return `null` when `project.visibility !== "public"`, OR require the caller to present a verified key/org claim and only return the spec when `verified.orgId === org.clerkOrgId`. The latter matches the gateway's access rule exactly and avoids shipping the gate in two places. Minimum: `if (project.visibility !== "public") return null;`.

---

### P1-2 — Fractional `x-zevium-cost` is floored to `0` at the gateway (free calls)

**Location:** `packages/shared/src/openapi.ts:177-184` (extractor), `packages/shared/src/validate.ts:155-167` (validator gap)

```ts
// openapi.ts
export function extractPricing(op: OpenApiOperation): EndpointPricing {
  const costRaw = asNumber(op["x-zevium-cost"]);
  const cost = costRaw !== undefined && costRaw > 0 ? Math.floor(costRaw) : 1;
  //                                              ^^^^^^^^^^^^^^
  ...
}
```

```ts
// validate.ts — the only check that gates publish
} else if (
  typeof cost !== "number" ||
  !Number.isFinite(cost) ||
  cost < 0
) {
  issues.push({ level: "error", ... "x-zevium-cost must be a number ≥ 0" });
}
```

**Problem:** The validator accepts any finite `cost >= 0`, including `0.5`, `0.1`, `0.99`. The gateway extractor then does `Math.floor(0.5)` → `0`. A spec with `x-zevium-cost: 0.5` is stored, published, catalogue-listed, and **the gateway charges 0 credits per call** — every call is free, forever, for the lifetime of that published (immutable) version. The publisher cannot fix it without publishing a new semver; existing consumers keep draining.

This is not a theoretical fractional-credit feature — `EndpointPricing.cost` is documented as "Credits per call" with no fractional contract. The validator's `cost >= 0` check implies non-negative reals are valid; the extractor silently reinterprets them.

**Impact:** Pricing integrity failure. A publisher who fat-fingers `0.5` instead of `5` gives
away free calls until they notice and publish a new version. The spec is the source of truth and
this silently corrupts it. There is no monitoring hook that would catch a 0-cost published endpoint.

**Fix:** In `validate.ts`, reject non-integer costs: add `|| !Number.isInteger(cost)` to the error branch, and tighten the message to "x-zevium-cost must be a non-negative integer". Optionally also reject `cost === 0` (see P1-3) or document that 0 means "free, do not bill". In `extractPricing`, make the floor a defense-in-depth: `const cost = costRaw !== undefined && costRaw >= 1 ? Math.floor(costRaw) : 1;` so the extractor and validator agree on the integer contract.

---

### P1-3 — Explicit `x-zevium-cost: 0` is silently rewritten to `1`

**Location:** `packages/shared/src/openapi.ts:179`

```ts
const cost = costRaw !== undefined && costRaw > 0 ? Math.floor(costRaw) : 1;
//                                              ^^^^^^^^
// costRaw === 0  →  condition false  →  cost = 1
```

**Problem:** The validator explicitly allows `cost: 0` (`cost < 0` is the only numeric rejection). A publisher who sets `x-zevium-cost: 0` — the natural way to say "this endpoint is free, do not bill" — gets a gateway cost of `1` credit per call. Consumers are charged against the publisher's stated intent. The `x-zevium-free-tier` extension exists for "first N calls free", but there is no documented way to make an endpoint permanently free other than `cost: 0`, which doesn't work.

Combined with P1-2, the cost contract is broken in **both** directions:
- `0` (intended free) → charged `1`
- `0.5` (intended 1, typo) → charged `0` (free)

The source of truth and the runtime disagree on three out of the four boundary cases.

**Impact:** Consumers billed for endpoints the publisher marked free. For a marketplace billing
itself on credit consumption, this is a direct revenue-correctness defect and a trust violation
against the published contract.

**Fix:** Decide one contract and enforce it everywhere:
- **Option A (recommended):** `cost` must be a positive integer ≥ 1; "free" is expressed via `x-zevium-free-tier` only. Validator rejects `cost < 1`. Extractor: `cost = costRaw >= 1 ? Math.floor(costRaw) : 1`.
- **Option B:** `cost: 0` means free. Extractor: `cost = costRaw !== undefined && costRaw >= 0 ? Math.floor(costRaw) : 1` (honor 0). Validator unchanged but reject non-integers (P1-2).

Either way, add a `validate.test.ts` case for `cost: 0` and `cost: 0.5` to lock the contract.

---

### P2-1 — `getPublishedForGateway` leaks `clerkOrgId` to unauthenticated callers

**Location:** `convex/specs.ts:303`

```ts
return {
  spec: latest.spec,
  ...
  clerkOrgId: org.clerkOrgId,   // ← Clerk's internal org identifier
  visibility: project.visibility,
  ...
};
```

**Problem:** `clerkOrgId` is Clerk's internal organization ID. It is not exposed by `catalogue.listPublic` or `catalogue.getPublicDetail` (those return `orgSlug`/`orgName`/`imageUrl` only). The gateway needs `clerkOrgId` for wallet-DO routing (`idFromName(clerkOrgId)`), so it must be in this payload — but the payload is returned to **any** unauthenticated caller, not just the gateway. Anyone who knows `orgSlug + projectSlug` harvests the clerkOrgId for every published project, public or **private** (per P1-1).

**Impact:** Internal identifier disclosure. Clerk org IDs are not secrets per se, but they are
a correlation surface for cross-system attacks (e.g., constructing Clerk API calls if any
key-leak path exists elsewhere). At minimum it's information the publisher did not consent to
expose for private projects.

**Fix:** Either (a) gate the whole query behind the gateway's key-verification path so only the
gateway can call it (move to `internalQuery` + call from a Worker-authenticated `httpAction`), or
(b) after fixing P1-1, restrict `clerkOrgId` to the gateway-only branch. Do not return
`clerkOrgId` on the public no-auth path.

---

### P2-2 — `undeprecateVersion` is silent: no notification, no webhook, no audit refId

**Location:** `convex/specs.ts:371-388`

```ts
export const undeprecateVersion = mutation({
  args: { versionId: v.id("specVersions") },
  handler: async (ctx, args): Promise<Doc<"specVersions">> => {
    const version = await ctx.db.get(args.versionId);
    if (version === null) throw new Error("Version not found");
    await requireProjectMember(ctx, version.projectId);
    await ctx.db.replace(args.versionId, {
      projectId: version.projectId,
      version: version.version,
      spec: version.spec,
      publishedAt: version.publishedAt,
    });
    const updated = await ctx.db.get(args.versionId);
    if (updated === null) throw new Error("Failed to load version");
    return updated;
  },
});
```

**Problem:** `deprecateVersion` fires `version_deprecated` notification (idempotent via
`refId: version_deprecated:${versionId}`) and a `spec.deprecated` webhook. `undeprecateVersion`
fires **neither**. A consumer who received the deprecation webhook and started migrating gets no
signal when the publisher reverses course. The gateway's `Deprecation`/`Sunset` headers silently
disappear. There is no audit trail that the un-deprecation happened — `replace` wipes
`deprecatedAt`/`sunsetAt`/`deprecationMessage` with no record they were ever set.

Worse: `replace` is used to "unset optional fields" (per the comment), but `replace` also rewrites
`spec` and `publishedAt` from the in-memory copy. If a concurrent `deprecateVersion` patches
`deprecationMessage` between the `get` and `replace` here, that message is lost. OCC retry would
re-fetch, but the race window exists.

**Impact:** Broken deprecation lifecycle for consumers. Webhook subscribers have inconsistent
state. No auditability for compliance-sensitive deprecation flows.

**Fix:** Fire `createNotification({ kind: "version_deprecated", ... refId: version_undeprecated:${versionId} })`
— or add a `version_undeprecated` kind — and `fireWebhookEvent(ctx, projectId, "spec.undeprecated", { projectId, version })`. Add a new notification kind to `schema.ts:notifications.kind` union.

---

### P2-3 — `projects.remove` orphans the `specEmbeddings` row

**Location:** `convex/projects.ts:202-216` vs `convex/dev.ts:72-79`

```ts
// projects.remove — deletes draft + versions, NOT embeddings
const versions = await ctx.db.query("specVersions")
  .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
  .collect();
for (const version of versions) await ctx.db.delete(version._id);
await ctx.db.delete(args.projectId);
// specEmbeddings row lingers forever
```

```ts
// dev.ts cleanup — KNOWS to delete embeddings
const embeddings = await ctx.db.query("specEmbeddings")
  .withIndex("by_project", (q) => q.eq("projectId", project._id))
  .collect();
for (const embedding of embeddings) await ctx.db.delete(embedding._id);
```

**Problem:** The cleanup script (`dev.ts`) deliberately deletes `specEmbeddings` rows for deleted
projects, but the production `projects.remove` mutation does not. After deletion, a vector row
remains pointing at a non-existent `projectId`. `search.ts:9-12` claims "fetchSearchListings
re-checks every project is PUBLIC + PUBLISHED before shaping a card — never leak private or draft
projects, even if a stale embedding lingers" — so it won't *leak*, but it will:
1. Bloat the vector index with dead vectors, degrading search recall and increasing vector-search
   latency for every catalogue query.
2. Waste a vector slot (768 floats × N dead rows) in perpetuity — there is no reaper.
3. Skew `by_project` lookups in `upsertEmbedding` which uses `.unique()` — if the project is
   later recreated with the same id (impossible in practice, but the index entry is still wrong).

**Impact:** Unbounded growth of dead vectors in the 768-dim vector index; slow search; no
self-healing.

**Fix:** In `projects.remove`, after deleting versions, delete the embedding row:
```ts
const embed = await ctx.db.query("specEmbeddings")
  .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
  .unique();
if (embed !== null) await ctx.db.delete(embed._id);
```

---

### P2-4 — `saveDraft` / `publish` impose no spec-size limit (DoS + cost)

**Location:** `convex/specs.ts:42-44` (`saveDraft` args), `convex/specs.ts:150-160` (`publish`)

```ts
export const saveDraft = mutation({
  args: { projectId: v.id("projects"), spec: v.string() },  // ← unbounded
  ...
});
```

**Problem:** `args.spec` is `v.string()` with no max length. A publisher can save a multi-megabyte
draft. Convex's per-document limit (~1 MB) will reject the insert at runtime, but the failure
surfaces as an opaque Convex error to the client (and the validation already ran `JSON.parse` on
the whole string first — parsing a 900 KB deeply-nested JSON inside a mutation burns function
budget). On `publish`, the draft is re-parsed by `validateOpenApiSpec` and then copied verbatim
into `specVersions.spec` — the same size concern applies, plus the spec is now immutable and
re-parsed by `catalogue.summarizePublishedPricing` on **every** catalogue listing (see P2-6).

There is no `MAX_SPEC_BYTES` constant anywhere. `projects.create` caps `description` at 2000 chars
and `name` at 120, but the spec body — the largest field by orders of magnitude — is uncapped.

**Impact:** A single publisher can store a ~1 MB spec that is then re-parsed on every catalogue
query (P2-6). With 100 such publishers, every `listPublic` call parses ~100 MB of JSON inside a
Convex query function. This is a DoS vector and a Convex-budget drain.

**Fix:** Add `MAX_SPEC_BYTES = 512 * 1024` (or similar) in `packages/shared/src/validate.ts`.
Check `specText.length` at the top of `collectOpenApiSpecIssues` and return an error issue. Also
guard in `saveDraft` before the first `JSON.parse` to fail fast.

---

### P2-5 — `validate.ts` has no SSRF blocklist on `servers[0].url`

**Location:** `packages/shared/src/validate.ts:82-98`

```ts
let url: URL | null = null;
try { url = new URL(first.url); } catch { url = null; }
if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
  issues.push({ level: "error", path: "$.servers[0].url", message: "servers[0].url must be an http(s) URL" });
}
```

**Problem:** The validator only checks the URL is `http:`/`https:`. It does not reject:
- `http://127.0.0.1`, `http://localhost`, `http://[::1]`
- `http://169.254.169.254/latest/meta-data/` (cloud metadata)
- `http://10.0.0.0/8`, `http://192.168.0.0/16`, `http://172.16.0.0/12` (RFC1918)
- `http://0.0.0.0`, `http://[::ffff:127.0.0.1]` (v4-mapped v6 bypass)

The gateway runs on Cloudflare Workers, which limits reachability to public internet (no route
to RFC1918 or link-local). But: (a) a publisher can still set the upstream to an attacker-controlled
public host that logs request shapes and exfiltrates the gateway's calling pattern; (b) if the
gateway is ever moved to a runtime with private-network access (a Worker-as-proxy, a container
migration, a dev-environment run), every published spec becomes an SSRF vector with no
application-level defense. The spec is immutable — fixing it requires a new publish.

**Impact:** Latent SSRF surface stored permanently in immutable published versions. Today
mitigated by CF Workers' network position; tomorrow it is not, and the specs are already published.

**Fix:** Add a `isPrivateHost(url)` check in `validate.ts` that rejects loopback, link-local,
RFC1918, and v4-mapped-v6 hosts. Resolve at validation time is not needed (DNS rebinding is a
runtime concern) but the static IP-range blocklist closes the obvious cases.

---

### P2-6 — `catalogue.listPublic` is an N+1 full-scan that re-parses every published spec per page load

**Location:** `convex/catalogue.ts:99-167`

```ts
const candidates = await ctx.db.query("projects")
  .withIndex("by_visibility_status", (q) => q.eq("visibility", "public").eq("status", "published"))
  .collect();                              // ← entire public+published table

for (const project of candidates) {
  ...
  const org = await ctx.db.get(project.organizationId);        // ← N reads
  const latest = await ctx.db.query("specVersions")
    .withIndex("by_project_published", (q) => q.eq("projectId", project._id))
    .order("desc").first();                                    // ← N index reads
  const pricing = latest === null ? null : summarizePublishedPricing(latest.spec);  // ← N full JSON.parse
  ...
}
```

**Problem:** Three nested N-queries per catalogue page load:
1. `.collect()` on all public+published projects (unbounded; `.take(1000)` is only used for the
   `total` stat, the candidate scan is `.collect()`).
2. `ctx.db.get(project.organizationId)` per project — N point reads. The org could be joined once
   via a `by_id` batch or denormalized into the project row.
3. `summarizePublishedPricing(latest.spec)` does `parseSpec(specJson)` → `JSON.parse` of the full
   spec body — **for every candidate, on every query, including paginated cursor advances that
   re-scan the same candidates**. With 500 published projects averaging 200 KB specs, that's
   ~100 MB of JSON parsing per catalogue page render, inside a Convex query (function-budget +
   latency blowup).

The pricing summary (`minCost`/`maxCost`/`endpointCount`/`hasFreeTier`) is **derived** from the
spec, which is immutable once published. There is no reason to recompute it on every read. It
should be materialized into the `specVersions` row (or a side table) at publish time.

**Impact:** Catalogue page latency scales O(N × spec_size). Convex query budget exhaustion at
moderate catalogue size. The `cheapest` and `maxCostCap` sort/filter paths make this worse —
every candidate must be parsed before filtering.

**Fix:** At `publish` time, compute `ListingPricingSummary` once and store it on the
`specVersions` row (add `pricingSummary: v.optional(...)` to the schema). `listPublic` then reads
the materialized field with no `JSON.parse`. Short of that, cache the parsed spec per query run
(it's already cached implicitly by `parseSpec` being called once per `summarizePublishedPricing`).
Also: batch org fetches, and consider a `by_project` index on a denormalized `latestVersionId`
field on `projects` to avoid the N `specVersions` lookups.

---

### P2-7 — No upper bound on `x-zevium-cost` (wallet drain / integer overflow)

**Location:** `packages/shared/src/validate.ts:155-167`

```ts
} else if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
  issues.push({ level: "error", ... "x-zevium-cost must be a number ≥ 0" });
}
```

**Problem:** `cost` accepts `1e300`, `Number.MAX_SAFE_INTEGER + 1`, `1e15`. A publisher (or a
compromised publisher account) can publish a spec with `x-zevium-cost: 1e15`. A consumer calling
that endpoint once is charged 1 quadrillion credits — instant wallet drain into deep negative
balance, and since the wallet ledger is signed (append-only), the reversal path is unclear. The
catalogue `summarizePublishedPricing` would report `maxCost: 1e15` which the UI would render as
`1e+15` or overflow.

`extractPricing` does `Math.floor(costRaw)` — for `1e300` this is `1e300`, a valid IEEE-754
double. The wallet DO presumably stores balance as a number; subtracting `1e300` from a small
balance yields `-1e300`, which poisons every downstream calculation (ledger, earnings splits,
payout rounding).

**Impact:** A single malicious or fat-fingered published endpoint can drain any consumer wallet
to negative infinity in one call. There is no `MAX_ENDPOINT_COST` constant.

**Fix:** Add an upper bound in the validator: `|| cost > 1_000_000` (or whatever the product cap
is). Reject with "x-zevium-cost must be a positive integer ≤ 1,000,000". Also cap
`x-zevium-free-tier` (P2-8).

---

### P2-8 — `x-zevium-free-tier` is entirely unvalidated

**Location:** `packages/shared/src/validate.ts` (no check), `packages/shared/src/openapi.ts:186-189`

```ts
// validate.ts — never mentions x-zevium-free-tier at all

// openapi.ts
const freeRaw = asNumber(op["x-zevium-free-tier"]);
const freeTier = freeRaw !== undefined && freeRaw > 0 ? Math.floor(freeRaw) : undefined;
```

**Problem:** The validator has a branch for `x-zevium-cost` but **zero** validation for
`x-zevium-free-tier`. A spec with `x-zevium-free-tier: "abc"` → `asNumber` returns `undefined`
→ silently treated as "no free tier". A spec with `x-zevium-free-tier: -100` →
`freeRaw > 0` is false → silently treated as "no free tier". A spec with
`x-zevium-free-tier: 1e15` → accepted, floored to `1e15`, stored, and the gateway grants
1 quadrillion free calls per key per day — effectively a permanent bypass of billing for that
endpoint. Combined with `x-zevium-cost: 0.5` (P1-2), a publisher can publish a fully-free endpoint
that the platform funds forever.

The `EndpointPricing.freeTier` doc says "Free calls per day — publisher-funded". The publisher is
on the hook for `freeTier × active_keys × days` credits. An unbounded value is an unbounded
publisher liability (and platform-abuse vector if the publisher's wallet is empty — who pays?).

**Impact:** Silent type coercion (string→ignored, negative→ignored), no integer check, no upper
bound. Free-tier abuse with no validator feedback.

**Fix:** In `validate.ts`, add a check mirroring the `cost` branch: `freeTier` must be a
non-negative integer ≤ some sensible cap (e.g., 1,000,000/day). Reject non-finite, negative,
fractional, or huge values with an error issue.

---

### P2-9 — No cap on path / operation count in `validate.ts` (DoS)

**Location:** `packages/shared/src/validate.ts:117-148`

```ts
for (const [pathKey, pathVal] of Object.entries(raw.paths)) {
  ...
  for (const [method, opVal] of Object.entries(pathVal)) {
    ...
  }
}
```

**Problem:** The validator iterates every path and every method with no upper bound. A spec with
100,000 path entries (or 1 path with 100,000 method keys) is fully iterated on every `saveDraft`
and every `publish`. The `matchOperation` path in the gateway does the same iteration on every
request (it's O(paths) per gateway call, first-match-wins). A publisher can store a spec that
makes their own gateway routing pathologically slow — and since the spec is immutable, the only
fix is a new publish.

There is also no validation that path keys are valid OpenAPI path templates (start with `/`,
contain `{param}` segments only in the allowed form). A path key of `""` or
`/users/{id` (unclosed brace) is accepted and silently never matches in `matchPathTemplate`.

**Impact:** Validator DoS on save/publish; gateway routing DoS for the lifetime of the published
version. Malformed path templates silently produce unroutable endpoints.

**Fix:** Cap `Object.keys(raw.paths).length` at e.g. 1000. Cap methods per pathItem at 8 (the
HTTP_METHODS set). Validate path keys start with `/` and that every `{...}` segment is a
well-formed param name.

---

### P2-10 — `parseSpec` has no depth / size guards (JSON billion-laughs-equivalent)

**Location:** `packages/shared/src/openapi.ts:60-118`

```ts
export function parseSpec(json: string): ParsedOpenApiSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;   // ← unbounded
  } catch (err) { ... }
  ...
  if (isRecord(raw.paths)) {
    for (const [pathKey, pathVal] of Object.entries(raw.paths)) {  // ← unbounded iteration
      ...
      for (const [method, opVal] of Object.entries(pathVal)) { ... }
    }
  }
  ...
  const components = isRecord(raw.components) ? (raw.components as Record<string, unknown>) : undefined;
  // ← components preserved verbatim, never validated, stored in specVersions.spec
}
```

**Problem:** JSON doesn't have XML-style billion-laughs entity expansion, but it has analogs:
- Deeply nested objects (`{"a":{"a":{"a":...}}}`) — V8's `JSON.parse` throws at ~256 depth, but
  the throw is caught and turned into a spec error only in `validate.ts`; in `parseSpec` (used by
  the gateway hot path and by `summarizePublishedPricing`) the throw propagates and is caught by
  the `try/catch` in `summarizePublishedPricing` returning `null` — silently hiding a malformed
  spec from the catalogue pricing chip.
- Huge duplicate keys / huge string values — `JSON.parse` handles them but allocates
  proportional memory. A 5 MB spec with a 5 MB `info.description` string is stored, parsed on
  every catalogue query, and shipped to the gateway on every `getPublishedForGateway` call.
- `components` is preserved verbatim and stored in `specVersions.spec` with no validation — a
  publisher can embed 500 KB of arbitrary `$ref` schemas that are never used by the gateway but
  inflate every spec read forever.

**Impact:** Memory/CPU DoS via stored specs. The spec is the source of truth and is re-read on
every gateway spec-source refresh and every catalogue listing.

**Fix:** Cap `json.length` before `JSON.parse` (P2-4). After parse, cap the number of top-level
keys and the recursive size of `components` (or strip `components` entirely if the gateway
mock-response path doesn't need it for this project's visibility). Add a max-depth check during
iteration.

---

### P2-11 — `publish` has no rate limit / per-project version-count cap (embedding cost abuse)

**Location:** `convex/specs.ts:89-186`

```ts
const versionId = await ctx.db.insert("specVersions", { ... });
await ctx.db.patch(args.projectId, { status: "published" });
...
await ctx.scheduler.runAfter(0, internal.search.embedProject, { projectId: args.projectId });
```

**Problem:** Every successful `publish` schedules `internal.search.embedProject`, which calls
Gemini's embedding API (`gemini-embedding-001`, 768 dims). There is no per-project or per-org rate
limit on publish. A publisher (or a compromised key) can publish `0.0.1`, `0.0.2`, ... `0.0.N` in
a loop, each triggering a Gemini API call and a vector-index upsert. This burns Gemini quota,
inflates Convex function budget, and pollutes the vector index with near-identical embeddings.

`listVersions` returns all versions with no pagination (P3-2), so the UI also degrades.

There is also no minimum-diff check between versions — a publisher can republish the identical
spec body under a new semver with zero changes.

**Impact:** Unbounded external API spend (Gemini) and vector-index bloat, triggerable by any org
member.

**Fix:** Add a per-project per-hour publish rate cap (e.g., 10/hour) enforced in `publish`.
Optionally reject publishes where the draft is byte-identical to the latest published spec's body
(unless explicitly forced).

---

### P2-12 — `saveDraft` / `publish` parse the spec twice (and `summarizePublishedPricing` parses a third time)

**Location:** `convex/specs.ts:46` + `convex/specs.ts:154` + `convex/catalogue.ts:62`

```ts
// saveDraft
const issues = validateOpenApiSpec(args.spec);          // parse #1

// publish
const issues = validateOpenApiSpec(draftRow.draft);      // parse #2

// catalogue.listPublic (per candidate, per query)
summarizePublishedPricing(latest.spec)                  // parse #3, ×N, ×page load
```

**Problem:** The same spec string is `JSON.parse`d at save time, again at publish time (the draft
was already validated on save), and again on every catalogue read. There is no cached parsed
representation. `validateOpenApiSpec` and `parseSpec` are two separate parsers with subtly
different acceptance rules (P3-9) — `validate.ts`'s `collectOpenApiSpecIssues` does its own
`JSON.parse` + `isRecord` walk, while `parseSpec` does a different `isRecord` walk and extracts
different fields. They can disagree on what's valid.

**Impact:** Wasted CPU on every publish and every catalogue query; parser-divergence bugs.

**Fix:** Unify on `parseSpec` as the single parser: have `collectOpenApiSpecIssues` call
`parseSpec` and run issue-collection on the `ParsedOpenApiSpec`. Materialize the
`ListingPricingSummary` at publish time (P2-6) so the catalogue never re-parses.

---

### P2-13 — `deprecateVersion` lets `sunsetAt` be in the past, zero, or negative

**Location:** `convex/specs.ts:336-340`

```ts
export const deprecateVersion = mutation({
  args: {
    versionId: v.id("specVersions"),
    sunsetAt: v.optional(v.number()),     // ← any number, including past/negative
    message: v.optional(v.string()),      // ← unbounded length
  },
  ...
});
```

**Problem:** `sunsetAt` is `v.optional(v.number())` with no range check. A publisher can set
`sunsetAt: 0` (epoch 1970) or `sunsetAt: -1` or `sunsetAt: Date.now() - 999999999`. The gateway
(`apps/gateway/src/pipeline.ts`) formats this into an HTTP `Sunset:` header — a negative or
zero epoch produces a malformed HTTP-date or a date in 1970. Browsers and HTTP clients that honor
`Sunset` will treat the version as already sunsetting, potentially breaking consumer retry logic.

`message` is unbounded — a publisher can store a multi-MB deprecation message that gets echoed
back in `getPublishedForGateway.deprecationMessage` on every gateway spec fetch and every
catalogue detail read.

**Impact:** Malformed HTTP headers; unbounded stored metadata on an immutable row.

**Fix:** Validate `sunsetAt > Date.now()` (must be future) and `sunsetAt < Date.now() + 10yr`.
Cap `message.length` at e.g. 2000 chars. Reject in the mutation handler before `patch`.

---

### P3-1 — `getVersion` existence oracle: throws "not found" before auth check

**Location:** `convex/specs.ts:243-252`

```ts
const row = await ctx.db.get(args.versionId);
if (row === null) {
  throw new Error("Spec version not found");     // ← leaks existence
}
await requireProjectMember(ctx, row.projectId);   // ← auth AFTER row fetch
```

**Problem:** The row is fetched and the "not found" error is thrown **before** any auth check. An
unauthenticated caller who guesses/enumerates a `versionId` learns whether it exists:
- Row doesn't exist → "Spec version not found"
- Row exists, not authenticated → "Not authenticated" (from `requireProjectMember`)

Convex `Id<"specVersions">` values are not secret (they're returned in `listVersions` to members),
but they are not meant to be enumerable. The ordering also means an unauthenticated caller gets a
different error for existing vs non-existing ids, a classic existence oracle.

**Impact:** Minor information leak; enables version-id enumeration if any id is leaked elsewhere.

**Fix:** Auth-first: call `requireIdentity(ctx)` (or a variant) before the row fetch, or use a
single uniform error ("Not authorized") for both not-found and not-member cases.

---

### P3-2 — `listVersions` is unbounded `.collect()` with no pagination

**Location:** `convex/specs.ts:202-221`

```ts
const rows = await ctx.db.query("specVersions")
  .withIndex("by_project_published", (q) => q.eq("projectId", args.projectId))
  .order("desc")
  .collect();                              // ← no limit/cursor
```

**Problem:** No pagination. A project with thousands of versions (feasible given P2-11) returns
all of them in one response. The return type only projects 6 fields, so the payload is bounded per
row, but the row count is unbounded.

**Impact:** UI latency + Convex budget for high-version-count projects.

**Fix:** Add `cursor`/`numItems` pagination matching the `@convex-dev/react-query` paginationOpts
convention used elsewhere in the codebase.

---

### P3-3 — `deprecateVersion` re-deprecation fires the webhook again (notification is idempotent, webhook is not)

**Location:** `convex/specs.ts:341-360`

```ts
await ctx.db.patch(args.versionId, {
  deprecatedAt: now,                        // ← overwrites previous deprecatedAt
  sunsetAt: args.sunsetAt,
  deprecationMessage: args.message,
});
await createNotification(ctx, {
  ...
  refId: `version_deprecated:${args.versionId}`,   // ← idempotent, deduped
});
await fireWebhookEvent(ctx, version.projectId, "spec.deprecated", { ... });  // ← NOT idempotent
```

**Problem:** Re-deprecating an already-deprecated version: `createNotification` dedupes via
`refId` (good), but `fireWebhookEvent` always inserts a new `webhookDeliveries` row and schedules
a delivery. A publisher toggling deprecation back-and-forth spams the webhook consumer with
duplicate `spec.deprecated` events for the same version.

Also: re-deprecation overwrites `deprecatedAt` with a new timestamp, losing the original
deprecation time — audit trail loss.

**Impact:** Webhook spam; lost original-deprecation-timestamp audit.

**Fix:** If `version.deprecatedAt !== undefined`, either no-op or use a different refId/event
(`spec.deprecation_updated`). Preserve the original `deprecatedAt` unless explicitly reset.

---

### P3-4 — `publish` return type leaks full `Doc<"specVersions">` and `Doc<"projects">`

**Location:** `convex/specs.ts:96-101`

```ts
): Promise<{
  ok: boolean;
  issues: SpecIssue[];
  version?: Doc<"specVersions">;     // ← includes full spec body, _creationTime
  project?: Doc<"projects">;          // ← includes organizationId, status, visibility, tags
}> {
```

**Problem:** The return type is the raw Convex doc, not a projected shape. `version` includes the
full `spec` string (which the caller already has — it's their draft) plus `_creationTime`.
`project` includes `organizationId` (which the caller, a member, already knows). The over-broad
shape isn't a leak (the caller is authorized), but it's a stable-API hazard: any schema field
added to `specVersions` or `projects` in the future automatically flows into the public mutation
return type with no review.

**Impact:** API surface bloat; future schema additions leak into the mutation contract.

**Fix:** Project the return to `{ version: { _id, version, publishedAt }, project: { _id, name, slug, status } }` or whatever the UI actually consumes.

---

### P3-5 — `saveDraft` echoes the input `draft` back on the error path

**Location:** `convex/specs.ts:56-60`

```ts
if (hasError) {
  return {
    ok: false,
    issues: effectiveIssues,
    draft: args.spec,        // ← echoes up to ~1 MB back to the client
    lastSavedAt: 0,
  };
}
```

**Problem:** On validation failure, the entire input spec string is echoed back in the response.
The client already has it (they just sent it). This doubles the bandwidth on every failed save
and bloats the Convex mutation response payload.

**Impact:** Wasted bandwidth; no functional issue.

**Fix:** Return `draft: undefined` (or omit) on the error path; the client retains its own input.

---

### P3-6 — `catalogue.listPublic` `total` is hard-capped at 1000

**Location:** `convex/catalogue.ts:118-122`

```ts
const totalDocs = await ctx.db.query("projects")
  .withIndex("by_visibility_status", (q) => q.eq("visibility", "public").eq("status", "published"))
  .take(1000);
const total = totalDocs.length;
```

**Problem:** The "APIs listed" stat on the landing page uses `total`. Once the catalogue exceeds
1000 public+published projects, the stat silently undercounts and never grows past 1000. The
comment acknowledges this but the fix is not present.

**Impact:** Stale/misleading marketplace stat at scale.

**Fix:** Maintain a counter doc (e.g., in a `metadata` table) updated on publish/visibility
flip, or use a `count` aggregate if Convex adds one. Short of that, document the cap in the UI.

---

### P3-7 — `catalogue.listPublic` cursor is a numeric offset, not a stable cursor

**Location:** `convex/catalogue.ts:152-156`

```ts
const offset = args.cursor !== undefined && args.cursor !== ""
  ? Number.parseInt(args.cursor, 10) : 0;
const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
...
const nextCursor = nextOffset < filtered.length ? String(nextOffset) : null;
```

**Problem:** The cursor is a raw integer offset into the in-memory filtered+sorted array. If a
project is published, unpublished, deprecated, or deleted between page advances, the offset shifts:
- Items shift left (a new item sorts before the cursor) → the next page skips what was the
  first item of the next page.
- Items shift right (an item before the cursor is removed) → the next page repeats an item.

The `sort: "newest"` path is especially vulnerable — every new publish inserts at offset 0.

Also: `Number.parseInt(args.cursor, 10)` with no validation beyond `Number.isFinite` — a cursor
of `"1e99999"` parses to `Infinity` (which `Number.isFinite` rejects, falling back to 0), and
`"-5"` falls back to 0 via `offset > 0`. Not exploitable, but fragile.

**Impact:** Pagination skew at moderate catalogue churn; duplicate/skipped cards.

**Fix:** Use a Convex `paginationOpts`-compatible cursor (the `@convex-dev/react-query`
convention), or use a `(publishedAt, _id)` compound cursor for `newest` and a stable rank for
other sorts.

---

### P3-8 — `saveDraft` first-save race can create duplicate `specs` rows

**Location:** `convex/specs.ts:61-75`

```ts
const existing = await ctx.db.query("specs")
  .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
  .unique();
if (existing === null) {
  await ctx.db.insert("specs", { projectId: args.projectId, draft: args.spec, lastSavedAt: now });
} else {
  await ctx.db.patch(existing._id, { draft: args.spec, lastSavedAt: now });
}
```

**Problem:** `projects.create` always inserts an empty `specs` row, so in normal operation
`existing` is non-null and the patch path runs. But: if the draft row is ever deleted (e.g., by a
future admin tool, or by `dev.ts`-style cleanup that doesn't re-create it), two concurrent
`saveDraft` calls both see `existing === null` and both insert. The `specs.by_project` index is
not unique-enforced (schema.ts:54). Subsequent `getDraft` uses `.unique()` which **throws** on
duplicate rows — the project becomes uneditable.

Convex's OCC retry would re-run the mutation, but the read-then-insert pattern doesn't conflict
on the same document (two new `specs` docs are distinct documents), so OCC does not save you here.

**Impact:** Project draft becomes uneditable if the draft row is lost and two saves race.

**Fix:** Either enforce uniqueness in application logic with a retry loop, or — since
`projects.create` guarantees the row exists — drop the `if (existing === null) insert` branch
entirely and always patch (throwing a clear error if the row is missing, indicating data
corruption that should be fixed upstream).

---

### P3-9 — `validate.ts` and `openapi.ts` have divergent parsers and HTTP-method sets

**Location:** `packages/shared/src/validate.ts:35-43` vs `packages/shared/src/openapi.ts:13-23`

```ts
// validate.ts
const HTTP_METHODS: Record<string, true> = {
  get: true, post: true, put: true, patch: true, delete: true, options: true, head: true, trace: true,
};

// openapi.ts — identical set, but a SEPARATE copy
const HTTP_METHODS: Record<string, true> = { ... same ... };
```

Two separate `isRecord` helpers, two separate `HTTP_METHODS` maps, two separate iteration patterns
over `raw.paths`. The validator accepts/rejects via its own walk; the gateway extractor walks via
`parseSpec`. They can diverge: e.g., `validate.ts` accepts a pathItem where a method key is
non-lowercase (`GET`) by lowercasing it (`const lower = method.toLowerCase()`) — but
`parseSpec` also lowercases, so they agree there. However, `validate.ts` does NOT check
`x-zevium-free-tier` (P2-8) while `extractPricing` reads it — so a spec can pass validation with
a malformed `free-tier` that the gateway silently misinterprets.

Also, `validate.ts`'s `cost` type check is `typeof cost !== "number"` — it rejects string
numbers like `"5"`. But `extractPricing` uses `asNumber` which **accepts** string numbers. So a
spec loaded directly (bypassing the validator, e.g., via a seed script or a future import path)
would have `x-zevium-cost: "5"` honored by the gateway but rejected by the validator. Two
contracts for the same field.

**Impact:** Validator/extractor drift; false confidence that "validated = gateway will honor".

**Fix:** Have `collectOpenApiSpecIssues` call `parseSpec` once and run checks on the parsed
shape. Share one `HTTP_METHODS` and one `isRecord` from a common module.

---

### P3-10 — `getVersion` does not return deprecation metadata (inconsistent with `listVersions`)

**Location:** `convex/specs.ts:243-256`

```ts
return {
  version: row.version,
  spec: row.spec,
  publishedAt: row.publishedAt,
  // ← no deprecatedAt, sunsetAt, deprecationMessage
};
```

**Problem:** `listVersions` returns `deprecatedAt`/`sunsetAt`/`deprecationMessage` for each
version. `getVersion` (which fetches a single version by id) does not. A UI rendering a specific
version's detail page cannot show whether that version is deprecated without a separate
`listVersions` call. The fields exist on the row; they're just not projected.

**Impact:** UX inconsistency; extra query for the UI.

**Fix:** Add the three fields to `getVersion`'s return shape.

---

### P3-11 — `projects.remove` fires no webhook or notification

**Location:** `convex/projects.ts:202-216`

**Problem:** Project deletion deletes the draft, all `specVersions`, and the project row, but
fires no `project.deleted` webhook and no notification. Consumers who have integrated against the
project's published versions get no signal — their calls start returning `404 project_not_found`
from the gateway with no prior warning. Compare: `deprecateVersion` fires both a notification and
a webhook for a softer lifecycle event.

`projects.update` also fires nothing when `visibility` changes from public to private — a
consumer-visible access revocation with no signal.

**Impact:** Silent breaking-change for consumers; no audit trail for deletion.

**Fix:** Fire `project.deleted` and (for visibility flips) `project.visibility_changed` webhooks +
notifications. This requires adding notification kinds to the `schema.ts` union.

---

### P3-12 — `joinUpstreamUrl` edge-case replace logic is convoluted and undertested

**Location:** `packages/shared/src/openapi.ts:225-240`

```ts
u.pathname = `${prefix}${path === "/" ? "" : path}` || "/";
return u.toString()
  .replace(/\/$/, path === "/" && prefix === "" ? "/" : "");
```

**Problem:** The trailing-slash normalization via `.replace(/\/$/, condition ? "/" : "")` is
hard to reason about. Tracing `base = "https://api.example.com"`, `requestPath = "/users"`:
- `prefix = ""`, `path = "/users"`, `u.pathname = "/users"`, `u.toString()` =
  `"https://api.example.com/users"`, no trailing slash, replace is a no-op. OK.

Tracing `base = "https://api.example.com"`, `requestPath = "/"`:
- `prefix = ""`, `path = "/"`, `u.pathname = "" + "" = ""` → falsy → `|| "/"` → `"/"`,
  `u.toString()` = `"https://api.example.com/"`, `.replace(/\/$/, "/")` = same. OK.

But `base = "https://api.example.com/v1/"`, `requestPath = "/users"`:
- `base.replace(/\/+$/, "")` = `"https://api.example.com/v1"`, `prefix = "/v1"`,
  `u.pathname = "/v1/users"`, fine.

`base = "api.example.com"` (no protocol):
- `new URL("https://api.example.com")` — works, but the original spec said `http://api.example.com`
  would also be valid. The validator accepts it; `joinUpstreamUrl` silently upgrades to https for
  pathname-joining purposes but the final `toString()` is `https://...` which the gateway then
  fetches via `fetch()` — so `http://api.example.com` upstream becomes `https://api.example.com`
  upstream. **Silent protocol upgrade** that may break upstreams that only serve HTTP.

Also the `catch` branch returns `${base}${path === "/" ? "" : path}` — for `base = "api.example.com"`
this yields `api.example.com/users` (no protocol), which `fetch()` would reject or interpret as a
relative URL.

**Impact:** Edge-case upstream URL corruption; silent http→https upgrade for non-absolute bases.

**Fix:** Simplify: always require an absolute `https://` base (the validator already enforces
http(s)); drop the no-protocol fallback. Use `URL` construction consistently and test the
trailing-slash matrix explicitly.

---

### P3-13 — `publish` does not validate `version` against the spec's `info.version`

**Location:** `convex/specs.ts:104-116`

```ts
const version = args.version.trim();
if (!isValidSemver(version)) { ... }
// draftRow.draft is never inspected for info.version
```

**Problem:** The `version` argument is validated as semver and checked for collision, but it's
never compared to the OpenAPI document's `info.version` field. A publisher can publish version
`1.2.3` while the spec body's `info.version` is `0.0.1`. The two are decoupled, creating
ambiguity about which is the "real" version. The gateway returns `version` (the
`specVersions.version` field) to consumers, but the spec body itself advertises a different
`info.version` — any consumer introspecting the spec body sees the wrong version.

**Impact:** Version-contract ambiguity; consumer confusion.

**Fix:** Either require `args.version === parsed.info.version` at publish time, or document that
`specVersions.version` is the canonical version and `info.version` is advisory. If the former,
add the check after `validateOpenApiSpec`.

---

### P3-14 — `deprecateVersion` / `undeprecateVersion` return the raw doc but `publish` returns a wrapped doc

**Location:** `convex/specs.ts:333` vs `convex/specs.ts:96-101`

```ts
// deprecateVersion / undeprecateVersion
handler: async (ctx, args): Promise<Doc<"specVersions">> => { ... return updated; }

// publish
handler: async (ctx, args): Promise<{ ok: boolean; issues: SpecIssue[]; version?: Doc<"specVersions">; ... }> => { ... }
```

**Problem:** Inconsistent return contracts: `publish` wraps in `{ok, issues, version, project}`,
while `deprecateVersion`/`undeprecateVersion` return the bare `Doc`. `saveDraft` returns a third
shape `{ok, issues, draft, lastSavedAt}`. There's no shared contract for "mutation result with
issues". A client must handle three different shapes for three mutations on the same table.

**Impact:** Client-side boilerplate; inconsistent error handling.

**Fix:** Pick one envelope (`{ ok, issues, data }` or bare-doc-throws-on-error) and apply it
consistently across `saveDraft`, `publish`, `deprecateVersion`, `undeprecateVersion`.

---

### P3-15 — Schema comment lies: `specEmbeddings` says "Gemini text-embedding-004" but the code uses `gemini-embedding-001`

**Location:** `convex/schema.ts:171`

```ts
// Catalogue semantic search (embedded on publish; Gemini text-embedding-004)
specEmbeddings: defineTable({ ... })
```

vs `convex/search.ts:4`:

```ts
// Embeddings: Gemini gemini-embedding-001 pinned to 768 dims
```

**Problem:** The schema comment references the dead `text-embedding-004` model (per the memory
note: "text-embedding-004 is DEAD — HTTP 404"). The actual code uses `gemini-embedding-001`. The
schema comment is stale and would mislead a future maintainer into thinking the embedding model
is `text-embedding-004`.

**Impact:** Stale documentation; future debugging confusion.

**Fix:** Update the schema comment to `gemini-embedding-001 (768 dims)`.

---

### P3-16 — `extractPricing` silently coerces string costs via `asNumber` (validator rejects them)

**Location:** `packages/shared/src/openapi.ts:179` + `packages/shared/src/openapi.ts:28-34`

```ts
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
```

**Problem:** `asNumber` accepts `x-zevium-cost: "5"` (string). The validator rejects it
(`typeof cost !== "number"`). So a spec that goes through `publish` can never have a string cost
(it's blocked). But `extractPricing` is also called by `summarizePublishedPricing` on stored specs
— if a spec ever enters `specVersions.spec` through a non-`publish` path (seed script, dev import,
future migration, manual DB edit), string costs are silently honored as numbers. Two contracts for
the same field depending on entry path.

**Impact:** Latent inconsistency; confusion about the cost type contract.

**Fix:** Either have the validator accept string-numbers (matching `asNumber`), or have
`extractPricing` reject non-number costs (matching the validator). Pick one.

---

## Summary

| Severity | Count | Highlights |
|---|---|---|
| **P0** | 0 | — |
| **P1** | 3 | Private-spec leak via `getPublishedForGateway` (no visibility gate); fractional `x-zevium-cost` floored to 0 (free calls); explicit `cost: 0` silently rewritten to 1. |
| **P2** | 13 | `clerkOrgId` public leak; silent `undeprecateVersion`; orphaned `specEmbeddings`; no spec-size cap; SSRF on `servers[0].url`; N+1 full-scan catalogue with per-candidate `JSON.parse`; unbounded `x-zevium-cost`; unvalidated `x-zevium-free-tier`; no path-count cap; `parseSpec` depth/size guards; publish rate-limit / embedding-cost abuse; double/triple parse; `sunsetAt` past/negative. |
| **P3** | 16 | `getVersion` existence oracle; `listVersions` unbounded; re-deprecation webhook spam; over-broad `publish` return; `saveDraft` echo; `total` cap at 1000; unstable offset cursor; `saveDraft` duplicate-row race; validator/extractor parser divergence; `getVersion` missing deprecation fields; `projects.remove` no webhook; `joinUpstreamUrl` edge cases + silent http→https; `version` vs `info.version` decoupled; inconsistent mutation return envelopes; stale `text-embedding-004` schema comment; string-cost type divergence. |

**Total: 32 findings** (prior review: 13). The prior review's 2 P1 are confirmed and a third P1
(the `cost: 0 → 1` rewrite, the inverse of the fractional-cost P1) is added. The P2 tier
expanded from 4 to 13 — the prior review missed the entire "no bounds on the pricing source of
truth" class (cost upper limit, free-tier validation, spec size, path count, SSRF) and the
catalogue hot-path re-parse problem. The P3 tier expanded from 7 to 16 by auditing the
lifecycle/audit/return-contract surface.

**Top 3 to fix first:**
1. **P1-1** — Gate `getPublishedForGateway` on `visibility === "public"` (or key-verified org
   match). One-line fix, closes a cross-tenant spec leak.
2. **P1-2 + P1-3** — Tighten `validate.ts` to require `x-zevium-cost` be a positive integer ≥ 1
   (or honor 0 as free consistently). Single validator change closes both pricing-integrity
   defects at the source of truth.
3. **P2-6** — Materialize `ListingPricingSummary` onto `specVersions` at publish time. Eliminates
   the per-candidate `JSON.parse` on every catalogue query and unblocks catalogue scaling past
   ~100 projects.
