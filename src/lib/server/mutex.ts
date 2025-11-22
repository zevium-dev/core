import { randomUUID } from "node:crypto";

import { kv } from "./kv";

export interface MutexOptions {
  key: string;
  ttlMs?: number;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Distributed mutex using Upstash Redis.
 * Ensures only one concurrent execution per `key`.
 */
export async function withMutex<T>(
  { key, ttlMs = 10_000, waitTimeoutMs = 5_000, pollIntervalMs = 150 }: MutexOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const lockKey = `mutex:${key}`;
  const token = randomUUID();
  const start = Date.now();

  // try to acquire the lock with simple backoff
  // Upstash supports NX+PX for atomic acquisition
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const acquired = await kv.set(lockKey, token, { nx: true, px: ttlMs }).catch(() => null);
    if (acquired === "OK") break;

    if (Date.now() - start > waitTimeoutMs) {
      throw new Error(`Mutex timeout for key ${key}`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  try {
    return await fn();
  } finally {
    // Best-effort release: only delete if token matches
    try {
      const current = await kv.get<string>(lockKey);
      if (current === token) {
        await kv.del(lockKey);
      }
    } catch {
      // ignore
    }
  }
}


