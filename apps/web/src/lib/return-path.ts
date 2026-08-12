const CANONICAL_APP_ORIGIN = "https://zevium.invalid";

/** Accept and normalize same-origin app paths only. */
export function safeReturnPath(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("\\") ||
    /%5c/i.test(trimmed)
  ) {
    return fallback;
  }
  for (const char of trimmed) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return fallback;
  }
  try {
    const parsed = new URL(trimmed, CANONICAL_APP_ORIGIN);
    if (parsed.origin !== CANONICAL_APP_ORIGIN) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
