/** Canonical control-plane to edge-registry Registry v2 contract. */

export const REGISTRY_PROTOCOL_VERSION = 2 as const;
export const REGISTRY_EVENT_PATH = "/internal/registry/v2/events" as const;
export const REGISTRY_BOOTSTRAP_PATH =
  "/internal/registry/v2/bootstrap" as const;
export const REGISTRY_RECEIVER_METHOD = "POST" as const;
export const REGISTRY_EVENT_TIMESTAMP_HEADER =
  "x-zevium-registry-timestamp" as const;
export const REGISTRY_EVENT_NONCE_HEADER = "x-zevium-registry-nonce" as const;
export const REGISTRY_EVENT_SIGNATURE_HEADER =
  "x-zevium-registry-signature" as const;
export const REGISTRY_ACK_SIGNATURE_HEADER =
  "x-zevium-registry-ack-signature" as const;
export const REGISTRY_MAX_CLOCK_SKEW_MS = 300_000;
export const REGISTRY_MAX_EVENT_BYTES = 524_288;
export const REGISTRY_MAX_SPEC_BYTES = 393_216;
export const REGISTRY_MAX_CREDENTIAL_PLAINTEXT_BYTES = 32_768;
export const REGISTRY_MAX_ACK_BYTES = 65_536;
export const REGISTRY_BOOTSTRAP_MAX_EVENTS = 100;
export const REGISTRY_BOOTSTRAP_MAX_ENCODED_EVENT_BYTES = 4 * 1024 * 1024;
export const REGISTRY_MANIFEST_MAX_ITEMS = 100;
export const REGISTRY_MANIFEST_MAX_BYTES = 262_144;
export const REGISTRY_ROLLOUT_BATCH_SIZE = 10;
export const REGISTRY_DELIVERY_LEASE_MS = 30_000;
export const REGISTRY_DELIVERY_TIMEOUT_MS = 10_000;
export const REGISTRY_DELIVERY_MAX_ATTEMPTS = 20;
export const REGISTRY_DELIVERY_MAX_BACKOFF_MS = 900_000;

export const REGISTRY_RECEIVER_SECURITY_CONTRACT = {
  event: {
    method: REGISTRY_RECEIVER_METHOD,
    path: REGISTRY_EVENT_PATH,
    maxBytes: REGISTRY_MAX_EVENT_BYTES,
    body: "exact_canonical_json_utf8",
    signature: "hmac_sha256_timestamp_nonce_body",
  },
  bootstrap: {
    method: REGISTRY_RECEIVER_METHOD,
    path: REGISTRY_BOOTSTRAP_PATH,
    maxEvents: REGISTRY_BOOTSTRAP_MAX_EVENTS,
    maxBytes: REGISTRY_BOOTSTRAP_MAX_ENCODED_EVENT_BYTES,
  },
  timestampWindowMs: REGISTRY_MAX_CLOCK_SKEW_MS,
  nonce: "event.nonce_and_header_nonce_must_match",
  replay: "exact_replay_is_idempotent_nonce_collision_is_conflict",
  ordering: "per_stream_only",
  tombstones: "permanent",
  credentialStorage: "decrypt_then_reencrypt_at_rest",
  acknowledgement: "signed_request_bound_ack",
} as const;

export const REGISTRY_V2_PRODUCER_CONTRACT = {
  schemaVersion: REGISTRY_PROTOCOL_VERSION,
  operations: [
    "org.put",
    "org.archive",
    "route.put",
    "route.archive",
    "key.put",
    "key.revoke",
    "catalogue.snapshot",
  ],
  canonicalization: {
    encoding: "utf8",
    objectKeys: "recursive_unicode_code_point_order",
    arrays: "preserve_order",
    values: "json_only",
    optionalFields: "omit_before_canonicalization",
  },
  transport: {
    signaturePreimage: "ASCII(timestamp)||0x2e||ASCII(nonce)||0x2e||rawBody",
    acknowledgementSignaturePreimage:
      "ASCII(ack.)||ASCII(requestTimestamp)||0x2e||ASCII(requestNonce)||0x2e||rawAckBody",
    clockSkewMs: REGISTRY_MAX_CLOCK_SKEW_MS,
    nonce: "[A-Za-z0-9_-]{16,128}",
  },
  event: {
    maxBytes: REGISTRY_MAX_EVENT_BYTES,
    specMaxBytes: REGISTRY_MAX_SPEC_BYTES,
    payloadDigest: "sha256(utf8(canonicalJson(payload)))",
    eventId: "r2_sha256(utf8(canonicalJson(event_without_eventId)))",
    revision: "positive_contiguous_per_stream",
  },
  acknowledgement: {
    statuses: ["applied", "duplicate", "superseded", "gap", "conflict"],
    stale: "not_supported; use superseded only with stored identity",
    identity: "eventId_streamKey_revision_operation_payloadSha256_entityKey",
  },
  delivery: {
    ordering: "previous_revision_same_stream_or_explicit_dependency_only",
    deadLetterScope: "same_stream_and_dependents_only",
    leaseMs: REGISTRY_DELIVERY_LEASE_MS,
    timeoutMs: REGISTRY_DELIVERY_TIMEOUT_MS,
    maxAttempts: REGISTRY_DELIVERY_MAX_ATTEMPTS,
  },
  sharding: [
    "r2/route/<sha256(streamKey)>",
    "r2/key/<secretSha256>",
    "r2/org/<sha256(clerkOrgId)>",
    "r2/catalogue/global",
    "r2/manifest/<kind>/<00..ff>",
  ],
  rawSecret: "never_persisted_or_sent",
} as const;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type Sha256Hex = string;

export type RegistryStreamKind = "org" | "route" | "key" | "catalogue";
export type RegistryOperation =
  | "org.put"
  | "org.archive"
  | "route.put"
  | "route.archive"
  | "key.put"
  | "key.revoke"
  | "catalogue.snapshot";
export type RegistryKeyLifecycle = "active" | "grace" | "disabled" | "revoked";
export type RegistryAdmissionMode = "open" | "entitled_only";

export type RegistryRouteAdmission = {
  mode: RegistryAdmissionMode;
  policyRevision: number;
};

export type RegistryEncryptedCredentials = {
  algorithm: "A256GCM";
  aadVersion: 1;
  keyId: string;
  ivBase64Url: string;
  ciphertextBase64Url: string;
  plaintextSha256: Sha256Hex;
};

export type QualitySnapshotContract = {
  readonly [key: string]: JsonValue;
};

