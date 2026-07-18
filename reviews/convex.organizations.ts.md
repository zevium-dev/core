# Tiger-Style Review — `convex/organizations.ts`

## Verdict
NEEDS WORK — no P0, but four P1 defects strike the file's core contract: orgs are the ownership/billing boundary, Clerk is the auth source of truth, and the mirror must never drift. `deleteFromClerk` orphans nearly every org-owned table (projects, payments, publisherEarnings, keySettings, usageEvents, notifications, checkoutIntents, organizationPayments, publisherTransfers, …) and silently destroys the credit ledger; `ensureOrganization` trusts client-supplied `name`/`slug`/`imageUrl` without validating them against the JWT `org_slug` claim, breaking the "Clerk is source of truth" invariant; both write paths race on first-call and brick the org with duplicate `clerkOrgId` rows (`.unique()` then throws on every subsequent read); and `getBySlug` is an unauthenticated public query that leaks the full org document — including Clerk's internal `clerkOrgId` — to anyone who can guess a slug. Seven P2 follow-ons (rename race, unbounded delete loop, no slug validation, orphaned keySettings/notifications, ignored org role, ledger destruction, wallet-`unique` throw propagation) and three P3 nits round it out.

## File Stats
- **Path:** `convex/organizations.ts`
- **LOC:** 167
- **Role:** Mirrors Clerk organizations into Convex. Org is the ownership and billing boundary — wallet, projects, keys, usage, payments, publisher earnings, and notifications are all org-scoped. `upsertFromClerk`/`deleteFromClerk` are the Clerk-webhook-driven sync primitives; `ensureOrganization` is the web-app-driven mirror-on-boot; `getBySlug`/`listMine` are read helpers. Every downstream table hangs off `organizationId` or `clerkOrgId` resolved here, so correctness in this file is load-bearing for the entire billing/ownership model.

## Findings

---

### [SEV: P1] `deleteFromClerk` does not cascade — orphans projects, payments, publisherEarnings, keySettings, usageEvents, notifications, and seven more tables
**Location:** `convex/organizations.ts:88-116` (`deleteFromClerk`); compare `convex/projects.ts:201-224` (`deleteProject` cascade) and `convex/dev.ts:58-100` (reference cascade).

```ts
if (wallet !== null) {
  const entries = await ctx.db.query("walletEntries")
    .withIndex("by_wallet", (q) => q.eq("walletId", wallet._id)).collect();
  for (const entry of entries) { await ctx.db.delete(entry._id); }
  await ctx.db.delete(wallet._id);
}
await ctx.db.delete(existing._id);
```

**Problem:** On `organization.deleted`, the handler deletes only `wallets`, `walletEntries`, and the `organizations` row. It leaves every other org-owned table fully populated but pointing at a non-existent org. The schema (`convex/schema.ts`) shows the orphaned references:

| Table | FK field | Orphaned? |
|---|---|---|
| `projects` | `organizationId` | yes |
| `specs`, `specVersions`, `specEmbeddings` | via `projects.organizationId` | yes (transitively) |
| `webhookEndpoints`, `webhookDeliveries` | via `projects` | yes |
| `usageEvents` | `organizationId` | yes |
| `payments` | `organizationId` | yes |
| `publisherEarnings` | `publisherOrganizationId` | yes |
| `publisherTransfers` | `publisherOrganizationId` | yes |
| `organizationPayments` | `organizationId` | yes |
| `checkoutIntents` | `organizationId` | yes |
| `keySettings` | `clerkOrgId` | yes |
| `notifications` | `clerkOrgId` | yes |
| `connectedPayouts` | via `stripeConnectedAccountId` | yes |

