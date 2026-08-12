import { makeFunctionReference } from "convex/server";

export const ORG_CAPABILITIES = [
  "viewWalletTotals",
  "viewOwnUsage",
  "viewOrgUsage",
  "viewPublisherEarnings",
  "manageBilling",
  "manageKeys",
  "manageWebhooks",
  "managePayouts",
  "managePublisher",
  "manageOrgSettings",
] as const;

export type OrgCapability = (typeof ORG_CAPABILITIES)[number];
export type OrgRole = "org:owner" | "org:admin" | "org:member";

export type OrgCapabilityProjection = {
  role: OrgRole;
  capabilities: Record<OrgCapability, boolean>;
  reasons: Record<OrgCapability, string | null>;
};

export const activeOrgCapabilitiesRef = makeFunctionReference<
  "query",
  Record<string, never>,
  OrgCapabilityProjection
>("organizations:activeCapabilities");

const ORG_ROLES = new Set<OrgRole>(["org:owner", "org:admin", "org:member"]);

/** Validate auth-sensitive server projection and fail closed on stale payloads. */
export function parseOrgCapabilityProjection(
  value: unknown,
): OrgCapabilityProjection | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (!ORG_ROLES.has(candidate.role as OrgRole)) return null;
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
