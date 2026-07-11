import { auth } from "@clerk/tanstack-react-start/server";
import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

export interface AuthSession {
  userId: string;
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
