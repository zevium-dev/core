# Tiger Review (DEEP) — `apps/web/src/routes/app/settings/keys.tsx`

Scope: full file (763 ln) + deep cross-read of `apps/web/src/lib/api-keys.ts`,
`apps/web/src/lib/key-cap.ts`, `convex/keySettings.ts`, `convex/schema.ts`
(`keySettings` table), `apps/web/src/lib/motion.ts`, `apps/web/src/lib/human-error.ts`,
`apps/web/src/lib/convex-api.ts`. Prior shallow review (`apps.web.src.routes.app.settings.keys.tsx.md`)
found 2 P1 + 2 P2 + 3 P3; this deep-dive **verifies** all of them and **expands**
with 13 additional findings. No praise — only problems.

## Verdict

**FAIL.** The rotation lifecycle is unsafe to ship: the old Clerk key is never
revoked, the new secret is lost on a downstream Convex write failure, the
client controls the grace window and the keyId namespace, and the route renders
the plaintext secret in the DOM with no auto-hide and never clears the
clipboard. The Convex control-plane mutations trust client-supplied `keyId`
for brand-new rows, enabling cross-org shadow-row DoS that permanently locks
victims out of their own key settings. `revokeKey`/`rotateKey` verify user
ownership but not org scope. The prior review's claim that there are "no
hardcoded motion values" is **wrong** — `blur(8px)` / `blur(0px)` are inlined.

## File Stats

| File | LOC | Notes |
|---|---|---|
| `apps/web/src/routes/app/settings/keys.tsx` | 763 | route + 5 sub-components |
| `apps/web/src/lib/api-keys.ts` | 253 | Clerk server fns |
| `apps/web/src/lib/key-cap.ts` | 28 | pure helpers |
| `convex/keySettings.ts` | 290 | control-plane mutations |
| Findings | — | 25 (P0: 0, P1: 5, P2: 8, P3: 12) |

---

## Findings

---

### [P1] Rotation two-phase write loses the new secret when `recordRotation` fails

**Location:** `apps/web/src/routes/app/settings/keys.tsx:139-152`

```tsx
const rotateMutation = useMutation({
  mutationFn: async (target: ApiKeyRow): Promise<RotateApiKeyResult> => {
    const created = await rotateKey({ data: { id: target.id } });   // Clerk create — commits
    await recordRotation({                                          // Convex write — may throw
      oldKeyId: target.id,
      newKeyId: created.id,
      graceUntil: created.graceUntil,
    });
    return created;
  },
  onSuccess: (created) => {
    setRevealed(created);                                            // ← skipped on throw
    ...
```

**Problem:** `mutationFn` performs two writes across independent systems — Clerk
key creation (`rotateKey`) then Convex metadata (`recordRotation`). If
`recordRotation` rejects (network blip, Convex validation error, transient
auth, tab backgrounded), the whole mutation rejects, `onSuccess` never runs,
and `setRevealed(created)` is skipped. But the Clerk key **was already created**:
the new secret exists only in the `created` local variable, which is discarded
on the throw path. `onError` shows a generic "Could not rotate API key" toast.

**Impact:** The user now has a new Clerk API key whose secret was shown exactly
zero times and is unrecoverable. The old key's `graceUntil` was never recorded,
so the gateway may not honour the 24h overlap. The user is forced to rotate
again, burning another key, and may believe the rotation failed and continue
using the old (now-ungraced) key. Canonical two-phase-write footgun on a
security-critical, show-once resource.

**Fix:** Either (a) move the Convex write **server-side into `rotateKey`** so
the TanStack server fn orchestrates both and the client only reveals what the
server returned (preferred — also fixes the never-revoke + graceUntil-tamper
findings below), or (b) surface the secret decoupled from `recordRotation` and
make the Convex write best-effort with a reconciling toast:

```tsx
const created = await rotateKey({ data: { id: target.id } });
setRevealed(created);            // reveal immediately, before the Convex write
try {
  await recordRotation({ oldKeyId: target.id, newKeyId: created.id, graceUntil: created.graceUntil });
} catch {
  toast.error("Key rotated, but grace sync failed — old key may not overlap. Re-rotate if unsure.");
}
```

---

### [P1] `rotateKey` never revokes the old Clerk key — rotation is non-atomic and the old key stays valid forever at Clerk

**Location:** `apps/web/src/lib/api-keys.ts:226-253` (`rotateKey` handler),
called from `keys.tsx:141`

```ts
const created = await client.apiKeys.create({
  name: data.name.length > 0 ? data.name : `${old.name} (rotated)`,
  subject: userId, createdBy: userId, claims: { org_id: orgId },
});
// …no client.apiKeys.revoke(old.id) anywhere…
return { …, graceUntil: Date.now() + ROTATION_GRACE_MS };
```

**Problem:** `rotateKey` creates a replacement Clerk API key and returns. The
old key is **never revoked in Clerk**. The 24h grace window is only recorded
as a `graceUntil` field on the old key's *Convex* `keySettings` row — and that
Convex write is delegated to the **client** (the route calls `recordRotation`
after `rotateKey` returns). Two independent failures:

1. If the route's `recordRotation` Convex call fails (see P1 above), the new
   Clerk key already exists but the gateway never learns a grace window, and
   the old Clerk key is still fully valid at Clerk. The system is left with two
   live Clerk keys and no recorded grace.
