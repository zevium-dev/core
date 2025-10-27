import { cache } from "react";

import { createTRPCClient } from "./trpc.client";

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

export const cachedCreateTRPCClient = cache(() => createTRPCClient(getBaseUrl(), getHeaders));
