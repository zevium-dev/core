/**
 * x402-style payment-required envelope for /gateway and /mock.
 * Every unauthenticated, invalid-key, or insufficient-credit request gets
 * the same machine-readable shape so agents can self-serve: create a key,
 * top up, or read the docs — never a bare 401/402 with no next step.
 */

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
    for (const [k, v] of Object.entries(extra)) {
      body[k] = v;
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
