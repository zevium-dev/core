/**
 * MCP execution is split by HTTP method safety. Directory review rejects one
 * catch-all tool whose `method` parameter mixes safe and unsafe calls, and the
 * split lets clients gate writes separately from reads.
 */
export const CALL_API_READ = "call_api_read";
export const CALL_API_WRITE = "call_api_write";
export type CallApiTool = typeof CALL_API_READ | typeof CALL_API_WRITE;

export const CALL_API_READ_METHODS = ["GET", "HEAD"] as const;
export const CALL_API_WRITE_METHODS = [
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "TRACE",
] as const;

/** Tool that executes `method`, or null for a method neither tool accepts. */
export function callApiTool(method: string): CallApiTool | null {
  const upper = method.toUpperCase();
  if ((CALL_API_READ_METHODS as readonly string[]).includes(upper))
    return CALL_API_READ;
  if ((CALL_API_WRITE_METHODS as readonly string[]).includes(upper))
    return CALL_API_WRITE;
  return null;
}