2. After 24h, **nothing revokes the old Clerk key**. No cron, no scheduled
   revoke, no TTL. The old key remains valid indefinitely at Clerk. Enforcement
   of the grace expiry is entirely delegated to the gateway wallet DO reading
   `graceUntil` — if the gateway ever validates the old key directly against
   Clerk (or the DO sync misses the row), the old key keeps authenticating.

**Impact:** A rotated (presumably "compromised") key continues to authenticate
after the documented 24h grace window — the exact failure mode rotation exists
to prevent. Repeated rotations accumulate unlimited live Clerk keys per user
(see P2 proliferation finding), all still valid at Clerk.

**Fix:** Make rotation transactional server-side. In `rotateKey`: (a) create
the new key, (b) call `recordRotation` via an internal Convex mutation
reference (server-to-server, not via the client), (c) schedule
`client.apiKeys.revoke({ apiKeyId: old.id, ... })` at `graceUntil` via a delayed
Convex job, or revoke immediately if the gateway reads `graceUntil` from Convex
exclusively. Do not rely on the client to call `recordRotation` after the Clerk
create succeeds. At minimum, if the Convex write fails, revoke the
freshly-created new key and throw (compensating action) so the system isn't
left with two live keys and no metadata.

---

### [P1] `recordRotation` accepts an unbounded client-supplied `graceUntil` — old key immortalised at the gateway

**Location:** `convex/keySettings.ts:267-290` (called from
`keys.tsx:142-145`)

```ts
export const recordRotation = mutation({
  args: { oldKeyId: v.string(), newKeyId: v.string(), graceUntil: v.number() },
  handler: async (ctx, args) => {
    ...
    if (!Number.isFinite(args.graceUntil) || args.graceUntil <= Date.now()) {
      throw new Error("graceUntil must be a future timestamp");
    }
    const oldDoc = await upsertSetting(ctx, clerkOrgId, args.oldKeyId, {
      graceUntil: args.graceUntil,   // ← arbitrary client value, no upper bound
    });
```

**Problem:** The mutation validates only that `graceUntil` is finite and in the
future. There is no upper bound and no cross-check against `ROTATION_GRACE_MS`
(which lives in the web package, unreachable from Convex anyway). `recordRotation`
is a public authenticated Convex mutation — any org member can call it directly
with `graceUntil: Date.now() + 10 * 365 * 86400_000` and pin a rotated
(supposedly superseded) key as valid at the gateway for a decade. The web
client passes `created.graceUntil` (24h, computed in `rotateKey`), but nothing
stops a tampered client from substituting an arbitrary value.

**Impact:** An attacker (or a compromised/buggy client) can extend a key's
gateway validity arbitrarily, defeating rotation's security purpose. If the old
key was rotated *because it was compromised*, the compromise is silently
perpetuated.

**Fix:** Compute `graceUntil` inside the mutation from a Convex-side constant
(the canonical source of truth), ignoring the client value entirely:

```ts
const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;
const graceUntil = Date.now() + ROTATION_GRACE_MS;
// ignore args.graceUntil entirely; or clamp: Math.min(args.graceUntil, Date.now() + ROTATION_GRACE_MS + 60_000)
```

Better: derive it from `ROTATION_GRACE_MS` duplicated in the Convex package (or
a shared `packages/shared` constant) so the web and Convex agree.

---

### [P1] `convex/keySettings.ts` trusts client-supplied `keyId` for brand-new rows — cross-org shadow-row injection / namespace squat DoS

**Location:** `convex/keySettings.ts:122-142` (`upsertSetting` →
`getOwnedRow`/`insertSetting`), reachable from `setCap` / `setDisabled` /
`recordRotation` — all called from `keys.tsx` via `useConvexMutation`

```ts
async function upsertSetting(ctx, clerkOrgId, keyId, patch) {
  const existing = await getOwnedRow(ctx, clerkOrgId, keyId);
  if (existing !== null) {
    return await patchSetting(ctx, existing._id, patch);
  }
  return await insertSetting(ctx, clerkOrgId, keyId, patch);  // ← stamps CALLER's org on ANY keyId
}
```

**Problem:** The module comment explicitly admits the assumption: *"the web
only ever passes keyIds it listed from Clerk filtered to that org."* That is a
client-side assumption, not a server-enforced invariant. `getOwnedRow` only
protects **existing** rows (throws `"Key not found"` on cross-org access); for
a `keyId` with no existing row, `insertSetting` blindly stamps the **caller's**
`clerkOrgId` onto whatever arbitrary `keyId` string the client supplied. There
is no verification that the Clerk key identified by `keyId` actually belongs to
the caller's org (or even exists). `setCap`, `setDisabled`, and `recordRotation`
are all public authenticated Convex mutations; `useConvexMutation` exposes them
directly to the browser.

Concrete attacks against the route's own consumers:

1. **Namespace squat / permanent lockout:** An org member calls
   `setCap({ keyId: <victim's keyId>, monthlyCapCredits: 1 })` before the victim
   ever touches that key's settings. A row is inserted under the attacker's
   `clerkOrgId` against the victim's `keyId`. When the victim later opens the
   keys screen and blurs the cap input, `setCap` calls `upsertSetting` →
   `getOwnedRow` finds the attacker's row (global `by_key` index), sees
   `existing.clerkOrgId !== victimOrgId`, and throws `"Key not found"`. The
   victim is **permanently locked out** of managing their own key's cap/disable
   state. The route's `commitCap` `catch` shows "Could not save cap" and
   `resetCapInput()` — the victim has no idea why.
