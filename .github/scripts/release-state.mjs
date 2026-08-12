import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

const TRANSITIONS = new Map([
  [
    "rollback_pointers_captured_no_traffic_mutation",
    "artifacts_uploaded_no_traffic_mutation",
  ],
  ["artifacts_uploaded_no_traffic_mutation", "convex_mutation_started"],
  ["convex_mutation_started", "convex_expanded"],
  ["convex_expanded", "gateway_active"],
  ["gateway_active", "web_active"],
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeState(path, state) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const VERSION_RE =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;

function versionId(value, context) {
  const id = value?.version_id ?? value?.versionId ?? value?.id;
  if (!VERSION_RE.test(id ?? "")) {
    throw new Error(`Invalid Cloudflare version id in ${context}`);
  }
  return id;
}

function percentage(value, context) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  ) {
    throw new Error(`Invalid Cloudflare traffic percentage in ${context}`);
  }
  return value;
}

function validateManifest(manifest) {
  if (
    manifest?.schemaVersion !== 2 ||
    !SHA_RE.test(manifest.release) ||
    !SHA_RE.test(manifest.activeBase) ||
    !DIGEST_RE.test(manifest.lifecycle?.digest) ||
    !["none", "expand", "contract"].includes(manifest.lifecycle?.phase) ||
    typeof manifest.lifecycle?.rollbackAllowed !== "boolean" ||
    !VERSION_RE.test(manifest.gateway?.previousVersion) ||
    !VERSION_RE.test(manifest.gateway?.candidateVersion) ||
    !VERSION_RE.test(manifest.web?.previousVersion) ||
    !VERSION_RE.test(manifest.web?.candidateVersion) ||
    !Number.isSafeInteger(manifest.source?.runId) ||
    manifest.source.runId <= 0 ||
    manifest.source.workflowPath !==
      (manifest.lifecycle?.rollbackAllowed
        ? ".github/workflows/deploy-production.yml"
        : ".github/workflows/gateway-do-lifecycle.yml") ||
    !Number.isSafeInteger(manifest.source.runAttempt) ||
    manifest.source.runAttempt <= 0
  ) {
    throw new Error("Recovery manifest is invalid or incomplete");
  }
  return manifest;
}

function validateIntent(intent) {
  if (
    intent?.schemaVersion !== 2 ||
    !SHA_RE.test(intent.release) ||
    !SHA_RE.test(intent.activeBase) ||
    !DIGEST_RE.test(intent.lifecycle?.digest) ||
    !["none", "expand", "contract"].includes(intent.lifecycle?.phase) ||
    typeof intent.lifecycle?.rollbackAllowed !== "boolean" ||
    !VERSION_RE.test(intent.gateway?.previousVersion) ||
    !VERSION_RE.test(intent.web?.previousVersion) ||
    !Number.isSafeInteger(intent.source?.runId) ||
    intent.source.runId <= 0 ||
    intent.source.workflowPath !==
      (intent.lifecycle?.rollbackAllowed
        ? ".github/workflows/deploy-production.yml"
        : ".github/workflows/gateway-do-lifecycle.yml") ||
    !Number.isSafeInteger(intent.source.runAttempt) ||
    intent.source.runAttempt <= 0
  ) {
    throw new Error("Recovery intent is invalid or incomplete");
  }
  return intent;
}

export function validateRecoveryArtifact(input) {
  const hasGatewayCandidate = input?.gateway?.candidateVersion !== undefined;
  const hasWebCandidate = input?.web?.candidateVersion !== undefined;
  if (hasGatewayCandidate !== hasWebCandidate) {
    throw new Error("Recovery artifact has a partial candidate identity");
  }
  if (hasGatewayCandidate) {
    validateManifest(input);
    return "manifest";
  }
  validateIntent(input);
  return "intent";
}

export function recoveryPlan(manifestInput, observed, strategy) {
  const manifest = validateManifest(manifestInput);
  if (!["auto", "roll-forward", "rollback"].includes(strategy)) {
    throw new Error("Recovery strategy is invalid");
  }
  for (const component of ["gateway", "web"]) {
    const value = observed[component];
    if (
      value !== manifest[component].previousVersion &&
      value !== manifest[component].candidateVersion
    ) {
      throw new Error(
        `${component} active version is outside recovery manifest`,
      );
    }
  }
  // Persisted pre-mutation manifest cannot prove how far a cancelled job got.
  // Only separately recovered final state evidence may authorize rollback.
  const state = manifest.lastVerifiedState;
  const controlPlaneMayHaveChanged =
    typeof state !== "string" ||
    state !== "rollback_pointers_captured_no_traffic_mutation";
  const selected =
    strategy === "auto"
      ? controlPlaneMayHaveChanged
        ? "roll-forward"
        : manifest.lifecycle.rollbackAllowed
          ? "rollback"
          : "roll-forward"
      : strategy;
  if (selected === "rollback" && !manifest.lifecycle.rollbackAllowed) {
    throw new Error("Lifecycle manifest prohibits rollback");
  }
  if (selected === "rollback" && controlPlaneMayHaveChanged) {
    throw new Error("Rollback cannot undo an ambiguous Convex mutation");
  }
  const key = selected === "rollback" ? "previousVersion" : "candidateVersion";
  return {
    action: selected,
    release: manifest.release,
    gatewayVersion: manifest.gateway[key],
    webVersion: manifest.web[key],
    requiresConvexRollForward:
      selected === "roll-forward" && controlPlaneMayHaveChanged,
  };
}

