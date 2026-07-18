# Tiger Review — `convex/keySettings.ts` (DEEP-DIVE)

Scope: `convex/keySettings.ts` plus its full consumption chain —
`convex/schema.ts`, `convex/wallets.ts` (`getGatewayWallet`, `recordUsage`),
`convex/http.ts` (`/wallet-grants`, `/ingest-usage`), `convex/lib/auth.ts`,
`apps/gateway/src/key-verifier.ts`, `apps/gateway/src/wallet.ts` (DO key
enforcement + sync), `apps/gateway/test/key-settings.test.ts`,
`convex/keySettings.test.ts`, and the web caller
`apps/web/src/lib/api-keys.ts` + `apps/web/src/routes/app/settings/keys.tsx`.

The prior review found 1 P1 + 2 P2. Verified and expanded below: **1 P1, 7 P2, 7 P3**.

---

## Verdict

**NEEDS WORK.** The per-key controls are well-shaped at the schema/enforcement
layer (cap boundary, grace semantics, single-flight sync), but the *control
plane that feeds them* has a real cross-org trust hole, an unbounded
client-controlled grace window, a non-atomic Clerk↔Convex rotation, and no
fast-path invalidation for the hot path. The keys gate credits at the edge,
so every gap here is a credit-leakage or incident-response gap at the edge.

---

## File Stats

| metric | value |
|---|---|
| lines | ~255 |
| exported fns | `getForOrg` (q), `setCap` (m), `setDisabled` (m), `recordRotation` (m), `toGatewayRow`, `KeySettingView`, `GatewayKeySettingRow` |
| indexes used | `by_org`, `by_key` (global, app-level `.unique()`) |
| hot-path touchpoints | gateway Wallet DO `reserve`/`settle`/`consumeFreeTier` via `/wallet-grants` sync |

---

## Findings

### [SEV: P1] Cross-org shadow-row DoS — client-supplied `keyId` stamps new rows with the caller's org

`upsertSetting` → `getOwnedRow` returns `null` when no row exists for `keyId`
(global `by_key` lookup), so `insertSetting` stamps the **caller's**
`clerkOrgId` onto the new row. The header comment asserts "the web only ever
passes keyIds it listed from Clerk filtered to that org" — but the mutation is
directly callable by *any* authenticated member of *any* org with an
arbitrary string. The `keyId` is never verified against Clerk as belonging to
the caller's org.

```ts
// convex/keySettings.ts
async function upsertSetting(ctx, clerkOrgId, keyId, patch) {
  const existing = await getOwnedRow(ctx, clerkOrgId, keyId);
  if (existing !== null) return await patchSetting(ctx, existing._id, patch);
  return await insertSetting(ctx, clerkOrgId, keyId, patch); // ← stamps caller org
}
```

Attack: Org B (attacker) learns or guesses Org A's Clerk key id `K1` before
Org A has opened the keys screen. Org B calls `setCap({ keyId: "K1", ... })`.
A row `{ clerkOrgId: orgB, keyId: "K1" }` is created. Because `by_key` is
globally unique (app-level `.unique()`), Org A can **never** create its own row
for `K1` — every subsequent `setCap`/`setDisabled`/`recordRotation` from Org A
hits `getOwnedRow`, finds the row owned by `orgB`, and throws `"Key not
found"`.

Impact (worse than a pure DoS): Org A **cannot disable or cap its own
compromised key** through the normal UI flow. The key keeps authenticating at
the gateway (Clerk still considers it valid), and because no `keySettings`
row exists for `orgA`, the DO treats `K1` as *unrestricted* (no cap, not
disabled). This blocks security incident response. The victim must escalate to
a platform admin to delete the row.

The convex test suite covers the *existing-row* cross-org rejection
(`"rejects cross-org mutation of an existing row"`) but has **zero coverage**
for the shadow-row creation path — the untested branch is the vulnerability.

