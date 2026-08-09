/**
 * Webhook HTTP delivery helper. Extracted so tests can inject a mock fetch
 * and assert signing, headers, and timeout behaviour without a real server.
 *
 * Uses WebCrypto (crypto.subtle) for HMAC-SHA256 — works in Convex actions
 * (edge-runtime) and in the vitest edge-runtime environment.
 *
 * Idempotency contract:
 *  - Callers SHOULD pass `deliveryId` (the `webhookDeliveries` doc id) and the
 *    delivery's `currentStatus` on every invocation. When `currentStatus` is
 *    already terminal (`ok` / `failed`), `postWebhook` short-circuits
 *    and does NOT re-deliver — this prevents late scheduler duplicates from
 *    resurrecting a `failed` delivery to `ok`.
 *  - When `deliveryId` is supplied it is propagated on the outgoing request as
 *    the `X-Zevium-Delivery-Id` header so consumers can dedupe at-least-once
 *    delivery (genuine retry vs. scheduler duplicate). Consumers MUST dedupe on
 *    this header.
 *  - HTTP 4xx responses (except `408` / `429`) are classified terminal — the
 *    receiver rejected the payload and retries will not help. Only `5xx`,
 *    `408`, `429`, and transport-level failures are `retryable`.
 *  - Transport-error strings from `fetch` (which routinely embed internal
 *    hostnames, IPs, and ports) are NEVER surfaced verbatim. The publisher-
 *    visible `error` is the generic `"Delivery failed"`; HTTP responses carry
 *    only the neutral `HTTP <status>` label.
 */

export type PostWebhookParams = {
  url: string;
  secret: string;
  event: string;
  data: unknown;
  timestamp: number;
  /**
   * Convex `webhookDeliveries` document id. When provided, propagated as the
   * `X-Zevium-Delivery-Id` header so downstream consumers can dedupe
   * at-least-once delivery.
   */
  deliveryId?: string;
  /**
   * Current persisted status of the delivery, as read by the caller before
   * invoking `postWebhook`. If already terminal (`ok` / `failed`),
   * the request is NOT sent — guards against late scheduler duplicates
   * resurrecting a terminal delivery.
   */
  currentStatus?: DeliveryStatus;
};

export type DeliveryStatus = "pending" | "ok" | "failed";

export type PostWebhookResult = {
  ok: boolean;
  status: number;
  /**
   * Sanitized, publisher-safe failure label. Never contains raw transport-error
   * strings (hostnames / IPs / ports from `fetch` failures).
   */
  error?: string;
  /**
   * Whether a failed delivery should be retried. Only `5xx`, `408`, `429`,
   * and transport-level failures are retryable; other `4xx` are terminal.
   */
  retryable: boolean;
  /**
   * True when the delivery was skipped because `currentStatus` was already
   * terminal. No HTTP request was made.
   */
  skipped?: boolean;
};

export type ResolveWebhookHostname = (hostname: string) => Promise<string[]>;

/** Delivery timeout in milliseconds. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** HTTP status codes that are retryable despite being in the 4xx band. */
const RETRYABLE_4XX: Record<number, true> = { 408: true, 429: true };

/** Terminal delivery statuses — a delivery in these states must not be re-sent. */
const TERMINAL_STATUSES: Partial<Record<DeliveryStatus, true>> = {
  ok: true,
  failed: true,
};

/** Generic, publisher-safe failure label for transport-level errors. */
const TRANSPORT_ERROR_LABEL = "Delivery failed";

/** Maximum number of safe redirects followed for one delivery attempt. */
const MAX_WEBHOOK_REDIRECTS = 3;

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b, c] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv6(hostname: string): number[] | null {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized.includes(":")) return null;
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array<number>(missing).fill(0), ...right].map(
    (part) => Number.parseInt(String(part), 16),
  );
  if (
    groups.length !== 8 ||
    groups.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)
  ) {
    return null;
  }
  return groups;
}

function isPrivateIpv6(hostname: string): boolean {
  const groups = parseIpv6(hostname);
  if (groups === null) return false;
  const first = groups[0]!;
  if (
    groups.every((part) => part === 0) ||
    (groups.slice(0, 7).every((part) => part === 0) && groups[7] === 1) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00
  ) {
    return true;
  }
  // IPv4-mapped IPv6 addresses are normalized by URL, e.g.
  // ::ffff:127.0.0.1 becomes ::ffff:7f00:1.
  if (groups.slice(0, 5).every((part) => part === 0) && groups[5] === 0xffff) {
    const ipv4 = `${groups[6]! >>> 8}.${groups[6]! & 255}.${groups[7]! >>> 8}.${groups[7]! & 255}`;
    return isPrivateIpv4(ipv4);
  }
  return false;
}

