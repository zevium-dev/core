import { appendFile, lstat, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, relative, resolve, sep } from "node:path";
import { hash as blake3 } from "blake3-wasm";
import {
  AUDIENCE_PREFIX,
  buildManifest,
  manifestDigest,
  staticAssetContentType,
  type DeploymentProfile,
  type ModuleArtifactManifest,
  type StaticAssetArtifactManifest,
} from "../src/manifest.ts";
import { parseDeploymentReceipt } from "../src/receipt.ts";
import { parseStrictJson } from "../src/strict-json.ts";

const BROKER_ORIGIN = "https://deploy-broker.zevium.dev";
const PROFILE_VALUES: DeploymentProfile[] = [
  "preview-gateway",
  "preview-web",
  "preview-cleanup",
  "staging-gateway",
  "staging-web",
  "production-gateway",
  "production-web",
];

interface Arguments {
  dryRun: boolean;
  profile: DeploymentProfile;
  recoveryReceiptPath?: string;
  remoteDryRun: boolean;
}

function fail(message: string): never {
  throw new Error(`Deploy broker registration failed: ${message}`);
}

function parseArguments(argv: string[]): Arguments {
  let dryRun = false;
  let remoteDryRun = false;
  let recoveryReceiptPath: string | undefined;
  let profile: DeploymentProfile | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--remote-dry-run") {
      remoteDryRun = true;
      continue;
    }
    if (argument === "--profile") {
      const value = argv[index + 1];
      if (!value || !PROFILE_VALUES.includes(value as DeploymentProfile)) {
        fail("--profile is invalid");
      }
      profile = value as DeploymentProfile;
      index += 1;
      continue;
    }
    if (
      argument === "--recovery-receipt" &&
      recoveryReceiptPath === undefined
    ) {
      const value = argv[index + 1];
      if (!value) fail("--recovery-receipt is invalid");
      recoveryReceiptPath = value;
      index += 1;
      continue;
    }
    fail(`unknown argument ${JSON.stringify(argument)}`);
  }
  if (!profile) fail("--profile is required");
  if (dryRun && remoteDryRun) fail("dry-run modes are mutually exclusive");
  if (recoveryReceiptPath && !profile.startsWith("staging-")) {
    fail("recovery is staging-only");
  }
  return {
    dryRun,
    profile,
    ...(recoveryReceiptPath === undefined ? {} : { recoveryReceiptPath }),
    remoteDryRun,
  };
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) fail(`${name} is required`);
  return value;
}

function optionalInteger(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  if (!/^[1-9][0-9]{0,9}$/.test(value)) fail(`${name} is invalid`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) fail(`${name} is invalid`);
  return result;
}

const MODULE_CONTENT_TYPES = new Map<string, string>([
  [".bin", "application/octet-stream"],
  [".js", "application/javascript+module"],
  [".mjs", "application/javascript+module"],
  [".py", "application/python"],
  [".txt", "text/plain"],
  [".wasm", "application/wasm"],
]);

function normalizedRelative(root: string, path: string): string {
  const name = relative(root, path).split(sep).join("/");
  if (
    name === "" ||
    name.startsWith("../") ||
    name.includes("\\") ||
    name.includes("%") ||
    name.split("/").some((segment) => segment === "" || segment === ".")
  ) {
    fail("artifact path escaped inventory root");
  }
  return name;
}

async function inventoryFiles(rootInput: string): Promise<string[]> {
  const root = resolve(rootInput);
  const rootState = await lstat(root).catch(() => null);
  if (!rootState?.isDirectory() || rootState.isSymbolicLink()) {
    fail("artifact inventory root is not a real directory");
  }
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) fail("artifact inventory contains symlink");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else fail("artifact inventory contains unsupported file");
    }
  };
  await visit(root);
  return files;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function moduleInventory(
  rootInput: string,
): Promise<ModuleArtifactManifest[]> {
  const root = resolve(rootInput);
  const modules: ModuleArtifactManifest[] = [];
  for (const path of await inventoryFiles(root)) {
    const contentType = MODULE_CONTENT_TYPES.get(extname(path).toLowerCase());
    if (!contentType) continue;
    const bytes = await readFile(path);
    modules.push({
      contentType,
      name: normalizedRelative(root, path),
      sha256: sha256(bytes),
      size: bytes.byteLength,
    });
  }
  if (modules.length === 0) fail("module inventory is empty");
  return modules;
}

