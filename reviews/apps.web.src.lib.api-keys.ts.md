# Tiger Review — `apps/web/src/lib/api-keys.ts` + `apps/web/src/lib/key-cap.ts`

Reviewed alongside `apps/web/src/lib/key-cap.test.ts`, `convex/keySettings.ts`, and the consuming route `apps/web/src/routes/app/settings/keys.tsx` for secret-handling context. No praise — only problems.

## Verdict

**FAIL.** Two correctness/authorization defects in the key-management server functions (non-atomic rotation that never revokes the old Clerk key; missing org-scope verification on revoke/rotate) plus a server-trusted `graceUntil` and a shadow-row authorization gap in `convex/keySettings.ts` make the rotation path unsafe to ship as-is. The pure `key-cap.ts` helpers are mostly fine but carry a dead export, a type/runtime mismatch, and lax numeric acceptance.

## File Stats

| File | LOC | Findings |
|---|---|---|
| `apps/web/src/lib/api-keys.ts` | 253 | 9 |
| `apps/web/src/lib/key-cap.ts` | 28 | 4 |
| `apps/web/src/lib/key-cap.test.ts` | 44 | 1 |
| `convex/keySettings.ts` | 290 | 4 |
| **Total** | — | **18** |

## Findings

### [SEV: P1] `rotateKey` never revokes the old Clerk key — rotation is non-atomic and leaves the old key valid forever at Clerk

**Location:** `apps/web/src/lib/api-keys.ts:226-253` (`rotateKey` handler)

```ts
const created = await client.apiKeys.create({
  name: data.name.length > 0 ? data.name : `${old.name} (rotated)`,
  subject: userId,
  createdBy: userId,
  claims: { org_id: orgId },
});
// …no client.apiKeys.revoke(old.id) anywhere…
return { …, graceUntil: Date.now() + ROTATION_GRACE_MS };
```

**Problem:** `rotateKey` creates a replacement Clerk API key and returns. The old key is **never revoked in Clerk**. The 24h grace window is only recorded as a `graceUntil` field on the old key's *Convex* `keySettings` row — and that Convex write is delegated to the **client** (the route calls `recordRotation` after `rotateKey` returns). Two independent failures:

1. If the route's `recordRotation` Convex call fails (network blip, Convex outage, tab closed between the two awaits), the new Clerk key already exists but the gateway never learns a grace window — and the old Clerk key is still fully valid at Clerk. The system is left with two live Clerk keys and no recorded grace.
2. After 24h, nothing revokes the old Clerk key. There is no cron, no scheduled revoke. The old key remains valid **indefinitely** at Clerk. Enforcement of the grace expiry is entirely delegated to the gateway wallet DO reading `graceUntil` — if the gateway ever validates the old key directly against Clerk (or the DO sync misses the row), the old key keeps authenticating.

**Impact:** A rotated (presumably "compromised") key continues to authenticate after the documented 24h grace window. This is the exact failure mode rotation exists to prevent. Also, because the old Clerk key is never revoked, repeated rotations accumulate unlimited live Clerk keys per user (see P2 proliferation finding).

**Fix:** Make rotation transactional server-side. In `rotateKey`: (a) create the new key, (b) call `recordRotation` via an internal Convex mutation reference (or have the gateway DO record it), (c) schedule `client.apiKeys.revoke({ apiKeyId: old.id, ... })` — either immediately if the gateway reads `graceUntil` from Convex, or via a delayed job at `graceUntil`. Do not rely on the client to call `recordRotation` after the Clerk create succeeds. At minimum, if the Convex write fails, revoke the freshly-created new key and throw (compensating action) so the system isn't left with two live keys and no metadata.

---

### [SEV: P1] `revokeKey` and `rotateKey` verify user ownership but NOT org scope — cross-org key manipulation

**Location:** `apps/web/src/lib/api-keys.ts:171-183` (`revokeKey`), `:226-234` (`rotateKey`)

