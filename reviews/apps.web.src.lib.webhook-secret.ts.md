# Tiger Review — `apps/web/src/lib/webhook-secret.ts`

## Verdict

**REJECT.** The one function that ships (`maskSecret`) is acceptable for the real
73-char `uuid.uuid` server secret, but the module is 75% dead code kept alive by
a test file, the dead validators are actively wrong against the real secret
format, the generator's JSDoc lies about a fallback that does not exist, and the
only production caller leaks the raw secret into the DOM without
`autoComplete="off"` or `spellCheck={false}`. Delete the dead trio, fix the
DOM leak, and stop pretending the client generates secrets.

## File Stats

| Metric | Value |
|---|---|
| File | `apps/web/src/lib/webhook-secret.ts` |
| LOC | 44 |
| Exports | 4 (`toHex`, `generateWebhookSecret`, `isHexSecret`, `maskSecret`) |
| Production importers | 1 (`project-settings-panel.tsx` → `maskSecret` only) |
| Test importers | 1 (`webhook-secret.test.ts` → all 4) |
| Dead production exports | 3 of 4 (`toHex`, `generateWebhookSecret`, `isHexSecret`) |
| Real server secret format | `${crypto.randomUUID()}.${crypto.randomUUID()}` (`convex/webhooks.ts:44`) — 73 chars, contains `-` and `.` |

## Findings

### [SEV: P1] Raw secret rendered into DOM without `autoComplete="off"` / `spellCheck={false}`

**Location:** `apps/web/src/components/project-settings-panel.tsx:495-501`
```tsx
<Input
  id="webhook-secret"
  readOnly
  value={revealSecret ? endpoint.secret : maskSecret(endpoint.secret)}
  className="font-mono text-sm"
  aria-label="Webhook signing secret"
/>
```

**Problem:** When `revealSecret` is true the full signing secret is written into
the input's `.value` (and React's controlled-value attribute on first render).
The input has neither `autoComplete="off"` nor `spellCheck={false}` — both of
which the neighbouring URL input (`project-settings-panel.tsx:~470`) does set.
A readOnly input is still eligible for browser autofill heuristics on some
engines, and spell-check can transmit the field value to spell-check services.

**Impact:** Signing secret may be persisted in browser autofill history or
exfiltrated via spell-check. The secret is the only thing authenticating
inbound webhook deliveries — leaking it enables forged deliveries.

**Fix:**
```tsx
<Input
  id="webhook-secret"
  readOnly
  value={revealSecret ? endpoint.secret : maskSecret(endpoint.secret)}
  className="font-mono text-sm"
  aria-label="Webhook signing secret"
  autoComplete="off"
  spellCheck={false}
/>
```
Also consider auto-collapsing `revealSecret` after a timeout and on unmount so
the raw value does not sit in the DOM indefinitely.

---

### [SEV: P1] JSDoc claims a crypto fallback that does not exist

**Location:** `apps/web/src/lib/webhook-secret.ts:22-31`
```ts
/**
 * Generate `bytes` of cryptographically-random data as a hex string.
 * Default 32 bytes → 64 hex chars (256 bits), matching typical signing-secret
 * strength. Falls back gracefully if `crypto` is somehow unavailable.
 */
export function generateWebhookSecret(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return toHex(buf);
}
```

**Problem:** The docstring promises "Falls back gracefully if `crypto` is
somehow unavailable," but the body calls `globalThis.crypto.getRandomValues`
unconditionally — no `typeof` check, no `try/catch`, no `Math.random` fallback.
If `globalThis.crypto` is `undefined` (older runtime, broken polyfill, SSR
without `globalThis.crypto`), this throws `TypeError: Cannot read properties of
undefined (reading 'getRandomValues')`. The "graceful fallback" is fiction.

**Impact:** False security documentation. A caller trusting the JSDoc will not
wrap the call in error handling and will crash in any environment where
`crypto` is absent — exactly the scenario the docstring claims is handled.

**Fix:** Either implement the fallback (e.g. `crypto?.getRandomValues ?? throw`
with a typed error) or delete the sentence. Given this function is dead code
(see below), the right fix is deletion.

---

### [SEV: P2] Three of four exports are dead production code, kept alive only by tests

**Location:** `apps/web/src/lib/webhook-secret.ts:13` (`toHex`), `:27` (`generateWebhookSecret`), `:34` (`isHexSecret`)

