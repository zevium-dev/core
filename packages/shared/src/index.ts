// Shared between apps/web and apps/gateway: OpenAPI spec parsing,
// x-zevium-* extension extraction, credit math. Grows with the build.

/** $1 = 10,000 credits (PRODUCT.md). One global constant, never per-API. */
export const CREDITS_PER_DOLLAR = 10_000;

/** Platform cut: 5%. Publishers keep 95%. */
export const PLATFORM_CUT = 0.05;

export type { EndpointPricing } from "./pricing.js";

export {
  parseSpec,
  matchOperation,
  extractPricing,
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
} from "./openapi.js";

export { generateMockResponse, type GeneratedMockResponse } from "./mock.js";

export { isPublicIp } from "./public-ip.js";

export {
  REGISTRY_SYNC_SCHEMA_VERSION,
  canonicalJson,
  registryPayloadDigest,
  registrySyncPath,
  sha256Hex,
  signRegistrySyncRequest,
  type RegistryKeyLifecycle,
  type RegistryKeySetting,
  type RegistryRouteSnapshot,
  type RegistrySyncAck,
  type RegistrySyncEnvelope,
  type RegistrySyncOperation,
  type RegistrySyncPathOverrides,
  type RegistrySyncPayloadMap,
} from "./registry-sync.js";

/** Exact canonical Registry v2 seam. Receiver cutover owned elsewhere. */
export {
  REGISTRY_PROTOCOL_VERSION,
  REGISTRY_EVENT_PATH,
  REGISTRY_V2_PRODUCER_CONTRACT,
  REGISTRY_RECEIVER_SECURITY_CONTRACT,
  REGISTRY_MAX_EVENT_BYTES,
  REGISTRY_MAX_SPEC_BYTES,
  type RegistryOperation as RegistryV2Operation,
  type RegistryEvent as RegistryV2Event,
  type RegistryAck as RegistryV2Ack,
  type RegistryEncryptedCredentials,
  type RegistryPayloadMap as RegistryV2PayloadMap,
  type RegistryOutboxRow as RegistryV2OutboxRow,
  type RegistryManifestPage,
  createRegistryEvent,
  validateRegistryEvent,
  validateRegistryAck,
  signRegistryEventRequest,
  verifyRegistryEventRequest,
  signRegistryAck,
  verifyRegistryAck,
  encryptRegistryCredentials,
  decryptRegistryCredentials,
} from "./registry-v2.js";

export {
  EDGE_KEY_REVOCATION_SCHEMA_VERSION,
  EDGE_KEY_REVOCATION_PATH,
  EDGE_KEY_REVOCATION_TIMESTAMP_HEADER,
  EDGE_KEY_REVOCATION_NONCE_HEADER,
  EDGE_KEY_REVOCATION_SIGNATURE_HEADER,
  EDGE_KEY_REVOCATION_ACK_SIGNATURE_HEADER,
  EDGE_KEY_REVOCATION_MAX_BODY_BYTES,
  EDGE_KEY_REVOCATION_MAX_ACK_BYTES,
  edgeKeyRevocationBody,
  edgeKeyRevocationBodySha256,
  signEdgeKeyRevocationRequest,
  signEdgeKeyRevocationAck,
  verifyEdgeKeyRevocationRequest,
  verifyEdgeKeyRevocationAck,
  parseEdgeKeyRevocationEvent,
  parseEdgeKeyRevocationAck,
  ackMatchesEdgeKeyRevocationEvent,
  type EdgeKeyRevocationEvent,
  type EdgeKeyRevocationAck,
  type EdgeKeyRevocationReason,
  type EdgeKeyRevocationAckStatus,
} from "./edge-key-revocation.js";

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