```ts
// revokeKey
const key = await client.apiKeys.get(data.id);
if (key.subject !== userId) {
  throw new Error("Key not found");
}
// no check that key.claims.org_id === session.orgId
```

```ts
// rotateKey
const old = await client.apiKeys.get(data.id);
if (old.subject !== userId) {
  throw new Error("Key not found");
}
// no check that old.claims.org_id === orgId
```

**Problem:** Both functions derive `orgId = session.orgId` (the *active* org) but only verify `key.subject === userId`. The old key's `claims.org_id` is never compared to the active org. A user with keys in multiple orgs can revoke or rotate a key belonging to org A while operating in org B's context. Rotation then creates the new key stamped with org B's `org_id` claim, silently migrating a key across orgs and breaking the "one key per org" invariant.

**Impact:** Cross-org key tampering; a key intended for org A can be revoked or replaced with one scoped to org B by the same user simply by switching active org. The `recordRotation` Convex call will then stamp the active org's `clerkOrgId` onto both rows, permanently corrupting org attribution.

**Fix:** After `client.apiKeys.get`, verify the key's org claim matches the active org:
```ts
const claims = key.claims;
if (!claims || typeof claims !== "object" ||
    !("org_id" in claims) || claims.org_id !== orgId) {
  throw new Error("Key not found");
}
```
Apply to both `revokeKey` and `rotateKey`.

---

### [SEV: P1] `convex/keySettings.ts` trusts client-supplied `keyId` for brand-new rows — cross-org shadow-row injection / namespace squatting

**Location:** `convex/keySettings.ts:122-142` (`upsertSetting` → `getOwnedRow`/`insertSetting`)

```ts
async function upsertSetting(ctx, clerkOrgId, keyId, patch) {
  const existing = await getOwnedRow(ctx, clerkOrgId, keyId);
  if (existing !== null) {
    return await patchSetting(ctx, existing._id, patch);
  }
  return await insertSetting(ctx, clerkOrgId, keyId, patch); // ← stamps caller's org on ANY keyId
}
```

**Problem:** The module comment admits the assumption: *"the web only ever passes keyIds it listed from Clerk filtered to that org."* That is a client-side assumption, not a server-enforced invariant. `setCap`, `setDisabled`, and `recordRotation` all accept `keyId: v.string()` and call `upsertSetting`. `getOwnedRow` only protects **existing** rows (throws "Key not found" on cross-org access); for a `keyId` with no existing row, `insertSetting` blindly stamps the **caller's** `clerkOrgId` onto whatever arbitrary `keyId` string the client supplied. There is no verification that the Clerk key identified by `keyId` actually belongs to the caller's org (or even exists).

Concrete attacks:
1. **Namespace squat / DoS:** An org member calls `setCap({ keyId: <victim's keyId>, monthlyCapCredits: 1 })` before the victim org ever touches that key. A row is inserted under the attacker's `clerkOrgId`. When the victim later calls `setCap` on their own key, `getOwnedRow` finds the attacker's row (global `by_key` index), sees `existing.clerkOrgId !== victimOrgId`, and throws `"Key not found"` — the victim is permanently locked out of managing their own key's cap/disable state.
2. **Cross-org cap application [INFERENCE]:** If the gateway wallet DO resolves key settings by `keyId` globally (rather than scoping to its own `clerkOrgId`), the attacker-created row's `monthlyCapCredits` / `disabled` would be applied to the victim org's key.

**Impact:** Cross-tenant authorization bypass on key metadata; persistent DoS of the victim's per-key controls.

**Fix:** Before `insertSetting`, verify the Clerk key actually exists and belongs to the caller's org. Since Convex mutations cannot call Clerk directly, the web server fn (`api-keys.ts`) must pass an authoritative org-bound keyId, or — better — `recordRotation`/`setCap`/`setDisabled` must require that a row was *pre-seeded* by a trusted path (e.g. only `recordRotation` and a new `seedKeySetting` server fn can create rows, both of which verify org scope through Clerk first). At minimum, `getOwnedRow` returning null for a foreign keyId should not silently fall through to `insertSetting`; it should require a Clerk-verified proof of ownership passed by the caller.