Fix: do not trust the client `keyId` for row creation. Either (a) verify the
`keyId` belongs to the caller's Clerk org server-side before insert (Convex
can call Clerk via `clerkClient` in the mutation, or accept a server-signed
proof from the web `rotateKey`/`listKeys` fn), or (b) make `keyId` scoped
uniqueness `(clerkOrgId, keyId)` and have `getOwnedRow` query by that compound
key — but that alone does *not* stop the shadow row; it just stops the
collision. The real fix is server-side ownership proof before insert. At
minimum, gate `insertSetting` behind a verifiable attestation that the keyId
was issued under the caller's org.

---

### [SEV: P2] `graceUntil` is client-provided with no upper bound

```ts
// recordRotation
args: { oldKeyId: v.string(), newKeyId: v.string(), graceUntil: v.number() }
...
if (!Number.isFinite(args.graceUntil) || args.graceUntil <= Date.now()) {
  throw new Error("graceUntil must be a future timestamp");
}
```

The web caller (`keys.tsx:145`) passes `created.graceUntil` from
`api-keys.ts` (`Date.now() + 24h`), but any authenticated member calling the
mutation directly can pass `graceUntil = Date.now() + 10*365*24*3600*1000`. A
rotated key (rotated precisely because it is being deprecated/compromised)
then stays valid at the gateway Wallet DO for a decade — `#isKeyDisabled`
only blocks once `graceUntil < now`. Rotation is silently defeated.

Fix: server-side clamp. Define `ROTATION_GRACE_MS` in the Convex module (not
just the web) and bind `graceUntil = Math.min(args.graceUntil, Date.now() +
ROTATION_GRACE_MS)`. Reject (or clamp) values exceeding the bound. The
constant belongs in the control plane since the control plane is the
enforcement authority.

---

### [SEV: P2] Rotation is non-atomic across Clerk and Convex — a failed `recordRotation` leaves the old key permanently valid

`apps/web/src/routes/app/settings/keys.tsx:140`:

```ts
const created = await rotateKey({ data: { id: target.id } }); // Clerk: new key created, old NOT revoked
await recordRotation({ oldKeyId: target.id, newKeyId: created.id, graceUntil: created.graceUntil });
```

`rotateKey` (api-keys.ts) creates the replacement key in Clerk and returns.
Clerk does **not** revoke the old key — that is intentionally deferred to
`graceUntil` enforcement in the Wallet DO. The Convex `recordRotation` is what
stamps `graceUntil` onto the old key's row. If `recordRotation` throws
(network blip, validation edge, shadow-row collision on `newKeyId`), the
mutation rolls back the Convex write, but the Clerk side is already committed:
the old key now has **no `graceUntil`** and will **never** be auto-disabled by
the DO. The user sees a toast error and believes rotation failed, but the old
key remains fully valid indefinitely.

Fix: make the rotation idempotent and reconcilable — either drive the whole
rotation from a single Convex mutation that owns the Clerk call (so the
transaction can retry), or record a "rotation intent" row first and reconcile
on retry. At minimum, on `recordRotation` failure the web fn should attempt a
retry and, on persistent failure, explicitly `setDisabled({ keyId: old, true })`
so the old key is not left in an unmanaged-valid state.

---

### [SEV: P2] Rotation silently drops the monthly cap — cap bypass via rotate

`recordRotation` writes `rotatedFromKeyId` on the new key and `graceUntil` on
the old key, but the new key's row is created with `disabled: false` and **no
`monthlyCapCredits`** (`insertSetting` only copies fields present in the
patch). The old key's cap is not transferred. A member whose key had a cap of
100 credits/month can rotate and obtain an uncapped replacement key with
lineage metadata that is **never enforced** at the gateway
(`wallet.ts:#isKeyDisabled` only consults `disabled` and `graceUntil`;
`rotatedFromKeyId` is purely informational).

Impact: intentional or accidental cap bypass. A member rotates → unlimited
spend. Also: a disabled key rotated to a new key re-enables access (new key
row defaults `disabled: false`).

Fix: in `recordRotation`, copy `monthlyCapCredits` (and `disabled`, if you
want rotation to preserve a hold) from the old row onto the new row. If the
old row had no settings, that's fine (unrestricted). If it did, inherit.

---

