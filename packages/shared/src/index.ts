// Shared between apps/web and apps/gateway: OpenAPI spec parsing,
// x-zevium-* extension extraction, credit math. Grows with the build.

/** $1 = 10,000 credits (PRODUCT.md). One global constant, never per-API. */
export const CREDITS_PER_DOLLAR = 10_000;

/** Platform cut: 5%. Publishers keep 95%. */
export const PLATFORM_CUT = 0.05;

export type { EndpointPricing } from "./pricing.js";

export {
  resolveLocalJsonPointer,
  resolveLocalJsonRefChain,
} from "./json-pointer.js";

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
