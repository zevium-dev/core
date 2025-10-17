import { getRequest } from "@tanstack/react-start/server";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";

import { cachedMakeQueryClient } from "~/lib/query-client/query-client.server";

import { appRouter } from ".";
import { createServerContext } from "./context";

export const trpcServer = createTRPCOptionsProxy({
  ctx: () => {
    const req = getRequest();
    return createServerContext({ req });
  },
  queryClient: cachedMakeQueryClient(),
  router: appRouter,
});
