export const ORG_ROLES = ["org:owner", "org:admin", "org:member"] as const;

export type OrgRole = (typeof ORG_ROLES)[number];

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
type CapabilityFlags = Record<OrgCapability, boolean>;

export type OrgCapabilityProjection = {
  role: OrgRole;
  capabilities: CapabilityFlags;
  reasons: Record<OrgCapability, string | null>;
};

const MEMBER_CAPABILITIES: CapabilityFlags = {
  viewWalletTotals: true,
  viewOwnUsage: true,
  viewOrgUsage: false,
  viewPublisherEarnings: true,
  manageBilling: false,
  manageKeys: false,
  manageWebhooks: false,
  managePayouts: false,
  managePublisher: false,
  manageOrgSettings: false,
};

const PRIVILEGED_CAPABILITIES = Object.fromEntries(
  ORG_CAPABILITIES.map((capability) => [capability, true]),
) as CapabilityFlags;

const CAPABILITY_MATRIX: Record<OrgRole, CapabilityFlags> = {
  "org:owner": PRIVILEGED_CAPABILITIES,
  "org:admin": PRIVILEGED_CAPABILITIES,
  "org:member": MEMBER_CAPABILITIES,
};

const CAPABILITY_REASONS: Record<OrgCapability, string> = {
  viewWalletTotals: "Active organization membership required.",
  viewOwnUsage: "Active organization membership required.",
  viewOrgUsage:
    "Organization admin or owner access is required to view organization-wide attribution.",
  viewPublisherEarnings: "Active publisher organization membership required.",
  manageBilling:
    "Organization admin or owner access is required to manage billing.",
  manageKeys:
    "Organization admin or owner access is required to manage API keys.",
  manageWebhooks:
    "Organization admin or owner access is required to manage webhooks.",
  managePayouts:
    "Organization admin or owner access is required to manage payout settings and transfers.",
  managePublisher:
    "Organization admin or owner access is required to publish APIs or change publisher settings.",
  manageOrgSettings:
    "Organization admin or owner access is required to manage organization settings.",
};

export function isOrgRole(value: string | undefined): value is OrgRole {
  return ORG_ROLES.some((role) => role === value);
}

export function isPrivilegedOrgRole(role: string | undefined): boolean {
  return role === "org:owner" || role === "org:admin";
}

export function projectOrgCapabilities(
  role: string | undefined,
): OrgCapabilityProjection | null {
  if (!isOrgRole(role)) return null;
  const capabilities = { ...CAPABILITY_MATRIX[role] };
  return {
    role,
    capabilities,
    reasons: Object.fromEntries(
      ORG_CAPABILITIES.map((capability) => [
        capability,
        capabilities[capability] ? null : CAPABILITY_REASONS[capability],
      ]),
    ) as Record<OrgCapability, string | null>,
  };
}
