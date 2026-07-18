# Tiger Review — `apps/web/src/routes/app/settings/keys.tsx`

Scope: full file. Cross-read: `apps/web/src/lib/api-keys.ts`, `apps/web/src/lib/key-cap.ts`,
`convex/keySettings.ts`, `apps/web/src/lib/motion.ts`, `apps/web/src/lib/human-error.ts`.

## Verdict

Incorrect. Two correctness/security blockers in the rotation path (secret loss on
partial failure; unbounded grace window), plus a clipboard-hygiene gap and a
client-controlled keyId trust boundary in the Convex control-plane mutations.

## File Stats

- File: `apps/web/src/routes/app/settings/keys.tsx` (763 lines)
- Supporting: `convex/keySettings.ts`, `apps/web/src/lib/api-keys.ts`
- No uncommitted diff; full-file review.
- Findings: 7 (P0: 0, P1: 2, P2: 2, P3: 3)

## Findings

---

### [P1] Rotation loses the new secret when `recordRotation` fails

**Location:** `apps/web/src/routes/app/settings/keys.tsx:139-150`

```tsx
  const rotateMutation = useMutation({
    mutationFn: async (target: ApiKeyRow): Promise<RotateApiKeyResult> => {
      const created = await rotateKey({ data: { id: target.id } });
      await recordRotation({
        oldKeyId: target.id,
        newKeyId: created.id,
        graceUntil: created.graceUntil,
      });
      return created;
    },
    onSuccess: (created) => {
      setRevealed(created);
      ...
```

**Problem:** `mutationFn` performs two writes across independent systems — Clerk
key creation (`rotateKey`) then Convex metadata (`recordRotation`). If
`recordRotation` rejects (network blip, Convex validation error, transient
auth), the entire mutation rejects and `onSuccess` never runs, so
`setRevealed(created)` is skipped. But the Clerk key was **already created**:
the new secret exists only in the `created` local variable, which is discarded
on the throw path. `onError` shows a generic "Could not rotate API key" toast.

**Impact:** The user now has a new Clerk API key whose secret was shown exactly
once (never) — it is unrecoverable. The old key's `graceUntil` was never
recorded, so the gateway may not honour the 24h overlap. The user is forced to
rotate again, burning another key, and may believe the rotation simply failed
and continue using the old (now-ungraced) key. This is the canonical
two-phase-write footgun and it sits on a security-critical, show-once resource.

**Fix:** Either (a) move the Convex write server-side into `rotateKey` so the
TanStack server fn orchestrates both and the client only reveals what the server
returned, or (b) surface the secret before/decoupled from `recordRotation` and
make the Convex write best-effort with a reconciling toast on failure:

```tsx
  mutationFn: async (target: ApiKeyRow): Promise<RotateApiKeyResult> => {
    const created = await rotateKey({ data: { id: target.id } });
    try {
      await recordRotation({
        oldKeyId: target.id,
        newKeyId: created.id,
        graceUntil: created.graceUntil,
      });
    } catch {
      // Secret must still be revealed; grace can be reconciled separately.
      toast.error("Key rotated, but grace sync failed — old key may not overlap.");
    }
    return created;
  },
```

---

### [P1] `recordRotation` accepts an unbounded `graceUntil` — old key immortal

**Location:** `convex/keySettings.ts:276-278` (called from
`apps/web/src/routes/app/settings/keys.tsx:142-145`)

```ts
    if (!Number.isFinite(args.graceUntil) || args.graceUntil <= Date.now()) {
      throw new Error("graceUntil must be a future timestamp");
    }
```

**Problem:** The mutation validates only that `graceUntil` is finite and in the
future. There is no upper bound. `recordRotation` is a public Convex mutation —
any authenticated member of any org can call it directly with
`graceUntil: Date.now() + 10 * 365 * 86400_000`. The web client passes
`created.graceUntil` (24h, from the `rotateKey` server fn), but nothing stops a
tampered client from substituting an arbitrary value.

**Impact:** The gateway wallet DO honours `graceUntil` to keep the old key live
during cutover. An attacker (or a compromised/buggy client) can pin a rotated —
i.e. supposedly superseded — key as valid at the gateway for years, defeating
the entire purpose of rotation. If the old key was rotated *because it was
compromised*, the compromise is silently perpetuated.

**Fix:** Cap server-side against the canonical grace constant:

```ts
    const MAX_GRACE = Date.now() + 24 * 60 * 60 * 1000 + 60_000; // 24h + 1min skew
    if (!Number.isFinite(args.graceUntil) || args.graceUntil <= Date.now()) {
      throw new Error("graceUntil must be a future timestamp");
    }
    if (args.graceUntil > MAX_GRACE) {
      throw new Error("graceUntil exceeds the rotation grace window");
    }
```

---

### [P2] Copied secret is never cleared from the clipboard

**Location:** `apps/web/src/routes/app/settings/keys.tsx:183-191`

```tsx
  async function copySecret() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.secret);
      setCopied(true);
      toast.success("Copied to clipboard");
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy — select and copy manually");
    }
  }
```