export type RegistryCatalogueListing = {
  projectId: string;
  publisherOrganizationId: string;
  publisherClerkOrgId: string;
  publisherHandle: string;
  projectSlug: string;
  name: string;
  organizationName: string;
  description: string | null;
  tags: string[];
  publishedAt: number;
  specVersionId: string;
  version: string;
  pricing: {
    minCostCredits: number;
    maxCostCredits: number;
    endpointCount: number;
    hasFreeTier: boolean;
  };
  quality: QualitySnapshotContract | null;
};

export type RegistryPayloadMap = {
  "org.put": {
    clerkOrgId: string;
    organizationId: string;
    publisherHandle: string;
  };
  "org.archive": {
    clerkOrgId: string;
    organizationId: string | null;
    archivedAt: number;
    reason: "clerk_deleted" | "admin_archived";
  };
  "route.put": {
    projectId: string;
    projectGeneration: number;
    publisherOrganizationId: string;
    publisherClerkOrgId: string;
    publisherHandle: string;
    projectSlug: string;
    specVersionId: string;
    version: string;
    publishedAt: number;
    spec: { readonly [key: string]: JsonValue };
    visibility: "public" | "private";
    credentialRevision: number;
    upstreamCredentials: RegistryEncryptedCredentials;
    admission: RegistryRouteAdmission;
    deprecation: {
      deprecatedAt: number | null;
      sunsetAt: number | null;
      message: string | null;
    };
  };
  "route.archive": {
    projectId: string;
    projectGeneration: number;
    publisherOrganizationId: string;
    publisherClerkOrgId: string;
    publisherHandle: string;
    projectSlug: string;
    archivedAt: number;
    reason: "rename" | "retired" | "org_archived";
    replacementStreamKey: string | null;
  };
  "key.put": {
    secretSha256: Sha256Hex;
    clerkKeyId: string;
    clerkOrgId: string;
    ownerUserId: string;
    subjectUserId: string;
    budgetId: string;
    budgetRevision: number;
    lifecycle: "active" | "grace" | "disabled";
    monthlyCapCredits: number | null;
    graceUntil: number | null;
    expiresAt: number | null;
    scopes: string[];
  };
  "key.revoke": {
    secretSha256: Sha256Hex;
    clerkKeyId: string;
    clerkOrgId: string;
    ownerUserId: string;
    budgetId: string;
    revokedAt: number;
    reason: "rotated" | "provider_revoked" | "org_archived" | "admin_revoked";
  };
  "catalogue.snapshot": {
    projectId: string;
    projectGeneration: number;
    route: {
      streamKey: string;
      revision: number;
      payloadSha256: Sha256Hex;
    } | null;
    discoverable: boolean;
    listing: RegistryCatalogueListing | null;
  };
};

export type RegistryEventFor<O extends RegistryOperation> = {
  schemaVersion: 2;
  eventId: `r2_${string}`;
  streamKey: string;
  revision: number;
  operation: O;
  occurredAt: number;
  nonce: string;
  payloadSha256: Sha256Hex;
  payload: RegistryPayloadMap[O];
};

export type RegistryEvent = {
  [O in RegistryOperation]: RegistryEventFor<O>;
}[RegistryOperation];

export type RegistryAckStatus =
  "applied" | "duplicate" | "superseded" | "gap" | "conflict";

export type RegistryAck = {
  schemaVersion: 2;
  eventId: `r2_${string}`;
  bodySha256: Sha256Hex;
  streamKey: string;
  revision: number;
  operation: RegistryOperation;
  payloadSha256: Sha256Hex;
  entityKey: string;
  status: RegistryAckStatus;
  receiverRevision: number;
  receiverEventId: `r2_${string}` | null;
  receiverPayloadSha256: Sha256Hex | null;
  receiverTombstone: boolean;
};

export type RegistryOutboxState =
  "pending" | "delivering" | "acked" | "dead_letter";

export type RegistryOutboxRow = {
  eventId: `r2_${string}`;
  streamKey: string;
  revision: number;
  eventJson: string;
  bodySha256: Sha256Hex;
  state: RegistryOutboxState;
  attempts: number;
  nextAttemptAt: number;
  leaseToken: string | null;
  leaseUntil: number | null;
  dependsOnEventId: `r2_${string}` | null;
  ack: RegistryAck | null;
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
};

export type RegistryManifestKind = RegistryStreamKind;
export type RegistryManifestItem = {
  entityKey: string;
  streamKey: string;
  revision: number;
  eventId: `r2_${string}`;
  operation: RegistryOperation;
  payloadSha256: Sha256Hex;
  tombstone: boolean;
};
export type RegistryManifestPage = {
  schemaVersion: 2;
  snapshotId: `rm2_${string}`;
  kind: RegistryManifestKind;
  shard: string;
  createdAt: number;
  pageIndex: number;
  afterEntityKey: string | null;
  items: RegistryManifestItem[];
  itemCount: number;
  pageSha256: Sha256Hex;
  totalCount: number;
  totalSha256: Sha256Hex;
  nextAfterEntityKey: string | null;
};

export type RegistryRolloutStatus = "running" | "complete";
export type RegistryRolloutPhase =
  | "credentials"
  | "organizations"
  | "routes"
  | "keys"
  | "verify_sources"
  | "verify_events"
  | "complete";
export type RegistryRolloutCounts = {
  credentials: number;
  organizations: number;
  archivedOrganizations: number;
  handlesBackfilled: number;
  handlesReassigned: number;
  publishedRoutes: number;
  retiredRoutes: number;
  keys: number;
  keysForcedToRotate: number;
  events: number;
};
export type RegistryRolloutDigests = { sources: Sha256Hex; events: Sha256Hex };
export type RegistryRolloutVerification = {
  counts: RegistryRolloutCounts;
  digests: RegistryRolloutDigests;
  lastPage: number | null;
  lastOrdinal: number | null;
};
export type RegistryRolloutManifest = {
  schemaVersion: 2;
  provenanceVersion: 1;
  rolloutId: string;
  snapshotAt: number;
  status: RegistryRolloutStatus;
  phase: RegistryRolloutPhase;
  cursor: string | null;
  page: number;
  counts: RegistryRolloutCounts;
  digests: RegistryRolloutDigests;
  verification: RegistryRolloutVerification;
  completedAt?: number;
};

export type EntitlementAdmissionClaims = {
  schemaVersion: 1;
  reservationId: string;
  consumerClerkOrgId: string;
  projectId: string;
  routeRevision: number;
  policyRevision: number;
  policyMode: RegistryAdmissionMode;
  decision: "existing" | "grant_on_settlement";
  admittedAt: number;
};
export type SignedEntitlementAdmission = {
  claims: EntitlementAdmissionClaims;
  signature: `v1=${string}`;
};
export type EntitlementAdmissionResult =
  | { status: "admitted"; proof: SignedEntitlementAdmission }
  | { status: "not_entitled" }
  | { status: "route_changed" }
  | { status: "unavailable" };
