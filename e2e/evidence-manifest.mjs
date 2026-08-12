#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoSensitiveText } from "./artifact-sanitizer.mjs";

const LANES = [
  "preview",
  "auth",
  "publisher",
  "consumer",
  "paid-consumer",
  "payment",
];
const RESULT_STATUSES = ["passed", "failed", "excluded", "skipped"];
const REQUIRED_CONTRACTS = {
  preview: ["anonymous"],
  auth: ["anonymous", "signed-in"],
  publisher: ["signed-in"],
  consumer: ["anonymous"],
  "paid-consumer": ["signed-in"],
  payment: ["signed-in"],
};
const ORG_ROLES = new Set(["org:owner", "org:admin", "org:member"]);

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function assertRealDirectoryAncestor(path, label) {
  let current = resolve(path);
  while (true) {
    try {
      assertRealDirectory(current, label);
      return;
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function readState(path) {
  assertRealDirectoryAncestor(dirname(path), "manifest state directory");
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("manifest state must be a regular non-symlink file");
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { contracts: [], results: [], targets: [] };
    }
    throw error;
  }
}

function assertRealDirectory(path, label) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  if (realpathSync(path) !== resolve(path)) {
    throw new Error(`${label} may not traverse symlinks`);
  }
}

function assertSafeMetadata(value, label) {
  const serialized = String(value ?? "");
  assertNoSensitiveText(serialized);
  if (/\r|\n|\0/.test(serialized)) {
    throw new Error(`${label} must be one line`);
  }
}

function writeState(path, state) {
  assertRealDirectoryAncestor(dirname(path), "manifest state directory");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertRealDirectory(dirname(path), "manifest state directory");
  const temporary = `${path}.tmp`;
  try {
    lstatSync(temporary);
    throw new Error("manifest temporary state already exists");
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

function parseObservedContract(raw) {
  let value = JSON.parse(raw);
  if (typeof value === "string") value = JSON.parse(value);
  const width = Number(value.viewport?.width);
  const height = Number(value.viewport?.height);
  const dpr = Number(value.viewport?.devicePixelRatio);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 240 ||
    height < 240 ||
    !Number.isFinite(dpr) ||
    dpr <= 0
  ) {
    throw new Error("browser contract has invalid observed viewport");
  }
  if (value.colorScheme !== "light" && value.colorScheme !== "dark") {
    throw new Error("browser contract has invalid observed color scheme");
  }
  if (typeof value.reducedMotion !== "boolean") {
    throw new Error("browser contract lacks reduced-motion observation");
  }
  const userId =
    typeof value.auth?.userId === "string" && value.auth.userId.trim() !== ""
      ? value.auth.userId
      : null;
  const organizationId =
    typeof value.auth?.organizationId === "string" &&
    value.auth.organizationId.trim() !== ""
      ? value.auth.organizationId
      : null;
  const role = ORG_ROLES.has(value.auth?.role) ? value.auth.role : null;
  return {
    viewport: { width, height, devicePixelRatio: dpr },
    colorScheme: value.colorScheme,
    reducedMotion: value.reducedMotion,
    auth: {
      clerkUserPresent: userId !== null,
      userSha256: userId === null ? null : sha256(userId),
      organizationSha256:
        organizationId === null ? null : sha256(organizationId),
      role,
    },
  };
}

export function appendContract(statePath, metadata, rawContract) {
  if (!LANES.includes(metadata.lane)) throw new Error("unknown manifest lane");
  if (metadata.authMode !== "anonymous" && metadata.authMode !== "signed-in") {
    throw new Error("invalid auth mode");
  }
  assertSafeMetadata(metadata.context, "browser context");
  if (
    !/^[a-z0-9][a-z0-9-]{0,127}$/.test(metadata.context) ||
    !Number.isInteger(Number(metadata.requestedWidth)) ||
    !Number.isInteger(Number(metadata.requestedHeight)) ||
    Number(metadata.requestedWidth) < 240 ||
    Number(metadata.requestedHeight) < 240 ||
    !["light", "dark"].includes(metadata.requestedColorScheme) ||
    !["reduce", "no-preference"].includes(metadata.requestedReducedMotion)
  ) {
    throw new Error("invalid requested browser contract");
  }
  if (metadata.authMode === "signed-in" && !metadata.email) {
    throw new Error("signed-in browser contract requires fixture identity");
  }
  const observed = parseObservedContract(rawContract);
  if (metadata.authMode === "anonymous" && observed.auth.clerkUserPresent) {
    throw new Error("anonymous browser contract contains signed-in identity");
  }
  if (
    metadata.authMode === "anonymous" &&
    (observed.auth.organizationSha256 || observed.auth.role)
  ) {
    throw new Error(
      "anonymous browser contract contains organization identity",
    );
  }
  if (metadata.authMode === "signed-in" && !observed.auth.clerkUserPresent) {
    throw new Error("signed-in browser contract has no Clerk identity");
  }
  if (
    metadata.authMode === "signed-in" &&
    (!observed.auth.organizationSha256 || !observed.auth.role)
  ) {
    throw new Error(
      "signed-in browser contract has no active organization identity",
    );
  }
  if (
    observed.viewport.width !== Number(metadata.requestedWidth) ||
    observed.viewport.height !== Number(metadata.requestedHeight) ||
    observed.colorScheme !== metadata.requestedColorScheme ||
    observed.reducedMotion !== (metadata.requestedReducedMotion === "reduce")
  ) {
    throw new Error(
      "observed browser contract differs from requested evidence settings",
    );
  }

  const state = readState(statePath);
  state.contracts = state.contracts.filter(
    (contract) =>
      contract.lane !== metadata.lane ||
      contract.context !== metadata.context ||
      contract.authIdentity?.mode !== metadata.authMode,
  );
  state.contracts.push({
    lane: metadata.lane,
    context: metadata.context,
    requested: {
      viewport: {
        width: Number(metadata.requestedWidth),
        height: Number(metadata.requestedHeight),
      },
      colorScheme: metadata.requestedColorScheme,
      reducedMotion: metadata.requestedReducedMotion === "reduce",
    },
    observed,
    authIdentity: {
      mode: metadata.authMode,
      emailSha256:
        metadata.authMode === "signed-in" ? sha256(metadata.email) : null,
      ...observed.auth,
    },
  });
  writeState(statePath, state);
}

export function appendResult(statePath, result) {
  if (!LANES.includes(result.lane)) throw new Error("unknown manifest lane");
  if (!RESULT_STATUSES.includes(result.status)) {
    throw new Error("unknown manifest result status");
  }
  assertSafeMetadata(result.proof, "result proof");
  const durationSeconds = Number(result.durationSeconds ?? 0);
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds < 0 ||
    !result.proof
  ) {
    throw new Error("invalid manifest result metadata");
  }
  const state = readState(statePath);
  state.results = state.results.filter((entry) => entry.lane !== result.lane);
  state.results.push({
    lane: result.lane,
    status: result.status,
    durationSeconds,
    proof: result.proof,
  });
  writeState(statePath, state);
}

