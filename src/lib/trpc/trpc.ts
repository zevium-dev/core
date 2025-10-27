import { createTRPCClient } from "./trpc.client";
import { cachedCreateTRPCClient } from "./trpc.server";

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
  return cachedCreateTRPCClient();
};
