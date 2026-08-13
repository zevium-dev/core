import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createClerkClient } from "@clerk/backend";

const ORG_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ORG_ID_RE = /^org_[A-Za-z0-9]+$/;
const MEMBERSHIP_ID_RE = /^orgmem_[A-Za-z0-9]+$/;
const USER_ID_RE = /^user_[A-Za-z0-9]+$/;
const KEY_ID_RE = /^ak_[A-Za-z0-9]+$/;
const PAGE_SIZE = 500;
const MAX_RELEASE_KEY_TTL_MS = 15 * 60 * 1000;
const CHILD_ENV_NAMES = new Set([
  "AGENT_BROWSER_BIN",
  "AGENT_BROWSER_EXECUTABLE_PATH",
  "AGENT_BROWSER_SESSION",
  "CI",
  "E2E_API_KEY",
  "E2E_ARTIFACTS",
  "E2E_BASE_URL",
  "E2E_EMAIL",
  "E2E_OTP",
  "E2E_ORG_SLUG",
  "E2E_PASSWORD",
  "E2E_SESSION",
  "GATEWAY_URL",
  "GITHUB_WORKSPACE",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "PNPM_HOME",
  "PWD",
  "RUNNER_ARCH",
  "RUNNER_OS",
  "RUNNER_TEMP",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TZ",
  "USER",
  "RELEASE_PROBE_CONTENT_TYPE",
  "RELEASE_PROBE_METERED_METHOD",
  "RELEASE_PROBE_METERED_PATH",
  "RELEASE_PROBE_MOCK_METHOD",
  "RELEASE_PROBE_MOCK_PATH",
  "RELEASE_PROBE_REQUEST_BODY",
  "RELEASE_PROBE_SECRET",
]);

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function record(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Clerk ${name} row has invalid schema`);
  }
  return value;
}

function organizationRow(value) {
  const row = record(value, "organization");
  if (!ORG_ID_RE.test(row.id ?? "") || !ORG_SLUG_RE.test(row.slug ?? "")) {
    throw new Error("Clerk organization row has invalid schema");
  }
  return row;
}

function membershipRow(value) {
  const row = record(value, "organization membership");
  const organization = record(
    row.organization,
    "organization membership organization",
  );
  const publicUserData = record(
    row.publicUserData,
    "organization membership user",
  );
  if (
    !MEMBERSHIP_ID_RE.test(row.id ?? "") ||
    !ORG_ID_RE.test(organization.id ?? "") ||
    !USER_ID_RE.test(publicUserData.userId ?? "") ||
    typeof row.role !== "string" ||
    row.role.trim() === "" ||
    !Array.isArray(row.permissions) ||
    row.permissions.some((permission) => typeof permission !== "string")
  ) {
    throw new Error("Clerk organization membership row has invalid schema");
  }
  return row;
}

function apiKeyRow(value) {
  const row = record(value, "API key");
  if (
    !KEY_ID_RE.test(row.id ?? "") ||
    row.type !== "api_key" ||
    typeof row.name !== "string" ||
    row.name.trim() === "" ||
    !USER_ID_RE.test(row.subject ?? "") ||
    !Array.isArray(row.scopes) ||
    row.scopes.some((scope) => typeof scope !== "string" || scope === "") ||
    (row.createdBy !== null && !USER_ID_RE.test(row.createdBy ?? "")) ||
    (row.claims !== null &&
      (typeof row.claims !== "object" || Array.isArray(row.claims))) ||
    typeof row.revoked !== "boolean" ||
    (row.revocationReason !== null &&
      typeof row.revocationReason !== "string") ||
    typeof row.expired !== "boolean" ||
    (row.expiration !== null &&
      (!Number.isSafeInteger(row.expiration) || row.expiration <= 0)) ||
    (row.description !== null && typeof row.description !== "string") ||
    (row.lastUsedAt !== null &&
      (!Number.isSafeInteger(row.lastUsedAt) || row.lastUsedAt <= 0)) ||
    !Number.isSafeInteger(row.createdAt) ||
    row.createdAt <= 0 ||
    !Number.isSafeInteger(row.updatedAt) ||
    row.updatedAt < row.createdAt ||
    row.secret !== undefined
  ) {
    throw new Error("Clerk API key row has invalid schema");
  }
  return row;
}

async function collectPages(fetchPage, name) {
  const rows = [];
  let offset = 0;
  let totalCount = null;
  while (totalCount === null || offset < totalCount) {
    const page = await fetchPage({ limit: PAGE_SIZE, offset });
    if (
      page === null ||
      !Array.isArray(page.data) ||
      !Number.isSafeInteger(page.totalCount) ||
      page.totalCount < 0
    ) {
      throw new Error(`Clerk ${name} returned invalid pagination metadata`);
    }
    if (totalCount !== null && page.totalCount !== totalCount) {
      throw new Error(`Clerk ${name} changed during pagination`);
    }
    totalCount = page.totalCount;
    if (page.data.length === 0 && offset < totalCount) {
      throw new Error(`Clerk ${name} pagination ended early`);
    }
    rows.push(...page.data);
    offset += page.data.length;
  }
  if (rows.length !== totalCount) {
    throw new Error(`Clerk ${name} pagination count mismatch`);
  }
  return rows;
}

function isActiveKey(key, now) {
  return (
    key.revoked === false &&
    key.expired === false &&
    Number.isSafeInteger(key.expiration) &&
    key.expiration > now &&
    key.expiration - now <= MAX_RELEASE_KEY_TTL_MS
  );
}

function keyMatches(key, { memberUserId, organizationId, keyId, now }) {
  return (
    (keyId === undefined || key.id === keyId) &&
    key.subject === memberUserId &&
    key.createdBy === memberUserId &&
    key.claims !== null &&
    key.claims?.org_id === organizationId &&
    isActiveKey(key, now)
  );
}

/** Resolve one exact active user-scoped key. No provider writes occur. */
export async function resolveClerkReleaseKey({
  client,
  orgSlug,
  memberUserId,
  keyId,
  now = Date.now(),
}) {
  if (!ORG_SLUG_RE.test(requiredString(orgSlug, "consumer org slug"))) {
    throw new Error("consumer org slug is not canonical");
  }
  if (
    !USER_ID_RE.test(requiredString(memberUserId, "consumer member user id"))
  ) {
    throw new Error("consumer member user id is invalid");
  }
  if (!KEY_ID_RE.test(requiredString(keyId, "release probe API key id"))) {
    throw new Error("release probe API key id is invalid");
  }
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new Error("resolver clock is invalid");
  }

  const organizations = await collectPages(
    ({ limit, offset }) =>
      client.organizations.getOrganizationList({
        query: orgSlug,
        limit,
        offset,
      }),
    "organizations",
  );
  const exactOrganizations = organizations
    .map(organizationRow)
    .filter((organization) => organization.slug === orgSlug);
  if (exactOrganizations.length !== 1) {
    throw new Error(
      `expected one exact Clerk organization, found ${exactOrganizations.length}`,
    );
  }
  const organization = exactOrganizations[0];

  const memberships = await collectPages(
    ({ limit, offset }) =>
      client.organizations.getOrganizationMembershipList({
        organizationId: organization.id,
        userId: [memberUserId],
        limit,
        offset,
      }),
    "organization memberships",
  );
  const exactMemberships = memberships
    .map(membershipRow)
    .filter(
      (membership) =>
        membership.publicUserData.userId === memberUserId &&
        membership.organization.id === organization.id,
    );
  if (exactMemberships.length !== 1) {
    throw new Error(
      `expected one exact Clerk organization membership, found ${exactMemberships.length}`,
    );
  }

  const keys = await collectPages(
    ({ limit, offset }) =>
      client.apiKeys.list({
        subject: memberUserId,
        includeInvalid: true,
        limit,
        offset,
      }),
    "API keys",
  );
  const matches = keys.map(apiKeyRow).filter((key) =>
    keyMatches(key, {
      memberUserId,
      organizationId: organization.id,
      keyId,
      now,
    }),
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected one exact short-lived active Clerk API key, found ${matches.length}`,
    );
  }

  const selected = matches[0];
  const secretResult = await client.apiKeys.getSecret(selected.id);
  const secret = secretResult?.secret;
  if (
    typeof secret !== "string" ||
    secret.length < 32 ||
    secret.length > 1024 ||
    !secret.startsWith("ak_") ||
    /[\r\n]/.test(secret)
  ) {
    throw new Error("Clerk returned invalid API key secret");
  }
  return {
    id: selected.id,
    secret,
    organizationId: organization.id,
    expiration: selected.expiration,
  };
}

