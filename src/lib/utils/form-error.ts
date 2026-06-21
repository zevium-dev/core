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
  return "Invalid value";
}