**Problem:** The 1500 ms `setTimeout` resets only the local `copied` icon state.
The secret itself stays in the system clipboard indefinitely, readable by any
foreground application. The dialog copy says "store it somewhere safe" while
simultaneously leaving it in the least-safe transient store with no expiry.

**Impact:** Credential exposure window is unbounded and entirely client-side;
clipboard managers persist it to disk indefinitely. This is the one place in
the app where a raw credential touches the clipboard, so the bar should be
higher than for ordinary copy.

**Fix:** Clear the clipboard after a short window (and re-write only if the
clipboard still holds our secret, to avoid clobbering a user copy in the
meantime):

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

### [P2] `setCap` / `setDisabled` / `recordRotation` trust client-supplied `keyId` without Clerk ownership proof

**Location:** `convex/keySettings.ts:168-179` (`upsertSetting` →
`insertSetting`), `98-113` (`getOwnedRow`)

```ts
async function upsertSetting(ctx, clerkOrgId, keyId, patch) {
  const existing = await getOwnedRow(ctx, clerkOrgId, keyId);
  if (existing !== null) {
    return await patchSetting(ctx, existing._id, patch);
  }
  return await insertSetting(ctx, clerkOrgId, keyId, patch); // stamps CALLER's org
}
```

**Problem:** Ownership is enforced only when a `keySettings` row already exists
(`getOwnedRow` throws on cross-org mismatch). On the **insert** path — when no
row yet exists for the supplied `keyId` — the backend stamps the row with the
*caller's* `clerkOrgId` and never verifies with Clerk that the `keyId` actually
belongs to the caller (or to the caller's org). The module comment explicitly
admits the assumption: *"the web only ever passes keyIds it listed from Clerk
filtered to that org."* But the Convex mutations are a public authenticated
API, not the web UI.

**Impact:** An authenticated user who learns another org's Clerk keyId (e.g.
from a leaked log, a shared curl command, a support ticket) and races the
victim before they create their own `keySettings` row can `setDisabled({
keyId, disabled: true })` / `setCap({ keyId, monthlyCapCredits: 1 })` and:
(a) disable or starve the victim's key at the gateway (`toGatewayRow` strips
`clerkOrgId`, so the gateway looks the row up by `keyId` globally), and
(b) permanently lock the victim out of managing their own key's settings —
every subsequent `setCap`/`setDisabled` call from the victim throws
`"Key not found"` because the row's `clerkOrgId` is the attacker's. Clerk keyIds
are not trivially guessable, which is why this is P2 not P1, but the trust
boundary is real and the failure mode is silent and permanent.

**Fix:** Before inserting, verify the `keyId` belongs to a Clerk key owned by
the caller's subject and scoped to `clerkOrgId` (mirror the `org_id` claim
filter used in `listKeys`), or have the `rotateKey`/`createKey` server fns
themselves call the Convex mutation so the client never supplies the `keyId`.

---

### [P3] `graceActive` badge goes stale after grace expiry

**Location:** `apps/web/src/routes/app/settings/keys.tsx:513-514`

```tsx
  const graceActive =
    setting?.graceUntil !== undefined && setting.graceUntil > Date.now();
```

**Problem:** `graceActive` is computed at render time from `Date.now()`. There
is no timer and the Convex document does not change when grace lapses, so the
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
rotation's `onSuccess`/`onError` wiring is clobbered.

**Impact:** Confusing UX and a real double-rotation hazard if the user double
confirms quickly. The asymmetric guarding between Revoke and Rotate is clearly
unintentional.

**Fix:** Pass `rotateMutation.isPending` down as `rotatePending` and disable
the row Rotate button (and the rotate dialog stays bound to the original
target).

---

### [P3] Enable/disable Switch has no optimistic update — reverts then snaps

**Location:** `apps/web/src/routes/app/settings/keys.tsx:462-485`
(`commitToggle`) and `:548-555` (`Switch` binding)

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

**Impact:** Visible flicker / perceived non-responsiveness on every toggle,
worse on slow networks. Not a correctness bug.

**Fix:** Track a local `pendingDisabled` and prefer it over `setting?.disabled`
while `toggleBusy` is true, or use the `useConvexMutation` optimistic hooks.

---

## Summary

7 findings · P0: 0 · P1: 2 · P2: 2 · P3: 3

Top 3:
1. **P1** — Rotation is a two-phase write (Clerk + Convex) with the secret
   revealed only in `onSuccess`; a `recordRotation` failure permanently loses
   the new key's secret and drops the old key's grace window.
2. **P1** — `recordRotation` validates `graceUntil` only as "future"; a
   client-controlled value can immortalise a rotated (potentially compromised)
   key at the gateway.
3. **P2** — Copied secret is never cleared from the clipboard; the 1500 ms
   timer resets only the icon.

Note: no raw Tailwind colors, no hardcoded motion values (uses `DUR.base`/`EASE`),
skeletons present (`KeysSkeleton`/`KeysTableSkeleton`), `isPending` used
correctly for React Query, `humanError` does not leak internals. The gaps are
concentrated in the rotation/secret lifecycle and the Convex mutation trust
boundary.
