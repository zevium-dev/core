import { Exception } from "@boi.gg/exception";
import { queryOptions, type QueryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { createServerOnlyFn } from "@tanstack/react-start";
import { apiKeyClient, organizationClient } from "better-auth/client/plugins";
import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient, ErrorContext } from "better-auth/react";

export class BetterAuthException extends Exception.kind<ErrorContext>("BetterAuthException") {}

export const auth = createAuthClient({
  fetchOptions: {
    onError: (ctx) => {
      throw new BetterAuthException(ctx.error.message, ctx, ctx.error);
    },
  },
  plugins: [
    apiKeyClient(),
    twoFactorClient({
      onTwoFactorRedirect() {
        if (typeof window !== "undefined") {
          window.location.assign("/auth/two-factor-verify");
        }
      },
    }),
    organizationClient(),
  ],
});

const getServerSession = createServerOnlyFn(async () => {
  const { authServer } = await import("~/lib/server/auth");
  const { getRequest } = await import("@tanstack/react-start/server");
  const request = getRequest();
  const response = await authServer.api.getSession({ headers: request.headers }).catch(() => null);
  if (!response) return { session: null, user: null };
  const { session, user } = response;
  return { session, user };
});

const getSession = async () => {
  if (typeof window === "undefined") {
    return getServerSession();
  } else {
    const session = await auth.getSession();
    return { session: session.data?.session, user: session.data?.user };
  }
};

type SessionQueryFnData = Awaited<ReturnType<typeof getSession>>;

export const sessionQueryOptions = (options?: QueryOptions<SessionQueryFnData>) => {
  const { queryKey, ...restOptions } = options ?? {};
  return queryOptions({
    ...restOptions,
    queryFn: getSession,
    queryKey: ["session", ...(queryKey ?? [])],
  });
};

export const useSession = () => useSuspenseQuery(sessionQueryOptions()).data;

export const useUser = () => useSession().user;
