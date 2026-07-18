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
 *    already terminal (`succeeded` / `failed`), `postWebhook` short-circuits
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
	 * invoking `postWebhook`. If already terminal (`succeeded` / `failed`),
	 * the request is NOT sent — guards against late scheduler duplicates
	 * resurrecting a terminal delivery.
	 */
	currentStatus?: DeliveryStatus;
};

export type DeliveryStatus = "pending" | "retrying" | "succeeded" | "failed";

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

/** Delivery timeout in milliseconds. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** HTTP status codes that are retryable despite being in the 4xx band. */
const RETRYABLE_4XX: Record<number, true> = { 408: true, 429: true };

/** Terminal delivery statuses — a delivery in these states must not be re-sent. */
const TERMINAL_STATUSES: Partial<Record<DeliveryStatus, true>> = {
	succeeded: true,
	failed: true,
};

/** Generic, publisher-safe failure label for transport-level errors. */
const TRANSPORT_ERROR_LABEL = "Delivery failed";

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
): Promise<PostWebhookResult> {
	// (1) Terminal-state guard: a delivery already in a terminal state must not
	//     be re-delivered. A late scheduler duplicate of the original action
	//     must not resurrect `failed → ok` or double-send a `succeeded` one.
	if (params.currentStatus && TERMINAL_STATUSES[params.currentStatus]) {
		return {
			ok: params.currentStatus === "succeeded",
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
		const response = await fetchImpl(params.url, {
			method: "POST",
			headers,
			body,
			signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
		});

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
