import { defineSchema } from "convex/server";
import { identityTables } from "./schema/identity";
import { walletTables } from "./schema/wallet";
import { settlementTables } from "./schema/settlement";
import { readTables } from "./schema/read";
// 36 application tables; component-owned tables are enumerated in contracts/tables.json.
export default defineSchema({
  ...identityTables,
  ...walletTables,
  ...settlementTables,
  ...readTables,
});