export function activeVersion(path) {
  const deployments = readJson(path);
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error(`No Cloudflare deployments in ${path}`);
  }
  // Wrangler emits deployment history oldest -> newest. Rollback must capture
  // current tail entry, never first historical deployment.
  const versions = deployments.at(-1)?.versions;
  if (!Array.isArray(versions) || versions.length !== 1) {
    throw new Error(
      `Latest Cloudflare deployment is not a single-version release in ${path}`,
    );
  }
  const active = versions[0];
  if (percentage(active?.percentage, path) !== 100) {
    throw new Error(`Latest Cloudflare deployment is not at 100% in ${path}`);
  }
  return versionId(active, path);
}

export function uploadedVersion(path) {
  const records = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const uploads = records.filter((record) => record?.type === "version-upload");
  if (uploads.length !== 1) {
    throw new Error(`Expected one uploaded version record in ${path}`);
  }
  return versionId(uploads[0], path);
}

export function verifyZeroTraffic(path, previousVersion, candidateVersion) {
  const deployments = readJson(path);
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error("Cloudflare zero-traffic deployment metadata is missing");
  }
  const versions = deployments.at(-1)?.versions;
  if (!Array.isArray(versions) || versions.length !== 2) {
    throw new Error("Expected exactly two zero-traffic deployment versions");
  }
  const weights = new Map(
    versions.map((version) => [
      versionId(version, path),
      percentage(version?.percentage, path),
    ]),
  );
  if (
    weights.get(previousVersion) !== 100 ||
    weights.get(candidateVersion) !== 0 ||
    weights.size !== 2
  ) {
    throw new Error("Cloudflare zero-traffic deployment weights drifted");
  }
  return true;
}

export function boundedDeploymentVersion(
  path,
  previousVersion,
  candidateVersion,
) {
  const deployments = readJson(path);
  const versions = Array.isArray(deployments)
    ? deployments.at(-1)?.versions
    : null;
  if (!Array.isArray(versions) || versions.length < 1 || versions.length > 2) {
    throw new Error("Cloudflare deployment shape is outside recovery bounds");
  }
  let total = 0;
  let candidateTraffic = 0;
  const seen = new Set();
  for (const version of versions) {
    const id = versionId(version, path);
    const weight = percentage(version?.percentage, path);
    if ((id !== previousVersion && id !== candidateVersion) || seen.has(id)) {
      throw new Error(
        "Cloudflare deployment contains duplicate or unrecorded version",
      );
    }
    seen.add(id);
    total += weight;
    if (id === candidateVersion) candidateTraffic += weight;
  }
  if (total !== 100)
    throw new Error("Cloudflare deployment weights do not total 100");
  return candidateTraffic > 0 ? candidateVersion : previousVersion;
}

