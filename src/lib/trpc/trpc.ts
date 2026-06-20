import { createServerOnlyFn } from "@tanstack/react-start";
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

function getBaseUrl() {
  if (typeof window !== "undefined") return "";
  return `http://localhost:${process.env.PORT ?? 5173}`;
}

const createClientTRPCClient = (baseUrl = getBaseUrl(), getHeaders = () => Promise.resolve({})) => {
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

const createServerTrpcClient = createServerOnlyFn((..._) => {
  const getHeaders = async () => {
    const { getRequestHeaders } = await import("@tanstack/react-start/server");
    return getRequestHeaders();
  };
  return createClientTRPCClient(getBaseUrl(), getHeaders);
});

export const createTRPCClient = import.meta.env.SSR ? createServerTrpcClient : createClientTRPCClient;

let _trpcClientSingleTon: null | ReturnType<typeof createTRPCClient> = null;

export const getTrpcClient = () => {
  if (!import.meta.env.SSR || typeof window !== "undefined") {
    if (_trpcClientSingleTon) {
      return _trpcClientSingleTon;
    }
    const trpcClient = createTRPCClient();
    _trpcClientSingleTon = trpcClient;
    return trpcClient;
  }
  return createTRPCClient();
};
