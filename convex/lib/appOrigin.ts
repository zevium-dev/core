/**
 * Web origin from deployment config, or null when missing/invalid. Never
 * falls back to a default: callers refuse the feature instead of linking
 * users to a guessed environment.
 */
export function configuredAppOrigin(
  name: "APP_ORIGIN" | "NEXT_APP_ORIGIN",
): string | null {
  const raw = process.env[name]?.trim();
  let url: URL | null = null;
  try {
    url = raw ? new URL(raw) : null;
  } catch {
    url = null;
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
  console.error("Web origin configuration missing or invalid", {
    variable: name,
  });
  return null;
}