2. **`recordRotation` shadow-row + grace hijack:** An attacker calls
   `recordRotation({ oldKeyId: <victim's keyId>, newKeyId: <any>, graceUntil: <huge> })`.
   `upsertSetting` for `oldKeyId` inserts a row under the attacker's org with
   `graceUntil: <huge>`. The victim is locked out of their old key's row (same
   `getOwnedRow` throw). And — because the gateway wallet DO resolves settings
   by `keyId` globally via `toGatewayRow` (which strips `clerkOrgId`) — the
   attacker-controlled `graceUntil` may be applied to the victim's key at the
   gateway `[INFERENCE]`, immortalising a rotated victim key.

**Impact:** Cross-tenant authorization bypass on key metadata; persistent DoS
of the victim's per-key controls; potential grace-window tamper on victim keys.

**Fix:** Before `insertSetting`, verify the Clerk key actually exists and
belongs to the caller's org. Since Convex mutations cannot call Clerk directly,
either (a) have the web server fns (`createKey`/`rotateKey`) themselves call the
Convex mutation to seed the row (server-to-server, with org proof already
established), or (b) require a Clerk-verified proof-of-ownership token passed
by the caller. At minimum, `getOwnedRow` returning null for a foreign keyId
must not silently fall through to `insertSetting` — it should require the
caller to be on a trusted seeding path.

---

### [P1] `revokeKey` and `rotateKey` verify user ownership but NOT org scope — cross-org key manipulation

**Location:** `apps/web/src/lib/api-keys.ts:163-183` (`revokeKey`),
`:226-234` (`rotateKey`)

```ts
// revokeKey
const key = await client.apiKeys.get(data.id);
if (key.subject !== userId) {
  throw new Error("Key not found");
}
// no check that key.claims.org_id === session.orgId  ← missing

// rotateKey
const old = await client.apiKeys.get(data.id);
if (old.subject !== userId) {
  throw new Error("Key not found");
}
// no check that old.claims.org_id === orgId  ← missing
```

**Problem:** Both functions derive `orgId = session.orgId` (the *active* org)
but only verify `key.subject === userId`. The old key's `claims.org_id` is
never compared to the active org. A user with keys in multiple orgs can revoke
or rotate a key belonging to org A while operating in org B's context. Rotation
then creates the new key stamped with org B's `org_id` claim, silently migrating
a key across orgs and breaking the "one key per org" invariant. The route's
`keys` list is org-filtered, so the *UI* never offers a cross-org keyId — but
`revokeKey`/`rotateKey` are `createServerFn` POST endpoints; a hand-crafted
request bypasses the UI filter entirely.

**Impact:** Cross-org key tampering via direct server-fn calls; key migration
across orgs corrupts org attribution; the `recordRotation` Convex call then
stamps the active org's `clerkOrgId` onto both rows, permanently corrupting
org attribution.

**Fix:** After `client.apiKeys.get`, verify the key's org claim matches the
active org (mirror the `listKeys` filter):

```ts
const claims = key.claims;
if (!claims || typeof claims !== "object" ||
    !("org_id" in claims) || claims.org_id !== orgId) {
  throw new Error("Key not found");
}
```

Apply to both `revokeKey` and `rotateKey`.

---

### [P2] Copied secret is never cleared from the clipboard

**Location:** `apps/web/src/routes/app/settings/keys.tsx:183-193`

```tsx
async function copySecret() {
  if (!revealed) return;
  try {
    await navigator.clipboard.writeText(revealed.secret);
    setCopied(true);
    toast.success("Copied to clipboard");
    window.setTimeout(() => setCopied(false), 1500);   // ← clears button label only
  } catch {
    toast.error("Could not copy — select and copy manually");
  }
}
```

**Problem:** The secret is written to the system clipboard. The only
`setTimeout` resets the *copied button label* after 1.5s — the clipboard itself
is never cleared. The plaintext API key persists in the OS clipboard
indefinitely, readable by any foreground application/process. Clipboard
managers persist it to disk indefinitely. The dialog copy says "store it
somewhere safe" while simultaneously leaving it in the least-safe transient
store with no expiry.

**Impact:** Credential exposure window is unbounded and entirely client-side.

**Fix:** After a short window (e.g. 30s), clear the clipboard — and re-write
only if the clipboard still holds our secret, to avoid clobbering a user copy
in the meantime:

```tsx
await navigator.clipboard.writeText(revealed.secret);
setCopied(true);
toast.success("Copied — clipboard clears in 30s");
window.setTimeout(async () => {
  try {
    const cur = await navigator.clipboard.readText();
    if (cur === revealed.secret) await navigator.clipboard.writeText("");
  } catch { /* clipboard read may be blocked; ignore */ }
  setCopied(false);
}, 30_000);
```

---

### [P2] Plaintext secret rendered in the DOM with no auto-hide / re-hide

**Location:** `apps/web/src/routes/app/settings/keys.tsx:632-660`
(`SecretRevealDialog` `<code>` block)

