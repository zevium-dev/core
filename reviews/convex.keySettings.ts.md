# Tiger Review — `convex/keySettings.ts`

## Verdict
INCORRECT — one cross-org authorization defect at the core of the file's contract, plus a revocation-bypass and an unbounded-growth gap. The file's stated auth model ("the web only ever passes keyIds it listed from Clerk filtered to that org") delegates the trust boundary to the UI: the Convex mutations are public, directly callable by any authenticated org member, and never verify that the supplied `keyId` belongs to the caller's Clerk org. The `by_key` index is global, so a row stamped with the attacker's `clerkOrgId` for a victim's `keyId` permanently blocks the victim from managing their own key. Two further issues undermine the rotation/revocation model this file exists to enforce.

## File Stats
- **Path:** `convex/keySettings.ts`
- **Lines:** 290
- **Exports:** `getForOrg` (query), `setCap` / `setDisabled` / `recordRotation` (mutations), `toGatewayRow` / `toView` (helpers), `KeySettingView` / `GatewayKeySettingRow` (types)
- **Table:** `keySettings` — `clerkOrgId: string` (not `v.id("organizations")`), indexed `by_org` (`clerkOrgId`) and `by_key` (`keyId`, global, non-unique)
- **Consumers:**
  - Web keys screen: `apps/web/src/routes/app/settings/keys.tsx` (`getForOrg`, `setCap`, `setDisabled`, `recordRotation`)
  - Gateway edge sync: `convex/wallets.ts` → `getGatewayWallet` calls `toGatewayRow` for every row `by_org`; served at `convex/http.ts` `/wallet-grants`; mirrored by `apps/gateway/src/wallet.ts` `WalletDO` (`#keySettings`, `#resolveKeySetting`, `#isKeyDisabled`)
  - Web rotation: `apps/web/src/lib/api-keys.ts` `rotateKey` creates the Clerk key, then the web calls `recordRotation`
- **Hot-path contract:** key settings feed the edge DO's `syncGrants` (≤60s staleness, rate-limited 1/60s per org). Per-request enforcement (`disabled`, `graceUntil`, monthly cap) happens in the DO, never against Convex.

---

## Findings

### [SEV: P1] `keyId` ownership is trusted from the client — cross-org keySettings hijack permanently locks the victim out of managing their own key
**Location:** `convex/keySettings.ts:168-184` (`upsertSetting` → `getOwnedRow` + `insertSetting`), `convex/keySettings.ts:96-114` (`getOwnedRow`), `convex/keySettings.ts:116-151` (`insertSetting`). Cross-reference: `convex/schema.ts:155-169` (`by_key` global index), `apps/web/src/lib/api-keys.ts:200-252` (web `rotateKey` verifies `old.subject === userId` and stamps `claims.org_id` — the authz the Convex side omits).

```ts
async function upsertSetting(ctx, clerkOrgId, keyId, patch) {
  const existing = await getOwnedRow(ctx, clerkOrgId, keyId);
  if (existing !== null) {
    return await patchSetting(ctx, existing._id, patch);
  }
  return await insertSetting(ctx, clerkOrgId, keyId, patch);   // ← stamps CALLER's clerkOrgId on an unverified keyId
}
```

**Problem:** `requireOrgByClerkId` only proves the caller is a member of *some* Clerk org; it does nothing to prove the supplied `keyId` is a key owned by that org. The file's header comment explicitly offloads this to the UI ("the web only ever passes keyIds it listed from Clerk filtered to that org"). That is not a trust boundary: `setCap`, `setDisabled`, and `recordRotation` are public `mutation`s. Any authenticated user with a valid Convex/JWT session can call them directly with an arbitrary `keyId` string. Clerk `key_` ids are non-secret opaque identifiers (the secret is the `ak_`/`zev_` token, not the id) and surface in the web UI, gateway responses, and logs.

The attack: an org-A member calls `setCap({ keyId: <org-B's keyId>, monthlyCapCredits: 1 })`.
1. `requireOrgByClerkId` returns `clerkOrgId = orgA`.
2. `getOwnedRow(orgA, <org-B keyId>)` queries `by_key` (a *global* index, not scoped by org) → no existing row → returns `null`.
3. `insertSetting` stamps `{ clerkOrgId: orgA, keyId: <org-B's keyId>, monthlyCapCredits: 1 }`.