function assertFullCommit(value, label) {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} must be a full lowercase Git SHA`);
  }
}

export function appendTargetCheck(statePath, target) {
  if (!LANES.includes(target.lane)) throw new Error("unknown manifest lane");
  assertSafeMetadata(target.baseUrl, "target base URL");
  assertFullCommit(target.expectedCommit, "expected commit");
  assertFullCommit(target.observedCommit, "observed commit");
  let url;
  try {
    url = new URL(target.baseUrl);
  } catch {
    throw new Error("target base URL must be absolute");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("target base URL must use HTTP(S)");
  }
  if (target.expectedCommit !== target.observedCommit) {
    throw new Error("observed target commit does not match expected commit");
  }
  const state = readState(statePath);
  state.targets ??= [];
  state.targets = state.targets.filter((entry) => entry.lane !== target.lane);
  state.targets.push({
    lane: target.lane,
    baseUrl: target.baseUrl,
    expectedCommit: target.expectedCommit,
    observedCommit: target.observedCommit,
  });
  writeState(statePath, state);
}

function git(repoRoot, args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function buildManifest({
  statePath,
  outputPath,
  repoRoot,
  baseUrl,
  expectedCommit,
  runId,
}) {
  const state = readState(statePath);
  assertSafeMetadata(baseUrl, "base URL");
  assertSafeMetadata(runId, "run id");
  assertFullCommit(expectedCommit, "expected commit");
  let targetUrl;
  try {
    targetUrl = new URL(baseUrl);
  } catch {
    throw new Error("base URL must be an absolute HTTP URL");
  }
  if (
    !["http:", "https:"].includes(targetUrl.protocol) ||
    targetUrl.username ||
    targetUrl.password ||
    targetUrl.search ||
    targetUrl.hash ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(runId) ||
    !Array.isArray(state.contracts) ||
    !Array.isArray(state.results) ||
    !Array.isArray(state.targets)
  ) {
    throw new Error("invalid manifest target, run id, or state shape");
  }
  assertNoSensitiveText(JSON.stringify(state));
  if (
    state.results.some(
      (result) =>
        !LANES.includes(result.lane) ||
        !RESULT_STATUSES.includes(result.status) ||
        !Number.isFinite(result.durationSeconds) ||
        result.durationSeconds < 0 ||
        !result.proof,
    ) ||
    state.contracts.some(
      (contract) =>
        !LANES.includes(contract.lane) ||
        !["anonymous", "signed-in"].includes(contract.authIdentity?.mode),
    )
  ) {
    throw new Error("manifest state contains invalid contract or result");
  }
  const missing = LANES.filter(
    (lane) => !state.results.some((result) => result.lane === lane),
  );
  if (missing.length > 0) {
    throw new Error(
      `manifest lacks explicit results for lanes: ${missing.join(", ")}`,
    );
  }
  for (const result of state.results) {
    if (result.status !== "passed") continue;
    const target = state.targets.find((entry) => entry.lane === result.lane);
    if (
      target?.baseUrl !== baseUrl ||
      target?.expectedCommit !== expectedCommit ||
      target?.observedCommit !== expectedCommit
    ) {
      throw new Error(
        `passed lane ${result.lane} lacks matching target build proof`,
      );
    }
    for (const authMode of REQUIRED_CONTRACTS[result.lane]) {
      if (
        !state.contracts.some(
          (contract) =>
            contract.lane === result.lane &&
            contract.authIdentity?.mode === authMode,
        )
      ) {
        throw new Error(
          `passed lane ${result.lane} lacks ${authMode} browser contract`,
        );
      }
    }
  }
  const passedLanes = new Set(
    state.results
      .filter((result) => result.status === "passed")
      .map((result) => result.lane),
  );
  const signedContracts = state.contracts.filter(
    (contract) =>
      passedLanes.has(contract.lane) &&
      contract.authIdentity?.mode === "signed-in",
  );
  for (const field of ["userSha256", "organizationSha256", "emailSha256"]) {
    if (
      new Set(signedContracts.map((contract) => contract.authIdentity[field]))
        .size > 1
    ) {
      throw new Error(
        `passed lanes used inconsistent signed identity: ${field}`,
      );
    }
  }
  const parent = dirname(outputPath);
  assertRealDirectoryAncestor(parent, "manifest output directory");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertRealDirectory(parent, "manifest output directory");
  try {
    lstatSync(outputPath);
    throw new Error("manifest output must be a new file");
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }

  const status = git(repoRoot, ["status", "--porcelain=v1"]);
  const diff = execFileSync("git", ["diff", "--binary", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const results = LANES.map((lane) =>
    state.results.find((result) => result.lane === lane),
  );
  const lanesPassed = results.every((result) => result.status === "passed");
  const hasFailures = results.some((result) => result.status === "failed");
  const worktreeClean = status === "";
  const fullCoverage = lanesPassed && worktreeClean;
  const sourceCommit = git(repoRoot, ["rev-parse", "HEAD"]);
  if (sourceCommit !== expectedCommit) {
    throw new Error("expected commit does not match source HEAD");
  }
  const manifest = {
    schemaVersion: 2,
    runId,
    generatedAt: new Date().toISOString(),
    source: {
      commit: sourceCommit,
      worktreeClean,
      trackedDiffSha256: sha256(diff),
      statusSha256: sha256(status),
    },
    target: {
      baseUrl,
      expectedCommit,
      observedCommit: expectedCommit,
      laneChecks: state.targets,
    },
    browserContracts: state.contracts,
    results,
    summary: {
      lanesPassed,
      hasFailures,
      fullCoverage,
      label: fullCoverage
        ? "FULL E2E PASS"
        : hasFailures
          ? "E2E FAILURES RECORDED"
          : "REQUESTED E2E LANES COMPLETE",
    },
  };
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return manifest;
}

function requiredFlag(name) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(3).find((arg) => arg.startsWith(prefix));
  if (!value) throw new Error(`missing ${prefix}<value>`);
  return value.slice(prefix.length);
}

function main() {
  const [command, stateArg] = process.argv.slice(2);
  if (!command || !stateArg) {
    throw new Error(
      "usage: evidence-manifest.mjs <contract|target|result|build> <state> ...",
    );
  }
  const statePath = resolve(stateArg);
  if (command === "contract") {
    const raw = readFileSync(0, "utf8");
    appendContract(
      statePath,
      {
        lane: requiredFlag("lane"),
        context: requiredFlag("context"),
        authMode: requiredFlag("auth-mode"),
        requestedWidth: requiredFlag("width"),
        requestedHeight: requiredFlag("height"),
        requestedColorScheme: requiredFlag("color"),
        requestedReducedMotion: requiredFlag("motion"),
        email: process.env.E2E_EMAIL ?? "",
      },
      raw,
    );
    return;
  }
  if (command === "result") {
    appendResult(statePath, {
      lane: requiredFlag("lane"),
      status: requiredFlag("status"),
      durationSeconds: requiredFlag("duration"),
      proof: requiredFlag("proof"),
    });
    return;
  }
  if (command === "target") {
    appendTargetCheck(statePath, {
      lane: requiredFlag("lane"),
      baseUrl: requiredFlag("base-url"),
      expectedCommit: requiredFlag("expected"),
      observedCommit: requiredFlag("observed"),
    });
    return;
  }
  if (command === "build") {
    const manifest = buildManifest({
      statePath,
      outputPath: resolve(requiredFlag("output")),
      repoRoot: resolve(requiredFlag("repo")),
      baseUrl: requiredFlag("base-url"),
      expectedCommit: requiredFlag("expected-commit"),
      runId: requiredFlag("run-id"),
    });
    process.stdout.write(`${manifest.summary.label}\n`);
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[evidence-manifest] ${error.message}\n`);
    process.exitCode = 1;
  }
}
