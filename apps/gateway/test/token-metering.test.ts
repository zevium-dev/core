import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareTokenRequest, readTokenCharge } from "../src/token-metering";
import type { TokenPricing } from "@zevium/shared";

const pricing: TokenPricing = { per: "token", input: 1000, output: 2000 };
const request = (body: unknown) =>
  new Request("https://gateway.test/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
afterEach(() => vi.useRealTimers());
describe("token observer bounds", () => {
  it("sizes from UTF-8 bytes, defaults output limit, and forces usage reporting", async () => {
    const body = {
      messages: [{ content: "你好" }],
      stream: true,
      prompt_tokens: 0,
      stream_options: { include_usage: false },
    };
    const prepared = await prepareTokenRequest(request(body), pricing);
    const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
    expect(prepared.hold).toBe(
      Math.ceil((bytes * 1000 + 4096 * 2000) / 1_000_000),
    );
    expect(JSON.parse(prepared.body)).toMatchObject({
      max_tokens: 4096,
      stream_options: { include_usage: true },
    });
    expect(
      JSON.parse(
        (
          await prepareTokenRequest(
            request({ max_completion_tokens: 20 }),
            pricing,
          )
        ).body,
      ),
    ).toEqual({ max_completion_tokens: 20 });
  });
  it.each([
    { max_tokens: -1 },
    { max_tokens: 1.5 },
    { max_tokens: 1_000_001 },
    { n: 2 },
    { stream: "true" },
    { stream: true, stream_options: [] },
    [],
  ])("rejects invalid request controls: %j", async (body) => {
    await expect(prepareTokenRequest(request(body), pricing)).rejects.toThrow(
      /Invalid|Only|JSON object/,
    );
  });
  it("rejects oversized input before reserving", async () => {
    await expect(
      prepareTokenRequest(request({ prompt: "x".repeat(1_048_576) }), pricing),
    ).rejects.toThrow(/1 MiB/);
  });
  it.each([
    ['data: {"choices":[]}\n\ndata: [DONE]\n\n', "text/event-stream"],
    [
      'data: {"usage":{"prompt_tokens":-1,"completion_tokens":3}}\n\n',
      "text/event-stream",
    ],
    ["data: " + "x".repeat(65_537) + "\n\n", "text/event-stream"],
    ["x".repeat(1_048_577), "application/json"],
  ])(
    "releases hold on missing or unusable usage",
    async (body, contentType) => {
      expect(
        await readTokenCharge(
          new Response(body).body,
          contentType,
          pricing,
          100,
        ),
      ).toBe(0);
    },
  );
  it("releases hold on interrupted streams", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("upstream disconnected"));
      },
    });
    expect(
      await readTokenCharge(stream, "text/event-stream", pricing, 100),
    ).toBe(0);
  });
  it("bounds observation time before the wallet lease expires", async () => {
    vi.useFakeTimers();
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    const observed = readTokenCharge(stream, "text/event-stream", pricing, 100);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await observed).toBe(0);
    expect(canceled).toBe(true);
  });
});