```tsx
<code className="block flex-1 overflow-x-auto rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs break-all">
  {revealed.secret}
</code>
```

**Problem:** The prior review noted the clipboard gap but missed the DOM
exposure. The full plaintext secret is rendered as a text node inside `<code>`
for the entire duration the reveal dialog is open. There is:

- **No auto-hide timer.** If the user copies and walks away, the secret stays
  on screen indefinitely until they manually click "Done" / press Escape /
  click outside.
- **No click-to-reveal toggle** (the secret is shown immediately, in full, the
  moment the dialog opens).
- **No mask-after-copy.** Copying does not hide or mask the secret; it remains
  fully visible.
- **No unmount-on-blur.** If the user alt-tabs, the dialog (and the secret)
  stays mounted and visible in tab-switch previews / screen captures / screen
  readers (`<code>` is not `aria-hidden`).

`revealed` is cleared by `closeReveal` only on explicit close. There is no
timeout. This is the one place in the app where a raw credential touches the
DOM; the bar should be higher, not lower, than for ordinary text.

**Impact:** Unbounded on-screen secret exposure; vulnerable to shoulder-surfing,
screen-recording, tab-preview leakage, and screen-reader exfiltration. On a
shared/screen-shared machine the secret is on display until manual dismissal.

**Fix:** Auto-hide the secret after a short window (e.g. 60s) and null
`revealed`; or render masked by default with a "Show" / "Hide" toggle (re-mask
after N seconds of inactivity); or auto-close the dialog shortly after a
successful copy. At minimum, expire `revealed` on a timer so the DOM is wiped
without user action.

---

### [P2] Hardcoded motion values `blur(8px)` / `blur(0px)` — violates "all animation from motion.ts / CSS vars"

**Location:** `apps/web/src/routes/app/settings/keys.tsx:633-641`

```tsx
<m.div
  className="flex items-center gap-2"
  initial={
    reduce
      ? { opacity: 1, filter: "blur(0px)" }
      : { opacity: 0, filter: "blur(8px)" }     // ← hardcoded blur value
  }
  animate={{ opacity: 1, filter: "blur(0px)" }} // ← hardcoded blur value
  transition={{ duration: DUR.base, ease: EASE }}
>
```

**Problem:** The prior review's closing note claims "no hardcoded motion values
(uses `DUR.base`/`EASE`)". That is **wrong**. `DUR.base` and `EASE` are sourced
from `#/lib/motion`, but the `filter: "blur(8px)"` and `filter: "blur(0px)"`
strings are inlined literals. `apps/web/src/lib/motion.ts` exports `DUR`,
`EASE`, `STAGGER`, `DIST`, `SPRING` — there is no blur constant. The project
rule is explicit: *"all animation from src/lib/motion.ts / CSS vars."* This is
a literal motion value defined at the call site.

**Impact:** Motion-token drift; the blur distance cannot be tuned globally;
violates the single-source-of-truth rule the rest of the app follows.

**Fix:** Add a `BLUR` token to `motion.ts` (e.g. `export const BLUR = { reveal: 8 };`)
and reference it, or drop the blur entirely and use `opacity` alone (the blur
adds no security value — the secret is already in the DOM as plaintext).

---

### [P2] `useSuspenseQuery` for settings has no error boundary — route crashes on Convex error

**Location:** `apps/web/src/routes/app/settings/keys.tsx:84-86`,
`63-72` (gating)

```tsx
const { data: settingsData } = useSuspenseQuery(
  convexQuery(api.keySettings.getForOrg, {}),
);
```

**Problem:** `useSuspenseQuery` throws on error. The route is wrapped in
`<Suspense fallback={<KeysSkeleton />}>`, but `Suspense` catches **pending**,
not **errors**. There is no `errorComponent` / `ErrorBoundary` on the `Route`
definition (`createFileRoute("/app/settings/keys")({ component: KeysPage, head })`)
and no error boundary anywhere in the `app/settings` route tree (verified:
`grep` for `ErrorBoundary|errorComponent|CatchBoundary` under
`apps/web/src/routes/app/settings` returns nothing). If `getForOrg` rejects
(transient Convex outage, schema mismatch, `requireOrgByClerkId` throwing
`"Organization not found"` because the mirror row is missing), the thrown error
propagates up to the nearest ancestor boundary — which, if none exists, blanks
the entire app with a React error overlay.

Meanwhile `keysQuery` (the Clerk list) uses plain `useQuery` and handles
`isError` gracefully (`keysQuery.isError ? <p>{humanError(...)}</p> : ...`).
The two data sources have **inconsistent error handling**: one degrades
gracefully, the other throws.

**Impact:** A transient Convex error or a missing org-mirror row (which the
reviewer confirmed is a real throw path in `requireOrgByClerkId`) blanks the
whole keys screen instead of showing a recoverable error message.

**Fix:** Either switch `settingsData` to `useQuery` and render a local error
fallback alongside `keysQuery.isError`, or add an `errorComponent` to the
`Route` (and/or a settings-level `ErrorBoundary`) that renders a retry CTA.

---

### [P2] Rotation silently resets the new key's `monthlyCapCredits` and `disabled` to defaults

**Location:** `convex/keySettings.ts:267-290` (`recordRotation`),
`keys.tsx:141-152`

