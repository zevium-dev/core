import { auth } from "@clerk/tanstack-react-start/server";
import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

export interface AuthSession {
  userId: string;
}

export interface AuthOrgSession {
  userId: string;
  orgSlug: string | null;
  orgId: string | null;
}

export const requireAuth = createServerFn({ method: "GET" }).handler(
  async (): Promise<AuthSession> => {
    const session = await auth();
    if (!session.userId) {
      throw redirect({ to: "/sign-in/$" });
    }
    return { userId: session.userId };
  },
);

/** Auth + optional active org (null when none selected). */
export const getAuthOrg = createServerFn({ method: "GET" }).handler(
  async (): Promise<AuthOrgSession> => {
    const session = await auth();
    if (!session.userId) {
      throw redirect({ to: "/sign-in/$" });
    }
    return {
      userId: session.userId,
      orgSlug: session.orgSlug ?? null,
      orgId: session.orgId ?? null,
    };
  },
);