---

### [SEV: P1] `recordRotation` trusts client-supplied `graceUntil` — grace-window tampering

**Location:** `convex/keySettings.ts:267-290` (`recordRotation`)

```ts
export const recordRotation = mutation({
  args: {
    oldKeyId: v.string(),
    newKeyId: v.string(),
    graceUntil: v.number(),
  },
  handler: async (ctx, args) => {
    // …
    if (!Number.isFinite(args.graceUntil) || args.graceUntil <= Date.now()) {
      throw new Error("graceUntil must be a future timestamp");
    }
    const oldDoc = await upsertSetting(ctx, clerkOrgId, args.oldKeyId, {
      graceUntil: args.graceUntil, // ← arbitrary client value
    });
    // …
  },
});
```

**Problem:** `graceUntil` is validated only as "a future timestamp." A malicious client calling the Convex mutation directly (bypassing `rotateKey`) can pass `graceUntil = Date.now() + 10 * 365 * 24 * 3600 * 1000` and keep an old key valid at the gateway for a decade. There is no upper bound and no cross-check against `ROTATION_GRACE_MS`. The web `rotateKey` computes `Date.now() + ROTATION_GRACE_MS` correctly, but the Convex mutation — the actual enforcement point — does not constrain it.

**Impact:** A user (or anyone who can invoke the Convex mutation with a valid identity) can extend a key's gateway validity arbitrarily, defeating rotation's security purpose.

**Fix:** Clamp `graceUntil` server-side: `const max = Date.now() + ROTATION_GRACE_MS; graceUntil = Math.min(args.graceUntil, max);` and reject/warn if the client value exceeds the bound. Better: compute `graceUntil` inside the mutation from a server constant, ignoring the client value entirely.

---

### [SEV: P2] API key secret copied to clipboard is never cleared

**Location:** `apps/web/src/routes/app/settings/keys.tsx:183-193` (consuming the `secret` returned by `createKey`/`rotateKey`)

```ts
async function copySecret() {
  if (!revealed) return;
  try {
    await navigator.clipboard.writeText(revealed.secret);
    setCopied(true);
    toast.success("Copied to clipboard");
    window.setTimeout(() => setCopied(false), 1500);  // ← clears button label only
  } catch { … }
}
```

**Problem:** The secret is written to the system clipboard and the only `setTimeout` resets the *copied button label* after 1.5s — the clipboard itself is never cleared. The plaintext API key persists in the OS clipboard indefinitely, available to any other app/process. This is the standard clipboard-exfiltration vector for secrets.

**Impact:** Secret lingers in clipboard; any other application can read it until the user copies something else.

**Fix:** After a short timeout (e.g. 30-60s), clear the clipboard: `await navigator.clipboard.writeText("")` (guard for focus/permission). Also consider auto-closing the reveal dialog and nulling `revealed` after N minutes of inactivity, since the secret currently stays rendered in the `<code>` DOM block for as long as the dialog is open.

---

### [SEV: P2] `rotateKey` has no rate limit and no max-keys guard — Clerk key proliferation / cost attack

**Location:** `apps/web/src/lib/api-keys.ts:226-253`

**Problem:** `rotateKey` creates a new Clerk API key on every invocation. There is no rate limit, no cap on number of rotations, and (per the P1 finding) the old key is never revoked. `createKey` enforces a one-key rule; `rotateKey` bypasses it entirely ("the one-key rule does not apply to rotation"). A user (or a script driving the server fn) can invoke `rotateKey` in a loop and create thousands of Clerk API keys, each billable/allocating resources on Clerk's side, all still valid.

**Impact:** Unbounded Clerk key creation; cost / resource exhaustion; unmanageable key inventory.

