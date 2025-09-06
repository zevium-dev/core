import SuperJSON from "superjson";

import { db, orm, schema } from "~/db";
import { hashString } from "~/lib/hash";

const defaultTtlMs = 24 * 60 * 60 * 1000;
const defaultMemoryCacheTtlMs = 60 * 1000;

const memoryCacheMap = new Map<string, { expiresAt: Date; value: unknown }>();

// Helper functions to reduce code duplication
const generateCacheKey = async <Args extends Array<unknown>>(
  namespace: string,
  fn: (...args: Args) => Promise<unknown>,
  args: Args,
): Promise<string> => {
  const hashedArgs = await hashString(SuperJSON.stringify(args));
  return `${namespace}:${fn.name || "anonymous"}:${hashedArgs}`;
};

const createExpiryDate = (ttlMs: number): Date => {
  return new Date(Date.now() + ttlMs);
};

const getFromMemoryCache = (cacheKey: string): unknown => {
  const cacheRow = memoryCacheMap.get(cacheKey);
  if (cacheRow && cacheRow.expiresAt > new Date()) {
    return cacheRow.value;
  }
  if (cacheRow) {
    memoryCacheMap.delete(cacheKey);
  }
  return null;
};

const setInMemoryCache = (cacheKey: string, value: unknown, ttlMs: number): void => {
  memoryCacheMap.set(cacheKey, {
    expiresAt: createExpiryDate(ttlMs),
    value,
  });
};

/**
 * Caches the result of a function in memory.
 *
 * @example
 * const cachedFn = memoryCached({ namespace: "my-cache" }, async (arg) => {
 *   return await someExpensiveOperation(arg);
 * });
 */
export const memoryCached = <Args extends Array<unknown>, Result>(
  { namespace = "cache", ttlMs = defaultMemoryCacheTtlMs },
  fn: (...args: Args) => Promise<Result>,
): ((...args: Args) => Promise<Result>) => {
  return async (...args) => {
    const cacheKey = await generateCacheKey(namespace, fn, args);

    const cachedResult = getFromMemoryCache(cacheKey) as null | Result;
    if (cachedResult !== null) {
      return cachedResult;
    }

    const result = await fn(...args);
    setInMemoryCache(cacheKey, result, ttlMs);

    return result;
  };
};

/**
 * Caches the result of a function in memory and database.
 *
 * @example
 * const cachedFn = cached({ namespace: "my-cache" }, async (arg) => {
 *   return await someExpensiveOperation(arg);
 * });
 */
export const cached = <Args extends Array<unknown>, Result>(
  { namespace = "cache", ttlMs = defaultTtlMs },
  fn: (...args: Args) => Promise<Result>,
): ((...args: Args) => Promise<Result>) => {
  return async (...args) => {
    const cacheKey = await generateCacheKey(namespace, fn, args);

    // First check memory cache
    const memoryCachedResult = getFromMemoryCache(cacheKey) as null | Result;
    if (memoryCachedResult !== null) {
      return memoryCachedResult;
    }

    // If memory cache miss or expired, check database cache
    const cacheRow = await db
      .select()
      .from(schema.cache)
      .where(orm.eq(schema.cache.key, cacheKey))
      .then((v) => v.at(0))
      .then(async (v) => {
        if (!v) throw new Error("Cache row not found");
        if (v.expiresAt < new Date()) {
          await db
            .delete(schema.cache)
            .where(orm.eq(schema.cache.key, cacheKey))
            .catch((e: unknown) => console.error("Error deleting cache row", e));
          throw new Error("Cache row expired");
        }
        return v;
      })
      .then((v) => SuperJSON.parse<Result>(v.value || "null"))
      .catch(() => null);

    if (cacheRow) {
      // Store in memory cache for faster future access
      setInMemoryCache(cacheKey, cacheRow, ttlMs);
      return cacheRow;
    }

    // If both caches miss, execute function
    const result = await fn(...args);

    // Store in both memory and database cache
    setInMemoryCache(cacheKey, result, ttlMs);

    await db
      .insert(schema.cache)
      .values({
        expiresAt: createExpiryDate(ttlMs),
        key: cacheKey,
        value: SuperJSON.stringify(result),
      })
      .catch(() => void 0);

    return result;
  };
};
