import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
const crons = cronJobs();
crons.interval(
  "recover provider key revocation",
  { minutes: 1 },
  internal.keyRecovery.recoverDue,
  {},
);
export default crons;
