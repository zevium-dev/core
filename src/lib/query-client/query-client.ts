import { QueryClient } from "@tanstack/react-query";

import { makeQueryClient } from "./query-client.client";
import { cachedMakeQueryClient } from "./query-client.server";

let _queryClientSingleton: null | QueryClient = null;

export const getQueryClient = () => {
  if (!import.meta.env.SSR || typeof window !== "undefined") {
    if (_queryClientSingleton) {
      return _queryClientSingleton;
    }
    const queryClient = makeQueryClient();
    _queryClientSingleton = queryClient;
    return queryClient;
  }
  return cachedMakeQueryClient();
};
