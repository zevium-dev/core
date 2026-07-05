import { Redis } from "@upstash/redis/cloudflare";

import { serverEnv } from "~/env/server";

export const kv = new Redis({
  automaticDeserialization: true,
  // Upstash auto-pipelining proxies command methods and breaks chainable helpers like `bitfield()`.
  // (It returns a Promise instead of a BitFieldCommand, causing `kv.bitfield(...).get is not a function`.)
  enableAutoPipelining: false,
  token: serverEnv.UPSTASH_REDIS_REST_TOKEN,
  url: serverEnv.UPSTASH_REDIS_REST_URL,
});
