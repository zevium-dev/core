import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/** Hourly low-balance check — one notification per org per UTC day. */
crons.hourly("low-balance-check", { minuteUTC: 0 }, internal.cronTasks.checkLowBalances);
export default crons;
