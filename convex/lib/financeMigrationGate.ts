import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export const FINANCE_MIGRATION_KEY = "finance-v2-universal-funding-v2" as const;

/**
 * Expansion deploy fails closed once migration starts. A failed or unfinished
 * job keeps runtime writes/optional reads fenced until restart reaches verified.
 */
export async function assertFinanceMigrationAllowsRuntime(
  ctx: MutationCtx | QueryCtx,
): Promise<void> {
  const job = await ctx.db
    .query("financialMigrationJobs")
    .withIndex("by_migration_key", (q) =>
      q.eq("migrationKey", FINANCE_MIGRATION_KEY),
    )
    .unique();
  if (job !== null && job.status !== "verified") {
    throw new Error("Finance migration is fenced and not verified");
  }
}

export async function assertFinanceMigrationJobActive(
  ctx: MutationCtx | QueryCtx,
  jobId: Id<"financialMigrationJobs">,
): Promise<void> {
  const job = await ctx.db.get(jobId);
  if (
    job === null ||
    job.migrationKey !== FINANCE_MIGRATION_KEY ||
    job.status === "verified"
  ) {
    throw new Error("Active finance migration fence required");
  }
}
