import { createClient } from "@libsql/client/http";
import { drizzle } from "drizzle-orm/libsql/http";

import { serverEnv } from "~/env/server";

export const client = createClient({
  authToken: serverEnv.LIBSQL_SECRET,
  url: serverEnv.LIBSQL_URL,
});

export const db = drizzle({ client });
export * as schema from "./schema";
export * as schemaZod from "./zod";
export * as orm from "drizzle-orm";
