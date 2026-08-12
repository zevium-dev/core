import {
  ORG_CAPABILITIES,
  ORG_ROLES,
  type OrgCapability,
  type OrgCapabilityProjection,
} from "@zevium/shared";

export type {
  OrgCapability,
  OrgCapabilityProjection,
  OrgRole,
} from "@zevium/shared";
export {
  ORG_CAPABILITIES,
  ORG_ROLES,
  isPrivilegedOrgRole,
} from "@zevium/shared";

const ORG_ROLE_SET = new Set(ORG_ROLES);

/** Validate auth-sensitive server projection and fail closed on stale payloads. */
export function parseOrgCapabilityProjection(
  value: unknown,
): OrgCapabilityProjection | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (!ORG_ROLE_SET.has(candidate.role as (typeof ORG_ROLES)[number])) {
    return null;
  }
  if (
    typeof candidate.capabilities !== "object" ||
    candidate.capabilities === null ||
    typeof candidate.reasons !== "object" ||
    candidate.reasons === null
  ) {
    return null;
  }
  const capabilities = candidate.capabilities as Record<string, unknown>;
  const reasons = candidate.reasons as Record<string, unknown>;
  for (const capability of ORG_CAPABILITIES) {
    if (typeof capabilities[capability] !== "boolean") return null;
    if (
      reasons[capability] !== null &&
      typeof reasons[capability] !== "string"
    ) {
      return null;
    }
  }
  return candidate as OrgCapabilityProjection;
}

export function hasServerCapability(
  projection: OrgCapabilityProjection | null,
  capability: OrgCapability,
): boolean {
  return projection?.capabilities[capability] === true;
}

/** Reject data produced under a stale role/capability snapshot. */
export function capabilityProjectionsMatch(
  left: OrgCapabilityProjection | null,
  right: OrgCapabilityProjection | null,
): boolean {
  if (left === null || right === null || left.role !== right.role) return false;
  return ORG_CAPABILITIES.every(
    (capability) =>
      left.capabilities[capability] === right.capabilities[capability],
  );
}