export interface EntitlementAdmissionAdapter {
  admit(input: {
    reservationId: string;
    consumerClerkOrgId: string;
    projectId: string;
    routeRevision: number;
    admission: RegistryRouteAdmission;
    nowMs: number;
  }): Promise<EntitlementAdmissionResult>;
  settle(proof: SignedEntitlementAdmission): Promise<"granted" | "existing">;
}

export type VerifiedOneTimeExecutionKey = {
  keyId: string;
  secret: string;
  clerkOrgId: string;
  ownerUserId: string;
  subjectUserId: string;
  budgetId: string;
  budgetRevision: number;
  scopes: string[];
};
export type SealedExecutionKey = {
  oneTimeSecret: string;
  provision: RegistryPayloadMap["key.put"];
};
export type RegistryVerifiedKeyProjection = {
  schemaVersion: 1;
  verifiedAt: number;
  provision: RegistryPayloadMap["key.put"];
};
export type RegistryVerifiedKeyRotationProjection = {
  schemaVersion: 1;
  verifiedAt: number;
  operationId: string;
  oldKeyId: string;
  newProvision: RegistryPayloadMap["key.put"];
  graceUntil: number;
};

const ZERO_DIGEST = "0".repeat(64);
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const IDENTIFIER = /^[A-Za-z0-9_:.\/-]+$/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function registryGenesisDigest(): Sha256Hex {
  return ZERO_DIGEST;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function codePointCompare(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const delta = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
}

function assertJsonValue(
  value: unknown,
  seen: Set<object>,
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Canonical JSON rejects non-finite numbers");
    return;
  }
  if (typeof value !== "object")
    throw new Error("Canonical JSON rejects unsupported values");
  if (seen.has(value)) throw new Error("Canonical JSON rejects cyclic values");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Canonical JSON accepts plain objects only");
    }
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined)
        throw new Error(`Canonical JSON rejects undefined field ${key}`);
      assertJsonValue(item, seen);
    }
  }
  seen.delete(value);
}

function serializeCanonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(serializeCanonical).join(",")}]`;
  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object)
    .sort(codePointCompare)
    .map((key) => `${JSON.stringify(key)}:${serializeCanonical(object[key]!)}`)
    .join(",")}}`;
}

/** Deterministic JSON for the strict JSON value domain. */
export function canonicalJson(value: unknown): string {
  assertJsonValue(value, new Set());
  return serializeCanonical(value);
}

export function registryEncodedByteLength(value: unknown): number {
  const raw = typeof value === "string" ? value : canonicalJson(value);
  return new TextEncoder().encode(raw).byteLength;
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(new TextEncoder().encode(value));
}

function toHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function sha256Hex(value: string): Promise<Sha256Hex> {
  return toHex(await crypto.subtle.digest("SHA-256", utf8(value)));
}