**Problem:** A repo-wide grep for `webhook-secret` shows exactly one production
importer:
```
apps/web/src/components/project-settings-panel.tsx:35
  import { maskSecret } from "#/lib/webhook-secret";
```
`toHex`, `generateWebhookSecret`, and `isHexSecret` are imported **only** by
`webhook-secret.test.ts`. The module's own header JSDoc overstates the surface:
```ts
 * The client never chooses it. These helpers exist for hex formatting, length
 * validation, masking, and previews (used by tests + the settings card).
```
"used by tests + the settings card" is misleading — the settings card uses only
`maskSecret`. The hex trio exists to satisfy its own test file.

Worse, the premise is wrong: the real server secret
(`convex/webhooks.ts:44`) is `${crypto.randomUUID()}.${crypto.randomUUID()}` —
not hex, not generated by this client helper, and not even *validatable* by
`isHexSecret`. `generateWebhookSecret` generates a secret in a format the
server never produces and the client never sends.

**Impact:** Maintenance burden plus a false narrative that the client
participates in secret generation. Future contributors may wire
`generateWebhookSecret` into a real flow, assuming it matches the server
format — it does not.

**Fix:** Delete `toHex`, `generateWebhookSecret`, `isHexSecret`, `HEX_CHARS`,
and the corresponding `describe` blocks in the test. Keep only `maskSecret` and
its test. Update the module JSDoc to reflect that this is a display-only helper.

---

### [SEV: P2] `isHexSecret` regex uses `*` not `+` — accepts `"0x"` as a valid secret

**Location:** `apps/web/src/lib/webhook-secret.ts:34-36`
```ts
export function isHexSecret(s: string): boolean {
  return /^(0x)?[0-9a-f]*$/.test(s) && s.length > 0 && s.length % 2 === 0;
}
```

**Problem:** `[0-9a-f]*` (zero-or-more) combined with the optional `0x` prefix
means the regex matches the empty body. The `s.length > 0` guard catches `""`
but not `"0x"`:
- `isHexSecret("0x")` → regex matches (`0x` prefix + zero hex chars),
  `length === 2 > 0`, `2 % 2 === 0` → **returns `true`**.

A bare `"0x"` is not a valid hex secret by any definition. The `*` should be
`+` to require at least one hex digit.

A second bug lives in the even-length check: it counts the `0x` prefix toward
`length`, so `isHexSecret("0xab")` (one byte of hex, length 4) passes the
even check while `isHexSecret("0xabc")` (1.5 bytes, length 5) fails. The
"even length" invariant was meant to ensure whole bytes of hex, but the
implementation checks total string length including the prefix.

**Impact:** Latent — the function is dead code — but if resurrected it produces
false positives (`"0x"`) and applies the even-byte invariant incorrectly to
prefixed inputs.

**Fix (if kept):**
```ts
export function isHexSecret(s: string): boolean {
  const m = /^(0x)?([0-9a-f]+)$/.exec(s);
  return m !== null && m[2].length % 2 === 0;
}
```

---

### [SEV: P2] `isHexSecret` would reject every real server secret

**Location:** `apps/web/src/lib/webhook-secret.ts:34` vs `convex/webhooks.ts:44`

**Problem:** The real signing secret produced by `webhooks.upsertEndpoint` is
```ts
function generateSecret(): string {
  return `${crypto.randomUUID()}.${crypto.randomUUID()}`;
}
```
e.g. `a1b2c3d4-e5f6-7890-abcd-ef1234567890.0987f654-3210-dcba-0987-6543210fedcb`
— 73 chars containing `-` and `.`. `isHexSecret` rejects any string with `-`
or `.`, so **every real server secret returns `false`**.

The module is named `webhook-secret` and exports `isHexSecret` as a generic
"secret validator." Any future caller that reaches for it to validate a
server-returned secret will reject 100% of valid secrets.

**Impact:** Latent landmine. The function's name and location imply it is the
right validator for webhook secrets; it is the wrong validator for the actual
webhook secret format.

**Fix:** Delete `isHexSecret` (preferred, since it is dead), or rename it to
`isHexByteString` and document that it does NOT validate Zevium webhook
secrets.

---

### [SEV: P2] `maskSecret` reveal cliff: near-threshold secrets leak ~89%

**Location:** `apps/web/src/lib/webhook-secret.ts:38-44`
```ts
export function maskSecret(secret: string, edge = 4): string {
  if (secret.length <= edge * 2) return "•".repeat(secret.length);
  return `${secret.slice(0, edge)}${"•".repeat(
    Math.max(4, secret.length - edge * 2),
  )}${secret.slice(-edge)}`;
}
```

**Problem:** The full-mask branch triggers at `length <= edge * 2` (≤ 8 for
default `edge=4`). One char over the threshold (`length === 9`) flips to the
reveal branch, exposing `2 * edge = 8` of 9 chars — **89% disclosure** — while
the single masked char is padded with `Math.max(4, 9 - 8) = 4` bullets to look
like more is hidden than actually is. The `Math.max(4, …)` inflates the visual
mask without reducing the revealed surface.

