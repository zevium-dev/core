import { describe, expect, it } from "vitest";
import { buildManifest } from "../../src/manifest";
import { inspectMultipart } from "../../src/multipart";
import { parseStrictJson } from "../../src/strict-json";
import {
  HEAD_SHA,
  MERGE_SHA,
  PREVIEW_SECRET_DIGESTS,
  PRODUCTION_SHA,
  TEST_MODULE_ARTIFACTS,
  TEST_STATIC_ASSETS,
} from "../fixtures";

function gatewayTarget() {
  return buildManifest({
    ...TEST_MODULE_ARTIFACTS,
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

function webTarget() {
  return buildManifest({
    ...TEST_MODULE_ARTIFACTS,
    ...TEST_STATIC_ASSETS,
    eventName: "workflow_run",
    headSha: HEAD_SHA,
    oidcSha: PRODUCTION_SHA,
    profile: "production-web",
    ref: "refs/heads/develop",
    runAttempt: 1,
    runId: "9002",
    secretDigests: [
      {
        name: "CLERK_SECRET_KEY",
        sha256:
          "673fdf3905ba00e820de905b7c831604ac535c756561234e6d90f974316226a6",
      },
    ],
    sourceRunId: "8999",
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

function webVersionMetadata(secret: string): Record<string, unknown> {
  return {
    annotations: { "workers/tag": "ci-9002-1" },
    assets: { config: {}, jwt: "a.b.c".repeat(10) },
    bindings: [{ name: "CLERK_SECRET_KEY", text: secret, type: "secret_text" }],
    compatibility_date: "2026-07-18",
    compatibility_flags: ["nodejs_compat"],
    main_module: "index.js",
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

  it("returns exact length for canonicalized validated multipart", async () => {
    const multipart = workerMultipart(versionMetadata());
    const nonCanonical = new TextEncoder().encode(
      new TextDecoder()
        .decode(multipart.body)
        .replaceAll("Content-Disposition:", "content-disposition:    "),
    );
    const inspected = await inspectMultipart(
      new Request("https://broker.invalid/upload", {
        body: Uint8Array.from(nonCanonical).buffer,
        headers: {
          "content-length": String(nonCanonical.byteLength),
          "content-type": `multipart/form-data; boundary=${multipart.boundary}`,
        },
        method: "POST",
      }),
      { mode: "worker-version", target: gatewayTarget() },
      1024 * 1024,
    );
    const forwarded = new Uint8Array(
      await new Response(inspected.body).arrayBuffer(),
    );

    expect(inspected.contentLength).toBe(forwarded.byteLength);
    expect(inspected.contentLength).not.toBe(nonCanonical.byteLength);
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

  it("rejects executable bytes and content type not bound by manifest", async () => {
    const changed = workerMultipart(versionMetadata());
    const tampered = new TextDecoder()
      .decode(changed.body)
      .replace("new Response('ok')", "new Response('pwned')");
    const tamperedBytes = new TextEncoder().encode(tampered);
    await expect(
      inspectMultipart(
        new Request("https://broker.invalid/upload", {
          body: tamperedBytes,
          headers: {
            "content-type": `multipart/form-data; boundary=${changed.boundary}`,
          },
          method: "POST",
        }),
        { mode: "worker-version", target: gatewayTarget() },
        1024 * 1024,
      ),
    ).rejects.toMatchObject({ code: "artifact_rejected" });

    const wrongType = new TextDecoder()
      .decode(changed.body)
      .replace("application/javascript+module", "application/javascript");
    await expect(
      inspectMultipart(
        new Request("https://broker.invalid/upload", {
          body: new TextEncoder().encode(wrongType),
          headers: {
            "content-type": `multipart/form-data; boundary=${changed.boundary}`,
          },
          method: "POST",
        }),
        { mode: "worker-version", target: gatewayTarget() },
        1024 * 1024,
      ),
    ).rejects.toMatchObject({ code: "artifact_rejected" });
  });

  it("binds explicit Worker secret values to signed digests", async () => {
    const valid = workerMultipart(webVersionMetadata("correct-secret"));
    const inspected = await inspectMultipart(
      new Request("https://broker.invalid/upload", {
        body: Uint8Array.from(valid.body).buffer,
        headers: {
          "content-type": `multipart/form-data; boundary=${valid.boundary}`,
        },
        method: "POST",
      }),
      { mode: "worker-version", target: webTarget() },
      1024 * 1024,
    );
    await new Response(inspected.body).arrayBuffer();

    const forged = workerMultipart(webVersionMetadata("wrong-secret"));
    await expect(
      inspectMultipart(
        new Request("https://broker.invalid/upload", {
          body: Uint8Array.from(forged.body).buffer,
          headers: {
            "content-type": `multipart/form-data; boundary=${forged.boundary}`,
          },
          method: "POST",
        }),
        { mode: "worker-version", target: webTarget() },
        1024 * 1024,
      ),
    ).rejects.toMatchObject({ code: "secret_rejected" });
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
