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
export default crons;