### [SEV: P2] No Clerk org-role gate on key management — any member can disable/rotate/cap

`requireOrgByClerkId` (keySettings.ts) verifies the JWT carries an org claim
and the org row exists, but never consults `claims.orgRole`. Any `org:member`
(including a read-only or billing-only invitee) can call `setDisabled`,
`setCap`, and `recordRotation`. The web layer (`api-keys.ts`) mirrors this —
no role check. A low-privilege member can disable every key in the org
(production DoS) or rotate to mint a new secret for themselves.

Fix: gate mutating key operations on `org:admin` (or an explicit
`keys:manage` role) in `requireOrgByClerkId` for the mutation path, or
introduce a dedicated `requireKeyManager` helper. List (`getForOrg`) can stay
open to members.

---

### [SEV: P2] Revoked/disabled key keeps working at the edge for ~60–120s — no push invalidation

Two independent caches, both 60s, both pull-only:

1. `apps/gateway/src/key-verifier.ts`: Clerk verify result cached 60s
   (`CACHE_TTL_SECONDS = 60`) in per-isolate memory + Cache API. After
   `revokeKey` (api-keys.ts) revokes in Clerk, the edge still returns
   `VerifiedKey` for up to 60s.
2. `apps/gateway/src/wallet.ts`: `#keySettings` map refreshed only when
   `nowMs - #keySettingsSyncedAt >= SYNC_GRANTS_WINDOW_MS` (60s) via
   `#resolveKeySetting`. After `setDisabled({ keyId, true })`, the DO's cached
   `disabled: false` persists for up to 60s + next-request latency.

Neither layer subscribes to Convex realtime for its own org's `keySettings`
rows. Worst case a revoked/disabled key continues serving billable traffic for
~2 minutes. For a key rotated because it was leaked, that is a real
credit-leakage window with no operator override short of waiting it out.

Compounding: `revokeKey` (api-keys.ts) revokes in Clerk but **does not** call
`keySettings.setDisabled` — so even after the Clerk cache expires, the DO's
`keySettings` row still says `disabled: false` (the row is orphaned, not
cleared). Revocation only takes effect at the DO via the Clerk-verify null
path. If Clerk verify is ever cached as `null`-skipped or the key is
un-revoked, the DO would allow it.

Fix: (a) have `revokeKey` also call `keySettings.setDisabled({ keyId, true })`
so the DO blocks it independently of Clerk verify. (b) For disable/rotate,
trigger an immediate DO sync (e.g., a Convex → DO alarm or a `setDisabled`
side-effect that pokes the wallet DO out of band) instead of waiting for the
60s pull window. (c) Consider negative-caching revoked keys in the verifier
with a shorter TTL or a revocation list.

---

### [SEV: P2] Cold-start + failed sync leaves the DO enforcing nothing for 60s

`wallet.ts:#resolveKeySetting` triggers `#syncGrantsSingleFlight` when
`nowMs - #keySettingsSyncedAt >= 60s`. On a cold DO, `#keySettingsSyncedAt`
is `0`, so the first request triggers a sync. But `syncGrants` **claims the
rate-limit window before fetching**:

```ts
await this.ctx.storage.put(K_SYNC_GRANTS_AT, nowMs);   // claim
const synced = await this.#fetchGrantsFromConvex(clerkOrgId);
if (synced === null) return { status: "sync_failed", ... }; // window already claimed
```

If the fetch fails (Convex 5xx, transient network, misconfigured
`CONVEX_URL`/`GATEWAY_INTERNAL_SECRET`), `K_SYNC_GRANTS_AT` is already set to
`nowMs`, so every subsequent `#resolveKeySetting` call within 60s triggers
`#syncGrantsSingleFlight` → `syncGrants` returns `rate_limited` →
`#keySettings` stays **empty**. Every `reserve`/`consumeFreeTier` then hits
`this.#keySettings.get(keyId) ?? setting` where both are `null` → **no key
enforcement at all**: disabled keys pass, capped keys are uncapped. For 60
seconds after a cold start with one failed sync, all keys are unrestricted.

