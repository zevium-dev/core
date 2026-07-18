/**
 * Thin re-export shim — validation lives in @zevium/shared.
 * Convex callers keep SpecIssue[] via collectOpenApiSpecIssues.
 */
export {
  isValidSlug,
  isValidSemver,
  hasErrors,
  type SpecIssue,
  collectOpenApiSpecIssues as validateOpenApiSpec,
} from "@zevium/shared";
