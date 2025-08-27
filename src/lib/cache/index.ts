import SuperJSON from "superjson";

import { db, orm, schema } from "~/db";
import { hashString } from "~/lib/hash";

const defaultTtlMs = 24 * 60 * 60 * 1000;
const defaultMemoryCacheTtlMs = 60 * 1000;

const memoryCacheMap = new Map<string, { expiresAt: Date; value: unknown }>();

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
    const hashedArgs = await hashString(SuperJSON.stringify(args));
    const cacheKey = `${namespace}:${fn.name || "anonymous"}:${hashedArgs}`;

    const cacheRow = memoryCacheMap.get(cacheKey);

    if (cacheRow) {
      if (cacheRow.expiresAt > new Date()) {
        return cacheRow.value as Result;
      }
      memoryCacheMap.delete(cacheKey);
    }

    const result = await fn(...args);

    memoryCacheMap.set(cacheKey, {
      expiresAt: new Date(Date.now() + ttlMs),
      value: result,
    });

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
    const hashedArgs = await hashString(SuperJSON.stringify(args));
    const cacheKey = `${namespace}:${fn.name || "anonymous"}:${hashedArgs}`;

    // First check memory cache
    const memoryCacheRow = memoryCacheMap.get(cacheKey);
    if (memoryCacheRow && memoryCacheRow.expiresAt > new Date()) {
      return memoryCacheRow.value as Result;
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
      memoryCacheMap.set(cacheKey, {
        expiresAt: new Date(Date.now() + ttlMs),
        value: cacheRow,
      });
      return cacheRow;
    }

    // If both caches miss, execute function
    const result = await fn(...args);

    // Store in both memory and database cache
    memoryCacheMap.set(cacheKey, {
      expiresAt: new Date(Date.now() + ttlMs),
      value: result,
    });

    await db
      .insert(schema.cache)
      .values({
        expiresAt: new Date(Date.now() + ttlMs),
        key: cacheKey,
        value: SuperJSON.stringify(result),
      })
      .catch(() => void 0);

    return result;
  };
};