The test `unknown key triggers a single refresh` covers the happy cold-start
path; there is **no test for the failed-sync cold-start path**.

Fix: on `sync_failed`, do not claim the rate-limit window (or roll it back).
Distinguish "rate_limited" (we just synced) from "sync_failed" (we did not)
and use a shorter retry backoff for failures. Also: on cold start with an
empty `#keySettings` map, consider failing closed for keys that *should* have
a row (hard without the row) — at minimum, log/alert so operators know the
DO is running ungated.

---

### [SEV: P2] `getForOrg` and `getGatewayWallet` use unbounded `.collect()` on `by_org`

```ts
// keySettings.ts getForOrg
const rows = await ctx.db.query("keySettings")
  .withIndex("by_org", (q) => q.eq("clerkOrgId", clerkOrgId))
  .collect();                                        // ← no take()
// wallets.ts getGatewayWallet
const settings = await ctx.db.query("keySettings")
  .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
  .collect();                                        // ← no take(), pulled every 60s
```

No server-side cap on rows per org. The "one active key per org" rule is
enforced only in the web `createKey` fn against Clerk — the Convex table will
happily store thousands of `keySettings` rows per org (e.g., via the shadow-row
path above, or via `recordRotation` lineage rows that are never cleaned up).
`getForOrg` is realtime-synced to the keys screen (unbounded subscription) and
`getGatewayWallet` is pulled by every Wallet DO every 60s (unbounded payload
over the internal HTTP). Both are amplification vectors.

Fix: cap with `.take(N)` (e.g., 256) and log/truncate beyond. Better: add a
cron that GCs `keySettings` rows whose key has been revoked in Clerk (the row
is orphaned and serves no enforcement purpose once Clerk says invalid).

---

### [SEV: P3] Cap accounting keyed by caller-supplied `usage.keyId` at settle can diverge from the reserved key

`wallet.ts:reserve` records `entry.keyId` (from `opts.keyId`) and
`sumInFlightForKey` counts against that key's cap. But `settle` increments the
persisted counter under `usage.keyId` (from `SettlementUsage`), and only when
`cost > 0`:

```ts
...(usage?.keyId && cost > 0
  ? { settledCounter: { storageKey: settledStorageKey(usage.keyId, utcMonthKey(settledAt)), amount: cost } }
  : {}),
```

If a caller settles a reservation with `usage.keyId` ≠ the reservation's
`entry.keyId`, the in-flight deduction was charged to one key's cap and the
settled counter to another. The cap check (`used + reserved + cost > cap`)
then under-counts for the actual key. The gateway pipeline controls both
fields today so this is latent, but the contract is unenforced and the
`keySettings` cap is the security boundary.

Fix: in `settle`, derive the counter key from `entry.keyId` (the reservation's
authoritative key), not from `usage.keyId`. Or assert `usage.keyId ===
entry.keyId` and reject on mismatch.

---

### [SEV: P3] `keyId` is unvalidated beyond non-empty-after-trim

`setCap`/`setDisabled`/`recordRotation` only check `args.keyId.trim().length
> 0`. No length cap, no format check (Clerk key ids are `key_…`). A member can
insert a 100KB `keyId`, which Convex will store and which then flows through
`getGatewayWallet` → `parseKeySettings` → `#keySettings` map and into
`usageEvents.keyId` / `settled:${keyId}:${month}` storage keys in the DO.
Large keyIds bloat every downstream store and index entry. Also no validation
that `oldKeyId`/`newKeyId` look like real Clerk ids in `recordRotation`.

Fix: validate `keyId` against `^key_[A-Za-z0-9_]+$` with a sane length cap
(e.g., 64), shared via `convex/lib/validate.ts`.

---

### [SEV: P3] `patchSetting` casts through `Record<string, unknown>` — type escape

```ts
const update: Record<string, unknown> = { updatedAt: Date.now() };
for (const [k, value] of Object.entries(patch)) {
  update[k] = value;
}
await ctx.db.patch(id, update as Partial<Doc<"keySettings">>);
```

