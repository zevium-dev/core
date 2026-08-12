export class BrokerError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BrokerError";
    this.status = status;
    this.code = code;
  }
}

export function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof BrokerError) {
    return jsonResponse(error.status, {
      error: { code: error.code, message: error.message },
      ok: false,
    });
  }
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.name : "unknown",
      event: "deploy_broker_internal_error",
    }),
  );
  return jsonResponse(500, {
    error: {
      code: "internal_error",
      message: "Deployment broker failed safely",
    },
    ok: false,
  });
}

export function invariant(
  condition: unknown,
  status: number,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new BrokerError(status, code, message);
}