**Problem:** `recordRotation` stamps `graceUntil` on the old key's row and
`rotatedFromKeyId` on the new key's row — but does **not** carry over the old
key's `monthlyCapCredits` or `disabled` state to the new key's row. The new
key's `keySettings` row is inserted via `insertSetting` with only
`rotatedFromKeyId` set; `monthlyCapCredits` is absent (unlimited) and
`disabled` defaults to `false`. So if the old key had a cap of 100 credits
and was enabled, the rotated replacement is **uncapped and enabled** — the cap
silently disappears.

**Impact:** Security/cost regression. A user who rotated specifically because
they were worried about runaway spend loses their cap on the new key without
warning. The route shows the new row with an empty "Unlimited" cap input; the
user must notice and re-set it. No toast or warning surfaces the loss.

**Fix:** In `recordRotation`, copy `monthlyCapCredits` (and optionally
`disabled`) from the old row to the new row, or surface a "re-set your cap"
prompt in `rotateMutation.onSuccess`.

---

### [P2] `revokeKey` orphans the `keySettings` row in Convex — storage leak + stale `settingsByKey` entries

**Location:** `apps/web/src/lib/api-keys.ts:163-193` (`revokeKey`) vs
`convex/keySettings.ts` (`getForOrg`)

**Problem:** `revokeKey` calls `client.apiKeys.revoke` but never deletes or
tombstones the corresponding Convex `keySettings` row. The row (with
`monthlyCapCredits`, `disabled`, `graceUntil`, `rotatedFromKeyId`) persists
forever in the `keySettings` table and is still returned by `getForOrg`. The
route's `settingsByKey` map keeps a ghost entry keyed by the revoked `keyId`.
Currently `keys.map` iterates only the Clerk-listed (non-revoked) keys, so the
ghost is not rendered — but it accumulates indefinitely, and if the join logic
ever changes (e.g. iterating settings instead of keys), the ghost cap/disabled
state would attach to nothing or to a reused keyId.

**Impact:** Storage leak; stale control-plane metadata; latent UI corruption
if the iteration source changes.

**Fix:** In `revokeKey` (or a Convex mutation called from it), delete or
tombstone the `keySettings` row for the revoked `keyId` scoped to the org.

---

### [P2] `createKey` one-key rule is a non-atomic list-then-create (TOCTOU); `listKeys`/`createKey` truncate at 100 keys

**Location:** `apps/web/src/lib/api-keys.ts:75-87` (`listKeys`),
`:103-141` (`createKey`)

```ts
const page = await client.apiKeys.list({ subject: userId, includeInvalid: false, limit: 100 });
return page.data.filter(/* … */).map(/* … */);
```

**Problem:** (1) Between `list` and `create` in `createKey` there is no
atomicity. Two concurrent `createKey` invocations can both observe "no active
key" and both create a key, violating the one-key-per-org invariant the route
header advertises ("1 active key allowed per user"). (2) Clerk's `apiKeys.list`
is paginated; both `listKeys` and `createKey` fetch only the first 100 keys. If
a user accumulates >100 keys (plausible given the P1 never-revoke finding —
rotation never revokes), `listKeys` silently truncates and `createKey`'s
one-key check can miss an active key beyond page 1, allowing a second key. No
pagination loop, no `hasMore` handling.

**Impact:** Silent data truncation in the UI; one-key rule bypass at scale and
under concurrent creates.

**Fix:** Serialize key creation with a per-user lock (Durable Object / Convex
atomic), or accept the race but add a reconciliation step that revokes surplus
keys. Paginate `apiKeys.list` until exhausted (loop on cursor/offset) or raise
`limit` to Clerk's max and assert `!hasMore`.

---

### [P2] `rotateKey` has no rate limit and no max-keys guard — Clerk key proliferation / cost attack

**Location:** `apps/web/src/lib/api-keys.ts:226-253`

**Problem:** `rotateKey` creates a new Clerk API key on every invocation. No
rate limit, no cap on total active keys per user/org, and (per the P1 finding)
the old key is never revoked. `createKey` enforces a one-key rule; `rotateKey`
bypasses it entirely ("the one-key rule does not apply to rotation"). A user
(or a script driving the server fn) can invoke `rotateKey` in a loop and create
thousands of Clerk API keys, each billable / allocating Clerk-side resources,
all still valid.

**Impact:** Unbounded Clerk key creation; cost / resource exhaustion;
unmanageable key inventory.

**Fix:** Rate-limit `rotateKey` (e.g. once per minute per user), cap total
active keys per user/org, and revoke the old key as part of rotation (see P1).

---

### [P3] `graceActive` badge goes stale after grace expiry

**Location:** `apps/web/src/routes/app/settings/keys.tsx:513-514`

```tsx
const graceActive =
  setting?.graceUntil !== undefined && setting.graceUntil > Date.now();
```

**Problem:** `graceActive` is computed at render time from `Date.now()`. There
is no timer, and the Convex document does not change when grace lapses, so the
realtime subscription does not re-emit. The "Grace <date>" badge keeps showing
after the grace window has actually expired, until some unrelated state change
triggers a re-render.

**Impact:** Misleading status — users may believe an old rotated key is still
honoured at the gateway after it has lapsed. Low severity since the gateway
enforces the real expiry independently.

**Fix:** Drive the badge off a small ticking effect, or render the grace
*expiry date* rather than an "active/inactive" boolean so staleness is
non-misleading.

