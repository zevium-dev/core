import { tokenCredits, type TokenPricing } from "@zevium/shared";

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_USAGE_BYTES = 1_048_576;
const MAX_SSE_EVENT_CHARS = 65_536;
const DEFAULT_OUTPUT_TOKENS = 4096;
const MAX_OUTPUT_TOKENS = 1_000_000;
// Finish before the wallet's ten-minute reservation lease expires.
const USAGE_TIMEOUT_MS = 5 * 60_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only token-priced requests need a bounded JSON read before reserving. */
export async function prepareTokenRequest(
  request: Request,
  pricing: TokenPricing,
) {
  if (
    !request.body ||
    !request.headers.get("content-type")?.includes("application/json")
  ) {
    throw new Error("Token-priced calls require a JSON request body");
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        void reader.cancel();
        throw new Error("Token request exceeds 1 MiB");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  const body: unknown = JSON.parse(text);
  if (!record(body)) throw new Error("Token request must be a JSON object");
  for (const key of ["max_tokens", "max_completion_tokens"] as const) {
    if (
      body[key] !== undefined &&
      (typeof body[key] !== "number" ||
        !Number.isSafeInteger(body[key]) ||
        body[key] <= 0 ||
        body[key] > MAX_OUTPUT_TOKENS)
    ) {
      throw new Error("Invalid output token limit");
    }
  }
  if (body.n !== undefined && body.n !== 1)
    throw new Error("Only one completion per request is supported");
  if (body.stream !== undefined && typeof body.stream !== "boolean")
    throw new Error("Invalid stream flag");
  const outputTokens = (body.max_completion_tokens ??
    body.max_tokens ??
    DEFAULT_OUTPUT_TOKENS) as number;
  if (body.max_completion_tokens === undefined) body.max_tokens = outputTokens;
  if (body.stream === true) {
    if (body.stream_options !== undefined && !record(body.stream_options))
      throw new Error("Invalid stream options");
    body.stream_options = {
      ...(record(body.stream_options) ? body.stream_options : {}),
      include_usage: true,
    };
  }
  // One token per UTF-8 byte is deliberately conservative; client token counts
  // are not trusted. This includes message framing and JSON overhead.
  const hold = Math.max(1, tokenCredits(pricing, bytes, outputTokens, true));
  return { body: JSON.stringify(body), hold };
}

type TokenUsage = { input: number; output: number };
function usageFromJson(text: string): TokenUsage | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!record(parsed) || !record(parsed.usage)) return undefined;
    const { prompt_tokens: input, completion_tokens: output } = parsed.usage;
    if (
      typeof input !== "number" ||
      typeof output !== "number" ||
      !Number.isSafeInteger(input) ||
      !Number.isSafeInteger(output) ||
      input < 0 ||
      output < 0
    )
      return undefined;
    return { input, output };
  } catch {
    return undefined;
  }
}

/** Observe a tee branch with bounded parser memory. Never rewrite client bytes. */
export async function readTokenCharge(
  body: ReadableStream<Uint8Array> | null,
  contentType: string,
  pricing: TokenPricing,
  hold: number,
): Promise<number> {
  if (!body) return 0;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const sse = contentType.includes("text/event-stream");
  let pending = "";
  let bytes = 0;
  let usage: TokenUsage | undefined;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, USAGE_TIMEOUT_MS);
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      pending += decoder.decode(chunk.value, { stream: true });
      if (sse) {
        // Normalize CRLF across chunk boundaries without changing forwarded bytes.
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(pending)) !== null) {
          const event = pending.slice(0, match.index);
          pending = pending.slice(match.index + match[0].length);
          if (event.length > MAX_SSE_EVENT_CHARS) return 0;
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data !== "[DONE]") usage = usageFromJson(data) ?? usage;
        }
        if (pending.length > MAX_SSE_EVENT_CHARS) return 0;
      } else if (bytes > MAX_USAGE_BYTES) return 0;
    }
    if (expired) return 0;
    pending += decoder.decode();
    if (!sse) usage = usageFromJson(pending);
    return usage
      ? Math.min(hold, tokenCredits(pricing, usage.input, usage.output))
      : 0;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
    // Do not await tee cancellation: the client may still be consuming its branch.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
