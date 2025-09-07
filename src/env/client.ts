import { type } from "arktype";

export const ClientEnvArk = type({
  VITE_CONVEX_URL: "0 < string < 128",
  "VITE_PUBLIC_POSTHOG_KEY?": "string | undefined",
  VITE_PUBLIC_URL: "string",
});

export type ClientEnv = typeof ClientEnvArk.infer;

export const clientEnv = ClientEnvArk.assert({
  VITE_CONVEX_URL: import.meta.env.VITE_CONVEX_URL,
  VITE_PUBLIC_POSTHOG_KEY: import.meta.env.VITE_PUBLIC_POSTHOG_KEY,
  VITE_PUBLIC_URL: import.meta.env.VITE_PUBLIC_URL ?? "http://localhost:5173",
});
