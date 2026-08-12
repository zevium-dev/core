import { describe, expect, it } from "vitest";
import { buildManifest } from "../../src/manifest";
import { inspectMultipart } from "../../src/multipart";
import { parseStrictJson } from "../../src/strict-json";
import { HEAD_SHA, MERGE_SHA, PREVIEW_SECRET_DIGESTS } from "../fixtures";

function gatewayTarget() {
  return buildManifest({
    convexSiteUrl: "https://preview-123.convex.site",
    convexUrl: "https://preview-123.convex.cloud",
    eventName: "pull_request",
    headSha: HEAD_SHA,
    oidcSha: MERGE_SHA,
    prNumber: 123,
    profile: "preview-gateway",
    ref: "refs/pull/123/merge",
    runAttempt: 1,
    runId: "9001",
    secretDigests: PREVIEW_SECRET_DIGESTS,
  }).targets[0]!;
}

function splitStream(
  bytes: Uint8Array,
  widths: number[],
): ReadableStream<Uint8Array> {
  let offset = 0;
  let widthIndex = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) {
        controller.close();
        return;
      }
      const width = widths[widthIndex % widths.length] ?? 1;
      widthIndex += 1;
      const end = Math.min(bytes.length, offset + width);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

function workerMultipart(
  metadata: Record<string, unknown>,
  moduleName = "index.js",
): { body: Uint8Array; boundary: string } {
  const boundary = "----zevium-boundary-123";
  const source = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="metadata"',
    "Content-Type: application/json",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Disposition: form-data; name="${moduleName}"; filename="${moduleName}"`,
    "Content-Type: application/javascript+module",
    "",
    "export default { fetch() { return new Response('ok') } }",
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return { body: new TextEncoder().encode(source), boundary };
}

function versionMetadata(): Record<string, unknown> {
  return {
    annotations: { "workers/tag": "preview-9001-1" },
    bindings: [
      {
        name: "CONVEX_SITE_URL",
        text: "https://preview-123.convex.site",
        type: "plain_text",
      },
      {
        name: "CONVEX_URL",
        text: "https://preview-123.convex.cloud",
        type: "plain_text",
      },
      {
        class_name: "WalletDO",
        name: "WALLET",
        type: "durable_object_namespace",
      },
    ],
    compatibility_date: "2025-04-01",
    compatibility_flags: ["global_fetch_strictly_public"],
    keep_bindings: ["secret_text", "secret_key"],
    main_module: "index.js",
    migrations: {
      new_tag: "v1",
      steps: [{ new_sqlite_classes: ["WalletDO"] }],
    },
  };
}

describe("strict JSON", () => {
  it.each([
    '{"a":1,"a":2}',
    '{"a":01}',
    '{"a":NaN}',
    '{"a":1} trailing',
    '{"__proto__":1,"__proto__":2}',
  ])("rejects ambiguous JSON %s", (source) => {
    expect(() => parseStrictJson(source)).toThrow("Invalid JSON");
  });

  it("uses null-prototype objects", () => {
    const value = parseStrictJson('{"__proto__":{"polluted":true}}');
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("streaming multipart validation", () => {
  it("validates metadata before exposing stream and survives split boundaries", async () => {
    const multipart = workerMultipart(versionMetadata());
    const request = new Request("https://broker.invalid/upload", {
      body: splitStream(multipart.body, [1, 2, 3, 5, 8]),
      duplex: "half",
      headers: {
        "content-length": String(multipart.body.length),
        "content-type": `multipart/form-data; boundary=${multipart.boundary}`,
      },
      method: "POST",
    } as RequestInit & { duplex: "half" });
    const inspected = await inspectMultipart(
      request,
      { mode: "worker-version", target: gatewayTarget() },
      1024 * 1024,
    );
    expect(inspected.mainModule).toBe("index.js");
    const forwarded = new Uint8Array(
      await new Response(inspected.body).arrayBuffer(),
    );
    expect(forwarded).toEqual(multipart.body);
  });

  it("rejects metadata after executable module", async () => {
    const boundary = "----zevium-order";
    const source = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="index.js"; filename="index.js"',
      "Content-Type: application/javascript+module",
      "",
      "export default {}",
      `--${boundary}`,
      'Content-Disposition: form-data; name="metadata"',
      "",
      JSON.stringify(versionMetadata()),
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const bytes = new TextEncoder().encode(source);
    await expect(
      inspectMultipart(
        new Request("https://broker.invalid/upload", {
          body: bytes,
          headers: {
            "content-type": `multipart/form-data; boundary=${boundary}`,
          },
          method: "POST",
        }),
        { mode: "worker-version", target: gatewayTarget() },
        1024 * 1024,
      ),
    ).rejects.toMatchObject({ code: "multipart_rejected" });
  });

  it("rejects duplicate, traversal, encoded, and undeclared module names", async () => {
    for (const moduleName of [
      "../index.js",
      "%2e%2e/index.js",
      "/index.js",
      "index\\.js",
    ]) {
      const multipart = workerMultipart(versionMetadata(), moduleName);
      await expect(
        inspectMultipart(
          new Request("https://broker.invalid/upload", {
            body: Uint8Array.from(multipart.body).buffer,
            headers: {
              "content-type": `multipart/form-data; boundary=${multipart.boundary}`,
            },
            method: "POST",
          }),
          { mode: "worker-version", target: gatewayTarget() },
          1024 * 1024,
        ),
      ).rejects.toBeDefined();
    }
  });

  it("rejects malformed asset base64, wrong sizes, and trailing bytes", async () => {
    const boundary = "----zevium-assets";
    const hash = "a".repeat(32);
    for (const payload of ["%%%%", "YQ==AA", "YQ==\r\nEVIL"]) {
      const source = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="${hash}"; filename="${hash}"`,
        "Content-Type: text/plain",
        "",
        payload,
        `--${boundary}--`,
        "",
      ].join("\r\n");
      const bytes = new TextEncoder().encode(source);
      try {
        const inspected = await inspectMultipart(
          new Request("https://broker.invalid/upload", {
            body: bytes,
            headers: {
              "content-type": `multipart/form-data; boundary=${boundary}`,
            },
            method: "POST",
          }),
          {
            assetSizes: { [hash]: 1 },
            mode: "assets",
            target: gatewayTarget(),
          },
          1024 * 1024,
        );
        await expect(
          new Response(inspected.body).arrayBuffer(),
        ).rejects.toBeDefined();
      } catch (error) {
        expect(error).toBeDefined();
      }
    }
  });
});
