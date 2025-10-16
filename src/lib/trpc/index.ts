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

async function getHeaders() {
  if (typeof window !== "undefined") return {};
  if (!import.meta.env.SSR) return {};

  const { getServerHeaders } = await import("./headers.server");
  return getServerHeaders();
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
          headers: getHeaders,
          transformer: SuperJSON,
          url: `${getBaseUrl()}/api/trpc`,
        }),
        true: httpLink({
          headers: getHeaders,
          transformer: { deserialize: SuperJSON.deserialize, serialize: (d) => d as unknown },
          url: `${getBaseUrl()}/api/trpc`,
        }),
      }),
    ],
  });
};

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();
