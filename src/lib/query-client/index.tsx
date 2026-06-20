import { getClientQueryClient } from "./query-client";
import { getServerQueryClient } from "./server";

export const getQueryClient = () => {
  if (!import.meta.env.SSR) {
    return getClientQueryClient();
  }
  return getServerQueryClient();
};