Now org B calls `setCap({ keyId: <org-B's keyId>, monthlyCapCredits: 100 })`:
1. `getOwnedRow(orgB, <org-B keyId>)` queries `by_key` → finds the hijacked row.
2. `existing.clerkOrgId (orgA) !== clerkOrgId (orgB)` → throws `"Key not found"`.

The victim is permanently locked out of `setCap`, `setDisabled`, and `recordRotation` for their own key. There is **no delete mutation** and **no admin override** in this file, so the hijacked row cannot be removed by any in-product path; recovery requires a Clerk key revoke (`revokeKey` checks Clerk `subject`, not Convex rows) plus creating a replacement under a new `keyId`. The victim additionally loses the ability to *temporarily disable* the key (Clerk only supports revoke, not disable) and to set any monthly cap on it.

`recordRotation` compounds this: `recordRotation({ oldKeyId: <victim>, newKeyId: <victim-2>, graceUntil })` runs `upsertSetting` for `oldKeyId` first; if `oldKeyId` is hijacked, the first `upsertSetting` throws `"Key not found"`, the whole transaction rolls back, but the web's `rotateKey` has **already created the new Clerk key** (`apps/web/src/lib/api-keys.ts:228-248`). The org is left with a second live Clerk key, the old key's `graceUntil` never set (so it never expires at the edge), and the rotation record absent — an irreversible inconsistent state triggered by the F1 root cause.

**Gateway impact (why this is not P0):** the hijacked row has `clerkOrgId = orgA`, so `getGatewayWallet` (`convex/wallets.ts:241-251`) returns it only on **org A's** edge sync. Org B's DO never sees it (it syncs `by_org` = `orgB`), so org B's wallet hot path is unaffected — the attacker cannot enforce a cap or disable on the victim's gateway. The defect is a cross-org **management** DoS plus loss of the cap/disable controls for the victim's key, not a credit/wallet compromise.

**Fix:** the backend, not the UI, must verify `keyId` belongs to the caller's Clerk org before any insert. Either (a) resolve the key via Clerk (the web already does `client.apiKeys.get(id)` + `claims.org_id` check in `rotateKey`/`revokeKey` — surface that as an internal Convex helper callable from the mutation, or have the web pass a server-attested keyId token), or (b) make `recordRotation`/`setCap`/`setDisabled` `internalMutation`s invoked only from the server-fn that has already verified ownership, exposing only the read query publicly. At minimum, `insertSetting` must reject a `keyId` whose Clerk key's `claims.org_id` ≠ caller `clerkOrgId`. Also add a delete/archive mutation so hijacked rows can be recovered.

---

### [SEV: P2] `recordRotation` accepts an unbounded `graceUntil` — defeats rotation as a revocation mechanism
**Location:** `convex/keySettings.ts:256-289` (`recordRotation`), validation at `convex/keySettings.ts:280-282`.

```ts
if (!Number.isFinite(args.graceUntil) || args.graceUntil <= Date.now()) {
  throw new Error("graceUntil must be a future timestamp");
}
```

**Problem:** the only `graceUntil` validation is "finite and future." `recordRotation` is a public `mutation`, so any org member can call it directly (bypassing the web `rotateKey` which computes `Date.now() + ROTATION_GRACE_MS` = 24h at `apps/web/src/lib/api-keys.ts:250`). A caller can pass `graceUntil: Number.MAX_SAFE_INTEGER`. The gateway's `#isKeyDisabled` (`apps/gateway/src/wallet.ts`) treats a key as disabled when `setting.graceUntil < nowMs`; with `graceUntil` at `2^53-1`, the rotated *old* key passes that check forever — it is never cut off.

The entire point of rotation is that the old key stops working after the grace window, so that a compromised key is revoked on a schedule. An attacker who has the old key's secret (the compromise that motivated the rotation) and any member JWT in the org can call `recordRotation` with a far-future `graceUntil` (or re-call it after a legitimate rotation to extend grace) and keep the old key live at the edge indefinitely. Combined with the fact that `apps/web/src/lib/api-keys.ts` `rotateKey` never revokes the old key in Clerk either (it only creates the replacement), the old key remains a valid, gateway-accepted credential permanently.

