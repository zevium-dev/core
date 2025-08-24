import { type } from "arktype";

const ServerEnvArk = type({
  AUTH_GOOGLE_CLIENT_ID: "string",
  AUTH_GOOGLE_CLIENT_SECRET: "string",
  LIBSQL_SECRET: "string",
  LIBSQL_URL: "string",
});

export type ServerEnv = typeof ServerEnvArk.infer;

export const serverEnv = ServerEnvArk.assert({
  AUTH_GOOGLE_CLIENT_ID: process.env.AUTH_GOOGLE_CLIENT_ID,
  AUTH_GOOGLE_CLIENT_SECRET: process.env.AUTH_GOOGLE_CLIENT_SECRET,
  LIBSQL_SECRET: process.env.LIBSQL_SECRET,
  LIBSQL_URL: process.env.LIBSQL_URL,
});
