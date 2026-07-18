# Tiger Review — `convex/auth.config.ts`

Trust root for Convex ↔ Clerk JWT validation. The OIDC provider form
(`{ domain, applicationID }`) is used: Convex fetches
`${domain}/.well-known/openid-configuration`, reads `issuer` + `jwks_uri` from
it, verifies the JWT signature against JWKS, and requires the JWT `aud` to
contain `applicationID`. The `iss` claim is validated against the `issuer`
value published in the discovery doc (which must equal `domain`).

## Verdict

**Incorrect — non-blocking defects present.** The config is structurally sound
(fail-closed on missing env, OIDC form correctly validates signature + `aud` +
`iss`), but the input-validation guard is leaky and `applicationID` is a magic
string with no per-deployment scoping. A supporting dead-code/role-mapping gap
in `convex/lib/auth.ts` compounds the trust-root picture.

## File Stats

- File under review: `convex/auth.config.ts` (15 lines)
- Context files read in full: `convex/lib/auth.ts`, `convex/users.ts`, `convex/organizations.ts`, `convex/schema.ts`, Convex `authentication.ts` (AuthProvider shape)
- No git diff present (committed at `c771e77`); entire file treated as the patch surface.

## Findings

---

### [SEV: P2] `CLERK_JWT_ISSUER_DOMAIN` validation accepts whitespace, scheme-less, and trailing-slash values

**Location:** `convex/auth.config.ts:3-6, 10`

```ts
const clerkIssuerDomain = process.env.CLERK_JWT_ISSUER_DOMAIN;
if (clerkIssuerDomain === undefined || clerkIssuerDomain.length === 0) {
  throw new Error("CLERK_JWT_ISSUER_DOMAIN is not configured");
}
// …
domain: clerkIssuerDomain,
```

**Problem.** The guard only rejects `undefined` and `""`. It accepts:

- Whitespace-only (`"   "`): `.length === 0` is false, so it passes; Convex then
  constructs `   /.well-known/openid-configuration`, fails discovery, and
  rejects **every** authenticated request with a cryptic server-side error.
- Scheme-less (`"foo.clerk.accounts.dev"`): OIDC discovery fetch needs an
  absolute URL; without a scheme the JWKS/issuer resolution is undefined and
  auth fails opaquely. `.env.example` shows the correct `https://` form, but
  nothing enforces it.
- Trailing slash (`"https://foo.clerk.accounts.dev/"`): discovery URL becomes
  `…accounts.dev//.well-known/openid-configuration` (double slash). Clerk's
  Frontend API host tolerates this today, but the contract is fragile; a host
  swap (custom domain, proxy) can silently 404 discovery and break auth.
- Path-bearing value (`"https://foo.clerk.accounts.dev/clerk"`): the `iss`
  published by Clerk is `https://foo.clerk.accounts.dev`; a path-segment
  mismatch silently rejects every token.

**Impact.** Auth is the root of every gated function in the marketplace
(wallet writes, spec publishing, admin ops). A single misconfigured env value
fails closed but with an error message (`CLERK_JWT_ISSUER_DOMAIN is not
configured`) that does **not** describe the actual problem, sending operators
on a long debugging detour. The validation claims to assert "is configured"
but does not assert "is a valid https issuer URL", which is the real invariant.

**Fix.**

```ts
const rawDomain = process.env.CLERK_JWT_ISSUER_DOMAIN?.trim();
if (rawDomain === undefined || rawDomain === "") {
  throw new Error("CLERK_JWT_ISSUER_DOMAIN is not configured");
}
let clerkIssuerDomain: string;
try {
  const url = new URL(rawDomain);
  if (url.protocol !== "https:") {
    throw new Error(`CLERK_JWT_ISSUER_DOMAIN must use https: ${rawDomain}`);
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(
      `CLERK_JWT_ISSUER_DOMAIN must not contain a path: ${rawDomain}`,
    );
  }
  // Strip trailing slash so discovery URL isn't double-slashed.
  clerkIssuerDomain = `${url.origin}`;
} catch (e) {
  throw new Error(
    `CLERK_JWT_ISSUER_DOMAIN is not a valid https URL: ${rawDomain} (${(e as Error).message})`,
  );
}
```

---

### [SEV: P2] `applicationID: "convex"` is a hardcoded magic string with no per-deployment scoping

**Location:** `convex/auth.config.ts:9-13`

```ts
providers: [
  {
    domain: clerkIssuerDomain,
    applicationID: "convex",
  },
],
```

**Problem.** `applicationID` is the **only** `aud`-claim gate in the trust
root. Two concerns:

1. **Cross-environment token replay.** If a staging deployment and a
   production deployment share a single Clerk instance (same issuer domain —
   a common setup for preview/stage environments branching off the prod Clerk
   instance), a JWT issued for staging satisfies production's auth config and
   vice versa: identical `iss` (same Clerk domain) + identical `aud`
   (`"convex"`). For a marketplace that holds prepaid org-scoped credits and
   runs payouts, a staging-issued token minting credits or modifying payouts in
   prod is a real privilege-boundary failure, not a hypothetical.

