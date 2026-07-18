/**
 * Shared JSON error envelope for /gateway and /mock. Never leaks internals —
 * `message` is always a short, human-safe string.
 */
export function jsonError(
  status: number,
  code: string,
  message: string,
  requestId: string,
  extra?: Record<string, unknown>,
): Response {
  const body: Record<string, unknown> = { error: code, message, requestId };
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      body[k] = v;
    }
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-zevium-request-id": requestId,
    },
  });
}