The `as Partial<Doc<"keySettings">>` discards type safety. Today `UpsertPatch`
is a closed type so the keys are bounded, but the loop + cast means any future
field added to `UpsertPatch` silently flows into the patch without schema
validation, and a refactor that widens `UpsertPatch` becomes a runtime landmine
with no compile-time signal. Also, spreading `undefined` values into
`update[k]` relies on Convex patch deleting the field — correct but
non-obvious; a comment is already there, good.

Fix: build the patch object as a typed `Partial<Doc<"keySettings">>` literal
with explicit field assignment so the compiler checks each key.

---

### [SEV: P3] `revokeKey` orphans the `keySettings` row; no cleanup path

`apps/web/src/lib/api-keys.ts:revokeKey` calls `client.apiKeys.revoke` and
returns. It never calls `keySettings.setDisabled` or deletes the
`keySettings` row. The row persists, is still synced to the DO every 60s
(`getGatewayWallet`), and `disabled` remains whatever it was. Harmless while
Clerk verify returns revoked, but: (a) wasted sync bandwidth forever, (b) if
the key is ever un-revoked or the Clerk verify cache misbehaves, the stale
`disabled: false` row re-admits the key, (c) accumulates with the
unbounded-`.collect()` issue above.

Fix: `revokeKey` should also `setDisabled({ keyId, true })` (belt-and-suspenders
with Clerk) and ideally mark the row for GC. A nightly cron can drop rows
whose Clerk key is revoked/expired.

---

### [SEV: P3] Settled-cap counters never garbage collected in the DO

`wallet.ts` stores `settled:${keyId}:${YYYY-MM}` per key per month and
`free:${keyId}:${YYYY-MM-DD}` per key per day, indefinitely. A long-lived org
with N keys accumulates `12 * N` settled counters per year plus `365 * N` free
counters, all loaded/stored transactionally. No purge on key revoke, no TTL.
Over years this slows every `storage.transaction` in the DO.

Fix: sweep expired month/day counters on `syncGrants` (drop entries older than
the current month for revoked/rotated-away keys).

---

### [SEV: P3] `rotatedFromKeyId` is metadata-only — never enforced at the gateway

`toGatewayRow` ships `rotatedFromKeyId` to the DO, but `wallet.ts` never reads
it. `#isKeyDisabled` checks `disabled` and `graceUntil` only. So the lineage
field is write-only metadata with no runtime effect: a rotated-to key does not
inherit the rotated-from key's cap or disabled state (see the cap-drop P2),
and the gateway cannot answer "is this key the active leg of a rotation?"
without re-deriving from `graceUntil` presence. Either enforce it (inherit
cap, treat the new key as disabled if the old key was disabled at rotation
time) or drop the field from the gateway payload to avoid implying
enforcement that doesn't exist.

---

## Summary

| sev | count |
|---|---|
| P0 | 0 |
| P1 | 1 |
| P2 | 7 |
| P3 | 7 |
| **total** | **15** |

Top 3 to fix first:

1. **P1 — cross-org shadow-row DoS.** Client-supplied `keyId` stamps new rows
   with the caller's org; victim can never manage (disable/cap/rotate) their
   own key. Blocks incident response. No test covers the creation path.
2. **P2 — rotation non-atomic + cap drop.** `recordRotation` failure leaves
   the old key permanently valid (no `graceUntil`), and the new key silently
   loses the old key's monthly cap. Rotation can both fail-open and bypass
   caps.
3. **P2 — no push invalidation for revoked/disabled keys.** ~60–120s window
   where a revoked/disabled key keeps serving at the edge, compounded by
   `revokeKey` not writing `disabled: true` to `keySettings` and by the
   cold-start-failed-sync 60s ungated window.

Cross-cutting note: the control plane (`keySettings.ts`) is the *authority* for
edge key enforcement, but it trusts the web client for `keyId` ownership,
`graceUntil` bounds, and rotation atomicity. Every one of those trust points
is independently exploitable by any authenticated org member. Move ownership
proof and grace clamping server-side, make rotation a single reconcilable
operation, and add a push/side-channel invalidation for disable+revoke.