async function ignoredAssetPaths(root: string): Promise<Set<string>> {
  const path = resolve(root, ".assetsignore");
  const source = await readFile(path, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  const ignored = new Set<string>([".assetsignore"]);
  for (const raw of source.split(/\r?\n/)) {
    const value = raw.trim();
    if (value === "" || value.startsWith("#")) continue;
    if (
      value.startsWith("/") ||
      value.includes("\\") ||
      value.includes("..") ||
      /[*?[\]{}!]/.test(value)
    ) {
      fail(".assetsignore must contain literal relative paths");
    }
    ignored.add(value);
  }
  return ignored;
}

async function staticAssetInventory(
  rootInput: string,
): Promise<StaticAssetArtifactManifest[]> {
  const root = resolve(rootInput);
  const ignored = await ignoredAssetPaths(root);
  const assets: StaticAssetArtifactManifest[] = [];
  for (const path of await inventoryFiles(root)) {
    const name = normalizedRelative(root, path);
    if (ignored.has(name)) continue;
    const bytes = await readFile(path);
    const extension = extname(path).slice(1);
    const cloudflareHash = Buffer.from(
      blake3(`${Buffer.from(bytes).toString("base64")}${extension}`),
    )
      .toString("hex")
      .slice(0, 32);
    assets.push({
      cloudflareHash,
      contentType: staticAssetContentType(`/${name}`),
      path: `/${name}`,
      sha256: sha256(bytes),
      size: bytes.byteLength,
    });
  }
  return assets;
}

export async function readResponseBounded(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength) ||
      Number(declaredLength) > maximumBytes)
  ) {
    fail("remote response is too large");
  }
  if (!response.body) fail("remote response is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel("response limit exceeded");
      fail("remote response is too large");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("remote response is not UTF-8");
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    fail("remote response is not JSON");
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readRecoveryReceipt(pathInput: string) {
  const path = resolve(pathInput);
  const state = await lstat(path).catch(() => null);
  if (
    !state?.isFile() ||
    state.isSymbolicLink() ||
    (state.mode & 0o777) !== 0o600 ||
    state.size < 2 ||
    state.size > 512 * 1024
  ) {
    fail("recovery receipt must be a bounded 0600 regular file");
  }
  const bytes = await readFile(path);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("recovery receipt is not UTF-8");
  }
  const receipt = parseDeploymentReceipt(parseStrictJson(source));
  if (
    !receipt.profile.startsWith("staging-") ||
    receipt.recovery !== null ||
    receipt.priorDeploymentId === null ||
    receipt.priorVersionId === null
  ) {
    fail("recovery receipt does not authorize a staging prior deployment");
  }
  return { digest: sha256(bytes), receipt };
}

