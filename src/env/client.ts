import { type } from "arktype";

export const ClientEnvArk = type({
  "VITE_PUBLIC_POLAR_TOPUP_PRODUCTS?": "string | undefined",
  "VITE_PUBLIC_POSTHOG_KEY?": "string | undefined",
  VITE_PUBLIC_URL: "string",
});

export type ClientEnv = typeof ClientEnvArk.infer;

export const clientEnv = ClientEnvArk.assert({
  VITE_PUBLIC_POLAR_TOPUP_PRODUCTS: import.meta.env.VITE_PUBLIC_POLAR_TOPUP_PRODUCTS,
  VITE_PUBLIC_POSTHOG_KEY: import.meta.env.VITE_PUBLIC_POSTHOG_KEY,
  VITE_PUBLIC_URL: import.meta.env.VITE_PUBLIC_URL ?? "http://localhost:5173",
});

/**
 * Polar top-up products exposed to the browser so the client can call
 * `auth.checkout({ products: [productId] })` directly (the Polar-native
 * path via the `@polar-sh/better-auth` `checkout` plugin endpoint). Each
 * entry is a fixed-price one-time Polar product that grants a fixed number
 * of meter-credit units via a `meter_credit` benefit. Variable-amount
 * top-ups are intentionally dropped — fixed products are the Polar-native
 * model and remove the §3.9 variable-amount-crediting unknown.
 *
 * Format: JSON array of `{ id: string, label: string, priceCents: number, units: number }`.
 * Example: `[{"id":"prd_...","label":"$20","priceCents":2000,"units":2000}]`
 */
export const POLAR_TOPUP_PRODUCTS = (() => {
  const raw = clientEnv.VITE_PUBLIC_POLAR_TOPUP_PRODUCTS;
  if (!raw) return [] as ReadonlyArray<{ id: string; label: string; priceCents: number; units: number }>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as Array<{ id: string; label: string; priceCents: number; units: number }>;
  } catch {
    return [];
  }
})();
