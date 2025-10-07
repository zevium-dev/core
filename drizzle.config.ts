import "dotenv/config";
import { type } from "arktype";
import { defineConfig } from "drizzle-kit";

// Only validate database-specific env vars for migrations
const DbEnvArk = type({
  LIBSQL_SECRET: "string",
  LIBSQL_URL: "string",
});

const dbEnv = DbEnvArk.assert({
  LIBSQL_SECRET: process.env.LIBSQL_SECRET,
  LIBSQL_URL: process.env.LIBSQL_URL,
});

export default defineConfig({
  dbCredentials: {
    authToken: dbEnv.LIBSQL_SECRET,
    url: dbEnv.LIBSQL_URL,
  },
  dialect: "turso",
  out: "./drizzle",
  schema: "./src/db/schema.ts",
});
