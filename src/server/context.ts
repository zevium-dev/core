import { authServer } from "~/lib/server/auth";

export type Context = Awaited<ReturnType<typeof createContext>>;

interface Options {
  req: Request;
}
export async function createContext({ req }: Options) {
  const auth = await authServer.api.getSession({ headers: req.headers });
  return { raw: { req }, user: auth?.user ?? null };
}
