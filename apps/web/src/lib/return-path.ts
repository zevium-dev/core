/** Accept app-local return paths only. Blocks protocol-relative and control chars. */
export function safeReturnPath(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    return fallback;
  }
  return trimmed;
}