/**
 * Accept only public HTTPS webhook destinations. URL normalisation also turns
 * alternative IPv4 forms (integer, octal, shortened) into dotted decimal
 * before private-range checks run.
 */
export function validateWebhookUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return false;
  }
  return !isPrivateIpv4(hostname) && !isPrivateIpv6(hostname);
}

async function validateResolvedWebhookUrl(
  url: URL,
  resolveHostname?: ResolveWebhookHostname,
): Promise<boolean> {
  if (!validateWebhookUrl(url.toString())) return false;
  if (
    resolveHostname === undefined ||
    isPrivateIpv4(url.hostname) ||
    parseIpv6(url.hostname) !== null ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)
  ) {
    return true;
  }
  const addresses = await resolveHostname(url.hostname);
  return (
    addresses.length > 0 &&
    addresses.every((address) =>
      validateWebhookUrl(
        address.includes(":") ? `https://[${address}]` : `https://${address}`,
      ),
    )
  );
}

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
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * POST a webhook payload with HMAC signature headers.
 *
 * Idempotency: if `params.currentStatus` is already terminal, the request is
 * skipped (no HTTP call) and the result reflects the prior terminal state.
 * When `params.deliveryId` is supplied it is sent as `X-Zevium-Delivery-Id`.
 *
 * `fetchImpl` defaults to global fetch; tests inject a mock.
 */
export async function postWebhook(
  params: PostWebhookParams,
  fetchImpl: typeof fetch = fetch,
  resolveHostname?: ResolveWebhookHostname,
): Promise<PostWebhookResult> {
  // (1) Terminal-state guard: a delivery already in a terminal state must not
  //     be re-delivered. A late scheduler duplicate of the original action
  //     must not resurrect `failed → ok` or double-send a successful one.
  if (params.currentStatus && TERMINAL_STATUSES[params.currentStatus]) {
    return {
      ok: params.currentStatus === "ok",
      status: 0,
      retryable: false,
      skipped: true,
    };
  }

  const body = JSON.stringify({
    event: params.event,
    data: params.data,
    timestamp: params.timestamp,
  });

  const signature = await computeSignature(params.secret, body);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-zevium-event": params.event,
    "x-zevium-signature": signature,
  };
  // (2) Propagate the delivery id so consumers can dedupe at-least-once
  //     delivery (genuine retry vs. scheduler duplicate).
  if (params.deliveryId !== undefined) {
    headers["X-Zevium-Delivery-Id"] = params.deliveryId;
  }

  try {
    let currentUrl = new URL(params.url);
    for (
      let redirects = 0;
      redirects <= MAX_WEBHOOK_REDIRECTS;
      redirects += 1
    ) {
      if (!(await validateResolvedWebhookUrl(currentUrl, resolveHostname))) {
        return {
          ok: false,
          status: 0,
          error: TRANSPORT_ERROR_LABEL,
          retryable: false,
        };
      }

      const response = await fetchImpl(currentUrl, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location !== null && redirects < MAX_WEBHOOK_REDIRECTS) {
          currentUrl = new URL(location, currentUrl);
          continue;
        }
      }

      if (response.status >= 200 && response.status < 300) {
        return { ok: true, status: response.status, retryable: false };
      }

      // (3) Classify: 4xx (except 408/429) is terminal — the receiver rejected
      //     the payload and retries will not help. Only 5xx + 408/429 retry.
      const retryable =
        response.status >= 500 || RETRYABLE_4XX[response.status] === true;
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}`,
        retryable,
      };
    }

    // Loop always returns after its final response.
    throw new Error("Unreachable redirect state");
  } catch (err) {
    // (4) Never interpolate raw transport-error strings into the publisher-
    //     visible notification body. `fetch` failures routinely embed internal
    //     hostnames, IPs, and ports (`connect ECONNREFUSED 10.0.5.23:443`,
    //     `getaddrinfo ENOTFOUND internal-admin.zevium.svc`, …). Surface a
    //     generic, sanitized label instead. The original error is not
    //     persisted; debugging happens via Convex action logs.
    void err;
    return {
      ok: false,
      status: 0,
      error: TRANSPORT_ERROR_LABEL,
      retryable: true,
    };
  }
}