function readRollbackVersion(directory, component) {
  const path = `${directory}/${component}-after-rollback.json`;
  try {
    return activeVersion(path);
  } catch {
    return null;
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
}

export function run(argv = process.argv.slice(2)) {
  const [command, directory, ...args] = argv;
  if (typeof directory !== "string" || directory.length === 0) {
    throw new Error("Evidence directory is required");
  }
  if (command === "get-active-version") {
    process.stdout.write(activeVersion(directory));
    return;
  }
  if (command === "get-uploaded-version") {
    process.stdout.write(uploadedVersion(directory));
    return;
  }
  if (command === "verify-zero-traffic") {
    const path = process.env.DEPLOYMENTS;
    const previous = process.env.EXPECTED_PREVIOUS;
    const candidate = process.env.EXPECTED_CANDIDATE;
    if (!path || !previous || !candidate) {
      throw new Error("Zero-traffic verification environment is incomplete");
    }
    verifyZeroTraffic(path, previous, candidate);
    return;
  }
  if (command === "get-bounded-version") {
    const [previous, candidate] = args;
    if (!previous || !candidate) {
      throw new Error("Bounded deployment versions are required");
    }
    process.stdout.write(
      boundedDeploymentVersion(directory, previous, candidate),
    );
    return;
  }
  if (command === "validate-recovery") {
    process.stdout.write(
      validateRecoveryArtifact(readJson(`${directory}/recovery-manifest.json`)),
    );
    return;
  }
  const statePath = `${directory}/state.json`;

  if (command === "capture") {
    mkdirSync(directory, { recursive: true });
    const gatewayPath = `${directory}/gateway-before.json`;
    const webPath = `${directory}/web-before.json`;
    try {
      const state = {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        state: "rollback_pointers_captured_no_traffic_mutation",
        gateway: { previousVersion: activeVersion(gatewayPath) },
        web: { previousVersion: activeVersion(webPath) },
      };
      writeState(statePath, state);
    } finally {
      if (existsSync(gatewayPath)) unlinkSync(gatewayPath);
      if (existsSync(webPath)) unlinkSync(webPath);
    }
    return;
  }

  if (command === "uploaded") {
    const gatewayPath = `${directory}/gateway-upload.ndjson`;
    const webPath = `${directory}/web-upload.ndjson`;
    try {
      const state = readJson(statePath);
      if (state.state !== "rollback_pointers_captured_no_traffic_mutation") {
        throw new Error(
          `Cannot record uploads from release state: ${state.state}`,
        );
      }
      state.gateway.candidateVersion = uploadedVersion(gatewayPath);
      state.web.candidateVersion = uploadedVersion(webPath);
      state.state = "artifacts_uploaded_no_traffic_mutation";
      state.updatedAt = new Date().toISOString();
      writeState(statePath, state);
    } finally {
      if (existsSync(gatewayPath)) unlinkSync(gatewayPath);
      if (existsSync(webPath)) unlinkSync(webPath);
    }
    return;
  }

  if (command === "intent") {
    const [
      release,
      activeBase,
      digest,
      phase,
      rollbackAllowed,
      runId,
      workflowPath,
      runAttempt,
    ] = args;
    if (rollbackAllowed !== "true" && rollbackAllowed !== "false") {
      throw new Error("rollbackAllowed must be true or false");
    }
    const state = readJson(statePath);
    if (state.state !== "rollback_pointers_captured_no_traffic_mutation") {
      throw new Error(`Cannot create recovery intent from ${state.state}`);
    }
    const intent = validateIntent({
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      state: state.state,
      release,
      activeBase,
      lifecycle: {
        digest,
        phase,
        rollbackAllowed: rollbackAllowed === "true",
      },
      source: {
        runId: Number(runId),
        workflowPath,
        runAttempt: Number(runAttempt),
      },
      gateway: { previousVersion: state.gateway.previousVersion },
      web: { previousVersion: state.web.previousVersion },
    });
    writeState(`${directory}/recovery-manifest.json`, intent);
    return intent;
  }

  if (command === "manifest") {
    const [
      release,
      activeBase,
      digest,
      phase,
      rollbackAllowed,
      runId,
      workflowPath,
      runAttempt,
    ] = args;
    const state = readJson(statePath);
    if (state.state !== "artifacts_uploaded_no_traffic_mutation") {
      throw new Error(`Cannot create recovery manifest from ${state.state}`);
    }
    if (rollbackAllowed !== "true" && rollbackAllowed !== "false") {
      throw new Error("rollbackAllowed must be true or false");
    }
    const intent = validateIntent(
      readJson(`${directory}/recovery-manifest.json`),
    );
    const manifest = validateManifest({
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      state: state.state,
      release,
      activeBase,
      lifecycle: {
        digest,
        phase,
        rollbackAllowed: rollbackAllowed === "true",
      },
      source: {
        runId: Number(runId),
        workflowPath,
        runAttempt: Number(runAttempt),
      },
      gateway: { ...state.gateway },
      web: { ...state.web },
    });
    if (
      intent.release !== manifest.release ||
      intent.activeBase !== manifest.activeBase ||
      intent.lifecycle.digest !== manifest.lifecycle.digest ||
      intent.lifecycle.phase !== manifest.lifecycle.phase ||
      intent.lifecycle.rollbackAllowed !== manifest.lifecycle.rollbackAllowed ||
      intent.source.runId !== manifest.source.runId ||
      intent.source.workflowPath !== manifest.source.workflowPath ||
      intent.source.runAttempt !== manifest.source.runAttempt ||
      intent.gateway.previousVersion !== manifest.gateway.previousVersion ||
      intent.web.previousVersion !== manifest.web.previousVersion
    ) {
      throw new Error("Final recovery manifest differs from persisted intent");
    }
    writeState(`${directory}/recovery-manifest.json`, manifest);
    return manifest;
  }

  if (command === "get") {
    const state = readJson(statePath);
    const component = args[0];
    const versionKind = args[1] ?? "previous";
    if (component !== "gateway" && component !== "web") {
      throw new Error(`Invalid rollback component: ${component}`);
    }
    if (versionKind !== "previous" && versionKind !== "candidate") {
      throw new Error(`Invalid version kind: ${versionKind}`);
    }
    const id = state[component]?.[`${versionKind}Version`];
    if (typeof id !== "string") {
      throw new Error(`Missing ${component} ${versionKind} version`);
    }
    process.stdout.write(id);
    return;
  }

  if (command === "mark") {
    const next = args[0];
    const state = readJson(statePath);
    const expected = TRANSITIONS.get(state.state);
    if (next !== expected) {
      throw new Error(`Invalid release transition: ${state.state} -> ${next}`);
    }
    state.state = next;
    state.updatedAt = new Date().toISOString();
    writeState(statePath, state);
    return;
  }

  if (command === "ambiguous") {
    mkdirSync(directory, { recursive: true });
    const signal = args[0] ?? "unknown";
    const state = existsSync(statePath)
      ? readJson(statePath)
      : { schemaVersion: 2, state: "failed_before_state_capture" };
    const lastVerifiedState = state.lastVerifiedState ?? state.state;
    state.lastVerifiedState = lastVerifiedState;
    state.state = "ambiguous_recovery_required";
    state.ambiguity = {
      recordedAt: new Date().toISOString(),
      signal,
    };
    writeState(statePath, state);
    if (existsSync(`${directory}/recovery-manifest.json`)) {
      const rawManifest = readJson(`${directory}/recovery-manifest.json`);
      const manifest = rawManifest.gateway?.candidateVersion
        ? validateManifest(rawManifest)
        : validateIntent(rawManifest);
      manifest.lastVerifiedState = lastVerifiedState;
      manifest.state = "ambiguous_recovery_required";
      manifest.ambiguity = state.ambiguity;
      writeState(`${directory}/recovery-manifest.json`, manifest);
    }
    return state;
  }

  if (command === "plan-recovery") {
    const strategy = args[0];
    const manifest = validateManifest(
      readJson(`${directory}/recovery-manifest.json`),
    );
    const gatewayActive =
      typeof manifest.observed?.gateway === "string"
        ? manifest.observed.gateway
        : activeVersion(`${directory}/gateway-current.json`);
    const webActive =
      typeof manifest.observed?.web === "string"
        ? manifest.observed.web
        : activeVersion(`${directory}/web-current.json`);
    const plan = recoveryPlan(
      manifest,
      { gateway: gatewayActive, web: webActive },
      strategy,
    );
    writeState(`${directory}/recovery-plan.json`, plan);
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return plan;
  }

  if (command === "recovery-final") {
    const [gatewayReady, webReady, accountingReady] = args;
    const manifest = validateManifest(
      readJson(`${directory}/recovery-manifest.json`),
    );
    const plan = readJson(`${directory}/recovery-plan.json`);
    const gatewayActive = readRollbackVersion(directory, "gateway");
    const webActive = readRollbackVersion(directory, "web");
    const verified =
      gatewayReady === "true" &&
      webReady === "true" &&
      accountingReady === "true" &&
      gatewayActive === plan.gatewayVersion &&
      webActive === plan.webVersion;
    const evidence = {
      schemaVersion: 2,
      finishedAt: new Date().toISOString(),
      release: manifest.release,
      action: plan.action,
      verified,
    };
    writeState(`${directory}/recovery-result.json`, evidence);
    if (!verified) throw new Error("Recovery provider or paid proof failed");
    return evidence;
  }

  if (command === "final") {
    const [release, web, gateway] = args;
    mkdirSync(directory, { recursive: true });
    const state = existsSync(statePath)
      ? readJson(statePath)
      : { schemaVersion: 1, state: "failed_before_artifact_upload" };
    const lastVerifiedState = state.state;
    state.finishedAt = new Date().toISOString();
    state.release = release;
    state.endpoints = { web, gateway };
    state.outcome = process.env.RELEASE_JOB_STATUS ?? "unknown";
    if (state.outcome === "success") {
      if (lastVerifiedState !== "web_active") {
        throw new Error(
          `Cannot verify incomplete release state: ${lastVerifiedState}`,
        );
      }
      state.state = "verified";
    } else {
      state.lastVerifiedState = lastVerifiedState;
      if (
        lastVerifiedState === "failed_before_artifact_upload" ||
        lastVerifiedState === "rollback_pointers_captured_no_traffic_mutation"
      ) {
        state.state = "aborted_without_traffic_change";
      } else state.state = "ambiguous_recovery_required";
    }
    writeState(statePath, state);
    return;
  }

  throw new Error(
    "Usage: release-state.mjs get-active-version|get-uploaded-version|get-bounded-version|verify-zero-traffic|validate-recovery|capture|intent|uploaded|manifest|get|mark|ambiguous|plan-recovery|recovery-final|final <path>",
  );
}

if (process.argv[1]?.endsWith("release-state.mjs")) {
  run();
}
