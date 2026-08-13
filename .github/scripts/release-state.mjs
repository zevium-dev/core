import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";

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
  writeFileSync(temporary, serialize(state), {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const VERSION_RE =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
const RECOVERY_WORKFLOW = ".github/workflows/recover-production.yml";
const ROOT_WORKFLOWS = new Map([
  [".github/workflows/deploy-production.yml", true],
  [".github/workflows/gateway-do-lifecycle.yml", false],
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function sha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function serialize(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function byteDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runIdentity(value, context, allowRecovery = true) {
  if (
    !Number.isSafeInteger(value?.runId) ||
    value.runId <= 0 ||
    !Number.isSafeInteger(value?.runAttempt) ||
    value.runAttempt <= 0 ||
    (!ROOT_WORKFLOWS.has(value?.workflowPath) &&
      (!allowRecovery || value?.workflowPath !== RECOVERY_WORKFLOW))
  ) {
    throw new Error(`Invalid recovery run identity in ${context}`);
  }
  return {
    runId: value.runId,
    runAttempt: value.runAttempt,
    workflowPath: value.workflowPath,
  };
}

function lineageIdentity(manifest) {
  return canonical({
    schemaVersion: 3,
    release: manifest.release,
    activeBase: manifest.activeBase,
    lifecycle: manifest.lifecycle,
    root: manifest.root,
    gatewayPreviousVersion: manifest.gateway?.previousVersion,
    webPreviousVersion: manifest.web?.previousVersion,
    ...(manifest.protectedTarget === undefined
      ? {}
      : {
          protectedTarget: manifest.protectedTarget,
          protectedBase: manifest.protectedBase,
        }),
  });
}

function attemptToken(seed, parentDigest, source) {
  return sha256({
    kind: "recovery-candidate-attempt",
    seed,
    parentDigest,
    source,
  });
}

function finalizedAttemptDigest(attempt) {
  return sha256({
    kind: "recovery-candidate-final",
    token: attempt.token,
    gatewayVersion: attempt.gatewayVersion,
    webVersion: attempt.webVersion,
  });
}

function finalizedHandoffDigest(attempt) {
  return sha256({
    kind: "recovery-candidate-handoff",
    token: attempt.token,
    reusedCandidateDigest: attempt.reusedCandidateDigest,
  });
}

function validateBaseManifest(manifest) {
  if (
    manifest?.schemaVersion !== 3 ||
    !SHA_RE.test(manifest.release) ||
    !SHA_RE.test(manifest.activeBase) ||
    !DIGEST_RE.test(manifest.lifecycle?.digest) ||
    !["none", "expand", "contract"].includes(manifest.lifecycle?.phase) ||
    typeof manifest.lifecycle?.rollbackAllowed !== "boolean" ||
    !VERSION_RE.test(manifest.gateway?.previousVersion) ||
    !VERSION_RE.test(manifest.web?.previousVersion)
  ) {
    throw new Error("Recovery manifest identity is invalid or incomplete");
  }
  const root = runIdentity(manifest.root, "root", false);
  const source = runIdentity(manifest.source, "source");
  if (
    ROOT_WORKFLOWS.get(root.workflowPath) !== manifest.lifecycle.rollbackAllowed
  ) {
    throw new Error("Recovery root workflow and rollback policy disagree");
  }
  const hasProtectedTarget = manifest.protectedTarget !== undefined;
  const hasProtectedBase = manifest.protectedBase !== undefined;
  if (
    hasProtectedTarget !== hasProtectedBase ||
    (!manifest.lifecycle.rollbackAllowed &&
      (!SHA_RE.test(manifest.protectedTarget ?? "") ||
        !SHA_RE.test(manifest.protectedBase ?? ""))) ||
    (manifest.lifecycle.rollbackAllowed && hasProtectedTarget)
  ) {
    throw new Error("Recovery protected lifecycle identity is invalid");
  }
  return { root, source };
}

function validateLineage(manifest) {
  const { root, source } = validateBaseManifest(manifest);
  const lineage = manifest.lineage;
  const expectedSeed = sha256(lineageIdentity(manifest));
  if (
    !DIGEST_RE.test(lineage?.seed ?? "") ||
    lineage.seed !== expectedSeed ||
    !DIGEST_RE.test(lineage?.head ?? "") ||
    !Array.isArray(lineage?.attempts) ||
    lineage.attempts.length === 0
  ) {
    throw new Error("Recovery candidate lineage root is invalid");
  }
  let head = expectedSeed;
  let latestFinal = null;
  const identities = new Set();
  const gatewayVersions = new Set([manifest.gateway.previousVersion]);
  const webVersions = new Set([manifest.web.previousVersion]);
  for (const [index, rawAttempt] of lineage.attempts.entries()) {
    const attemptSource = runIdentity(
      rawAttempt?.source,
      `lineage attempt ${index}`,
    );
    if (index === 0 && !equal(attemptSource, root)) {
      throw new Error("Recovery candidate lineage root attempt is invalid");
    }
    const identity = `${attemptSource.workflowPath}:${attemptSource.runId}:${attemptSource.runAttempt}`;
    if (identities.has(identity)) {
      throw new Error("Recovery candidate lineage repeats a workflow attempt");
    }
    identities.add(identity);
    if (
      rawAttempt.parentDigest !== head ||
      rawAttempt.token !== attemptToken(expectedSeed, head, attemptSource)
    ) {
      throw new Error("Recovery candidate lineage hash chain is invalid");
    }
    head = rawAttempt.token;
    const hasGateway = rawAttempt.gatewayVersion !== undefined;
    const hasWeb = rawAttempt.webVersion !== undefined;
    const hasHandoff = rawAttempt.reusedCandidateDigest !== undefined;
    const hasDigest = rawAttempt.digest !== undefined;
    if (hasHandoff) {
      if (
        hasGateway ||
        hasWeb ||
        !hasDigest ||
        latestFinal === null ||
        rawAttempt.reusedCandidateDigest !== latestFinal.digest ||
        rawAttempt.digest !== finalizedHandoffDigest(rawAttempt)
      ) {
        throw new Error("Recovery candidate handoff is invalid");
      }
      head = rawAttempt.digest;
      continue;
    }
    if (hasGateway !== hasWeb || hasGateway !== hasDigest) {
      throw new Error("Recovery candidate lineage attempt is partial");
    }
    if (hasGateway) {
      if (
        !VERSION_RE.test(rawAttempt.gatewayVersion) ||
        !VERSION_RE.test(rawAttempt.webVersion) ||
        rawAttempt.digest !== finalizedAttemptDigest(rawAttempt)
      ) {
        throw new Error("Recovery candidate lineage finalization is invalid");
      }
      if (
        gatewayVersions.has(rawAttempt.gatewayVersion) ||
        webVersions.has(rawAttempt.webVersion)
      ) {
        throw new Error(
          "Recovery candidate lineage repeats a provider version",
        );
      }
      gatewayVersions.add(rawAttempt.gatewayVersion);
      webVersions.add(rawAttempt.webVersion);
      head = rawAttempt.digest;
      latestFinal = rawAttempt;
    }
  }
  if (lineage.head !== head) {
    throw new Error("Recovery candidate lineage head is invalid");
  }
  const latestAttempt = lineage.attempts.at(-1);
  if (!equal(latestAttempt?.source, source)) {
    throw new Error("Recovery manifest source is not latest lineage attempt");
  }
  const hasGatewayCandidate = manifest.gateway?.candidateVersion !== undefined;
  const hasWebCandidate = manifest.web?.candidateVersion !== undefined;
  if (hasGatewayCandidate !== hasWebCandidate) {
    throw new Error("Recovery artifact has a partial candidate identity");
  }
  if (
    (latestFinal === null && hasGatewayCandidate) ||
    (latestFinal !== null &&
      (!hasGatewayCandidate ||
        manifest.gateway.candidateVersion !== latestFinal.gatewayVersion ||
        manifest.web.candidateVersion !== latestFinal.webVersion))
  ) {
    throw new Error("Recovery manifest candidate is not lineage head");
  }
  return { latestFinal, latestAttempt };
}

export function createRecoveryIntent(manifestInput) {
  const manifest = canonical(manifestInput);
  const { root, source: baseSource } = validateBaseManifest(manifest);
  if (!equal(root, baseSource)) {
    throw new Error("Initial recovery source must equal root workflow attempt");
  }
  const seed = sha256(lineageIdentity(manifest));
  const source = runIdentity(manifest.source, "initial source", false);
  const attempt = {
    parentDigest: seed,
    source,
    token: attemptToken(seed, seed, source),
  };
  const initialized = {
    ...manifest,
    lineage: { seed, head: attempt.token, attempts: [attempt] },
  };
  validateLineage(initialized);
  return initialized;
}

export function beginRecoveryAttempt(manifestInput, sourceInput) {
  validateRecoveryArtifact(manifestInput);
  const source = runIdentity(sourceInput, "new recovery attempt");
  const manifest = structuredClone(manifestInput);
  const parentDigest = manifest.lineage.head;
  manifest.lineage.attempts.push({
    parentDigest,
    source,
    token: attemptToken(manifest.lineage.seed, parentDigest, source),
  });
  manifest.lineage.head = manifest.lineage.attempts.at(-1).token;
  manifest.source = source;
  manifest.state = "recovery_attempt_bound_before_mutation";
  manifest.updatedAt = new Date().toISOString();
  validateRecoveryArtifact(manifest);
  return manifest;
}

export function finalizeRecoveryAttempt(
  manifestInput,
  gatewayVersion,
  webVersion,
  state = "recovery_candidates_bound",
) {
  validateRecoveryArtifact(manifestInput);
  if (!VERSION_RE.test(gatewayVersion) || !VERSION_RE.test(webVersion)) {
    throw new Error("Recovery candidate versions are invalid");
  }
  const manifest = structuredClone(manifestInput);
  const attempt = manifest.lineage.attempts.at(-1);
  if (
    attempt?.digest !== undefined ||
    manifest.lineage.head !== attempt?.token ||
    !equal(attempt?.source, manifest.source)
  ) {
    throw new Error("Latest recovery attempt cannot be finalized");
  }
  attempt.gatewayVersion = gatewayVersion;
  attempt.webVersion = webVersion;
  attempt.digest = finalizedAttemptDigest(attempt);
  manifest.lineage.head = attempt.digest;
  manifest.gateway.candidateVersion = gatewayVersion;
  manifest.web.candidateVersion = webVersion;
  manifest.state = state;
  manifest.updatedAt = new Date().toISOString();
  validateManifest(manifest);
  return manifest;
}

export function finalizeRecoveryHandoff(
  manifestInput,
  state = "recursive_recovery_handoff_bound",
) {
  const { latestFinal } = validateLineage(manifestInput);
  if (latestFinal === null) {
    throw new Error("Recovery handoff has no finalized candidates");
  }
  const manifest = structuredClone(manifestInput);
  const attempt = manifest.lineage.attempts.at(-1);
  if (
    attempt?.digest !== undefined ||
    manifest.lineage.head !== attempt?.token ||
    !equal(attempt?.source, manifest.source)
  ) {
    throw new Error("Latest recovery attempt cannot bind candidate handoff");
  }
  attempt.reusedCandidateDigest = latestFinal.digest;
  attempt.digest = finalizedHandoffDigest(attempt);
  manifest.lineage.head = attempt.digest;
  manifest.state = state;
  manifest.updatedAt = new Date().toISOString();
  validateManifest(manifest);
  return manifest;
}

function finalizedVersions(manifest, component) {
  validateLineage(manifest);
  return manifest.lineage.attempts
    .filter((attempt) => attempt.gatewayVersion !== undefined)
    .map((attempt) => attempt[`${component}Version`]);
}

function assertObservedLineageOrder(manifest, observed, verifiedPending = {}) {
  const positions = { gateway: new Map(), web: new Map() };
  for (const component of ["gateway", "web"]) {
    positions[component].set(manifest[component].previousVersion, -1);
  }
  for (const [index, attempt] of manifest.lineage.attempts.entries()) {
    if (attempt.digest !== undefined) {
      positions.gateway.set(attempt.gatewayVersion, index);
      positions.web.set(attempt.webVersion, index);
    }
  }
  const pendingPosition = manifest.lineage.attempts.length - 1;
  for (const component of ["gateway", "web"]) {
    if (verifiedPending[component] !== undefined) {
      positions[component].set(verifiedPending[component], pendingPosition);
    }
  }
  const gatewayPosition = positions.gateway.get(observed.gateway);
  const webPosition = positions.web.get(observed.web);
  if (gatewayPosition === undefined || webPosition === undefined) {
    throw new Error("Observed provider state is outside recovery lineage");
  }
  if (webPosition > gatewayPosition) {
    throw new Error(
      "Observed provider state violates recovery deployment order",
    );
  }
  return { gatewayPosition, webPosition };
}

export function verifyRecoveryVersionLineage(manifestInput, remotePayload) {
  validateRecoveryArtifact(manifestInput);
  const result = remotePayload?.result ?? remotePayload;
  const id = versionId(result, "recovery lineage version metadata");
  const tag =
    result?.annotations?.["workers/tag"] ??
    result?.metadata?.annotations?.["workers/tag"];
  const pendingTokens = new Set(
    manifestInput.lineage.attempts
      .filter((attempt) => attempt.digest === undefined)
      .map((attempt) => attempt.token),
  );
  if (typeof tag !== "string" || !pendingTokens.has(tag)) {
    throw new Error(
      "Active recovery version lacks cryptographic lineage token",
    );
  }
  return { id, token: tag };
}

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
  const { latestFinal } = validateLineage(manifest);
  if (latestFinal === null) {
    throw new Error("Recovery manifest is invalid or incomplete");
  }
  return manifest;
}

function validateIntent(intent) {
  const { latestFinal } = validateLineage(intent);
  if (latestFinal !== null) {
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

export function recoveryPlan(manifestInput, observed, strategy, admission) {
  const artifactKind = validateRecoveryArtifact(manifestInput);
  const manifest = manifestInput;
  if (!["auto", "roll-forward", "rollback"].includes(strategy)) {
    throw new Error("Recovery strategy is invalid");
  }
  for (const component of ["gateway", "web"]) {
    const value = observed[component];
    const allowed = new Set([
      manifest[component].previousVersion,
      ...finalizedVersions(manifest, component),
    ]);
    if (!allowed.has(value)) {
      throw new Error(
        `${component} active version is outside cryptographic recovery lineage`,
      );
    }
  }
  assertObservedLineageOrder(manifest, observed);
  const { selected, controlPlaneMayHaveChanged } = selectRecoveryAction(
    manifest,
    strategy,
    observed,
  );
  if (artifactKind === "intent" && selected === "roll-forward") {
    throw new Error("Roll-forward recovery candidates are not finalized");
  }
  if (admission !== undefined) {
    verifyRecoveryAdmission(admission, manifest);
    if (admission.action !== selected) {
      throw new Error("Late recovery plan differs from pre-mutation admission");
    }
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

const SAFE_CONTROL_PLANE_STATES = new Set([
  "rollback_pointers_captured_no_traffic_mutation",
  "artifacts_uploaded_no_traffic_mutation",
  "recovery_attempt_bound_before_mutation",
  "aborted_without_traffic_change",
]);

function selectRecoveryAction(manifest, strategy, observed) {
  if (!["auto", "roll-forward", "rollback"].includes(strategy)) {
    throw new Error("Recovery strategy is invalid");
  }
  const state = manifest.lastVerifiedState ?? manifest.state;
  const controlPlaneMayHaveChanged =
    typeof state !== "string" || !SAFE_CONTROL_PLANE_STATES.has(state);
  const trafficMayHaveChanged = ["gateway", "web"].some(
    (component) =>
      observed?.[component] !== manifest[component].previousVersion,
  );
  const selected =
    strategy === "auto"
      ? controlPlaneMayHaveChanged || trafficMayHaveChanged
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
  if (selected === "rollback" && trafficMayHaveChanged) {
    throw new Error("Rollback requires verified unchanged provider traffic");
  }
  return { selected, controlPlaneMayHaveChanged, trafficMayHaveChanged };
}

export function recoveryArtifactDigest(manifestInput) {
  validateRecoveryArtifact(manifestInput);
  return byteDigest(serialize(manifestInput));
}

export function recoveryAdmission(
  manifestInput,
  observed,
  strategy,
  recoverySourceInput,
  verifiedPending = {},
) {
  const artifactKind = validateRecoveryArtifact(manifestInput);
  const recoverySource = runIdentity(
    recoverySourceInput,
    "recovery admission source",
  );
  const currentIdentity = `${recoverySource.workflowPath}:${recoverySource.runId}:${recoverySource.runAttempt}`;
  if (
    manifestInput.lineage.attempts.some((attempt) => {
      const source = attempt.source;
      return (
        `${source.workflowPath}:${source.runId}:${source.runAttempt}` ===
        currentIdentity
      );
    })
  ) {
    throw new Error("Recovery admission replays an existing workflow attempt");
  }
  for (const component of ["gateway", "web"]) {
    const allowed = new Set([
      manifestInput[component].previousVersion,
      ...finalizedVersions(manifestInput, component),
      ...(verifiedPending[component] === observed?.[component]
        ? [verifiedPending[component]]
        : []),
    ]);
    if (!allowed.has(observed?.[component])) {
      throw new Error(
        `${component} pre-mutation state is outside cryptographic recovery lineage`,
      );
    }
  }
  assertObservedLineageOrder(manifestInput, observed, verifiedPending);
  const { selected, controlPlaneMayHaveChanged } = selectRecoveryAction(
    manifestInput,
    strategy,
    observed,
  );
  const body = canonical({
    schemaVersion: 1,
    action: selected,
    artifactDigest: recoveryArtifactDigest(manifestInput),
    artifactKind,
    controlPlaneMayHaveChanged,
    lineageHead: manifestInput.lineage.head,
    lineageSeed: manifestInput.lineage.seed,
    observed: {
      gateway: observed.gateway,
      web: observed.web,
    },
    verifiedPending: canonical(verifiedPending),
    recoverySource,
    root: manifestInput.root,
    source: manifestInput.source,
    requiresCandidateGeneration:
      selected === "roll-forward" && artifactKind === "intent",
    requiresConvexRollForward:
      selected === "roll-forward" && controlPlaneMayHaveChanged,
  });
  return canonical({ ...body, digest: sha256(body) });
}

export function verifyRecoveryAdmission(admission, manifestInput) {
  validateRecoveryArtifact(manifestInput);
  const { digest: suppliedDigest, ...body } = admission ?? {};
  if (
    admission?.schemaVersion !== 1 ||
    !DIGEST_RE.test(suppliedDigest ?? "") ||
    suppliedDigest !== sha256(body) ||
    admission.lineageSeed !== manifestInput.lineage.seed ||
    !equal(admission.root, manifestInput.root)
  ) {
    throw new Error("Recovery admission identity or digest is invalid");
  }
  const currentAttempt = manifestInput.lineage.attempts.at(-1);
  const beforeAttempt =
    manifestInput.source.runId === admission.recoverySource?.runId &&
    manifestInput.source.runAttempt === admission.recoverySource?.runAttempt &&
    manifestInput.source.workflowPath ===
      admission.recoverySource?.workflowPath;
  const expectedHead = beforeAttempt
    ? currentAttempt?.parentDigest
    : manifestInput.lineage.head;
  if (expectedHead !== admission.lineageHead) {
    throw new Error("Recovery admission is stale for candidate lineage");
  }
  if (!beforeAttempt) {
    if (
      recoveryArtifactDigest(manifestInput) !== admission.artifactDigest ||
      !equal(manifestInput.source, admission.source)
    ) {
      throw new Error("Recovery artifact changed after admission");
    }
  }
  return true;
}

export function createRecoveryLineagePredicate(manifestInput) {
  validateRecoveryArtifact(manifestInput);
  const manifest = canonical(manifestInput);
  const token = manifest.lineage.attempts.at(-1)?.token;
  if (!DIGEST_RE.test(token ?? "")) {
    throw new Error("Recovery lineage subject token is invalid");
  }
  const subject = canonical({
    schemaVersion: 1,
    token,
    manifestDigest: recoveryArtifactDigest(manifest),
  });
  return canonical({
    schemaVersion: 1,
    subjectDigest: byteDigest(serialize(subject)),
    subject,
    lineageSeed: manifest.lineage.seed,
    lineageHead: manifest.lineage.head,
    root: manifest.root,
    source: manifest.source,
    manifest,
  });
}

export function extractRecoveryLineageAttestation(payload) {
  const statements = [];
  for (const row of Array.isArray(payload) ? payload : [payload]) {
    const verified =
      row?.verificationResult?.statement ?? row?.verification_result?.statement;
    if (verified) statements.push(verified);
  }
  for (const row of Array.isArray(payload?.attestations)
    ? payload.attestations
    : []) {
    try {
      const encoded = row?.bundle?.dsseEnvelope?.payload;
      if (typeof encoded !== "string") continue;
      statements.push(
        JSON.parse(Buffer.from(encoded, "base64").toString("utf8")),
      );
    } catch {
      // Ignore malformed untrusted transparency-log rows.
    }
  }
  const predicates = new Map();
  const subjectDigests = new Set();
  for (const statement of statements) {
    try {
      if (
        statement?._type !== "https://in-toto.io/Statement/v1" ||
        statement?.predicateType !==
          "https://zevium.dev/attestations/recovery-lineage/v1"
      ) {
        continue;
      }
      const predicate = createRecoveryLineagePredicate(
        statement?.predicate?.manifest,
      );
      if (!equal(predicate, statement.predicate)) continue;
      const subject = statement.subject;
      if (
        !Array.isArray(subject) ||
        subject.length !== 1 ||
        subject[0]?.digest?.sha256 !== predicate.subjectDigest
      ) {
        continue;
      }
      subjectDigests.add(predicate.subjectDigest);
      predicates.set(recoveryArtifactDigest(predicate.manifest), predicate);
    } catch {
      // Untrusted transparency-log rows fail closed and cannot mask valid rows.
    }
  }
  if (subjectDigests.size !== 1 || predicates.size === 0) {
    throw new Error(
      "Durable recovery lineage attestation is absent or ambiguous",
    );
  }
  const candidates = [...predicates.values()];
  const finalized = candidates.filter(
    (predicate) => validateRecoveryArtifact(predicate.manifest) === "manifest",
  );
  const selected = finalized.length > 0 ? finalized : candidates;
  if (selected.length !== 1) {
    throw new Error(
      "Durable recovery lineage attestation is absent or ambiguous",
    );
  }
  return selected[0].manifest;
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

export function boundedDeploymentLineageVersion(
  path,
  manifestInput,
  component,
) {
  const manifest = validateManifest(manifestInput);
  if (component !== "gateway" && component !== "web") {
    throw new Error("Recovery lineage component is invalid");
  }
  const previous = manifest[component].previousVersion;
  const candidates = new Set(finalizedVersions(manifest, component));
  const allowed = new Set([previous, ...candidates]);
  const deployments = readJson(path);
  const versions = Array.isArray(deployments)
    ? deployments.at(-1)?.versions
    : null;
  if (!Array.isArray(versions) || versions.length < 1 || versions.length > 2) {
    throw new Error("Cloudflare deployment shape is outside recovery bounds");
  }
  let total = 0;
  const activeCandidates = new Set();
  const seen = new Set();
  for (const version of versions) {
    const id = versionId(version, path);
    const weight = percentage(version?.percentage, path);
    if (!allowed.has(id) || seen.has(id)) {
      throw new Error(
        "Cloudflare deployment contains version outside cryptographic recovery lineage",
      );
    }
    seen.add(id);
    total += weight;
    if (id !== previous && weight > 0) activeCandidates.add(id);
  }
  if (total !== 100) {
    throw new Error("Cloudflare deployment weights do not total 100");
  }
  if (activeCandidates.size > 1) {
    throw new Error("Cloudflare deployment mixes recovery candidate lineages");
  }
  return [...activeCandidates][0] ?? previous;
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
  if (command === "get-bounded-lineage-version") {
    const [manifestPath, component] = args;
    if (!manifestPath || !component) {
      throw new Error("Recovery lineage manifest and component are required");
    }
    process.stdout.write(
      boundedDeploymentLineageVersion(
        directory,
        readJson(manifestPath),
        component,
      ),
    );
    return;
  }
  if (command === "validate-recovery") {
    process.stdout.write(
      validateRecoveryArtifact(readJson(`${directory}/recovery-manifest.json`)),
    );
    return;
  }
  if (command === "lineage-predicate") {
    const [predicatePath, subjectPath] = args;
    if (!predicatePath || !subjectPath) {
      throw new Error(
        "Recovery lineage predicate and subject paths are required",
      );
    }
    const manifest = readJson(`${directory}/recovery-manifest.json`);
    const predicate = createRecoveryLineagePredicate(manifest);
    writeState(predicatePath, predicate);
    writeState(subjectPath, predicate.subject);
    process.stdout.write(predicate.subjectDigest);
    return predicate;
  }
  if (command === "extract-lineage-attestation") {
    const outputPath = args[0];
    if (!outputPath) {
      throw new Error("Recovery lineage output path is required");
    }
    const manifest = extractRecoveryLineageAttestation(readJson(directory));
    writeState(outputPath, manifest);
    process.stdout.write(recoveryArtifactDigest(manifest));
    return manifest;
  }
  if (command === "get-lineage-token") {
    const manifest = readJson(`${directory}/recovery-manifest.json`);
    validateRecoveryArtifact(manifest);
    const attempt = manifest.lineage.attempts.at(-1);
    if (
      attempt?.digest !== undefined ||
      !DIGEST_RE.test(attempt?.token ?? "")
    ) {
      throw new Error("Latest recovery attempt has no pending lineage token");
    }
    process.stdout.write(attempt.token);
    return;
  }
  if (command === "verify-lineage-version") {
    const versionPath = args[0];
    if (!versionPath) throw new Error("Recovery version metadata is required");
    const proof = verifyRecoveryVersionLineage(
      readJson(`${directory}/recovery-manifest.json`),
      readJson(versionPath),
    );
    process.stdout.write(`${JSON.stringify(proof)}\n`);
    return;
  }
  const statePath = `${directory}/state.json`;

  if (command === "admit-recovery") {
    const [strategy, runId, workflowPath, runAttempt] = args;
    const manifest = readJson(`${directory}/recovery-manifest.json`);
    const kind = validateRecoveryArtifact(manifest);
    const observed = {};
    const verifiedPending = {};
    for (const component of ["gateway", "web"]) {
      const path = `${directory}/${component}-current.json`;
      observed[component] =
        kind === "manifest"
          ? boundedDeploymentLineageVersion(path, manifest, component)
          : activeVersion(path);
      if (
        kind === "intent" &&
        observed[component] !== manifest[component].previousVersion
      ) {
        const versionPath = `${directory}/${component}-current-version.json`;
        const proof = verifyRecoveryVersionLineage(
          manifest,
          readJson(versionPath),
        );
        if (proof.id !== observed[component]) {
          throw new Error(
            `${component} pending lineage proof does not match active version`,
          );
        }
        verifiedPending[component] = proof.id;
      }
    }
    const admission = recoveryAdmission(
      manifest,
      observed,
      strategy,
      {
        runId: Number(runId),
        workflowPath,
        runAttempt: Number(runAttempt),
      },
      verifiedPending,
    );
    writeState(`${directory}/recovery-admission.json`, admission);
    process.stdout.write(`${JSON.stringify(admission)}\n`);
    return admission;
  }

  if (command === "begin-attempt") {
    const [runId, workflowPath, runAttempt] = args;
    const source = {
      runId: Number(runId),
      workflowPath,
      runAttempt: Number(runAttempt),
    };
    const original = readJson(`${directory}/recovery-manifest.json`);
    const admission = readJson(`${directory}/recovery-admission.json`);
    verifyRecoveryAdmission(admission, original);
    if (!equal(admission.recoverySource, source)) {
      throw new Error("Recovery attempt differs from pre-mutation admission");
    }
    const manifest = beginRecoveryAttempt(original, source);
    verifyRecoveryAdmission(admission, manifest);
    writeState(`${directory}/recovery-manifest.json`, manifest);
    return manifest;
  }

  if (command === "finalize-attempt") {
    const [gatewayVersion, webVersion, state] = args;
    const manifest = finalizeRecoveryAttempt(
      readJson(`${directory}/recovery-manifest.json`),
      gatewayVersion,
      webVersion,
      state,
    );
    writeState(`${directory}/recovery-manifest.json`, manifest);
    return manifest;
  }

  if (command === "finalize-handoff") {
    const [state] = args;
    const manifest = finalizeRecoveryHandoff(
      readJson(`${directory}/recovery-manifest.json`),
      state,
    );
    writeState(`${directory}/recovery-manifest.json`, manifest);
    return manifest;
  }

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
      protectedTarget,
      protectedBase,
    ] = args;
    if (rollbackAllowed !== "true" && rollbackAllowed !== "false") {
      throw new Error("rollbackAllowed must be true or false");
    }
    const state = readJson(statePath);
    if (state.state !== "rollback_pointers_captured_no_traffic_mutation") {
      throw new Error(`Cannot create recovery intent from ${state.state}`);
    }
    const source = {
      runId: Number(runId),
      workflowPath,
      runAttempt: Number(runAttempt),
    };
    const intent = createRecoveryIntent({
      schemaVersion: 3,
      createdAt: new Date().toISOString(),
      state: state.state,
      release,
      activeBase,
      lifecycle: {
        digest,
        phase,
        rollbackAllowed: rollbackAllowed === "true",
      },
      root: source,
      source,
      gateway: { previousVersion: state.gateway.previousVersion },
      web: { previousVersion: state.web.previousVersion },
      ...(protectedTarget === undefined && protectedBase === undefined
        ? {}
        : { protectedTarget, protectedBase }),
    });
    validateIntent(intent);
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
    if (
      intent.release !== release ||
      intent.activeBase !== activeBase ||
      intent.lifecycle.digest !== digest ||
      intent.lifecycle.phase !== phase ||
      intent.lifecycle.rollbackAllowed !== (rollbackAllowed === "true") ||
      intent.source.runId !== Number(runId) ||
      intent.source.workflowPath !== workflowPath ||
      intent.source.runAttempt !== Number(runAttempt) ||
      intent.gateway.previousVersion !== state.gateway.previousVersion ||
      intent.web.previousVersion !== state.web.previousVersion
    ) {
      throw new Error("Final recovery manifest differs from persisted intent");
    }
    const manifest = finalizeRecoveryAttempt(
      { ...intent, state: state.state },
      state.gateway.candidateVersion,
      state.web.candidateVersion,
      state.state,
    );
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
    const manifestPath = `${directory}/recovery-manifest.json`;
    if (existsSync(manifestPath)) {
      const manifest = readJson(manifestPath);
      validateRecoveryArtifact(manifest);
      manifest.state = next;
      manifest.updatedAt = state.updatedAt;
      validateRecoveryArtifact(manifest);
      writeState(manifestPath, manifest);
    }
    return;
  }

  if (command === "checkpoint-irreversible") {
    const state = readJson(statePath);
    if (!SAFE_CONTROL_PLANE_STATES.has(state.state)) {
      throw new Error(
        `Cannot checkpoint irreversible mutation from ${state.state}`,
      );
    }
    const manifestPath = `${directory}/recovery-manifest.json`;
    const manifest = readJson(manifestPath);
    validateRecoveryArtifact(manifest);
    const updatedAt = new Date().toISOString();
    state.state = "convex_mutation_started";
    state.updatedAt = updatedAt;
    manifest.state = state.state;
    manifest.updatedAt = updatedAt;
    validateRecoveryArtifact(manifest);
    writeState(statePath, state);
    writeState(manifestPath, manifest);
    return manifest;
  }

  if (command === "ambiguous") {
    mkdirSync(directory, { recursive: true });
    const signal = args[0] ?? "unknown";
    const state = existsSync(statePath)
      ? readJson(statePath)
      : { schemaVersion: 2, state: "failed_before_state_capture" };
    const lastVerifiedState = state.lastVerifiedState ?? state.state;
    state.lastVerifiedState = lastVerifiedState;
    state.state = SAFE_CONTROL_PLANE_STATES.has(lastVerifiedState)
      ? "aborted_without_traffic_change"
      : "ambiguous_recovery_required";
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
      manifest.state = state.state;
      manifest.ambiguity = state.ambiguity;
      writeState(`${directory}/recovery-manifest.json`, manifest);
    }
    return state;
  }

  if (command === "plan-recovery") {
    const strategy = args[0];
    const manifest = readJson(`${directory}/recovery-manifest.json`);
    validateRecoveryArtifact(manifest);
    const admission = readJson(`${directory}/recovery-admission.json`);
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
      admission,
    );
    writeState(`${directory}/recovery-plan.json`, plan);
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return plan;
  }

  if (command === "recovery-final") {
    const [gatewayReady, webReady, accountingReady] = args;
    const manifest = readJson(`${directory}/recovery-manifest.json`);
    const artifactKind = validateRecoveryArtifact(manifest);
    const plan = readJson(`${directory}/recovery-plan.json`);
    if (plan.action === "roll-forward" && artifactKind !== "manifest") {
      throw new Error(
        "Roll-forward recovery completed without finalized candidates",
      );
    }
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
        SAFE_CONTROL_PLANE_STATES.has(lastVerifiedState)
      ) {
        state.state = "aborted_without_traffic_change";
      } else state.state = "ambiguous_recovery_required";
    }
    writeState(statePath, state);
    return;
  }

  throw new Error(
    "Usage: release-state.mjs get-active-version|get-uploaded-version|get-bounded-version|get-bounded-lineage-version|verify-zero-traffic|validate-recovery|lineage-predicate|extract-lineage-attestation|get-lineage-token|verify-lineage-version|admit-recovery|begin-attempt|finalize-attempt|finalize-handoff|capture|intent|uploaded|manifest|get|mark|checkpoint-irreversible|ambiguous|plan-recovery|recovery-final|final <path>",
  );
}

if (process.argv[1]?.endsWith("release-state.mjs")) {
  run();
}
