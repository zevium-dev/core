import { Redis } from "@upstash/redis/cloudflare";

import { serverEnv } from "~/env/server";

export const kv = new Redis({
  automaticDeserialization: true,
  enableAutoPipelining: true,
  token: serverEnv.UPSTASH_REDIS_REST_TOKEN,
  url: serverEnv.UPSTASH_REDIS_REST_URL,
});
