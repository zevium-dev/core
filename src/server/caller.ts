import { appRouter } from ".";
import { createServerContext } from "./context";
import { t } from "./trpc";

export const createCaller = async (req: Request) => {
  const factory = t.createCallerFactory(appRouter);
  const ServerContext = await createServerContext({ req });
  const caller = factory(ServerContext);
  return caller;
};
