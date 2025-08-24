import { appRouter } from ".";
import { createContext } from "./context";
import { t } from "./trpc";

export const createCaller = async (req: Request) => {
  const factory = t.createCallerFactory(appRouter);
  const ServerContext = await createContext({ req });
  const caller = factory(ServerContext);
  return caller;
};
