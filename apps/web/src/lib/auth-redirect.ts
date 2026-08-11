const APP_ROOT = "/app";

/**
 * Keep Clerk return targets local and inside authenticated app shell.
 * Returning a normalized relative URL also prevents Host-header or query-based
 * open redirects from reaching Clerk's `redirect_url` handling.
 */
export function safeAppReturnPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return APP_ROOT;
  if (value.startsWith("//") || /[\\\u0000-\u001f\u007f]/u.test(value)) {
    return APP_ROOT;
  }

  try {
    const url = new URL(value, "https://return.zevium.invalid");
    if (
      url.origin !== "https://return.zevium.invalid" ||
      (url.pathname !== APP_ROOT && !url.pathname.startsWith(`${APP_ROOT}/`))
    ) {
      return APP_ROOT;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return APP_ROOT;
  }
}
