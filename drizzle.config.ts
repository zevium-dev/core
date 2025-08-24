import "dotenv/config";
import { defineConfig } from "drizzle-kit";

import { serverEnv } from "~/env/server";

export default defineConfig({
  dbCredentials: {
    authToken: serverEnv.LIBSQL_SECRET,
    url: serverEnv.LIBSQL_URL,
  },
  dialect: "turso",
  out: "./drizzle",
  schema: "./src/db/schema.ts",
});
