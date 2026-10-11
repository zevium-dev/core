/** Human recovery envelope for authenticated, credit-gated calls. */
const RECOVERY: Record<string, string> = {
  missing_api_key: "Create an API key and send it as a Bearer credential.",
  invalid_api_key:
    "Replace the credential with a valid API key from this environment.",
  insufficient_credits: "Add credits to the organization wallet, then retry.",
  key_cap_exceeded:
    "Ask an organization admin to increase this key's monthly cap, or wait until the next UTC month. Adding wallet credits does not increase the key cap.",
  in_flight_budget_exhausted: "Wait for active calls to finish, then retry.",
  weight_exceeds_budget:
    "Reduce the prompt or output limit, or add wallet credits, then retry.",
};

/** Only platform-owned safe text belongs here; never pass upstream errors. */
export function paymentRequiredResponse(
  requestId: string,
  detail: string,
  extra?: Record<string, unknown>,
  webOrigin = "https://zevium.dev",
): Response {
  const origin = new URL(webOrigin);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password
  )
    throw new Error("Invalid APP_ORIGIN");
  const url = (path: string) => new URL(path, origin.origin).href;
  const reason = typeof extra?.reason === "string" ? extra.reason : "";
  const actions =
    reason === "key_cap_exceeded"
      ? { manageKey: url("/app/settings/keys"), docs: url("/docs/consuming") }
      : {
          createKey: url("/app/settings/keys"),
          topUp: url("/app/billing"),
          docs: url("/docs/consuming"),
        };
  return new Response(
    JSON.stringify({
      error: "payment_required",
      ...extra,
      message: detail,
      detail,
      recovery: RECOVERY[reason],
      actions,
      requestId,
    }),
    {
      status: 402,
      headers: {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="zevium"',
        "x-zevium-request-id": requestId,
      },
    },
  );
}