2. **Silent break on template rename.** Renaming the Clerk JWT template (and
   thus the `aud` claim) silently rejects every authenticated request with no
   deploy-time signal tying `applicationID` here to the template name in
   Clerk. There is no constant, no env binding, no assertion that the value
   matches the actual Clerk template.

The convention (Clerk + Convex tutorial uses `aud: "convex"`) is deliberate,
but the lack of any per-env differentiation or binding to the Clerk template
name is an emergent trust-root gap, not a deliberate security decision.

**Impact.** Trust root accepts any token whose `aud` contains the literal
`"convex"` from any deployment sharing this Clerk instance. The
`applicationID` is the sole application-scoping control and it is identical
across every environment by default.

**Fix.** Drive `applicationID` from env so each deployment can scope its own
audience (e.g. `convex-prod`, `convex-staging`), and name the Clerk template
to match.

```ts
const applicationID = process.env.CONVEX_JWT_AUDIENCE ?? "convex";
if (applicationID.trim() === "") {
  throw new Error("CONVEX_JWT_AUDIENCE is not configured");
}
// …
applicationID,
```

---

### [SEV: P3] `orgRole` is parsed and threaded through `OrgIdentityClaims` but never gates any operation; camelCase fallbacks are dead branches

**Location:** `convex/lib/auth.ts:21-39` (supporting context — the auth claim
extraction that auth.config.ts makes possible)

```ts
const raw = identity as Record<string, unknown>;
const orgId =
  typeof raw.org_id === "string"
    ? raw.org_id
    : typeof raw.orgId === "string"      // ← dead: Clerk emits snake_case
      ? raw.orgId
      : undefined;
// …
const orgRole =
  typeof raw.org_role === "string"
    ? raw.org_role
    : typeof raw.orgRole === "string"     // ← dead: Clerk emits snake_case
      ? raw.orgRole
      : undefined;
```

**Problem.** `orgRole` is extracted into `OrgIdentityClaims` and returned by
`requireIdentity` / `requireOrgMemberBySlug` / `requireProjectMember`, but a
codebase-wide search for `claims.orgRole` / `orgRole` consumers outside
`auth.ts` itself returns **zero** matches. No mutation or query in the
control plane gates on role; `requireOrgMemberBySlug` and
`requireProjectMember` check only `org.clerkOrgId === claims.orgId`
(membership), not role. So any `org:member` can perform every org-scoped
operation that an `org:admin` can (spec publishing, webhook/key-settings
management, etc.).

Whether that flat membership model is intended is a design question, but as
written the role field is dead data — parsed, typed, threaded, never read.
The camelCase `orgId` / `orgSlug` / `orgRole` fallback branches are also
dead: Clerk's JWT template emits `org_id` / `org_slug` / `org_role`
(snake_case), and every test fixture
(`deprecation.test.ts`, `keySettings.test.ts`, `notifications.test.ts`,
`usage.test.ts`, `webhooks.test.ts`) only ever sets the snake_case form.

**Impact.** Two maintenance hazards: (1) future code that assumes
`claims.orgRole` is enforced will be wrong; (2) the camelCase fallback gives
a false impression of multi-provider support that does not exist (the
codebase is Clerk-only). No runtime correctness impact today.

**Fix.** Either consume `orgRole` (e.g. gate destructive org operations on
`org:admin`) or drop the field from `OrgIdentityClaims` and its extraction.
Drop the camelCase fallbacks unless a second non-Clerk issuer is actually
planned.

```suggestion
const raw = identity as Record<string, unknown>;
const orgId = typeof raw.org_id === "string" ? raw.org_id : undefined;
const orgSlug = typeof raw.org_slug === "string" ? raw.org_slug : undefined;
const orgRole = typeof raw.org_role === "string" ? raw.org_role : undefined;
```

---

## Supporting observations (no formal findings)

- **`requireAdmin` / `isAdmin` use `identity.subject` (Clerk `sub`) compared
  against `ADMIN_USER_IDS` env.** Fails closed when env unset. Correct. The
  separate `requireAdminInAction` in `convex/admin.ts:321` re-implements the
  same logic rather than reusing `isAdmin` (action ctx vs mutation ctx), which
  is a small DRY gap but not a bug.
- **`ensureUser` / `ensureOrganization` mirror Clerk identity into Convex
  tables.** `ensureOrganization` correctly requires `claims.orgId ===
  args.clerkOrgId`, preventing client-invented org IDs. Good.
- **`listMine` returns only the active-org row**, not every org the user
  belongs to. This matches Clerk's active-org model; naming is slightly
  misleading but not incorrect.
- **`getBySlug` is a public query with no auth gate** — by design (catalogue
  discovery). Confirmed not a leak since orgs are public catalogue entities.

## Summary

- **3 findings:** 0×P0, 0×P1, 2×P2, 1×P3.
- **Top 3:**
  1. (P2) `CLERK_JWT_ISSUER_DOMAIN` validation accepts whitespace /
     scheme-less / trailing-slash / path-bearing values → opaque auth
     failures with a misleading error.
  2. (P2) `applicationID: "convex"` hardcoded with no per-deployment
     scoping → cross-env token replay when staging/prod share a Clerk
     instance, and silent break on template rename.
  3. (P3) `orgRole` parsed but never enforced; camelCase claim fallbacks
     are dead branches.