async function requestOidcToken(audience: string): Promise<string> {
  const endpoint = new URL(requiredEnvironment("ACTIONS_ID_TOKEN_REQUEST_URL"));
  if (
    endpoint.protocol !== "https:" ||
    (!endpoint.hostname.endsWith(".actions.githubusercontent.com") &&
      endpoint.hostname !== "actions.githubusercontent.com") ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  ) {
    fail("GitHub OIDC endpoint is invalid");
  }
  endpoint.searchParams.set("audience", audience);
  const response = await fetch(endpoint, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${requiredEnvironment("ACTIONS_ID_TOKEN_REQUEST_TOKEN")}`,
    },
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    fail("GitHub OIDC redirect was rejected");
  }
  if (response.status !== 200)
    fail(`GitHub OIDC returned HTTP ${response.status}`);
  const value = await readResponseBounded(response, 64 * 1024);
  if (
    !isRecord(value) ||
    typeof value.value !== "string" ||
    value.value.length > 16_384 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.value)
  ) {
    fail("GitHub OIDC response token is invalid");
  }
  return value.value;
}

export async function buildFromEnvironment(
  profile: DeploymentProfile,
  options: {
    recoveryReceipt?: Awaited<ReturnType<typeof readRecoveryReceipt>>;
  } = {},
) {
  const prNumber = optionalInteger("PR_NUMBER");
  const sourceRunId = process.env.SOURCE_RUN_ID;
  const secretSources = profile.endsWith("-gateway")
    ? [
        {
          environmentName: "CLERK_SECRET_KEY",
          name: "CLERK_SECRET_KEY",
        },
        {
          environmentName: "GATEWAY_INTERNAL_SECRET",
          name: "GATEWAY_INTERNAL_SECRET",
        },
      ]
    : profile.endsWith("-web")
      ? [
          {
            environmentName: "CLERK_SECRET_KEY",
            name: "CLERK_SECRET_KEY",
          },
        ]
      : [];
  const secretDigests = secretSources.map(({ environmentName, name }) => ({
    name,
    sha256: createHash("sha256")
      .update(requiredEnvironment(environmentName), "utf8")
      .digest("hex"),
  }));
  const cleanup = profile === "preview-cleanup";
  const recoveryReceipt = options.recoveryReceipt;
  if (recoveryReceipt) {
    const { receipt } = recoveryReceipt;
    if (
      receipt.profile !== profile ||
      receipt.gitSha !== requiredEnvironment("DEPLOY_HEAD_SHA") ||
      receipt.target !==
        (profile === "staging-gateway"
          ? "zevium-gateway-staging"
          : "zevium-web-staging")
    ) {
      fail("recovery receipt does not match current staging release target");
    }
  }
  const modules =
    cleanup || recoveryReceipt
      ? []
      : await moduleInventory(requiredEnvironment("DEPLOY_MODULE_ROOT"));
  const staticAssets =
    profile.endsWith("-web") && !recoveryReceipt
      ? await staticAssetInventory(requiredEnvironment("DEPLOY_ASSET_ROOT"))
      : [];
  return buildManifest({
    ...(process.env.CONVEX_SITE_URL
      ? { convexSiteUrl: process.env.CONVEX_SITE_URL }
      : {}),
    ...(process.env.VITE_CONVEX_URL
      ? { convexUrl: process.env.VITE_CONVEX_URL }
      : {}),
    eventName: requiredEnvironment("GITHUB_EVENT_NAME") as
      "pull_request" | "workflow_dispatch" | "workflow_run",
    headSha: requiredEnvironment("DEPLOY_HEAD_SHA"),
    ...(cleanup || recoveryReceipt
      ? {}
      : { mainModule: requiredEnvironment("DEPLOY_MAIN_MODULE") }),
    ...(modules.length === 0 ? {} : { modules }),
    oidcSha: requiredEnvironment("GITHUB_SHA"),
    ...(prNumber === undefined ? {} : { prNumber }),
    profile,
    ref: requiredEnvironment("GITHUB_REF"),
    ...(recoveryReceipt
      ? {
          recovery: {
            failedDeploymentId: recoveryReceipt.receipt.deploymentId,
            failedManifestDigest: recoveryReceipt.receipt.manifestDigest,
            failedVersionId: recoveryReceipt.receipt.versionId,
            priorDeploymentId: recoveryReceipt.receipt.priorDeploymentId!,
            priorVersionId: recoveryReceipt.receipt.priorVersionId!,
            sourceReceiptDigest: recoveryReceipt.digest,
          },
        }
      : {}),
    runAttempt: Number(requiredEnvironment("GITHUB_RUN_ATTEMPT")),
    runId: requiredEnvironment("GITHUB_RUN_ID"),
    ...(secretDigests.length === 0 ? {} : { secretDigests }),
    ...(sourceRunId ? { sourceRunId } : {}),
    ...(staticAssets.length === 0 ? {} : { staticAssets }),
  });
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const recoveryReceipt = arguments_.recoveryReceiptPath
    ? await readRecoveryReceipt(arguments_.recoveryReceiptPath)
    : undefined;
  const manifest = await buildFromEnvironment(
    arguments_.profile,
    recoveryReceipt === undefined ? {} : { recoveryReceipt },
  );
  const digest = await manifestDigest(manifest);
  const audience = `${AUDIENCE_PREFIX}${digest}`;

  if (arguments_.dryRun) {
    process.stdout.write(
      `${JSON.stringify({ audience, manifest, manifestDigest: digest }, null, 2)}\n`,
    );
    return;
  }

  const token = await requestOidcToken(audience);
  const endpoint = arguments_.remoteDryRun
    ? "/v1/manifest/dry-run"
    : "/v1/manifest";
  const response = await fetch(`${BROKER_ORIGIN}${endpoint}`, {
    body: JSON.stringify(manifest),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    fail("broker redirect was rejected");
  }
  const value = await readResponseBounded(response, 128 * 1024);
  if (response.status < 200 || response.status >= 300) {
    const code =
      isRecord(value) &&
      isRecord(value.error) &&
      typeof value.error.code === "string"
        ? value.error.code
        : "unknown_error";
    fail(`broker returned HTTP ${response.status} (${code})`);
  }
  if (arguments_.remoteDryRun) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (
    !isRecord(value) ||
    typeof value.apiBaseUrl !== "string" ||
    !new RegExp(
      `^${BROKER_ORIGIN.replaceAll(".", "\\.")}/sessions/[0-9a-f]{64}/client/v4$`,
    ).test(value.apiBaseUrl) ||
    typeof value.expiresAt !== "number"
  ) {
    fail("broker registration response is invalid");
  }
  const brokerEnvironment = requiredEnvironment("BROKER_ENV_FILE");
  const brokerEnvironmentState = await lstat(brokerEnvironment).catch(
    () => null,
  );
  if (
    !brokerEnvironmentState?.isFile() ||
    brokerEnvironmentState.isSymbolicLink() ||
    (brokerEnvironmentState.mode & 0o777) !== 0o600
  ) {
    fail("BROKER_ENV_FILE must be a 0600 regular file");
  }
  process.stdout.write(`::add-mask::${token}\n`);
  await appendFile(
    brokerEnvironment,
    `CLOUDFLARE_API_BASE_URL=${value.apiBaseUrl}\nCLOUDFLARE_API_TOKEN=${token}\nCLOUDFLARE_DEPLOY_MANIFEST_DIGEST=${digest}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  process.stdout.write(
    `Registered ${arguments_.profile} broker session ${digest.slice(0, 12)} (expires ${new Date(value.expiresAt).toISOString()})\n`,
  );
}

if (import.meta.main) await main();