function sanitizedChildEnvironment(secretName, secret) {
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      CHILD_ENV_NAMES.has(name) &&
      !name.startsWith("GITHUB_") &&
      !name.startsWith("ACTIONS_")
    ) {
      environment[name] = value;
    }
  }
  if (process.env.GITHUB_WORKSPACE !== undefined) {
    environment.GITHUB_WORKSPACE = process.env.GITHUB_WORKSPACE;
  }
  environment[secretName] = secret;
  return environment;
}

function parseArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error("resolver requires command after --");
  }
  const options = {};
  for (const token of argv.slice(0, separator)) {
    const match = token.match(/^--([a-z-]+)=(.*)$/s);
    if (!match) throw new Error(`invalid resolver argument: ${token}`);
    if (Object.hasOwn(options, match[1])) {
      throw new Error(`duplicate resolver argument: ${match[1]}`);
    }
    options[match[1]] = match[2];
  }
  const allowed = new Set([
    "clerk-secret-env",
    "org-slug",
    "member-user-id",
    "key-id",
    "child-env",
  ]);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name))
      throw new Error(`unknown resolver argument: ${name}`);
  }
  return { options, command: argv.slice(separator + 1) };
}

function runChild(command, env, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command[0], command.slice(1), {
      env,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`release probe command terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const { options, command } = parseArgs(argv);
  const secretEnv = options["clerk-secret-env"];
  if (secretEnv !== "CLERK_PRODUCTION_SECRET_KEY") {
    throw new Error("clerk secret env must name the production key");
  }
  const clerkSecret = requiredString(process.env[secretEnv], secretEnv);
  const requiredPrefix = "sk_live_";
  if (!clerkSecret.startsWith(requiredPrefix)) {
    throw new Error(`${secretEnv} has wrong Clerk instance type`);
  }
  const childEnvName = options["child-env"] || "RELEASE_PROBE_API_KEY";
  if (
    childEnvName !== "RELEASE_PROBE_API_KEY" &&
    childEnvName !== "E2E_API_KEY"
  ) {
    throw new Error("child env must be RELEASE_PROBE_API_KEY or E2E_API_KEY");
  }
  const client =
    dependencies.client ?? createClerkClient({ secretKey: clerkSecret });
  const now = dependencies.now?.() ?? Date.now();
  const resolved = await resolveClerkReleaseKey({
    client,
    orgSlug: options["org-slug"],
    memberUserId: options["member-user-id"],
    keyId: options["key-id"],
    now,
  });

  // First output after secret retrieval is runner masking. Secret never enters
  // GITHUB_ENV, GITHUB_OUTPUT, argv, artifact, or filesystem.
  (
    dependencies.mask ??
    ((value) => process.stdout.write(`::add-mask::${value}\n`))
  )(resolved.secret);
  let verified;
  try {
    verified = apiKeyRow(await client.apiKeys.verify(resolved.secret));
  } catch {
    throw new Error("Clerk API key verification failed");
  }
  if (
    verified.id !== resolved.id ||
    verified.expiration !== resolved.expiration ||
    !keyMatches(verified, {
      memberUserId: options["member-user-id"],
      organizationId: resolved.organizationId,
      keyId: resolved.id,
      now,
    })
  ) {
    throw new Error("Clerk API key verification no longer matches constraints");
  }
  const childEnv = sanitizedChildEnvironment(childEnvName, resolved.secret);
  let childFailure;
  try {
    const code = await runChild(command, childEnv, dependencies.spawnImpl);
    if (code !== 0)
      childFailure = new Error(`release probe command exited ${code}`);
  } catch (error) {
    childFailure = error;
  }
  const finishedAt = dependencies.now?.() ?? Date.now();
  let after;
  try {
    after = apiKeyRow(await client.apiKeys.verify(resolved.secret));
  } catch {
    throw new Error("Clerk API key post-probe revocation check failed");
  }
  if (
    after.id !== resolved.id ||
    after.expiration !== resolved.expiration ||
    !keyMatches(after, {
      memberUserId: options["member-user-id"],
      organizationId: resolved.organizationId,
      keyId: resolved.id,
      now: finishedAt,
    })
  ) {
    throw new Error("Clerk API key rotated, revoked, or expired during probe");
  }
  if (childFailure !== undefined) throw childFailure;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "key resolver failed",
    );
    process.exitCode = 1;
  });
}

export { MAX_RELEASE_KEY_TTL_MS };