---

### [P3] Row-level Rotate button is not disabled while a rotation is pending

**Location:** `apps/web/src/routes/app/settings/keys.tsx:585-592`

```tsx
<Button
  variant="ghost"
  size="sm"
  onClick={onRotate}
  title="Rotate key (old key works 24h)"
>
  <RotateCw className="size-4" />
  Rotate
</Button>
```

**Problem:** The Revoke button in the same row is disabled via
`revokePending={revokeMutation.isPending}`, but the Rotate button has no
`disabled` and no `rotatePending` prop. While a rotation is in flight (dialog
open, spinner on the confirm button), the user can click Rotate on a different
row, which silently swaps `rotateTarget` mid-flight. Confirming would call
`rotateMutation.mutate` a second time while the first is still settling —
`useMutation` v5 only tracks the last invocation's state, so the first
rotation's `onSuccess`/`onError` wiring is clobbered. The asymmetric guarding
between Revoke and Rotate is clearly unintentional.

**Fix:** Pass `rotateMutation.isPending` down as `rotatePending` and disable
the row Rotate button (and bind the rotate dialog to the original target).

---

### [P3] Enable/disable Switch has no optimistic update — reverts then snaps

**Location:** `apps/web/src/routes/app/settings/keys.tsx:462-485`
(`commitToggle`), `:548-555` (`Switch` binding)

```tsx
async function commitToggle(nextEnabled: boolean) {
  setToggleBusy(true);
  try {
    await setDisabled({ keyId: apiKey.id, disabled: !nextEnabled });
    ...
  } finally {
    setToggleBusy(false);
  }
}
...
<Switch
  checked={!setting?.disabled}
  disabled={toggleBusy}
  onCheckedChange={(checked) => void commitToggle(checked === true)}
/>
```

**Problem:** `checked` is bound to the Convex-realtime persisted value, and
during `toggleBusy` the Switch is disabled. After the mutation resolves
locally, `setting.disabled` has not yet updated (the realtime round-trip is
still in flight), so the Switch visually **reverts to the old state** for a
frame, then snaps to the new state when Convex syncs. The project rule
("optimistic where safe") calls for an optimistic flip here — toggling a
boolean that we immediately reconcile from realtime is the textbook safe case.

**Fix:** Track a local `pendingDisabled` and prefer it over `setting?.disabled`
while `toggleBusy` is true, or use the `useConvexMutation` optimistic hooks.

---

### [P3] `closeReveal`'s `isPending` guard is dead code

**Location:** `apps/web/src/routes/app/settings/keys.tsx:161-167`

```tsx
function closeReveal() {
  if (createMutation.isPending || rotateMutation.isPending) return;
  setCreateOpen(false);
  setName("");
  setRevealed(null);
  setCopied(false);
}
```

**Problem:** The guard blocks closing the reveal dialog while a create/rotate
is pending. But the reveal dialog only opens **after** `onSuccess` sets
`revealed` — at which point `isPending` is already `false`. While the mutation
is pending, `revealed` is `null`, so the reveal dialog is closed and
`closeReveal` is never invoked. The guard can never be true at the moment
`closeReveal` runs. It is defensive dead code, giving a false sense of
safety around mid-flight dismissal.

**Fix:** Remove the guard, or — if the intent was to block dismissal during
a *future* in-flight re-mutation (e.g. copy-then-rotate-again), re-scope it
to the actual mutation the reveal dialog is bound to.

---

### [P3] Rotate / Revoke dialog Cancel buttons bypass the `isPending` close guard

**Location:** `apps/web/src/routes/app/settings/keys.tsx:343-349` (rotate
Cancel), `:395-401` (revoke Cancel)

```tsx
// rotate dialog onOpenChange:
onOpenChange={(open) => {
  if (!open && !rotateMutation.isPending) setRotateTarget(null);
}}
...
<Button
  type="button"
  variant="outline"
  onClick={() => setRotateTarget(null)}    // ← no isPending check
  disabled={rotateMutation.isPending}
  ...
>
  Cancel
</Button>
```

**Problem:** The `onOpenChange` handler and the `disabled` on the confirm
button both respect `rotateMutation.isPending`, but the **Cancel button**
calls `setRotateTarget(null)` directly — bypassing the guard. The Cancel
button itself is not `disabled={rotateMutation.isPending}`, so the user can
click Cancel mid-rotation, dismiss the dialog, and lose visibility into the
in-flight mutation (which continues in the background). Same asymmetric
pattern in the revoke dialog.

**Fix:** `disabled={rotateMutation.isPending}` on the Cancel button too, or
have Cancel route through the same guard as `onOpenChange`.

---

### [P3] `SettingView` / `SetCapFn` / `SetDisabledFn` locally re-defined — drift from Convex `KeySettingView`

**Location:** `apps/web/src/routes/app/settings/keys.tsx:417-437`

```tsx
type SettingView = {
  keyId: string;
  monthlyCapCredits?: number;
  disabled: boolean;
  rotatedFromKeyId?: string;
  graceUntil?: number;
  updatedAt: number;
};

type SetCapFn = (args: { keyId: string; monthlyCapCredits: number | null; }) => Promise<unknown>;
type SetDisabledFn = (args: { keyId: string; disabled: boolean; }) => Promise<unknown>;
```