**Impact:** Three concrete consequences. (1) **Access breaks**: `requireProjectMember` (`convex/lib/auth.ts`) does `ctx.db.get(project.organizationId)` → returns `null` → throws `"Organization not found"`. Every project, spec, webhook, and key-setting endpoint for the deleted org is now permanently inaccessible to its publishers — they cannot view, edit, or export their orphaned data, and there is no path to reattach it. (2) **Billing/financial orphans**: `payments`, `publisherEarnings`, `publisherTransfers`, and `connectedPayouts` rows remain referencing a deleted org. Any join/aggregation by `organizationId` returns null org metadata; financial reconciliation and payout reporting are severed from the org identity. (3) **Gateway leak**: `keySettings` (keyed by `clerkOrgId`) survives deletion, so `getGatewayWallet` (`convex/wallets.ts`) still returns active monthly caps / `disabled` flags / rotation-grace windows for a non-existent `clerkOrgId` — the edge honors key gates for a deleted org (cross-referenced as P2 #11 in `reviews/convex.wallets.ts.md`). `deleteProject` cascades specs/versions/embeddings/webhooks carefully; `deleteFromClerk` does none of that for the org's projects. This is the org-level referential-integrity bug the file exists to prevent.

**Fix:** Cascade through the org's owned tables before deleting the org row — at minimum: query `projects` by `by_org`, call the existing project-cascade logic for each (or inline it); delete `usageEvents` (`by_org`), `payments` (`by_organization`), `publisherEarnings` (`by_publisher`), `publisherTransfers` (`by_publisher`), `organizationPayments` (`by_organization`), `checkoutIntents` (`by_organization`), `keySettings` (`by_org` on `clerkOrgId`), `notifications` (`by_org` on `clerkOrgId`). For financial records, prefer a soft-delete (`deletedAt` sentinel, retain for compliance) over hard delete. If hard-delete is required, batch the per-row deletes (see P2 #6) to avoid mutation timeouts.

---

### [SEV: P1] `ensureOrganization` trusts client-supplied `name`, `slug`, and `imageUrl` — mirror drift, slug-collision DoS, and a direct violation of the "never trust client identifiers" contract
**Location:** `convex/organizations.ts:123-167` (args `124-129`, insert `141-148`, patch `156-160`); contract violated: `convex/lib/auth.ts:13-47` (`requireIdentity` already exposes `claims.orgSlug`).

```ts
export const ensureOrganization = mutation({
  args: {
    clerkOrgId: v.string(),
    name: v.string(),
    slug: v.string(),
    imageUrl: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Doc<"organizations">> => {
    const claims = await requireIdentity(ctx);
    if (claims.orgId === undefined || claims.orgId !== args.clerkOrgId) {
      throw new Error("Organization does not match authenticated identity");
    }
    // …insert/patch args.name / args.slug / args.imageUrl verbatim…
```

**Problem:** Only `args.clerkOrgId` is validated against the JWT (`claims.orgId`). `args.name`, `args.slug`, and `args.imageUrl` are taken verbatim from the client and written to the mirror. The JWT already carries the authoritative `org_slug` (and Clerk carries `name`/`image_url` server-side via `upsertFromClerk`), so there is no reason to accept these from the client at all. The file's own docstring (`convex/organizations.ts:118-122`) claims "clients cannot invent orgs for other tenants" — true for the *identity* of the org, but false for its *content*: any org member can set `slug` to an empty string, garbage, or **another org's slug**, and `name`/`imageUrl` to anything. This directly violates the project contract: *"Never trust client-provided identifiers when auth context (ctx.auth) supplies them."*

**Impact:** Three failure modes. (1) **Mirror drift**: the Convex mirror diverges from Clerk (the declared source of truth). `requireOrgMemberBySlug` (`convex/lib/auth.ts:43-62`) resolves the org by the DB slug, then checks `org.clerkOrgId !== claims.orgId`. If a member drifts the slug to `"haha"`, every other member's JWT still carries the real `org_slug`, so `getOrgBySlug(realSlug)` returns null → `requireOrgMemberBySlug` throws `"Organization not found"` for the entire org — every project/key/spec mutation is blocked until an admin manually fixes the DB or Clerk pushes a rename webhook. (2) **Slug-collision DoS**: a member sets their org's `slug` to victim org B's slug. `by_slug` is a non-unique index (schema `convex/schema.ts:13`), so two rows now share it; `getBySlug` and `getOrgBySlug` call `.unique()` which throws `NonUniqueResponseError` — victim org B's members can no longer resolve their org by slug. (3) **Stored-URL injection**: `imageUrl` is an arbitrary client-supplied string stored and (presumably) rendered to other members — a tracking pixel or malicious URL.

**Fix:** Derive `name`/`slug`/`imageUrl` from the JWT claims (or omit them and rely solely on the Clerk webhook `upsertFromClerk` to populate mirror content). At minimum, reject the mutation unless `args.slug === claims.orgSlug` (when `claims.orgSlug` is present):
```ts
if (claims.orgSlug !== undefined && args.slug !== claims.orgSlug) {
  throw new Error("Slug does not match authenticated identity");
}
```
Better: drop `name`/`slug`/`imageUrl` from the public-mutation args entirely and let `ensureOrganization` only ensure-exists (insert with slug from `claims.orgSlug`, name/imageUrl from `claims` or `undefined`); let the Clerk webhook own content updates.

---

### [SEV: P1] `ensureOrganization` and `upsertFromClerk` insert-path race creates duplicate `clerkOrgId` rows — `.unique()` then throws on every read, permanently bricking the org
**Location:** `convex/organizations.ts:67-75` (`upsertFromClerk` insert), `141-148` (`ensureOrganization` insert); schema index `by_clerk_org` (`convex/schema.ts:13`) is not a unique constraint.

```ts
const existing = await ctx.db
  .query("organizations")
  .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
  .unique();
if (existing === null) {
  const organizationId = await ctx.db.insert("organizations", {
    clerkOrgId: args.clerkOrgId, name: args.name, slug: args.slug, imageUrl: args.imageUrl,
  });
  await ensureWallet(ctx, organizationId);
  return organizationId;
}
```

**Problem:** Read-then-insert is not atomic against a concurrent inserter. Convex indexes are **not unique constraints** — `.unique()` is a read helper that throws if >1 row matches, but it does not prevent two transactions from both observing zero rows and both inserting. OCC does not save this case: each transaction's read-set contains no overlapping document, and the two inserts target different document ids, so there is no write-write conflict to trigger a retry. Both commit. This is the exact same race the wallets reviewer flagged as P0 in `reviews/convex.wallets.ts.md` (finding #1), now at the org layer — and it is worse here because the org row is the root of the ownership tree.

Realistic concurrent callers for a brand-new Clerk org:
- Clerk `organization.created` webhook → `upsertFromClerk`, racing with the first member's `ensureOrganization` from `useEnsureMirror` (`apps/web/src/hooks/use-ensure-mirror.ts:42`) or `ensureMirrorOnServer` (`apps/web/src/lib/ensure-mirror.ts:108`).
- Two members of a freshly-created org loading `/app` simultaneously — `useEnsureMirror` fires for both.
- Svix retry of `organization.created` racing the original delivery.

**Impact:** Once two `organizations` rows share a `clerkOrgId`, every downstream `.unique()` read throws `NonUniqueResponseError`: `listMine` (line 46-49), `getBySlug` (32-35), `getOrgBySlug` (`lib/auth.ts:30-40`), `requireOrgMemberBySlug`, `ensureOrganization`'s own read on the next call, `ensureWallet` (15-18), and `deleteFromClerk`'s read (91-94). The entire org — for every member — is bricked: no project access, no wallet ops, no key settings, no mirror recovery. `deleteFromClerk` cannot even clean it up because its first read throws. Manual DB surgery is the only recovery. The wallet-insert call inside the same race also creates duplicate `wallets` rows (compounding `reviews/convex.wallets.ts.md` P0 #1).

**Fix:** Make the insert path idempotent under concurrency. Options: (a) insert unconditionally, then on conflict (or always) query `by_clerk_org` and delete/reconcile duplicates in the same transaction; (b) move org+wallet creation to a single authoritative `internalMutation` called only from the Clerk webhook (`upsertFromClerk`), and make `ensureOrganization` a pure get-or-throw that does not insert (the webhook is the source of truth). If a public ensure-must-create path is required, insert and then re-read `by_clerk_org` `.unique()` — if it throws (duplicate), delete the loser by `_creationTime` and return the survivor. The cleanest fix is (b): the web app should only ensure the row exists, and only the Clerk webhook should create it.

---

### [SEV: P1] `getBySlug` is an unauthenticated public query that returns the full org document including Clerk's internal `clerkOrgId`
**Location:** `convex/organizations.ts:29-37`; contrast `requireOrgMemberBySlug` (`convex/lib/auth.ts:43-62`) which enforces membership for the same lookup.

```ts
export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args): Promise<Doc<"organizations"> | null> => {
    return await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
  },
});
```

**Problem:** No `requireIdentity`, no membership check. Any anonymous caller — no Clerk session required — can resolve any org's full `Doc<"organizations">` by guessing or enumerating slugs. The returned document includes `clerkOrgId` (Clerk's internal organization identifier), `name`, `slug`, and `imageUrl`. Slugs are low-entropy and enumerable (dictionary words, company names). This is inconsistent with `requireOrgMemberBySlug`, which carefully verifies `org.clerkOrgId === claims.orgId` before returning the same document — so the file has a membership-gated path and a fully-open path to the same data.

**Impact:** (1) Anonymous enumeration of every org on the platform — name, slug, image, and Clerk internal id. (2) `clerkOrgId` is an internal identifier leaked to unauthenticated callers; while not a credential, it is the join key for `keySettings`, `notifications`, and gateway-keyed state, and disclosing it expands the attack surface for any future endpoint that trusts a client-supplied `clerkOrgId`. (3) It enables the slug-collision DoS in P1 #2 — an attacker can probe `getBySlug` for a victim's slug, then set their own org's slug to match, confident the collision will throw. The project contract explicitly forbids leaking internal state ("Never leak internal errors"); leaking internal identifiers is a stricter violation.

**Fix:** Gate `getBySlug` behind `requireIdentity` and `requireOrgMemberBySlug` semantics — return only the org the caller's JWT `org_id` claim matches, or `null`/throw otherwise. If a public org-directory is a product requirement, expose a separate `listPublicOrgs` query returning only `{ name, slug, imageUrl }` (never `clerkOrgId`), behind pagination and rate-limiting. As written, `getBySlug` should not exist as a public query returning `Doc<"organizations">`.

---

### [SEV: P2] `upsertFromClerk` (rename) races with stale client `ensureOrganization` — last-write-wins reverts the correct slug
**Location:** `convex/organizations.ts:78-82` (`upsertFromClerk` patch) vs `156-160` (`ensureOrganization` patch); client source `apps/web/src/hooks/use-ensure-mirror.ts:42-50` and `apps/web/src/lib/ensure-mirror.ts:108-112`.

**Problem:** Both the Clerk webhook (`organization.updated` → `upsertFromClerk`) and the web app (`ensureOrganization` with `organization.slug` from the client's cached Clerk `useOrganization()` object) write `slug` to the same row with no versioning and no claim-based guard. When an admin renames an org's slug in Clerk, the webhook fires `upsertFromClerk` with the new slug, but a member's browser still holds the *old* `organization` object (Clerk's `useOrganization` hasn't refreshed yet). The member's `ensureOrganization` runs with the stale slug and overwrites the webhook's correct update — last-write-wins reverts the rename. The mirror now disagrees with Clerk until the next webhook or a manual fix.

**Impact:** Mirror drift after any org slug change. `requireOrgMemberBySlug` and `getBySlug` resolve the stale slug; members whose JWT has refreshed to the new `org_slug` can no longer find their org by slug → `"Organization not found"`. The drift is self-healing only if another `organization.updated` webhook fires, which may not happen. This compounds P1 #2 (client controls slug content) — here even a *non-malicious* client corrupts the mirror.

**Fix:** Stop having the public mutation write `slug`/`name`/`imageUrl` (see P1 #2 fix). Make the Clerk webhook the sole writer of org content; `ensureOrganization` should only ensure-exists and never patch content fields. If both writers must coexist, version the row (`updatedAt` / Clerk `updated_at`) and reject stale patches.

---

### [SEV: P2] `deleteFromClerk` does an unbounded `.collect()` + per-entry sequential delete loop — large orgs time out and brick the webhook
**Location:** `convex/organizations.ts:103-112`.

```ts
if (wallet !== null) {
  const entries = await ctx.db.query("walletEntries")
    .withIndex("by_wallet", (q) => q.eq("walletId", wallet._id)).collect();
  for (const entry of entries) { await ctx.db.delete(entry._id); }
  await ctx.db.delete(wallet._id);
}
```

**Problem:** `.collect()` materializes every `walletEntries` row for the org into memory, then deletes them one at a time in a sequential `await` loop. For a long-lived org with 10⁵–10⁶ ledger entries (usage settlements are append-only and one-row-per-call), this exceeds Convex's mutation wall-clock/time limits — the mutation aborts. Svix retries the webhook; the same mutation times out again; retry exhaustion drops the delete event. The org row is never removed, the wallet is never removed, and the entries keep accumulating. The same unbounded-loop pattern recurs for every cascade table that P1 #1 says is missing (projects, usageEvents, payments, publisherEarnings, …) — adding the cascade without batching will make the timeout worse.

**Impact:** Org deletion silently fails for any org with a substantial ledger; webhook retries livelock; operator must manually intervene. The mutation is atomic (no partial delete), so the org is left in its pre-delete state, but the deletion the admin requested in Clerk never propagates.

**Fix:** Batch deletes — Convex supports paginated iteration via `.paginate({ cursor, numItems })`; delete in chunks of a few hundred per mutation and schedule the next chunk via `scheduler.runAfter(0, internal.organizations.deleteFromClerkBatch, …)` until empty, then delete the wallet and org. Or, if hard-delete is not required, soft-delete the org (`deletedAt`) and let a background job reclaim children in batches. Do not add the missing cascade (P1 #1) without solving this first.

---

### [SEV: P2] No slug validation anywhere — empty string, whitespace, oversized, and colliding slugs accepted; `by_slug` is not a unique constraint
**Location:** `convex/organizations.ts:124-128` (args), `29-37` (`getBySlug`), `78-82` and `156-160` (writes); schema `by_slug` index (`convex/schema.ts:13`).

**Problem:** `slug: v.string()` accepts any string — `""`, `" "`, `"\t"`, a 10KB slug, a slug containing `/` or `..`, or a slug identical to another org's. There is no format validator and no uniqueness enforcement (Convex indexes are not unique constraints; `.unique()` only throws *after* a duplicate exists). `getBySlug` and `getOrgBySlug` call `.unique()`, so any collision throws `NonUniqueResponseError` for both orgs. Because `ensureOrganization` accepts client-supplied slugs (P1 #2), a member can deliberately collide with a victim org. Empty/whitespace slugs are also indexed and queryable, polluting `by_slug`.

**Impact:** Deliberate or accidental slug collision bricks `getBySlug` and `requireOrgMemberBySlug` for every org sharing the slug (`.unique()` throws). Empty/oversized slugs pollute the index and can break downstream URL routing that embeds the slug. This is the cheap-DoS amplifier for P1 #2.

**Fix:** Validate slug format at the validator layer (`v.string()` → a regex-checked `v.string()` via a custom validator, e.g. `/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/`, reject empty/whitespace). For uniqueness, since Convex can't enforce it at the index, either (a) make `ensureOrganization` reject a slug that already exists for a different `clerkOrgId` (query `by_slug` first), or (b) stop accepting client slugs entirely (P1 #2 fix) and trust Clerk's slug uniqueness from the webhook.

---

### [SEV: P2] `deleteFromClerk` does not delete `keySettings` or `notifications` (both keyed by `clerkOrgId`) — orphans persist and the gateway still serves them
**Location:** `convex/organizations.ts:88-116`; schema `keySettings.by_org` (`clerkOrgId`) and `notifications.by_org` (`clerkOrgId`).

**Problem:** Both `keySettings` and `notifications` are keyed by `clerkOrgId` (not `organizationId`), so the wallet-deletion block (which keys off `existing._id`) does not touch them, and there is no separate cleanup. After `deleteFromClerk`, `keySettings` rows for the deleted `clerkOrgId` remain active (`disabled`, `monthlyCapCredits`, `graceUntil`), and `notifications` rows remain unread. The gateway's `getGatewayWallet` (`convex/wallets.ts`, P2 #11 in the wallets review) queries `keySettings` by `clerkOrgId` and returns them regardless of whether the org exists — so the edge continues to honor key caps and disabled flags for a deleted org.

**Impact:** Stale key gates honored for a deleted org; if Clerk ever recycles a `clerkOrgId` (unlikely but possible across instances), a recreated org would inherit the deleted org's key caps. Notifications for the deleted org linger in the database with no consumer. This is the `clerkOrgId`-keyed half of P1 #1's cascade gap.

**Fix:** In `deleteFromClerk`, after resolving `existing`, also delete `keySettings` (`.withIndex("by_org", q => q.eq("clerkOrgId", args.clerkOrgId))`) and `notifications` (`.withIndex("by_org", q => q.eq("clerkOrgId", args.clerkOrgId))`) — batched per P2 #6. Document the retention policy if financial/admin notifications must be retained.

---

### [SEV: P2] `ensureOrganization` ignores `claims.orgRole` — any non-admin member can drift the mirror
**Location:** `convex/organizations.ts:130-167`; `claims.orgRole` is already populated by `requireIdentity` (`convex/lib/auth.ts:39-47`).

**Problem:** The handler checks only that `claims.orgId === args.clerkOrgId` — i.e. that the caller is *some* member of the org. It does not check `claims.orgRole` (Clerk's `org_role` claim, typically `"org:admin"` or `"org:member"`). Any member, including a least-privileged `org:member`, can invoke `ensureOrganization` and overwrite the org's `name`/`slug`/`imageUrl` in the mirror. Combined with P1 #2, this means a non-admin member can drift the slug and DoS the entire org's `requireOrgMemberBySlug` lookups.

**Impact:** Privilege mismatch with Clerk's own org-role model. Clerk restricts org-metadata edits to admins; the Convex mirror lets any member do it. Non-admin-driven mirror drift and slug-collision DoS.

**Fix:** Require admin role for the patch path (and ideally for the insert path too, since org creation is an admin action in Clerk):
```ts
if (claims.orgRole !== "org:admin") {
  throw new Error("Only org admins may modify organization metadata");
}
```
If the mutation is reduced to ensure-exists-only (P1 #2 fix), the role check matters less but should still gate any content writes.

---

### [SEV: P2] `deleteFromClerk` hard-deletes the wallet and all `walletEntries` — silently destroys prepaid balance and publisher earnings ledger without settlement or refund
**Location:** `convex/organizations.ts:103-114`.

**Problem:** On `organization.deleted`, the handler deletes every `walletEntries` row and the `wallets` row. For a consumer org, this destroys the prepaid credit balance with no refund flow. For a publisher org, it destroys the credit ledger that backs `publisherEarnings` — and while `publisherEarnings` rows are orphaned rather than deleted (P1 #1), their materialized balance and sequence are gone, breaking any future reconciliation or payout audit. Financial records of this kind are typically subject to retention requirements; hard-deleting the ledger on an admin action in Clerk is the wrong default.

**Impact:** Loss of financial state: prepaid credits vanish without refund, publisher earnings allocation history is severed from its ledger. If the org is later recreated (same `clerkOrgId`), the new wallet starts at `balance: 0` / `sequence: 0` — lost credits are not restorable. No audit trail of the destruction beyond the absence of rows.

**Fix:** Do not hard-delete `wallets` or `walletEntries` on org deletion. Soft-delete the wallet (`deletedAt` sentinel) and retain the ledger; if balance must be zeroed, record an explicit `admin_adjustment` / `kind: "refund_reversal"` entry with a `refId` referencing the deletion event so the ledger remains auditable. If hard-delete is mandated by policy, settle outstanding balances (refund prepaid credits, payout pending publisher earnings) *before* deleting — do not destroy financial state as a side effect of a Clerk org deletion.

---

### [SEV: P2] `ensureWallet` `.unique()` throws unhandled on duplicate wallets — propagates to `upsertFromClerk`/`ensureOrganization` and bricks the webhook retry loop
**Location:** `convex/organizations.ts:11-27` (`ensureWallet`); called from `upsertFromClerk:74,83` and `ensureOrganization:148,161`.

```ts
const existing = await ctx.db.query("wallets")
  .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
  .unique();
```

**Problem:** `.unique()` throws `NonUniqueResponseError` if >1 wallet row matches. Duplicate wallets can arise from the race in P1 #3 (concurrent `ensureWallet` calls both observing zero rows and both inserting — no unique constraint), or from the pre-existing `getOrCreateWallet` race documented as P0 in `reviews/convex.wallets.ts.md`. When `ensureWallet` throws, the exception propagates up through `upsertFromClerk` (the Clerk webhook handler) and `ensureOrganization` (the web-app mutation). The webhook gets a 500; Svix retries; the retry hits the same throw; retry exhaustion drops the event. The org is stuck with duplicate wallets and no automated recovery. `ensureWallet` is also duplicated logic — `convex/wallets.ts` has its own `getOrCreateWallet` with the identical race (flagged P2 in the wallets review as "Duplicated `getOrCreateWallet` implementation in `organizations.ts`").

**Impact:** Org stuck: every wallet-touching path (settlement, grant, refund, checkpoint) throws; webhook retries livelock on the throw; the duplicate-wallet state is non-recoverable without manual DB surgery. Cross-references the wallets P0.

**Fix:** Centralize wallet creation in one place (the wallets reviewer recommends `organizations.upsertFromClerk` as the sole creator and `getOrCreateWallet` becoming get-or-throw). After the insert, re-query `by_organization` `.unique()` and reconcile duplicates (delete the newer by `_creationTime`) within the same transaction. Or, since `ensureWallet` is only called from the org-creation path, make it idempotent: insert if absent, and on the read-back if duplicates exist, delete the losers and return the survivor.

---

### [SEV: P3] `upsertFromClerk` and `ensureOrganization` patch `imageUrl: args.imageUrl` — undefined leaves stale value, so Clerk image removal does not propagate
**Location:** `convex/organizations.ts:78-82` and `156-160`; webhook source `convex/http.ts:60-67` (`data.image_url ?? undefined`).

**Problem:** `args.imageUrl` is `v.optional(v.string())`. When the source omits `image_url` (or Clerk sends `null`, coerced to `undefined` via `??` in `http.ts:67`), `db.patch(id, { imageUrl: undefined })` is a no-op — Convex treats `undefined` patch values as "leave unchanged". So removing an org's image in Clerk fires `organization.updated` with no `image_url`, and the Convex mirror retains the stale `imageUrl` forever.

**Impact:** Mirror drift on image removal only. Cosmetic, but contradicts "Clerk is source of truth."

**Fix:** If removal should propagate, patch with `imageUrl: args.imageUrl ?? null` and change the schema field to `v.optional(v.union(v.string(), v.null()))` — or use `v.any()`-free sentinel. Alternatively, accept that image removal is unsupported and document it; the current behavior (silently keep stale) is the worst of both.

---

### [SEV: P3] `listMine` is misnamed — returns at most the *active* org, not all orgs the caller is a member of
**Location:** `convex/organizations.ts:39-52`.

```ts
export const listMine = query({
  args: {},
  handler: async (ctx): Promise<Doc<"organizations">[]> => {
    const claims = await requireIdentity(ctx);
    if (claims.orgId === undefined) return [];
    const org = await ctx.db.query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", claims.orgId!)).unique();
    return org === null ? [] : [org];
  },
});
```

**Problem:** "listMine" implies "all orgs I am a member of." The implementation returns only the org matching the JWT's *active* `org_id` claim — at most one row. A user who is a member of multiple Clerk orgs sees only the currently-active one; they cannot enumerate their memberships via this query. The `claims.orgId!` non-null assertion is safe (guarded by the `undefined` check on line 43) but is a code smell that the type didn't carry through. The return type `Doc<"organizations">[]` (array) reinforces the misleading "list" framing.

**Impact:** Misleading API; consumers may assume the array contains all member orgs. No security impact — the active-org scoping is correct — but the name invites a future caller to trust it for membership enumeration and be wrong.

**Fix:** Rename to `getActiveOrg` (return `Doc<"organizations"> | null`) or, if multi-org listing is a product requirement, accept that Convex has no Clerk-membership data (membership lives in Clerk) and document that callers must use Clerk's `useOrganizationList` instead. As written, `listMine` returning `[]` or `[org]` is an awkward middle ground.

---

### [SEV: P3] Mutation error messages leak authz internals to the client
**Location:** `convex/organizations.ts:133` (`"Organization does not match authenticated identity"`), `151` (`"Failed to load created organization"`), `164` (`"Failed to load updated organization"`).

**Problem:** Convex surfaces mutation error messages to the calling client by default. `"Organization does not match authenticated identity"` reveals *why* the authz check failed (identity/org mismatch) — useful to an attacker probing the auth model. `"Failed to load created/updated organization"` leaks internal state-machine internals (the post-write read-back failed). The project contract explicitly says "Never leak internal errors."

**Impact:** Minor info disclosure; aids reconnaissance of the authz model. No direct exploit.

**Fix:** Return a single generic message (`"Unauthorized"` / `"Organization not available"`) for the authz failure, and log the detailed reason server-side only. For the post-write read-back failures (which are internal-only and should never fire), a generic `"Internal error"` is sufficient — the detailed message helps no one client-side.

---

## Summary

| Severity | Count |
|---|---|
| P0 | 0 |
| P1 | 4 |
| P2 | 7 |
| P3 | 3 |
| **Total** | **14** |

**Top 3:**
1. **`deleteFromClerk` cascade gap (P1 #1)** — orphans projects, payments, publisherEarnings, keySettings, usageEvents, notifications, and 7 more tables; breaks `requireProjectMember` for every project of the deleted org; gateway still serves orphaned key gates. The file's reason for existing — keeping the org mirror referentially intact — is violated on every deletion.
2. **`ensureOrganization` trusts client-supplied name/slug/imageUrl (P1 #2)** — only `clerkOrgId` is validated; the JWT's `org_slug` claim is ignored, so any member can drift the mirror and DoS other members via slug collision. Direct violation of the stated "never trust client-provided identifiers when auth context supplies them" contract.
3. **Insert-path race creates duplicate `clerkOrgId` rows (P1 #3)** — concurrent first-calls (webhook + client, two members, or svix retry) both insert; `by_clerk_org` is not a unique constraint; every subsequent `.unique()` read throws `NonUniqueResponseError`, permanently bricking the org for all members. The same class of bug the wallets reviewer rated P0, now at the ownership-tree root.

**Recurring themes:** (a) Convex indexes are treated as unique constraints when they are not — every `.unique()` read is a latent throw on duplicates that the insert paths can create (P1 #3, P2 #7, P2 #11). (b) The mirror has two writers (Clerk webhook + public mutation) with no versioning and no claim-based content guard, so last-write-wins drift is inevitable (P1 #2, P2 #5). (c) Deletion is shallow — only `wallets`/`walletEntries`/the org row are touched, leaving the entire ownership/billing subtree orphaned and the ledger destroyed without settlement (P1 #1, P2 #6, P2 #8, P2 #10). (d) Authz is inconsistent: `requireOrgMemberBySlug` checks membership, `getBySlug` does not, and `ensureOrganization` ignores `orgRole` (P1 #4, P2 #9).
