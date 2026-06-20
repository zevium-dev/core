export function getFormErrorString(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "summary" in error &&
    typeof (error as { summary?: unknown }).summary === "string"
  ) {
    return (error as { summary: string }).summary;
  }
  if (error && typeof error === "object" && "toString" in error && typeof error.toString === "function") {
    const str = error.toString();
    if (str !== "[object Object]") return str;
  }
  return "Invalid value";
}