**Problem:** `convex/keySettings.ts` already exports `KeySettingView` with the
same shape. The route re-defines `SettingView` locally instead of importing
`KeySettingView`. Likewise `SetCapFn` / `SetDisabledFn` are hand-rolled
signatures duplicating the Convex mutation arg shapes. If the Convex schema or
mutation adds/renames a field (e.g. a `hardCapCredits`), the route's type
silently drifts — TS will not flag it because the local type is structurally
compatible with the narrower shape. `useConvexMutation(api.keySettings.setCap)`
already produces a typed function; annotating it with a hand-rolled `SetCapFn`
discards that inference.

**Impact:** Drift risk; the route can render stale field sets while the Convex
source of truth moves on.

**Fix:** `import type { KeySettingView } from "#/lib/convex-api"` (re-export
from convex) and drop the local `SettingView`. Drop `SetCapFn`/`SetDisabledFn`
and let `useConvexMutation` infer the arg type.

---

### [P3] "24 hours" hardcoded in dialog / title strings — magic string detached from `ROTATION_GRACE_MS`

**Location:** `apps/web/src/routes/app/settings/keys.tsx:330` (rotate dialog
description), `:589` (rotate button title)

```tsx
<DialogDescription>
  {rotateTarget
    ? `"${rotateTarget.name}" keeps working for 24 hours while you switch over. A new secret is shown once.`
    : "A new key replaces this one."}
</DialogDescription>
...
<Button ... title="Rotate key (old key works 24h)">
```

**Problem:** The rotation grace duration is hardcoded as the literal string
"24 hours" / "24h" in two UI strings, while the actual value lives in
`ROTATION_GRACE_MS` in `apps/web/src/lib/api-keys.ts` (and, per the P1 fix,
should live in a Convex-side constant too). If the grace window is tuned, the
UI silently lies. Also: the reveal dialog (`SecretRevealDialog`) hardcodes
"for 24 hours" again at `:651`. Three independent magic strings.

**Fix:** Derive the display string from `ROTATION_GRACE_MS` (e.g.
`${ROTATION_GRACE_MS / 3600_000} hours`) or a shared `ROTATION_GRACE_LABEL`
constant.

---

### [P3] Cap input is clobbered by realtime `useEffect` while the user is editing

**Location:** `apps/web/src/routes/app/settings/keys.tsx:444-456`

```tsx
const [capInput, setCapInput] = useState(
  setting?.monthlyCapCredits === undefined ? "" : String(setting.monthlyCapCredits),
);

useEffect(() => {
  setCapInput(
    setting?.monthlyCapCredits === undefined
      ? ""
      : String(setting.monthlyCapCredits),
  );
}, [setting?.monthlyCapCredits]);
```

**Problem:** The `useEffect` resets `capInput` whenever the persisted
`monthlyCapCredits` changes. Because `getForOrg` is a realtime subscription, any
backend mutation that touches the row (including the user's own `setCap` round
trip, but also a concurrent admin / cron write) re-emits the document and
re-fires the effect — clobbering whatever the user is mid-typing. The user's
in-progress edit is lost without warning. The effect also fires on the local
mutation echo, so even on a stable connection there's a window between
`setCapInput` (user keystroke) and the realtime round-trip where the effect
can stomp the input.

**Fix:** Track a `dirty` / `isEditing` flag and skip the sync while the input
is focused or has unsaved changes; only sync from server when not editing.

---

### [P3] No-org-selected state surfaces as a query error instead of a redirect / CTA

**Location:** `apps/web/src/lib/api-keys.ts:79-83` (`listKeys` throws),
`keys.tsx:281-284` (renders the error)

```tsx
{keysQuery.isError ? (
  <p className="text-sm text-muted-foreground">
    {humanError(keysQuery.error, "Could not load keys")}
  </p>
) : ...
```

**Problem:** When the user has no active Clerk org, `listKeys` throws
`"Select an organization before managing API keys"`. The route renders that
string verbatim inside the table card as a muted paragraph — no org picker,
no redirect to the org switcher, no "Create key" disabling. The header still
shows the "Create key" button (since `hasKey` is false), which on click opens
the create dialog and then fails the same way on submit. The user is stuck in
an error loop with no path forward.

**Fix:** Detect the no-org condition at the route level (via `useOrganization`
or a loader guard) and render an org-picker CTA / redirect, rather than letting
the query throw and rendering the error inline.

---

### [P3] `useConvexAuth` not-authenticated branch shows skeleton forever, no error

**Location:** `apps/web/src/routes/app/settings/keys.tsx:62-71`

```tsx
const { isLoading: convexAuthLoading, isAuthenticated: convexAuthed } =
  useConvexAuth();

if (!isLoaded || convexAuthLoading) {
  return <KeysSkeleton />;
}
if (!convexAuthed) {
  return <KeysSkeleton />;
}
```

**Problem:** If Convex auth never authenticates (JWT misconfig, Convex outage,
clock skew), the route renders `<KeysSkeleton />` indefinitely — no error
state, no retry, no message. The user sees a perpetual loading skeleton with
no clue why. The `!convexAuthed` branch is indistinguishable from the loading
branch.

**Fix:** After a timeout, or if `convexAuthLoading` is false and
`!convexAuthed`, render an error / retry state instead of a skeleton.

