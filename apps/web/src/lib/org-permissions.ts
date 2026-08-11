/**
 * Client-side affordance gate. Backend authorization remains authoritative.
 * Unknown, missing, and non-Clerk role values fail closed.
 */
export function canAdministerOrg(role: unknown): boolean {
  return role === "org:admin";
}
