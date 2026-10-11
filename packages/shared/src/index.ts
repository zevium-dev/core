// Shared between apps/web and apps/gateway: OpenAPI spec parsing,
// x-zevium-* extension extraction, credit math. Grows with the build.

/** $1 = 10,000 credits (.agents/notes/features/pricing.md). One global constant, never per-API. */
export const CREDITS_PER_DOLLAR = 10_000;

/** Platform cut: 5%. Publishers keep 95%. */
export const PLATFORM_CUT = 0.05;

/** Hard cap shared by gateway queue batches and Convex usage ingestion. */
export const MAX_USAGE_INGEST_EVENTS = 100;

export { isTokenPricingEnabled } from "./pricing-policy.js";

export {
  MAX_DAILY_FREE_TIER_CALLS,
  MAX_ENDPOINT_COST_CREDITS,
  type EndpointPricing,
  type TokenPricing,
  parseTokenPricing,
  tokenCredits,
  tokenPricingLabel,
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
export { isPublicIp } from "./public-ip.js";

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

export { SUPPORTED_CONNECT_COUNTRY_CODES } from "./connect-countries.js";

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
  canonicalJson,
  sha256Hex,
  sealOneTimeExecutionKey,
  signRegistryVerifiedKeyProjection,
  signRegistryVerifiedKeyRotationProjection,
  verifyRegistryVerifiedKeyProjection,
  verifyRegistryVerifiedKeyRotationProjection,
  validateRegistryVerifiedKeyProjection,
  validateRegistryVerifiedKeyRotationProjection,
  type RegistryVerifiedKeyProjection,
  type RegistryVerifiedKeyRotationProjection,
} from "./key-projection.js";

export { synthesize } from "./mock.js";

export {
  generateSpecContract,
  GenerationError,
  GENERATOR_VERSION,
  MAX_GENERATED_BYTES,
  type GeneratedContract,
  type GeneratedOperation,
  type GeneratedFlag,
  type JsonSchema,
} from "./spec-generation/index.js";
export {
  generatedCallArguments,
  generatedToolArguments,
} from "./spec-generation/cli.js";

export {
  formValueFits,
  schemaToForm,
  initialFormValue,
  validateFormValue,
  operationParameters,
  serializeRequestParameters,
  isFormObject,
  formPath,
  type FormNode,
  type FormSchema,
  type FormIssue,
  type FormValidation,
  type RequestParameter,
} from "./request-form.js";
