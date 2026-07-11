/**
 * Webhook HTTP delivery helper. Extracted so tests can inject a mock fetch
 * and assert signing, headers, and timeout behaviour without a real server.
 *
 * Uses WebCrypto (crypto.subtle) for HMAC-SHA256 — works in Convex actions
 * (edge-runtime) and in the vitest edge-runtime environment.
 */

export type PostWebhookParams = {
  url: string;
  secret: string;
  event: string;
  data: unknown;
  timestamp: number;
};

export type PostWebhookResult = {
  ok: boolean;
  status: number;
  error?: string;
};

/** Delivery timeout in milliseconds. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Compute hex HMAC-SHA256 of `body` using `secret`.
 */
export async function computeSignature(
  secret: string,
  body: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(body),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * POST a webhook payload with HMAC signature headers.
 * `fetchImpl` defaults to global fetch; tests inject a mock.
 */
export async function postWebhook(
  params: PostWebhookParams,
  fetchImpl: typeof fetch = fetch,
): Promise<PostWebhookResult> {
  const body = JSON.stringify({
    event: params.event,
    data: params.data,
    timestamp: params.timestamp,
  });

  const signature = await computeSignature(params.secret, body);

  try {
    const response = await fetchImpl(params.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-zevium-event": params.event,
        "x-zevium-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });

    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status };
    }
    return {
      ok: false,
      status: response.status,
      error: `HTTP ${response.status}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: message };
  }
}
