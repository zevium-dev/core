import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/** Hourly low-balance check — one notification per org per UTC day. */
crons.hourly(
  "low-balance-check",
  { minuteUTC: 0 },
  internal.cronTasks.checkLowBalances,
);

crons.interval(
  "resume-retirement-jobs",
  { minutes: 1 },
  internal.retirementJobs.scheduleDue,
);

crons.interval(
  "resume-key-saga-cleanup",
  { minutes: 5 },
  internal.keySettings.resumeStaleSagaCleanup,
);

crons.interval(
  "resume-key-auto-revocation",
  { minutes: 5 },
  internal.keySettings.resumeDueAutoRevokes,
);

/**
 * Hourly release of risk-held earnings that have matured past their hold.
 * Each org is released in its own transaction with per-org error isolation,
 * so a single org failing cannot block the rest.
 */
crons.hourly(
  "release-mature-earnings",
  { minuteUTC: 15 },
  internal.cronTasks.releaseMatureEarningsCron,
);
export default crons;
