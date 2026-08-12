import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  registryPayloadDigest,
  registrySyncPath,
  signRegistrySyncRequest,
} from "./registry-sync";

describe("registry sync signing contract", () => {
  it("canonicalizes nested objects without changing array order", () => {
    expect(canonicalJson({ z: 1, a: { y: true, x: [2, 1] } })).toBe(
      '{"a":{"x":[2,1],"y":true},"z":1}',
    );
  });

  it("rejects non-JSON and cyclic values", () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow("non-finite");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow("cyclic");
  });

  it("produces stable payload digests and exact HMAC vectors", async () => {
    const first = await registryPayloadDigest("key.state", {
      orgId: "org_1",
      keyId: "key_1",
    });
    const second = await registryPayloadDigest("key.state", {
      keyId: "key_1",
      orgId: "org_1",
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);

    await expect(
      signRegistrySyncRequest("short", "1", "nonce", "{}"),
    ).rejects.toThrow("at least 32 bytes");
    expect(
      await signRegistrySyncRequest(
        "0123456789abcdef0123456789abcdef",
        "1723456789000",
        "nonce-1",
        '{"operation":"org.archive"}',
      ),
    ).toBe(
      "v1=7f0cf1189d18541a5ff0020762bd4b48745807de06030aebe8bc26c3776a5721",
    );
  });

  it("keeps path adapters internal and configurable", () => {
    expect(registrySyncPath("org.archive")).toBe(
      "/internal/registry/v1/org/archive",
    );
    expect(
      registrySyncPath("route.upsert", {
        "route.upsert": "/internal/registry/v1/custom-route",
      }),
    ).toBe("/internal/registry/v1/custom-route");
    expect(() =>
      registrySyncPath("route.upsert", { "route.upsert": "https://evil.test" }),
    ).toThrow("invalid");
  });
});
