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
export default crons;
