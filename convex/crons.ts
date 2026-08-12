import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "resume-catalogue-projection-backfill",
  { minutes: 5 },
  internal.catalogue.resumeCatalogueProjectionBackfill,
);

/** Hourly low-balance check — one notification per org per UTC day. */
crons.hourly(
  "low-balance-check",
  { minuteUTC: 0 },
  internal.cronTasks.checkLowBalances,
  {},
);

crons.hourly(
  "retire-sunset-projects",
  { minuteUTC: 30 },
  internal.projects.retireSunsetProjects,
);

/** Credential-free public upstream probes. Batch size and network time are bounded. */
crons.interval(
  "probe-published-upstreams",
  { minutes: 5 },
  internal.quality.runDueProbes,
);

/**
 * Hourly release of risk-held earnings that have matured past their hold.
 * Each org is released in its own transaction with per-org error isolation,
 * so a single org failing cannot block the rest.
 */
crons.hourly(
  "release-mature-earnings",
  { minuteUTC: 15 },
  internal.payouts.releaseMatureEarningsGlobal,
);

// Scheduled actions are at-most-once. Lease recovery closes crash windows
// without asking Stripe to redeliver an event we already acknowledged.
crons.interval(
  "stripe-event-recovery",
  { minutes: 1 },
  internal.billing.recoverStripeEvents,
);

crons.interval(
  "publisher-reconciliation-recovery",
  { minutes: 1 },
  internal.billing.recoverPublisherReconciliations,
);

crons.interval(
  "publisher-transfer-dispatch-recovery",
  { minutes: 1 },
  internal.payouts.recoverPublisherTransferDispatches,
);
export default crons;
