import {
  existsSync,
  mkdirSync,
  readFileSync,
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
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
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
  if (Number(active?.percentage) !== 100) {
    throw new Error(`Latest Cloudflare deployment is not at 100% in ${path}`);
  }
  const id = active?.version_id ?? active?.versionId ?? active?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`No active version id in ${path}`);
  }
  return id;
}

export function uploadedVersion(path) {
  const records = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const upload = records.findLast(
    (record) => record?.type === "version-upload",
  );
  const id = upload?.version_id ?? upload?.versionId ?? upload?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`No uploaded version id in ${path}`);
  }
  return id;
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

  if (command === "recover") {
    const [gatewayCommand, webCommand, gatewayReady, webReady] = args;
    const state = readJson(statePath);
    const gatewayActive = readRollbackVersion(directory, "gateway");
    const webActive = readRollbackVersion(directory, "web");
    const gatewayRestored =
      gatewayCommand === "success" &&
      gatewayReady === "true" &&
      gatewayActive === state.gateway?.previousVersion;
    const webRestored =
      webCommand === "success" &&
      webReady === "true" &&
      webActive === state.web?.previousVersion;
    state.recovery = {
      attemptedAt: new Date().toISOString(),
      gatewayRestored,
      webRestored,
      verified: gatewayRestored && webRestored,
    };
    writeState(statePath, state);
    return;
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
        lastVerifiedState ===
          "rollback_pointers_captured_no_traffic_mutation" ||
        lastVerifiedState === "artifacts_uploaded_no_traffic_mutation"
      ) {
        state.state = "aborted_without_traffic_change";
      } else {
        if (!state.recovery?.verified) {
          state.state = "manual_recovery_required";
        } else if (lastVerifiedState === "convex_mutation_started") {
          state.state = "workers_rolled_back_control_plane_change_possible";
        } else {
          state.state = "workers_rolled_back_control_plane_expansion_retained";
        }
      }
    }
    writeState(statePath, state);
    return;
  }

  throw new Error(
    "Usage: release-state.mjs capture|uploaded|get|mark|recover|final <evidence-directory>",
  );
}

if (process.argv[1]?.endsWith("release-state.mjs")) {
  run();
}