**Impact:** rotation does not revoke. A rotated key continues to authenticate (Clerk `revoked=false`) and pass the DO's grace gate. Revocation-by-rotation — the security property this file advertises — is bypassable by any org member.

**Fix:** bound `graceUntil` to `now + MAX_ROTATION_GRACE_MS` (e.g. `ROTATION_GRACE_MS` from `api-keys.ts` plus modest slack) inside the mutation. Reject anything larger. Do not rely on the web caller to self-limit a public mutation.

---

### [SEV: P2] No cleanup/archive path for revoked or superseded keySettings rows — unbounded `getForOrg` and edge-sync payload growth
**Location:** `convex/keySettings.ts` (whole file — no delete/archive mutation exists); `convex/keySettings.ts:188-197` (`getForOrg` `.collect()`); cross-reference `convex/wallets.ts:241-251` (`getGatewayWallet` `.collect()` on `by_org`), `convex/http.ts` `/wallet-grants`.

```ts
const rows = await ctx.db
  .query("keySettings")
  .withIndex("by_org", (q) => q.eq("clerkOrgId", clerkOrgId))
  .collect();
return rows.map(toView);
```

**Problem:** rows are created on first `setCap`/`setDisabled`/`recordRotation` and never removed. Clerk key revocation (`apps/web/src/lib/api-keys.ts` `revokeKey`) revokes the Clerk key but does **not** delete the corresponding `keySettings` row — there is no Convex endpoint to do so, and the webhook handler in `convex/http.ts` (`/clerk-webhook`) handles `organization.deleted` only, not API-key revocation. Every rotation also creates a new row for `newKeyId` while leaving the `oldKeyId` row in place (with its now-stale `graceUntil`). Over an org's lifetime, every key ever created accumulates a row.

Two consuming paths scan and serialize the full set on every call:
1. `getForOrg` is a realtime query feeding the keys screen — every row returned to every open session on every change.
2. `getGatewayWallet` (`/wallet-grants`) `.collect()`s all rows on every edge DO `syncGrants` (≤60s cadence per org) and ships them as JSON to the Worker.

Neither filters on `disabled`, expired `graceUntil`, or revoked keys. For a long-lived org that rotates monthly, the edge-sync payload and the realtime query grow without bound. This is the keySettings-side half of the unbounded-`collect` finding already raised against `convex/wallets.ts`; the root cause (no lifecycle) lives here.

