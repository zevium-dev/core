import type { UserIdentity } from "convex/server";
import { describe, expect, it, vi } from "vitest";
import { requireActiveOrgAdmin } from "./lib/auth";

function identity(
  customClaims: Record<string, string | undefined>,
): UserIdentity {
  return {
    tokenIdentifier: "https://clerk.test|user_test",
    subject: "user_test",
    issuer: "https://clerk.test",
    ...customClaims,
  };
}

function authContext(value: UserIdentity | null) {
  const getUserIdentity = vi.fn(async () => value);
  return {
    ctx: { auth: { getUserIdentity } },
    getUserIdentity,
  };
}

describe("requireActiveOrgAdmin", () => {
  it("returns canonical active-org claims for Clerk org admins", async () => {
    const { ctx, getUserIdentity } = authContext(
      identity({
        email: "admin@example.com",
        org_id: "org_test",
        org_slug: "test-org",
        org_role: "org:admin",
      }),
    );

    await expect(requireActiveOrgAdmin(ctx)).resolves.toEqual({
      subject: "user_test",
      email: "admin@example.com",
      orgId: "org_test",
      orgSlug: "test-org",
      orgRole: "org:admin",
    });
    expect(getUserIdentity).toHaveBeenCalledTimes(1);
  });

  it.each(["org:member", "admin", "", undefined])(
    "fails closed for non-admin role %s",
    async (orgRole) => {
      const { ctx } = authContext(
        identity({ org_id: "org_test", org_role: orgRole }),
      );

      await expect(requireActiveOrgAdmin(ctx)).rejects.toThrow(
        "Org admin or owner role required",
      );
    },
  );

  it("requires authentication and an active organization before role checks", async () => {
    const anonymous = authContext(null);
    await expect(requireActiveOrgAdmin(anonymous.ctx)).rejects.toThrow(
      "Not authenticated",
    );

    const noOrg = authContext(identity({ org_role: "org:admin" }));
    await expect(requireActiveOrgAdmin(noOrg.ctx)).rejects.toThrow(
      "Active organization required",
    );
  });
});
