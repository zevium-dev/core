import {
  createTRPCClient,
  httpBatchStreamLink,
  httpLink,
  isNonJsonSerializable,
  loggerLink,
  splitLink,
} from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import SuperJSON from "superjson";

import type { AppRouter } from "~/server";

function getBaseUrl() {
  if (typeof window !== "undefined") return "";
  return `http://localhost:${process.env.PORT ?? 5173}`;
}

export const createClient = () => {
  return createTRPCClient<AppRouter>({
    links: [
      loggerLink({
        enabled: (opts) =>
          (process.env.NODE_ENV === "development" && typeof window !== "undefined") ||
          (opts.direction === "down" && opts.result instanceof Error),
      }),
      splitLink({
        condition: (op) => isNonJsonSerializable(op.input),
        false: httpBatchStreamLink({
          async headers() {
            if (typeof window !== "undefined") return {};
            const { getRequestHeaders } = await import("@tanstack/react-start/server");
            const headers = getRequestHeaders();
            return headers;
          },
          transformer: SuperJSON,
          url: `${getBaseUrl()}/api/trpc`,
        }),
        true: httpLink({
          async headers() {
            if (typeof window !== "undefined") return {};
            const { getRequestHeaders } = await import("@tanstack/react-start/server");
            const headers = getRequestHeaders();
            return headers;
          },
          transformer: { deserialize: SuperJSON.deserialize, serialize: (d) => d as unknown },
          url: `${getBaseUrl()}/api/trpc`,
        }),
      }),
    ],
  });
};

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();
