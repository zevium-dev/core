import { defineSchema } from "convex/server";
import { identityTables } from "./schema/identity";
import { walletTables } from "./schema/wallet";
import { settlementTables } from "./schema/settlement";
import { readTables } from "./schema/read";
// 35 application tables. rateLimiter + nested batchWorker own 4 additional tables.
export default defineSchema({
  ...identityTables,
  ...walletTables,
  ...settlementTables,
  ...readTables,
});