**Fix:** Rate-limit `rotateKey` (e.g. once per minute per user), cap total active keys per user/org, and revoke the old key as part of rotation (see P1). Consider a server-side guard: refuse rotation if a rotation has occurred in the last N seconds.

---

### [SEV: P2] `createKey` one-key rule is a non-atomic list-then-create (TOCTOU)

**Location:** `apps/web/src/lib/api-keys.ts:103-141`

```ts
const existing = await client.apiKeys.list({ subject: userId, includeInvalid: false, limit: 100 });
const active = existing.data.some(/* org match */);
if (active) throw new Error("Only one API key per organization…");
// …gap…
const created = await client.apiKeys.create({ … });
```

**Problem:** Between `list` and `create` there is no atomicity. Two concurrent `createKey` invocations can both observe "no active key" and both create a key, violating the one-key-per-org invariant. There is no database-level uniqueness constraint on (subject, org_id) in Clerk API keys.

**Impact:** Two live keys for one org, defeating the one-key rule.

**Fix:** Either serialize key creation with a per-user lock (Durable Object / Convex atomic), or accept the race but add a reconciliation step that revokes surplus keys. At minimum, document that the one-key rule is best-effort.

---

### [SEV: P2] `listKeys`/`createKey` use `limit: 100` then `.some()`/`.filter()` — one-key rule and listing break past 100 keys

**Location:** `apps/web/src/lib/api-keys.ts:75-87`, `:103-122`

```ts
const page = await client.apiKeys.list({ subject: userId, includeInvalid: false, limit: 100 });
return page.data.filter(/* … */).map(/* … */);
```

**Problem:** Clerk's `apiKeys.list` is paginated. Both `listKeys` and `createKey` fetch only the first 100 keys. If a user accumulates >100 keys (plausible given the P2 proliferation finding — rotation never revokes), `listKeys` silently truncates and `createKey`'s one-key check can miss an active key beyond page 1, allowing a second key. No pagination loop, no `hasMore` handling.

**Impact:** Silent data truncation in the UI; one-key rule bypass at scale.

**Fix:** Paginate until exhausted (loop on `client.apiKeys.list` with cursor/offset) or raise limit to Clerk's max and assert `!hasMore`.

---

### [SEV: P2] `revokeKey` leaves orphaned `keySettings` rows in Convex

**Location:** `apps/web/src/lib/api-keys.ts:163-193` vs `convex/keySettings.ts`

**Problem:** `revokeKey` calls `client.apiKeys.revoke` but never deletes or marks the corresponding Convex `keySettings` row. The row (with `monthlyCapCredits`, `disabled`, `graceUntil`, `rotatedFromKeyId`) persists forever in the `keySettings` table, returned by `getForOrg` until the row is manually removed. Stale rows accumulate; the keys screen's `settingsByKey` map keeps ghost entries that never match a listed (non-revoked) Clerk key.

**Impact:** Storage leak; UI shows stale cap/disabled state for revoked keys if the join logic ever changes; confusing audit trail.

**Fix:** In `revokeKey` (or a Convex mutation called from it), delete or tombstone the `keySettings` row for the revoked `keyId` scoped to the org.

---

### [SEV: P2] `formatMonthlyCap` crashes on `null` — type contract mismatch with `parseMonthlyCap`

**Location:** `apps/web/src/lib/key-cap.ts:25-28`

```ts
export type ParsedCap =
  { ok: true; cap: number | null } | { ok: false; error: string };
// …
export function formatMonthlyCap(cap: number | undefined): string {
  if (cap === undefined) return "Unlimited";
  return cap.toLocaleString();   // ← null.toLocaleString() throws TypeError
}
```

