import { describe, expect, it } from "vitest";

import { filterRequestHeaders, filterResponseHeaders } from "../src/headers";

describe("request header forwarding", () => {
  it("removes forwarding identity and reserved metadata without mutating input", () => {
    const stripped = {
      Forwarded: "for=192.0.2.18;host=pretend.example;proto=http",
      "X-Forwarded-For": "192.0.2.18",
      "X-Forwarded-Host": "pretend.example",
      "X-Forwarded-Proto": "http",
      "X-Forwarded-Port": "80",
      "X-Forwarded-Server": "relay.example",
      "X-Real-IP": "192.0.2.18",
      "CF-Connecting-IP": "192.0.2.18",
      "X-Zevium-Release-Challenge": "private-probe",
      "X-Zevium-Org": "pretend-org",
      "X-Zevium-Future-Metadata": "not-trusted",
      Authorization: "Bearer consumer-secret",
      "X-API-Key": "consumer-secret",
      Cookie: "session=consumer-secret",
      Host: "gateway.example",
      "Content-Length": "17",
    };
    const source = new Headers(stripped);
    const before = Array.from(source.entries());
    const result = filterRequestHeaders(source);

    for (const name of Object.keys(stripped)) {
      expect(result.has(name)).toBe(false);
    }
    expect(Array.from(source.entries())).toEqual(before);
  });

  it("keeps application headers, including object-prototype names", () => {
    const application = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Accept-Language": "en-GB",
      "If-None-Match": '"revision-7"',
      "Idempotency-Key": "order-42",
      "X-App-Tenant": "tenant-42",
      Traceparent: "00-12345678901234567890123456789012-1234567890123456-01",
      Constructor: "app-constructor",
    };
    const result = filterRequestHeaders(new Headers(application));

    for (const [name, value] of Object.entries(application)) {
      expect(result.get(name)).toBe(value);
    }
  });
});

describe.each([
  ["request", filterRequestHeaders],
  ["response", filterResponseHeaders],
] as const)("%s hop-by-hop filtering", (_direction, filter) => {
  it("removes fixed and Connection-nominated fields regardless of case or order", () => {
    const source = new Headers({
      Connection: "  X-App-Hop , KEEP-ALIVE, , a-local-hop  ",
      "A-Local-Hop": "sorted-before-connection",
      "X-App-Hop": "private-relay-value",
      "X-Second-Hop": "second-connection-line",
      "Keep-Alive": "timeout=10",
      "Proxy-Authenticate": "Basic",
      "Proxy-Authorization": "Basic private",
      TE: "trailers",
      Trailer: "X-Trailer",
      "Transfer-Encoding": "chunked",
      Upgrade: "websocket",
      "X-App-End-To-End": "public-value",
    });
    source.append("Connection", "x-SECOND-hop, X-App-Hop");
    const before = Array.from(source.entries());
    const result = filter(source);

    expect(Array.from(result.entries())).toEqual([
      ["x-app-end-to-end", "public-value"],
    ]);
    expect(Array.from(source.entries())).toEqual(before);
  });
});

describe("response header forwarding", () => {
  it("keeps application response headers and existing cookie/length/auth exclusions", () => {
    const application = {
      "Content-Type": "application/problem+json",
      "Cache-Control": "private, max-age=30",
      ETag: '"response-9"',
      "Content-Disposition": 'attachment; filename="report.json"',
      "X-App-Result": "accepted",
      Link: '</reports/next>; rel="next"',
      Constructor: "response-constructor",
    };
    const result = filterResponseHeaders(
      new Headers({
        ...application,
        "Set-Cookie": "session=upstream-secret",
        "Content-Length": "123",
        Authorization: "Bearer upstream-secret",
        "X-API-Key": "upstream-secret",
      }),
    );

    for (const [name, value] of Object.entries(application)) {
      expect(result.get(name)).toBe(value);
    }
    for (const name of [
      "set-cookie",
      "content-length",
      "authorization",
      "x-api-key",
    ]) {
      expect(result.has(name)).toBe(false);
    }
  });

  it("rejects spoofed platform metadata but allows gateway metadata applied afterward", () => {
    const source = new Headers({
      Connection: "X-Zevium-Request-Id, X-Zevium-Cost",
      "X-Zevium-Request-Id": "spoofed-id",
      "X-Zevium-Cost": "0",
      "X-Zevium-Free-Tier": "1",
      "X-Zevium-Release": "spoofed-release",
      "X-Zevium-Future-Metadata": "spoofed",
      "Content-Type": "application/json",
    });
    const result = filterResponseHeaders(source);
    expect(Array.from(result.entries())).toEqual([
      ["content-type", "application/json"],
    ]);

    // Same ordering as pipeline.ts: filter upstream, then stamp gateway facts.
    result.set("x-zevium-request-id", "gateway-id");
    result.set("x-zevium-cost", "12");
    expect(result.get("x-zevium-request-id")).toBe("gateway-id");
    expect(result.get("x-zevium-cost")).toBe("12");
    expect(result.has("x-zevium-free-tier")).toBe(false);
    result.set("x-zevium-free-tier", "1");
    expect(result.get("x-zevium-free-tier")).toBe("1");
  });
});
