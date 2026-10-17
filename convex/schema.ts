import { defineSchema } from "convex/server";
import { identityTables } from "./schema/identity";
import { walletTables } from "./schema/wallet";
import { settlementTables } from "./schema/settlement";
import { readTables } from "./schema/read";
import { connectionTables } from "./schema/connections";
// 38 application tables; component-owned tables are enumerated in contracts/tables.json.
export default defineSchema({
  ...identityTables,
  ...walletTables,
  ...settlementTables,
  ...readTables,
  ...connectionTables,
});
