import { authServer } from "~/lib/server/auth";

export type Context = Awaited<ReturnType<typeof createServerContext>>;

interface Options {
  req: Request;
}
export async function createServerContext({ req }: Options) {
  const auth = await authServer.api.getSession({ headers: req.headers }).catch((cause) => {
    console.error("[BetterAuthError]: Failed to get server session", cause);
    return null;
  });
  return { raw: { req }, user: auth?.user ?? null };
}
