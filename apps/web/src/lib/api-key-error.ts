import { ConvexError } from "convex/values";

const PUBLIC_KEY_ERRORS = new Set([
  "Verified key not found",
  "Key not found",
  "This key is no longer active",
  "Only the current key can be rotated",
  "You already have a key in this organization. Rotate or revoke it before creating another.",
  "A rotation is already in progress for this key",
  "Key must be rotated before it can be enabled",
  "Cap must be a positive whole number of credits",
  "Key revoked. Provider cleanup will retry automatically.",
  "Select an organization before managing API keys",
]);

/** Only intentional Convex application errors can supply toast copy. */
export function apiKeyError(error: unknown, fallback: string): string {
  if (
    error instanceof ConvexError &&
    typeof error.data === "string" &&
    PUBLIC_KEY_ERRORS.has(error.data)
  ) {
    return error.data;
  }
  return fallback;
}
