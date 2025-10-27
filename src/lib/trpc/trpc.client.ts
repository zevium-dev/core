import {
  createTRPCClient as createTRPCClientOriginal,
  httpBatchStreamLink,
  httpLink,
  isNonJsonSerializable,
  loggerLink,
  splitLink,
} from "@trpc/client";
import SuperJSON from "superjson";

import type { AppRouter } from "~/server";

export const createTRPCClient = (baseUrl = "", getHeaders?: () => Promise<Record<string, string>>) => {
  return createTRPCClientOriginal<AppRouter>({
    links: [
      loggerLink({
        enabled: (opts) =>
          (process.env.NODE_ENV === "development" && typeof window !== "undefined") ||
          (opts.direction === "down" && opts.result instanceof Error),
      }),
      splitLink({
        condition: (op) => isNonJsonSerializable(op.input),
        false: httpBatchStreamLink({
          headers: getHeaders,
          transformer: SuperJSON,
          url: `${baseUrl}/api/trpc`,
        }),
        true: httpLink({
          headers: getHeaders,
          transformer: { deserialize: SuperJSON.deserialize, serialize: (d) => d as unknown },
          url: `${baseUrl}/api/trpc`,
        }),
      }),
    ],
  });
};
