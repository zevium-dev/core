// Shared between apps/web and apps/gateway: OpenAPI spec parsing,
// x-zevium-* extension extraction, credit math. Grows with the build.

/** $1 = 10,000 credits (PRODUCT.md). One global constant, never per-API. */
export const CREDITS_PER_DOLLAR = 10_000;

/** Platform cut: 5%. Publishers keep 95%. */
export const PLATFORM_CUT = 0.05;

/** Hard cap shared by gateway queue batches and Convex usage ingestion. */
export const MAX_USAGE_INGEST_EVENTS = 100;

export {
  MAX_DAILY_FREE_TIER_CALLS,
  MAX_ENDPOINT_COST_CREDITS,
  type EndpointPricing,
} from "./pricing.js";

export {
  resolveLocalJsonPointer,
  resolveLocalJsonRefChain,
} from "./json-pointer.js";

export {
  parseSpec,
  MAX_OPENAPI_SPEC_BYTES,
  matchOperation,
  extractPricing,
  parseCreditExtension,
  extractHealthCheckTarget,
  trimTrailingSlashes,
  normalizePath,
  matchPathTemplate,
  joinUpstreamUrl,
  type HttpMethod,
  type OpenApiServer,
  type OpenApiOperation,
  type OpenApiPathItem,
  type ParsedOpenApiSpec,
  type MatchedOperation,
  type HealthCheckTarget,
} from "./openapi.js";

export { generateMockResponse, type GeneratedMockResponse } from "./mock.js";

export type {
  PublicReviewContract,
  QualityIncidentContract,
  QualityProbeOutcome,
  QualitySnapshotContract,
  ReviewAggregateContract,
} from "./quality.js";
export { REGISTRY_V2_SHARED_VECTORS } from "./registry-v2-vectors.js";

export {
  ORG_CAPABILITIES,
  ORG_ROLES,
  isOrgRole,
  isPrivilegedOrgRole,
  projectOrgCapabilities,
  type OrgCapability,
  type OrgCapabilityProjection,
  type OrgRole,
} from "./org-capabilities.js";

export {
  signTransferCorrelation,
  verifyTransferCorrelation,
  type TransferCorrelationPayload,
} from "./finance.js";

export {
  isValidSlug,
  isValidSemver,
  collectOpenApiSpecIssues,
  validateOpenApiSpec,
  hasErrors,
  hasValidationErrors,
  type SpecIssue,
  type SpecValidationResult,
} from "./validate.js";

export {
  REGISTRY_PROTOCOL_VERSION,
  REGISTRY_EVENT_PATH,
  REGISTRY_BOOTSTRAP_PATH,
  REGISTRY_RECEIVER_METHOD,
  REGISTRY_EVENT_TIMESTAMP_HEADER,
  REGISTRY_EVENT_NONCE_HEADER,
  REGISTRY_EVENT_SIGNATURE_HEADER,
  REGISTRY_ACK_SIGNATURE_HEADER,
  REGISTRY_MAX_CLOCK_SKEW_MS,
  REGISTRY_MAX_EVENT_BYTES,
  REGISTRY_MAX_SPEC_BYTES,
  REGISTRY_MAX_CREDENTIAL_PLAINTEXT_BYTES,
  REGISTRY_MAX_ACK_BYTES,
  REGISTRY_BOOTSTRAP_MAX_EVENTS,
  REGISTRY_BOOTSTRAP_MAX_ENCODED_EVENT_BYTES,
  REGISTRY_MANIFEST_MAX_ITEMS,
  REGISTRY_MANIFEST_MAX_BYTES,
  REGISTRY_DELIVERY_LEASE_MS,
  REGISTRY_DELIVERY_TIMEOUT_MS,
  REGISTRY_DELIVERY_MAX_ATTEMPTS,
  REGISTRY_DELIVERY_MAX_BACKOFF_MS,
  REGISTRY_ROLLOUT_BATCH_SIZE,
  REGISTRY_RECEIVER_SECURITY_CONTRACT,
  REGISTRY_V2_PRODUCER_CONTRACT,
  registryGenesisDigest,
  registryStreamKindForOperation,
  registryStreamKeyForPayload,
  registryEntityKey,
  canonicalJson,
  registryEncodedByteLength,
  sha256Hex,
  registryPayloadDigest,
  registryEventDigest,
  createRegistryEvent,
  validateRegistryPayload,
  validateRegistryEvent,
  validateRegistryAck,
  registryManifestShard,
  registryManifestPageDigest,
  registryManifestTotalDigest,
  createRegistryManifestPage,
  signRegistryEventRequest,
  verifyRegistryEventRequest,
  signRegistryBootstrapRequest,
  verifyRegistryBootstrapRequest,
  signRegistryAck,
  verifyRegistryAck,
  validateRegistryVerifiedKeyProjection,
  validateRegistryVerifiedKeyRotationProjection,
  signRegistryVerifiedKeyProjection,
  verifyRegistryVerifiedKeyProjection,
  signRegistryVerifiedKeyRotationProjection,
  verifyRegistryVerifiedKeyRotationProjection,
  signEntitlementAdmission,
  verifyEntitlementAdmission,
  parseRegistryTransportKeyring,
  encryptRegistryCredentials,
  decryptRegistryCredentials,
  sealOneTimeExecutionKey,
  type RegistryStreamKind,
  type RegistryOperation,
  type JsonPrimitive,
  type JsonValue,
  type Sha256Hex,
  type RegistryKeyLifecycle,
  type RegistryAdmissionMode,
  type RegistryRouteAdmission,
  type RegistryEncryptedCredentials,
  type RegistryTransportKeyring,
  type RegistryCatalogueListing,
  type RegistryPayloadMap,
  type RegistryEvent,
  type RegistryAckStatus,
  type RegistryAck,
  type RegistryOutboxState,
  type RegistryOutboxRow,
  type RegistryManifestKind,
  type RegistryManifestItem,
  type RegistryManifestPage,
  type RegistryRolloutStatus,
  type RegistryRolloutPhase,
  type RegistryRolloutCounts,
  type RegistryRolloutDigests,
  type RegistryRolloutVerification,
  type RegistryRolloutManifest,
  type EntitlementAdmissionClaims,
  type SignedEntitlementAdmission,
  type EntitlementAdmissionResult,
  type EntitlementAdmissionAdapter,
  type VerifiedOneTimeExecutionKey,
  type SealedExecutionKey,
  type RegistryVerifiedKeyProjection,
  type RegistryVerifiedKeyRotationProjection,
} from "./registry-sync.js";
