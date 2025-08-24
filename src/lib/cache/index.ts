import SuperJSON from "superjson";

import { db, orm, schema } from "~/db";
import { hashString } from "~/lib/hash";

const defaultTtlMs = 24 * 60 * 60 * 1000;

export const cached = <Args extends Array<unknown>, Result>(
  { namespace = "cache", ttlMs = defaultTtlMs },
  fn: (...args: Args) => Promise<Result>,
): ((...args: Args) => Promise<Result>) => {
  return async (...args) => {
    const hashedArgs = await hashString(SuperJSON.stringify(args));
    const cacheKey = `${namespace}:${fn.name || "anonymous"}:${hashedArgs}`;

    const cacheRow = await db
      .select()
      .from(schema.cache)
      .where(orm.eq(schema.cache.key, cacheKey))
      .then((v) => v.at(0))
      .then((v) => {
        if (!v) throw new Error("Cache row not found");
        if (v.expiresAt < new Date()) throw new Error("Cache row expired");
        return v;
      })
      .then((v) => SuperJSON.parse<Result>(v.value || "null"))
      .catch(() => null);

    if (cacheRow) {
      return cacheRow;
    }

    const result = await fn(...args);

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
