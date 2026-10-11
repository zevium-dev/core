import { RateLimiter } from "@convex-dev/rate-limiter";
import { ConvexError, getConvexSize } from "convex/values";
import { components } from "../_generated/api";
import type { Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

// One shared budget across payments AND releases, not one allowance per job.
// <= 1.25 MiB/s of full post-write Convex values, leaving room below the 4 MiB/s
// deployment limit for encoding, limiter/scheduler writes and foreground work.
export const FINANCE_PAGE_INTERVAL_MS = 100;
export const FINANCE_PAGE_WRITE_BYTES = 128 * 1024;
// Contending jobs back off longer than an active chain to bound scheduler churn.
export const FINANCE_THROTTLE_RETRY_MS = 1000;
export const FINANCE_TRANSIENT_RETRY_MS = 2000;
const limiter = new RateLimiter(components.rateLimiter, {
  financePages: {
    kind: "token bucket",
    rate: 1,
    period: FINANCE_PAGE_INTERVAL_MS,
    capacity: 1,
    // Strict global admission. Ten admissions/s do not need approximate sharding.
    shards: 1,
  },
});

export function isTransientFinanceError(error: unknown) {
  const message = String(error);
  return (
    /Too many (?:writes|reads) per second/i.test(message) ||
    /changed while this mutation/i.test(message)
  );
}

/** Rate admission and effects commit atomically; rejection changes no job cursor. */
export async function financePage<T>(
  ctx: MutationCtx,
  work: (bounded: MutationCtx) => Promise<T>,
): Promise<T | "throttled"> {
  const admission = await limiter.limit(ctx, "financePages");
  if (!admission.ok) return "throttled";
  let writeBytes = 0;
  let writes = 0;
  const db = new Proxy(ctx.db, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property);
      if (typeof member !== "function") return member;
      if (["insert", "patch", "replace", "delete"].includes(String(property)))
        return async (...params: unknown[]) => {
          const deleted =
            property === "delete"
              ? await target.get(params[0] as Id<TableNames>)
              : undefined;
          const value: unknown = await Reflect.apply(member, target, params);
          const id = (
            property === "insert" ? value : params[0]
          ) as Id<TableNames>;
          const document =
            property === "delete" ? deleted : await target.get(id);
          // Include full system fields and repeated patches, not just patch arguments.
          writeBytes += getConvexSize(document);
          writes++;
          if (writeBytes > FINANCE_PAGE_WRITE_BYTES || writes > 150)
            throw new ConvexError("Finance page exceeds its write budget");
          return value;
        };
      return member.bind(target);
    },
  });
  return work({ ...ctx, db });
}
