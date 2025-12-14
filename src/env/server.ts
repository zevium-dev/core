import { type } from "arktype";

const ServerEnvArk = type({
  AUTH_GOOGLE_CLIENT_ID: "string",
  AUTH_GOOGLE_CLIENT_SECRET: "string",
  AUTUMN_SECRET_KEY: "string",
  LIBSQL_SECRET: "string",
  LIBSQL_URL: "string",
  RESEND_API_KEY: "string",
  SECRETS_KEYS_JSON: type("string.json.parse").pipe(type({ id: "string > 0", key: "string > 0" }, "[]")),
  SECRETS_PRIMARY_KEY_ID: "string",
  UPSTASH_REDIS_REST_TOKEN: "string",
  UPSTASH_REDIS_REST_URL: "string.url",
});

export type ServerEnv = typeof ServerEnvArk.infer;

export const serverEnv = ServerEnvArk.assert({
  AUTH_GOOGLE_CLIENT_ID: process.env.AUTH_GOOGLE_CLIENT_ID,
  AUTH_GOOGLE_CLIENT_SECRET: process.env.AUTH_GOOGLE_CLIENT_SECRET,
  AUTUMN_SECRET_KEY: process.env.AUTUMN_SECRET_KEY,
  LIBSQL_SECRET: process.env.LIBSQL_SECRET,
  LIBSQL_URL: process.env.LIBSQL_URL,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  SECRETS_KEYS_JSON: process.env.SECRETS_KEYS_JSON,
  SECRETS_PRIMARY_KEY_ID: process.env.SECRETS_PRIMARY_KEY_ID,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
});