---

### [P3] `formatMonthlyCap` is dead code — exported but unused outside its own test

**Location:** `apps/web/src/lib/key-cap.ts:25-28`

**Problem:** A repo-wide search shows `formatMonthlyCap` is imported only by
`key-cap.test.ts`. The keys route imports `parseMonthlyCap` only and renders
the cap via a raw `<Input type="number">` with a `"Unlimited"` placeholder —
`formatMonthlyCap` is never called. The committed cap value is shown only as
the raw input string, never grouped (`1,000`). Either wire it into the display
path or delete it.

**Fix:** Use it in `KeyRow` to render the committed cap (e.g. as a read-only
formatted value alongside or below the input), or remove it and its test.

---

### [P3] `parseMonthlyCap` accepts scientific notation, hex, and binary literals; no upper bound

**Location:** `apps/web/src/lib/key-cap.ts:14-22`

```ts
const n = Number(trimmed);
if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
  return { ok: false, error: CAP_ERROR };
}
return { ok: true, cap: n };
```

**Problem:** `Number("1e3")` → `1000`, `Number("0x10")` → `16`,
`Number("0b101")` → `5`, `Number("1e18")` → `1e18`,
`Number("999999999999999999999")` → a finite integer-representable double
beyond `Number.MAX_SAFE_INTEGER`. All pass. The test file even bakes
`parseMonthlyCap("1e3") === 1000` in as intended behavior. There is no upper
bound, so a user can set `monthlyCapCredits = 1e15` (the Convex `setCap`
mutation re-validates `>0` and integer but also has no max). A "cap" of 1
quadrillion credits is nonsensical and signals the validation is too loose.

**Impact:** Surprising input acceptance; no defense-in-depth against absurd
caps; precision loss for values beyond `MAX_SAFE_INTEGER`.

**Fix:** Add an explicit integer-string check (`/^\d+$/`) or
`Number.parseInt(trimmed, 10)` with a range guard `n <= MAX_CAP` (e.g. 1e9).
Reject scientific/hex/binary notation explicitly.

---

### [P3] `createKey` name validation doesn't reject control characters / newlines / zero-width chars

**Location:** `apps/web/src/lib/api-keys.ts:91-101`

```ts
const name = raw.trim();
if (name.length === 0) throw new Error("Name is required");
if (name.length > 64) throw new Error("Name must be 64 characters or fewer");
return { name };
```

**Problem:** `trim()` strips leading/trailing whitespace but a name like
`"prod\nkey\0malicious"` or one containing embedded RTL overrides / zero-width
chars passes. The name is rendered in the DOM (React escapes HTML, so no XSS)
and stored in Clerk, but control characters can corrupt logs, CLI output, and
audit trails, and zero-width chars enable lookalike-name confusion (two keys
named "prod" that look identical but differ by an invisible char).

**Fix:** Strip or reject control chars / zero-width / RTL override codepoints
before the length check: `name.replace(/[\u0000-\u001F\u202E\u200B-\u200D\uFEFF]/g, "")`.

---

## Summary

25 findings · P0: 0 · P1: 5 · P2: 8 · P3: 12

**Top 3:**

1. **P1 — Rotation is a two-phase write across Clerk + Convex with the secret
   revealed only in `onSuccess`.** A `recordRotation` failure permanently loses
   the new key's secret (show-once resource, never shown) and drops the old
   key's grace window. Compounded by `rotateKey` never revoking the old Clerk
   key at all — the old key stays valid at Clerk forever, defeating rotation's
   entire purpose. (`keys.tsx:139-152`, `api-keys.ts:226-253`)
2. **P1 — Client controls the grace window and the keyId namespace.**
   `recordRotation` accepts an unbounded client-supplied `graceUntil` (only
   "future" is checked), so a tampered client can immortalise a rotated key at
   the gateway. `setCap`/`setDisabled`/`recordRotation` trust client-supplied
   `keyId` for brand-new rows — an attacker can stamp their org onto a
   victim's keyId and permanently lock the victim out of their own key settings
   (shadow-row DoS via the global `by_key` index). (`keySettings.ts:122-142`,
   `:267-290`)
3. **P2 — Plaintext secret in the DOM with no auto-hide, and clipboard never
   cleared.** The copied secret lingers in the OS clipboard indefinitely (the
   1.5s timer resets only the button label), and the full secret is rendered
   in `<code>` for the entire duration the dialog is open with no timeout,
   mask-after-copy, or unmount-on-blur. (`keys.tsx:183-193`, `:632-660`)

**Correction to prior review:** the prior review's closing note ("no hardcoded
motion values") is wrong — `filter: "blur(8px)"` / `"blur(0px)"` at `:633-641`
are inlined literals not present in `motion.ts`.

**Confirmed clean:** `isPending` is used correctly for React Query v5 (the
local `isLoading = keysQuery.isPending` alias is semantically equivalent at
first-load); `humanError` does not leak internals (it masks `ConvexError`/
`Server Error`/`Uncaught` substrings and caps length at 200); no raw Tailwind
colors (all `bg-muted`/`text-destructive`/`border` semantic tokens);
skeletons present (`KeysSkeleton`/`KeysTableSkeleton`); `.mutate()` used in
handlers, `.mutateAsync()` not misused; reduced-motion respected via
`useReducedMotion`.