For the real 73-char `uuid.uuid` secret this is benign (reveals 8/73 ≈ 11%),
but `maskSecret` is a generic exported helper. The cliff at `edge*2 + 1` is a
real disclosure bug for any short-but-over-threshold secret.

**Impact:** A secret of length 9–12 (e.g. a short API token, a truncated
credential passed through this helper) is rendered with 67–89% of its bytes
visible while the bullet count implies heavy masking.

**Fix:** Scale `edge` down for near-threshold lengths, or raise the full-mask
boundary:
```ts
export function maskSecret(secret: string, edge = 4): string {
  const e = Math.min(edge, Math.floor(secret.length / 4));
  if (e === 0) return "•".repeat(secret.length);
  if (secret.length <= e * 2) return "•".repeat(secret.length);
  return `${secret.slice(0, e)}${"•".repeat(secret.length - e * 2)}${secret.slice(-e)}`;
}
```
This guarantees at most 50% disclosure regardless of input length.

---

### [SEV: P2] `generateWebhookSecret(0)` returns `""` — an empty "secret"

**Location:** `apps/web/src/lib/webhook-secret.ts:27-31`
```ts
export function generateWebhookSecret(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return toHex(buf);
}
```

**Problem:** `bytes = 0` produces an empty `Uint8Array`, an empty hex string,
and returns `""`. An empty string is not a secret by any definition. The test
file even codifies this:
```ts
expect(generateWebhookSecret(0)).toHaveLength(0);
```
turning the bug into a regression-locked contract.

**Impact:** Latent (dead code), but if `generateWebhookSecret` is ever wired
into a real flow with an unvalidated `bytes` argument, an empty secret could be
issued and stored.

**Fix:** Throw on `bytes < 1` (or a sensible minimum like 16). Delete the
`toHaveLength(0)` assertion.

---

### [SEV: P3] `toHex` leans on non-null assertions needlessly

**Location:** `apps/web/src/lib/webhook-secret.ts:13-20`
```ts
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX_CHARS[(b >> 4) & 0xf]! + HEX_CHARS[b & 0xf]!;
  }
  return out;
}
```

**Problem:** Under `noUncheckedIndexedAccess`, `bytes[i]` and `HEX_CHARS[k]`
are `string | undefined`. The `!` asserts them away, but `bytes[i]` inside a
bounds-checked `for` loop is always defined, and `HEX_CHARS[k]` for `0 ≤ k ≤ 15`
is always defined. The assertions are correct but noisy; a reader must re-derive
the invariant each time. Prefer `Uint8Array.prototype.toHex()` (standard since
Node 20 / all modern browsers) or an index-free lookup.

**Impact:** Noise / readability. If this file is deleted (per the dead-code
finding), this dissolves.

**Fix:** `return bytes.toHex();` — or delete the function.

---

### [SEV: P3] Module JSDoc overstates the production surface

**Location:** `apps/web/src/lib/webhook-secret.ts:1-8`
```ts
/**
 * Client-side helpers for webhook signing-secret display.
 *
 * NOTE: Zevium's webhook endpoint secret is generated server-side by
 * `webhooks.upsertEndpoint` (Convex) and returned in the endpoint document.
 * The client never chooses it. These helpers exist for hex formatting, length
 * validation, masking, and previews (used by tests + the settings card).
 */
```

**Problem:** "used by tests + the settings card" implies the card consumes
the hex/length helpers. It does not — only `maskSecret` is imported by the card.
The header sells a four-function surface when one function ships.

**Impact:** Misleads readers about the module's role and the client's
involvement in secret handling.

**Fix:** After deleting the dead trio, trim the header to describe `maskSecret`
alone.

---

## Summary

| SEV | Count |
|---|---|
| P0 | 0 |
| P1 | 2 |
| P2 | 5 |
| P3 | 2 |
| **Total** | **9** |

**Top 3:**
1. **Secret input lacks `autoComplete="off"` / `spellCheck={false}`** — the only production leak path; the neighbouring URL input sets both, the secret input sets neither.
2. **`generateWebhookSecret` JSDoc lies about a graceful crypto fallback** that the body does not implement — false security documentation that will crash, not degrade, in the documented failure mode.
3. **3 of 4 exports are dead code** (`toHex`, `generateWebhookSecret`, `isHexSecret`) kept alive only by the test file — and `isHexSecret` is actively wrong against the real `uuid.uuid` server secret format, a latent landmine under a `webhook-secret` module name.
