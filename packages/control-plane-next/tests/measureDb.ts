import type { MutationCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";
import { facts } from "../convex/money/walletLedger";
export async function measure<T>(
  ctx: MutationCtx,
  run: (ctx: MutationCtx) => Promise<T>,
) {
  let writes = 0,
    argumentBytes = 0,
    readBytes = 0,
    documentWriteBytes = 0;
  const bytes = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(facts(value ?? null))).length;
  const queryProxy = <T extends object>(query: T): T =>
    new Proxy(query, {
      get(target, property) {
        const member: unknown = Reflect.get(target, property);
        if (typeof member !== "function") return member;
        return (...params: unknown[]) => {
          const result: unknown = Reflect.apply(member, target, params);
          if (
            ["unique", "first", "take", "collect", "paginate"].includes(
              String(property),
            )
          )
            return Promise.resolve(result).then((value) => {
              readBytes += bytes(value);
              return value;
            });
          return typeof result === "object" && result !== null
            ? queryProxy(result)
            : result;
        };
      },
    });
  const db = new Proxy(ctx.db, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property);
      if (typeof member !== "function") return member;
      if (property === "query")
        return (...params: unknown[]) =>
          queryProxy(Reflect.apply(member, target, params) as object);
      if (property === "get")
        return async (...params: unknown[]) => {
          const value: unknown = await Reflect.apply(member, target, params);
          readBytes += bytes(value);
          return value;
        };
      if (["insert", "patch", "replace", "delete"].includes(String(property)))
        return async (...params: unknown[]) => {
          writes++;
          argumentBytes += bytes(params);
          const value: unknown = await Reflect.apply(member, target, params);
          const id = (
            property === "insert" ? value : params[0]
          ) as Id<"usageEvents">;
          // Charge the full post-write document for every write, including repeated patches.
          if (property !== "delete")
            documentWriteBytes += bytes(await target.get(id));
          return value;
        };
      return member.bind(target);
    },
  });
  const result = await run({ ...ctx, db });
  return { result, writes, argumentBytes, readBytes, documentWriteBytes };
}
