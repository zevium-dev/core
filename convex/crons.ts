import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
const crons = cronJobs();
crons.interval(
  "recover provider key revocation",
  { minutes: 1 },
  internal.keyRecovery.recoverDue,
  {},
);
for (const state of ["pending", "moving"] as const)
  crons.interval(
    `recover ${state} dust merges`,
    { minutes: 1 },
    internal.wallets.recoverMerges,
    { state, cursor: null },
  );
crons.interval(
  "recover Stripe receipts",
  { minutes: 1 },
  internal.stripeEvents.recover,
  {},
);
crons.interval(
  "reconcile payment sources",
  { minutes: 1 },
  internal.billing.recoverAdjustments,
  {},
);
crons.interval(
  "release earning buckets",
  { minutes: 1 },
  internal.payouts.releaseDue,
  {},
);
crons.interval(
  "recover publisher transfers",
  { minutes: 1 },
  internal.payouts.recoverTransfers,
  {},
);
crons.interval(
  "recover Connect operations",
  { minutes: 1 },
  internal.connect.recover,
  {},
);
crons.interval(
  "recover drained edge maintenance",
  { minutes: 1 },
  internal.edgeMaintenance.recover,
  { cursor: null },
);
crons.interval(
  "discover wallet dust",
  { minutes: 5 },
  internal.edgeMaintenance.discoverDust,
  { cursor: null },
);
crons.interval(
  "probe published upstreams",
  { minutes: 1 },
  internal.quality.runDueProbes,
  {},
);
crons.interval(
  "recover publisher webhooks",
  { minutes: 1 },
  internal.webhooks.recover,
  {},
);
crons.interval(
  "clean import leases",
  { minutes: 5 },
  internal.specImportLimits.cleanup,
  {},
);
export default crons;