**Impact:** unbounded read cost and payload size on a hot edge-sync path and a realtime query; orphaned rows for revoked keys linger and keep being shipped to the edge, where the DO honors any still-active gate (`disabled`, `monthlyCapCredits`, `graceUntil`) for keys that no longer exist in Clerk. (If Clerk ever recycles a `keyId` across instances, a recreated key inherits the deleted key's gates — low probability, high confusion.)

**Fix:** add a cleanup path. Either (a) a `deleteForRevokedKey` internal mutation invoked from a Clerk API-key-revoked webhook (add the event to `convex/http.ts` `/clerk-webhook`), or (b) archive rows on rotation (mark `oldKeyId` row superseded and exclude it from `getForOrg`/`toGatewayRow` via a status filter), and (c) bound `getGatewayWallet`'s keySettings query with `.take(N)` plus a `disabled`/expired-`graceUntil` filter for the gateway sync specifically. At minimum, stop shipping revoked/expired rows to the edge.

---

### [SEV: P3] `setDisabled(false)` cannot re-enable a key whose `graceUntil` has expired — stale grace is never cleared
**Location:** `convex/keySettings.ts:234-232` (`setDisabled`); cross-reference `apps/gateway/src/wallet.ts` `#isKeyDisabled` (`setting.disabled || (setting.graceUntil !== undefined && setting.graceUntil < nowMs)`).

```ts
const doc = await upsertSetting(ctx, clerkOrgId, args.keyId, {
  disabled: args.disabled,
});
```

**Problem:** `setDisabled` patches only the `disabled` boolean. It does not touch `graceUntil`. After a rotation, the old key has `graceUntil` set; once `graceUntil < now`, `#isKeyDisabled` returns `true` via the grace clause even if `disabled === false`. An admin who toggles the key to "enabled" via `setDisabled(false)` sees `disabled: false` persisted, but the gateway still rejects the key with `key_disabled` because the stale past `graceUntil` keeps `#isKeyDisabled` true. No mutation in this file clears `graceUntil` (only `recordRotation` overwrites it with a new value). The key is permanently dead at the edge despite the persisted "enabled" state.

**Impact:** admin confusion — the UI shows the key as enabled but the gateway rejects it. No security impact (the key stays dead, which is the safe direction), but the persisted state is misleading and there is no recovery path short of re-rotating.

**Fix:** when `setDisabled(false)` is called, also clear `graceUntil` (patch `graceUntil: undefined`), or expose an explicit "clear grace" operation. Alternatively document that `setDisabled` is a no-op on grace-expired keys and have the UI hide the toggle for them.

---

### [SEV: P3] `keyId` whitespace is not trimmed/rejected — silently-inert rows and duplicate-keyId confusion
**Location:** `convex/keySettings.ts:211-213` (`setCap`), `convex/keySettings.ts:239-241` (`setDisabled`), `convex/keySettings.ts:273-277` (`recordRotation`).

```ts
if (args.keyId.trim().length === 0) {
  throw new Error("keyId is required");
}
// args.keyId is then used UNTRIMMED for the by_key lookup and stored verbatim:
await upsertSetting(ctx, clerkOrgId, args.keyId, { ... });
```

**Problem:** validation rejects only all-whitespace strings; a `keyId` with leading/trailing spaces (`" key_abc "`) passes, is stored verbatim, and is used as the `by_key` lookup key. The gateway matches keys by exact `keyId` string (`apps/gateway/src/wallet.ts` `#keySettings.get(keyId)`), so a padded row never matches real traffic — the setting is silently inert. A subsequent call with the trimmed `keyId` creates a *second* row (different `keyId` string → `getOwnedRow` misses the padded row → inserts again), and the two rows diverge independently.

**Impact:** data-quality bug. A user (or a direct mutation caller) who fat-fingers whitespace gets a no-op row that looks saved in the UI but never enforces at the edge, plus a confusing duplicate when they re-enter it cleanly. Low security impact.

**Fix:** `const keyId = args.keyId.trim();` once at the top of each handler and use that for both lookup and storage; or reject any `keyId !== keyId.trim()`.

---

### [SEV: P3] No upper bound on `monthlyCapCredits`
**Location:** `convex/keySettings.ts:214-220` (`setCap` validation).

```ts
if (
  args.monthlyCapCredits !== null &&
  (!Number.isFinite(args.monthlyCapCredits) ||
    args.monthlyCapCredits <= 0 ||
    !Number.isInteger(args.monthlyCapCredits))
) {
  throw new Error("Cap must be a positive whole number of credits");
}
```

**Problem:** the validator correctly rejects `NaN`, `Infinity`, non-positive, and non-integer values, but accepts any positive integer up to `Number.MAX_SAFE_INTEGER` (`2^53 - 1`). Such a cap is functionally "unlimited" (the gateway's `used + reserved + cost > cap` comparison never trips), so the persisted row is semantically equivalent to "no cap" while appearing to set one. The UI likely bounds this, but the public mutation does not. Low impact: no overflow (JS safe-integer arithmetic is exact below `2^53`), just misleading state.

**Fix:** enforce a sane maximum (e.g. the org's largest credit pack × some factor, or a fixed ceiling) and reject above it; or document that "unlimited" must be expressed as `null`, not a huge number.

---

### [SEV: P3] `patchSetting` uses a `Record<string, unknown>` → `Partial<Doc<"keySettings">>` type escape
**Location:** `convex/keySettings.ts:153-165`.

```ts
const update: Record<string, unknown> = { updatedAt: Date.now() };
for (const [k, value] of Object.entries(patch)) {
  update[k] = value;
}
await ctx.db.patch(id, update as Partial<Doc<"keySettings">>);
```

**Problem:** the patch object is built as an untyped `Record<string, unknown>` and then `as`-cast to `Partial<Doc<"keySettings">>`, bypassing the type system. The current `UpsertPatch` shape (`monthlyCapCredits`, `disabled`, `rotatedFromKeyId`, `graceUntil`) only contains valid `keySettings` fields, so the cast is safe today. But the escape means a future field added to `UpsertPatch` that is not a valid `keySettings` column (or a typo) would compile and silently write through to `db.patch` with no type error. This is the kind of untyped seam that lets the kind of cross-field drift seen elsewhere in the codebase slip in.

**Impact:** no runtime defect today; type-safety smell that lowers the barrier for a future regression.

**Fix:** build the patch as a typed `Partial<Doc<"keySettings">>` directly:
```ts
const update: Partial<Doc<"keySettings">> & { updatedAt: number } = {
  updatedAt: Date.now(),
};
if (patch.monthlyCapCredits !== undefined) update.monthlyCapCredits = patch.monthlyCapCredits;
if (patch.disabled !== undefined) update.disabled = patch.disabled;
if (patch.rotatedFromKeyId !== undefined) update.rotatedFromKeyId = patch.rotatedFromKeyId;
if (patch.graceUntil !== undefined) update.graceUntil = patch.graceUntil;
await ctx.db.patch(id, update);
```

---

### [SEV: P3] No org-role check — any org member (not just admin) can disable, cap, or rotate every key in the org
**Location:** `convex/keySettings.ts:84-95` (`requireOrgByClerkId`); all three mutations gate only on org membership.

**Problem:** `requireOrgByClerkId` calls `requireIdentity` and confirms a mirrored org row exists, but never inspects `claims.orgRole` (available from `requireIdentity` per `convex/lib/auth.ts`). Any org member — including the Clerk `member` role, not just `admin` — can call `setDisabled({ keyId, disabled: true })` to disable every key in the org, `setCap({ keyId, monthlyCapCredits: 1 })` to throttle the org's own API to a trickle, or `recordRotation` to trigger rotation. These are org-wide destructive operations gated only by membership. The file's header comment documents "Require an authenticated member of the active Clerk org" as deliberate, so this is flagged for confirmation rather than as a clear defect — but API key management (disable-all, rotation) is conventionally an admin capability, and the sibling web server-fn `revokeKey`/`rotateKey` check `key.subject === userId` (per-key creator ownership), a stricter model than this file's "any member of the org."

**Impact:** a non-admin member can DoS the org's API access (disable all keys, set cap to 1) or force unwanted rotations. Low exploitability (insider) but high blast radius for a capability that is typically admin-gated.

**Fix:** if key-settings mutations are intended to be admin-only, gate on `claims.orgRole === "admin"` (or the project's equivalent) in `requireOrgByClerkId`. If member-level is intentional, document the rationale at the mutation level (not just the file header) since the operations are destructive and org-wide.

---

## Summary
- **Counts:** P0: 0 · P1: 1 · P2: 2 · P3: 5 — **8 findings**
- **Verdict:** INCORRECT

**Top 3:**
1. **Cross-org `keyId` hijack (P1)** — the Convex mutations trust a client-supplied `keyId` and never verify it belongs to the caller's Clerk org; the global `by_key` index lets an attacker stamp their `clerkOrgId` onto a victim's `keyId`, permanently locking the victim out of managing their own key (no delete mutation, no admin recovery). The file's header comment explicitly delegates the trust boundary to the UI — but these are public mutations, and the web's own `rotateKey`/`revokeKey` do the Clerk ownership check that Convex omits. Fix at the backend.
2. **Unbounded `graceUntil` in `recordRotation` (P2)** — the only validation is "future"; a public-mutation caller can set `MAX_SAFE_INTEGER`, so a rotated old key never expires at the edge, defeating rotation-as-revocation. Combined with the web's `rotateKey` never revoking the old key in Clerk, rotated credentials can live forever.
3. **No lifecycle for keySettings rows (P2)** — revoked-in-Clerk and rotated-old keys leave orphaned rows that are never deleted and never filtered out; `getForOrg` (realtime) and `getGatewayWallet` (`/wallet-grants` edge sync) `.collect()` and ship the full unbounded set every cadence, including stale gates for keys that no longer exist.

**Accepted design (not flagged):** ≤60s edge-cache staleness on `disabled`/`cap`/`grace` changes is documented (`SYNC_GRANTS_WINDOW_MS` rate-limit + lazy `#resolveKeySetting` refresh) and is the stated hot-path contract — not a defect. The `by_key` global index relying on Clerk `keyId` uniqueness is noted in the schema review; Convex serializable isolation prevents same-keyId duplicate inserts via the query-then-insert pattern in a single transaction, so `getOwnedRow`'s `.unique()` is a defensive invariant rather than a live failure mode.