function assertString(
  value: unknown,
  label: string,
  maxBytes = 256,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    registryEncodedByteLength(value) > maxBytes
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function assertId(
  value: unknown,
  label: string,
  maxBytes = 256,
): asserts value is string {
  assertString(value, label, maxBytes);
  if (!IDENTIFIER.test(value)) throw new Error(`${label} is invalid`);
}

function assertPositive(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new Error(`${label} must be a positive safe integer`);
}

function assertNonNegative(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error(`${label} must be a non-negative safe integer`);
}

function assertNullablePositive(value: unknown, label: string): void {
  if (value !== null) assertPositive(value, label);
}

function assertKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  label = "Registry value",
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} fields are invalid`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function validateHash(
  value: unknown,
  label: string,
): asserts value is Sha256Hex {
  if (typeof value !== "string" || !HEX_SHA256.test(value))
    throw new Error(`${label} is invalid`);
}

function validateLifecycle(
  value: unknown,
): asserts value is RegistryKeyLifecycle {
  if (!["active", "grace", "disabled", "revoked"].includes(String(value))) {
    throw new Error("Registry key lifecycle is invalid");
  }
}

function validateCredentialBundle(
  value: unknown,
): asserts value is RegistryEncryptedCredentials {
  const bundle = record(value, "Registry credential envelope");
  assertKeys(
    bundle,
    [
      "algorithm",
      "aadVersion",
      "keyId",
      "ivBase64Url",
      "ciphertextBase64Url",
      "plaintextSha256",
    ],
    [],
    "Registry credential envelope",
  );
  if (bundle.algorithm !== "A256GCM" || bundle.aadVersion !== 1)
    throw new Error("Registry credential envelope is invalid");
  assertId(bundle.keyId, "Registry credential key id", 64);
  validateHash(bundle.plaintextSha256, "Registry credential plaintext hash");
  const iv = base64UrlToBytes(String(bundle.ivBase64Url));
  const ciphertext = base64UrlToBytes(String(bundle.ciphertextBase64Url));
  if (
    iv.byteLength !== 12 ||
    ciphertext.byteLength < 16 ||
    ciphertext.byteLength > 32_784
  ) {
    throw new Error("Registry credential envelope is invalid");
  }
}

function validateRouteIdentity(payload: Record<string, unknown>): void {
  assertId(payload.projectId, "Registry project id");
  assertPositive(payload.projectGeneration, "Registry project generation");
  assertId(
    payload.publisherOrganizationId,
    "Registry publisher organization id",
  );
  assertId(payload.publisherClerkOrgId, "Registry Clerk organization id");
  assertString(payload.publisherHandle, "Registry publisher handle", 64);
  assertString(payload.projectSlug, "Registry project slug", 64);
  if (
    !KEBAB.test(String(payload.publisherHandle)) ||
    !KEBAB.test(String(payload.projectSlug))
  ) {
    throw new Error("Registry route handle or slug is invalid");
  }
}

function validateScopes(value: unknown): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 32 ||
    value.some(
      (scope) =>
        typeof scope !== "string" ||
        scope.length < 1 ||
        registryEncodedByteLength(scope) > 128 ||
        !IDENTIFIER.test(scope),
    )
  ) {
    throw new Error("Registry key scopes are invalid");
  }
}

/** Strict operation-specific payload validator. */
export function validateRegistryPayload(
  operation: RegistryOperation,
  value: unknown,
): void {
  const payload = record(value, "Registry payload");
  switch (operation) {
    case "org.put":
      assertKeys(payload, ["clerkOrgId", "organizationId", "publisherHandle"]);
      assertId(payload.clerkOrgId, "Registry Clerk organization id");
      assertId(payload.organizationId, "Registry organization id");
      assertString(payload.publisherHandle, "Registry publisher handle", 64);
      if (!KEBAB.test(String(payload.publisherHandle)))
        throw new Error("Registry publisher handle is invalid");
      return;
    case "org.archive":
      assertKeys(payload, [
        "clerkOrgId",
        "organizationId",
        "archivedAt",
        "reason",
      ]);
      assertId(payload.clerkOrgId, "Registry Clerk organization id");
      if (payload.organizationId !== null)
        assertId(payload.organizationId, "Registry organization id");
      assertPositive(payload.archivedAt, "Registry archive time");
      if (
        payload.reason !== "clerk_deleted" &&
        payload.reason !== "admin_archived"
      )
        throw new Error("Registry archive reason is invalid");
      return;
    case "route.put": {
      assertKeys(payload, [
        "projectId",
        "projectGeneration",
        "publisherOrganizationId",
        "publisherClerkOrgId",
        "publisherHandle",
        "projectSlug",
        "specVersionId",
        "version",
        "publishedAt",
        "spec",
        "visibility",
        "credentialRevision",
        "upstreamCredentials",
        "admission",
        "deprecation",
      ]);
      validateRouteIdentity(payload);
      assertId(payload.specVersionId, "Registry spec version id");
      assertString(payload.version, "Registry route version", 128);
      assertPositive(payload.publishedAt, "Registry publish time");
      assertPositive(
        payload.credentialRevision,
        "Registry credential revision",
      );
      if (payload.visibility !== "public" && payload.visibility !== "private")
        throw new Error("Registry route visibility is invalid");
      if (!isRecord(payload.spec))
        throw new Error("Registry route spec is invalid");
      if (registryEncodedByteLength(payload.spec) > REGISTRY_MAX_SPEC_BYTES)
        throw new Error("Registry OpenAPI spec exceeds size limit");
      validateCredentialBundle(payload.upstreamCredentials);
      const admission = record(payload.admission, "Registry route admission");
      assertKeys(admission, ["mode", "policyRevision"]);
      if (admission.mode !== "open" && admission.mode !== "entitled_only")
        throw new Error("Registry route admission mode is invalid");
      assertPositive(admission.policyRevision, "Registry policy revision");
      const deprecation = record(
        payload.deprecation,
        "Registry route deprecation",
      );
      assertKeys(deprecation, ["deprecatedAt", "sunsetAt", "message"]);
      assertNullablePositive(
        deprecation.deprecatedAt,
        "Registry deprecation time",
      );
      assertNullablePositive(deprecation.sunsetAt, "Registry sunset time");
      if (deprecation.message !== null)
        assertString(
          deprecation.message,
          "Registry deprecation message",
          2_000,
        );
      return;
    }
    case "route.archive":
      assertKeys(payload, [
        "projectId",
        "projectGeneration",
        "publisherOrganizationId",
        "publisherClerkOrgId",
        "publisherHandle",
        "projectSlug",
        "archivedAt",
        "reason",
        "replacementStreamKey",
      ]);
      validateRouteIdentity(payload);
      assertPositive(payload.archivedAt, "Registry route archive time");
      if (
        !["rename", "retired", "org_archived"].includes(String(payload.reason))
      )
        throw new Error("Registry route archive reason is invalid");
      if (payload.replacementStreamKey !== null)
        assertString(
          payload.replacementStreamKey,
          "Registry replacement stream key",
          600,
        );
      return;
    case "key.put":
      assertKeys(payload, [
        "secretSha256",
        "clerkKeyId",
        "clerkOrgId",
        "ownerUserId",
        "subjectUserId",
        "budgetId",
        "budgetRevision",
        "lifecycle",
        "monthlyCapCredits",
        "graceUntil",
        "expiresAt",
        "scopes",
      ]);
      validateHash(payload.secretSha256, "Registry key secret hash");
      assertId(payload.clerkKeyId, "Registry Clerk key id");
      assertId(payload.clerkOrgId, "Registry Clerk organization id");
      assertId(payload.ownerUserId, "Registry key owner");
      assertId(payload.subjectUserId, "Registry key subject");
      if (payload.ownerUserId !== payload.subjectUserId)
        throw new Error("Registry key ownership is not verified");
      assertId(payload.budgetId, "Registry key budget id");
      if (payload.budgetId === payload.clerkOrgId)
        throw new Error(
          "Registry key budget must be independent from organization",
        );
      assertPositive(payload.budgetRevision, "Registry budget revision");
      validateLifecycle(payload.lifecycle);
      if (payload.lifecycle === "revoked")
        throw new Error("Registry key.put cannot be revoked");
      if (payload.monthlyCapCredits !== null)
        assertPositive(payload.monthlyCapCredits, "Registry monthly cap");
      assertNullablePositive(payload.graceUntil, "Registry grace time");
      assertNullablePositive(payload.expiresAt, "Registry key expiry");
      validateScopes(payload.scopes);
      if (payload.lifecycle === "grace" && payload.graceUntil === null)
        throw new Error("Registry grace key requires an expiry");
      return;
    case "key.revoke":
      assertKeys(payload, [
        "secretSha256",
        "clerkKeyId",
        "clerkOrgId",
        "ownerUserId",
        "budgetId",
        "revokedAt",
        "reason",
      ]);
      validateHash(payload.secretSha256, "Registry key secret hash");
      assertId(payload.clerkKeyId, "Registry Clerk key id");
      assertId(payload.clerkOrgId, "Registry Clerk organization id");
      assertId(payload.ownerUserId, "Registry key owner");
      assertId(payload.budgetId, "Registry key budget id");
      assertPositive(payload.revokedAt, "Registry key revoke time");
      if (
        ![
          "rotated",
          "provider_revoked",
          "org_archived",
          "admin_revoked",
        ].includes(String(payload.reason))
      )
        throw new Error("Registry key revoke reason is invalid");
      return;
    case "catalogue.snapshot": {
      assertKeys(payload, [
        "projectId",
        "projectGeneration",
        "route",
        "discoverable",
        "listing",
      ]);
      assertId(payload.projectId, "Registry project id");
      assertPositive(payload.projectGeneration, "Registry project generation");
      if (typeof payload.discoverable !== "boolean")
        throw new Error("Registry catalogue discoverability is invalid");
      if (payload.route !== null) {
        const route = record(payload.route, "Registry catalogue route");
        assertKeys(route, ["streamKey", "revision", "payloadSha256"]);
        assertString(
          route.streamKey,
          "Registry catalogue route stream key",
          600,
        );
        assertPositive(route.revision, "Registry catalogue route revision");
        validateHash(
          route.payloadSha256,
          "Registry catalogue route payload hash",
        );
      }
      if (payload.listing !== null) validateCatalogueListing(payload.listing);
      if (payload.discoverable !== (payload.listing !== null))
        throw new Error(
          "Registry catalogue listing visibility is inconsistent",
        );
      return;
    }
  }
}

function validateCatalogueListing(
  value: unknown,
): asserts value is RegistryCatalogueListing {
  const listing = record(value, "Registry catalogue listing");
  assertKeys(listing, [
    "projectId",
    "publisherOrganizationId",
    "publisherClerkOrgId",
    "publisherHandle",
    "projectSlug",
    "name",
    "organizationName",
    "description",
    "tags",
    "publishedAt",
    "specVersionId",
    "version",
    "pricing",
    "quality",
  ]);
  assertId(listing.projectId, "Registry catalogue project id");
  assertId(
    listing.publisherOrganizationId,
    "Registry catalogue organization id",
  );
  assertId(
    listing.publisherClerkOrgId,
    "Registry catalogue Clerk organization id",
  );
  assertString(listing.publisherHandle, "Registry catalogue handle", 64);
  assertString(listing.projectSlug, "Registry catalogue slug", 64);
  assertString(listing.name, "Registry catalogue name", 120);
  assertString(
    listing.organizationName,
    "Registry catalogue organization name",
    120,
  );
  if (listing.description !== null)
    assertString(listing.description, "Registry catalogue description", 2_000);
  if (
    !Array.isArray(listing.tags) ||
    listing.tags.length > 32 ||
    listing.tags.some(
      (tag) =>
        typeof tag !== "string" ||
        tag.length === 0 ||
        registryEncodedByteLength(tag) > 64,
    )
  )
    throw new Error("Registry catalogue tags are invalid");
  assertPositive(listing.publishedAt, "Registry catalogue publish time");
  assertId(listing.specVersionId, "Registry catalogue spec version id");
  assertString(listing.version, "Registry catalogue version", 128);
  const pricing = record(listing.pricing, "Registry catalogue pricing");
  assertKeys(pricing, [
    "minCostCredits",
    "maxCostCredits",
    "endpointCount",
    "hasFreeTier",
  ]);
  assertNonNegative(pricing.minCostCredits, "Registry minimum cost");
  assertNonNegative(pricing.maxCostCredits, "Registry maximum cost");
  assertNonNegative(pricing.endpointCount, "Registry endpoint count");
  if (
    pricing.minCostCredits > pricing.maxCostCredits ||
    typeof pricing.hasFreeTier !== "boolean"
  )
    throw new Error("Registry catalogue pricing is invalid");
  if (listing.quality !== null && !isRecord(listing.quality))
    throw new Error("Registry catalogue quality is invalid");
}

export function registryStreamKindForOperation(
  operation: RegistryOperation,
): RegistryStreamKind {
  return operation.split(".", 1)[0] as RegistryStreamKind;
}

export function registryStreamKeyForPayload(
  operation: RegistryOperation,
  payload: unknown,
): string {
  const row = record(payload, "Registry payload");
  switch (operation) {
    case "org.put":
    case "org.archive":
      return `org:${String(row.clerkOrgId)}`;
    case "route.put":
    case "route.archive":
      return `route:${String(row.publisherHandle)}/${String(row.projectSlug)}`;
    case "key.put":
    case "key.revoke":
      return `key:${String(row.secretSha256)}`;
    case "catalogue.snapshot":
      return `catalogue:${String(row.projectId)}`;
  }
}

export function registryEntityKey(
  event: Pick<RegistryEvent, "operation" | "payload">,
): string {
  const payload = record(event.payload, "Registry payload");
  switch (event.operation) {
    case "org.put":
    case "org.archive":
      return `org:${String(payload.clerkOrgId)}`;
    case "route.put":
    case "route.archive":
      return `project:${String(payload.projectId)}:${String(payload.projectGeneration)}`;
    case "key.put":
    case "key.revoke":
      return `key:${String(payload.secretSha256)}`;
    case "catalogue.snapshot":
      return `catalogue:${String(payload.projectId)}:${String(payload.projectGeneration)}`;
  }
}

export async function registryPayloadDigest(
  operation: RegistryOperation,
  payload: unknown,
): Promise<Sha256Hex> {
  validateRegistryPayload(operation, payload);
  return await sha256Hex(canonicalJson(payload));
}

export async function registryEventDigest(
  eventWithoutEventId: unknown,
): Promise<Sha256Hex> {
  return await sha256Hex(canonicalJson(eventWithoutEventId));
}

export async function createRegistryEvent<O extends RegistryOperation>(
  input: Omit<
    RegistryEventFor<O>,
    "schemaVersion" | "eventId" | "payloadSha256" | "nonce"
  > & { nonce?: string },
): Promise<RegistryEventFor<O>> {
  validateRegistryPayload(input.operation, input.payload);
  if (
    registryStreamKeyForPayload(input.operation, input.payload) !==
    input.streamKey
  )
    throw new Error("Registry payload identity does not match stream key");
  assertPositive(input.revision, "Registry revision");
  assertPositive(input.occurredAt, "Registry occurredAt");
  if (input.occurredAt > Date.now() + REGISTRY_MAX_CLOCK_SKEW_MS)
    throw new Error("Registry occurredAt is too far in the future");
  const nonce =
    input.nonce ?? bytesToBase64Url(crypto.getRandomValues(new Uint8Array(18)));
  if (!NONCE.test(nonce)) throw new Error("Registry event nonce is invalid");
  const payloadSha256 = await registryPayloadDigest(
    input.operation,
    input.payload,
  );
  const unsigned = {
    schemaVersion: REGISTRY_PROTOCOL_VERSION,
    streamKey: input.streamKey,
    revision: input.revision,
    operation: input.operation,
    occurredAt: input.occurredAt,
    nonce,
    payloadSha256,
    payload: input.payload,
  } as const;
  const eventId = `r2_${await registryEventDigest(unsigned)}` as `r2_${string}`;
  const event = { ...unsigned, eventId } as RegistryEventFor<O>;
  if (registryEncodedByteLength(event) > REGISTRY_MAX_EVENT_BYTES)
    throw new Error("Registry event exceeds size limit");
  return event;
}

export async function validateRegistryEvent(
  value: unknown,
): Promise<RegistryEvent> {
  const event = record(value, "Registry event");
  assertKeys(
    event,
    [
      "schemaVersion",
      "eventId",
      "streamKey",
      "revision",
      "operation",
      "occurredAt",
      "nonce",
      "payloadSha256",
      "payload",
    ],
    [],
    "Registry event",
  );
  if (
    event.schemaVersion !== REGISTRY_PROTOCOL_VERSION ||
    typeof event.eventId !== "string" ||
    !event.eventId.startsWith("r2_")
  )
    throw new Error("Registry event envelope is invalid");
  assertString(event.streamKey, "Registry stream key", 600);
  assertPositive(event.revision, "Registry revision");
  if (
    !REGISTRY_V2_PRODUCER_CONTRACT.operations.includes(
      event.operation as RegistryOperation,
    )
  )
    throw new Error("Registry operation is invalid");
  assertPositive(event.occurredAt, "Registry occurredAt");
  if (event.occurredAt > Date.now() + REGISTRY_MAX_CLOCK_SKEW_MS)
    throw new Error("Registry occurredAt is too far in the future");
  if (typeof event.nonce !== "string" || !NONCE.test(event.nonce))
    throw new Error("Registry event nonce is invalid");
  validateHash(event.payloadSha256, "Registry payload hash");
  validateRegistryPayload(event.operation as RegistryOperation, event.payload);
  if (
    registryStreamKeyForPayload(
      event.operation as RegistryOperation,
      event.payload,
    ) !== event.streamKey
  )
    throw new Error("Registry payload identity does not match stream key");
  if (registryEncodedByteLength(event) > REGISTRY_MAX_EVENT_BYTES)
    throw new Error("Registry event exceeds size limit");
  const payloadHash = await registryPayloadDigest(
    event.operation as RegistryOperation,
    event.payload,
  );
  if (payloadHash !== event.payloadSha256)
    throw new Error("Registry payload digest mismatch");
  const { eventId, ...withoutId } = event;
  const expected = `r2_${await registryEventDigest(withoutId)}`;
  if (eventId !== expected) throw new Error("Registry event digest mismatch");
  return event as RegistryEvent;
}

function compareBytes(left: string, right: string): number {
  const a = utf8(left);
  const b = utf8(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

export async function registryManifestShard(
  entityKey: string,
): Promise<string> {
  const digest = await sha256Hex(entityKey);
  return digest.slice(0, 2);
}

export async function registryManifestPageDigest(
  items: readonly RegistryManifestItem[],
): Promise<Sha256Hex> {
  return await sha256Hex(canonicalJson(items));
}

export async function registryManifestTotalDigest(
  kind: RegistryManifestKind,
  shard: string,
  items: readonly RegistryManifestItem[],
): Promise<Sha256Hex> {
  let input = `zevium-registry-manifest-v2\0${kind}\0${shard}\0`;
  for (const item of items) {
    const body = canonicalJson(item);
    const length = new TextEncoder().encode(body).byteLength;
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, length);
    input += String.fromCharCode(...prefix) + body;
  }
  return await sha256Hex(input);
}

export async function createRegistryManifestPage(
  input: Omit<
    RegistryManifestPage,
    "snapshotId" | "itemCount" | "pageSha256" | "totalSha256"
  >,
): Promise<RegistryManifestPage> {
  if (
    input.items.length > REGISTRY_MANIFEST_MAX_ITEMS ||
    registryEncodedByteLength(input.items) > REGISTRY_MANIFEST_MAX_BYTES
  )
    throw new Error("Registry manifest page exceeds size limit");
  const items = [...input.items].sort(
    (a, b) =>
      compareBytes(a.entityKey, b.entityKey) ||
      compareBytes(a.streamKey, b.streamKey),
  );
  const pageSha256 = await registryManifestPageDigest(items);
  const totalSha256 = await registryManifestTotalDigest(
    input.kind,
    input.shard,
    items,
  );
  const snapshotMaterial = {
    kind: input.kind,
    shard: input.shard,
    createdAt: input.createdAt,
    totalCount: input.totalCount,
    totalSha256,
  };
  const snapshotId =
    `rm2_${await sha256Hex(canonicalJson(snapshotMaterial))}` as `rm2_${string}`;
  return {
    ...input,
    snapshotId,
    items,
    itemCount: items.length,
    pageSha256,
    totalSha256,
  };
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("Registry encrypted value is invalid");
  try {
    const binary = atob(
      value
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "="),
    );
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new Error("Registry encrypted value is invalid");
  }
}

function strictKeyBytes(raw: string): Uint8Array<ArrayBuffer> {
  if (/^[a-fA-F0-9]{64}$/.test(raw))
    return Uint8Array.from(raw.match(/.{2}/g)!, (pair) =>
      Number.parseInt(pair, 16),
    );
  const decoded = base64UrlToBytes(raw.replace(/=+$/g, ""));
  if (decoded.byteLength !== 32)
    throw new Error("Registry transport key must contain exactly 32 bytes");
  return decoded;
}

export type RegistryTransportKeyring = {
  current: string;
  keys: Record<string, string>;
};
export function parseRegistryTransportKeyring(
  raw: string | undefined,
): RegistryTransportKeyring {
  if (!raw) throw new Error("Registry transport keyring is not configured");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Registry transport keyring is invalid");
  }
  const row = record(parsed, "Registry transport keyring");
  assertKeys(row, ["current", "keys"]);
  assertId(row.current, "Registry transport current key", 64);
  const keys = record(row.keys, "Registry transport keyring keys");
  for (const [id, value] of Object.entries(keys)) {
    assertId(id, "Registry transport key id", 64);
    if (typeof value !== "string")
      throw new Error("Registry transport keyring is invalid");
    strictKeyBytes(value);
  }
  if (typeof keys[row.current] !== "string")
    throw new Error("Registry transport current key is unavailable");
  return { current: row.current, keys: keys as Record<string, string> };
}

function credentialAad(
  streamKey: string,
  revision: number,
): Uint8Array<ArrayBuffer> {
  return utf8(
    canonicalJson({
      purpose: "zevium-registry-credentials-v2",
      schemaVersion: 2,
      streamKey,
      revision,
    }),
  );
}

async function importAesKey(
  raw: string,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    strictKeyBytes(raw),
    "AES-GCM",
    false,
    [usage],
  );
}

export async function encryptRegistryCredentials(
  keyring: RegistryTransportKeyring,
  streamKey: string,
  revision: number,
  headers: Record<string, string>,
): Promise<RegistryEncryptedCredentials> {
  const rawKey = keyring.keys[keyring.current];
  if (rawKey === undefined)
    throw new Error("Registry transport current key is unavailable");
  const plaintextJson = canonicalJson(headers);
  if (
    registryEncodedByteLength(plaintextJson) >
    REGISTRY_MAX_CREDENTIAL_PLAINTEXT_BYTES
  )
    throw new Error("Registry credential plaintext exceeds size limit");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: credentialAad(streamKey, revision) },
    await importAesKey(rawKey, "encrypt"),
    utf8(plaintextJson),
  );
  return {
    algorithm: "A256GCM",
    aadVersion: 1,
    keyId: keyring.current,
    ivBase64Url: bytesToBase64Url(iv),
    ciphertextBase64Url: bytesToBase64Url(new Uint8Array(ciphertext)),
    plaintextSha256: await sha256Hex(plaintextJson),
  };
}

export async function decryptRegistryCredentials(
  keyring: RegistryTransportKeyring,
  streamKey: string,
  revision: number,
  bundle: RegistryEncryptedCredentials,
): Promise<Record<string, string>> {
  validateCredentialBundle(bundle);
  const rawKey = keyring.keys[bundle.keyId];
  if (rawKey === undefined)
    throw new Error("Registry credential key version is unavailable");
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBytes(bundle.ivBase64Url),
        additionalData: credentialAad(streamKey, revision),
      },
      await importAesKey(rawKey, "decrypt"),
      base64UrlToBytes(bundle.ciphertextBase64Url),
    );
  } catch {
    throw new Error("Registry credential envelope authentication failed");
  }
  if (plaintext.byteLength > REGISTRY_MAX_CREDENTIAL_PLAINTEXT_BYTES)
    throw new Error("Registry credential plaintext exceeds size limit");
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        plaintext,
      ),
    );
  } catch {
    throw new Error("Registry credential payload is invalid");
  }
  const headers = record(decoded, "Registry credential payload");
  for (const value of Object.values(headers))
    if (typeof value !== "string")
      throw new Error("Registry credential payload is invalid");
  if ((await sha256Hex(canonicalJson(headers))) !== bundle.plaintextSha256)
    throw new Error("Registry credential plaintext hash mismatch");
  return headers as Record<string, string>;
}

async function hmac(
  secret: string,
  message: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const length = new TextEncoder().encode(secret).byteLength;
  if (length < 32 || length > 4096)
    throw new Error("Registry signing secret must be 32-4096 UTF-8 bytes");
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, message));
}

async function verifyHmac(
  secret: string,
  message: Uint8Array<ArrayBuffer>,
  expected: string,
): Promise<boolean> {
  if (!HEX_SHA256.test(expected)) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      utf8(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "HMAC",
      key,
      Uint8Array.from(expected.match(/.{2}/g)!, (pair) =>
        Number.parseInt(pair, 16),
      ) as Uint8Array<ArrayBuffer>,
      message,
    );
  } catch {
    return false;
  }
}

function timestampBytes(
  timestamp: string,
  nonce: string,
  body: string,
): Uint8Array<ArrayBuffer> {
  if (!/^(0|[1-9][0-9]*)$/.test(timestamp))
    throw new Error("Registry timestamp is invalid");
  if (!NONCE.test(nonce)) throw new Error("Registry nonce is invalid");
  return Uint8Array.from([
    ...utf8(timestamp),
    46,
    ...utf8(nonce),
    46,
    ...utf8(body),
  ]);
}

export async function signRegistryEventRequest(
  secret: string,
  timestamp: string,
  nonce: string,
  rawCanonicalBody: string,
): Promise<`v2=${string}`> {
  return `v2=${await hmac(secret, timestampBytes(timestamp, nonce, rawCanonicalBody))}`;
}
export async function verifyRegistryEventRequest(
  secret: string,
  timestamp: string,
  nonce: string,
  rawCanonicalBody: string,
  signature: string,
): Promise<boolean> {
  if (!signature.startsWith("v2=")) return false;
  try {
    return await verifyHmac(
      secret,
      timestampBytes(timestamp, nonce, rawCanonicalBody),
      signature.slice(3),
    );
  } catch {
    return false;
  }
}
export async function signRegistryBootstrapRequest(
  secret: string,
  timestamp: string,
  nonce: string,
  rawCanonicalBody: string,
): Promise<`v2=${string}`> {
  return await signRegistryEventRequest(
    secret,
    timestamp,
    nonce,
    rawCanonicalBody,
  );
}
export async function verifyRegistryBootstrapRequest(
  secret: string,
  timestamp: string,
  nonce: string,
  rawCanonicalBody: string,
  signature: string,
): Promise<boolean> {
  return await verifyRegistryEventRequest(
    secret,
    timestamp,
    nonce,
    rawCanonicalBody,
    signature,
  );
}
export async function signRegistryAck(
  secret: string,
  requestTimestamp: string,
  requestNonce: string,
  rawCanonicalAck: string,
): Promise<`v2=${string}`> {
  return `v2=${await hmac(secret, Uint8Array.from([...utf8("ack."), ...utf8(requestTimestamp), 46, ...utf8(requestNonce), 46, ...utf8(rawCanonicalAck)]) as Uint8Array<ArrayBuffer>)}`;
}
export async function verifyRegistryAck(
  secret: string,
  requestTimestamp: string,
  requestNonce: string,
  rawCanonicalAck: string,
  signature: string,
): Promise<boolean> {
  if (!signature.startsWith("v2=")) return false;
  try {
    return await verifyHmac(
      secret,
      Uint8Array.from([
        ...utf8("ack."),
        ...utf8(requestTimestamp),
        46,
        ...utf8(requestNonce),
        46,
        ...utf8(rawCanonicalAck),
      ]) as Uint8Array<ArrayBuffer>,
      signature.slice(3),
    );
  } catch {
    return false;
  }
}

export function validateRegistryAck(
  value: unknown,
): asserts value is RegistryAck {
  const ack = record(value, "Registry acknowledgement");
  assertKeys(ack, [
    "schemaVersion",
    "eventId",
    "bodySha256",
    "streamKey",
    "revision",
    "operation",
    "payloadSha256",
    "entityKey",
    "status",
    "receiverRevision",
    "receiverEventId",
    "receiverPayloadSha256",
    "receiverTombstone",
  ]);
  if (
    ack.schemaVersion !== 2 ||
    typeof ack.eventId !== "string" ||
    !ack.eventId.startsWith("r2_")
  )
    throw new Error("Registry acknowledgement is invalid");
  assertString(ack.bodySha256, "Registry acknowledgement body hash", 64);
  assertString(ack.streamKey, "Registry acknowledgement stream key", 600);
  assertPositive(ack.revision, "Registry acknowledgement revision");
  if (
    !REGISTRY_V2_PRODUCER_CONTRACT.operations.includes(
      ack.operation as RegistryOperation,
    )
  )
    throw new Error("Registry acknowledgement operation is invalid");
  validateHash(ack.payloadSha256, "Registry acknowledgement payload hash");
  assertString(ack.entityKey, "Registry acknowledgement entity key", 600);
  if (
    !["applied", "duplicate", "superseded", "gap", "conflict"].includes(
      String(ack.status),
    )
  )
    throw new Error("Registry acknowledgement status is invalid");
  assertNonNegative(ack.receiverRevision, "Registry receiver revision");
  if (
    ack.receiverEventId !== null &&
    (typeof ack.receiverEventId !== "string" ||
      !ack.receiverEventId.startsWith("r2_"))
  )
    throw new Error("Registry acknowledgement receiver event is invalid");
  if (ack.receiverPayloadSha256 !== null)
    validateHash(ack.receiverPayloadSha256, "Registry receiver payload hash");
  if (typeof ack.receiverTombstone !== "boolean")
    throw new Error("Registry acknowledgement tombstone is invalid");
  if (registryEncodedByteLength(ack) > REGISTRY_MAX_ACK_BYTES)
    throw new Error("Registry acknowledgement exceeds size limit");
}

export function validateRegistryVerifiedKeyProjection(
  value: unknown,
): RegistryVerifiedKeyProjection {
  const projection = record(value, "Registry verified key projection");
  assertKeys(
    projection,
    ["schemaVersion", "verifiedAt", "provision"],
    [],
    "Registry verified key projection",
  );
  if (projection.schemaVersion !== 1)
    throw new Error("Registry verified key projection schema is invalid");
  assertPositive(
    projection.verifiedAt,
    "Registry verified key projection time",
  );
  validateRegistryPayload("key.put", projection.provision);
  return projection as RegistryVerifiedKeyProjection;
}
export function validateRegistryVerifiedKeyRotationProjection(
  value: unknown,
): RegistryVerifiedKeyRotationProjection {
  const projection = record(value, "Registry verified key rotation projection");
  assertKeys(projection, [
    "schemaVersion",
    "verifiedAt",
    "operationId",
    "oldKeyId",
    "newProvision",
    "graceUntil",
  ]);
  if (projection.schemaVersion !== 1)
    throw new Error("Registry verified key rotation schema is invalid");
  assertPositive(projection.verifiedAt, "Registry verified key rotation time");
  assertId(projection.operationId, "Registry rotation operation");
  assertId(projection.oldKeyId, "Registry old key id");
  assertPositive(projection.graceUntil, "Registry key grace time");
  validateRegistryPayload("key.put", projection.newProvision);
  const provision = projection.newProvision as RegistryPayloadMap["key.put"];
  if (
    provision.clerkKeyId === projection.oldKeyId ||
    projection.graceUntil <= projection.verifiedAt
  )
    throw new Error("Registry verified key rotation is invalid");
  return projection as RegistryVerifiedKeyRotationProjection;
}

export async function sealOneTimeExecutionKey(
  issued: VerifiedOneTimeExecutionKey,
  settings: {
    lifecycle?: "active" | "grace" | "disabled";
    monthlyCapCredits?: number | null;
    graceUntil?: number | null;
    expiresAt?: number | null;
  } = {},
): Promise<SealedExecutionKey> {
  if (issued.ownerUserId !== issued.subjectUserId)
    throw new Error("Registry key ownership is not verified");
  assertString(issued.secret, "Execution key secret", 16_384);
  const provision: RegistryPayloadMap["key.put"] = {
    secretSha256: await sha256Hex(issued.secret),
    clerkKeyId: issued.keyId,
    clerkOrgId: issued.clerkOrgId,
    ownerUserId: issued.ownerUserId,
    subjectUserId: issued.subjectUserId,
    budgetId: issued.budgetId,
    budgetRevision: issued.budgetRevision,
    lifecycle: settings.lifecycle ?? "active",
    monthlyCapCredits: settings.monthlyCapCredits ?? null,
    graceUntil: settings.graceUntil ?? null,
    expiresAt: settings.expiresAt ?? null,
    scopes: [...issued.scopes],
  };
  validateRegistryPayload("key.put", provision);
  return { oneTimeSecret: issued.secret, provision };
}

export async function signRegistryVerifiedKeyProjection(
  secret: string,
  projection: RegistryVerifiedKeyProjection,
): Promise<`v1=${string}`> {
  validateRegistryVerifiedKeyProjection(projection);
  return `v1=${await hmac(secret, utf8(`zevium-registry-key-projection-v1\0${canonicalJson(projection)}`))}`;
}
export async function verifyRegistryVerifiedKeyProjection(
  secret: string,
  projection: RegistryVerifiedKeyProjection,
  signature: string,
): Promise<boolean> {
  try {
    validateRegistryVerifiedKeyProjection(projection);
  } catch {
    return false;
  }
  return (
    signature.startsWith("v1=") &&
    (await verifyHmac(
      secret,
      utf8(`zevium-registry-key-projection-v1\0${canonicalJson(projection)}`),
      signature.slice(3),
    ))
  );
}
export async function signRegistryVerifiedKeyRotationProjection(
  secret: string,
  projection: RegistryVerifiedKeyRotationProjection,
): Promise<`v1=${string}`> {
  validateRegistryVerifiedKeyRotationProjection(projection);
  return `v1=${await hmac(secret, utf8(`zevium-registry-key-rotation-projection-v1\0${canonicalJson(projection)}`))}`;
}
export async function verifyRegistryVerifiedKeyRotationProjection(
  secret: string,
  projection: RegistryVerifiedKeyRotationProjection,
  signature: string,
): Promise<boolean> {
  try {
    validateRegistryVerifiedKeyRotationProjection(projection);
  } catch {
    return false;
  }
  return (
    signature.startsWith("v1=") &&
    (await verifyHmac(
      secret,
      utf8(
        `zevium-registry-key-rotation-projection-v1\0${canonicalJson(projection)}`,
      ),
      signature.slice(3),
    ))
  );
}

export async function signEntitlementAdmission(
  secret: string,
  claims: EntitlementAdmissionClaims,
): Promise<SignedEntitlementAdmission> {
  return {
    claims,
    signature: `v1=${await hmac(secret, utf8(`zevium-entitlement-admission-v1\0${canonicalJson(claims)}`))}`,
  };
}
export async function verifyEntitlementAdmission(
  secret: string,
  proof: SignedEntitlementAdmission,
): Promise<boolean> {
  try {
    return (
      proof.signature.startsWith("v1=") &&
      (await verifyHmac(
        secret,
        utf8(`zevium-entitlement-admission-v1\0${canonicalJson(proof.claims)}`),
        proof.signature.slice(3),
      ))
    );
  } catch {
    return false;
  }
}
