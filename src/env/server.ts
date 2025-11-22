import { type } from "arktype";

const ServerEnvArk = type({
  AUTH_GOOGLE_CLIENT_ID: "string",
  AUTH_GOOGLE_CLIENT_SECRET: "string",
  POLAR_ACCESS_TOKEN: "string",
  POLAR_WEBHOOK_SECRET: "string",
  POLAR_SERVER: "'sandbox' | 'production'",
  POLAR_ORGANIZATION_ID: "string",
  POLAR_PRODUCT_ID_CREDITS: "string",
  LIBSQL_SECRET: "string",
  LIBSQL_URL: "string",
  RESEND_API_KEY: "string",
  UPSTASH_REDIS_REST_TOKEN: "string",
  UPSTASH_REDIS_REST_URL: "string.url",
});

export type ServerEnv = typeof ServerEnvArk.infer;

export const serverEnv = ServerEnvArk.assert({
  AUTH_GOOGLE_CLIENT_ID: process.env.AUTH_GOOGLE_CLIENT_ID,
  AUTH_GOOGLE_CLIENT_SECRET: process.env.AUTH_GOOGLE_CLIENT_SECRET,
  POLAR_ACCESS_TOKEN: process.env.POLAR_ACCESS_TOKEN,
  POLAR_WEBHOOK_SECRET: process.env.POLAR_WEBHOOK_SECRET,
  POLAR_SERVER: (process.env.POLAR_SERVER as "sandbox" | "production") ?? "sandbox",
  POLAR_ORGANIZATION_ID: process.env.POLAR_ORGANIZATION_ID,
  POLAR_PRODUCT_ID_CREDITS: process.env.POLAR_PRODUCT_ID_CREDITS,
  LIBSQL_SECRET: process.env.LIBSQL_SECRET,
  LIBSQL_URL: process.env.LIBSQL_URL,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
});
