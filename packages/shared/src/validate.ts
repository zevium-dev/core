/** Kebab-case slug: lowercase alnum segments joined by single hyphens. */
import {
  MAX_DAILY_FREE_TIER_CALLS,
  MAX_ENDPOINT_COST_CREDITS,
} from "./pricing.js";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_OPENAPI_SPEC_BYTES = 393_216;

/**
 * Semver 2.0 core + optional pre-release / build metadata.
 * Rejects leading zeros on numeric core identifiers.
 */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 64 && SLUG_RE.test(slug);
}

export function isValidSemver(version: string): boolean {
  return SEMVER_RE.test(version);
}

export type SpecIssue = {
  level: "error" | "warning";
  path: string;
  message: string;
};

export type SpecValidationResult = {
  errors: SpecIssue[];
  warnings: SpecIssue[];
};

const HTTP_METHODS: Record<string, true> = {
  get: true,
  post: true,
  put: true,
  patch: true,
  delete: true,
  options: true,
  head: true,
  trace: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Collect draft/publish OpenAPI JSON issues in discovery order.
 * Errors block save/publish; warnings (missing cost) surface on publish.
 */
export function collectOpenApiSpecIssues(specText: string): SpecIssue[] {
  const issues: SpecIssue[] = [];
  let healthCheckCount = 0;

  if (new TextEncoder().encode(specText).byteLength > MAX_OPENAPI_SPEC_BYTES) {
    issues.push({
      level: "error",
      path: "$",
      message: "Spec exceeds 393216 UTF-8 bytes",
    });
    return issues;
  }

  if (new TextEncoder().encode(specText).byteLength > MAX_OPENAPI_SPEC_BYTES) {
    issues.push({
      level: "error",
      path: "$",
      message: "Spec exceeds 393216 UTF-8 bytes",
    });
    return issues;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(specText) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      {
        level: "error",
        path: "$",
        message: `Invalid JSON: ${message}`,
      },
    ];
  }

  if (!isRecord(raw)) {
    return [
      {
        level: "error",
        path: "$",
        message: "Root must be a JSON object",
      },
    ];
  }

  if (typeof raw.openapi !== "string" || raw.openapi.trim() === "") {
    issues.push({
      level: "error",
      path: "$.openapi",
      message: "Missing openapi field (expected OpenAPI 3.x version string)",
    });
  }

  if (!Array.isArray(raw.servers) || raw.servers.length === 0) {
    issues.push({
      level: "error",
      path: "$.servers",
      message: "servers[0].url is required",
    });
  } else {
    const first = raw.servers[0];
    if (!isRecord(first) || typeof first.url !== "string") {
      issues.push({
        level: "error",
        path: "$.servers[0].url",
        message: "servers[0].url must be a string",
      });
    } else {
      let url: URL | null = null;
      try {
        url = new URL(first.url);
      } catch {
        url = null;
      }
      if (
        url === null ||
        (url.protocol !== "http:" && url.protocol !== "https:")
      ) {
        issues.push({
          level: "error",
          path: "$.servers[0].url",
          message: "servers[0].url must be an http(s) URL",
        });
      }
    }
  }

  if (!isRecord(raw.paths)) {
    issues.push({
      level: "warning",
      path: "$.paths",
      message: "No paths object — catalogue will show zero endpoints",
    });
    return issues;
  }

  for (const [pathKey, pathVal] of Object.entries(raw.paths)) {
    if (!isRecord(pathVal)) {
      issues.push({
        level: "warning",
        path: `$.paths["${pathKey}"]`,
        message: "Path item must be an object",
      });
      continue;
    }

    for (const [method, opVal] of Object.entries(pathVal)) {
      const lower = method.toLowerCase();
      if (!(lower in HTTP_METHODS)) continue;
      if (!isRecord(opVal)) {
        issues.push({
          level: "warning",
          path: `$.paths["${pathKey}"].${lower}`,
          message: "Operation must be an object",
        });
        continue;
      }

      const cost = opVal["x-zevium-cost"];
      if (cost === undefined) {
        issues.push({
          level: "warning",
          path: `$.paths["${pathKey}"].${lower}.x-zevium-cost`,
          message: "Missing x-zevium-cost (defaults to 1 at gateway)",
        });
      } else if (
        typeof cost !== "number" ||
        !Number.isSafeInteger(cost) ||
        cost < 0
      ) {
        issues.push({
          level: "error",
          path: `$.paths["${pathKey}"].${lower}.x-zevium-cost`,
          message: "x-zevium-cost must be a finite safe non-negative integer",
        });
      } else if (cost > MAX_ENDPOINT_COST_CREDITS) {
        issues.push({
          level: "error",
          path: `$.paths["${pathKey}"].${lower}.x-zevium-cost`,
          message: `x-zevium-cost must be at most ${MAX_ENDPOINT_COST_CREDITS}`,
        });
      }

      const freeTier = opVal["x-zevium-free-tier"];
      if (
        freeTier !== undefined &&
        (typeof freeTier !== "number" ||
          !Number.isSafeInteger(freeTier) ||
          freeTier < 0)
      ) {
        issues.push({
          level: "error",
          path: `$.paths["${pathKey}"].${lower}.x-zevium-free-tier`,
          message:
            "x-zevium-free-tier must be a finite safe non-negative integer",
        });
      } else if (
        typeof freeTier === "number" &&
        freeTier > MAX_DAILY_FREE_TIER_CALLS
      ) {
        issues.push({
          level: "error",
          path: `$.paths["${pathKey}"].${lower}.x-zevium-free-tier`,
          message: `x-zevium-free-tier must be at most ${MAX_DAILY_FREE_TIER_CALLS}`,
        });
      }

      if (opVal["x-zevium-health-check"] === true) {
        healthCheckCount += 1;
        if (lower !== "get" && lower !== "head") {
          issues.push({
            level: "error",
            path: `$.paths["${pathKey}"].${lower}.x-zevium-health-check`,
            message:
              "Health check must be a side-effect-free GET or HEAD operation",
          });
        }
        if (
          !pathKey.startsWith("/") ||
          pathKey.includes("{") ||
          pathKey.includes("}") ||
          pathKey.includes("?") ||
          pathKey.includes("#")
        ) {
          issues.push({
            level: "error",
            path: `$.paths["${pathKey}"].${lower}.x-zevium-health-check`,
            message: "Health check path must be absolute and parameter-free",
          });
        }
      }
    }
  }

  if (healthCheckCount === 0) {
    issues.push({
      level: "warning",
      path: "$.paths",
      message:
        "Publication requires one GET or HEAD operation with x-zevium-health-check: true",
    });
  } else if (healthCheckCount > 1) {
    issues.push({
      level: "error",
      path: "$.paths",
      message: "Exactly one x-zevium-health-check operation is allowed",
    });
  }

  return issues;
}

/**
 * Validate draft/publish OpenAPI JSON.
 * Errors block save/publish; warnings (missing cost) surface on publish.
 */
export function validateOpenApiSpec(specText: string): SpecValidationResult {
  const issues = collectOpenApiSpecIssues(specText);
  return {
    errors: issues.filter((i) => i.level === "error"),
    warnings: issues.filter((i) => i.level === "warning"),
  };
}

export function hasErrors(issues: SpecIssue[]): boolean {
  return issues.some((i) => i.level === "error");
}

export function hasValidationErrors(result: SpecValidationResult): boolean {
  return result.errors.length > 0;
}
