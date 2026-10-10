/** Human recovery envelope; configured machine rail adds x402 V2 requirements. */
const ACTIONS = {
  createKey: "https://zevium.dev/app/settings/keys",
  topUp: "https://zevium.dev/app/billing",
  docs: "https://zevium.dev/docs/consuming",
} as const;

/**
 * 402 Payment Required. `detail` is a short human-safe reason (never an
 * internal error). `extra` merges additional machine-readable fields
 * (e.g. `reason`, `available`, `cost`) without changing the base shape.
 */
export function paymentRequiredResponse(
  requestId: string,
  detail: string,
  extra?: Record<string, unknown>,
): Response {
  const body: Record<string, unknown> = {
    error: "payment_required",
    detail,
    actions: ACTIONS,
    requestId,
  };
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      body[key] = value;
    }
  }
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="zevium"',
      "x-zevium-request-id": requestId,
    },
  });
}
