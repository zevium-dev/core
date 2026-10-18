let reported = false;

/**
 * Paired web origin from APP_ORIGIN, or undefined when missing/invalid.
 * Never defaults: callers omit web links or refuse instead of pointing users
 * at a guessed environment. Logged once per isolate to keep the hot path quiet.
 */
export function webOrigin(raw: string | undefined): string | undefined {
  let url: URL | undefined;
  try {
    url = raw?.trim() ? new URL(raw.trim()) : undefined;
  } catch {
    url = undefined;
  }
  if (
    url &&
    !url.username &&
    !url.password &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    return url.origin;
  if (!reported) {
    reported = true;
    console.error(
      JSON.stringify({
        schema: 1,
        type: "zevium.config_error",
        variable: "APP_ORIGIN",
      }),
    );
  }
  return undefined;
}
