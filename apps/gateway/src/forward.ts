import { filterRequestHeaders } from "./headers";
import { scopeUpstreamIdempotencyKey } from "./idempotency";
import type { Admission } from "./admit";

const UPSTREAM_HEADERS_TIMEOUT_MS = 15_000;
export type ForwardResult = { response: Response } | { timedOut: boolean };

/** Forward once, preserving the request body stream and bounded header wait. */
export async function forward(
  request: Request,
  admission: Admission,
  fetchImpl: typeof fetch = fetch,
  prepareResponse?: (response: Response) => Promise<Response>,
): Promise<ForwardResult> {
  const { published, verified, upstreamUrl } = admission;
  const upstreamHeaders = filterRequestHeaders(request.headers);
  for (const [name, value] of Object.entries(published.upstreamHeaders ?? {})) {
    upstreamHeaders.set(name, value);
  }
  const idempotencyKey = upstreamHeaders.get("idempotency-key");
  if (idempotencyKey !== null) {
    upstreamHeaders.set(
      "idempotency-key",
      await scopeUpstreamIdempotencyKey(idempotencyKey, {
        consumerOrgId: verified.orgId,
        projectId: published.projectId,
        method: request.method,
        upstreamUrl: upstreamUrl.toString(),
      }),
    );
  }
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: upstreamHeaders,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    // Required by fetch when body is a stream.
    init.duplex = "half";
  }
  const controller = new AbortController();
  const abortUpstream = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) {
    abortUpstream();
  } else {
    request.signal.addEventListener("abort", abortUpstream, { once: true });
  }
  const timeout = setTimeout(
    () => controller.abort(),
    UPSTREAM_HEADERS_TIMEOUT_MS,
  );
  init.signal = controller.signal;
  try {
    let response = await fetchImpl(upstreamUrl.toString(), init);
    // Adapter buffering must succeed before finalize can settle the reservation.
    if (prepareResponse) response = await prepareResponse(response);
    return { response };
  } catch {
    return { timedOut: controller.signal.aborted };
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortUpstream);
  }
}
