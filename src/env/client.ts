import { type } from "arktype";

export const ClientEnvArk = type({
  "VITE_PUBLIC_POSTHOG_KEY?": "string | undefined",
});

export type ClientEnv = typeof ClientEnvArk.infer;

export const clientEnv = ClientEnvArk.assert({
  VITE_PUBLIC_POSTHOG_KEY: import.meta.env.VITE_PUBLIC_POSTHOG_KEY,
});
