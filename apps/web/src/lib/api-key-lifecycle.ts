export type ApiKeySetting = {
  disabled: boolean;
  graceUntil?: number;
};

export type ApiKeyLifecycle = "current" | "grace" | "expired" | "disabled";

/** Match UI and create guards to gateway key enforcement. */
export function getApiKeyLifecycle(
  setting: ApiKeySetting | undefined,
  now: number,
): ApiKeyLifecycle {
  if (setting?.disabled) return "disabled";
  if (setting?.graceUntil !== undefined) {
    return setting.graceUntil > now ? "grace" : "expired";
  }
  return "current";
}
