/** Map unknown mutation/query errors to short human copy. Never leak internals. */
export function humanError(err: unknown, fallback = "Something went wrong. Try again."): string {
  if (err instanceof Error) {
    const msg = err.message.trim();
    if (
      msg.length > 0 &&
      msg.length <= 200 &&
      !msg.includes("Server Error") &&
      !msg.includes("ConvexError") &&
      !msg.startsWith("Uncaught") &&
      !msg.includes("at handler")
    ) {
      return msg;
    }
  }
  if (typeof err === "string" && err.trim().length > 0 && err.length <= 200) {
    return err.trim();
  }
  return fallback;
}
