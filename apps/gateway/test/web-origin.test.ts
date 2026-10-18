import { describe, expect, it } from "vitest";
import { appendDeprecationLink } from "../src/deprecation";
import { paymentRequiredResponse } from "../src/payment-required";
import { webOrigin } from "../src/web-origin";

const route = { publisherHandle: "acme", projectSlug: "demo" };

describe("APP_ORIGIN fails closed", () => {
  it("accepts HTTPS and loopback HTTP origins only", () => {
    expect(webOrigin("https://web.example.test/path")).toBe(
      "https://web.example.test",
    );
    expect(webOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    for (const raw of [
      undefined,
      "",
      " ",
      "not a url",
      "http://web.example.test",
      "https://user:pass@web.example.test",
      "javascript:alert(1)",
    ])
      expect(webOrigin(raw)).toBeUndefined();
  });

  it("keeps the 402 but drops action links without an origin", async () => {
    const body = (await paymentRequiredResponse("req_1", "API key required", {
      reason: "missing_api_key",
    }).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      error: "payment_required",
      reason: "missing_api_key",
    });
    expect(body).not.toHaveProperty("actions");
    const linked = (await paymentRequiredResponse(
      "req_2",
      "API key required",
      { reason: "missing_api_key" },
      "https://web.example.test",
    ).json()) as { actions: Record<string, string> };
    expect(linked.actions.createKey).toBe(
      "https://web.example.test/app/settings/keys",
    );
  });

  it("omits the deprecation Link without an origin", () => {
    const missing = new Headers();
    appendDeprecationLink(missing, route, undefined);
    expect(missing.has("link")).toBe(false);
    const linked = new Headers();
    appendDeprecationLink(linked, route, "https://web.example.test");
    expect(linked.get("link")).toBe(
      '<https://web.example.test/catalogue/acme/demo>; rel="deprecation"',
    );
  });
});