**Problem:** `parseMonthlyCap` returns `cap: number | null` for the success branch, but `formatMonthlyCap` accepts only `number | undefined`. Passing `parsed.cap` (which is `null` when the user cleared the cap) is a type error at the call site — and if forced via `as any` or a future refactor, `null.toLocaleString()` throws `TypeError: Cannot read properties of null`. The two functions have incompatible "unlimited" representations (`null` vs `undefined`). The route currently avoids this only by not using `formatMonthlyCap` at all (it's dead — see P3), so the trap is armed for the next caller.

**Impact:** Latent runtime crash; confusing API contract.

**Fix:** Make `formatMonthlyCap` accept `number | null | undefined` and treat both `null` and `undefined` as unlimited:
```ts
export function formatMonthlyCap(cap: number | null | undefined): string {
  if (cap === null || cap === undefined) return "Unlimited";
  return cap.toLocaleString();
}
```

---

### [SEV: P2] `parseMonthlyCap` accepts scientific notation, hex, and binary literals; no upper bound

**Location:** `apps/web/src/lib/key-cap.ts:14-22`

```ts
const n = Number(trimmed);
if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
  return { ok: false, error: CAP_ERROR };
}
return { ok: true, cap: n };
```

**Problem:** `Number("1e3")` → `1000`, `Number("0x10")` → `16`, `Number("0b101")` → `5`, `Number("1e18")` → `1e18`, `Number("999999999999999999999")` → a finite integer-representable double beyond `Number.MAX_SAFE_INTEGER`. All pass. The test file even bakes `parseMonthlyCap("1e3") === 1000` in as intended behavior. There is no upper bound, so a user can set `monthlyCapCredits = 1e15` (the Convex `setCap` mutation re-validates `>0` and integer but also has no max). A "cap" of 1 quadrillion credits is nonsensical and signals the validation is too loose.

**Impact:** Surprising input acceptance; no defense-in-depth against absurd caps; precision loss for values beyond `MAX_SAFE_INTEGER`.

**Fix:** Add an explicit integer-string check (`/^\d+$/`) or `Number.parseInt(trimmed, 10)` with a range guard `n <= MAX_CAP` (e.g. 1e9). Reject scientific/hex/binary notation explicitly.

---

### [SEV: P3] `formatMonthlyCap` is dead code — exported but unused outside its own test

**Location:** `apps/web/src/lib/key-cap.ts:25-28`

**Problem:** A repo-wide search shows `formatMonthlyCap` is imported only by `key-cap.test.ts`. The keys route imports `parseMonthlyCap` only and renders the cap via a raw `<Input type="number">` with a `"Unlimited"` placeholder — `formatMonthlyCap` is never called. Either wire it into the display path (the table currently shows the raw input value, not a formatted cap) or delete it.

**Impact:** Dead code; unused export; the formatting intent (grouped `1,000`) is silently absent from the UI.

**Fix:** Use it in `KeyRow` to render the committed cap value, or remove it and its test.

---

### [SEV: P3] `createKey` name validation doesn't reject control characters / newlines

**Location:** `apps/web/src/lib/api-keys.ts:91-101`

```ts
const name = raw.trim();
if (name.length === 0) throw new Error("Name is required");
if (name.length > 64) throw new Error("Name must be 64 characters or fewer");
return { name };
```

**Problem:** `trim()` strips leading/trailing whitespace but a name like `"prod\nkey\0malicious"` or one containing embedded RTL overrides / zero-width chars passes. The name is later rendered in the DOM (React escapes HTML, so no XSS) and in Clerk, but control characters can corrupt logs, CLI output, and audit trails, and zero-width chars enable lookalike-name confusion.

**Impact:** Minor; log/display corruption, name-collision tricks.

**Fix:** Strip or reject control characters: `if (/[\x00-\x1f\x7f]/.test(name)) throw new Error("Name contains invalid characters");`

---

### [SEV: P3] `toRow` maps `lastUsedAt` from Clerk without verifying the field exists

**Location:** `apps/web/src/lib/api-keys.ts:43-56`

```ts
function toRow(key: { …; lastUsedAt: number | null; … }): ApiKeyRow { … }
```

**Problem:** The structural type assumes `lastUsedAt: number | null`, but Clerk's `apiKeys.list` response shape is not asserted at runtime. If Clerk omits the field, `lastUsedAt` becomes `undefined`, which violates the declared `number | null` type silently (TS structural typing on unvalidated external data).

**Impact:** Latent type lie; `formatDate(undefined)` in the route would render `"Invalid Date"`.

**Fix:** Coerce explicitly: `lastUsedAt: typeof key.lastUsedAt === "number" ? key.lastUsedAt : null`.

---

### [SEV: P3] `key-cap.test.ts` encodes lax behavior as intended and has no negative-coverage for hex/large numbers/null formatting

**Location:** `apps/web/src/lib/key-cap.test.ts:29`

**Problem:** The test `expect(parseMonthlyCap("1e3")).toEqual({ ok: true, cap: 1000 })` is filed under "rejects non-numbers" but actually asserts that scientific notation is *accepted* — locking in the lax behavior flagged above as a regression-tested feature. No tests cover: `formatMonthlyCap(null)` (would crash), `parseMonthlyCap("0x10")`, `parseMonthlyCap("999999999999999999999")`, or upper-bound rejection.

**Impact:** Tests entrench the bugs; no guardrail against the crash/null-path.

**Fix:** Add the missing negative cases; flip the `"1e3"` assertion once scientific notation is rejected (per P2 fix).

---

### [SEV: P3] `maskKeyId` exposes last 4 chars of the key *id* — low value but inconsistent with "masked" intent

**Location:** `apps/web/src/lib/api-keys.ts:24-27`

```ts
function maskKeyId(id: string): string {
  if (id.length <= 8) return "••••••••";
  return `••••${id.slice(-4)}`;
}
```

**Problem:** The masked display exposes the last 4 characters of the Clerk key **id** (not the secret). The id is not itself a secret, but exposing its suffix reduces the id's search space for anyone who observes the masked form in a screenshot/log. More importantly, the function is named `maskKeyId` but the field is exposed as `masked` in `ApiKeyRow` — a reader may assume `masked` is a masked *secret*, not a masked *id*. The actual secret is never re-listed (correct), but the naming invites confusion.

**Impact:** Minor information leak; naming confusion.

**Fix:** Either fully mask (`••••••••` always) or rename the field to `maskedKeyId` to make clear only the id is masked.

---

### [SEV: P3] `requireOrgByClerkId` throws raw `"Organization not found"` — minor existence leak

**Location:** `convex/keySettings.ts:80-93`

**Problem:** After resolving the active org from the JWT, the function queries the mirrored `organizations` table and throws `"Organization not found"` if no row exists. Since the org is derived from the caller's own JWT, this isn't a cross-tenant leak — but the message distinguishes "no org in JWT" from "org row missing" which can leak state about the mirroring pipeline to an attacker probing error responses.

**Impact:** Negligible; minor error-message granularity.

**Fix:** Collapse to a generic `"Select an organization before managing API keys"` for both branches.

---

## Summary

**Counts:** P0: 0 · P1: 4 · P2: 6 · P3: 8 · **Total: 18**

**Top 3 to fix before shipping:**
1. **Rotation is non-atomic and never revokes the old Clerk key** (`api-keys.ts:226-253`) — the old key stays valid past the 24h grace window; rotation's entire security purpose is defeated. Make it transactional and schedule/perform the old-key revoke.
2. **Missing org-scope verification on `revokeKey` and `rotateKey`** (`api-keys.ts:171-183, 226-234`) — a user with multiple org memberships can revoke/rotate a key from the wrong org, silently migrating keys across orgs.
3. **`convex/keySettings.ts` trusts client `keyId` for new rows and client `graceUntil` with no bound** (`keySettings.ts:122-142, 267-290`) — cross-org shadow-row injection (namespace squat / DoS on victim key management) and arbitrary grace-window extension. Verify Clerk ownership before inserting and clamp `graceUntil` server-side.
